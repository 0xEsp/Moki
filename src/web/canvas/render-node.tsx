import { observer } from 'mobx-react-lite';
import { createElement, useCallback, type CSSProperties, type ReactNode } from 'react';
import { computeNodeStyle } from '../../core/render-style';
import { tokensRenderCss } from '../../core/tokens';
import type { TreeNode } from '../../core/types';
import type { DocStore } from '../state/doc-store';
import type { DomRegistry, NodeElement } from './dom-registry';

// Modelo → DOM real. Cada nodo es un elemento HTML/SVG con su CSS inline; el navegador hace
// el layout (flex, gap, fit-content, texto). Lo usan el canvas del editor, el runtime del MCP
// y la página de captura, así que los tres pintan exactamente lo mismo.

export interface RenderOptions {
  doc: DocStore;
  registry?: DomRegistry;
  /** Ids que se pintan aunque estén ocultos (cadena hasta el objetivo de una captura). */
  forceVisible?: Set<string>;
  /** Nodo en edición de texto: se pinta transparente (el editor superpone su propio input). */
  editingTextId?: string | null;
}

/** Bloque de variables CSS de los tokens, con un selector de ámbito. */
export const TokenVars = observer(function TokenVars({ doc, scope }: { doc: DocStore; scope: string }) {
  return <style>{tokensRenderCss(doc.data, scope)}</style>;
});

/** Pinta el subárbol que cuelga de `rootId` (incluido). */
export const RenderTree = observer(function RenderTree({ rootId, ...opts }: RenderOptions & { rootId: string }) {
  const node = opts.doc.view(rootId);
  if (!node) return null;
  return <RenderNode id={rootId} parentId={opts.doc.parentId(rootId)} opts={opts} />;
});

const SVG_NS_TAGS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g', 'text', 'tspan', 'use',
  'image', 'foreignObject', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'pattern',
]);

const RenderNode = observer(function RenderNodeView({
  id,
  parentId,
  opts,
}: {
  id: string;
  parentId: string | null;
  opts: RenderOptions;
}) {
  const { doc, registry, forceVisible } = opts;
  // Vista efectiva: en instancias, estilos del main + overrides (los hijos son ids virtuales).
  const node = doc.view(id);
  const ref = useCallback(
    (el: NodeElement | null) => {
      if (!registry) return;
      if (el) registry.register(id, el);
      return () => {
        if (el) registry.unregister(id, el);
      };
    },
    [id, registry],
  );
  if (!node) return null;
  if (node.isVisible === false && !forceVisible?.has(id)) return null;

  const parent = parentId ? doc.view(parentId) : null;
  const style = computeNodeStyle(node, { file: doc.data, parent, mode: 'render' }) as CSSProperties & Record<string, string>;
  if (opts.editingTextId === id) style.color = 'transparent';

  const childIds = doc.childIds(id);
  const kids: ReactNode[] = childIds.map((c) => <RenderNode key={c} id={c} parentId={id} opts={opts} />);

  const common: Record<string, unknown> = { ref, 'data-node-id': id, style };
  // Efectos caros de pintar (sobre todo en Safari): el canvas no los pinta con zoom alejado.
  if (style.backdropFilter || style.WebkitBackdropFilter || style.filter) common['data-fx'] = '';

  switch (node.component) {
    case 'Text':
      return createElement('div', common, node.textValue ?? '');
    case 'SVG': {
      const attrs = toReactAttrs(node.attrs);
      return createElement(
        'svg',
        { xmlns: 'http://www.w3.org/2000/svg', ...attrs, ...common },
        node.svgNonRendered ? <g key="__defs" dangerouslySetInnerHTML={{ __html: node.svgNonRendered }} /> : null,
        ...kids,
      );
    }
    case 'SVGVisualElement': {
      const tag = node.tag && (SVG_NS_TAGS.has(node.tag) || /^[a-z][a-zA-Z]*$/.test(node.tag)) ? node.tag : 'g';
      const attrs = toReactAttrs(node.attrs);
      const content = tag === 'text' || tag === 'tspan' ? (node.textValue ?? null) : null;
      return createElement(tag, { ...attrs, ...common }, content, ...kids);
    }
    default:
      if (node.instanceOf && doc.components.isMissingMain(node)) {
        return createElement('div', common, 'Componente no encontrado');
      }
      return createElement('div', common, ...kids);
  }
});

/** Atributos guardados (nombres HTML/SVG) → props de React. */
export function toReactAttrs(attrs: Record<string, string> | undefined): Record<string, string> {
  if (!attrs) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') continue;
    if (k === 'class') out.className = v;
    else if (k === 'xlink:href') out.xlinkHref = v;
    else if (k === 'xml:space') out.xmlSpace = v;
    else if (k.startsWith('data-') || k.startsWith('aria-')) out[k] = v;
    else if (k.includes('-') || k.includes(':')) out[k.replace(/[-:]([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
    else out[k] = v;
  }
  return out;
}

export type { TreeNode };
