import { describe, expect, it } from 'vitest';
import { computeDistances, formatDistance } from '../measure-distances';

const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const values = (d: ReturnType<typeof computeDistances>) => d.lines.map((l) => Math.round(l.value * 10) / 10).sort((a, b) => a - b);

describe('computeDistances', () => {
  it('padre que contiene: 4 cotas a los bordes interiores', () => {
    const d = computeDistances(r(20, 30, 100, 50), r(0, 0, 200, 100));
    expect(values(d)).toEqual([20, 20, 30, 80]); // izq 20, arriba 30, abajo 20, derecha 80
    expect(d.guides).toHaveLength(0);
  });
  it('hijo dentro de la selección: cotas del hijo al interior de la selección', () => {
    const d = computeDistances(r(0, 0, 200, 100), r(10, 10, 50, 50));
    expect(values(d)).toEqual([10, 10, 40, 140]);
  });
  it('separados en horizontal con solape vertical: solo el hueco', () => {
    const d = computeDistances(r(0, 0, 100, 100), r(180, 20, 50, 50));
    expect(values(d)).toEqual([80]);
    const l = d.lines[0]!;
    expect([l.x1, l.x2, l.y1]).toEqual([100, 180, 45]);
    expect(d.guides).toHaveLength(0);
  });
  it('a la izquierda', () => {
    expect(values(computeDistances(r(300, 0, 100, 100), r(0, 0, 250, 100)))).toEqual([50]);
  });
  it('separados en vertical', () => {
    const d = computeDistances(r(0, 0, 100, 100), r(10, 130, 50, 50));
    expect(values(d)).toEqual([30]);
  });
  it('en diagonal: huecos horizontal y vertical con guías', () => {
    const d = computeDistances(r(0, 0, 100, 100), r(150, 200, 50, 50));
    expect(values(d)).toEqual([50, 100]);
    expect(d.guides).toHaveLength(2);
  });
  it('solapados: diferencia entre bordes homólogos', () => {
    const d = computeDistances(r(0, 0, 100, 100), r(50, 20, 100, 100));
    expect(values(d)).toEqual([20, 20, 50, 50]);
  });
  it('mismo rectángulo: nada que medir', () => {
    expect(computeDistances(r(0, 0, 10, 10), r(0, 0, 10, 10)).lines).toHaveLength(0);
  });
  it('formato', () => {
    expect(formatDistance(12)).toBe('12');
    expect(formatDistance(12.04)).toBe('12');
    expect(formatDistance(12.46)).toBe('12.5');
  });
});
