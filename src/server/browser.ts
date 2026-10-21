import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { config } from './config';

// Chromium headless compartido (runtime del MCP + capturas). Se lanza bajo demanda y se
// relanza si se cae.

let launching: Promise<BrowserContext> | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;

let emptySince: number | null = null;

export async function getContext(): Promise<BrowserContext> {
  emptySince = null;
  if (context && browser?.isConnected()) return context;
  if (launching) return launching;
  launching = (async () => {
    const args = [
      '--font-render-hinting=none',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      // Runtime y captura conviven en el mismo navegador: que ninguno pase a "segundo plano"
      // (rAF y timers limitados a ~1 Hz harían que cada herramienta tardase segundos).
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ];
    if (config.needsNoSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
    if (config.lowMemory) {
      // Raspberry Pi / poca RAM: menos procesos renderer, sin GPU y heap JS acotado.
      args.push(
        '--renderer-process-limit=2',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-default-apps',
        '--no-first-run',
        '--mute-audio',
        '--js-flags=--max-old-space-size=384',
        '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints,AcceptCHFrame',
      );
    }
    args.push(...config.chromiumExtraArgs);
    const opts: Parameters<typeof chromium.launch>[0] = { headless: true, args };
    if (config.chromiumPath) opts.executablePath = config.chromiumPath;
    else opts.channel = 'chrome';
    console.log(`[browser] lanzando Chromium headless (${config.chromiumPath ?? 'channel chrome'})`);
    const b = await chromium.launch(opts);
    b.on('disconnected', () => {
      console.warn('[browser] Chromium se ha cerrado');
      if (browser === b) {
        browser = null;
        context = null;
      }
    });
    const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    browser = b;
    context = ctx;
    emptySince = null;
    return ctx;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

export async function closeBrowser() {
  const b = browser;
  browser = null;
  context = null;
  await b?.close().catch(() => undefined);
}

// Sin páginas abiertas durante `browserIdleMs` → se cierra Chromium entero para liberar RAM.
// Se vuelve a lanzar (≈1–3 s) con la siguiente herramienta o captura.
const sweeper = setInterval(() => {
  if (!context || !browser || launching) return;
  if (context.pages().length > 0) {
    emptySince = null;
    return;
  }
  emptySince ??= Date.now();
  if (Date.now() - emptySince >= config.browserIdleMs) {
    console.log('[browser] sin páginas abiertas: cierro Chromium para liberar memoria');
    emptySince = null;
    void closeBrowser();
  }
}, 15_000);
sweeper.unref();
