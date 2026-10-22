import fs from 'node:fs';
import path from 'node:path';
import { newFileId, newUlid } from '../core/ids';
import { createEmptyFile, normalizeFile } from '../core/new-file';
import { purgeDeletedNodes } from '../core/tree';
import type { CommentThread, FileSummary, FolderInfo, MokiFile } from '../core/types';
import { paths } from './config';

// Persistencia en JSON con escritura atómica (tmp + rename) y debounce de 500 ms.
//   data/files/<id>.json        → { file, meta: { clientIndexSeq } }
//   data/folders.json           → FolderInfo[]
//   data/comments/<fileId>.json → CommentThread[]

export interface FileRecord {
  file: MokiFile;
  meta: { clientIndexSeq: number };
}

const DEBOUNCE_MS = 500;

export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const SAFE_ID = /^[0-9A-Za-z_-]+$/;

export class Store {
  /** Registros cargados en memoria (los que tienen clientes o se han tocado). */
  private loaded = new Map<string, FileRecord>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private commentCache = new Map<string, CommentThread[]>();
  private commentTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private filePath(id: string) {
    if (!SAFE_ID.test(id)) throw new Error('Invalid file id');
    return path.join(paths.files, `${id}.json`);
  }

  exists(id: string): boolean {
    return SAFE_ID.test(id) && (this.loaded.has(id) || fs.existsSync(this.filePath(id)));
  }

  /** Carga (o devuelve de memoria) el registro de un fichero. */
  get(id: string): FileRecord | null {
    if (!SAFE_ID.test(id)) return null;
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const raw = readJson<FileRecord | MokiFile>(this.filePath(id));
    if (!raw) return null;
    const rec: FileRecord =
      'file' in raw && 'meta' in raw
        ? { file: normalizeFile(raw.file), meta: { clientIndexSeq: raw.meta?.clientIndexSeq ?? 0 } }
        : { file: normalizeFile(raw as MokiFile), meta: { clientIndexSeq: 0 } };
    // Al cargar de disco nadie tiene historial sobre el fichero: los borrados ya no hacen falta y
    // solo engordan lo que se envía a cada pestaña (llegaron a ser más de la mitad del fichero).
    const purged = purgeDeletedNodes(rec.file);
    this.loaded.set(id, rec);
    if (purged) {
      console.log(`[store] ${id}: ${purged} nodos borrados eliminados al cargar`);
      // Guardar sin tocar updatedAt: el contenido visible no ha cambiado.
      this.timers.set(id, setTimeout(() => this.save(id), DEBOUNCE_MS));
    }
    return rec;
  }

