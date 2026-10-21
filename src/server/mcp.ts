import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ULID_RE } from '../core/ids';
import { guideText } from '../core/mcp/guides';
import { MCP_INSTRUCTIONS } from '../core/mcp/instructions';
import { TOOL_BY_NAME, TOOL_DEFS, schemaWithFileId, toolJsonSchema } from '../core/mcp/tools';
import type { ToolCallContext, ToolResult } from '../core/runtime';
import { createHostMatcher, isAuthorized } from './auth';
import { config } from './config';
import { runtimes } from './runtime';
import { store } from './store';
import { hub } from './sync';

// Servidor MCP (Streamable HTTP) en /mcp. Una sesión por agente (cabecera mcp-session-id).
// Las herramientas de scope "app" se resuelven aquí; las de fichero se delegan al runtime.

interface Session {
  id: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
  viaCli: boolean;
}

const sessions = new Map<string, Session>();

export function mcpTools() {
  return TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: toolJsonSchema(d), annotations: d.annotations }));
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });
const data = (d: unknown): ToolResult => text(typeof d === 'string' ? d : JSON.stringify(d, null, 2));

class UserError extends Error {}

/** Extrae el id de fichero (y página) de un id, ruta /file/<id>[/<pageId>] o URL. */
export function parseFileRef(ref: string): { fileId: string; pageId?: string } | null {
  const s = ref.trim();
  if (ULID_RE.test(s)) return { fileId: s.toUpperCase() };
  let p = s;
  try {
    if (/^[a-z]+:\/\//i.test(s)) p = new URL(s).pathname;
  } catch {
    /* no es URL */
  }
  const m = /\/file\/([0-9A-Za-z]{26})(?:\/([^/?#]+))?/.exec(p);
  if (m && ULID_RE.test(m[1]!)) return { fileId: m[1]!.toUpperCase(), ...(m[2] ? { pageId: decodeURIComponent(m[2]) } : {}) };
  return null;
}

function resolveFileId(raw: unknown): string {
  const ref = parseFileRef(String(raw ?? ''));
  if (!ref) throw new UserError(`Could not parse a file ID from "${String(raw)}".`);
  if (!store.exists(ref.fileId)) throw new UserError(`File not found: ${ref.fileId}`);
  return ref.fileId;
}

// ------------------------------------------------------------------------------ herramientas app

async function appTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
  switch (name) {
    case 'get_guide':
      return text(guideText(String(args.topic ?? '')));
    case 'open_file': {
      const ref = parseFileRef(String(args.fileId));
      if (!ref) throw new UserError(`Could not parse a file ID from "${String(args.fileId)}".`);
      if (!store.exists(ref.fileId)) throw new UserError(`File not found: ${ref.fileId}`);
      const pageId = (args.pageId as string | undefined) ?? ref.pageId;
      return runtimes.call(ref.fileId, ctx, 'get_basic_info', { fileId: ref.fileId, ...(pageId ? { pageId } : {}) });
    }
    case 'list_resources': {
      const limit = (args.limit as number | undefined) ?? 50;
      const open = hub.openFiles();
      const focused = open[0]?.fileId;
      const folders = store.listFolders();
      const files = store.listFiles();
      type Res = { id: string; name: string; type: 'file' | 'folder'; parentId?: string; updatedAt?: number; createdAt?: number; open?: boolean; active?: boolean };
      const folderIds = new Set(folders.map((f) => f.id));
      const fileRes = (f: (typeof files)[number], extra: Partial<Res> = {}): Res => ({
        id: f.id,
        name: f.name,
        type: 'file',
        ...(f.folderId && folderIds.has(f.folderId) ? { parentId: f.folderId } : {}),
        updatedAt: f.updatedAt,
        createdAt: f.createdAt,
        ...extra,
      });
      const byId = new Map(files.map((f) => [f.id, f]));
      const out: Res[] = [];
      const seen = new Set<string>();
      for (const o of open) {
        const f = byId.get(o.fileId);
        if (!f) continue;
        out.push(fileRes(f, { open: true, ...(o.fileId === focused ? { active: true } : {}) }));
        seen.add(f.id);
      }
      const rest: Res[] = [
        ...files.filter((f) => !seen.has(f.id)).map((f) => fileRes(f)),
        ...folders.map((f) => ({
          id: f.id,
          name: f.name,
          type: 'folder' as const,
          ...(f.parentId && folderIds.has(f.parentId) ? { parentId: f.parentId } : {}),
          updatedAt: f.updatedAt,
          createdAt: f.createdAt,
        })),
      ].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      out.push(...rest);
      const count = out.length;
      const resources = out.slice(0, limit);
      return data({
        teamId: 'local',
        teamName: 'Moki (local)',
        resources,
        count,
        ...(count > limit ? { truncated: true, truncatedMessage: `Showing ${limit} of ${count} resources. Pass a higher limit (max 200) to see more.` } : {}),
      });
    }
    case 'create_file': {
      let file;
      try {
        file = store.create({ name: (args.name as string | undefined)?.trim() || undefined, cloneFileId: args.cloneFileId as string | undefined });
      } catch (e) {
        throw new UserError(e instanceof Error ? e.message : String(e));
      }
      return data({ fileId: file.id, url: `${config.publicOrigin}/file/${file.id}` });
    }
    case 'rename_resource': {
      const id = String(args.resourceId);
      const name = String(args.name ?? '').trim().slice(0, 500);
      if (store.exists(id)) {
        const rec = store.get(id)!;
        if (name) hub.renameFile(id, name);
        return data({ resourceId: id, name: rec.file.name, type: 'file' });
      }
      const folder = store.listFolders().find((f) => f.id === id);
      if (!folder) return data({ error: 'Resource not found' });
      const updated = name ? store.updateFolder(id, { name }) : folder;
      return data({ resourceId: id, name: updated?.name ?? folder.name, type: 'folder' });
    }
  }
  return text(`Unknown tool: ${name}`, true);
}

async function callTool(session: Session, name: string, rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
  const def = TOOL_BY_NAME.get(name);
  if (!def) return text(`Unknown tool: ${name}`, true);
  const parsed = schemaWithFileId(def).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return text(
      `Invalid arguments for ${name}: ${issues}. Fix the arguments and retry once; if it keeps failing, ask the user to restart the Moki MCP connection to refresh the tool definitions.`,
      true,
    );
  }
  const args = parsed.data as Record<string, unknown>;
  const client = session.server.getClientVersion();
  const ctx: ToolCallContext = {
    sessionId: session.id,
    clientInfo: client ? { name: client.name, version: client.version } : null,
    transport: session.viaCli ? 'stdio' : 'http',
  };
  try {
    if (def.scope === 'app') return await appTool(name, args, ctx);
    let fileId: string;
    if (def.scope === 'file-optional-id' && (args.fileId === undefined || args.fileId === '')) {
      const focused = hub.focusedFileId();
      if (!focused) throw new UserError('No Moki file is open in the browser. Pass fileId (see list_resources) or call open_file.');
      fileId = focused;
    } else {
      fileId = resolveFileId(args.fileId);
    }
    return await runtimes.call(fileId, ctx, name, { ...args, fileId });
  } catch (e) {
    if (e instanceof UserError) return text(e.message, true);
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

// ------------------------------------------------------------------------------ sesiones

function createSession(id: string | null, initialized: boolean): Session {
  const server = new Server({ name: 'moki', version: config.version }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  let session!: Session;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id ?? randomUUID(),
    onsessioninitialized: (sid) => {
      session.id = sid;
      sessions.set(sid, session);
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
      void runtimes.removeAgent(sid);
    },
  });
  session = { id: id ?? '', server, transport, viaCli: false };
  if (initialized && id) {
    // "Resucitar" una sesión desconocida (p. ej. tras reiniciar el servidor): la damos por
    // inicializada con el mismo id que manda el cliente.
    const inner = (transport as unknown as { _webStandardTransport: { sessionId?: string; _initialized: boolean } })._webStandardTransport;
    inner.sessionId = id;
    inner._initialized = true;
    sessions.set(id, session);
  }
  transport.onclose = () => {
    if (session.id && sessions.get(session.id) === session) sessions.delete(session.id);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const started = Date.now();
    const { name, arguments: args } = req.params;
    const result = await callTool(session, name, args as Record<string, unknown> | undefined);
    const ms = Date.now() - started;
    const err = result.isError ? ` ERROR: ${result.content.find((c) => c.type === 'text')?.text?.slice(0, 160) ?? ''}` : '';
    console.log(`[mcp] ${name} ${ms}ms${err}`);
    return result as unknown as Record<string, unknown> & { content: [] };
  });
  void server.connect(transport);
  return session;
}

// ------------------------------------------------------------------------------ HTTP

export const hostAllowed = createHostMatcher(config.allowedHosts);

function empty(res: ServerResponse, status: number) {
  res.writeHead(status, { 'content-length': '0' });
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Fuerza el Accept que exige el transporte (algunos clientes no lo mandan). */
function fixAccept(req: IncomingMessage) {
  const acc = String(req.headers.accept ?? '');
  if (acc.includes('application/json') && acc.includes('text/event-stream')) return;
  const value = 'application/json, text/event-stream';
  req.headers.accept = value;
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) if (raw[i]!.toLowerCase() === 'accept') raw.splice(i, 2);
  raw.push('Accept', value);
}

const isInitialize = (body: unknown) =>
  Array.isArray(body) ? body.some((m) => m?.method === 'initialize') : (body as { method?: string })?.method === 'initialize';

/** Devuelve true si atendió la petición. */
export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (/^\/\.well-known\/(oauth-|openid-configuration)/.test(pathname) || /^\/mcp\/\.well-known\//.test(pathname)) {
    empty(res, 404);
    return true;
  }
  if (pathname !== '/mcp' && pathname !== '/mcp/' && pathname !== '/mcp/config.json') return false;

  if (req.method === 'OPTIONS' || req.headers.origin) {
    empty(res, 403);
    return true;
  }
  if (!hostAllowed(req.headers.host)) {
    empty(res, 403);
    return true;
  }
  // Con MOKI_TOKEN: Bearer obligatorio. 401 sin cuerpo ni campos OAuth (para que el cliente
  // no intente un flujo OAuth: el token se configura como cabecera en el cliente MCP).
  if (!isAuthorized(req, { token: config.token, bearer: true })) {
    empty(res, 401);
    return true;
  }
  if (pathname === '/mcp/config.json') {
    if (req.method !== 'GET') return empty(res, 405), true;
    const body = JSON.stringify({ tools: mcpTools(), instructions: MCP_INSTRUCTIONS });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return true;
  }

  fixAccept(req);
  const viaCli = String(req.headers['x-moki-from'] ?? '').toUpperCase() === 'CLI';
  const sid = req.headers['mcp-session-id'] as string | undefined;

  if (req.method === 'GET' || req.method === 'DELETE') {
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) {
      if (req.method === 'DELETE' && sid) void runtimes.removeAgent(sid);
      empty(res, 404);
      return true;
    }
    await s.transport.handleRequest(req, res);
    if (req.method === 'DELETE') {
      sessions.delete(s.id);
      void runtimes.removeAgent(s.id);
    }
    return true;
  }
  if (req.method !== 'POST') {
    empty(res, 405);
    return true;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return true;
  }

  let s = sid ? sessions.get(sid) : undefined;
  if (!s) {
    if (isInitialize(body)) s = createSession(null, false);
    else {
      const id = sid ?? randomUUID();
      s = createSession(id, true);
      if (!sid) {
        // Sin cabecera: el transporte exige la sesión; la inyectamos.
        req.headers['mcp-session-id'] = id;
        req.rawHeaders.push('mcp-session-id', id);
      }
    }
  }
  s.viaCli = viaCli;
  await s.transport.handleRequest(req, res, body);
  return true;
}

export async function closeMcp() {
  for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
  sessions.clear();
}
