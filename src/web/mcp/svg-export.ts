import { computeNodeStyle, styleToCssText } from '../../core/render-style';
import type { TreeNode } from '../../core/types';
import type { DocStore } from '../state/doc-store';

// Serializa un nodo SVG (y su subárbol) a un documento SVG autónomo, con tokens resueltos.

const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Propiedades de layout que no tienen sentido en un .svg suelto. */
const DROP_ROOT = new Set(['position', 'left', 'top', 'right', 'bottom', 'display', 'flexShrink', 'flexGrow', 'alignSelf', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft']);

export function serializeSvgNode(doc: DocStore, nodeId: string): string {
  const node = doc.view(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.component !== 'SVG' && node.component !== 'SVGVisualElement') {
    throw new Error('SVG export is only available for SVG nodes; try a raster format (png, jpg, webp) or pdf');
  }
  const file = doc.data;
  const emit = (n: TreeNode, isRoot: boolean): string => {
    if (n.isVisible === false) return '';
    const tag = n.component === 'SVG' ? 'svg' : (n.tag ?? 'g');
    const style = computeNodeStyle(n, { file, parent: doc.parent(n.id), mode: 'resolved' });
    const attrs: Record<string, string> = { ...(n.attrs ?? {}) };
    if (isRoot) {
      for (const k of DROP_ROOT) delete style[k];
      if (tag === 'svg') {
        attrs.xmlns = 'http://www.w3.org/2000/svg';
        if (style.width && !attrs.width) attrs.width = style.width.replace(/px$/, '');
        if (style.height && !attrs.height) attrs.height = style.height.replace(/px$/, '');
      }
      delete style.width;
      delete style.height;
    }
    const css = styleToCssText(style);
    if (css) attrs.style = css;
    const attrText = Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
      .join('');
    const inner =
      (n.component === 'SVG' && n.svgNonRendered ? n.svgNonRendered : '') +
      ((tag === 'text' || tag === 'tspan') && n.textValue ? escText(n.textValue) : '') +
      doc.childIds(n.id).map((c) => emit(doc.view(c)!, false)).join('');
    return inner ? `<${tag}${attrText}>${inner}</${tag}>` : `<${tag}${attrText}/>`;
  };
  let out = emit(node, true);
  if (node.component === 'SVGVisualElement') {
    out = `<svg xmlns="http://www.w3.org/2000/svg">${out}</svg>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${out}`;
}
