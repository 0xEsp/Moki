// Prueba end-to-end del MCP de Moki: node scripts/mcp-e2e.mjs <puerto> <dirSalida>
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// MOKI_TOKEN opcional (servidor con auth): Bearer para /api y /mcp.
const AUTH = process.env.MOKI_TOKEN ? { authorization: `Bearer ${process.env.MOKI_TOKEN}` } : {};
const port = process.argv[2] ?? '7410';
const outDir = process.argv[3] ?? '.';
const base = process.env.MOKI_URL ?? `http://127.0.0.1:${port}`;

const created = await (await fetch(`${base}/api/files`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ name: 'E2E MCP' }) })).json();
const fileId = created.id ?? created.fileId ?? created.file?.id;
console.log('file', fileId);

const client = new Client({ name: 'moki-e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: AUTH } }));
const tools = await client.listTools();
console.log('tools:', tools.tools.length);

let failures = 0;
async function call(name, args, { expectError = false } = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const body = texts.length > 1 ? texts.slice(1).join('\n') : texts[0] ?? '';
  const ok = !!r.isError === expectError;
  if (!ok) failures++;
  console.log(`\n### ${name} ${ok ? 'OK' : 'FAIL'} (${Date.now() - t0} ms)${r.isError ? ' [isError]' : ''}`);
  console.log(body.length > 1500 ? body.slice(0, 1500) + '…' : body);
  const imgs = r.content.filter((c) => c.type === 'image');
  imgs.forEach((im, i) => {
    const p = path.join(outDir, `${name}-${Date.now()}-${i}.jpg`);
    fs.writeFileSync(p, Buffer.from(im.data, 'base64'));
    console.log('image saved', p);
  });
  let data = null;
  try { data = JSON.parse(body); } catch { data = body; }
  return { r, data, texts };
}

await call('get_guide', { topic: 'nope' });
await call('open_file', { fileId });
const info = (await call('get_basic_info', { fileId })).data;
const pageId = info.pageId;
await call('get_font_family_info', { fileId, familyNames: ['Inter', 'Arial', 'Nope Sans'] });
await call('create_tokens', { fileId, tokens: [
  { type: 'color', name: '--color-ink', value: '#14110F' },
  { type: 'color', name: '--color-accent', value: '#E4572E' },
  { type: 'spacing', name: '--spacing-4', value: 16 },
  { type: 'color', name: '--color-text', value: 'var(--color-ink)' },
  { type: 'color', name: '--color-bad', value: 'notacolor' },
] });
await call('get_tokens', { fileId, format: 'css' });
const ab = (await call('create_artboard', { fileId, name: 'Desktop', styles: { width: '1440px', height: '900px', backgroundColor: '#FFFFFF', padding: '64px' } })).data;
const card = (await call('write_html', { fileId, targetNodeId: ab.id, mode: 'insert-children', html: `
<div layer-name="Card" style="display:flex;flex-direction:column;gap:16px;width:420px;padding:32px;background:#F6F1EA;border-radius:16px">
  <span style="font-family:Inter;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-accent)">New in Moki</span>
  <h1 style="font-family:Inter;font-size:40px;line-height:44px;font-weight:700;letter-spacing:-0.03em;color:var(--color-ink);margin:0">Design with <em>real</em> HTML</h1>
  <p style="font-family:Inter;font-size:16px;line-height:24px;color:#5A534D;margin:0">Every layer is a DOM element.<br>Agents write it, you refine it.</p>
  <div style="display:flex;gap:12px;align-items:center">
    <button style="padding:12px 20px;background:#14110F;color:#fff;border-radius:999px;font-family:Inter;font-size:15px;font-weight:600;border:none">Start designing</button>
    <a style="font-family:Inter;font-size:15px;color:#14110F;text-decoration:underline">Read the docs</a>
  </div>
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2"/></svg>
</div>` })).data;
const cardId = card.createdNodes?.[0]?.id;
const tree = (await call('get_tree_summary', { fileId, nodeId: ab.id, depth: 4 })).data;
await call('get_node_info', { fileId, nodeId: cardId });
await call('get_children', { fileId, nodeId: cardId });
await call('update_styles', { fileId, updates: [{ nodeIds: [cardId], styles: { boxShadow: '0 8px 24px rgba(0,0,0,0.08)', flexGrow: 1, gap: 'var(--spacing-4)' } }] });
await call('get_computed_styles', { fileId, nodeIds: [cardId, 'nope'] });
await call('get_screenshot', { fileId, nodeId: ab.id });
await call('get_screenshot', { fileId, nodeId: `root_node_${pageId}` }, { expectError: true });
await call('get_jsx', { fileId, nodeId: cardId, includeNodeIds: false });
await call('get_jsx', { fileId, nodeId: cardId, format: 'tailwind', includeNodeIds: false });
await call('find_nodes', { fileId, filters: [{ styleValue: '#14110F' }] });
await call('find_nodes', { fileId, textValue: '*docs*' });
const dup = (await call('duplicate_nodes', { fileId, nodes: [{ id: cardId }, { id: ab.id }] })).data;
const kids = (await call('get_children', { fileId, nodeId: cardId })).data;
const firstKid = kids.children[0].id;
await call('move_nodes', { fileId, moves: [{ nodeId: firstKid, parentId: cardId }, { nodeId: firstKid, before: kids.children[1].id }] });
await call('set_text_content', { fileId, updates: [{ nodeId: firstKid, textContent: 'Fresh in Moki' }, { nodeId: cardId, textContent: 'x' }] });
await call('rename_nodes', { fileId, updates: [{ nodeId: cardId, name: 'Hero card' }] });
await call('write_html', { fileId, targetNodeId: firstKid, mode: 'replace', html: '<div style="font-family:Inter;font-size:12px;color:#E4572E">Replaced label</div>' });
await call('create_page', { fileId, name: 'Explorations', icon: 'design' });
const info2 = (await call('get_basic_info', { fileId })).data;
await call('arrange_pages', { fileId, order: [...info2.pages.map((p) => p.id).reverse(), { type: 'divider' }] });
await call('update_pages', { fileId, updates: [{ pageId, name: 'Main', icon: 'arrow' }] });
await call('get_selection', { fileId });
await call('list_comment_threads', { fileId, status: 'all' });
await call('delete_nodes', { fileId, nodeIds: [dup.duplicatedNodes[0].newId] });
await call('delete_nodes', { fileId, nodeIds: ['ZZZ-0'] }, { expectError: true });
await call('set_tokens', { fileId, tokens: [{ name: '--color-accent', value: '#1F7A5C' }, { name: '--color-ink', value: 'var(--color-text)' }, { name: '--nope', delete: true }] });
await call('export', { fileId, nodes: { [ab.id]: [{ format: 'png', scale: '1x' }, { format: 'pdf', scale: '1x' }, { format: 'svg', scale: '1x' }] } });
await call('export_combined_pdf', { fileId, nodeIds: [ab.id, dup.duplicatedNodes[1].newId] });
await call('export', { fileId, type: 'video', nodes: { [ab.id]: [] } }, { expectError: true });
await call('get_screenshot', { fileId, nodeId: ab.id, scale: 2 });
await call('finish_working_on_nodes', { fileId });
await client.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
