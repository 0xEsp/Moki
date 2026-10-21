// Geometría común: rectángulos en coordenadas de mundo (px del canvas a zoom 1).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rectángulo de `el` en coordenadas de mundo. `originEl` es el elemento raíz de la página
 * (su esquina superior izquierda es el (0,0) del mundo) y `scale` el zoom de la cámara.
 */
export function worldRectOf(el: Element, originEl: Element, scale: number): Rect {
  const r = el.getBoundingClientRect();
  const o = originEl.getBoundingClientRect();
  return { x: (r.left - o.left) / scale, y: (r.top - o.top) / scale, width: r.width / scale, height: r.height / scale };
}

export const rectRight = (r: Rect) => r.x + r.width;
export const rectBottom = (r: Rect) => r.y + r.height;

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function rectContainsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Espera a que carguen las fuentes usadas y las imágenes de un subárbol (con timeout). */
export async function waitForAssets(root: Element, timeoutMs = 5000): Promise<{ failedImages: number }> {
  const deadline = Date.now() + timeoutMs;
  const families = new Set<string>();
  const urls = new Set<string>();
  const els = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (el.textContent && el.childElementCount === 0) {
      families.add(`${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`);
    }
    const bg = cs.backgroundImage;
    if (bg && bg !== 'none') for (const m of bg.matchAll(/url\("?([^")]+)"?\)/g)) urls.add(m[1]!);
    if (el instanceof HTMLImageElement && el.src) urls.add(el.src);
  }
  const timeout = new Promise<void>((r) => setTimeout(r, Math.max(0, deadline - Date.now())));
  const fontLoads = [...families].map((f) => document.fonts.load(f).catch(() => undefined));
  let failed = 0;
  const imgLoads = [...urls].map(
    (u) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => {
          failed++;
          resolve();
        };
        img.src = u;
      }),
  );
  await Promise.race([Promise.all([...fontLoads, ...imgLoads, document.fonts.ready]), timeout]);
  // Dos frames (con respaldo por timer si la página está en segundo plano).
  for (let i = 0; i < 2; i++) await new Promise<void>((r) => { const t = setTimeout(r, 16); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
  return { failedImages: failed };
}
