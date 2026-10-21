import { describe, expect, it } from 'vitest';
import { keyBetween, keysBetween } from '../fractional';

describe('fractional', () => {
  it('genera claves ordenadas', () => {
    let keys: string[] = [keyBetween(null, null)];
    for (let i = 0; i < 200; i++) keys.push(keyBetween(keys[keys.length - 1]!, null));
    for (let i = 0; i < 200; i++) keys.unshift(keyBetween(null, keys[0]!));
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
    for (const k of keys) expect(k.endsWith('!')).toBe(false);
  });
  it('inserta entre vecinos repetidamente', () => {
    let a = keyBetween(null, null);
    const b = keyBetween(a, null);
    for (let i = 0; i < 300; i++) {
      const m = keyBetween(a, b);
      expect(a < m && m < b).toBe(true);
      a = m;
    }
  });
  it('keysBetween', () => {
    const ks = keysBetween('A', 'B', 10);
    expect(ks.length).toBe(10);
    for (let i = 1; i < ks.length; i++) expect(ks[i - 1]! < ks[i]!).toBe(true);
    expect('A' < ks[0]! && ks[9]! < 'B').toBe(true);
  });
});

import { quoteFontFamilyList } from '../tokens';
describe('quoteFontFamilyList', () => {
  it('entrecomilla familias que lo necesitan', () => {
    expect(quoteFontFamilyList('Source Sans 3')).toBe('"Source Sans 3"');
    expect(quoteFontFamilyList('"Inter", system-ui, sans-serif')).toBe('"Inter", system-ui, sans-serif');
    expect(quoteFontFamilyList('Montserrat, serif')).toBe('"Montserrat", serif');
  });
});
