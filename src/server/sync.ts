import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { applyEdits } from '../core/edits';
import {
  Focus,
  MessageType,
  type ClientKind,
  type ClientMessage,
  type PresenceUser,
  type RpcMethod,
  type ServerMessage,
} from '../core/protocol';
import { LOCAL_USER, type CommentThread, type Edit, type MokiFile } from '../core/types';
import { store } from './store';

// Hub de sync: una "sala" por fichero. El servidor guarda el documento autoritativo en
// memoria, aplica cada FileEditBatch en orden de llegada (último-que-escribe-gana por ruta)
// y lo reenvía al resto de clientes. También retransmite presencia y gestiona comentarios y RPC.

export interface SyncClientConn {
  ws: WebSocket;
  fileId: string;
  clientId: string;
  clientIndex: number;
  kind: ClientKind;
  tabId: string;
  presence: PresenceUser;
}

export type RpcHandler = (ctx: { fileId: string; client: SyncClientConn }, method: RpcMethod, params: unknown) => Promise<unknown>;

const UNLOAD_AFTER_MS = 60_000;

class Room {
  clients = new Map<string, SyncClientConn>();
  unloadTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly fileId: string) {}

  get file(): MokiFile {
    const rec = store.get(this.fileId);
    if (!rec) throw new Error('File not found');
    return rec.file;
  }

  send(c: SyncClientConn, msg: ServerMessage) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage, except?: SyncClientConn) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c !== except && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

let seq = 0;

