import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Configuración del servidor (variables de entorno MOKI_*).

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const env = process.env;
const isProd = env.NODE_ENV === 'production';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as { version: string };

function detectChromium(): string | undefined {
  if (env.MOKI_CHROMIUM_PATH) return env.MOKI_CHROMIUM_PATH;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

const port = Number(env.MOKI_PORT ?? 7410);
const host = env.MOKI_HOST ?? '127.0.0.1';
const dataDir = path.resolve(env.MOKI_DATA_DIR ?? path.join(ROOT_DIR, 'data'));
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const lowMemory = env.MOKI_LOW_MEMORY === '1' || env.MOKI_LOW_MEMORY === 'true';
const num = (v: string | undefined, fallback: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
const MIN = 60 * 1000;

export const config = {
  version: pkg.version,
  isProd,
  port,
  host,
  dataDir,
  /** Origen interno del propio servidor (para el Chromium headless en producción). */
  serverOrigin: `http://127.0.0.1:${port}`,
  /** Origen desde el que el Chromium headless carga la web app. */
  webOrigin: (env.MOKI_WEB_ORIGIN ?? (isProd ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:5173')).replace(/\/$/, ''),
  /** Origen público que se devuelve a los agentes en URLs. */
  publicOrigin: (env.MOKI_PUBLIC_ORIGIN ?? (isProd ? `http://localhost:${port}` : 'http://localhost:5173')).replace(/\/$/, ''),
  chromiumPath: detectChromium(),
  exportHostDir: env.MOKI_EXPORT_HOST_DIR || null,
  localhostAlias: env.MOKI_LOCALHOST_ALIAS || null,
  allowedHosts: list(env.MOKI_ALLOWED_HOSTS),
  localAssetRoots: list(env.MOKI_LOCAL_ASSET_ROOTS).map((p) => path.resolve(p)),
  distDir: path.join(ROOT_DIR, 'dist'),
  /** ¿Corremos en un contenedor o como root? (Chromium necesita --no-sandbox). */
  needsNoSandbox: fs.existsSync('/.dockerenv') || process.getuid?.() === 0 || env.MOKI_NO_SANDBOX === '1',
  /** Token de acceso (opcional). Si existe, /mcp exige Bearer y la web/API una cookie. */
  token: env.MOKI_TOKEN?.trim() || null,
  /** Perfil de poca memoria (Raspberry Pi): menos runtimes, cierres más agresivos. */
  lowMemory,
  runtimeIdleMs: num(env.MOKI_RUNTIME_IDLE_MS, lowMemory ? 5 * MIN : 15 * MIN),
  /** Máximo de páginas runtime abiertas a la vez (se cierra la menos usada). */
  maxRuntimes: Math.max(1, num(env.MOKI_MAX_RUNTIMES, lowMemory ? 2 : 8)),
  /** Inactividad tras la que se cierra la página de capturas. */
  captureIdleMs: num(env.MOKI_CAPTURE_IDLE_MS, lowMemory ? 2 * MIN : 10 * MIN),
  /** Inactividad (sin páginas abiertas) tras la que se cierra Chromium entero. */
  browserIdleMs: num(env.MOKI_BROWSER_IDLE_MS, lowMemory ? 3 * MIN : 15 * MIN),
  /** Lado máximo (px) de un export raster. */
  maxExportSide: num(env.MOKI_MAX_EXPORT_SIDE, lowMemory ? 8000 : 16000),
  /** Flags extra para Chromium (separados por espacios). */
  chromiumExtraArgs: (env.MOKI_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean),
};

export const paths = {
  files: path.join(dataDir, 'files'),
  comments: path.join(dataDir, 'comments'),
  assets: path.join(dataDir, 'assets'),
  exports: path.join(dataDir, 'exports'),
  folders: path.join(dataDir, 'folders.json'),
};

for (const p of [paths.files, paths.comments, paths.assets, paths.exports]) fs.mkdirSync(p, { recursive: true });
