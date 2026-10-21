// Segunda prueba e2e centrada en el parser HTML: node scripts/mcp-e2e-parser.mjs <puerto> <dirSalida>
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// MOKI_TOKEN opcional (servidor con auth): Bearer para /api y /mcp.
const AUTH = process.env.MOKI_TOKEN ? { authorization: `Bearer ${process.env.MOKI_TOKEN}` } : {};
const [port = '7410', outDir = '.'] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const created = await (await fetch(`${base}/api/files`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ name: 'Parser' }) })).json();
const fileId = created.id ?? created.fileId ?? created.file?.id;
const client = new Client({ name: 'moki-e2e-parser', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: AUTH } }));
let failures = 0;
async function call(name, args, expectError = false) {
  const r = await client.callTool({ name, arguments: args });
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const body = texts.length > 1 ? texts.slice(1).join('\n') : texts[0] ?? '';
  if (!!r.isError !== expectError) failures++;
  console.log(`\n### ${name}${r.isError ? ' [isError]' : ''}\n${body.slice(0, 2500)}`);
  for (const [i, im] of r.content.filter((c) => c.type === 'image').entries()) {
    const p = path.join(outDir, `parser-${name}-${i}.jpg`);
    fs.writeFileSync(p, Buffer.from(im.data, 'base64'));
    console.log('image saved', p);
  }
  try { return JSON.parse(body); } catch { return body; }
}
const guide = await call('get_guide', { topic: 'mobile-status-bar' });
const statusHtml = /```html\n([\s\S]*?)```/.exec(guide)[1].replaceAll('#FFFFFF', '#000000');
const mobile = await call('create_artboard', { fileId, name: 'Mobile', styles: { width: '375px', height: '812px', backgroundColor: '#FAFAF7' } });
await call('write_html', { fileId, targetNodeId: mobile.id, mode: 'insert-children', html: statusHtml });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwHwyBNAMDA8N/AAD9Cv/hX6s8VgAAAABJRU5ErkJggg==';
await call('write_html', { fileId, targetNodeId: mobile.id, mode: 'insert-children', html: `
<form style="display:flex;flex-direction:column;gap:12px;padding:24px">
  <label style="font-family:Inter;font-size:13px;font-weight:600;color:#333">Email</label>
  <input type="email" placeholder="you@studio.com" style="height:44px;padding:0 14px;border:1px solid #D9D6CF;border-radius:10px;font-family:Inter;font-size:15px;background:#fff">
  <select style="height:44px;padding:0 14px;border:1px solid #D9D6CF;border-radius:10px;font-family:Inter;font-size:15px"><option>Designer</option><option selected>Engineer</option></select>
  <div style="display:flex;align-items:center;gap:8px;font-family:Inter;font-size:14px"><input type="checkbox" checked> Remember me</div>
  <div style="position:relative;height:140px;border-radius:12px;overflow:hidden">
    <img src="${png}" style="width:100%;height:100%;object-fit:cover">
    <div style="position:absolute;left:12px;bottom:12px;z-index:2;background:#000;color:#fff;font-family:Inter;font-size:12px;padding:4px 8px;border-radius:6px">Cover</div>
    <div style="position:absolute;left:0;top:0;width:100%;height:100%;z-index:1;background:linear-gradient(transparent,rgba(0,0,0,0.4))"></div>
  </div>
</form>` });
const sum = await call('get_tree_summary', { fileId, nodeId: mobile.id, depth: 6 });
// Clone + insert into the page root + replace inside a freeform parent
const ids = [...sum.summary.matchAll(/\(([0-9A-Z]+-[0-9A-Z]+)\)/g)].map((m) => m[1]);
const formId = ids[ids.length > 8 ? 8 : 1];
const info = await call('get_basic_info', { fileId });
await call('write_html', { fileId, targetNodeId: info.rootNodeId, mode: 'insert-children', html: `<div layer-name="Sticker" style="width:200px;height:200px;background:#E4572E;border-radius:50%;margin:40px"><x-moki-clone node-id="${formId}" style="opacity:0.5"></x-moki-clone></div>` });
await call('get_basic_info', { fileId });
await call('get_screenshot', { fileId, nodeId: mobile.id, scale: 1 });
await call('find_nodes', { fileId, filters: [{ styleName: 'border', styleValue: '#d9d6cf' }] });
await call('write_html', { fileId, targetNodeId: mobile.id, mode: 'insert-children', html: '<p></p>' });
await call('write_html', { fileId, targetNodeId: 'nope', mode: 'replace', html: '<div>x</div>' }, true);
await call('finish_working_on_nodes', { fileId, nodeIds: [mobile.id] });
await client.close();
console.log(`\nFAILURES: ${failures}`);
