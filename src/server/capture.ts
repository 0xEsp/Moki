import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { newUlid } from '../core/ids';
import type { CaptureParams, ExportRequestItem, RpcMethods } from '../core/protocol';
import type { ImageInfo, MokiFile } from '../core/types';
import { getContext } from './browser';
import { config, paths } from './config';
import { store } from './store';
import { hub } from './sync';

// Capturas, export y assets. Las capturas se hacen en una página dedicada (`/?capture=1`)
// que pinta el artboard desde un snapshot del modelo autoritativo del servidor.

const MAX_SIDE = config.maxExportSide;
const AI_MAX_SIDE = 2000;
const AI_MAX_B64 = 4_500_000;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------- mutex + página

let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

let capturePage: Page | null = null;
let lastCaptureAt = 0;

// La página de capturas se cierra tras un rato sin uso (memoria).
const captureSweeper = setInterval(() => {
  if (capturePage && !capturePage.isClosed() && Date.now() - lastCaptureAt > config.captureIdleMs) {
    const p = capturePage;
    capturePage = null;
    void p.close().catch(() => undefined);
  }
}, 30_000);
captureSweeper.unref();

async function getCapturePage(): Promise<Page> {
  lastCaptureAt = Date.now();
  if (capturePage && !capturePage.isClosed()) return capturePage;
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.warn('[capture]', m.text());
  });
  page.on('pageerror', (e) => console.warn('[capture] pageerror', e.message));
  page.on('crash', () => {
    if (capturePage === page) capturePage = null;
  });
  try {
    await page.goto(`${config.webOrigin}/?capture=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.mokiCapture, undefined, { timeout: 20_000 });
  } catch {
    await page.close().catch(() => undefined);
    throw new Error(`The Moki capture page is not reachable at ${config.webOrigin}/?capture=1`);
  }
  capturePage = page;
  return page;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  failedImages: number;
}

function snapshotFile(fileId: string): MokiFile {
  const rec = store.get(fileId);
  if (!rec) throw new Error(`File not found: ${fileId}`);
  return rec.file;
}

async function renderNode(page: Page, file: MokiFile, nodeId: string, scale: number, mode: 'image' | 'pdf', backdrop: 'visible' | 'hidden') {
  const rect = (await page.evaluate(
    (req) => window.mokiCapture!.render(req),
    { file, nodeId, scale, backdrop, mode } as Parameters<NonNullable<Window['mokiCapture']>['render']>[0],
  )) as Rect;
  if (rect.width < 1 || rect.height < 1) throw new Error('Node has no size');
  return rect;
}

async function screenshotRect(page: Page, rect: Rect, type: 'png' | 'jpeg', quality?: number, transparent = false): Promise<Buffer> {
  const right = Math.ceil(rect.x + rect.width);
  const bottom = Math.ceil(rect.y + rect.height);
  const clip = { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
  if (right <= 8000 && bottom <= 8000) {
    const vp = page.viewportSize();
    if (!vp || vp.width < right || vp.height < bottom) {
      await page.setViewportSize({ width: Math.max(1600, right), height: Math.max(1000, bottom) });
    }
    return page.screenshot({ clip, type, quality: type === 'jpeg' ? quality : undefined, omitBackground: transparent });
  }
  return page.screenshot({ clip, type, fullPage: true, quality: type === 'jpeg' ? quality : undefined, omitBackground: transparent });
}

/** Limita la escala para que ningún lado pase de MAX_SIDE ni el área de MAX_SIDE². */
function clampScale(width: number, height: number, scale: number, maxSide = MAX_SIDE): number {
  let s = scale;
  if (width * s > maxSide) s = maxSide / width;
  if (height * s > maxSide) s = maxSide / height;
  if (width * s * height * s > MAX_SIDE * MAX_SIDE) s = Math.sqrt((MAX_SIDE * MAX_SIDE) / (width * height));
  return s > 0 && Number.isFinite(s) ? s : 1;
}

/** Comprime a JPEG para la IA: base64 ≤ 4.5M (baja calidad y, si no basta, reduce a la mitad). */
async function compressForAgent(input: Buffer): Promise<{ data: string; width: number; height: number }> {
  let img = sharp(input).flatten({ background: '#ffffff' });
  let meta = await sharp(input).metadata();
  let w = meta.width ?? 1;
  let h = meta.height ?? 1;
  if (Math.max(w, h) > AI_MAX_SIDE) {
    const f = AI_MAX_SIDE / Math.max(w, h);
    w = Math.max(1, Math.round(w * f));
    h = Math.max(1, Math.round(h * f));
  }
  let base = await img.resize(w, h).png().toBuffer();
  for (let halvings = 0; halvings <= 8; halvings++) {
    for (const q of [92, 75, 60, 45]) {
      const buf = await sharp(base).jpeg({ quality: q }).toBuffer();
      const b64 = buf.toString('base64');
      if (b64.length <= AI_MAX_B64) return { data: b64, width: w, height: h };
    }
    w = Math.max(1, Math.round(w / 2));
    h = Math.max(1, Math.round(h / 2));
    base = await sharp(base).resize(w, h).png().toBuffer();
  }
  const last = await sharp(base).jpeg({ quality: 50 }).toBuffer();
  meta = await sharp(last).metadata();
  return { data: last.toString('base64'), width: meta.width ?? w, height: meta.height ?? h };
}

// ---------------------------------------------------------------------------- capture

export function capture(fileId: string, p: CaptureParams): Promise<RpcMethods['capture']['result']> {
  return serialized(async () => {
    const page = await getCapturePage();
    const file = snapshotFile(fileId);
    // Primer pase a escala 1 para conocer el tamaño y limitar la escala.
    let scale = p.scale > 0 ? p.scale : 1;
    let rect = await renderNode(page, file, p.nodeId, scale, 'image', p.backdrop ?? 'visible');
    const forAgent = p.format === 'jpeg' && p.quality === undefined;
    const limit = forAgent ? AI_MAX_SIDE : MAX_SIDE;
    const clamped = clampScale(rect.width / scale, rect.height / scale, scale, limit);
    if (Math.abs(clamped - scale) > 1e-3) {
      scale = clamped;
      rect = await renderNode(page, file, p.nodeId, scale, 'image', p.backdrop ?? 'visible');
    }
    const transparent = p.backdrop === 'hidden' && p.format !== 'jpeg';
    const png = await screenshotRect(page, rect, 'png', undefined, transparent);
    let out: Buffer;
    let mimeType: string;
    let width = Math.round(rect.width);
    let height = Math.round(rect.height);
    switch (p.format) {
      case 'jpeg': {
        if (forAgent) {
          const c = await compressForAgent(png);
          return { data: c.data, mimeType: 'image/jpeg', width: c.width, height: c.height };
        }
        out = await sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: p.quality ?? 90 }).toBuffer();
        mimeType = 'image/jpeg';
        break;
      }
      case 'webp':
        out = await sharp(png).webp({ quality: p.quality ?? 90 }).toBuffer();
        mimeType = 'image/webp';
        break;
      case 'avif':
        out = await sharp(png).avif({ quality: p.quality ?? 70 }).toBuffer();
        mimeType = 'image/avif';
        break;
      default:
        out = png;
        mimeType = 'image/png';
    }
    const meta = await sharp(out).metadata();
    width = meta.width ?? width;
    height = meta.height ?? height;
    return { data: out.toString('base64'), mimeType, width, height };
  });
}

// ---------------------------------------------------------------------------- export

export function uniqueExportName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || 'export';
  const m = /^(.*?)((?:\.moki)?\.[a-z0-9]+)?$/i.exec(safe)!;
  const stem = m[1] || safe;
  const ext = m[2] ?? '';
  let candidate = safe;
  for (let i = 2; fs.existsSync(path.join(paths.exports, candidate)); i++) candidate = `${stem} (${i})${ext}`;
  return candidate;
}

/** Destino de un export ya nombrado: ruta en disco + rutas/URLs para el cliente. */
export function exportTarget(finalName: string): { fullPath: string; filePath: string; downloadUrl: string; url: string } {
  const filePath = path.join(config.exportHostDir ?? paths.exports, finalName);
  const downloadUrl = `/api/exports/${encodeURIComponent(finalName)}`;
  // `url` absoluta para agentes en otra máquina (descarga con Bearer o con la cookie de sesión).
  return { fullPath: path.join(paths.exports, finalName), filePath, downloadUrl, url: `${config.publicOrigin}${downloadUrl}` };
}

function writeExport(name: string, data: Buffer | string): { filePath: string; downloadUrl: string; url: string } {
  const t = exportTarget(uniqueExportName(name));
  fs.writeFileSync(t.fullPath, data);
  return { filePath: t.filePath, downloadUrl: t.downloadUrl, url: t.url };
}

async function pdfOf(page: Page, file: MokiFile, nodeId: string): Promise<Buffer> {
  const rect = await renderNode(page, file, nodeId, 1, 'pdf', 'visible');
  const pdf = await page.pdf({
    width: `${Math.ceil(rect.width)}px`,
    height: `${Math.ceil(rect.height)}px`,
    printBackground: true,
    pageRanges: '1',
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });
  await page.evaluate(() => window.mokiCapture!.reset());
  return pdf;
}

export type RenderFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'pdf' | 'svg';

/** Renderiza un nodo a bytes en el formato pedido (sin tomar el mutex: el llamante ya lo tiene). */
async function renderUnlocked(page: Page, file: MokiFile, nodeId: string, format: RenderFormat, scaleIn: number): Promise<Buffer> {
  if (format === 'pdf') return pdfOf(page, file, nodeId);
  if (format === 'svg') {
    const markup = await page.evaluate((req) => window.mokiCapture!.svg(req), { file, nodeId });
    if (!markup) throw new Error('SVG export is only available for SVG nodes; try a raster format (png, jpg, webp) or pdf');
    return Buffer.from(markup, 'utf8');
  }
  let rect = await renderNode(page, file, nodeId, 1, 'image', 'visible');
  const scale = clampScale(rect.width, rect.height, scaleIn > 0 ? scaleIn : 1);
  if (scale !== 1) rect = await renderNode(page, file, nodeId, scale, 'image', 'visible');
  const png = await screenshotRect(page, rect, 'png');
  if (format === 'jpg') return sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  if (format === 'webp') return sharp(png).webp({ quality: 90 }).toBuffer();
  if (format === 'avif') return sharp(png).avif({ quality: 70 }).toBuffer();
  return png;
}

/**
 * Renderiza un nodo para exportar. Toma el mutex por nodo (no por lote), así una exportación larga
 * no bloquea las capturas del MCP más que lo que dura cada render.
 */
export function renderExport(file: MokiFile, nodeId: string, format: RenderFormat, scale: number): Promise<Buffer> {
  return serialized(async () => renderUnlocked(await getCapturePage(), file, nodeId, format, scale));
}

/** Une varios PDFs (una página por nodo) en uno. */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  merged.setProducer('Moki');
  merged.setCreator('Moki');
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const pg of pages) merged.addPage(pg);
  }
  return Buffer.from(await merged.save());
}

export function exportFiles(fileId: string, items: ExportRequestItem[]): Promise<RpcMethods['exportFiles']['result']> {
  return serialized(async () => {
    const file = snapshotFile(fileId);
    const exports: RpcMethods['exportFiles']['result']['exports'] = [];
    const errors: RpcMethods['exportFiles']['result']['errors'] = [];
    let page: Page | null = null;
    for (const item of items) {
      try {
        if (item.format === 'svg' && item.svgMarkup) {
          exports.push({ nodeId: item.nodeId, ...writeExport(item.fileName, item.svgMarkup) });
          continue;
        }
        page ??= await getCapturePage();
        const out = await renderUnlocked(page, file, item.nodeId, item.format, item.scale);
        exports.push({ nodeId: item.nodeId, ...writeExport(item.fileName, out) });
      } catch (e) {
        errors.push({ nodeId: item.nodeId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { exports, errors };
  });
}

export function exportCombinedPdf(fileId: string, p: RpcMethods['exportCombinedPdf']['params']): Promise<RpcMethods['exportCombinedPdf']['result']> {
  return serialized(async () => {
    const file = snapshotFile(fileId);
    const page = await getCapturePage();
    const parts: Buffer[] = [];
    for (const nodeId of p.nodeIds) parts.push(await pdfOf(page, file, nodeId));
    return writeExport(p.fileName, await mergePdfs(parts));
  });
}

// ---------------------------------------------------------------------------- assets

const EXT_BY_FORMAT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', svg: 'svg', heif: 'heic', tiff: 'tiff' };
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', heic: 'image/heic', tiff: 'image/tiff',
};
export const mimeForExt = (ext: string) => MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';

/** Lee los bytes de una fuente de imagen (http(s), data:, file://, /file-assets/…). */
async function readSource(src: string): Promise<{ bytes: Buffer; name?: string }> {
  const s = src.trim();
  if (s.startsWith('data:')) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(s);
    if (!m) throw new Error('Invalid data: URL');
    const bytes = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
    return { bytes };
  }
  if (s.startsWith('/file-assets/')) return { bytes: readLocalAsset(s), name: path.basename(s) };
  if (s.startsWith('file://') || s.startsWith('moki-asset://') || s.startsWith('/')) {
    const p = s.startsWith('/') ? s : fileURLToPath(s.replace(/^moki-asset:\/\//, 'file://'));
    const abs = path.resolve(decodeURIComponent(p));
    if (!config.localAssetRoots.some((r) => abs === r || abs.startsWith(r + path.sep))) {
      throw new Error(`Local file not allowed: ${abs}. Add its folder to MOKI_LOCAL_ASSET_ROOTS.`);
    }
    return { bytes: fs.readFileSync(abs), name: path.basename(abs) };
  }
  const url = new URL(s);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported image URL: ${url.protocol}`);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (isLocal && url.pathname.startsWith('/file-assets/') && (url.port === String(config.port) || url.port === '5173')) {
    return { bytes: readLocalAsset(url.pathname), name: path.basename(url.pathname) };
  }
  if (isLocal && config.localhostAlias) url.hostname = config.localhostAlias;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Could not download image (${res.status}) ${src}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_ASSET_BYTES) throw new Error('Image is larger than 100 MiB');
  return { bytes: Buffer.from(await res.arrayBuffer()), name: decodeURIComponent(path.basename(url.pathname)) || undefined };
}