  /** Programa el guardado (debounce). */
  touch(id: string) {
    const rec = this.loaded.get(id);
    if (!rec) return;
    rec.file.updatedAt = Date.now();
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => this.save(id), DEBOUNCE_MS));
  }

  save(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const rec = this.loaded.get(id);
    if (rec) writeJsonAtomic(this.filePath(id), rec);
  }

  /** Guarda y libera de memoria. */
  unload(id: string) {
    this.save(id);
    this.loaded.delete(id);
  }

  /** Siguiente clientIndex (creciente y persistido). */
  nextClientIndex(id: string): number {
    const rec = this.get(id);
    if (!rec) throw new Error('File not found');
    rec.meta.clientIndexSeq += 1;
    this.save(id);
    return rec.meta.clientIndexSeq;
  }

  create(opts: { name?: string; cloneFileId?: string; folderId?: string | null } = {}): MokiFile {
    const id = newFileId();
    let file: MokiFile;
    let seq = 0;
    if (opts.cloneFileId) {
      const src = this.get(opts.cloneFileId);
      if (!src) throw new Error(`File not found: ${opts.cloneFileId}`);
      file = structuredClone(src.file);
      file.id = id;
      file.name = opts.name ?? `${src.file.name} (copy)`;
      seq = src.meta.clientIndexSeq;
      // Copiamos los assets del original.
      const from = path.join(paths.assets, opts.cloneFileId);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(paths.assets, id), { recursive: true });
      for (const img of Object.values(file.images)) img.url = img.url.replace(`/file-assets/${opts.cloneFileId}/`, `/file-assets/${id}/`);
      rewriteAssetUrls(file, opts.cloneFileId, id);
    } else {
      file = createEmptyFile(opts.name ?? 'Untitled', id);
    }
    const now = Date.now();
    file.createdAt = now;
    file.updatedAt = now;
    file.folderId = opts.folderId ?? file.folderId ?? null;
    const rec: FileRecord = { file, meta: { clientIndexSeq: seq } };
    this.loaded.set(id, rec);
    this.save(id);
    return file;
  }

  /** Importa un JSON de fichero con id nuevo. */
  /**
   * Importa un fichero (JSON exportado o bundle .moki.zip) como fichero nuevo. Los assets llegan en
   * `assets` (bundle) o, si el original existe en esta instancia, se copian de su carpeta; en ambos
   * casos las URLs `/file-assets/<idViejo>/…` pasan al id nuevo, así la importación no pierde imágenes.
   */
  importFile(data: Partial<MokiFile>, opts: { folderId?: string | null; assets?: Map<string, Buffer> } = {}): MokiFile {
    const id = newFileId();
    const oldId = typeof data.id === 'string' && SAFE_ID.test(data.id) ? data.id : null;
    const file = normalizeFile({ ...structuredClone(data), id } as MokiFile);
    file.createdAt = file.updatedAt = Date.now();
    // Un id de carpeta de otra instancia no significa nada aquí.
    const folder = opts.folderId !== undefined ? opts.folderId : (file.folderId ?? null);
    file.folderId = folder && this.listFolders().some((f) => f.id === folder) ? folder : null;
    const dir = path.join(paths.assets, id);
    if (opts.assets?.size) {
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, bytes] of opts.assets) fs.writeFileSync(path.join(dir, path.basename(name)), bytes);
    } else if (oldId && fs.existsSync(path.join(paths.assets, oldId))) {
      fs.cpSync(path.join(paths.assets, oldId), dir, { recursive: true });
    }
    if (oldId) {
      for (const img of Object.values(file.images)) img.url = img.url.replace(`/file-assets/${oldId}/`, `/file-assets/${id}/`);
      rewriteAssetUrls(file, oldId, id);
    }
    this.loaded.set(id, { file, meta: { clientIndexSeq: 0 } });
    this.save(id);
    return file;
  }

  /** Ficheros de assets de un fichero (nombre → ruta absoluta). */
  assetFiles(id: string): { name: string; path: string }[] {
    const dir = path.join(paths.assets, id);
    if (!SAFE_ID.test(id) || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).map((name) => ({ name, path: path.join(dir, name) }));
  }

  delete(id: string) {
    clearTimeout(this.timers.get(id));
    this.loaded.delete(id);
    fs.rmSync(this.filePath(id), { force: true });
    fs.rmSync(path.join(paths.comments, `${id}.json`), { force: true });
    fs.rmSync(path.join(paths.assets, id), { recursive: true, force: true });
    this.commentCache.delete(id);
  }

  listFiles(): FileSummary[] {
    const out = new Map<string, FileSummary>();
    for (const name of fs.readdirSync(paths.files)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (this.loaded.has(id)) continue;
      const raw = readJson<FileRecord | MokiFile>(path.join(paths.files, name));
      if (!raw) continue;
      const f = ('file' in raw ? raw.file : raw) as MokiFile;
      out.set(id, { id, name: f.name, folderId: f.folderId ?? null, createdAt: f.createdAt, updatedAt: f.updatedAt });
    }
    for (const [id, rec] of this.loaded) {
      const f = rec.file;
      out.set(id, { id, name: f.name, folderId: f.folderId ?? null, createdAt: f.createdAt, updatedAt: f.updatedAt });
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ------------------------------------------------------------------ carpetas

  listFolders(): FolderInfo[] {
    return readJson<FolderInfo[]>(paths.folders) ?? [];
  }

  private saveFolders(list: FolderInfo[]) {
    writeJsonAtomic(paths.folders, list);
  }

  createFolder(name: string, parentId: string | null = null): FolderInfo {
    const now = Date.now();
    const f: FolderInfo = { id: newUlid(), name: name.slice(0, 500) || 'Untitled folder', parentId, createdAt: now, updatedAt: now };
    this.saveFolders([...this.listFolders(), f]);
    return f;
  }

  updateFolder(id: string, patch: { name?: string; parentId?: string | null }): FolderInfo | null {
    const list = this.listFolders();
    const f = list.find((x) => x.id === id);
    if (!f) return null;
    if (patch.name !== undefined && patch.name.trim()) f.name = patch.name.trim().slice(0, 500);
    if (patch.parentId !== undefined) f.parentId = patch.parentId;
    f.updatedAt = Date.now();
    this.saveFolders(list);
    return f;
  }

  deleteFolder(id: string): boolean {
    const list = this.listFolders();
    if (!list.some((f) => f.id === id)) return false;
    this.saveFolders(list.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId: null } : f)));
    // Los ficheros de la carpeta pasan a la raíz.
    for (const s of this.listFiles()) {
      if (s.folderId !== id) continue;
      const rec = this.get(s.id);
      if (rec) {
        rec.file.folderId = null;
        this.save(s.id);
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ comentarios

  getComments(fileId: string): CommentThread[] {
    let c = this.commentCache.get(fileId);
    if (!c) {
      c = readJson<CommentThread[]>(path.join(paths.comments, `${fileId}.json`)) ?? [];
      this.commentCache.set(fileId, c);
    }
    return c;
  }

  saveComments(fileId: string) {
    clearTimeout(this.commentTimers.get(fileId));
    this.commentTimers.set(
      fileId,
      setTimeout(() => {
        this.commentTimers.delete(fileId);
        const c = this.commentCache.get(fileId);
        if (c) writeJsonAtomic(path.join(paths.comments, `${fileId}.json`), c);
      }, DEBOUNCE_MS),
    );
  }

  /** Escribe a disco todo lo pendiente. */
  flushAll() {
    for (const id of [...this.timers.keys()]) this.save(id);
    for (const [fileId, t] of this.commentTimers) {
      clearTimeout(t);
      const c = this.commentCache.get(fileId);
      if (c) writeJsonAtomic(path.join(paths.comments, `${fileId}.json`), c);
    }
    this.commentTimers.clear();
  }
}

/** Reescribe /file-assets/<old>/ → /file-assets/<new>/ en estilos (clon de fichero). */
function rewriteAssetUrls(file: MokiFile, oldId: string, newId: string) {
  const from = `/file-assets/${oldId}/`;
  const to = `/file-assets/${newId}/`;
  for (const n of Object.values(file.nodes)) {
    for (const [k, v] of Object.entries(n.styles)) {
      if (typeof v === 'string' && v.includes(from)) n.styles[k] = v.split(from).join(to);
    }
    if (n.attrs) for (const [k, v] of Object.entries(n.attrs)) if (v.includes(from)) n.attrs[k] = v.split(from).join(to);
  }
}

export const store = new Store();
