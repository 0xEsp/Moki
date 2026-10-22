import { expandShorthand, SHORTHANDS } from './css';
import { applyStyleOverride, ROOT_POSITION_PROPS, type NodeOverride } from './components';
import type { StyleValue, Styles, TreeNode } from './types';

// Convertir una copia "a mano" de un componente en una instancia suya, sin cambiar cómo se ve.
//
// Se recorren en paralelo el árbol efectivo del main y el de la copia. Si la estructura coincide
// (mismo tipo de nodo, tag, atributos SVG y número de hijos), cada diferencia (estilos, texto,
// visibilidad) se guarda como override con la clave del nodo en el main. Los overrides son
// mínimos a propósito: lo que no difiere sigue heredándose, así editar el main llega a la copia.

export interface ViewAccess {
  /** Vista efectiva (overrides aplicados) de un nodo real o virtual. */
  view(id: string): TreeNode | undefined;
  /** Hijos efectivos (virtuales dentro de instancias). */
  childIds(id: string): string[];
}

export type ConversionPlan =
  | { ok: true; rootStyles: Styles; overrides: Record<string, NodeOverride>; overrideCount: number }
  | { ok: false; reason: string };

const UNSET = 'unset';

/** Forma comparable: sin 'unset' (equivale a ausente) y con los shorthands expandidos. */
function normalize(styles: Styles): Record<string, string> {
  let cur: Styles = {};
  for (const [k, v] of Object.entries(styles)) if (String(v).trim() !== UNSET) cur[k] = v;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const next: Styles = {};
    for (const [k, v] of Object.entries(cur)) {
      const ex = SHORTHANDS[k] ? expandShorthand(k, v) : null;
      if (ex) {
        changed = true;
        for (const [ek, ev] of Object.entries(ex)) if (next[ek] === undefined) next[ek] = ev;
      } else next[k] = v;
    }
    cur = next;
    if (!changed) break;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cur)) out[k] = String(v).trim();
  return out;
}

function sameStyles(a: Styles, b: Styles): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
  for (const k of keys) if (na[k] !== nb[k]) return false;
  return true;
}

/** Patch ordenado (primero los borrados) que lleva `base` a `target`; null si no hay diferencias. */
function stylePatch(base: Styles, target: Styles, skip: readonly string[] = []): Styles | null {
  const removals: Styles = {};
  const sets: Styles = {};
  for (const k of Object.keys(base)) {
    if (skip.includes(k)) continue;
    if (target[k] === undefined && String(base[k]).trim() !== UNSET) removals[k] = UNSET;
  }
  for (const [k, v] of Object.entries(target)) {
    if (skip.includes(k)) continue;
    if (base[k] === undefined || String(base[k]).trim() !== String(v).trim()) sets[k] = v;
  }
  const minimal = { ...removals, ...sets };
  const apply = (patch: Styles) => applyStyleOverride(withoutKeys(base, skip), patch);
  const want = withoutKeys(target, skip);
  if (sameStyles(apply(minimal), want)) return Object.keys(minimal).length ? minimal : null;
  // Mezcla de shorthands y longhands: se reemplaza el estilo entero de ese nodo.
  const full: Styles = {};
  for (const k of Object.keys(base)) if (!skip.includes(k)) full[k] = UNSET;
  Object.assign(full, want);
  if (sameStyles(apply(full), want)) return full;
  throw new Error('styles could not be expressed as overrides');
}

function withoutKeys(styles: Styles, keys: readonly string[]): Styles {
  const out: Styles = {};
  for (const [k, v] of Object.entries(styles)) if (!keys.includes(k)) out[k] = v;
  return out;
}

const sortedJson = (o: Record<string, string> | undefined) =>
  o ? JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])) : '';

/**
 * Plan para convertir `memberId` en instancia de `mainId`: estilos propios de la raíz de la
 * instancia y overrides de sus hijos. Devuelve `ok: false` con el motivo si la estructura difiere.
 */
export function planInstanceConversion(acc: ViewAccess, memberId: string, mainId: string): ConversionPlan {
  const main = acc.view(mainId);
  const member = acc.view(memberId);
  if (!main || !member) return { ok: false, reason: 'node not found' };
  if (member.component !== 'Frame') return { ok: false, reason: `only frames can become instances (got ${member.component})` };

  const overrides: Record<string, NodeOverride> = {};
  let count = 0;
  const describe = (n: TreeNode) => `"${n.label}"`;

  const walk = (mainEff: string, memberEff: string): string | null => {
    const mk = acc.childIds(mainEff);
    const ck = acc.childIds(memberEff);
    if (mk.length !== ck.length) {
      return `${describe(acc.view(memberEff)!)} has ${ck.length} children, the component has ${mk.length}`;
    }
    for (let i = 0; i < mk.length; i++) {
      const m = acc.view(mk[i]!)!;
      const c = acc.view(ck[i]!)!;
      if (m.component !== c.component) return `${describe(c)} is a ${c.component}, the component has a ${m.component}`;
      if ((m.tag ?? '') !== (c.tag ?? '')) return `${describe(c)} is <${c.tag}>, the component has <${m.tag}>`;
      if (sortedJson(m.attrs) !== sortedJson(c.attrs) || (m.svgNonRendered ?? '') !== (c.svgNonRendered ?? '')) {
        return `${describe(c)} has different SVG content`;
      }
      const o: NodeOverride = {};
      try {
        const patch = stylePatch(m.styles, c.styles);
        if (patch) o.styles = patch;
      } catch {
        return `${describe(c)}: styles could not be expressed as overrides`;
      }
      if ((m.textValue ?? '') !== (c.textValue ?? '')) o.textValue = c.textValue ?? '';
      const mv = m.isVisible !== false;
      const cv = c.isVisible !== false;
      if (mv !== cv) o.isVisible = cv;
      if (Object.keys(o).length) {
        // La clave es el id efectivo en el main ("k" o "J::k" dentro de instancias anidadas).
        overrides[mk[i]!] = o;
        count++;
      }
      const err = walk(mk[i]!, ck[i]!);
      if (err) return err;
    }
    return null;
  };

  const err = walk(mainId, memberId);
  if (err) return { ok: false, reason: err };

  // Raíz: lo que el main no aporta (posición) se conserva siempre; el resto, solo si difiere.
  const base = withoutKeys(main.styles, ROOT_POSITION_PROPS);
  let rootStyles: Styles;
  try {
    rootStyles = { ...(stylePatch(base, member.styles, ROOT_POSITION_PROPS) ?? {}) };
  } catch {
    return { ok: false, reason: `${describe(member)}: root styles could not be expressed as overrides` };
  }
  for (const k of ROOT_POSITION_PROPS) {
    const v: StyleValue | undefined = member.styles[k];
    if (v !== undefined) rootStyles[k] = v;
  }
  return { ok: true, rootStyles, overrides, overrideCount: count };
}

export const _test = { normalize, sameStyles, stylePatch };
