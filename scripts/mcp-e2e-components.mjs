// E2E de componentes vía MCP: main → instancias → overrides → editar main → detach → export.
// Uso: node scripts/mcp-e2e-components.mjs <port> <outDir>   (MOKI_TOKEN opcional)
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [port = '7410', outDir = '.'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const headers = process.env.MOKI_TOKEN ? { Authorization: `Bearer ${process.env.MOKI_TOKEN}` } : {};
const client = new Client({ name: 'e2e-components', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${process.env.MOKI_URL ?? `http://localhost:${port}`}/mcp`), { requestInit: { headers } }));

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};
async function call(name, args, { expectError = false } = {}) {
  const r = await client.callTool({ name, arguments: args });
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const raw = texts.length > 1 ? texts[texts.length - 1] : texts[0];
  for (const c of r.content) {
    if (c.type === 'image') {
      const f = path.join(outDir, `${name}-${Date.now()}.jpg`);
      fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
      console.log(`  imagen → ${f}`);
    }
  }
  if (!!r.isError !== expectError) {
    failures++;
    console.log(`✗ ${name}: ${raw}`);
  } else console.log(`✓ ${name}${expectError ? ' (error esperado)' : ''}`);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const tools = await client.listTools();
for (const t of ['create_component', 'create_instance', 'list_components', 'detach_instance', 'reset_overrides']) {
  check(tools.tools.some((x) => x.name === t), `tools/list incluye ${t}`);
}

const { fileId } = await call('create_file', { name: 'E2E componentes' });
const info = await call('open_file', { fileId });
const root = info.rootNodeId;

// Página de componentes + botón main.
const comps = await call('create_artboard', { fileId, name: 'Components', styles: { width: '400px', height: '200px', backgroundColor: '#F4F4F5', padding: '24px' } });
const w = await call('write_html', {
  fileId,
  targetNodeId: comps.id,
  mode: 'insert-children',
  html: `<div layer-name="Button" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;background:#685EF7;border-radius:8px;width:fit-content"><span layer-name="Label" style="font-family:Inter;font-size:15px;font-weight:600;color:#fff">Continuar</span></div>`,
});
const buttonId = w.createdNodes[0].id;
const comp = await call('create_component', { fileId, nodeId: buttonId, name: 'Button / Primary' });
check(comp.componentId === buttonId, 'create_component devuelve el id del main');

// Artboard con 3 instancias (una vía x-moki-instance).
const board = await call('create_artboard', { fileId, name: 'Screen', styles: { width: '375px', height: '400px', backgroundColor: '#fff', padding: '24px', gap: '16px' } });
const i1 = await call('create_instance', { fileId, componentId: buttonId, targetNodeId: board.id });
const i2 = await call('create_instance', { fileId, componentId: buttonId, targetNodeId: board.id });
const w3 = await call('write_html', { fileId, targetNodeId: board.id, mode: 'insert-children', html: `<x-moki-instance component-id="${buttonId}" layer-name="Cancel" style="align-self:stretch"></x-moki-instance>` });
const i3 = w3.createdNodes?.[0]?.id;
check(!!i3, 'write_html crea una instancia con <x-moki-instance>');
check(i1.childIds?.length === 1 && i1.childIds[0].includes('::'), 'la instancia expone hijos virtuales');

const tree = await call('get_tree_summary', { fileId, nodeId: board.id, depth: 3 });
check(String(tree.summary).includes('[instance of "Button / Primary"]'), 'tree summary marca las instancias');
const list = await call('list_components', { fileId });
check(list.components?.[0]?.instanceCount === 3, 'list_components cuenta 3 instancias');

// Overrides en la tercera instancia.
const label3 = `${i3}::${w.createdNodes.find((n) => n.name === 'Label')?.id ?? ''}`;
const kids3 = (await call('get_children', { fileId, nodeId: i3 })).children;
const labelVirtual = kids3[0].id;
await call('set_text_content', { fileId, updates: [{ nodeId: labelVirtual, textContent: 'Cancelar' }] });
await call('update_styles', { fileId, updates: [{ nodeIds: [i3], styles: { backgroundColor: '#E4E4E7' } }, { nodeIds: [labelVirtual], styles: { color: '#18181B' } }] });
void label3;

// Editar el main: radio y texto.
const mainLabel = (await call('get_children', { fileId, nodeId: buttonId })).children[0].id;
await call('update_styles', { fileId, updates: [{ nodeIds: [buttonId], styles: { borderRadius: '999px' } }] });
await call('set_text_content', { fileId, updates: [{ nodeId: mainLabel, textContent: 'Siguiente' }] });

const cs = await call('get_computed_styles', { fileId, nodeIds: [i1.id, i3, labelVirtual, `${i1.id}::${mainLabel}`] });
check(cs.styles[i1.id]?.borderRadius === '999px', 'el radio del main llega a la instancia 1');
check(cs.styles[i3]?.borderRadius === '999px' && cs.styles[i3]?.backgroundColor === '#E4E4E7', 'la instancia 3 hereda el radio y conserva su fondo');
check(cs.styles[labelVirtual]?.color === '#18181B', 'override de color en el hijo virtual');
const n1 = await call('get_node_info', { fileId, nodeId: `${i1.id}::${mainLabel}` });
const n3 = await call('get_node_info', { fileId, nodeId: labelVirtual });
check(n1.textContent === 'Siguiente', 'el texto del main llega a la instancia 1');
check(n3.textContent === 'Cancelar', 'la instancia 3 conserva su texto (override)');

// Errores de estructura.
await call('write_html', { fileId, targetNodeId: i1.id, mode: 'insert-children', html: '<div>x</div>' }, { expectError: true });
await call('create_instance', { fileId, componentId: buttonId, targetNodeId: buttonId }, { expectError: true });
const mv = await call('move_nodes', { fileId, moves: [{ nodeId: labelVirtual, parentId: board.id }] });
check(mv.errors?.length === 1, 'move_nodes rechaza mover un hijo virtual');

// JSX y captura.
const jsx = await call('get_jsx', { fileId, nodeId: board.id, includeNodeIds: false });
check(String(jsx).includes('Cancelar') && String(jsx).split('Siguiente').length === 3, 'get_jsx expande las instancias con overrides');
await call('get_screenshot', { fileId, nodeId: board.id, scale: 2 });

// Duplicar instancia, reset y detach.
const dup = await call('duplicate_nodes', { fileId, nodes: [{ id: i3 }] });
const dupInfo = await call('get_node_info', { fileId, nodeId: dup.duplicatedNodes[0].newId });
check(dupInfo.instanceOf === buttonId, 'duplicar una instancia da otra instancia');
await call('reset_overrides', { fileId, nodeId: dup.duplicatedNodes[0].newId });
const det = await call('detach_instance', { fileId, nodeId: i2.id });
check(Object.keys(det.descendantIdMap ?? {}).length === 1, 'detach devuelve el mapa de hijos');
const after = await call('get_node_info', { fileId, nodeId: i2.id });
check(!after.instanceOf && !String(after.childIds?.[0] ?? '').includes('::'), 'la instancia desvinculada tiene hijos reales');
await call('update_styles', { fileId, updates: [{ nodeIds: [buttonId], styles: { backgroundColor: '#16A34A' } }] });
const cs2 = await call('get_computed_styles', { fileId, nodeIds: [i1.id, i2.id] });
check(cs2.styles[i1.id]?.backgroundColor === '#16A34A' && cs2.styles[i2.id]?.backgroundColor !== '#16A34A', 'el main ya no afecta a la desvinculada');

await call('get_screenshot', { fileId, nodeId: board.id, scale: 2 });
const ex = await call('export', { fileId, nodes: { [board.id]: [{ format: 'png', scale: '2x' }] } });
check(ex.exports?.length === 1, 'export png del artboard con instancias');
await call('finish_working_on_nodes', { fileId });
console.log(`\nfileId=${fileId}\nFAILURES: ${failures}`);
await client.close();
process.exit(failures ? 1 : 0);
