import type { CommentThread, Edit, MokiFile } from './types';

// Protocolo WebSocket de sync: `ws://<host>/sync/<fileId>?kind=human|runtime&tabId=<id>`.
// Mensajes JSON con discriminador numérico en la clave "$t".

export enum MessageType {
  CursorMove = 0,
  UserJoinedFile = 1,
  UserLeftFile = 2,
  UsersAlreadyInFile = 3,
  FilePayload = 4,
  FileLoadFailed = 5,
  UserSelectNode = 7,
  UserFocusChange = 8,
  UserPageChange = 9,
  Ping = 10,
  Pong = 11,
  UserCameraChange = 13,
  FileEditBatch = 15,
  CommentThreadsInitialPayload = 19,
  CommentThreadPayload = 20,
  CommentThreadCreate = 21,
  CommentThreadUpdate = 22,
  CommentThreadDelete = 23,
  CommentMessageCreate = 24,
  CommentMessageDelete = 25,
  CommentMessageUpdate = 26,
  UserAgentsChange = 31,
  // --- Propios de Moki ---
  FileMetaChange = 40,
  RpcRequest = 50,
  RpcResponse = 51,
}

export type ClientKind = 'human' | 'runtime';

export enum Focus {
  Canvas = 0,
  Interface = 1,
  Blurred = 2,
}

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PresenceUser {
  clientId: string;
  clientIndex: number;
  kind: ClientKind;
  userId: string;
  name: string;
  pageId?: string | null;
  selectedNodes?: string[];
  cameraView?: WorldRect | null;
  focus?: Focus;
  /** Última vez (ms) que esta pestaña estuvo enfocada / activa. */
  lastActiveAt?: number;
  agents?: AgentActivity[];
}

export type AgentActivityKind = 'read' | 'write' | 'edit' | 'delete';

export interface AgentActivity {
  sessionId: string;
  /** Nombre del harness (Claude Code, Cursor…), si se conoce. */
  harness: string | null;
  nodes: { nodeId: string; kind: AgentActivityKind; at: number }[];
  lastArtboardId?: string | null;
}

export type ServerMessage =
  | { $t: MessageType.FilePayload; file: MokiFile; clientId: string; clientIndex: number; accessLevel: 'edit' }
  | { $t: MessageType.FileLoadFailed; reason: 'not_found' | 'error'; message?: string }
  | { $t: MessageType.UsersAlreadyInFile; users: PresenceUser[] }
  | { $t: MessageType.UserJoinedFile; user: PresenceUser }
  | { $t: MessageType.UserLeftFile; clientId: string }
  | { $t: MessageType.FileEditBatch; fileId: string; edits: Edit[]; clientId: string }
  | { $t: MessageType.CursorMove; clientId: string; x: number; y: number }
  | { $t: MessageType.UserSelectNode; clientId: string; nodeIds: string[] }
  | { $t: MessageType.UserFocusChange; clientId: string; focus: Focus; lastActiveAt: number }
  | { $t: MessageType.UserPageChange; clientId: string; pageId: string }
  | { $t: MessageType.UserCameraChange; clientId: string; view: WorldRect }
  | { $t: MessageType.UserAgentsChange; clientId: string; agents: AgentActivity[] }
  | { $t: MessageType.Pong }
  | { $t: MessageType.CommentThreadsInitialPayload; threads: CommentThread[] }
  | { $t: MessageType.CommentThreadPayload; threadId: string; thread: CommentThread | null }
  | { $t: MessageType.FileMetaChange; name: string }
  | { $t: MessageType.RpcResponse; rpcId: string; result?: unknown; error?: string };

export type ClientMessage =
  | { $t: MessageType.FileEditBatch; fileId: string; edits: Edit[] }
  | { $t: MessageType.CursorMove; x: number; y: number }
  | { $t: MessageType.UserSelectNode; nodeIds: string[] }
  | { $t: MessageType.UserFocusChange; focus: Focus }
  | { $t: MessageType.UserPageChange; pageId: string }
  | { $t: MessageType.UserCameraChange; view: WorldRect }
  | { $t: MessageType.UserAgentsChange; agents: AgentActivity[] }
  | { $t: MessageType.Ping }
  | { $t: MessageType.CommentThreadCreate; thread: CommentThread }
  | { $t: MessageType.CommentThreadUpdate; threadId: string; status?: 'open' | 'resolved'; position?: { nodeId: string; xOffset: number; yOffset: number } }
  | { $t: MessageType.CommentThreadDelete; threadId: string }
  | { $t: MessageType.CommentMessageCreate; threadId: string; message: CommentThread['messages'][number] }
  | { $t: MessageType.CommentMessageUpdate; threadId: string; messageId: string; text: string }
  | { $t: MessageType.CommentMessageDelete; threadId: string; messageId: string }
  | { $t: MessageType.RpcRequest; rpcId: string; method: RpcMethod; params: unknown };

