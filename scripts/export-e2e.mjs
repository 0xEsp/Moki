// Prueba e2e de la exportación masiva (POST /api/export) y del bundle editable .moki.zip.
//   node scripts/export-e2e.mjs <puerto>     (acepta MOKI_URL y MOKI_TOKEN)
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const port = process.argv[2] ?? '7410';
const base = process.env.MOKI_URL ?? `http://127.0.0.1:${port}`;
const AUTH = process.env.MOKI_TOKEN ? { authorization: `Bearer ${process.env.MOKI_TOKEN}` } : {};
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

async function api(path, init = {}) {
  const r = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...AUTH, ...(init.headers ?? {}) } });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}
const download = async (url) => new Uint8Array(await (await fetch(`${base}${url}`, { headers: AUTH })).arrayBuffer());
const exportReq = (body, q = '') => api(`/api/export${q}`, { method: 'POST', body: JSON.stringify(body) });

const client = new Client({ name: 'export-e2e', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: AUTH } }));
const tool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const last = t[t.length - 1];
  if (r.isError) throw new Error(`${name}: ${last}`);
  try {
    return JSON.parse(last);
  } catch {
    return last;
  }
};

const red = `data:image/png;base64,${(await sharp({ create: { width: 40, height: 40, channels: 4, background: '#e5484d' } }).png().toBuffer()).toString('base64')}`;

/** Crea un fichero con N páginas × 2 artboards y devuelve su id. */
async function makeFile(name, folderId, pages = 1) {
  const { body } = await api('/api/files', { method: 'POST', body: JSON.stringify({ name, folderId }) });
  const fileId = body.id;
  const info = await tool('open_file', { fileId });
  const pageIds = [info.pageId];
  for (let i = 1; i < pages; i++) pageIds.push((await tool('create_page', { fileId, name: `Página ${i + 1}` })).pageId);
  for (const [pi, pageId] of pageIds.entries()) {
    for (const label of ['Inicio', 'Detalle']) {
      const ab = await tool('create_artboard', { fileId, pageId, name: `${label} ${pi + 1}`, styles: { width: '200px', height: '120px', backgroundColor: '#ffffff', padding: '16px', gap: '8px' } });
      await tool('write_html', {
        fileId,
        targetNodeId: ab.id,
        mode: 'insert-children',
        html: `<div style="font-family: Inter; font-size: 18px; font-weight: 700">${label}</div><img src="${red}" style="width: 40px; height: 40px" />`,
      });
    }
  }
  await tool('finish_working_on_nodes', { fileId });
  return { fileId, pageIds };
}

const demo = await makeFile('Export demo', null, 2);
const { body: root } = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'Carpeta E2E' }) });
const { body: sub } = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'Sub', parentId: root.id }) });
await makeFile('Fichero A', root.id);
await makeFile('Fichero B', sub.id);

// 1) Un único nodo → fichero directo (sin zip).
{
  const file = (await api(`/api/files/${demo.fileId}`)).body;
  const someArtboard = Object.values(file.nodes).find((n) => n.label === 'Inicio 1');
  const r = await exportReq({ scope: 'nodes', fileId: demo.fileId, nodeIds: [someArtboard.id], format: 'png', scale: 2 });
  check(r.status === 200 && r.body.name === 'Inicio 1@2x.png' && r.body.count === 1, `nodo suelto → ${r.body.name}`);
  const bytes = await download(r.body.downloadUrl);
  const meta = await sharp(bytes).metadata();
  check(meta.width === 400 && meta.height === 240, `PNG 2x de 200×120 → ${meta.width}×${meta.height}`);
}

// 2) Página → zip con sus artboards.
{
  const r = await exportReq({ scope: 'page', fileId: demo.fileId, pageId: demo.pageIds[0], format: 'png', scale: 1 });
  const z = unzipSync(await download(r.body.downloadUrl));
  const names = Object.keys(z).sort();
  check(r.body.name === 'Export demo - Page 1.zip' && names.join('|') === 'Export demo/Page 1/Detalle 1.png|Export demo/Page 1/Inicio 1.png', `página → ${r.body.name}: ${names.join(', ')}`);
  const meta = await sharp(z['Export demo/Page 1/Inicio 1.png']).metadata();
  check(meta.width === 200, 'los PNG del zip se decodifican');
}

