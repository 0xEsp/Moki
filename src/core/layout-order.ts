// Orden de lectura de rectángulos en el canvas (para PDFs combinados y exportaciones por página):
// filas (dos elementos comparten fila si su solape vertical es ≥ 15 % de la menor altura) y,
// dentro de cada fila, de izquierda a derecha.

export interface OrderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function readingOrder<T extends { r: OrderRect }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => a.r.y - b.r.y);
  const rows: T[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row) {
      const first = row[0]!;
      const overlap = Math.min(first.r.y + first.r.height, it.r.y + it.r.height) - Math.max(first.r.y, it.r.y);
      if (overlap >= 0.15 * Math.min(first.r.height, it.r.height)) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.r.x - b.r.x));
}
