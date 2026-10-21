import { describe, expect, it } from 'vitest';
import { readingOrder } from '../../core/layout-order';
import { createEmptyFile } from '../../core/new-file';
import type { MokiFile, TreeNode } from '../../core/types';
import { folderTree, planFile, planNodes, sanitizeName, scaleSuffix, ZipNamer } from '../export-plan';

function fileWith(nodes: { id: string; parent: string; key: string; node: Partial<TreeNode> }[], extraPage = false): MokiFile {
  const f = createEmptyFile('Demo');
  if (extraPage) {
    f.pages.push({ id: 'p-2-0', label: 'Segunda', createdAt: 0, updatedAt: 0 });
    f.pages.push({ id: 'p-3-0', label: '', createdAt: 0, updatedAt: 0, isDivider: true });
    f.nodes['root_node_p-2-0'] = { id: 'root_node_p-2-0', label: 'Segunda', component: 'Frame', styles: { display: '*' } };
  }
  for (const n of nodes) {
    f.nodes[n.id] = { id: n.id, label: n.id, component: 'Frame', styles: {}, ...n.node } as TreeNode;
    f.nodeRelationships[n.id] = `${n.parent}:${n.key}`;
  }
  return f;
}

describe('export-plan', () => {
  it('sanea nombres', () => {
    expect(sanitizeName('Login / iOS: v2?')).toBe('Login _ iOS_ v2_');
    expect(sanitizeName('   ')).toBe('Sin nombre');
    expect(sanitizeName('..oculto..')).toBe('oculto');
  });

  it('deduplica rutas del zip sin distinguir mayúsculas y respeta .moki.zip', () => {
    const n = new ZipNamer();
    expect(n.take('A/x.png')).toBe('A/x.png');
    expect(n.take('A/X.png')).toBe('A/X (2).png');
    expect(n.take('A/x.png')).toBe('A/x (3).png');
    expect(n.take('Demo.moki.zip')).toBe('Demo.moki.zip');
    expect(n.take('Demo.moki.zip')).toBe('Demo (2).moki.zip');
  });

  it('sufijo de escala', () => {
    expect(scaleSuffix(1)).toBe('');
    expect(scaleSuffix(2)).toBe('@2x');
  });

  it('artboards por página, visibles y en orden de lectura; sin separadores', () => {
    const f = fileWith(
      [
        { id: 'B', parent: 'root_node_p-1-0', key: 'a', node: { styles: { left: '500px', top: '0px', width: '400px', height: '800px' } } },
        { id: 'A', parent: 'root_node_p-1-0', key: 'b', node: { styles: { left: '0px', top: '10px', width: '400px', height: '800px' } } },
        { id: 'C', parent: 'root_node_p-1-0', key: 'c', node: { styles: { left: '0px', top: '1000px', width: '400px', height: '800px' } } },
        { id: 'H', parent: 'root_node_p-1-0', key: 'd', node: { isVisible: false } },
        { id: 'T', parent: 'root_node_p-1-0', key: 'e', node: { component: 'Text', textValue: 'suelto' } },
        { id: 'child', parent: 'A', key: 'a', node: {} },
        { id: 'S', parent: 'root_node_p-2-0', key: 'a', node: { component: 'SVG' } },
      ],
      true,
    );
    const pages = planFile(f);
    expect(pages.map((p) => p.label)).toEqual(['Page 1', 'Segunda']);
    expect(pages[0]!.artboards.map((a) => a.id)).toEqual(['A', 'B', 'C']);
    expect(pages[1]!.artboards).toMatchObject([{ id: 'S', isSvg: true }]);
    expect(planFile(f, 'p-2-0')).toHaveLength(1);
    expect(planNodes(f, ['child', 'nope']).map((a) => a.id)).toEqual(['child']);
  });

  it('árbol de carpetas recursivo con rutas', () => {
    const tree = folderTree(
      [
        { id: 'root', name: 'Gotty', parentId: null },
        { id: 'sub', name: 'iOS / Android', parentId: 'root' },
        { id: 'deep', name: 'Viejo', parentId: 'sub' },
        { id: 'other', name: 'Otra', parentId: null },
      ],
      'root',
    );
    expect(tree).toEqual([
      { id: 'root', path: ['Gotty'] },
      { id: 'sub', path: ['Gotty', 'iOS _ Android'] },
      { id: 'deep', path: ['Gotty', 'iOS _ Android', 'Viejo'] },
    ]);
    expect(folderTree([], 'x')).toEqual([]);
  });

  it('orden de lectura por filas', () => {
    const items = [
      { id: 'b', r: { x: 500, y: 0, width: 100, height: 100 } },
      { id: 'c', r: { x: 0, y: 300, width: 100, height: 100 } },
      { id: 'a', r: { x: 0, y: 20, width: 100, height: 100 } },
    ];
    expect(readingOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
