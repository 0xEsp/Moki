import { ulid } from 'ulid';
import type { MokiFile } from './types';

export const newFileId = (): string => ulid();
export const newUlid = (): string => ulid();

/** ULID: 26 caracteres en base32 Crockford. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const b36 = (n: number) => n.toString(36).toUpperCase();

/**
 * Ids de nodo `<contador>-<clientIndex>` en base36 mayúsculas. El contador vive en el fichero
 * y el clientIndex lo asigna el servidor por conexión: dos clientes nunca colisionan.
 * Muta `file.counter` (el llamante decide si eso entra o no en el undo).
 */
export function nextNodeId(file: MokiFile, clientIndex: number): string {
  file.counter.nodes += 1;
  return `${b36(file.counter.nodes)}-${b36(clientIndex)}`;
}

export function nextPageId(file: MokiFile, clientIndex: number): string {
  file.counter.pages += 1;
  return `p-${b36(file.counter.pages)}-${b36(clientIndex)}`;
}

export function nextTokenId(file: MokiFile, clientIndex: number): string {
  file.counter.tokens += 1;
  return `t:${file.counter.tokens.toString(36)}-${clientIndex.toString(36)}`;
}

export const rootNodeIdFor = (pageId: string) => `root_node_${pageId}`;
export const pageIdFromRoot = (rootId: string) =>
  rootId.startsWith('root_node_') ? rootId.slice('root_node_'.length) : null;

/** Id corto aleatorio para comentarios: `<prefijo>-<6 caracteres>`. */
export function shortId(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}
