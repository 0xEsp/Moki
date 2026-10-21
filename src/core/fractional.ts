// Indexación fraccional sobre el alfabeto ASCII 33 ('!') … 126 ('~').
// Una clave entre A y B es una cadena que ordena lexicográficamente entre ambas.
// Invariante: ninguna clave generada termina en '!' (así siempre cabe otra delante).

const MIN = 33;
const MAX = 126;
const MID = 79; // 'O'
const BELOW = MIN - 1; // relleno de `a` cuando se agota
const ABOVE = MAX + 1; // relleno de `b` cuando no restringe

/**
 * Devuelve una clave estrictamente entre `a` y `b`. `a = null` significa "antes de todo";
 * `b = null` significa "después de todo". Si `a >= b` se recupera generando una clave tras `a`.
 */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  let hi: string | null = b;
  if (hi !== null && lo >= hi) hi = null; // recuperación ante claves desordenadas
  let prefix = '';
  for (let i = 0; i < 4096; i++) {
    const ca = i < lo.length ? lo.charCodeAt(i) : BELOW;
    const cb = hi === null ? ABOVE : i < hi.length ? hi.charCodeAt(i) : ABOVE;
    if (ca === cb) {
      prefix += String.fromCharCode(ca);
      continue;
    }
    if (cb - ca > 1) {
      const mid = Math.floor((ca + cb) / 2);
      if (mid === MIN) return prefix + String.fromCharCode(MIN, MID);
      return prefix + String.fromCharCode(mid);
    }
    // cb === ca + 1: no cabe nada en esta posición.
    if (ca === BELOW) {
      // `a` agotado y b[i] === '!': copiamos '!' y seguimos acotados por b.
      prefix += String.fromCharCode(cb);
      continue;
    }
    // Copiamos el carácter de `a`; desde aquí ya somos < b, solo hay que superar a `a`.
    prefix += String.fromCharCode(ca);
    hi = null;
  }
  throw new Error('keyBetween: no se pudo generar clave');
}

/** N claves en orden entre `a` y `b`. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const mid = keyBetween(a, b);
  const nLeft = Math.floor((n - 1) / 2);
  const left = keysBetween(a, mid, nLeft);
  const right = keysBetween(mid, b, n - 1 - nLeft);
  return [...left, mid, ...right];
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
