import { action, makeObservable, observable, runInAction } from 'mobx';
import { MessageType, type AgentActivity, type ClientKind, type PresenceUser, type ServerMessage } from '../../core/protocol';
import type { CommentThread } from '../../core/types';
import { DocStore } from './doc-store';
import { SyncClient, type SyncStatus } from '../sync/sync-client';

// Un fichero abierto: conexión de sync + documento + presencia + comentarios.
// Lo usan tanto el editor (kind=human) como el runtime headless del MCP (kind=runtime).

export class FileSession {
  readonly sync: SyncClient;
  doc: DocStore | null = null;
  status: SyncStatus = 'connecting';
  fileName = '';
  /** Otros clientes conectados al fichero (pestañas humanas y runtimes). */
  users = new Map<string, PresenceUser>();
  threads = new Map<string, CommentThread>();
  threadsLoaded = false;
  private readyResolvers: ((d: DocStore) => void)[] = [];
  private unsubs: (() => void)[] = [];

  constructor(readonly fileId: string, readonly kind: ClientKind) {
    this.sync = new SyncClient({ fileId, kind });
    makeObservable(this, {
      doc: observable.ref,
      status: observable,
      fileName: observable,
      users: observable,
      threads: observable,
      threadsLoaded: observable,
      handle: action,
    });
    this.unsubs.push(this.sync.on((m) => this.handle(m)));
    this.unsubs.push(this.sync.onStatus((s) => runInAction(() => (this.status = s))));
  }

  start() {
    this.sync.connect();
    return this;
  }

  dispose() {
    for (const u of this.unsubs) u();
    this.sync.close();
    this.doc?.dispose();
  }

  /** Resuelve cuando llega el primer snapshot del fichero. */
  ready(): Promise<DocStore> {
    if (this.doc) return Promise.resolve(this.doc);
    return new Promise((r) => this.readyResolvers.push(r));
  }

  handle(m: ServerMessage) {
    switch (m.$t) {
      case MessageType.FilePayload: {
        this.fileName = m.file.name;
        if (!this.doc) {
          const doc = new DocStore(m.file, m.clientIndex);
          doc.onLocalEdits((edits) => this.sync.sendEdits(edits));
          this.doc = doc;
          for (const r of this.readyResolvers.splice(0)) r(doc);
        } else {
          // Reconexión: snapshot del servidor + re-aplicar lo editado sin conexión.
          const queued = this.sync.takeQueued();
          this.doc.clientIndex = m.clientIndex;
          this.doc.replaceData(m.file);
          if (queued.length) {
            this.doc.applyRemoteEdits(queued);
            this.sync.sendEdits(queued);
          }
        }
        return;
      }
      case MessageType.FileEditBatch:
        this.doc?.applyRemoteEdits(m.edits);
        if (this.doc) this.fileName = this.doc.data.name;
        return;
      case MessageType.FileMetaChange:
        this.fileName = m.name;
        return;
      case MessageType.UsersAlreadyInFile:
        this.users.clear();
        for (const u of m.users) this.users.set(u.clientId, u);
        return;
      case MessageType.UserJoinedFile:
        this.users.set(m.user.clientId, m.user);
        return;
      case MessageType.UserLeftFile:
        this.users.delete(m.clientId);
        return;
      case MessageType.UserSelectNode:
        this.patchUser(m.clientId, { selectedNodes: m.nodeIds });
        return;
      case MessageType.UserPageChange:
        this.patchUser(m.clientId, { pageId: m.pageId });
        return;
      case MessageType.UserCameraChange:
        this.patchUser(m.clientId, { cameraView: m.view });
        return;
      case MessageType.UserFocusChange:
        this.patchUser(m.clientId, { focus: m.focus, lastActiveAt: m.lastActiveAt });
        return;
      case MessageType.UserAgentsChange:
        this.patchUser(m.clientId, { agents: m.agents });
        return;
      case MessageType.CommentThreadsInitialPayload:
        this.threads.clear();
        for (const t of m.threads) this.threads.set(t.id, t);
        this.threadsLoaded = true;
        return;
      case MessageType.CommentThreadPayload:
        if (m.thread) this.threads.set(m.threadId, m.thread);
        else this.threads.delete(m.threadId);
        return;
    }
  }

  private patchUser(clientId: string, patch: Partial<PresenceUser>) {
    const u = this.users.get(clientId);
    if (u) this.users.set(clientId, { ...u, ...patch });
  }

  /** Pestaña humana activa más reciente (la "del usuario"). */
  get primaryHuman(): PresenceUser | null {
    let best: PresenceUser | null = null;
    for (const u of this.users.values()) {
      if (u.kind !== 'human') continue;
      if (!best || (u.lastActiveAt ?? 0) > (best.lastActiveAt ?? 0)) best = u;
    }
    return best;
  }

  /** Actividad de agentes reportada por los runtimes conectados. */
  get remoteAgents(): AgentActivity[] {
    const out: AgentActivity[] = [];
    for (const u of this.users.values()) if (u.agents) out.push(...u.agents);
    return out;
  }
}
