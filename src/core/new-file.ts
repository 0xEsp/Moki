import { newFileId } from './ids';
import { FREEFORM_DISPLAY, SCHEMA_VERSION, type MokiFile } from './types';

export const DEFAULT_CANVAS_COLOR = '#ECECEC';

/** Fichero vacío: una página "Page 1" (`p-1-0`) con su raíz libre. */
export function createEmptyFile(name = 'Untitled', id = newFileId()): MokiFile {
  const now = Date.now();
  const pageId = 'p-1-0';
  const rootId = `root_node_${pageId}`;
  return {
    id,
    name,
    folderId: null,
    createdAt: now,
    updatedAt: now,
    schema: SCHEMA_VERSION,
    pages: [{ id: pageId, label: 'Page 1', createdAt: now, updatedAt: now, canvasColor: DEFAULT_CANVAS_COLOR }],
    nodes: {
      [rootId]: { id: rootId, label: 'Page 1', component: 'Frame', styles: { display: FREEFORM_DISPLAY } },
    },
    nodeRelationships: {},
    counter: { pages: 1, nodes: 0, tokens: 0, modes: 0 },
    labelCounter: {},
    theme: { tokens: {}, modes: {} },
    images: {},
  };
}

/** Rellena campos que falten (ficheros antiguos o importados). */
export function normalizeFile(f: Partial<MokiFile> & { id: string }): MokiFile {
  const base = createEmptyFile(f.name ?? 'Untitled', f.id);
  const file = { ...base, ...f } as MokiFile;
  file.counter = { ...base.counter, ...(f.counter ?? {}) };
  file.theme = { tokens: f.theme?.tokens ?? {}, modes: f.theme?.modes ?? {} };
  file.images = f.images ?? {};
  file.labelCounter = f.labelCounter ?? {};
  file.nodeRelationships = f.nodeRelationships ?? {};
  if (!f.pages || f.pages.length === 0) {
    file.pages = base.pages;
    file.nodes = { ...base.nodes, ...(f.nodes ?? {}) };
  }
  for (const p of file.pages) {
    const rootId = `root_node_${p.id}`;
    if (!p.isDivider && !file.nodes[rootId]) {
      file.nodes[rootId] = { id: rootId, label: p.label, component: 'Frame', styles: { display: FREEFORM_DISPLAY } };
    }
  }
  return file;
}
