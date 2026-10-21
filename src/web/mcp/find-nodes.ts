import { converter, parse as parseColor } from 'culori';
import { splitCssValue, toCssValue } from '../../core/css';
import { INTERNAL_REF_RE, cssNameOf, resolveTokenDeep, serializePrimitive, tokenByCssName } from '../../core/tokens';
import type { MokiFile, TreeNode } from '../../core/types';

// Matcher de `find_nodes`: comodines, familias de propiedades con "slots" (padding ↔ paddingTop),
// alias, equivalencia de colores (también dentro de valores compuestos y a través de tokens).

export interface StyleFilter {
  styleName?: string;
  styleValue?: string;
}

export type Match = { styleName: string; styleValue: string } | { textValue: string };

const norm = (s: string) => s.replace(/-/g, '').toLowerCase();

export function wildcardRegex(pattern: string): RegExp {
  const esc = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${esc}$`, 'is');
}

export function wildcardMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern.toLowerCase() === value.toLowerCase();
  return wildcardRegex(pattern).test(value);
}

// ------------------------------------------------------------------ familias y slots

type Fam = { family: string; slots: string[] };
const SIDES4 = ['t', 'r', 'b', 'l'];

function boxFamily(prefix: string, suffix = ''): Record<string, Fam> {
  const f = prefix + suffix;
  return {
    [norm(`${prefix}${suffix}`)]: { family: f, slots: SIDES4 },
    [norm(`${prefix}Top${suffix}`)]: { family: f, slots: ['t'] },
    [norm(`${prefix}Right${suffix}`)]: { family: f, slots: ['r'] },
    [norm(`${prefix}Bottom${suffix}`)]: { family: f, slots: ['b'] },
    [norm(`${prefix}Left${suffix}`)]: { family: f, slots: ['l'] },
    [norm(`${prefix}Inline${suffix}`)]: { family: f, slots: ['l', 'r'] },
    [norm(`${prefix}Block${suffix}`)]: { family: f, slots: ['t', 'b'] },
    [norm(`${prefix}InlineStart${suffix}`)]: { family: f, slots: ['l'] },
    [norm(`${prefix}InlineEnd${suffix}`)]: { family: f, slots: ['r'] },
    [norm(`${prefix}BlockStart${suffix}`)]: { family: f, slots: ['t'] },
    [norm(`${prefix}BlockEnd${suffix}`)]: { family: f, slots: ['b'] },
  };
}

const FAMILIES: Record<string, Fam> = {
  ...boxFamily('padding'),
  ...boxFamily('margin'),
  inset: { family: 'inset', slots: SIDES4 },
  top: { family: 'inset', slots: ['t'] },
  right: { family: 'inset', slots: ['r'] },
  bottom: { family: 'inset', slots: ['b'] },
  left: { family: 'inset', slots: ['l'] },
  insetinline: { family: 'inset', slots: ['l', 'r'] },
  insetblock: { family: 'inset', slots: ['t', 'b'] },
  borderradius: { family: 'radius', slots: ['tl', 'tr', 'br', 'bl'] },
  bordertopleftradius: { family: 'radius', slots: ['tl'] },
  bordertoprightradius: { family: 'radius', slots: ['tr'] },
  borderbottomrightradius: { family: 'radius', slots: ['br'] },
  borderbottomleftradius: { family: 'radius', slots: ['bl'] },
  width: { family: 'size', slots: ['w'] },
  inlinesize: { family: 'size', slots: ['w'] },
  height: { family: 'size', slots: ['h'] },
  blocksize: { family: 'size', slots: ['h'] },
  minwidth: { family: 'size', slots: ['minw'] },
  mininlinesize: { family: 'size', slots: ['minw'] },
  maxwidth: { family: 'size', slots: ['maxw'] },
  maxinlinesize: { family: 'size', slots: ['maxw'] },
  minheight: { family: 'size', slots: ['minh'] },
  minblocksize: { family: 'size', slots: ['minh'] },
  maxheight: { family: 'size', slots: ['maxh'] },
  maxblocksize: { family: 'size', slots: ['maxh'] },
};
// Borde: slots lado × aspecto.
{
  const aspects = ['w', 's', 'c'];
  const sides: Record<string, string[]> = { '': SIDES4, Top: ['t'], Right: ['r'], Bottom: ['b'], Left: ['l'] };
  const asp: Record<string, string[]> = { '': aspects, Width: ['w'], Style: ['s'], Color: ['c'] };
  for (const [side, ss] of Object.entries(sides)) {
    for (const [a, as] of Object.entries(asp)) {
      FAMILIES[norm(`border${side}${a}`)] = { family: 'border', slots: ss.flatMap((s) => as.map((x) => `${s}${x}`)) };
    }
  }
}

const ALIASES: Record<string, string> = { radius: 'borderradius', background: 'backgroundcolor', bg: 'backgroundcolor' };

/** ¿La clave de estilo `key` (camelCase) casa con el nombre consultado? */
export function styleNameMatches(query: string, key: string): boolean {
  let q = norm(query);
  q = ALIASES[q] ?? q;
  const k = norm(key);
  if (q.includes('*')) return wildcardMatch(q, k);
  if (q === k) return true;
  const fq = FAMILIES[q];
  const fk = FAMILIES[k];
  if (fq && fk && fq.family === fk.family) return fq.slots.some((s) => fk.slots.includes(s));
  return false;
}

// ------------------------------------------------------------------ colores

const toRgb = converter('rgb');

export function colorKey(v: string): string | null {
  const s = v.trim();
  if (!s || /^-?\d/.test(s) || /^(none|auto|inherit|initial|unset|transparent0)$/i.test(s)) return null;
  const c = parseColor(s);
  if (!c) return null;
  const rgb = toRgb(c);
  if (!rgb) return null;
  const ch = (x: number | undefined) => Math.round(Math.max(0, Math.min(1, x ?? 0)) * 255);
  const a = Math.round((rgb.alpha ?? 1) * 1000) / 1000;
  return `${ch(rgb.r)},${ch(rgb.g)},${ch(rgb.b)},${a}`;
}

/** Fragmentos (posibles colores) de un valor compuesto: gradientes, bordes, sombras. */
function fragments(value: string): string[] {
  const out: string[] = [];
  const walk = (v: string) => {
    for (const commaPart of splitCssValue(v, ',')) {
      for (const p of splitCssValue(commaPart, ' ')) {
        out.push(p);
        const fn = /^([a-z-]+)\((.*)\)$/is.exec(p);
        if (fn && /gradient|color-mix|var|calc/i.test(fn[1]!)) walk(fn[2]!);
      }
    }
  };
  walk(value);
  return out;
}

// ------------------------------------------------------------------ matcher principal

const COLOR_QUERY_KEYS = new Set(['color', 'backgroundcolor', 'backgroundimage', 'background']);

export interface FindQuery {
  textValue?: string;
  filters?: StyleFilter[];
}

/** Devuelve los matches de un nodo o null si no casa con TODOS los criterios. */
export function matchNode(file: MokiFile, node: TreeNode, q: FindQuery): Match[] | null {
  const matched: Match[] = [];
  if (q.textValue !== undefined) {
    if (node.component !== 'Text') return null;
    const t = node.textValue ?? '';
    if (!wildcardMatch(q.textValue, t)) return null;
    matched.push({ textValue: t });
  }
  for (const f of q.filters ?? []) {
    const m = matchFilter(file, node, f);
    if (m.length === 0) return null;
    matched.push(...m);
  }
  // Dedupe
  const seen = new Set<string>();
  return matched.filter((m) => {
    const k = JSON.stringify(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function candidateKeys(node: TreeNode, styleName: string | undefined): string[] {
  const keys = Object.keys(node.styles);
  if (styleName === undefined) return keys;
  const q = ALIASES[norm(styleName)] ?? norm(styleName);
  const out = keys.filter((k) => styleNameMatches(styleName, k));
  if (COLOR_QUERY_KEYS.has(q)) {
    const fill = node.component === 'Text' ? ['color', 'background', 'backgroundColor', 'backgroundImage', 'WebkitTextFillColor'] : ['background', 'backgroundColor', 'backgroundImage'];
    for (const k of fill) if (node.styles[k] !== undefined && !out.includes(k)) out.push(k);
  }
  return out;
}

function externalValue(file: MokiFile, raw: string): string {
  return raw.replace(INTERNAL_REF_RE, (m, id: string) => {
    const t = file.theme.tokens[id];
    return t && !t['~'] ? `var(${cssNameOf(t)})` : m;
  });
}

function matchFilter(file: MokiFile, node: TreeNode, f: StyleFilter): Match[] {
  const keys = candidateKeys(node, f.styleName);
  const out: Match[] = [];
  const sv = f.styleValue?.trim();

  // Token: "--x" o "var(--x)"
  const tokRef = sv ? /^(?:var\(\s*)?(--[a-zA-Z0-9_*-]+)\s*\)?$/.exec(sv) : null;
  const queryColor = sv && !tokRef ? colorKey(sv) : null;

  for (const k of keys) {
    const raw = toCssValue(k, node.styles[k]!);
    const ext = externalValue(file, raw);
    if (sv === undefined) {
      out.push({ styleName: k, styleValue: ext });
      continue;
    }
    if (tokRef) {
      const pattern = tokRef[1]!;
      for (const m of raw.matchAll(INTERNAL_REF_RE)) {
        const t = file.theme.tokens[m[1]!];
        if (t && !t['~'] && wildcardMatch(pattern, cssNameOf(t))) out.push({ styleName: k, styleValue: `var(${cssNameOf(t)})` });
      }
      continue;
    }
    if (queryColor) {
      for (const frag of fragments(raw)) {
        const tm = /^var\((t:[0-9a-z]+-[0-9a-z]+)\)$/.exec(frag);
        if (tm) {
          const r = resolveTokenDeep(file, tm[1]!);
          if (r && r.token.type === 'color' && colorKey(serializePrimitive('color', r.value)) === queryColor) {
            const t = file.theme.tokens[tm[1]!]!;
            out.push({ styleName: k, styleValue: `var(${cssNameOf(t)})` });
          }
          continue;
        }
        if (colorKey(frag) === queryColor) out.push({ styleName: k, styleValue: frag });
      }
      continue;
    }
    if (norm(k) === 'fontfamily') {
      const fams = splitCssValue(ext, ',').map((x) => x.replace(/^['"]|['"]$/g, '').trim());
      const m = fams.find((x) => wildcardMatch(sv.replace(/^['"]|['"]$/g, ''), x));
      if (m) out.push({ styleName: k, styleValue: m });
      continue;
    }
    if (wildcardMatch(sv, ext) || wildcardMatch(sv, raw)) out.push({ styleName: k, styleValue: ext });
  }
  return out;
}

export { tokenByCssName };
