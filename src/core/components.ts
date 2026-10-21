import { mergeStyles } from './css';
import type { StyleValue, Styles, TreeNode } from './types';

// Componentes e instancias.
//
// Un componente principal ("main") es un Frame con `isComponent`. Una instancia es un Frame con
// `instanceOf = <mainId>` y SIN hijos guardados: sus hijos se resuelven al vuelo desde el main,
// con ids virtuales `<instanceId>::<idEnElMain>` (un segmento más por cada instancia anidada:
// `I::J::k` = nodo k del main de J, que a su vez está dentro del main de I). Los overrides de la
// instancia se guardan en `overrides[<ruta relativa>]`, donde la ruta es lo que va tras el id de
// la instancia (`k` o `J::k`). Editar el main actualiza todas las instancias.

export const VSEP = '::';
const MAX_DEPTH = 8;

export interface NodeOverride {
  styles?: Styles;
  textValue?: string;
  isVisible?: boolean;
}

export const isVirtualId = (id: string | null | undefined): boolean => !!id && id.includes(VSEP);

export function splitVirtualId(id: string): string[] {
  return id.split(VSEP);
}

/** Id de la instancia real más externa de un id virtual (o el propio id). */
export const outerInstanceOf = (id: string): string => id.split(VSEP)[0]!;

/** Estilos del main que no se heredan en la raíz de la instancia (posición en su página). */
const ROOT_POSITION_PROPS = ['position', 'left', 'top', 'right', 'bottom', 'inset', 'zIndex'];

export interface ComponentEnv {
  /** Nodo guardado aunque esté borrado (soft delete): los mains borrados siguen pintando. */
  raw(id: string): TreeNode | undefined;
  /** Hijos reales vivos, ordenados. */
  children(id: string): string[];
  /** Padre real (relación guardada). */
  parent(id: string): string | null;
}

interface Level {
  /** Id (real o virtual) del nodo instancia de este nivel. */
  id: string;
  inst: TreeNode;
  mainId: string;
}

interface Resolved {
  segs: string[];
  base: TreeNode;
  levels: Level[];
}

export class ComponentResolver {
  constructor(private env: ComponentEnv) {}

  /** ¿`id` está dentro del subárbol real de `ancestor` (incluido)? */
  private withinReal(id: string, ancestor: string): boolean {
    let cur: string | null = id;
    for (let i = 0; cur && i < 10_000; i++) {
      if (cur === ancestor) return true;
      cur = this.env.parent(cur);
    }
    return false;
  }

  /** Resuelve un id virtual a su nodo base del main y la cadena de instancias. */
  resolve(id: string): Resolved | null {
    const segs = splitVirtualId(id);
    if (segs.length < 2 || segs.length > MAX_DEPTH + 1) return null;
    const first = this.env.raw(segs[0]!);
    if (!first?.instanceOf) return null;
    const levels: Level[] = [{ id: segs[0]!, inst: first, mainId: first.instanceOf }];
    const seen = new Set([first.instanceOf]);
    for (let i = 1; i < segs.length; i++) {
      const level = levels[levels.length - 1]!;
      const seg = segs[i]!;
      const n = this.env.raw(seg);
      if (!n || seg === level.mainId || !this.withinReal(seg, level.mainId)) return null;
      if (i < segs.length - 1) {
        if (!n.instanceOf || seen.has(n.instanceOf)) return null;
        seen.add(n.instanceOf);
        levels.push({ id: segs.slice(0, i + 1).join(VSEP), inst: n, mainId: n.instanceOf });
      }
    }
    return { segs, base: this.env.raw(segs[segs.length - 1]!)!, levels };
  }

  /** Estilos base de la raíz de una instancia: los del main (sin posición) + los propios. */
  instanceRootStyles(inst: TreeNode): Styles {
    const main = inst.instanceOf ? this.env.raw(inst.instanceOf) : undefined;
    if (!main) return { ...inst.styles };
    const base: Styles = {};
    for (const [k, v] of Object.entries(main.styles)) if (!ROOT_POSITION_PROPS.includes(k)) base[k] = v;
    return mergeStyles(base, inst.styles);
  }

  /** Overrides aplicables a un id virtual, de dentro hacia fuera (el nivel externo gana). */
  overridesFor(r: Resolved): NodeOverride[] {
    const out: NodeOverride[] = [];
    for (let j = r.levels.length - 1; j >= 0; j--) {
      const key = r.segs.slice(j + 1).join(VSEP);
      const o = r.levels[j]!.inst.overrides?.[key];
      if (o) out.push(o);
    }
    return out;
  }

  /** Vista efectiva (lectura) de un nodo virtual. */
  virtualView(id: string): TreeNode | undefined {
    const r = this.resolve(id);
    if (!r) return undefined;
    const base = r.base;
    let styles: Styles = base.instanceOf ? this.instanceRootStyles(base) : { ...base.styles };
    let textValue = base.textValue;
    let isVisible = base.isVisible;
    for (const o of this.overridesFor(r)) {
      if (o.styles) styles = mergeStyles(styles, o.styles);
      if (o.textValue !== undefined) textValue = o.textValue;
      if (o.isVisible !== undefined) isVisible = o.isVisible;
    }
    const view: TreeNode = { ...base, id, styles };
    delete view.isComponent;
    delete view['~'];
    if (textValue !== undefined) view.textValue = textValue;
    if (isVisible === false) view.isVisible = false;
    else delete view.isVisible;
    if (base.instanceOf) view.overrides = this.nestedOverrides(r);
    return view;
  }