// 3) Proyecto entero en PDF por artboard.
{
  const r = await exportReq({ scope: 'file', fileId: demo.fileId, format: 'pdf' });
  const z = unzipSync(await download(r.body.downloadUrl));
  const names = Object.keys(z);
  check(names.length === 4 && names.every((n) => Buffer.from(z[n].slice(0, 4)).toString() === '%PDF'), `proyecto PDF por artboard: ${names.length} PDFs`);
}

// 4) PDF por página: 2 PDFs de 2 páginas cada uno.
{
  const r = await exportReq({ scope: 'file', fileId: demo.fileId, format: 'pdf-combined' });
  const z = unzipSync(await download(r.body.downloadUrl));
  const counts = await Promise.all(Object.keys(z).sort().map(async (n) => `${n}:${(await PDFDocument.load(z[n])).getPageCount()}`));
  check(counts.join('|') === 'Export demo/Page 1.pdf:2|Export demo/Página 2.pdf:2', `PDF por página → ${counts.join(', ')}`);
}

// 5) Bundle editable → reimportar sin pérdidas (mismos nodos, imágenes copiadas).
{
  const r = await exportReq({ scope: 'file', fileId: demo.fileId, format: 'moki' });
  check(r.body.name === 'Export demo.moki.zip', `bundle editable → ${r.body.name}`);
  const zipBytes = await download(r.body.downloadUrl);
  const z = unzipSync(zipBytes);
  const assets = Object.keys(z).filter((n) => n.startsWith('assets/'));
  check(!!z['file.json'] && !!z['manifest.json'] && assets.length >= 1, `bundle: file.json + manifest + ${assets.length} assets`);
  const imp = await fetch(`${base}/api/files/import`, { method: 'POST', headers: { 'content-type': 'application/zip', ...AUTH }, body: zipBytes });
  const created = await imp.json();
  check(imp.status === 201 && created.id !== demo.fileId, `reimportado como ${created.id}`);
  const orig = (await api(`/api/files/${demo.fileId}`)).body;
  const copy = (await api(`/api/files/${created.id}`)).body;
  const live = (f) => Object.values(f.nodes).filter((n) => !n['~']).length;
  check(live(orig) === live(copy), `mismo nº de nodos (${live(orig)} = ${live(copy)})`);
  const urls = JSON.stringify(copy.nodes).match(/\/file-assets\/[^)"]+/g) ?? [];
  check(urls.length > 0 && urls.every((u) => u.includes(`/file-assets/${created.id}/`)), `URLs de assets reescritas al id nuevo (${urls.length})`);
  const img = await fetch(`${base}${urls[0]}`, { headers: AUTH });
  check(img.ok, `asset servido tras reimportar (${img.status})`);
  await api(`/api/files/${created.id}`, { method: 'DELETE' });
}

// 6) Carpeta recursiva con fuente editable, en segundo plano con progreso.
{
  const start = await exportReq({ scope: 'folder', folderId: root.id, format: 'png', scale: 1, includeSource: true }, '?async=1');
  check(start.status === 202 && start.body.status === 'running', 'job en segundo plano iniciado');
  let job = start.body;
  let sawProgress = false;
  while (job.status === 'running') {
    await new Promise((r) => setTimeout(r, 200));
    job = (await api(`/api/export/jobs/${job.id}`)).body;
    if (job.total > 0) sawProgress = true;
  }
  check(job.status === 'done' && sawProgress, `job terminado (${job.result?.count} ficheros)`);
  const names = Object.keys(unzipSync(await download(job.result.downloadUrl))).sort();
  check(
    names.join('|') ===
      'Carpeta E2E/Fichero A.moki.zip|Carpeta E2E/Fichero A/Page 1/Detalle 1.png|Carpeta E2E/Fichero A/Page 1/Inicio 1.png|Carpeta E2E/Sub/Fichero B.moki.zip|Carpeta E2E/Sub/Fichero B/Page 1/Detalle 1.png|Carpeta E2E/Sub/Fichero B/Page 1/Inicio 1.png',
    `carpeta → ${names.join(', ')}`,
  );
}

// 7) SVG sin nodos SVG → error claro (no un zip vacío).
{
  const r = await exportReq({ scope: 'file', fileId: demo.fileId, format: 'svg' });
  check(r.status === 400 && /SVG/.test(r.body.message), `SVG sin nodos SVG → 400 "${r.body.message}"`);
}

// 8) MCP: export con scope.
{
  const res = await tool('export', { fileId: demo.fileId, scope: 'file', format: 'jpg', scale: 1 });
  check(!!res.export?.url && res.export.files === 4, `MCP export scope file → ${res.export?.files} ficheros (${res.export?.downloadUrl})`);
}

await client.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
