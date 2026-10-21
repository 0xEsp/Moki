import type { Styles, StyleValue } from './types';

// Utilidades CSS compartidas: nombres, unidades y normalización de shorthands.
// Un nodo nunca mezcla un shorthand con sus longhands (React lo desaconseja y el diff
// sería ambiguo): al escribir uno, se expande o se borra el otro.

export const camelCase = (s: string) =>
  s.trim().startsWith('--') ? s.trim() : s.trim().toLowerCase().replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export const kebabCase = (s: string) =>
  s.startsWith('--') ? s : s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()).replace(/^ms-/, '-ms-').replace(/^webkit-/, '-webkit-');

/** Propiedades cuyo valor numérico NO lleva px. */
export const UNITLESS = new Set([
  'opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flexGrow', 'flexShrink', 'flex', 'order',
  'aspectRatio', 'zoom', 'lineClamp', 'WebkitLineClamp', 'fillOpacity', 'strokeOpacity',
  'strokeMiterlimit', 'stopOpacity', 'floodOpacity', 'columnCount', 'gridRow', 'gridColumn',
  'gridRowStart', 'gridRowEnd', 'gridColumnStart', 'gridColumnEnd', 'scale', 'tabSize',
  'orphans', 'widows', 'animationIterationCount',
]);

export function toCssValue(prop: string, v: StyleValue): string {
  if (typeof v === 'number') return UNITLESS.has(prop) || v === 0 ? String(v) : `${v}px`;
  return v;
}

/** Divide un valor CSS por espacios respetando paréntesis y comillas. */
export function splitCssValue(value: string, sep: ' ' | ',' = ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of value) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    const isSep = sep === ' ' ? /\s/.test(ch) : ch === ',';
    if (isSep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Parsea `a: b; c: d` (atributo style) respetando paréntesis, comillas y comentarios. */
export function parseStyleAttribute(css: string): Styles {
  const out: Styles = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const decl of splitDeclarations(clean)) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    let value = decl.slice(i + 1).trim();
    if (!prop || !value) continue;
    value = value.replace(/\s*!important\s*$/i, '');
    out[camelCase(prop)] = value;
  }
  return out;
}

function splitDeclarations(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of css) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Shorthands

const BOX: Record<string, [string, string, string, string]> = {
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  inset: ['top', 'right', 'bottom', 'left'],
  borderWidth: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'],
  borderStyle: ['borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle'],
  borderColor: ['borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'],
  borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'],
};

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;

/** shorthand → longhands directos. */
export const SHORTHANDS: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(BOX).map(([k, v]) => [k, [...v]])),
  gap: ['rowGap', 'columnGap'],
  overflow: ['overflowX', 'overflowY'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  flexFlow: ['flexDirection', 'flexWrap'],
  placeItems: ['alignItems', 'justifyItems'],
  placeContent: ['alignContent', 'justifyContent'],
  placeSelf: ['alignSelf', 'justifySelf'],
  border: ['borderWidth', 'borderStyle', 'borderColor', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft'],
  ...Object.fromEntries(SIDES.map((s) => [`border${s}`, [`border${s}Width`, `border${s}Style`, `border${s}Color`]])),
  background: ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundClip', 'backgroundOrigin', 'backgroundAttachment'],
  outline: ['outlineWidth', 'outlineStyle', 'outlineColor'],
  textDecoration: ['textDecorationLine', 'textDecorationColor', 'textDecorationStyle', 'textDecorationThickness'],
  font: ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'fontVariant', 'fontStretch'],
  gridArea: ['gridRowStart', 'gridColumnStart', 'gridRowEnd', 'gridColumnEnd'],
  gridRow: ['gridRowStart', 'gridRowEnd'],
  gridColumn: ['gridColumnStart', 'gridColumnEnd'],
};

/** Todos los longhands (transitivos) de un shorthand. */
export function allLonghands(prop: string): string[] {
  const direct = SHORTHANDS[prop];
  if (!direct) return [];
  const out = new Set<string>();
  for (const d of direct) {
    out.add(d);
    for (const x of allLonghands(d)) out.add(x);
  }
  return [...out];
}

/** Shorthands (transitivos) que contienen a `prop`. */
export function shorthandsOf(prop: string): string[] {
  return Object.keys(SHORTHANDS).filter((s) => allLonghands(s).includes(prop));
}

function expandBox(value: string): [string, string, string, string] {
  const p = splitCssValue(value);
  const [a, b = a, c = a, d = b] = p as [string, string?, string?, string?];
  return [a, b!, c!, d!];
}

