import { FREEFORM_DISPLAY, type MokiFile, type TreeNode } from './types';
import { toCssValue } from './css';
import { internalToExternal, internalToRender, internalToResolved, quoteFontFamilyList } from './tokens';
import { isRootId } from './tree';

// Del modelo a CSS efectivo. Un único sitio decide cómo se pinta un nodo, de modo que
// canvas, capturas, export y JSX coinciden.

export type StyleMode =
  /** Canvas y capturas: tokens → variables internas (--moki-…). */
  | 'render'
  /** Hacia el agente / código: tokens → var(--nombre). */
  | 'external'
  /** Valores resueltos (sin variables). */
  | 'resolved';

export interface StyleContext {
  file: MokiFile;
  parent: TreeNode | null | undefined;
  mode: StyleMode;
}

/** Devuelve el CSS efectivo del nodo en camelCase, todo como string. */
export function computeNodeStyle(node: TreeNode, ctx: StyleContext): Record<string, string> {
  const out: Record<string, string> = {};
  const map =
    ctx.mode === 'render'
      ? internalToRender
      : ctx.mode === 'external'
        ? (v: string) => internalToExternal(ctx.file, v)
        : (v: string) => internalToResolved(ctx.file, v);

  for (const [k, raw] of Object.entries(node.styles)) {
    if (raw === null || raw === undefined || raw === '') continue;
    out[k] = map(toCssValue(k, raw));
  }
  if (out.fontFamily && !out.fontFamily.includes('var(')) out.fontFamily = quoteFontFamilyList(out.fontFamily);

  // Contenedor libre: bloque relativo (los hijos se posicionan con left/top).
  if (node.styles.display === FREEFORM_DISPLAY || isRootId(node.id)) {
    delete out.display;
    if (!out.position || out.position === 'static') out.position = 'relative';
  }

  // Hijo de un padre libre: absoluto por defecto.
  if (ctx.parent && (ctx.parent.styles.display === FREEFORM_DISPLAY || isRootId(ctx.parent.id))) {
    if (out.position !== 'absolute' && out.position !== 'fixed') out.position = 'absolute';
    if (out.left === undefined && out.right === undefined) out.left = '0px';
    if (out.top === undefined && out.bottom === undefined) out.top = '0px';
  }

  if (node.component === 'Text') {
    if (out.whiteSpace === undefined && out.textWrap === undefined) out.whiteSpace = 'pre-wrap';
  }

  return out;
}

/** Serializa a `prop: value;` (kebab-case). */
export function styleToCssText(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([k, v]) => `${k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
    .join(';');
}
