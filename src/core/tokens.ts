import { parse as parseColor } from 'culori';
import type { MokiFile, Token, TokenType } from './types';

// Design tokens. En los estilos de los nodos una referencia se guarda internamente como
// `var(t:<id>)` (estable ante renombrados). Hacia fuera (MCP, JSX) se expone `var(--nombre)`.
// En el render se usa una variable CSS interna derivada del id.

export const TOKEN_ID_RE = /^t:[0-9a-z]+-[0-9a-z]+$/;
export const INTERNAL_REF_RE = /var\((t:[0-9a-z]+-[0-9a-z]+)\)/g;
export const EXTERNAL_REF_RE = /var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;

export const cssNameOf = (t: Token) => `--${t.name}`;
export const renderVarOf = (tokenId: string) => `--moki-${tokenId.replace(/[^a-zA-Z0-9-]/g, '-')}`;

export function liveTokens(file: MokiFile): Token[] {
  return Object.values(file.theme?.tokens ?? {}).filter((t) => !t['~']);
}

export function tokenByCssName(file: MokiFile, cssName: string): Token | undefined {
  const name = cssName.replace(/^--/, '');
  // Si hay nombres repetidos, gana el último creado (mayor sortKey dentro del tipo no aplica aquí).
  let found: Token | undefined;
  for (const t of liveTokens(file)) if (t.name === name) found = t;
  return found;
}

/** Resuelve alias en profundidad. Devuelve el token final y el valor bruto, o null si hay ciclo. */
export function resolveTokenDeep(
  file: MokiFile,
  id: string,
  modeId?: string,
): { token: Token; value: string | number } | null {
  const seen = new Set<string>();
  let cur = file.theme.tokens[id];
  while (cur && !cur['~']) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    const v = (modeId && cur.modes?.[modeId]) ?? cur.value;
    if (typeof v === 'string' && TOKEN_ID_RE.test(v)) {
      cur = file.theme.tokens[v];
      continue;
    }
    return { token: cur, value: v };
  }
  return null;
}

export function wouldCreateCycle(file: MokiFile, tokenId: string, newValue: string | number): boolean {
  if (typeof newValue !== 'string' || !TOKEN_ID_RE.test(newValue)) return false;
  const seen = new Set<string>([tokenId]);
  let cur: string | undefined = newValue;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const t: Token | undefined = file.theme.tokens[cur];
    const v: string | number | undefined = t?.value;
    cur = typeof v === 'string' && TOKEN_ID_RE.test(v) ? v : undefined;
  }
  return false;
}