const BORDER_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);

function splitBorder(value: string): { width?: string; style?: string; color?: string } {
  const out: { width?: string; style?: string; color?: string } = {};
  for (const part of splitCssValue(value)) {
    if (BORDER_STYLES.has(part)) out.style = part;
    else if (/^-?\d|^thin$|^medium$|^thick$|^calc\(|^var\(t:/.test(part) && !out.width && !/^var\(t:/.test(part)) out.width = part;
    else out.color = part;
  }
  return out;
}

/** Expande un shorthand presente en `styles` a sus longhands directos (cuando es posible). */
export function expandShorthand(prop: string, value: StyleValue): Styles | null {
  const v = String(value);
  if (BOX[prop]) {
    const parts = expandBox(v);
    return Object.fromEntries(BOX[prop]!.map((k, i) => [k, parts[i]!]));
  }
  switch (prop) {
    case 'gap': {
      const [r, c = r] = splitCssValue(v);
      return { rowGap: r!, columnGap: c! };
    }
    case 'overflow': {
      const [x, y = x] = splitCssValue(v);
      return { overflowX: x!, overflowY: y! };
    }
    case 'border': {
      const b = splitBorder(v);
      const out: Styles = {};
      if (b.width) out.borderWidth = b.width;
      if (b.style) out.borderStyle = b.style;
      if (b.color) out.borderColor = b.color;
      return out;
    }
    case 'borderTop':
    case 'borderRight':
    case 'borderBottom':
    case 'borderLeft': {
      const b = splitBorder(v);
      const out: Styles = {};
      if (b.width) out[`${prop}Width`] = b.width;
      if (b.style) out[`${prop}Style`] = b.style;
      if (b.color) out[`${prop}Color`] = b.color;
      return out;
    }
    case 'background': {
      // Un color simple → backgroundColor; si no, todo va a backgroundImage.
      const parts = splitCssValue(v, ',');
      if (parts.length === 1 && !/url\(|gradient\(/.test(v)) return { backgroundColor: v };
      return { backgroundImage: v };
    }
    default:
      return null;
  }
}

/**
 * Aplica `incoming` sobre `current` (sin mutar) respetando shorthands. `null`/`""` borra.
 * Devuelve los estilos resultantes.
 */
export function mergeStyles(current: Styles, incoming: Record<string, StyleValue | null | undefined>): Styles {
  const next: Styles = { ...current };
  for (const [rawKey, value] of Object.entries(incoming)) {
    const key = rawKey.startsWith('--') ? rawKey : camelCase(kebabCase(rawKey));
    // 1) Si algún shorthand que contiene a `key` está presente, se expande primero.
    for (const sh of shorthandsOf(key)) {
      if (next[sh] === undefined) continue;
      const expanded = expandShorthand(sh, next[sh]!);
      delete next[sh];
      if (expanded) {
        for (const [k, v] of Object.entries(expanded)) if (next[k] === undefined) next[k] = v;
      }
    }
    // 2) Si `key` es shorthand, se borran sus longhands.
    for (const lh of allLonghands(key)) delete next[lh];
    // 3) Asignar o borrar.
    if (value === null || value === undefined || value === '') delete next[key];
    else next[key] = typeof value === 'string' ? value.trim() : value;
  }
  return next;
}

/** Compacta longhands de caja a shorthand cuando son iguales (para salidas legibles). */
export function compactStyles(styles: Record<string, string>): Record<string, string> {
  const out = { ...styles };
  for (const [sh, longs] of Object.entries(BOX)) {
    const vals = longs.map((l) => out[l]);
    if (vals.some((x) => x === undefined)) continue;
    const [t, r, b, l] = vals as string[];
    let v: string;
    if (t === r && r === b && b === l) v = t!;
    else if (t === b && r === l) v = `${t} ${r}`;
    else if (r === l) v = `${t} ${r} ${b}`;
    else v = `${t} ${r} ${b} ${l}`;
    for (const l2 of longs) delete out[l2];
    out[sh] = v;
  }
  if (out.rowGap !== undefined && out.rowGap === out.columnGap) {
    out.gap = out.rowGap;
    delete out.rowGap;
    delete out.columnGap;
  }
  return out;
}

/** Valor px numérico de un estilo, o null si no es px/número. */
export function pxValue(v: StyleValue | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return v;
  const m = /^(-?\d*\.?\d+)(px)?$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}