function readLocalAsset(urlPath: string): Buffer {
  const m = /^\/file-assets\/([^/]+)\/([^/?#]+)/.exec(urlPath);
  if (!m) throw new Error('Invalid asset URL');
  const p = path.join(paths.assets, path.basename(m[1]!), path.basename(decodeURIComponent(m[2]!)));
  return fs.readFileSync(p);
}

/** Guarda bytes de imagen como asset del fichero y lo registra en `images` (vía sync). */
export async function storeImage(fileId: string, bytes: Buffer, opts: { name?: string; sourceUrl?: string; imageId?: string } = {}): Promise<ImageInfo> {
  if (!store.exists(fileId)) throw new Error(`File not found: ${fileId}`);
  if (bytes.length > MAX_ASSET_BYTES) throw new Error('Image is larger than 100 MiB');
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(bytes, { animated: true }).metadata();
  } catch {
    throw new Error('Unsupported or corrupt image');
  }
  let ext = EXT_BY_FORMAT[meta.format ?? ''] ?? 'png';
  let data = bytes;
  if (ext === 'heic' || ext === 'tiff') {
    data = await sharp(bytes).jpeg({ quality: 92 }).toBuffer();
    ext = 'jpg';
  }
  const id = opts.imageId ?? newUlid();
  const dir = path.join(paths.assets, fileId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.${ext}`), data);
  const height = meta.pageHeight ?? meta.height;
  const info: ImageInfo = {
    id,
    status: 'ready',
    extension: ext,
    url: `/file-assets/${fileId}/${id}.${ext}`,
    ...(opts.name ? { name: opts.name.slice(0, 200) } : {}),
    ...(meta.width ? { width: meta.width } : {}),
    ...(height ? { height } : {}),
    ...(opts.sourceUrl ? { sourceUrl: opts.sourceUrl } : {}),
  };
  hub.applyEdits(fileId, [{ path: `/images/${id}`, type: 'add', value: info }]);
  return info;
}

export async function importImage(fileId: string, src: string): Promise<RpcMethods['importImage']['result']> {
  const isRemote = /^https?:\/\//i.test(src);
  // Misma URL remota en el mismo fichero → mismo id (no se descarga dos veces).
  const imageId = isRemote
    ? crypto.createHash('sha256').update(`${src}|${fileId}`).digest('hex').slice(0, 26).toUpperCase()
    : undefined;
  const existing = imageId ? store.get(fileId)?.file.images[imageId] : undefined;
  if (existing && existing.status === 'ready' && fs.existsSync(path.join(paths.assets, fileId, `${existing.id}.${existing.extension}`))) {
    return { imageId: existing.id, url: existing.url, width: existing.width, height: existing.height, extension: existing.extension, name: existing.name };
  }
  const { bytes, name } = await readSource(src);
  const info = await storeImage(fileId, bytes, { name, sourceUrl: isRemote ? src : undefined, imageId });
  return { imageId: info.id, url: info.url, width: info.width, height: info.height, extension: info.extension, name: info.name };
}

export async function readImageForAgent(src: string): Promise<RpcMethods['readImageForAgent']['result']> {
  const { bytes } = await readSource(src);
  const meta = await sharp(bytes).metadata();
  const c = await compressForAgent(bytes);
  return {
    data: c.data,
    mimeType: 'image/jpeg',
    width: c.width,
    height: c.height,
    originalWidth: meta.width ?? c.width,
    originalHeight: meta.pageHeight ?? meta.height ?? c.height,
  };
}

export async function closeCapture() {
  await capturePage?.close().catch(() => undefined);
  capturePage = null;
}