  /** Vista efectiva de la raíz de una instancia real. */
  instanceView(inst: TreeNode): TreeNode {
    const main = inst.instanceOf ? this.env.raw(inst.instanceOf) : undefined;
    if (!main) {
      return {
        ...inst,
        styles: mergeStyles(
          { width: '120px', height: '48px', outline: '1px dashed #E5484D', backgroundColor: '#FFF1F0' },
          inst.styles,
        ),
      };
    }
    return { ...inst, styles: this.instanceRootStyles(inst) };
  }

  isMissingMain(inst: TreeNode): boolean {
    return !!inst.instanceOf && !this.env.raw(inst.instanceOf);
  }

  /**
   * Overrides que hereda una instancia anidada (nodo virtual que es instancia), re-indexados
   * respecto a ella: los suyos guardados + los de niveles externos con prefijo de su ruta.
   */
  nestedOverrides(r: Resolved): Record<string, NodeOverride> {
    const out: Record<string, NodeOverride> = {};
    const merge = (key: string, o: NodeOverride) => {
      const prev = out[key] ?? {};
      out[key] = {
        ...prev,
        ...o,
        ...(prev.styles || o.styles ? { styles: mergeStyles(prev.styles ?? {}, o.styles ?? {}) } : {}),
      };
    };
    for (const [k, o] of Object.entries(r.base.overrides ?? {})) merge(k, o);
    for (let j = r.levels.length - 1; j >= 0; j--) {
      const prefix = r.segs.slice(j + 1).join(VSEP) + VSEP;
      for (const [k, o] of Object.entries(r.levels[j]!.inst.overrides ?? {})) {
        if (k.startsWith(prefix)) merge(k.slice(prefix.length), o);
      }
    }
    return out;
  }

  /** Hijos efectivos: reales, o virtuales si `id` es (o está dentro de) una instancia. */
  childIds(id: string): string[] {
    if (!isVirtualId(id)) {
      const n = this.env.raw(id);
      if (n?.instanceOf) {
        if (!this.env.raw(n.instanceOf)) return [];
        return this.env.children(n.instanceOf).map((c) => `${id}${VSEP}${c}`);
      }
      return this.env.children(id);
    }
    const r = this.resolve(id);
    if (!r) return [];
    if (r.base.instanceOf) {
      if (r.levels.some((l) => l.mainId === r.base.instanceOf) || r.levels.length >= MAX_DEPTH) return [];
      if (!this.env.raw(r.base.instanceOf)) return [];
      return this.env.children(r.base.instanceOf).map((c) => `${id}${VSEP}${c}`);
    }
    const prefix = r.segs.slice(0, -1).join(VSEP);
    return this.env.children(r.base.id).map((c) => `${prefix}${VSEP}${c}`);
  }

  /** Padre efectivo de un id virtual. */
  parentId(id: string): string | null {
    const r = this.resolve(id);
    if (!r) return null;
    const prefix = r.segs.slice(0, -1).join(VSEP);
    const level = r.levels[r.levels.length - 1]!;
    const realParent = this.env.parent(r.base.id);
    if (!realParent || realParent === level.mainId) return prefix;
    return `${prefix}${VSEP}${realParent}`;
  }

  /** Clave de override de un id virtual respecto a su instancia externa. */
  overrideKey(id: string): { instanceId: string; key: string } | null {
    const segs = splitVirtualId(id);
    if (segs.length < 2) return null;
    return { instanceId: segs[0]!, key: segs.slice(1).join(VSEP) };
  }

  /** ¿El main `mainId` contiene (transitivamente) instancias de `otherMain` (o es él)? */
  dependsOn(mainId: string, otherMain: string, seen = new Set<string>()): boolean {
    if (mainId === otherMain) return true;
    if (seen.has(mainId)) return false;
    seen.add(mainId);
    const stack = [mainId];
    while (stack.length) {
      const cur = stack.pop()!;
      const n = this.env.raw(cur);
      if (n?.instanceOf && cur !== mainId) {
        if (this.dependsOn(n.instanceOf, otherMain, seen)) return true;
        continue;
      }
      stack.push(...this.env.children(cur));
    }
    return false;
  }

  /**
   * ¿Se puede colocar una instancia de `mainId` bajo `parentId` (real)? No si el padre está
   * dentro de un main que el propio `mainId` usa (ciclo), ni dentro del propio main.
   */
  canPlaceInstance(mainId: string, parentId: string): boolean {
    let cur: string | null = parentId;
    for (let i = 0; cur && i < 10_000; i++) {
      const n = this.env.raw(cur);
      if (n?.isComponent && this.dependsOn(mainId, cur)) return false;
      cur = this.env.parent(cur);
    }
    return true;
  }
}

/** Fusiona un parche en un override. `styles` sigue la semántica de mergeStyles (null borra). */
export function mergeOverride(
  prev: NodeOverride | undefined,
  patch: { styles?: Record<string, StyleValue | null | undefined>; textValue?: string; isVisible?: boolean },
): NodeOverride {
  const next: NodeOverride = { ...(prev ?? {}) };
  if (patch.styles) next.styles = mergeStyles(prev?.styles ?? {}, cleanPatch(patch.styles));
  if (patch.textValue !== undefined) next.textValue = patch.textValue;
  if (patch.isVisible !== undefined) next.isVisible = patch.isVisible;
  return next;
}

/**
 * En un override, borrar una propiedad del main se guarda como valor vacío explícito
 * ("" no es válido en mergeStyles, así que usamos 'unset' / 'initial' según convenga).
 */
function cleanPatch(styles: Record<string, StyleValue | null | undefined>): Styles {
  const out: Styles = {};
  for (const [k, v] of Object.entries(styles)) out[k] = v === null || v === undefined || v === '' ? 'unset' : v;
  return out;
}
