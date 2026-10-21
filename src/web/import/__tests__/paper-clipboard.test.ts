import { describe, expect, it } from 'vitest';
import { DocStore } from '../../state/doc-store';
import { createEmptyFile } from '../../../core/new-file';
import { colorToCss, convertPaperClipboard, parsePaperClipboard } from '../paper-clipboard';

// Fixture mínimo con la forma del portapapeles de Paper (escrito a mano, sin datos reales).
const payload = {
  id: 'x', fileId: 'F1', topLevelNodeIds: ['a'],
  nodes: {
    a: { id: 'a', label: 'Card', component: 'Frame', styles: { display: 'flex', borderRadius: 't:1-0' }, styleMeta: {
      fill: [{ type: 'solid', color: { type: 'alpha', base: 't:2-0', alpha: 0.4 }, isVisible: true }],
      borders: { all: { isVisible: true, width: '1px', color: '#ff0000', style: 'solid' } },
      outerShadow: [{ color: '#00000040', x: '0', y: '4', blur: '12', spread: '0', isVisible: true }] } },
    b: { id: 'b', label: 'Title', component: 'Text', textValue: 'Hola', styles: { fontSize: '17px' }, styleMeta: {
      fill: [{ type: 'solid', color: { value: { mode: 'oklch', l: 1, c: 0, h: 0 }, mode: 'hex' }, isVisible: true }],
      font: { family: 'Source Sans 3', weight: 600, isItalic: true } } },
    c: { id: 'c', label: 'Logo', component: 'Frame', styles: {}, styleMeta: { fill: [{ type: 'image', imageId: 'IMG', sizeX: 'contain', isVisible: true }] } },
  },
  images: { IMG: { id: 'IMG', extension: 'png' } },
  parentToChildrenIndex: { a: ['b', 'c'] },
  positions: { a: [100, 50] },
  tokens: {
    't:1-0': { id: 't:1-0', name: 'radius-m', type: 'radius', value: '14px' },
    't:2-0': { id: 't:2-0', name: 'color-muted', type: 'color', value: { value: { mode: 'oklch', l: 0.2, c: 0.01, h: 280 }, mode: 'hex' } },
  },
};
const html = `<meta charset="utf-8"><!--<paper-paste-start data-embed="${JSON.stringify(payload).replace(/</g, '\\u003c')}"></paper-paste-start>--><span>x</span>`;

describe('paper clipboard', () => {
  it('extrae el JSON', () => {
    expect(parsePaperClipboard(html)?.topLevelNodeIds).toEqual(['a']);
    expect(parsePaperClipboard('<p>hola</p>')).toBeNull();
  });
  it('convierte colores', () => {
    expect(colorToCss({ value: { mode: 'oklch', l: 1, c: 0, h: 0 }, mode: 'hex' }, new Map())).toBe('#FFFFFF');
    expect(colorToCss({ type: 'alpha', base: 't:9-0', alpha: 0.5 }, new Map([['t:9-0', 't:1-0']]))).toBe('color-mix(var(t:1-0) 50%, transparent)');
  });
  it('convierte nodos, tokens e imágenes', async () => {
    const doc = new DocStore(createEmptyFile('t'), 0);
    const res = await convertPaperClipboard(parsePaperClipboard(html)!, { doc, importImage: async (src) => ({ url: `/file-assets/local/${src.split('/').pop()}` }) });
    expect(res.createdTokens).toBe(2);
    const [card] = res.clips;
    const s = card!.node.styles;
    expect(String(s.borderRadius)).toMatch(/^var\(t:/);
    expect(String(s.backgroundColor)).toMatch(/^color-mix\(var\(t:[^)]+\) 40%, transparent\)$/);
    expect(s.border).toBe('1px solid #ff0000');
    expect(s.boxShadow).toBe('0px 4px 12px 0px #00000040');
    const [title, logo] = card!.children;
    expect(title!.node.styles).toMatchObject({ color: '#FFFFFF', fontWeight: 600, fontStyle: 'italic', fontFamily: '"Source Sans 3", system-ui, sans-serif' });
    expect(logo!.node.styles).toMatchObject({ backgroundImage: 'url(/file-assets/local/IMG.png)', backgroundSize: 'contain' });
    expect(res.positions[0]).toEqual({ x: 100, y: 50 });
  });
});

describe('reconstrucción del frame padre', () => {
  it('agrupa capas copiadas de dentro de una pantalla en un frame flex column', async () => {
    const p = {
      id: 'x', fileId: 'F', topLevelNodeIds: ['sb', 'sheet', 'ov'],
      nodes: {
        sb: { id: 'sb', label: 'Status bar', component: 'Frame', styles: { display: 'flex' }, pinnedWidth: 393, pinnedHeight: 62 },
        sheet: { id: 'sheet', label: 'Sheet', component: 'Frame', styles: { width: '393px', height: '793px' }, styleMeta: { fill: [{ type: 'solid', color: '#131319', isVisible: true }] } },
        ov: { id: 'ov', label: 'Overlay', component: 'Frame', styles: { position: 'absolute', left: '0px', top: '62px', width: '393px', height: '790px' } },
      },
      images: {}, parentToChildrenIndex: {},
      positions: { sb: [500, 0, 0, 0], sheet: [500, 62, 0, 62], ov: [500, 62, 0, 62] },
    };
    const html = `<!--<paper-paste-start data-embed="${JSON.stringify(p)}"></paper-paste-start>-->`;
    const doc = new DocStore(createEmptyFile('t'), 0);
    const res = await convertPaperClipboard(parsePaperClipboard(html)!, { doc, importImage: async (src) => ({ url: src }) });
    expect(res.clips).toHaveLength(1);
    const frame = res.clips[0]!;
    expect(frame.node.styles).toMatchObject({ display: 'flex', flexDirection: 'column', width: '393px', height: '852px', backgroundColor: '#131319' });
    expect(frame.children.map((c) => c.node.label)).toEqual(['Status bar', 'Sheet', 'Overlay']);
    expect(frame.children[2]!.node.styles.position).toBe('absolute');
    expect(res.positions[0]).toEqual({ x: 500, y: 0 });
  });
});
