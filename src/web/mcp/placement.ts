import type { Rect } from '../canvas/geometry';

// Colocación automática de artboards en el "mejor hueco" libre del canvas.

export interface PlacementInput {
  obstacles: Rect[];
  width: number;
  height: number;
  padding?: number;
  /** Área visible de la cámara del usuario (si la página es la que está viendo). */
  visibleArea?: Rect | null;
  /** Rectángulo de referencia (p. ej. el original al duplicar): se prefiere a su derecha / debajo. */
  anchor?: Rect | null;
}

export const ARTBOARD_GAP = 80;

function overlapsAny(r: Rect, obstacles: Rect[], pad: number): boolean {
  const x0 = r.x - pad, y0 = r.y - pad, x1 = r.x + r.width + pad, y1 = r.y + r.height + pad;
  for (const o of obstacles) {
    if (x0 < o.x + o.width && o.x < x1 && y0 < o.y + o.height && o.y < y1) return true;
  }
  return false;
}

function overlap1d(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** ¿El rectángulo queda "bien visible"? (≥ 2/3 de su área y min(300, lado) por eje). */
function wellVisible(r: Rect, area: Rect): boolean {
  const ox = overlap1d(r.x, r.x + r.width, area.x, area.x + area.width);
  const oy = overlap1d(r.y, r.y + r.height, area.y, area.y + area.height);
  if (ox * oy < (2 / 3) * r.width * r.height) return false;
  return ox >= Math.min(300, r.width) && oy >= Math.min(300, r.height);
}

function startsInside(r: Rect, area: Rect): boolean {
  return r.x >= area.x && r.x <= area.x + area.width && r.y >= area.y && r.y <= area.y + area.height;
}

export function findPlacement(input: PlacementInput): { x: number; y: number } {
  const pad = input.padding ?? ARTBOARD_GAP;
  const { width: w, height: h, obstacles, visibleArea, anchor } = input;
  const at = (x: number, y: number): Rect => ({ x, y, width: w, height: h });
  const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });

  const tryCandidates = (accept: (r: Rect) => boolean): Rect | null => {
    // 1. Ancla: a la derecha y debajo.
    if (anchor) {
      const rightX = anchor.x + anchor.width + pad;
      const ys = [anchor.y, ...obstacles.filter((o) => o.y + o.height >= anchor.y && o.y <= anchor.y + anchor.height).map((o) => o.y + o.height + pad)];
      for (const y of ys) {
        const r = at(rightX, y);
        if (accept(r)) return r;
      }
      const belowY = anchor.y + anchor.height + pad;
      const xs = [anchor.x, ...obstacles.filter((o) => o.x + o.width >= anchor.x && o.x <= anchor.x + anchor.width).map((o) => o.x + o.width + pad)];
      for (const x of xs) {
        const r = at(x, belowY);
        if (accept(r)) return r;
      }
    }
    const sorted = [...obstacles].sort((a, b) => a.y - b.y || a.x - b.x);
    // 2. A la derecha de cada obstáculo (alineado arriba).
    for (const o of sorted) {
      const r = at(o.x + o.width + pad, o.y);
      if (accept(r)) return r;
    }
    // 3. Debajo de cada obstáculo (alineado a la izquierda).
    for (const o of sorted) {
      const r = at(o.x, o.y + o.height + pad);
      if (accept(r)) return r;
    }
    return null;
  };

  const free = (r: Rect) => !overlapsAny(r, obstacles, pad);

  if (!visibleArea) {
    if (obstacles.length === 0) return { x: 0, y: 0 };
    const r = tryCandidates(free);
    if (r) return round(r);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of obstacles) {
      minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + o.width); maxY = Math.max(maxY, o.y + o.height);
    }
    const right = at(maxX + pad, minY);
    if (free(right)) return round(right);
    return round(at(minX, maxY + pad));
  }

  const area = visibleArea;
  const centered = at(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2);
  const inArea = obstacles.filter((o) => o.x < area.x + area.width && area.x < o.x + o.width && o.y < area.y + area.height && area.y < o.y + o.height);
  if (inArea.length === 0 && free(centered)) return round(centered);

  const strict = (r: Rect) => free(r) && wellVisible(r, area);
  const r1 = tryCandidates(strict);
  if (r1) return round(r1);

  // Rejilla de candidatos dentro del área.
  const xs = new Set<number>([area.x + pad]);
  const ys = new Set<number>([area.y + pad]);
  for (const o of obstacles) {
    xs.add(o.x + o.width + pad);
    xs.add(o.x);
    ys.add(o.y + o.height + pad);
    ys.add(o.y);
  }
  const gridXs = [...xs].filter((x) => x >= area.x && x <= area.x + area.width).sort((a, b) => a - b);
  const gridYs = [...ys].filter((y) => y >= area.y && y <= area.y + area.height).sort((a, b) => a - b);
  for (const y of gridYs) {
    for (const x of gridXs) {
      const r = at(x, y);
      if (strict(r)) return round(r);
    }
  }

  const relaxed = (r: Rect) => free(r) && startsInside(r, area);
  const r2 = tryCandidates(relaxed);
  if (r2) return round(r2);
  // Último recurso: fuera de todo, a la derecha del conjunto (sin solapar).
  const r3 = tryCandidates(free);
  if (r3) return round(r3);
  return round(centered);
}
