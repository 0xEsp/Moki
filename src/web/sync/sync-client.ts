import { MessageType, type ClientKind, type ClientMessage, type RpcMethod, type RpcMethods, type ServerMessage } from '../../core/protocol';
import type { Edit, MokiFile } from '../../core/types';

// Conexión de sync de un fichero. Reconexión con backoff, ping cada 15 s y RPC ordenado
// respecto a las ediciones (va por el mismo socket).
//
// Mejora sobre el comportamiento "recargar si difiere": mientras está desconectado, las
// ediciones locales se encolan; al reconectar se aplica el snapshot del servidor y se
// reenvían encima (rebase simple, último-que-escribe-gana).

type Handler = (msg: ServerMessage) => void;

export interface SyncClientOptions {
  fileId: string;
  kind: ClientKind;
  /** Base http(s) del servidor; por defecto el origen actual. */
  origin?: string;
}

export type SyncStatus = 'connecting' | 'connected' | 'disconnected' | 'not_found' | 'error';

export class SyncClient {
  readonly fileId: string;
  readonly kind: ClientKind;
  readonly tabId = Math.random().toString(36).slice(2, 10);
  status: SyncStatus = 'connecting';
  clientId: string | null = null;
  clientIndex = 0;

  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(s: SyncStatus) => void>();
  private queue: Edit[] = [];
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private rpcSeq = 0;
  private rpcPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private origin: string;

  constructor(opts: SyncClientOptions) {
    this.fileId = opts.fileId;
    this.kind = opts.kind;
    this.origin = opts.origin ?? window.location.origin;
  }

  connect() {
    this.closedByUser = false;
    const url = new URL(`/sync/${encodeURIComponent(this.fileId)}`, this.origin);
    url.protocol = url.protocol.replace('http', 'ws');
    url.searchParams.set('kind', this.kind);
    url.searchParams.set('tabId', this.tabId);
    this.setStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.startPing();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      this.stopPing();
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, p] of this.rpcPending) p.reject(new Error('Connection lost'));
      this.rpcPending.clear();
      if (ev.code === 4404) return this.setStatus('not_found');
      if (this.closedByUser) return this.setStatus('disconnected');
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose se encarga */
    };
  }

  close() {
    this.closedByUser = true;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect() {
    this.attempts++;
    const delay = Math.min(this.attempts, 5) * 1000 + Math.random() * 500;
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ $t: MessageType.Ping });
      this.pongTimer = setTimeout(() => this.ws?.close(), 5000);
    }, 15000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.$t) {
      case MessageType.Pong:
        if (this.pongTimer) clearTimeout(this.pongTimer);
        return;
      case MessageType.FilePayload:
        this.clientId = msg.clientId;
        this.clientIndex = msg.clientIndex;
        this.setStatus('connected');
        break;
      case MessageType.FileLoadFailed:
        this.setStatus(msg.reason === 'not_found' ? 'not_found' : 'error');
        break;
      case MessageType.RpcResponse: {
        const p = this.rpcPending.get(msg.rpcId);
        if (p) {
          this.rpcPending.delete(msg.rpcId);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
        return;
      }
    }
    for (const h of this.handlers) h(msg);
    if (msg.$t === MessageType.FilePayload) this.flushQueue();
  }

  /** Suscribe a todos los mensajes del servidor. */
  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onStatus(h: (s: SyncStatus) => void): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  private setStatus(s: SyncStatus) {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  get connected() {
    return this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Envía un lote de ediciones locales (o lo encola si no hay conexión). */
  sendEdits(edits: Edit[]) {
    if (edits.length === 0) return;
    if (!this.connected) {
      this.queue.push(...edits);
      return;
    }
    // Trocear lotes enormes (> 4 MiB).
    const json = JSON.stringify(edits);
    if (json.length > 4 * 1024 * 1024 && edits.length > 1) {
      const mid = Math.floor(edits.length / 2);
      this.sendEdits(edits.slice(0, mid));
      this.sendEdits(edits.slice(mid));
      return;
    }
    this.send({ $t: MessageType.FileEditBatch, fileId: this.fileId, edits });
  }

  /** Ediciones encoladas mientras no había conexión (el llamante las re-aplica tras el snapshot). */
  takeQueued(): Edit[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  private flushQueue() {
    /* El dueño del DocStore decide cuándo reenviar (tras aplicar el snapshot). */
  }

  rpc<M extends RpcMethod>(method: M, params: RpcMethods[M]['params'], timeoutMs = 120_000): Promise<RpcMethods[M]['result']> {
    const rpcId = `${this.tabId}-${++this.rpcSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.send({ $t: MessageType.RpcRequest, rpcId, method, params })) {
        reject(new Error('Not connected to the Moki server'));
        return;
      }
      const timer = setTimeout(() => {
        this.rpcPending.delete(rpcId);
        reject(new Error(`RPC ${method} timed out`));
      }, timeoutMs);
      this.rpcPending.set(rpcId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as RpcMethods[M]['result']);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}

export type { MokiFile };
