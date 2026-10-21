import fs from 'node:fs';
import path from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough, zipSync, type Zippable } from 'fflate';
import { newUlid } from '../core/ids';
import type { BulkExportJob, BulkExportRequest, BulkExportResult } from '../core/protocol';
import type { MokiFile } from '../core/types';
import { exportTarget, mergePdfs, renderExport, uniqueExportName, type RenderFormat } from './capture';
import { folderTree, planFile, planNodes, sanitizeName, scaleSuffix, ZipNamer, type PlannedArtboard } from './export-plan';
import { store } from './store';

// Exportación masiva: una selección, una página, un fichero entero o una carpeta (recursiva).
// Se renderiza nodo a nodo (el mutex de captura se toma por nodo) y, si sale más de un fichero,
// se escribe un .zip en streaming en la carpeta de exports. También genera el bundle editable
// `.moki.zip` (file.json + assets/), que POST /api/files/import vuelve a importar sin pérdidas.

export const MOKI_BUNDLE_VERSION = 1;

class ExportError extends Error {}

interface Task {
  /** Ruta dentro del zip (o nombre del fichero si es la única salida). */
  path: string;
  /** Las imágenes y PDFs ya van comprimidos: se guardan tal cual. */
  compress: boolean;
  run: () => Promise<Uint8Array>;
}

type Progress = (done: number, total: number, current?: string) => void;

const EXT: Record<string, string> = { png: 'png', jpg: 'jpg', webp: 'webp', svg: 'svg', pdf: 'pdf', 'pdf-combined': 'pdf' };

/** Bundle editable de un fichero: manifest.json + file.json + assets/<id>.<ext>. */
export function buildMokiBundle(fileId: string): Uint8Array {
  const rec = store.get(fileId);
  if (!rec) throw new ExportError(`File not found: ${fileId}`);
  const entries: Zippable = {
    'manifest.json': strToU8(
      JSON.stringify({ format: 'moki-bundle', version: MOKI_BUNDLE_VERSION, fileId, name: rec.file.name, exportedAt: new Date().toISOString() }, null, 2),
    ),
    'file.json': [strToU8(JSON.stringify(rec.file)), { level: 6 }],
  };
  for (const a of store.assetFiles(fileId)) entries[`assets/${a.name}`] = [new Uint8Array(fs.readFileSync(a.path)), { level: 0 }];
  return zipSync(entries, { level: 0 });
}

const strToU8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

function snapshot(fileId: string): MokiFile {
  const rec = store.get(fileId);
  if (!rec) throw new ExportError(`File not found: ${fileId}`);
  return structuredClone(rec.file);
}

/** Tareas de un fichero bajo `base` ("" o "Carpeta/Sub/"). */
function fileTasks(
  fileId: string,
  base: string,
  req: BulkExportRequest,
  errors: BulkExportResult['errors'],
  opts: { pageId?: string; nodeIds?: string[] } = {},
): Task[] {
  const file = snapshot(fileId);
  const fileName = sanitizeName(file.name, 'Sin título');
  const tasks: Task[] = [];
  const bundle = (): Task => ({ path: `${base}${fileName}.moki.zip`, compress: false, run: async () => buildMokiBundle(fileId) });
  if (req.format === 'moki') return [bundle()];

  const format = req.format;
  const scale = format === 'pdf' || format === 'pdf-combined' || format === 'svg' ? 1 : Math.max(0.5, Math.min(4, req.scale ?? 2));
  const ext = EXT[format]!;
  const renderFmt: RenderFormat = format === 'pdf-combined' ? 'pdf' : (format as RenderFormat);
  const root = `${base}${fileName}/`;
  const nameOf = (a: PlannedArtboard) => `${sanitizeName(a.label)}${scaleSuffix(scale)}.${ext}`;

  const usable = (items: PlannedArtboard[], where: string) =>
    items.filter((a) => {
      if (format !== 'svg' || a.isSvg) return true;
      errors.push({ name: `${where}${a.label}`, error: 'SVG export is only available for SVG nodes; use png, jpg, webp or pdf' });
      return false;
    });

  if (opts.nodeIds) {
    const items = usable(planNodes(file, opts.nodeIds), root);
    if (format === 'pdf-combined' && items.length) {
      tasks.push({ path: `${root}${fileName}.pdf`, compress: false, run: () => combined(file, items) });
    } else {
      for (const a of items) tasks.push({ path: `${root}${nameOf(a)}`, compress: format === 'svg', run: () => one(file, a.id, renderFmt, scale) });
    }
  } else {
    for (const page of planFile(file, opts.pageId)) {
      const pageDir = `${root}${sanitizeName(page.label)}/`;
      const items = usable(page.artboards, pageDir);
      if (!items.length) continue;
      if (format === 'pdf-combined') {
        tasks.push({ path: `${root}${sanitizeName(page.label)}.pdf`, compress: false, run: () => combined(file, items) });
        continue;
      }
      for (const a of items) tasks.push({ path: `${pageDir}${nameOf(a)}`, compress: format === 'svg', run: () => one(file, a.id, renderFmt, scale) });
    }
  }
  if (req.includeSource) tasks.push(bundle());
  return tasks;
}

async function one(file: MokiFile, nodeId: string, format: RenderFormat, scale: number): Promise<Uint8Array> {
  return new Uint8Array(await renderExport(file, nodeId, format, scale));
}

async function combined(file: MokiFile, items: PlannedArtboard[]): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for (const a of items) parts.push(await renderExport(file, a.id, 'pdf', 1));
  return new Uint8Array(await mergePdfs(parts));
}

