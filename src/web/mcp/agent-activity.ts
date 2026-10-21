import { MessageType, type AgentActivity, type AgentActivityKind } from '../../core/protocol';
import type { ToolCallContext } from '../../core/runtime';

// Actividad de los agentes (una por sesión MCP): qué nodos están leyendo/escribiendo.
// Se difunde a las pestañas del usuario con `UserAgentsChange`, que pintan el indicador
// y las animaciones. Cada entrada caduca a los 40 s sin actividad.

export const ACTIVITY_TTL_MS = 40_000;

interface AgentState {
  sessionId: string;
  harness: string | null;
  nodes: Map<string, { kind: AgentActivityKind; at: number; timer: ReturnType<typeof setTimeout> }>;
  lastArtboardId: string | null;
}

export class AgentActivityTracker {
  private agents = new Map<string, AgentState>();
  private broadcastScheduled = false;

  constructor(
    private send: (agents: AgentActivity[]) => void,
    /** Ancestros (sin raíz) de un nodo, para `finish_working_on_nodes`. */
    private ancestorsOf: (id: string) => string[],
    private artboardOf: (id: string) => string | null,
  ) {}

  private agent(ctx: ToolCallContext): AgentState {
    let a = this.agents.get(ctx.sessionId);
    const name = ctx.clientInfo?.name && ctx.clientInfo.name !== 'unknown' ? ctx.clientInfo.name : null;
    if (!a) {
      a = { sessionId: ctx.sessionId, harness: name, nodes: new Map(), lastArtboardId: null };
      this.agents.set(ctx.sessionId, a);
    } else if (name) a.harness = name;
    return a;
  }

  private record(ctx: ToolCallContext, nodeIds: string[], kind: AgentActivityKind) {
    if (nodeIds.length === 0) return;
    const a = this.agent(ctx);
    const now = Date.now();
    for (const id of nodeIds) {
      const prev = a.nodes.get(id);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => this.expire(a.sessionId, id), ACTIVITY_TTL_MS);
      a.nodes.set(id, { kind, at: now, timer });
    }
    if (kind === 'write' || kind === 'edit') {
      const ab = this.artboardOf(nodeIds[0]!);
      if (ab) a.lastArtboardId = ab;
    }
    this.schedule();
  }

  recordRead(ctx: ToolCallContext, nodeIds: string[]) {
    this.record(ctx, nodeIds, 'read');
  }

  recordWrite(ctx: ToolCallContext, nodeIds: string[], kind: 'write' | 'edit' | 'delete') {
    this.record(ctx, nodeIds, kind);
  }

  private expire(sessionId: string, nodeId: string) {
    const a = this.agents.get(sessionId);
    if (!a) return;
    a.nodes.delete(nodeId);
    if (a.nodes.size === 0) this.agents.delete(sessionId);
    this.schedule();
  }

  /** Sin ids: borra toda la actividad. Con ids: las entradas cuyo nodo o ancestro esté en la lista. */
  finish(sessionId: string, nodeIds?: string[]) {
    const a = this.agents.get(sessionId);
    if (!a) return;
    if (!nodeIds || nodeIds.length === 0) {
      for (const e of a.nodes.values()) clearTimeout(e.timer);
      this.agents.delete(sessionId);
    } else {
      const set = new Set(nodeIds);
      for (const [id, e] of [...a.nodes]) {
        if (set.has(id) || this.ancestorsOf(id).some((x) => set.has(x))) {
          clearTimeout(e.timer);
          a.nodes.delete(id);
        }
      }
      if (a.nodes.size === 0) this.agents.delete(sessionId);
    }
    this.schedule();
  }

  removeAgent(sessionId: string) {
    this.finish(sessionId);
  }

  snapshot(): AgentActivity[] {
    return [...this.agents.values()].map((a) => ({
      sessionId: a.sessionId,
      harness: a.harness,
      lastArtboardId: a.lastArtboardId,
      nodes: [...a.nodes].map(([nodeId, e]) => ({ nodeId, kind: e.kind, at: e.at })),
    }));
  }

  private schedule() {
    if (this.broadcastScheduled) return;
    this.broadcastScheduled = true;
    queueMicrotask(() => {
      this.broadcastScheduled = false;
      this.send(this.snapshot());
    });
  }
}

export const agentsChangeMessage = (agents: AgentActivity[]) => ({ $t: MessageType.UserAgentsChange as const, agents });