// ---------------------------------------------------------------------------
// RPC por el mismo socket (ordenado respecto a las ediciones ya enviadas).

export type RpcMethod = keyof RpcMethods;

export interface CaptureParams {
  nodeId: string;
  /** Factor de escala CSS final (ya calculado por el llamante). */
  scale: number;
  format: 'png' | 'jpeg' | 'webp' | 'avif';
  /** 0–100 para jpeg/webp/avif. */
  quality?: number;
  /** "visible": pinta el fondo del canvas y lo que hay debajo del nodo dentro del artboard. */
  backdrop?: 'visible' | 'hidden';
}

export interface ExportRequestItem {
  nodeId: string;
  format: 'png' | 'jpg' | 'webp' | 'avif' | 'svg' | 'pdf';
  /** Factor efectivo. */
  scale: number;
  fileName: string;
  pdfQuality?: 'low' | 'medium' | 'high';
  pdfResampling?: 'detailed' | 'basic';
  /** Para SVG: el marcado ya serializado por el cliente. */
  svgMarkup?: string;
}

// ---------------------------------------------------------------------------
// Exportación masiva (POST /api/export y RPC `bulkExport`): una selección, una página, un
// fichero entero o una carpeta (recursiva). Más de un resultado → un .zip.

export type BulkExportScope = 'nodes' | 'page' | 'file' | 'folder';
/** `pdf` = un PDF por artboard; `pdf-combined` = un PDF por página; `moki` = fuente editable (.moki.zip). */
export type BulkExportFormat = 'png' | 'jpg' | 'webp' | 'svg' | 'pdf' | 'pdf-combined' | 'moki';

export interface BulkExportRequest {
  scope: BulkExportScope;
  fileId?: string;
  pageId?: string;
  nodeIds?: string[];
  folderId?: string;
  format: BulkExportFormat;
  /** 1, 2, 3… (por defecto 2; en PDF siempre 1). */
  scale?: number;
  /** Añade el .moki.zip editable de cada fichero junto a lo renderizado. */
  includeSource?: boolean;
}

export interface BulkExportResult {
  /** Nombre del fichero generado (zip, imagen o pdf) en la carpeta de exports. */
  name: string;
  downloadUrl: string;
  filePath: string;
  url: string;
  /** Ficheros de salida dentro del resultado (1 si no es zip). */
  count: number;
  errors: { name: string; error: string }[];
}

export interface BulkExportJob {
  id: string;
  status: 'running' | 'done' | 'error';
  done: number;
  total: number;
  current?: string;
  result?: BulkExportResult;
  error?: string;
}

export interface RpcMethods {
  /** Exportación masiva (página, fichero…); ver BulkExportRequest. */
  bulkExport: { params: BulkExportRequest; result: BulkExportResult };
  /** Captura un nodo y devuelve base64. */
  capture: { params: CaptureParams; result: { data: string; mimeType: string; width: number; height: number } };
  /** Exporta ficheros a la carpeta de exportación. */
  exportFiles: {
    params: { items: ExportRequestItem[] };
    result: { exports: { nodeId: string; filePath: string; downloadUrl: string; url?: string }[]; errors: { nodeId: string; error: string }[] };
  };
  /** Exporta varios nodos a un único PDF (en el orden dado). */
  exportCombinedPdf: {
    params: { nodeIds: string[]; fileName: string; pdfQuality?: 'low' | 'medium' | 'high'; pdfResampling?: 'detailed' | 'basic' };
    result: { filePath: string; downloadUrl: string; url?: string };
  };
  /** Descarga una URL remota / data: / fichero local y la registra como imagen del fichero. */
  importImage: {
    params: { src: string };
    result: { imageId: string; url: string; width?: number; height?: number; extension: string; name?: string };
  };
  /** Lee una imagen del fichero y la devuelve recomprimida para la IA (JPEG ≤2000px, ≤4.5MB base64). */
  readImageForAgent: {
    params: { url: string };
    result: { data: string; mimeType: string; width: number; height: number; originalWidth: number; originalHeight: number };
  };
}

export const FILE_SIZE_LIMIT_BYTES = 47 * 1024 * 1024;
