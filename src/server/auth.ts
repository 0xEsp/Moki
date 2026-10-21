import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// Autenticación opcional por token (MOKI_TOKEN) y lista de Hosts permitidos.
// Funciones puras: no importan la configuración, para poder testearlas aisladas.
//
// - /mcp: cabecera `Authorization: Bearer <token>`.
// - Web, /api, /file-assets y /sync: cookie `moki_token` (se obtiene en POST /api/login).
// - Las peticiones desde loopback (el Chromium headless del propio servidor) no la necesitan.

export const COOKIE_NAME = 'moki_token';
export const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** Comparación en tiempo constante (sobre hashes, así no filtra la longitud). */
export function tokenMatches(expected: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(candidate).digest();
  return crypto.timingSafeEqual(a, b);
}

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

export function isLoopback(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export function cookieTokenOf(req: IncomingMessage): string | null {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? null;
}

export interface AuthOptions {
  token: string | null;
  bearer?: boolean;
  cookie?: boolean;
}

/** ¿La petición está autorizada? Sin token configurado, siempre. Loopback, siempre. */
export function isAuthorized(req: IncomingMessage, opts: AuthOptions): boolean {
  if (!opts.token) return true;
  if (isLoopback(req)) return true;
  if (opts.bearer && tokenMatches(opts.token, bearerOf(req))) return true;
  if (opts.cookie && tokenMatches(opts.token, cookieTokenOf(req))) return true;
  return false;
}

export function sessionCookie(token: string, secure = false): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------- Hosts

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface HostMatcher {
  (host: string | undefined): boolean;
  /** ¿Hay alguna entrada que no sea loopback (es decir, se expone a la red)? */
  exposesNetwork: boolean;
}

/** Divide "host[:port]" teniendo en cuenta IPv6 entre corchetes. */
function splitHost(h: string): { name: string; port: string | null } {
  const s = h.trim().toLowerCase();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    const name = s.slice(0, end + 1);
    const rest = s.slice(end + 1);
    return { name, port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const parts = s.split(':');
  if (parts.length === 2) return { name: parts[0]!, port: parts[1]! };
  return { name: s, port: null };
}

/**
 * Lista de Hosts permitidos. Siempre incluye localhost/127.0.0.1/[::1] (cualquier puerto).
 * Entradas: "*", "nombre", "nombre:puerto", "192.168.1.20", "[fe80::1]:7410"…
 * Una entrada sin puerto acepta cualquier puerto.
 */
export function createHostMatcher(entries: string[]): HostMatcher {
  const any = entries.some((e) => e.trim() === '*');
  const parsed = entries.filter((e) => e.trim() && e.trim() !== '*').map(splitHost);
  const matcher = ((host: string | undefined) => {
    if (!host) return false;
    if (any) return true;
    const h = splitHost(host);
    // Loopback en cualquier puerto (el mapeo de puertos de Docker puede cambiarlo); lo que
    // protege del DNS-rebinding es el nombre, no el puerto.
    if (LOCAL_NAMES.has(h.name)) return true;
    return parsed.some((e) => e.name === h.name && (e.port === null || e.port === (h.port ?? '80')));
  }) as HostMatcher;
  matcher.exposesNetwork = any || parsed.some((e) => !LOCAL_NAMES.has(e.name));
  return matcher;
}
