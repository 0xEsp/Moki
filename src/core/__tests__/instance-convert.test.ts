import { describe, expect, it } from 'vitest';
import { createEmptyFile } from '../new-file';
import { DocStore } from '../../web/state/doc-store';
import { _test } from '../instance-convert';

const ROOT = 'root_node_p-1-0';

/** Árbol efectivo comparable (sin ids ni etiquetas): lo que se pinta. */
function snapshot(doc: DocStore, id: string, root = true): unknown {
  const v = doc.view(id)!;
  const styles = { ..._test.normalize(v.styles) };
  if (root) for (const k of ['position', 'left', 'top']) delete styles[k];
  return {
    c: v.component,
    t: v.textValue ?? null,
    vis: v.isVisible !== false,
    s: styles,
    kids: doc.childIds(id).map((k) => snapshot(doc, k, false)),
  };
}

function button(doc: DocStore, parent: string, opts: { bg: string; text: string; width?: string; padding?: string; extra?: boolean }) {
  const b = doc.createNode('Frame', parent, {
    label: 'Button',
    styles: { display: 'flex', backgroundColor: opts.bg, borderRadius: '8px', ...(opts.padding ? { padding: opts.padding } : { paddingTop: '8px', paddingRight: '16px', paddingBottom: '8px', paddingLeft: '16px' }), ...(opts.width ? { width: opts.width } : {}) },
  });
  doc.createNode('Text', b, { label: 'Label', textValue: opts.text, styles: { color: '#fff', fontSize: '16px' } });
  if (opts.extra) doc.createNode('Frame', b, { label: 'Icon', styles: { width: '16px', height: '16px' } });
  return b;
}

describe('convertToInstance', () => {
  it('convierte copias sin cambiar cómo se ven y mantiene el vínculo con el main', () => {
    const doc = new DocStore(createEmptyFile('t'), 0);
    const main = button(doc, ROOT, { bg: '#685EF7', text: 'Continue', padding: '8px 16px' });
    doc.createComponentFrom(main);
    const board = doc.createNode('Frame', ROOT, { label: 'Screen', styles: { display: 'flex', left: '400px', top: '0px' } });
    const copy = button(doc, board, { bg: '#685EF7', text: 'Sign in', width: '320px' });
    const red = button(doc, board, { bg: '#FF6467', text: 'Delete' });
    const before = [snapshot(doc, copy), snapshot(doc, red)];
    const order = doc.childIds(board);

    expect(doc.convertToInstance(copy, main).overrideCount).toBe(1); // solo el texto
    doc.convertToInstance(red, main);
    expect([snapshot(doc, copy), snapshot(doc, red)]).toEqual(before);
    expect(doc.childIds(board)).toEqual(order); // mismo id y mismo sitio
    expect(doc.node(copy)!.instanceOf).toBe(main);

    // Editar el main llega a las copias salvo donde hay override.
    doc.setStyles(main, { borderRadius: '20px' });
    expect(doc.view(copy)!.styles.borderRadius).toBe('20px');
    const label = doc.childIds(main)[0]!;
    doc.setStyles(label, { fontSize: '18px' });
    expect(doc.view(doc.childIds(copy)[0]!)!.styles.fontSize).toBe('18px');
    expect(doc.view(doc.childIds(red)[0]!)!.textValue).toBe('Delete');
  });

  it('rechaza copias con otra estructura y no las toca', () => {
    const doc = new DocStore(createEmptyFile('t'), 0);
    const main = button(doc, ROOT, { bg: '#685EF7', text: 'Continue' });
    doc.createComponentFrom(main);
    const other = button(doc, ROOT, { bg: '#685EF7', text: 'Next', extra: true });
    expect(() => doc.convertToInstance(other, main)).toThrow(/children/);
    expect(doc.node(other)!.instanceOf).toBeUndefined();
    expect(doc.childIds(other)).toHaveLength(2);
  });

  it('respeta capas ocultas y estilos que la copia no tiene', () => {
    const doc = new DocStore(createEmptyFile('t'), 0);
    const main = button(doc, ROOT, { bg: '#685EF7', text: 'Continue', extra: true });
    doc.createComponentFrom(main);
    const copy = button(doc, ROOT, { bg: '#685EF7', text: 'Continue', extra: true });
    doc.setVisible(doc.childIds(copy)[1]!, false);
    doc.setStyles(copy, { borderRadius: null });
    const before = snapshot(doc, copy);
    doc.convertToInstance(copy, main);
    expect(snapshot(doc, copy)).toEqual(before);
  });

  it('convierte copias que contienen instancias anidadas', () => {
    const doc = new DocStore(createEmptyFile('t'), 0);
    const btn = button(doc, ROOT, { bg: '#685EF7', text: 'OK' });
    doc.createComponentFrom(btn);
    const card = doc.createNode('Frame', ROOT, { label: 'Card', styles: { display: 'flex', padding: '12px' } });
    doc.createNode('Text', card, { label: 'Title', textValue: 'Elden Ring', styles: { fontSize: '20px' } });
    doc.createInstance(btn, card);
    doc.createComponentFrom(card);
    const copy = doc.createNode('Frame', ROOT, { label: 'Card', styles: { display: 'flex', padding: '12px' } });
    doc.createNode('Text', copy, { label: 'Title', textValue: 'Portal', styles: { fontSize: '20px' } });
    const inner = doc.createInstance(btn, copy);
    doc.setText(doc.childIds(inner)[0]!, 'Play');
    const before = snapshot(doc, copy);
    doc.convertToInstance(copy, card);
    expect(snapshot(doc, copy)).toEqual(before);
    doc.setStyles(btn, { backgroundColor: '#000' });
    expect(doc.view(doc.childIds(copy)[1]!)!.styles.backgroundColor).toBe('#000');
  });
});
