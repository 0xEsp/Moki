import { camelCase, kebabCase, mergeStyles } from '../../core/css';
import { externalToInternal } from '../../core/tokens';
import { FREEFORM_DISPLAY, type MokiFile, type Styles, type StyleValue, type TreeNode } from '../../core/types';
import { isRootId } from '../../core/tree';

// Semántica de `update_styles`: fusión respetando shorthands, conversión de tokens y
// eliminación de estilos inertes según el contexto del nodo.

const FLEX_CHILD = ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'order'];
const GRID_CHILD = ['gridArea', 'gridRow', 'gridRowStart', 'gridRowEnd', 'gridColumn', 'gridColumnStart', 'gridColumnEnd', 'justifySelf'];
const FLEX_CONTAINER = ['flexDirection', 'flexWrap', 'flexFlow', 'alignItems', 'justifyContent', 'alignContent', 'placeItems', 'placeContent', 'gap', 'rowGap', 'columnGap'];
const GRID_CONTAINER = ['gridTemplate', 'gridTemplateColumns', 'gridTemplateRows', 'gridTemplateAreas', 'gridAutoFlow', 'gridAutoRows', 'gridAutoColumns', 'justifyItems'];

const isFlexDisplay = (d: unknown) => d === 'flex' || d === 'inline-flex';
const isGridDisplay = (d: unknown) => d === 'grid' || d === 'inline-grid';

export interface InertContext {
  node: Pick<TreeNode, 'component' | 'id'>;
  parent: Pick<TreeNode, 'styles' | 'id'> | null | undefined;
  /** ¿Algún hijo directo es absoluto? (position:relative sí aporta). */
  hasAbsoluteChildren?: boolean;
}

/** Devuelve las claves inertes de `styles` en su contexto. */
export function inertKeys(styles: Styles, ctx: InertContext): string[] {
  const out: string[] = [];
  const parentDisplay = ctx.parent?.styles.display;
  const parentFreeform = !!ctx.parent && (parentDisplay === FREEFORM_DISPLAY || isRootId(ctx.parent.id));
  const parentFlex = isFlexDisplay(parentDisplay);
  const parentGrid = isGridDisplay(parentDisplay);
  const display = styles.display;
  const pos = String(styles.position ?? '');
  const absolute = pos === 'absolute' || pos === 'fixed' || parentFreeform;
  const has = (k: string) => styles[k] !== undefined;

  for (const k of FLEX_CHILD) {
    if (!has(k)) continue;
    if (!(parentFlex || (parentGrid && k === 'alignSelf') || (parentGrid && k === 'order'))) out.push(k);
    else if (absolute && k === 'alignSelf') out.push(k);
  }
  for (const k of GRID_CHILD) {
    if (!has(k)) continue;
    if (!parentGrid || (absolute && k === 'justifySelf')) out.push(k);
  }
  for (const k of FLEX_CONTAINER) {
    if (has(k) && !isFlexDisplay(display) && !isGridDisplay(display)) out.push(k);
  }
  for (const k of GRID_CONTAINER) {
    if (has(k) && !isGridDisplay(display)) out.push(k);
  }
  if (has('zIndex') && !absolute && (pos === '' || pos === 'static') && !parentFlex && !parentGrid) out.push('zIndex');
  if (pos === 'relative' && !parentFreeform) {
    const offsets = ['top', 'left', 'right', 'bottom', 'inset', 'zIndex'].some(has);
    if (!offsets && !ctx.hasAbsoluteChildren) out.push('position');
  }
  if (has('verticalAlign') && !/inline|table-cell/.test(String(display ?? ''))) out.push('verticalAlign');
  for (const k of ['float', 'clear']) if (has(k) && (parentFlex || parentGrid || absolute)) out.push(k);
  if (styles.whiteSpace === 'nowrap' && ctx.node.component !== 'Text') out.push('whiteSpace');
  return [...new Set(out)];
}

/** Normaliza claves y convierte `var(--token)` a referencias internas. */
export function normalizeIncoming(file: MokiFile, styles: Record<string, StyleValue | null>): Record<string, StyleValue | null> {
  const out: Record<string, StyleValue | null> = {};
  for (const [rawK, v] of Object.entries(styles)) {
    const k = rawK.startsWith('--') ? rawK : camelCase(kebabCase(rawK));
    out[k] = typeof v === 'string' ? externalToInternal(file, v.trim()) : v;
  }
  return out;
}

/**
 * Calcula los estilos resultantes de aplicar `incoming` a un nodo. Devuelve los estilos
 * finales (sin inertes) y las claves pasadas por el agente que se ignoraron.
 */
export function computeAgentStyles(
  file: MokiFile,
  current: Styles,
  incoming: Record<string, StyleValue | null>,
  ctx: InertContext,
): { styles: Styles; ignoredStyles: string[] } {
  const norm = normalizeIncoming(file, incoming);
  const merged = mergeStyles(current, norm);
  const inert = inertKeys(merged, ctx);
  const styles: Styles = { ...merged };
  for (const k of inert) delete styles[k];
  const passed = new Set(Object.keys(norm).filter((k) => norm[k] !== null && norm[k] !== ''));
  const ignoredStyles = inert.filter((k) => passed.has(k));
  return { styles, ignoredStyles };
}