export class SyncHub {
  private rooms = new Map<string, Room>();
  // Compresión por mensaje solo para los grandes (el fichero entero al abrir: ~10× menos por la
  // red); las ediciones pequeñas van sin comprimir para no gastar CPU en cada tecla.
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
    perMessageDeflate: { threshold: 64 * 1024, zlibDeflateOptions: { level: 3 } },
  });
  private rpcHandler: RpcHandler | null = null;
  /** Escuchas de cambios de presencia (para el MCP: ficheros abiertos, foco). */
  private listeners = new Set<() => void>();

  setRpcHandler(h: RpcHandler) {
    this.rpcHandler = h;
  }

  onPresenceChange(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  /** Atiende el upgrade HTTP → WS para /sync/<fileId>. */
  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^\/sync\/([^/]+)$/.exec(url.pathname);
    if (!m) {
      socket.destroy();
      return;
    }
    const fileId = decodeURIComponent(m[1]!);
    const kind: ClientKind = url.searchParams.get('kind') === 'runtime' ? 'runtime' : 'human';
    const tabId = url.searchParams.get('tabId') ?? '';
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, fileId, kind, tabId));
  }

  private room(fileId: string): Room {
    let r = this.rooms.get(fileId);
    if (!r) this.rooms.set(fileId, (r = new Room(fileId)));
    if (r.unloadTimer) {
      clearTimeout(r.unloadTimer);
      r.unloadTimer = null;
    }
    return r;
  }

  private onConnection(ws: WebSocket, fileId: string, kind: ClientKind, tabId: string) {
    const rec = store.get(fileId);
    if (!rec) {
      ws.send(JSON.stringify({ $t: MessageType.FileLoadFailed, reason: 'not_found' } satisfies ServerMessage));
      ws.close(4404, 'File not found');
      return;
    }
    const room = this.room(fileId);
    const clientIndex = store.nextClientIndex(fileId);
    const clientId = `c${Date.now().toString(36)}${(++seq).toString(36)}`;
    const now = Date.now();
    const presence: PresenceUser = {
      clientId,
      clientIndex,
      kind,
      userId: kind === 'human' ? LOCAL_USER.id : 'moki-agent',
      name: kind === 'human' ? LOCAL_USER.name : 'Moki agent',
      pageId: null,
      selectedNodes: [],
      cameraView: null,
      focus: kind === 'human' ? Focus.Canvas : Focus.Blurred,
      lastActiveAt: kind === 'human' ? now : 0,
      agents: [],
    };
    const conn: SyncClientConn = { ws, fileId, clientId, clientIndex, kind, tabId, presence };

    room.send(conn, { $t: MessageType.FilePayload, file: rec.file, clientId, clientIndex, accessLevel: 'edit' });
    room.send(conn, { $t: MessageType.UsersAlreadyInFile, users: [...room.clients.values()].map((c) => c.presence) });
    room.send(conn, { $t: MessageType.CommentThreadsInitialPayload, threads: this.visibleThreads(fileId) });
    room.clients.set(clientId, conn);
    room.broadcast({ $t: MessageType.UserJoinedFile, user: presence }, conn);
    this.notify();

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        this.onMessage(room, conn, msg);
      } catch (e) {
        console.error('[sync] error procesando mensaje', e);
      }
    });
    ws.on('close', () => {
      room.clients.delete(clientId);
      room.broadcast({ $t: MessageType.UserLeftFile, clientId });
      this.notify();
      if (room.clients.size === 0) {
        room.unloadTimer = setTimeout(() => {
          if (room.clients.size > 0) return;
          this.rooms.delete(fileId);
          if (store.exists(fileId)) store.unload(fileId);
        }, UNLOAD_AFTER_MS);
      }
    });
  }

  private markActive(conn: SyncClientConn, room: Room) {
    if (conn.kind !== 'human') return;
    conn.presence.lastActiveAt = Date.now();
    void room;
  }

  private onMessage(room: Room, conn: SyncClientConn, msg: ClientMessage) {
    const { clientId } = conn;
    switch (msg.$t) {
      case MessageType.Ping:
        room.send(conn, { $t: MessageType.Pong });
        return;
      case MessageType.FileEditBatch: {
        if (!Array.isArray(msg.edits) || msg.edits.length === 0) return;
        this.applyEdits(room.fileId, msg.edits, conn);
        this.markActive(conn, room);
        return;
      }
      case MessageType.CursorMove:
        room.broadcast({ $t: MessageType.CursorMove, clientId, x: msg.x, y: msg.y }, conn);
        return;
      case MessageType.UserSelectNode:
        conn.presence.selectedNodes = msg.nodeIds;
        this.markActive(conn, room);
        room.broadcast({ $t: MessageType.UserSelectNode, clientId, nodeIds: msg.nodeIds }, conn);
        return;
      case MessageType.UserPageChange:
        conn.presence.pageId = msg.pageId;
        this.markActive(conn, room);
        room.broadcast({ $t: MessageType.UserPageChange, clientId, pageId: msg.pageId }, conn);
        this.notify();
        return;
      case MessageType.UserCameraChange:
        conn.presence.cameraView = msg.view;
        room.broadcast({ $t: MessageType.UserCameraChange, clientId, view: msg.view }, conn);
        return;
      case MessageType.UserFocusChange:
        conn.presence.focus = msg.focus;
        if (msg.focus !== Focus.Blurred) this.markActive(conn, room);
        room.broadcast(
          { $t: MessageType.UserFocusChange, clientId, focus: msg.focus, lastActiveAt: conn.presence.lastActiveAt ?? 0 },
          conn,
        );
        this.notify();
        return;
      case MessageType.UserAgentsChange:
        conn.presence.agents = msg.agents;
        room.broadcast({ $t: MessageType.UserAgentsChange, clientId, agents: msg.agents }, conn);
        return;
      case MessageType.CommentThreadCreate:
      case MessageType.CommentThreadUpdate:
      case MessageType.CommentThreadDelete:
      case MessageType.CommentMessageCreate:
      case MessageType.CommentMessageUpdate:
      case MessageType.CommentMessageDelete:
        this.onComment(room, conn, msg);
        return;
      case MessageType.RpcRequest:
        void this.onRpc(room, conn, msg.rpcId, msg.method, msg.params);
        return;
    }
  }

  /** Aplica ediciones al documento autoritativo y las difunde (excepto al emisor). */
  applyEdits(fileId: string, edits: Edit[], from?: SyncClientConn) {
    const rec = store.get(fileId);
    if (!rec) return;
    applyEdits(rec.file as unknown as Record<string, unknown>, edits);
    store.touch(fileId);
    const room = this.rooms.get(fileId);
    if (!room) return;
    room.broadcast({ $t: MessageType.FileEditBatch, fileId, edits, clientId: from?.clientId ?? 'server' }, from);
    if (edits.some((e) => e.path === '/name')) room.broadcast({ $t: MessageType.FileMetaChange, name: rec.file.name });
  }

  /** Cambia el nombre de un fichero (dashboard / MCP) propagándolo como edición. */
  renameFile(fileId: string, name: string) {
    this.applyEdits(fileId, [{ path: '/name', type: 'update', value: name }]);
  }

  // ------------------------------------------------------------------ comentarios

  private visibleThreads(fileId: string): CommentThread[] {
    return store.getComments(fileId).filter((t) => !t.deletedAt);
  }

  private onComment(room: Room, conn: SyncClientConn, msg: ClientMessage) {
    const threads = store.getComments(room.fileId);
    const now = Date.now();
    let changed: CommentThread | undefined;
    let deletedId: string | null = null;
    switch (msg.$t) {
      case MessageType.CommentThreadCreate: {
        const t = { ...msg.thread, fileId: room.fileId, createdAt: msg.thread.createdAt ?? now, updatedAt: now };
        const i = threads.findIndex((x) => x.id === t.id);
        if (i >= 0) threads[i] = t;
        else threads.push(t);
        changed = t;
        break;
      }
      case MessageType.CommentThreadUpdate: {
        const t = threads.find((x) => x.id === msg.threadId);
        if (!t) break;
        if (msg.status) t.status = msg.status;
        if (msg.position) Object.assign(t, msg.position);
        t.updatedAt = now;
        changed = t;
        break;
      }
      case MessageType.CommentThreadDelete: {
        const t = threads.find((x) => x.id === msg.threadId);
        if (!t) break;
        t.deletedAt = now;
        deletedId = t.id;
        break;
      }
      case MessageType.CommentMessageCreate: {
        const t = threads.find((x) => x.id === msg.threadId);
        if (!t) break;
        t.messages.push({ ...msg.message, createdAt: msg.message.createdAt ?? now, updatedAt: now });
        t.updatedAt = now;
        changed = t;
        break;
      }
      case MessageType.CommentMessageUpdate: {
        const t = threads.find((x) => x.id === msg.threadId);
        const m = t?.messages.find((x) => x.id === msg.messageId);
        if (!t || !m) break;
        m.text = msg.text;
        m.updatedAt = t.updatedAt = now;
        changed = t;
        break;
      }
      case MessageType.CommentMessageDelete: {
        const t = threads.find((x) => x.id === msg.threadId);
        const m = t?.messages.find((x) => x.id === msg.messageId);
        if (!t || !m) break;
        m.deletedAt = now;
        t.updatedAt = now;
        changed = t;
        break;
      }
    }
    if (changed) {
      store.saveComments(room.fileId);
      room.broadcast({ $t: MessageType.CommentThreadPayload, threadId: changed.id, thread: changed });
    } else if (deletedId) {
      store.saveComments(room.fileId);
      room.broadcast({ $t: MessageType.CommentThreadPayload, threadId: deletedId, thread: null });
    } else if ('threadId' in msg) {
      // Rechazado: rollback en el emisor.
      const t = threads.find((x) => x.id === msg.threadId && !x.deletedAt) ?? null;
      room.send(conn, { $t: MessageType.CommentThreadPayload, threadId: msg.threadId, thread: t });
    }
  }

  // ------------------------------------------------------------------ RPC

  private async onRpc(room: Room, conn: SyncClientConn, rpcId: string, method: RpcMethod, params: unknown) {
    try {
      if (!this.rpcHandler) throw new Error('RPC not available');
      const result = await this.rpcHandler({ fileId: room.fileId, client: conn }, method, params);
      room.send(conn, { $t: MessageType.RpcResponse, rpcId, result });
    } catch (e) {
      room.send(conn, { $t: MessageType.RpcResponse, rpcId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ------------------------------------------------------------------ consultas (MCP, API)

  /** Ficheros con al menos una pestaña humana abierta. */
  openFiles(): { fileId: string; lastActiveAt: number }[] {
    const out: { fileId: string; lastActiveAt: number }[] = [];
    for (const [fileId, room] of this.rooms) {
      let best = -1;
      for (const c of room.clients.values()) if (c.kind === 'human') best = Math.max(best, c.presence.lastActiveAt ?? 0);
      if (best >= 0) out.push({ fileId, lastActiveAt: best });
    }
    return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** Fichero que el usuario está mirando (la pestaña humana activa más reciente). */
  focusedFileId(): string | null {
    return this.openFiles()[0]?.fileId ?? null;
  }

  /** Página que el usuario está viendo en un fichero, si se conoce. */
  userPageId(fileId: string): string | null {
    const room = this.rooms.get(fileId);
    if (!room) return null;
    let best: SyncClientConn | null = null;
    for (const c of room.clients.values()) {
      if (c.kind !== 'human') continue;
      if (!best || (c.presence.lastActiveAt ?? 0) > (best.presence.lastActiveAt ?? 0)) best = c;
    }
    return best?.presence.pageId ?? null;
  }

  /** Cierra todas las conexiones de un fichero (borrado). */
  closeFile(fileId: string) {
    const room = this.rooms.get(fileId);
    if (!room) return;
    for (const c of room.clients.values()) c.ws.close(4404, 'File deleted');
    this.rooms.delete(fileId);
  }

  closeAll() {
    for (const room of this.rooms.values()) for (const c of room.clients.values()) c.ws.close(1001, 'Server shutting down');
    this.wss.close();
  }
}

export const hub = new SyncHub();