/** Plan completo + nombre del zip según el alcance. */
function plan(req: BulkExportRequest, errors: BulkExportResult['errors']): { tasks: Task[]; zipName: string } {
  switch (req.scope) {
    case 'nodes': {
      if (!req.fileId || !req.nodeIds?.length) throw new ExportError('scope "nodes" needs fileId and nodeIds');
      const name = sanitizeName(snapshot(req.fileId).name, 'Sin título');
      return { tasks: fileTasks(req.fileId, '', req, errors, { nodeIds: req.nodeIds }), zipName: `${name} - selección.zip` };
    }
    case 'page': {
      if (!req.fileId || !req.pageId) throw new ExportError('scope "page" needs fileId and pageId');
      const file = snapshot(req.fileId);
      const page = file.pages.find((p) => p.id === req.pageId && !p['~'] && !p.isDivider);
      if (!page) throw new ExportError(`Page not found: ${req.pageId}`);
      return {
        tasks: fileTasks(req.fileId, '', req, errors, { pageId: req.pageId }),
        zipName: `${sanitizeName(file.name, 'Sin título')} - ${sanitizeName(page.label)}.zip`,
      };
    }
    case 'file': {
      if (!req.fileId) throw new ExportError('scope "file" needs fileId');
      return { tasks: fileTasks(req.fileId, '', req, errors), zipName: `${sanitizeName(snapshot(req.fileId).name, 'Sin título')}.zip` };
    }
    case 'folder': {
      if (!req.folderId) throw new ExportError('scope "folder" needs folderId');
      const tree = folderTree(store.listFolders(), req.folderId);
      if (!tree.length) throw new ExportError(`Folder not found: ${req.folderId}`);
      const files = store.listFiles();
      const tasks: Task[] = [];
      for (const f of tree) {
        const base = `${f.path.join('/')}/`;
        for (const file of files.filter((x) => x.folderId === f.id).sort((a, b) => a.name.localeCompare(b.name))) {
          tasks.push(...fileTasks(file.id, base, req, errors));
        }
      }
      return { tasks, zipName: `${tree[0]!.path[0]}.zip` };
    }
    default:
      throw new ExportError(`Unknown scope: ${String((req as { scope?: unknown }).scope)}`);
  }
}

/** Ejecuta una exportación masiva y devuelve dónde quedó el resultado. */
export async function runBulkExport(req: BulkExportRequest, progress: Progress = () => undefined): Promise<BulkExportResult> {
  const errors: BulkExportResult['errors'] = [];
  const { tasks, zipName } = plan(req, errors);
  if (!tasks.length) throw new ExportError(errors.length ? errors[0]!.error : 'Nothing to export: no visible artboards in that scope');

  // Una sola salida (y sin errores que reportar dentro): se devuelve el fichero tal cual.
  if (tasks.length === 1) {
    const t = tasks[0]!;
    progress(0, 1, t.path);
    const bytes = await t.run();
    const finalName = uniqueExportName(path.basename(t.path));
    const target = exportTarget(finalName);
    fs.writeFileSync(target.fullPath, bytes);
    progress(1, 1);
    return { name: finalName, downloadUrl: target.downloadUrl, filePath: target.filePath, url: target.url, count: 1, errors };
  }

  const finalName = uniqueExportName(zipName);
  const target = exportTarget(finalName);
  const tmp = `${target.fullPath}.part`;
  const out = fs.createWriteStream(tmp);
  const written = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      zipError = err;
      out.destroy(err);
      return;
    }
    out.write(chunk);
    if (final) out.end();
  });
  const namer = new ZipNamer();
  let count = 0;
  try {
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      progress(i, tasks.length, t.path);
      try {
        const bytes = await t.run();
        const entry = t.compress ? new ZipDeflate(namer.take(t.path), { level: 6 }) : new ZipPassThrough(namer.take(t.path));
        zip.add(entry);
        entry.push(bytes, true);
        count++;
      } catch (e) {
        errors.push({ name: t.path, error: e instanceof Error ? e.message : String(e) });
      }
      if (zipError) throw zipError;
    }
    if (count === 0) throw new ExportError(errors[0]?.error ?? 'Nothing could be exported');
    zip.end();
    await written;
    fs.renameSync(tmp, target.fullPath);
  } catch (e) {
    zip.terminate();
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  progress(tasks.length, tasks.length);
  return { name: finalName, downloadUrl: target.downloadUrl, filePath: target.filePath, url: target.url, count, errors };
}

export const isExportError = (e: unknown): e is Error => e instanceof ExportError;

// ---------------------------------------------------------------------------- jobs (progreso)

const jobs = new Map<string, BulkExportJob & { finishedAt?: number }>();

/** Lanza una exportación en segundo plano; la UI consulta el progreso con `getJob`. */
export function startBulkExportJob(req: BulkExportRequest): BulkExportJob {
  const id = newUlid();
  const job: BulkExportJob & { finishedAt?: number } = { id, status: 'running', done: 0, total: 0 };
  jobs.set(id, job);
  runBulkExport(req, (done, total, current) => {
    job.done = done;
    job.total = total;
    job.current = current;
  })
    .then((result) => {
      job.status = 'done';
      job.result = result;
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      job.finishedAt = Date.now();
      job.current = undefined;
    });
  return { ...job };
}

export function getJob(id: string): BulkExportJob | null {
  const j = jobs.get(id);
  if (!j) return null;
  const { finishedAt: _f, ...rest } = j;
  void _f;
  return rest;
}

const sweeper = setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [id, j] of jobs) if (j.finishedAt && j.finishedAt < cutoff) jobs.delete(id);
}, 60_000);
sweeper.unref();
