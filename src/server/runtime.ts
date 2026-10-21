import type { Page } from 'playwright-core';
import type { ToolCallContext, ToolResult } from '../core/runtime';
import { getContext } from './browser';
import { config } from './config';

// Runtime del MCP: una página headless por fichero con el editor completo (sin UI) que
// ejecuta las herramientas. Es el equivalente al main de Electron haciendo executeJavaScript
// sobre la pestaña del fichero.

const READY_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;

interface RuntimeEntry {
  fileId: string;
  page: Promise<Page>;
  lastUsed: number;
  /** Llamadas en curso (no se cierra un runtime ocupado). */
  busy: number;
}

const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export class RuntimeManager {
  private entries = new Map<string, RuntimeEntry>();
  private sweeper = setInterval(() => this.sweep(), 60_000);

  constructor() {
    this.sweeper.unref();
  }

  private async openPage(fileId: string): Promise<Page> {
    const ctx = await getContext();
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.warn(`[runtime ${fileId.slice(-6)}] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.error(`[runtime ${fileId.slice(-6)}] pageerror`, e.message));
    page.on('crash', () => {
      console.error(`[runtime ${fileId.slice(-6)}] la página se ha colgado; se recreará`);
      this.entries.delete(fileId);
    });
    page.on('close', () => {
      const e = this.entries.get(fileId);
      if (e) void e.page.then((p) => p === page && this.entries.delete(fileId)).catch(() => undefined);
    });
    try {
      await page.goto(`${config.webOrigin}/file/${encodeURIComponent(fileId)}?runtime=1`, { waitUntil: 'load' });
    } catch {
      await page.close().catch(() => undefined);
      throw new Error(`The Moki web app is not reachable at ${config.webOrigin} (set MOKI_WEB_ORIGIN or start it).`);
    }
    try {
      await page.waitForFunction(() => window.mokiRuntime?.ready === true, undefined, { timeout: READY_TIMEOUT_MS });
    } catch {
      await page.close().catch(() => undefined);
      throw new Error('The Moki runtime did not start in time. Is the web app reachable from the server?');
    }
    return page;
  }

  /** Página runtime del fichero (la crea si no existe). */
  ensure(fileId: string): Promise<Page> {
    let e = this.entries.get(fileId);
    if (!e) {
      this.evictForNew();
      const page = this.openPage(fileId);
      e = { fileId, page, lastUsed: Date.now(), busy: 0 };
      this.entries.set(fileId, e);
      page.catch(() => {
        if (this.entries.get(fileId) === e) this.entries.delete(fileId);
      });
    }
    e.lastUsed = Date.now();
    return e.page;
  }

  /** Con el límite de runtimes alcanzado, cierra el menos usado que no esté ocupado (LRU). */
  private evictForNew() {
    while (this.entries.size >= config.maxRuntimes) {
      const idle = [...this.entries.values()].filter((x) => x.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed);
      const victim = idle[0];
      if (!victim) return; // todos ocupados: se supera el límite temporalmente
      console.log(`[runtime] límite de ${config.maxRuntimes} runtimes: cierro ${victim.fileId}`);
      void this.close(victim.fileId);
    }
  }

  get size() {
    return this.entries.size;
  }

  has(fileId: string) {
    return this.entries.has(fileId);
  }

  async call(fileId: string, ctx: ToolCallContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    let page: Page;
    const entryBusy = () => this.entries.get(fileId);
    try {
      page = await this.ensure(fileId);
      const be = entryBusy();
      if (be) be.busy++;
      if (page.isClosed()) {
        this.entries.delete(fileId);
        page = await this.ensure(fileId);
      }
    } catch (e) {
      return errorResult(`Could not open the file in the Moki runtime: ${e instanceof Error ? e.message : String(e)}`);
    }
    const run = page.evaluate(
      ({ ctx, name, args }) => window.mokiRuntime!.handleToolCall(ctx, name, args),
      { ctx, name, args },
    ) as Promise<ToolResult>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => resolve(errorResult('Tool call timed out. Please check your file then try again.')), CALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([run, timeout]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Target page|has been closed|crash/i.test(msg)) this.entries.delete(fileId);
      return errorResult(msg);
    } finally {
      clearTimeout(timer);
      const e = this.entries.get(fileId);
      if (e) {
        e.lastUsed = Date.now();
        e.busy = Math.max(0, e.busy - 1);
      }
    }
  }

  /** Quita la actividad de un agente (sesión MCP cerrada) en todos los runtimes. */
  async removeAgent(sessionId: string) {
    for (const e of this.entries.values()) {
      const page = await e.page.catch(() => null);
      if (!page || page.isClosed()) continue;
      await page.evaluate((id) => window.mokiRuntime?.removeAgent(id), sessionId).catch(() => undefined);
    }
  }

  /** Cierra el runtime de un fichero (p. ej. al borrarlo). */
  async close(fileId: string) {
    const e = this.entries.get(fileId);
    this.entries.delete(fileId);
    const p = await e?.page.catch(() => null);
    await p?.close().catch(() => undefined);
  }

  private sweep() {
    const now = Date.now();
    for (const e of [...this.entries.values()]) if (e.busy === 0 && now - e.lastUsed > config.runtimeIdleMs) void this.close(e.fileId);
  }

  async closeAll() {
    clearInterval(this.sweeper);
    for (const id of [...this.entries.keys()]) await this.close(id);
  }
}

export const runtimes = new RuntimeManager();
