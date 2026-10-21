import { compactStyles, UNITLESS } from '../../core/css';
import { computeNodeStyle } from '../../core/render-style';
import type { TreeNode } from '../../core/types';
import { isRootId } from '../../core/tree';
import { toReactAttrs } from '../canvas/render-node';
import type { DocStore } from '../state/doc-store';
import { stylesToTailwind } from './tailwind';

// Nodo → JSX (estilos inline o clases de Tailwind). Sin cabeceras ni `export default`.

export interface JsxOptions {
  format?: 'inline-styles' | 'tailwind';
  includeNodeIds?: boolean;
  includeRootPositioning?: boolean;
}

const TRIVIAL: Record<string, string[]> = {
  display: ['block'],
  flexDirection: ['row'],
  alignItems: ['stretch', 'normal'],
  justifyContent: ['start', 'flex-start', 'normal'],
  margin: ['0px', '0'], marginTop: ['0px', '0'], marginRight: ['0px', '0'], marginBottom: ['0px', '0'], marginLeft: ['0px', '0'],
  paddingTop: ['0px', '0'], paddingRight: ['0px', '0'], paddingBottom: ['0px', '0'], paddingLeft: ['0px', '0'], padding: ['0px', '0'],
  gap: ['0px', '0'], rowGap: ['0px', '0'], columnGap: ['0px', '0'],
  borderRadius: ['0px', '0'],
  borderTopLeftRadius: ['0px', '0'], borderTopRightRadius: ['0px', '0'], borderBottomRightRadius: ['0px', '0'], borderBottomLeftRadius: ['0px', '0'],
  fontWeight: ['400', 'normal'],
  textAlign: ['left', 'start'],
  rotate: ['0deg', '0'],
  flexGrow: ['0'],
};

const INSETS = ['top', 'left', 'right', 'bottom', 'inset'];

