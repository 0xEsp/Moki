import { FREEFORM_DISPLAY, ROOT_PREFIX, type MokiFile, type TreeNode } from './types';
import { compareKeys } from './fractional';

// Utilidades puras sobre el árbol plano. Sirven al servidor, al runtime y a la UI
// (que las envuelve en `computed` de MobX).

export function parseRel(rel: string | undefined): { parentId: string; sortKey: string } | null {
  if (!rel) return null;
  const i = rel.indexOf(':');
  if (i < 0) return null;
  return { parentId: rel.slice(0, i), sortKey: rel.slice(i + 1) };
}

export const makeRel = (parentId: string, sortKey: string) => `${parentId}:${sortKey}`;

export const isRootId = (id: string) => id.startsWith(ROOT_PREFIX);

export function isLive(file: MokiFile, id: string): boolean {
  const n = file.nodes[id];
  return !!n && !n['~'];
}

/** Índice padre → hijos ordenados (por sortKey y, a igualdad, por id). */
export function buildChildrenIndex(file: MokiFile): Map<string, string[]> {
  const tmp = new Map<string, { id: string; key: string }[]>();
  for (const [childId, rel] of Object.entries(file.nodeRelationships)) {
    const r = parseRel(rel);
    if (!r) continue;
    const n = file.nodes[childId];
    if (!n || n['~']) continue;
    let list = tmp.get(r.parentId);
    if (!list) tmp.set(r.parentId, (list = []));
    list.push({ id: childId, key: r.sortKey });
  }
  const out = new Map<string, string[]>();
  for (const [p, list] of tmp) {
    list.sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.id, b.id));
    out.set(p, list.map((x) => x.id));
  }
  return out;
}

export class TreeIndex {
  readonly children: Map<string, string[]>;
  constructor(readonly file: MokiFile) {
    this.children = buildChildrenIndex(file);
  }
  node(id: string): TreeNode | undefined {
    const n = this.file.nodes[id];
    return n && !n['~'] ? n : undefined;
  }
  childIds(id: string): string[] {
    return this.children.get(id) ?? [];
  }
  parentId(id: string): string | null {
    return parseRel(this.file.nodeRelationships[id])?.parentId ?? null;
  }
  sortKey(id: string): string | null {
    return parseRel(this.file.nodeRelationships[id])?.sortKey ?? null;
  }
  ancestors(id: string): string[] {
    const out: string[] = [];
    let p = this.parentId(id);
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
      p = this.parentId(p);
    }
    return out;
  }
  /** Descendientes en orden de recorrido (pre-orden), sin incluir `id`. */
  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (pid: string) => {
      for (const c of this.childIds(pid)) {
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  }
  /** Raíz de página que contiene al nodo (o el propio nodo si es raíz). */
  rootOf(id: string): string | null {
    if (isRootId(id)) return id;
    const anc = this.ancestors(id);
    const last = anc[anc.length - 1];
    return last && isRootId(last) ? last : null;
  }
  pageIdOf(id: string): string | null {
    const r = this.rootOf(id);
    return r ? r.slice(ROOT_PREFIX.length) : null;
  }
  isArtboard(id: string): boolean {
    const p = this.parentId(id);
    const n = this.node(id);
    return !!p && isRootId(p) && !!n && canHaveChildren(n);
  }
  /** Artboard que contiene al nodo (o él mismo si lo es). */
  artboardOf(id: string): string | null {
    if (this.isArtboard(id)) return id;
    for (const a of this.ancestors(id)) if (this.isArtboard(a)) return a;
    return null;
  }
  /** ¿`maybeAncestor` es ancestro (o igual) de `id`? */
  isWithin(id: string, maybeAncestor: string): boolean {
    return id === maybeAncestor || this.ancestors(id).includes(maybeAncestor);
  }
  indexInParent(id: string): number {
    const p = this.parentId(id);
    return p ? this.childIds(p).indexOf(id) : -1;
  }
  /** Visible efectivo (el nodo y todos sus ancestros). */
  isEffectivelyVisible(id: string): boolean {
    for (const x of [id, ...this.ancestors(id)]) {
      const n = this.file.nodes[x];
      if (n && n.isVisible === false) return false;
    }
    return true;
  }
  isEffectivelyLocked(id: string): boolean {
    for (const x of [id, ...this.ancestors(id)]) {
      const n = this.file.nodes[x];
      if (n?.isLocked) return true;
    }
    return false;
  }
}

export function canHaveChildren(n: TreeNode): boolean {
  return n.component === 'Frame' || n.component === 'SVG' || (n.component === 'SVGVisualElement' && n.tag === 'g');
}

export function canHaveHTMLChildren(n: TreeNode): boolean {
  return n.component === 'Frame';
}

export function isFreeform(n: TreeNode): boolean {
  return n.styles.display === FREEFORM_DISPLAY || n.styles.display === undefined && n.id.startsWith(ROOT_PREFIX);
}

export function isFlexOrGrid(n: TreeNode | undefined): boolean {
  if (!n) return false;
  const d = String(n.styles.display ?? '');
  return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
}

export function isAbsolute(n: TreeNode): boolean {
  const p = n.styles.position;
  return p === 'absolute' || p === 'fixed';
}

export function livePages(file: MokiFile) {
  return file.pages.filter((p) => !p['~']);
}

export function canvasPages(file: MokiFile) {
  return file.pages.filter((p) => !p['~'] && !p.isDivider);
}

/**
 * Elimina de verdad los nodos borrados (soft delete) y sus relaciones. Solo es seguro cuando nadie
 * tiene historial de deshacer sobre el fichero: el servidor lo hace al cargarlo de disco, y todo
 * cliente que se conecta recibe el fichero entero y empieza con el historial vacío. Los mains
 * borrados se conservan porque sus instancias siguen pintándose a partir de ellos.
 */
export function purgeDeletedNodes(file: MokiFile): number {
  let purged = 0;
  for (const [id, node] of Object.entries(file.nodes)) {
    if (!node['~'] || node.isComponent) continue;
    delete file.nodes[id];
    delete file.nodeRelationships[id];
    purged++;
  }
  for (const id of Object.keys(file.nodeRelationships)) if (!file.nodes[id]) delete file.nodeRelationships[id];
  return purged;
}
