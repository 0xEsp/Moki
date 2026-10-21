import { describe, expect, it } from 'vitest';
import { createEmptyFile } from '../new-file';
import { DocStore } from '../../web/state/doc-store';
import { isVirtualId } from '../components';

const ROOT = 'root_node_p-1-0';

function setup() {
  const doc = new DocStore(createEmptyFile('t'), 0);
  // main: Button (Frame) > Label (Text)
  const main = doc.createNode('Frame', ROOT, { label: 'Button', styles: { display: 'flex', left: '0px', top: '0px', backgroundColor: '#111', borderRadius: '4px', padding: '8px' } });
  const label = doc.createNode('Text', main, { label: 'Label', textValue: 'OK', styles: { color: '#fff' } });
  doc.createComponentFrom(main);
  const board = doc.createNode('Frame', ROOT, { label: 'Board', styles: { display: 'flex', left: '500px', top: '0px' } });
  const inst = doc.createInstance(main, board);
  return { doc, main, label, board, inst };
}

describe('componentes', () => {
  it('la instancia pinta los hijos del main con ids virtuales', () => {
    const { doc, inst, label } = setup();
    const kids = doc.childIds(inst);
    expect(kids).toEqual([`${inst}::${label}`]);
    expect(isVirtualId(kids[0])).toBe(true);
    expect(doc.node(kids[0]!)?.textValue).toBe('OK');
    expect(doc.parentId(kids[0]!)).toBe(inst);
    // La raíz hereda estilos del main salvo la posición.
    const v = doc.view(inst)!;
    expect(v.styles.backgroundColor).toBe('#111');
    expect(v.styles.left).toBeUndefined();
  });

  it('editar el main actualiza la instancia; los overrides ganan', () => {
    const { doc, inst, main, label } = setup();
    const vid = `${inst}::${label}`;
    doc.setStyles(main, { borderRadius: '12px' });
    expect(doc.view(inst)!.styles.borderRadius).toBe('12px');
    doc.setText(vid, 'Cancelar');
    doc.setStyles(vid, { color: '#f00' });
    expect(doc.node(vid)!.textValue).toBe('Cancelar');
    expect(doc.node(vid)!.styles.color).toBe('#f00');
    // El main no cambia.
    expect(doc.node(label)!.textValue).toBe('OK');
    doc.setText(label, 'Aceptar');
    expect(doc.node(vid)!.textValue).toBe('Cancelar');
    doc.resetOverrides(vid);
    expect(doc.node(vid)!.textValue).toBe('Aceptar');
  });

  it('borrar un hijo virtual lo oculta con override', () => {
    const { doc, inst, label } = setup();
    const vid = `${inst}::${label}`;
    doc.deleteNodes([vid]);
    expect(doc.node(vid)!.isVisible).toBe(false);
    expect(doc.node(label)!.isVisible).toBeUndefined();
  });

  it('no se pueden añadir hijos dentro de una instancia ni crear ciclos', () => {
    const { doc, inst, main } = setup();
    expect(() => doc.createNode('Frame', inst)).toThrow(/instance/);
    expect(() => doc.createInstance(main, main)).toThrow(/cycle/);
  });

  it('instancias anidadas y overrides externos', () => {
    const { doc, main, label } = setup();
    const card = doc.createNode('Frame', ROOT, { label: 'Card', styles: { display: 'flex', left: '0px', top: '300px' } });
    const nested = doc.createInstance(main, card);
    doc.createComponentFrom(card);
    const page = doc.createNode('Frame', ROOT, { label: 'Page', styles: { display: 'flex', left: '900px', top: '0px' } });
    const cardInst = doc.createInstance(card, page);
    const deep = `${cardInst}::${nested}::${label}`;
    expect(doc.childIds(`${cardInst}::${nested}`)).toEqual([deep]);
    expect(doc.node(deep)!.textValue).toBe('OK');
    doc.setText(deep, 'Ver más');
    expect(doc.node(deep)!.textValue).toBe('Ver más');
    expect(doc.node(cardInst)!.overrides![`${nested}::${label}`]!.textValue).toBe('Ver más');
    expect(doc.parentId(deep)).toBe(`${cardInst}::${nested}`);
    // Ciclo: el main Button no puede contener instancias de Card (que usa Button).
    expect(() => doc.createInstance(card, main)).toThrow(/cycle/);
  });

  it('desvincular materializa los nodos con los overrides', () => {
    const { doc, inst, label } = setup();
    doc.setText(`${inst}::${label}`, 'Hola');
    const map = doc.detachInstance(inst);
    expect(doc.node(inst)!.instanceOf).toBeUndefined();
    const kids = doc.childIds(inst);
    expect(kids.length).toBe(1);
    expect(isVirtualId(kids[0])).toBe(false);
    expect(doc.node(kids[0]!)!.textValue).toBe('Hola');
    expect(map[label]).toBe(kids[0]);
    expect(doc.node(inst)!.styles.backgroundColor).toBe('#111');
  });

  it('duplicar una instancia da otra instancia; deshacer funciona', () => {
    const { doc, inst } = setup();
    const c = doc.cloneNode(inst)!;
    expect(doc.node(c.newId)!.instanceOf).toBe(doc.node(inst)!.instanceOf);
    expect(Object.keys(c.map)).toEqual([inst]);
    doc.breakUndoGroup();
    doc.setText(doc.childIds(inst)[0]!, 'X');
    doc.breakUndoGroup();
    doc.undo();
    expect(doc.node(doc.childIds(inst)[0]!)!.textValue).toBe('OK');
  });

  it('un main borrado sigue pintando sus instancias', () => {
    const { doc, inst, main } = setup();
    doc.deleteNodes([main]);
    expect(doc.childIds(inst).length).toBe(1);
    expect(doc.view(inst)!.styles.backgroundColor).toBe('#111');
  });
});