export function generateJsx(doc: DocStore, nodeId: string, opts: JsxOptions = {}): string {
  const node = doc.view(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.isVisible === false) return '';
  const format = opts.format ?? 'inline-styles';
  const includeIds = opts.includeNodeIds ?? true;
  const file = doc.data;

  const subtree = [nodeId, ...doc.descendants(nodeId)].filter((id) => doc.isEffectivelyVisible(id));
  const hasText = subtree.some((id) => doc.view(id)?.component === 'Text');

  const styleFor = (n: TreeNode, isRoot: boolean): Record<string, string> => {
    const parent = doc.parent(n.id);
    let s = computeNodeStyle(n, { file, parent, mode: 'external' });
    s = { boxSizing: 'border-box', ...s };
    if (isRoot) {
      if (hasText) {
        s.WebkitFontSmoothing = 'antialiased';
        s.MozOsxFontSmoothing = 'grayscale';
        s.fontSynthesis = 'none';
        s.overflowWrap = 'anywhere';
      }
      if (doc.isArtboard(n.id)) {
        const dependsOnSize = doc.childIds(n.id).some((c) => {
          const cs = doc.view(c)?.styles ?? {};
          return [cs.width, cs.height, cs.flex, cs.flexGrow, cs.flexBasis].some((v) => v !== undefined && /%|^1|fill/.test(String(v)));
        });
        if (!dependsOnSize) {
          delete s.width;
          delete s.height;
        }
      }
      if (!opts.includeRootPositioning && (s.position === 'absolute' || s.position === 'fixed')) {
        for (const k of INSETS) delete s[k];
        const freeformKids = doc.childIds(n.id).some((c) => {
          const p = doc.view(c)?.styles.position;
          return p === 'absolute' || p === 'fixed';
        }) || doc.isFreeform(n.id);
        if (freeformKids) s.position = 'relative';
        else delete s.position;
        delete s.translate;
      }
    }
    if (n.component === 'Text') {
      const t = n.textValue ?? '';
      if (!/ {2}|\n/.test(t)) delete s.whiteSpace;
    }
    for (const [k, vals] of Object.entries(TRIVIAL)) if (s[k] !== undefined && vals.includes(String(s[k]))) delete s[k];
    return compactStyles(s);
  };

  const lines: string[] = [];
  const emit = (n: TreeNode, depth: number, isRoot: boolean) => {
    const pad = '  '.repeat(depth);
    const tag = n.component === 'SVG' ? 'svg' : n.component === 'SVGVisualElement' ? (n.tag ?? 'g') : 'div';
    const attrs: string[] = [];
    if (includeIds) attrs.push(`id="${n.id}"`);
    if (n.component === 'SVG') attrs.push('xmlns="http://www.w3.org/2000/svg"');
    if (n.component === 'SVG' || n.component === 'SVGVisualElement') {
      for (const [k, v] of Object.entries(toReactAttrs(n.attrs))) attrs.push(`${k}=${jsxString(v)}`);
    }
    const style = styleFor(n, isRoot);
    if (format === 'tailwind') {
      const { classes, rest } = stylesToTailwind(style);
      if (classes.length) attrs.push(`className="${classes.join(' ')}"`);
      if (Object.keys(rest).length) attrs.push(`style={${styleObject(rest)}}`);
    } else if (Object.keys(style).length) {
      attrs.push(`style={${styleObject(style)}}`);
    }
    const open = `${pad}<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
    const kids = doc.childIds(n.id).map((c) => doc.view(c)!).filter((c) => c && c.isVisible !== false);
    const defs = n.component === 'SVG' && n.svgNonRendered ? svgMarkupToJsx(n.svgNonRendered) : '';
    const text = n.component === 'Text' || (n.component === 'SVGVisualElement' && (n.tag === 'text' || n.tag === 'tspan')) ? n.textValue ?? '' : '';
    if (kids.length === 0 && !text && !defs) {
      lines.push(`${open} />`);
      return;
    }
    lines.push(`${open}>`);
    if (defs) lines.push(`${pad}  ${defs}`);
    if (text) lines.push(...jsxText(text).split('\n').map((l) => `${pad}  ${l}`));
    for (const k of kids) emit(k, depth + 1, false);
    lines.push(`${pad}</${tag}>`);
  };
  if (isRootId(nodeId)) {
    // La raíz de página no es un elemento: se exportan sus hijos en un fragmento.
    const kids = doc.childIds(nodeId).map((c) => doc.view(c)!).filter((c) => c && c.isVisible !== false);
    if (kids.length === 0) return '';
    if (kids.length === 1) {
      emit(kids[0]!, 0, true);
      return lines.join('\n');
    }
    lines.push('<>');
    for (const k of kids) emit(k, 1, true);
    lines.push('</>');
    return lines.join('\n');
  }
  emit(node, 0, true);
  return lines.join('\n');
}

function styleObject(s: Record<string, string>): string {
  const entries = Object.keys(s)
    .sort()
    .map((k) => {
      const v = s[k]!;
      const key = /^[a-zA-Z_$][\w$]*$/.test(k) ? k : `'${k}'`;
      if (UNITLESS.has(k) && /^-?\d*\.?\d+$/.test(v)) return `${key}: ${Number(v)}`;
      return `${key}: ${jsString(v)}`;
    });
  return `{ ${entries.join(', ')} }`;
}

const jsString = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const jsxString = (v: string) => (v.includes('"') ? `{${jsString(v)}}` : `"${v}"`);

/** Texto JSX: saltos → <br />, espacios múltiples protegidos, caracteres especiales escapados. */
function jsxText(t: string): string {
  return t
    .split('\n')
    .map((line) => {
      const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '{': "{'{'}", '}': "{'}'}" };
      const esc = line.replace(/[&<>{}]/g, (c) => map[c]!);
      return esc.replace(/ {2,}/g, (m) => `{'${m}'}`).replace(/^ | $/g, "{' '}");
    })
    .join('<br />\n');
}

/** Marcado SVG crudo (defs…) → JSX aproximado (atributos en camelCase). */
export function svgMarkupToJsx(markup: string): string {
  return markup
    .replace(/\sclass=/g, ' className=')
    .replace(/\s(xlink|xml):([a-z]+)=/g, (_, ns: string, n: string) => ` ${ns}${n[0]!.toUpperCase()}${n.slice(1)}=`)
    .replace(/\s([a-z]+(?:-[a-z]+)+)=/g, (m, name: string) => (name.startsWith('data-') || name.startsWith('aria-') ? m : ` ${name.replace(/-([a-z])/g, (_x, c: string) => c.toUpperCase())}=`))
    .replace(/\sstyle="([^"]*)"/g, (_, css: string) => {
      const obj = css
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const i = d.indexOf(':');
          const k = d.slice(0, i).trim().replace(/-([a-z])/g, (_x, c: string) => c.toUpperCase());
          return `${k}: ${jsString(d.slice(i + 1).trim())}`;
        });
      return ` style={{ ${obj.join(', ')} }}`;
    });
}
