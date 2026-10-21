import { readingOrder } from '../core/layout-order';
import { canvasPages, TreeIndex } from '../core/tree';
import type { MokiFile, TreeNode } from '../core/types';

// Partes puras de la exportación masiva: qué se exporta de cada página/fichero y cómo se llaman
// las entradas del zip. Sin dependencias de navegador ni de disco (se testean aparte).

/** Nombre seguro para un fichero/carpeta dentro de un zip (y en cualquier SO). */
export function sanitizeName(name: string, fallback = 'Sin nombre'): string {
  const clean = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120);
  return clean || fallback;
}

/** Evita colisiones de rutas dentro de un zip: "A.png", "A (2).png"… (sin distinguir mayúsculas). */
export class ZipNamer {
  private used = new Set<string>();
  take(path: string): string {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
    const base = path.slice(slash + 1);
    // Extensiones compuestas (.moki.zip) cuentan como una sola.
    const m = /^(.*?)((?:\.moki)?\.[a-z0-9]+)?$/i.exec(base)!;
    const stem = m[1] || base;
    const ext = m[2] ?? '';
    let candidate = path;
    for (let i = 2; this.used.has(candidate.toLowerCase()); i++) candidate = `${dir}${stem} (${i})${ext}`;
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

/** Sufijo de escala de los nombres de export: "" para 1x, "@2x"… */
export const scaleSuffix = (scale: number) => (scale === 1 ? '' : `@${scale}x`);

export interface PlannedArtboard {
  id: string;
  label: string;
  isSvg: boolean;
  /** Rectángulo aproximado desde estilos (para el orden de lectura). */
  r: { x: number; y: number; width: number; height: number };
}

export interface PlannedPage {
  id: string;
  label: string;
  artboards: PlannedArtboard[];
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const m = /^(-?\d*\.?\d+)(px)?$/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) : 0;
};

function rectOf(n: TreeNode) {
  return { x: num(n.styles.left), y: num(n.styles.top), width: num(n.styles.width), height: num(n.styles.height) };
}

/**
 * Artboards visibles de cada página de lienzo (los separadores no tienen). Son los hijos directos
 * de la raíz de la página que son Frame o SVG; se devuelven en orden de lectura.
 */
export function planFile(file: MokiFile, onlyPageId?: string): PlannedPage[] {
  const idx = new TreeIndex(file);
  const out: PlannedPage[] = [];
  for (const p of canvasPages(file)) {
    if (onlyPageId && p.id !== onlyPageId) continue;
    const rootId = `root_node_${p.id}`;
    const items: PlannedArtboard[] = [];
    for (const id of idx.childIds(rootId)) {
      const n = idx.node(id);
      if (!n || n.isVisible === false) continue;
      if (n.component !== 'Frame' && n.component !== 'SVG') continue;
      items.push({ id, label: n.label || id, isSvg: n.component === 'SVG', r: rectOf(n) });
    }
    out.push({ id: p.id, label: p.label || p.id, artboards: readingOrder(items) });
  }
  return out;
}

/** Nodos concretos de un fichero (scope `nodes`), en orden de lectura cuando son artboards. */
export function planNodes(file: MokiFile, nodeIds: string[]): PlannedArtboard[] {
  const idx = new TreeIndex(file);
  const items: PlannedArtboard[] = [];
  for (const id of nodeIds) {
    const n = idx.node(id);
    if (!n) continue;
    items.push({ id, label: n.label || id, isSvg: n.component === 'SVG', r: rectOf(n) });
  }
  return items;
}

/** Carpetas descendientes (incluida la propia), con su ruta relativa a `rootId`. */
export function folderTree(
  folders: { id: string; name: string; parentId?: string | null }[],
  rootId: string,
): { id: string; path: string[] }[] {
  const root = folders.find((f) => f.id === rootId);
  if (!root) return [];
  const out: { id: string; path: string[] }[] = [];
  const walk = (id: string, pathParts: string[], seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, path: pathParts });
    for (const f of folders) if (f.parentId === id) walk(f.id, [...pathParts, sanitizeName(f.name)], seen);
  };
  walk(root.id, [sanitizeName(root.name)], new Set());
  return out;
}