/** Serializa un valor primitivo de token a CSS según su tipo. */
export function serializePrimitive(type: TokenType, v: string | number): string {
  if (type === 'fontFamily') return quoteFontFamilyList(String(v));
  if (typeof v === 'string') return v;
  switch (type) {
    case 'lineHeight':
      return `${round(v * 100)}%`;
    case 'opacity':
      return `${round(v * 100)}%`;
    case 'fontWeight':
      return String(v);
    case 'color':
      return String(v);
    default:
      return `${round(v)}px`;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Valor CSS de un token tal como se expone hacia fuera (alias → var(--otro)). */
export function externalCssValue(file: MokiFile, t: Token): string {
  const v = t.value;
  if (typeof v === 'string' && TOKEN_ID_RE.test(v)) {
    const target = file.theme.tokens[v];
    return target ? `var(${cssNameOf(target)})` : 'initial';
  }
  return serializePrimitive(t.type, v);
}

/** Valor CSS para el render (alias → var(--moki-…)). */
export function renderCssValue(file: MokiFile, t: Token): string {
  const v = t.value;
  if (typeof v === 'string' && TOKEN_ID_RE.test(v)) return `var(${renderVarOf(v)})`;
  return serializePrimitive(t.type, v);
}

/** Bloque `:root{…}` con todas las variables internas, para inyectar en el canvas. */
export function tokensRenderCss(file: MokiFile, selector = ':root'): string {
  const decls = liveTokens(file)
    .map((t) => `${renderVarOf(t.id)}:${renderCssValue(file, t)};`)
    .join('');
  return `${selector}{${decls}}`;
}

/** `var(t:…)` → `var(--moki-…)` para render. */
export function internalToRender(value: string): string {
  return value.includes('var(t:') ? value.replace(INTERNAL_REF_RE, (_, id) => `var(${renderVarOf(id)})`) : value;
}

/** `var(t:…)` → `var(--nombre)` para exponer al agente / exportar código. */
export function internalToExternal(file: MokiFile, value: string): string {
  if (!value.includes('var(t:')) return value;
  return value.replace(INTERNAL_REF_RE, (m, id) => {
    const t = file.theme.tokens[id];
    return t && !t['~'] ? `var(${cssNameOf(t)})` : m;
  });
}

/** `var(t:…)` → valor CSS resuelto (para export sin variables). */
export function internalToResolved(file: MokiFile, value: string): string {
  if (!value.includes('var(t:')) return value;
  return value.replace(INTERNAL_REF_RE, (m, id) => {
    const r = resolveTokenDeep(file, id);
    return r ? serializePrimitive(r.token.type, r.value) : m;
  });
}

/**
 * `var(--nombre[, fallback])` → `var(t:…)` si el token existe. Si no existe y hay fallback,
 * se usa el fallback; si no hay fallback se deja literal.
 */
export function externalToInternal(file: MokiFile, value: string): string {
  if (!value.includes('var(')) return value;
  return value.replace(EXTERNAL_REF_RE, (m, name: string, fallback?: string) => {
    const t = tokenByCssName(file, name);
    if (t) return `var(${t.id})`;
    if (fallback !== undefined && fallback.trim() !== '') return fallback.trim();
    return m;
  });
}

// ---------------------------------------------------------------------------
// Parseo de valores entrantes (create_tokens / set_tokens / panel de tokens).

export type ParsedTokenValue = { ok: true; value: string | number } | { ok: false; error: string };

const FONT_WEIGHT_KEYWORDS: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, normal: 400,
  regular: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800,
  ultrabold: 800, black: 900, heavy: 900,
};

export function parseTokenValue(file: MokiFile, type: TokenType, raw: string | number): ParsedTokenValue {
  if (typeof raw === 'string') {
    const s = raw.trim();
    const ref = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/.exec(s);
    if (ref) {
      const t = tokenByCssName(file, ref[1]!);
      if (!t) return { ok: false, error: `Invalid value "${raw}": token ${ref[1]} does not exist` };
      return { ok: true, value: t.id };
    }
    if (s === '') return { ok: false, error: 'Invalid value: empty' };
  }
  switch (type) {
    case 'color': {
      const s = String(raw).trim();
      if (/^color-mix\(/i.test(s)) return { ok: true, value: s };
      if (!parseColor(s)) return { ok: false, error: `Invalid value "${raw}" for a color token` };
      return { ok: true, value: s };
    }
    case 'fontFamily':
      return { ok: true, value: String(raw).trim() };
    case 'opacity': {
      let n: number;
      if (typeof raw === 'number') n = raw;
      else if (/%$/.test(raw.trim())) n = parseFloat(raw) / 100;
      else n = parseFloat(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `Invalid value "${raw}" for an opacity token` };
      if (n > 1) n = n / 100;
      return { ok: true, value: Math.max(0, Math.min(1, n)) };
    }
    case 'fontWeight': {
      if (typeof raw === 'number') return { ok: true, value: raw };
      const k = raw.trim().toLowerCase().replace(/[\s_-]/g, '');
      if (FONT_WEIGHT_KEYWORDS[k]) return { ok: true, value: FONT_WEIGHT_KEYWORDS[k]! };
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `Invalid value "${raw}" for a fontWeight token` };
      return { ok: true, value: n };
    }
    case 'lineHeight': {
      if (typeof raw === 'number') return { ok: true, value: raw };
      const s = raw.trim();
      if (/^-?\d*\.?\d+$/.test(s)) return { ok: true, value: Number(s) };
      if (/%$/.test(s)) return { ok: true, value: parseFloat(s) / 100 };
      if (/^-?\d*\.?\d+(px|rem|em)$/.test(s)) return { ok: true, value: s };
      if (s === 'normal') return { ok: true, value: s };
      return { ok: false, error: `Invalid value "${raw}" for a lineHeight token` };
    }
    default: {
      if (typeof raw === 'number') return { ok: true, value: raw };
      const s = raw.trim();
      if (/^-?\d*\.?\d+$/.test(s)) return { ok: true, value: Number(s) };
      if (/^-?\d*\.?\d+px$/.test(s)) return { ok: true, value: parseFloat(s) };
      if (/^-?\d*\.?\d+(rem|em|%|vw|vh|ch|ex)$/.test(s) || /^calc\(/.test(s) || s === 'normal') {
        return { ok: true, value: s };
      }
      return { ok: false, error: `Invalid value "${raw}" for a ${type} token` };
    }
  }
}

// ---------------------------------------------------------------------------
// Hash de contenido de los tokens (FNV-1a 32 bits sobre una serialización estable).

export function tokensContentHash(file: MokiFile): string {
  const toks = liveTokens(file)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((t) => [t.id, t.type, t.name, t.value, t.description ?? '', t.modes ?? null]);
  const s = JSON.stringify([toks, file.theme.modes ?? {}]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset',
]);

/**
 * Entrecomilla cada familia que lo necesite: `Source Sans 3` sin comillas es CSS inválido
 * (un identificador no puede empezar por dígito) y el navegador caería a la fuente por defecto.
 */
export function quoteFontFamilyList(value: string): string {
  return value
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => (/^["']/.test(f) || GENERIC_FAMILIES.has(f.toLowerCase()) || /^var\(/.test(f) ? f : `"${f.replace(/"/g, '')}"`))
    .join(', ');
}
