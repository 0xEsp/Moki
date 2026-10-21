// Prueba de réplica: toma JSX exportado con `get_jsx` del MCP de Paper y reconstruye el flujo en
// Moki usando solo su MCP (como haría un agente): tokens → artboard → write_html → duplicate →
// write_html de las hojas → capturas.
//
// Uso: node scripts/replicate-paper-flow.mjs <port> <dir con tokens.css, login.jsx, sheets.jsx>
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [port = '7410', dir = '.'] = process.argv.slice(2);
const headers = process.env.MOKI_TOKEN ? { Authorization: `Bearer ${process.env.MOKI_TOKEN}` } : {};

// ---------------------------------------------------------------- JSX → HTML
const kebab = (s) => s.replace(/^(Webkit|Moz|ms)/, (m) => `-${m.toLowerCase()}`).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
function jsxToHtml(jsx) {
  let html = jsx.replace(/style=\{\{([\s\S]*?)\}\}/g, (_, body) => {
    const obj = Function(`return {${body}}`)();
    const css = Object.entries(obj).map(([k, v]) => `${kebab(k)}: ${String(v).replace(/"/g, "'")}`).join('; ');
    return `style="${css}"`;
  });
  html = html.replace(/\s(fillRule|clipRule|clipPath|strokeWidth|strokeLinecap|strokeLinejoin)=/g, (_, a) => ` ${kebab(a)}=`);
  return html.trim();
}
/** Separa el div raíz (sus estilos) de sus hijos. */
function splitRoot(html) {
  const m = /^<div style="([^"]*)">([\s\S]*)<\/div>$/.exec(html.trim());
  if (!m) throw new Error('raíz inesperada');
  const styles = {};
  for (const decl of m[1].split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    styles[k] = decl.slice(i + 1).trim();
  }
  return { styles, children: m[2] };
}

const TYPE_BY_PREFIX = [
  ['--color-', 'color'], ['--font-weight-', 'fontWeight'], ['--font-', 'fontFamily'], ['--text-', 'fontSize'],
  ['--tracking-', 'letterSpacing'], ['--leading-', 'lineHeight'], ['--opacity-', 'opacity'],
  ['--breakpoint-', 'breakpoint'], ['--container-', 'container'], ['--spacing-', 'spacing'], ['--radius-', 'radius'],
];

// ---------------------------------------------------------------- MCP
const client = new Client({ name: 'replica-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${process.env.MOKI_URL ?? `http://localhost:${port}`}/mcp`), { requestInit: { headers } }));
const out = path.join(dir, 'out');
fs.mkdirSync(out, { recursive: true });
let failures = 0;

async function call(name, args, { expectError = false } = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const data = texts.length > 1 ? texts[texts.length - 1] : texts[0];
  const ms = Date.now() - t;
  if (r.isError && !expectError) {
    failures++;
    console.log(`✗ ${name} (${ms} ms): ${data}`);
  } else console.log(`✓ ${name} (${ms} ms)`);
  for (const c of r.content) {
    if (c.type === 'image') {
      const f = path.join(out, `${args.nodeId}-${Date.now()}.jpg`);
      fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
      console.log(`   imagen → ${f}`);
    }
  }
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

const created = await call('create_file', { name: process.env.MOKI_REPLICA_NAME ?? 'Réplica desde Paper' });
const fileId = created.fileId;
await call('get_guide', { topic: 'moki-mcp-instructions' });
const info = await call('open_file', { fileId });
const pageId = info.pageId;
await call('update_pages', { fileId, updates: [{ pageId, name: '10 · Mobile · Access' }] });

// Tokens
const tokens = [];
for (const line of fs.readFileSync(path.join(dir, 'tokens.css'), 'utf8').split('\n')) {
  const m = /^(--[a-zA-Z0-9-]+):\s*(.+);$/.exec(line.trim());
  if (!m) continue;
  const type = TYPE_BY_PREFIX.find(([p]) => m[1].startsWith(p))?.[1];
  if (type) tokens.push({ type, name: m[1], value: m[2] });
}
// Los alias (var(--x)) deben ir después de su destino.
tokens.sort((a, b) => Number(a.value.startsWith('var(')) - Number(b.value.startsWith('var(')));
const tk = await call('create_tokens', { fileId, tokens });
const tokenErrors = (tk.tokens ?? []).filter((t) => t.result === 'error');
console.log(`   tokens: ${tk.count} procesados, ${tokenErrors.length} errores`, tokenErrors.slice(0, 3));

await call('get_font_family_info', { fileId, familyNames: ['Source Sans 3', 'Montserrat', 'Helvetica Neue'] });

// Login
const login = splitRoot(jsxToHtml(fs.readFileSync(path.join(dir, 'login.jsx'), 'utf8')));
const ab = await call('create_artboard', { fileId, pageId, name: 'Access · Login · iOS', styles: { ...login.styles, width: '393px', height: '852px' } });
const loginId = ab.id;
// Igual que pide la guía: piezas pequeñas. Barra de estado y hoja por separado.
const parts = login.children.split(/\n      <div style="background-color: var\(--color-background\)/);
const w1 = await call('write_html', { fileId, targetNodeId: loginId, mode: 'insert-children', html: parts[0] });
const w2 = await call('write_html', { fileId, targetNodeId: loginId, mode: 'insert-children', html: `<div style="background-color: var(--color-background)${parts[1]}` });
console.log(`   nodos creados: ${(w1.createdNodes?.length ?? 0) + (w2.createdNodes?.length ?? 0)}`);
await call('get_screenshot', { fileId, nodeId: loginId });

// Las otras pantallas: duplicar + hoja encima.
const sheets = {};
let cur = null;
for (const line of fs.readFileSync(path.join(dir, 'sheets.jsx'), 'utf8').split('\n')) {
  const m = /^=== (\w+)/.exec(line);
  if (m) sheets[(cur = m[1])] = [];
  else if (cur) sheets[cur].push(line);
}
const names = { forgot: 'Access · Forgot password · iOS', sent: 'Access · Reset link sent · iOS', guest: 'Access · Guest notice · iOS' };
const ids = { login: loginId };
for (const [key, lines] of Object.entries(sheets)) {
  const dup = await call('duplicate_nodes', { fileId, nodes: [{ id: loginId }] });
  const id = dup.duplicatedNodes[0].newId;
  ids[key] = id;
  await call('rename_nodes', { fileId, updates: [{ nodeId: id, name: names[key] }] });
  await call('update_styles', { fileId, updates: [{ nodeIds: [id], styles: { position: 'relative' } }] });
  await call('write_html', { fileId, targetNodeId: id, mode: 'insert-children', html: jsxToHtml(lines.join('\n')) });
  await call('get_screenshot', { fileId, nodeId: id });
}

const tree = await call('get_tree_summary', { fileId, nodeId: ids.sent, depth: 4 });
console.log(typeof tree === 'object' ? tree.summary : tree);
const basic = await call('get_basic_info', { fileId, pageId });
console.log(`   artboards: ${basic.artboards.map((a) => `${a.name} ${a.width}×${a.height} @${a.worldX},${a.worldY}`).join(' | ')}`);
const found = await call('find_nodes', { fileId, filters: [{ styleName: 'backgroundColor', styleValue: '#685EF7' }] });
console.log(`   nodos con --color-primary (#685EF7) de fondo: ${found.count}`);
await call('finish_working_on_nodes', { fileId });
console.log(`\nfileId=${fileId}\nFAILURES: ${failures}`);
await client.close();
