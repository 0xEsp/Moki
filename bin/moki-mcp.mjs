#!/usr/bin/env node
// Relay MCP stdio → HTTP para clientes que solo hablan stdio.
// Lee JSON-RPC (una línea por mensaje o batch) de stdin, lo reenvía a <MOKI_URL>/mcp y
// escribe cada mensaje de respuesta (JSON o SSE) como una línea en stdout.
// Variables: MOKI_URL (por defecto http://127.0.0.1:7410) y MOKI_TOKEN (Bearer, si el servidor lo exige).
import readline from 'node:readline';

const BASE = (process.env.MOKI_URL || 'http://127.0.0.1:7410').replace(/\/$/, '');
const ENDPOINT = `${BASE}/mcp`;
const TOKEN = (process.env.MOKI_TOKEN || '').trim();
let sessionId = null;
let chain = Promise.resolve();

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const log = (...a) => process.stderr.write(`[moki-mcp] ${a.join(' ')}\n`);

function errorFor(msg, text) {
  const list = Array.isArray(msg) ? msg : [msg];
  for (const m of list) {
    if (m && m.id !== undefined && m.id !== null && m.method) {
      write({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: text } });
    }
  }
}

function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* ignorar */
    }
  }
  return out;
}

async function forward(msg) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-moki-from': 'CLI',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let res;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(msg) });
  } catch {
    errorFor(msg, `Moki is not running at ${BASE}. Start it (docker compose up, or npm run dev) and retry.`);
    return;
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (res.status === 202 || res.status === 204) return;
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  let messages = [];
  if (type.includes('text/event-stream')) messages = parseSse(body);
  else if (body.trim()) {
    try {
      const parsed = JSON.parse(body);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      errorFor(msg, `Unexpected response from Moki (${res.status})`);
      return;
    }
  }
  if (messages.length === 0 && !res.ok) {
    errorFor(msg, `Moki returned HTTP ${res.status}`);
    return;
  }
  for (const m of messages) write(m);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    log('línea no JSON ignorada');
    return;
  }
  chain = chain.then(() => forward(msg)).catch((e) => log(String(e)));
});
rl.on('close', () => {
  void chain.then(async () => {
    if (sessionId) {
      await fetch(ENDPOINT, { method: 'DELETE', headers: { 'mcp-session-id': sessionId, 'x-moki-from': 'CLI' } }).catch(() => {});
    }
    process.exit(0);
  });
});
