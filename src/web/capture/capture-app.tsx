import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { MokiFile } from '../../core/types';
import { DocStore } from '../state/doc-store';
import { RenderTree, TokenVars } from '../canvas/render-node';
import { waitForAssets } from '../canvas/geometry';
import { serializeSvgNode } from '../mcp/svg-export';

// Página de captura (`/?capture=1`), manejada por el servidor con Playwright.
// Pinta, a partir de un snapshot del modelo, el artboard que contiene al nodo pedido en la
// esquina superior izquierda y devuelve el rectángulo (px CSS de la página) que hay que
// recortar. El servidor hace `page.screenshot({ clip })` o `page.pdf()`.

export interface CaptureRenderRequest {
  file: MokiFile;
  nodeId: string;
  scale: number;
  backdrop: 'visible' | 'hidden';
  mode: 'image' | 'pdf';
}

export interface CaptureRenderResult {
  x: number;
  y: number;
  width: number;
  height: number;
  failedImages: number;
}

declare global {
  interface Window {
    mokiCapture?: {
      render(req: CaptureRenderRequest): Promise<CaptureRenderResult>;
      reset(): void;
      /** Marcado SVG de un nodo SVG (tokens resueltos), o null si el nodo no es SVG. */
      svg(req: { file: MokiFile; nodeId: string }): string | null;
    };
  }
}

export function installCapture(container: HTMLElement) {
  let root: Root | null = null;
  let doc: DocStore | null = null;
  const pageStyle = document.createElement('style');
  document.head.appendChild(pageStyle);

  const reset = () => {
    root?.unmount();
    root = null;
    doc?.dispose();
    doc = null;
    container.innerHTML = '';
    pageStyle.textContent = '';
  };

  window.mokiCapture = {
    reset,
    svg({ file, nodeId }) {
      const d = new DocStore(file, 0);
      try {
        const n = d.node(nodeId);
        if (!n || n.component !== 'SVG') return null;
        return serializeSvgNode(d, nodeId);
      } finally {
        d.dispose();
      }
    },
    async render(req) {
      reset();
      doc = new DocStore(req.file, 0);
      const target = doc.node(req.nodeId);
      if (!target) throw new Error(`Node not found: ${req.nodeId}`);
      // Contexto de render: el artboard (si lo hay) o el propio nodo.
      const contextId = doc.artboardOf(req.nodeId) ?? req.nodeId;
      const pageId = doc.pageIdOf(req.nodeId);
      const page = pageId ? doc.page(pageId) : undefined;
      const forceVisible = new Set([req.nodeId, ...doc.ancestors(req.nodeId)]);

      const host = document.createElement('div');
      host.className = 'moki-capture-scope';
      // Contenedor enorme para no restringir el layout; el artboard se pinta en (0,0).
      host.style.cssText = `position:absolute;left:0;top:0;width:100000px;height:100000px;zoom:${req.scale};`;
      container.appendChild(host);
      const inner = document.createElement('div');
      inner.style.cssText = 'position:relative;';
      host.appendChild(inner);

      // El artboard se renderiza dentro de un padre libre sintético en (0,0).
      const contextNode = doc.node(contextId)!;
      doc.withoutUndo(() => {
        contextNode.styles.left = 0;
        contextNode.styles.top = 0;
        delete contextNode.styles.right;
        delete contextNode.styles.bottom;
      });

      root = createRoot(inner);
      const parentId = doc.parentId(contextId);
      flushSync(() => {
        root!.render(
          <>
            <TokenVars doc={doc!} scope=".moki-capture-scope" />
            <div style={{ position: 'relative' }}>
              {parentId ? (
                <FakeFreeformParent>
                  <RenderTree doc={doc!} rootId={contextId} forceVisible={forceVisible} />
                </FakeFreeformParent>
              ) : (
                <RenderTree doc={doc!} rootId={contextId} forceVisible={forceVisible} />
              )}
            </div>
          </>,
        );
      });

      const el = inner.querySelector(`[data-node-id="${CSS.escape(req.nodeId)}"]`) as HTMLElement | null;
      if (!el) throw new Error('Node is not rendered (hidden or empty)');
      const ctxEl = inner.querySelector(`[data-node-id="${CSS.escape(contextId)}"]`) as HTMLElement;
      const { failedImages } = await waitForAssets(ctxEl);

      if (req.backdrop === 'visible') {
        document.body.style.background = page?.canvasColor ?? '#ffffff';
      } else {
        document.body.style.background = 'transparent';
      }

      const r = el.getBoundingClientRect();
      const rect = { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
      if (req.mode === 'pdf') {
        // Desplazamos para que el nodo quede en (0,0) y fijamos el tamaño de página.
        host.style.left = `${-rect.x / req.scale}px`;
        host.style.top = `${-rect.y / req.scale}px`;
        pageStyle.textContent = `@page{size:${rect.width}px ${rect.height}px;margin:0}html,body{width:${rect.width}px;height:${rect.height}px;overflow:hidden;margin:0}`;
        await new Promise((res) => requestAnimationFrame(() => res(null)));
        return { x: 0, y: 0, width: rect.width, height: rect.height, failedImages };
      }
      return { ...rect, failedImages };
    },
  };
}

/** Padre libre (los hijos se posicionan absolutos con left/top), como la raíz de una página. */
function FakeFreeformParent({ children }: { children: React.ReactNode }) {
  return <div style={{ position: 'relative' }}>{children}</div>;
}
