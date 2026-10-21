import { observer } from 'mobx-react-lite';
import { createRoot } from 'react-dom/client';
import type { MokiRuntimeApi, ToolCallContext } from '../../core/runtime';
import { RenderTree, TokenVars } from '../canvas/render-node';
import { DomRegistry } from '../canvas/dom-registry';
import type { Rect } from '../canvas/geometry';
import type { DocStore } from '../state/doc-store';
import { FileSession } from '../state/file-session';
import { McpHandlers, type Measurer } from '../mcp/handlers';

// Runtime headless del MCP (`/file/<id>?runtime=1`, abierto por el servidor en Chromium).
// Pinta TODAS las páginas a escala 1 sin transformación (cada una en su capa en (0,0); las que
// no ve el usuario con visibility:hidden, que sigue maquetando), así cualquier nodo de
// cualquier página es medible. Expone `window.mokiRuntime` para que el servidor invoque las
// herramientas con `page.evaluate`.

// Un frame, sin depender solo de rAF: si Chromium deja la página en segundo plano, rAF baja
// a ~1 Hz. El layout se fuerza igualmente al medir (getBoundingClientRect).
const raf = () =>
  new Promise<void>((r) => {
    const t = setTimeout(r, 16);
    requestAnimationFrame(() => {
      clearTimeout(t);
      r();
    });
  });

class RuntimeMeasurer implements Measurer {
  constructor(
    private doc: DocStore,
    private registry: DomRegistry,
  ) {}

  worldRect(id: string): Rect | null {
    const el = this.registry.el(id);
    if (!el || !el.isConnected) return null;
    const rootId = this.doc.rootOf(id);
    if (!rootId) return null;
    const rootEl = this.registry.el(rootId);
    if (!rootEl) return null;
    if (id === rootId) return { x: 0, y: 0, width: 0, height: 0 };
    const r = el.getBoundingClientRect();
    const o = rootEl.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && getComputedStyle(el).display === 'none') return null;
    return { x: r.left - o.left, y: r.top - o.top, width: r.width, height: r.height };
  }

  async whenMeasured(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const t0 = Date.now();
    const fonts = Promise.race([document.fonts.ready.then(() => 'fonts'), new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))]);
    const how = await fonts;
    const tFonts = Date.now() - t0;
    while (Date.now() < deadline) {
      await raf();
      await raf();
      if (this.allTopLevelRendered()) {
        if (Date.now() - t0 > 500) console.warn(`[moki-runtime] slow measure: fonts=${how} ${tFonts}ms total ${Date.now() - t0}ms status=${document.fonts.status}`);
        return true;
      }
    }
    console.warn(`[moki-runtime] measure timeout: fonts=${how} ${tFonts}ms`);
    return false;
  }

  private allTopLevelRendered(): boolean {
    for (const p of this.doc.canvasPages) {
      const rootId = `root_node_${p.id}`;
      if (!this.registry.el(rootId)) return false;
      for (const c of this.doc.childIds(rootId)) {
        if (this.doc.node(c)?.isVisible === false) continue;
        if (!this.registry.el(c)) return false;
      }
    }
    return true;
  }
}

const RuntimeView = observer(function RuntimeView({ session, doc, registry }: { session: FileSession; doc: DocStore; registry: DomRegistry }) {
  const humanPage = session.primaryHuman?.pageId;
  const active = doc.canvasPages.some((p) => p.id === humanPage) ? humanPage : doc.canvasPages[0]?.id;
  return (
    <div className="moki-runtime" style={{ position: 'absolute', left: 0, top: 0 }}>
      <TokenVars doc={doc} scope=".moki-runtime" />
      {doc.canvasPages.map((p) => (
        <div
          key={p.id}
          data-page-id={p.id}
          style={{ position: 'absolute', left: 0, top: 0, visibility: p.id === active ? 'visible' : 'hidden' }}
        >
          <RenderTree doc={doc} rootId={`root_node_${p.id}`} registry={registry} />
        </div>
      ))}
    </div>
  );
});

export function mountRuntime(el: HTMLElement, fileId: string): void {
  if (!document.querySelector('link[href="/fonts/fonts.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/fonts/fonts.css';
    document.head.appendChild(link);
  }
  document.body.style.margin = '0';
  document.body.style.background = '#ffffff';

  const session = new FileSession(fileId, 'runtime').start();
  const registry = new DomRegistry();
  let handlers: McpHandlers | null = null;
  const pendingRemovals: string[] = [];

  const api: MokiRuntimeApi = {
    ready: false,
    fileId,
    async handleToolCall(ctx: ToolCallContext, name: string, args: Record<string, unknown>) {
      if (!handlers) {
        const doc = await Promise.race([session.ready(), new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
        if (!doc || !handlers) {
          return { content: [{ type: 'text' as const, text: 'Open a Moki file to use this tool (the file could not be loaded).' }], isError: true };
        }
      }
      return handlers.handleToolCall(ctx, name, args);
    },
    removeAgent(sessionId: string) {
      if (handlers) handlers.removeAgent(sessionId);
      else pendingRemovals.push(sessionId);
    },
  };
  window.mokiRuntime = api;

  session.ready().then(async (doc) => {
    const measurer = new RuntimeMeasurer(doc, registry);
    handlers = new McpHandlers({ session, doc, measurer });
    for (const s of pendingRemovals.splice(0)) handlers.removeAgent(s);
    createRoot(el).render(<RuntimeView session={session} doc={doc} registry={registry} />);
    await measurer.whenMeasured(10_000);
    api.ready = true;
    console.log(`[moki-runtime] ready for file ${fileId}`);
  });
}
