import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { BulkExportRequest } from '../core/protocol';
import type { MokiFile } from '../core/types';
import { getJob, isExportError, runBulkExport, startBulkExportJob } from './bulk-export';
import { mimeForExt, storeImage } from './capture';
import { clearCookie, isAuthorized, sessionCookie, tokenMatches } from './auth';
import { config, paths } from './config';
import { handleMcpHttp } from './mcp';
import { runtimes } from './runtime';
import { store } from './store';
import { hub } from './sync';

// API REST del dashboard, assets, exports y estáticos de producción.

const MAX_BODY = 110 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function readRaw(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readRaw(req);
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.map': 'application/json',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, opts: { mime?: string; cache?: string; download?: string } = {}) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error();
  } catch {
    throw new HttpError(404, 'Not found');
  }
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': opts.mime ?? STATIC_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(stat.size),
    etag,
    'cache-control': opts.cache ?? 'no-cache',
  };
  if (opts.download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(opts.download)}`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function isHttps(req: IncomingMessage): boolean {
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https';
}

function resources() {
  return { files: store.listFiles(), folders: store.listFolders(), openFiles: hub.openFiles().map((o) => o.fileId) };
}

export async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (await handleMcpHttp(req, res, p)) return;

    if (p === '/api/health') return json(res, 200, { ok: true, version: config.version });

    // --- Sesión / login (públicos) ---
    if (p === '/api/session') {
      return json(res, 200, { authRequired: !!config.token, authenticated: isAuthorized(req, { token: config.token, cookie: true }) });
    }
    if (p === '/api/login' && method === 'POST') {
      if (!config.token) return json(res, 200, { ok: true });
      const body = await readJson<{ token?: string }>(req);
      if (!tokenMatches(config.token, typeof body.token === 'string' ? body.token.trim() : '')) {
        await new Promise((r) => setTimeout(r, 400)); // frena la fuerza bruta
        return json(res, 401, { ok: false, message: 'Token incorrecto' });
      }
      res.setHeader('set-cookie', sessionCookie(config.token, isHttps(req)));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/logout' && method === 'POST') {
      res.setHeader('set-cookie', clearCookie());
      return json(res, 200, { ok: true });
    }

    // --- Lo demás de /api y los assets exige sesión si hay token: cookie (navegador) o
    //     Bearer (scripts, agentes descargando exports desde otra máquina).
    if ((p.startsWith('/api/') || p.startsWith('/file-assets/')) && !isAuthorized(req, { token: config.token, cookie: true, bearer: true })) {
      return json(res, 401, { message: 'Unauthorized' });
    }

    if (p === '/api/info') {
      return json(res, 200, {
        name: 'moki',
        version: config.version,
        mcpUrl: `${config.isProd ? config.publicOrigin : `http://localhost:${config.port}`}/mcp`,
        authRequired: !!config.token,
        dataDir: config.dataDir,
        exportDir: config.exportHostDir ?? paths.exports,
      });
    }
    if (p === '/api/resources' && method === 'GET') return json(res, 200, resources());

    if (p === '/api/files' && method === 'POST') {
      const body = await readJson<{ name?: string; cloneFileId?: string; folderId?: string | null }>(req);
      try {
        const file = store.create(body);
        return json(res, 201, { id: file.id, name: file.name });
      } catch (e) {
        throw new HttpError(404, e instanceof Error ? e.message : String(e));
      }
    }
    if (p === '/api/files/import' && method === 'POST') {
      // JSON exportado (GET /api/files/:id) o bundle editable .moki.zip (file.json + assets/).
      const raw = await readRaw(req, 1024 * 1024 * 1024);
      const folderId = url.searchParams.get('folderId') || null;
      let data: Partial<MokiFile> | null = null;
      let assets: Map<string, Buffer> | undefined;
      if (raw[0] === 0x50 && raw[1] === 0x4b) {
        let entries: Record<string, Uint8Array>;
        try {
          entries = unzipSync(new Uint8Array(raw));
        } catch {
          throw new HttpError(400, 'Invalid zip');
        }
        const fileJson = entries['file.json'];
        if (!fileJson) throw new HttpError(400, 'Not a Moki bundle (missing file.json)');
        try {
          data = JSON.parse(Buffer.from(fileJson).toString('utf8'));
        } catch {
          throw new HttpError(400, 'Invalid file.json');
        }
        assets = new Map();
        for (const [name, bytes] of Object.entries(entries)) {
          if (name.startsWith('assets/') && bytes.length) assets.set(path.basename(name), Buffer.from(bytes));
        }
      } else {
        let body: Partial<MokiFile> & { file?: MokiFile };
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          throw new HttpError(400, 'Invalid JSON');
        }
        data = body.file && typeof body.file === 'object' ? body.file : body;
      }
      if (!data || typeof data !== 'object' || !('nodes' in data)) throw new HttpError(400, 'Not a Moki file');
      const file = store.importFile(data, { folderId, assets });
      return json(res, 201, { id: file.id, name: file.name });
    }

    // Exportación masiva (selección, página, fichero o carpeta). `?async=1` → job con progreso.
    if (p === '/api/export' && method === 'POST') {
      const body = await readJson<BulkExportRequest>(req);
      if (url.searchParams.get('async') === '1') return json(res, 202, startBulkExportJob(body));
      try {
        return json(res, 200, await runBulkExport(body));
      } catch (e) {
        if (isExportError(e)) throw new HttpError(400, e.message);
        throw e;
      }
    }
    let jm = /^\/api\/export\/jobs\/([0-9A-Za-z]+)$/.exec(p);
    if (jm && method === 'GET') {
      const job = getJob(jm[1]!);
      if (!job) throw new HttpError(404, 'Job not found');
      return json(res, 200, job);
    }

    let m = /^\/api\/files\/([0-9A-Za-z]+)$/.exec(p);
    if (m) {
      const id = m[1]!;
      const rec = store.get(id);
      if (!rec) throw new HttpError(404, 'File not found');
      if (method === 'GET') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rec.file.name || 'moki')}.moki.json`,
        });
        return res.end(JSON.stringify(rec.file));
      }
      if (method === 'PATCH') {
        const body = await readJson<{ name?: string; folderId?: string | null }>(req);
        if (typeof body.name === 'string' && body.name.trim()) hub.renameFile(id, body.name.trim().slice(0, 500));
        if (body.folderId !== undefined) hub.applyEdits(id, [{ path: '/folderId', type: 'update', value: body.folderId }]);
        return json(res, 200, { id, name: rec.file.name, folderId: rec.file.folderId ?? null });
      }
      if (method === 'DELETE') {
        hub.closeFile(id);
        await runtimes.close(id);
        store.delete(id);
        return json(res, 200, { ok: true });
      }
    }

    m = /^\/api\/files\/([0-9A-Za-z]+)\/assets$/.exec(p);
    if (m && method === 'POST') {
      const id = m[1]!;
      if (!store.exists(id)) throw new HttpError(404, 'File not found');
      const bytes = await readRaw(req);
      const rawName = req.headers['x-file-name'];
      const name = typeof rawName === 'string' ? decodeURIComponent(rawName) : undefined;
      try {
        const info = await storeImage(id, bytes, { name });
        return json(res, 201, info);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    }

    if (p === '/api/folders' && method === 'POST') {
      const body = await readJson<{ name?: string; parentId?: string | null }>(req);
      return json(res, 201, store.createFolder(body.name ?? 'Untitled folder', body.parentId ?? null));
    }
    m = /^\/api\/folders\/([0-9A-Za-z]+)$/.exec(p);
    if (m) {
      if (method === 'PATCH') {
        const body = await readJson<{ name?: string; parentId?: string | null }>(req);
        const f = store.updateFolder(m[1]!, body);
        if (!f) throw new HttpError(404, 'Folder not found');
        return json(res, 200, f);
      }
      if (method === 'DELETE') {
        if (!store.deleteFolder(m[1]!)) throw new HttpError(404, 'Folder not found');
        return json(res, 200, { ok: true });
      }
    }

    m = /^\/file-assets\/([0-9A-Za-z]+)\/([^/]+)$/.exec(p);
    if (m && (method === 'GET' || method === 'HEAD')) {
      const name = path.basename(decodeURIComponent(m[2]!));
      return sendFile(req, res, path.join(paths.assets, m[1]!, name), {
        mime: mimeForExt(path.extname(name).slice(1)),
        cache: 'public, max-age=31536000, immutable',
      });
    }

    m = /^\/api\/exports\/([^/]+)$/.exec(p);
    if (m && (method === 'GET' || method === 'HEAD')) {
      const name = path.basename(decodeURIComponent(m[1]!));
      return sendFile(req, res, path.join(paths.exports, name), { download: name });
    }

    if (p.startsWith('/api/')) throw new HttpError(404, 'Not found');

    // `?token=…` en cualquier ruta de la web: fija la cookie y redirige sin el token.
    const qToken = url.searchParams.get('token');
    if (qToken !== null && config.token && method === 'GET') {
      url.searchParams.delete('token');
      const location = url.pathname + (url.search ? url.search : '');
      if (tokenMatches(config.token, qToken)) res.setHeader('set-cookie', sessionCookie(config.token, isHttps(req)));
      res.writeHead(302, { location, 'cache-control': 'no-store' });
      return res.end();
    }

    // Estáticos de producción (dist/) con fallback SPA. Públicos: no contienen datos (la
    // app pide login antes de llamar a la API).
    if (method === 'GET' || method === 'HEAD') {
      if (!fs.existsSync(config.distDir)) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(`Moki server ${config.version}. In development open the Vite app (npm run dev:web). MCP: /mcp`);
      }
      const rel = path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(config.distDir, rel);
      if (file.startsWith(config.distDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const immutable = rel.startsWith('/assets/') || rel.startsWith('/fonts/files/');
        return sendFile(req, res, file, { cache: immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      }
      if (p === '/' || p.startsWith('/file/') || !path.extname(p)) {
        return sendFile(req, res, path.join(config.distDir, 'index.html'));
      }
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (e instanceof HttpError) return json(res, e.status, { message: e.message });
    console.error('[http]', e);
    return json(res, 500, { message: e instanceof Error ? e.message : 'Internal error' });
  }
}
