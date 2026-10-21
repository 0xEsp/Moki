import type { Rect } from './geometry';

// Distancias entre dos rectángulos (mundo), como al mantener Option en Figma/Paper:
//  - uno contiene al otro → 4 cotas del interior a los bordes del exterior;
//  - separados → hueco horizontal y/o vertical entre los bordes más cercanos (con guías
//    discontinuas cuando la cota queda fuera del alto/ancho del destino);
//  - solapados sin contenerse → diferencia entre bordes correspondientes.

export interface DistanceLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Distancia en px de mundo. */
  value: number;
}

export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Distances {
  lines: DistanceLine[];
  guides: GuideLine[];
}

const EPS = 0.01;
const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const cx = (r: Rect) => r.x + r.width / 2;
const cy = (r: Rect) => r.y + r.height / 2;

export function contains(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x + EPS && outer.y <= inner.y + EPS && right(inner) <= right(outer) + EPS && bottom(inner) <= bottom(outer) + EPS;
}

/** Valor para la etiqueta: entero, o 1 decimal si no lo es ("12", "12.5"). */
export function formatDistance(v: number): string {
  const r = Math.round(Math.abs(v) * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Cotas de `inner` a los bordes interiores de `outer` (omite las nulas). */
function insetLines(outer: Rect, inner: Rect): DistanceLine[] {
  const out: DistanceLine[] = [];
  const mx = cx(inner);
  const my = cy(inner);
  const push = (l: DistanceLine) => {
    if (l.value > EPS) out.push(l);
  };
  push({ x1: mx, y1: outer.y, x2: mx, y2: inner.y, value: inner.y - outer.y });
  push({ x1: right(inner), y1: my, x2: right(outer), y2: my, value: right(outer) - right(inner) });
  push({ x1: mx, y1: bottom(inner), x2: mx, y2: bottom(outer), value: bottom(outer) - bottom(inner) });
  push({ x1: outer.x, y1: my, x2: inner.x, y2: my, value: inner.x - outer.x });
  return out;
}

export function computeDistances(s: Rect, t: Rect): Distances {
  if (contains(t, s)) return { lines: insetLines(t, s), guides: [] };
  if (contains(s, t)) return { lines: insetLines(s, t), guides: [] };

  const lines: DistanceLine[] = [];
  const guides: GuideLine[] = [];
  const overlapX = Math.min(right(s), right(t)) - Math.max(s.x, t.x);
  const overlapY = Math.min(bottom(s), bottom(t)) - Math.max(s.y, t.y);

  // Hueco horizontal.
  if (overlapX <= EPS) {
    const tRight = right(s) <= t.x + EPS; // T a la derecha de S
    const [x1, x2] = tRight ? [right(s), t.x] : [right(t), s.x];
    let y: number;
    if (overlapY > EPS) y = (Math.max(s.y, t.y) + Math.min(bottom(s), bottom(t))) / 2;
    else {
      y = cy(s);
      // Guía vertical desde el extremo que toca T hasta su borde más cercano.
      const gx = tRight ? x2 : x1;
      guides.push({ x1: gx, y1: y, x2: gx, y2: y < t.y ? t.y : bottom(t) });
    }
    if (x2 - x1 > EPS) lines.push({ x1, y1: y, x2, y2: y, value: x2 - x1 });
  }

  // Hueco vertical.
  if (overlapY <= EPS) {
    const tBelow = bottom(s) <= t.y + EPS; // T debajo de S
    const [y1, y2] = tBelow ? [bottom(s), t.y] : [bottom(t), s.y];
    let x: number;
    if (overlapX > EPS) x = (Math.max(s.x, t.x) + Math.min(right(s), right(t))) / 2;
    else {
      x = cx(s);
      const gy = tBelow ? y2 : y1;
      guides.push({ x1: x, y1: gy, x2: x < t.x ? t.x : right(t), y2: gy });
    }
    if (y2 - y1 > EPS) lines.push({ x1: x, y1, x2: x, y2, value: y2 - y1 });
  }

  // Solapados sin contenerse: diferencias entre bordes homólogos (a la altura del centro de S).
  if (overlapX > EPS && overlapY > EPS) {
    const my = cy(s);
    const mx = cx(s);
    const add = (l: DistanceLine) => {
      if (Math.abs(l.value) > EPS) lines.push({ ...l, value: Math.abs(l.value) });
    };
    add({ x1: Math.min(s.x, t.x), y1: my, x2: Math.max(s.x, t.x), y2: my, value: s.x - t.x });
    add({ x1: Math.min(right(s), right(t)), y1: my, x2: Math.max(right(s), right(t)), y2: my, value: right(s) - right(t) });
    add({ x1: mx, y1: Math.min(s.y, t.y), x2: mx, y2: Math.max(s.y, t.y), value: s.y - t.y });
    add({ x1: mx, y1: Math.min(bottom(s), bottom(t)), x2: mx, y2: Math.max(bottom(s), bottom(t)), value: bottom(s) - bottom(t) });
  }

  return { lines, guides };
}
