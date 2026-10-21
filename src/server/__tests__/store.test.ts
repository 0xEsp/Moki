import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../core/edits';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moki-store-'));
process.env.MOKI_DATA_DIR = dir;
const { store } = await import('../store');
const { parseFileRef } = await import('../mcp');

describe('store', () => {
  it('crea, edita, persiste y clona ficheros', () => {
    const f = store.create({ name: 'A' });
    const rec = store.get(f.id)!;
    applyEdits(rec.file as unknown as Record<string, unknown>, [
      { path: '/nodes/1-1', type: 'add', value: { id: '1-1', label: 'Frame 1', component: 'Frame', styles: {} } },
      { path: '/nodeRelationships/1-1', type: 'add', value: 'root_node_p-1-0:O' },
    ]);
    store.save(f.id);
    store.unload(f.id);
    expect(store.get(f.id)!.file.nodes['1-1']?.label).toBe('Frame 1');
    expect(store.nextClientIndex(f.id)).toBe(1);
    expect(store.nextClientIndex(f.id)).toBe(2);
    const c = store.create({ cloneFileId: f.id });
    expect(c.id).not.toBe(f.id);
    expect(c.nodeRelationships['1-1']).toBe('root_node_p-1-0:O');
    // El clon hereda la secuencia de clientIndex (los ids existentes no colisionan).
    expect(store.nextClientIndex(c.id)).toBe(3);
    expect(store.listFiles().length).toBe(2);
    store.delete(c.id);
    expect(store.exists(c.id)).toBe(false);
  });

  it('carpetas', () => {
    const folder = store.createFolder('Proyectos');
    const f = store.create({ name: 'B', folderId: folder.id });
    expect(store.deleteFolder(folder.id)).toBe(true);
    expect(store.get(f.id)!.file.folderId).toBeNull();
  });
});

describe('parseFileRef', () => {
  const id = '01M5DR3WH1VK8FP4QSSHG0N2FW';
  it('acepta id, ruta y URL', () => {
    expect(parseFileRef(id)).toEqual({ fileId: id });
    expect(parseFileRef(`/file/${id}/p-2-0`)).toEqual({ fileId: id, pageId: 'p-2-0' });
    expect(parseFileRef(`http://localhost:7410/file/${id}`)).toEqual({ fileId: id });
    expect(parseFileRef('nope')).toBeNull();
  });
});
