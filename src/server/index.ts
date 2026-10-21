import http from 'node:http';
import type { BulkExportRequest, CaptureParams, ExportRequestItem, RpcMethods } from '../core/protocol';
import { runBulkExport } from './bulk-export';
import { closeBrowser } from './browser';
import { capture, closeCapture, exportCombinedPdf, exportFiles, importImage, readImageForAgent } from './capture';
import { config } from './config';
import { handleHttp } from './http';
import { closeMcp, hostAllowed } from './mcp';
import { isAuthorized } from './auth';
import { runtimes } from './runtime';
import { store } from './store';
import { hub } from './sync';

// Punto de entrada del servidor Moki.

hub.setRpcHandler(async ({ fileId }, method, params) => {
  switch (method) {
    case 'capture':
      return capture(fileId, params as CaptureParams);
    case 'exportFiles':
      return exportFiles(fileId, (params as { items: ExportRequestItem[] }).items);
    case 'exportCombinedPdf':
      return exportCombinedPdf(fileId, params as RpcMethods['exportCombinedPdf']['params']);
    case 'importImage':
      return importImage(fileId, (params as { src: string }).src);
    case 'bulkExport':
      return runBulkExport({ ...(params as BulkExportRequest), fileId: (params as BulkExportRequest).fileId ?? fileId });
    case 'readImageForAgent':
      return readImageForAgent((params as { url: string }).url);
    default:
      throw new Error(`Unknown RPC method: ${String(method)}`);
  }
});

// Exponer el MCP a la red sin token sería dar control del fichero a cualquiera de la LAN.
if (hostAllowed.exposesNetwork && !config.token) {
  console.error(
    '[moki] MOKI_ALLOWED_HOSTS permite hosts de red pero MOKI_TOKEN no está definido.\n' +
      '       Define MOKI_TOKEN (p. ej. `openssl rand -hex 24`) o quita los hosts no locales.',
  );
  process.exit(1);
}

const server = http.createServer((req, res) => {
  void handleHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!(req.url ?? '').startsWith('/sync/')) return socket.destroy();
  if (!isAuthorized(req, { token: config.token, cookie: true })) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return socket.destroy();
  }
  hub.handleUpgrade(req, socket, head);
});

server.listen(config.port, config.host, () => {
  console.log(`Moki ${config.version} escuchando en http://${config.host}:${config.port}`);
  console.log(`  MCP:   ${config.isProd ? config.publicOrigin : `http://localhost:${config.port}`}/mcp`);
  console.log(`  Datos: ${config.dataDir}`);
  console.log(`  Web (runtime/capturas): ${config.webOrigin}`);
  console.log(`  Auth:  ${config.token ? 'MOKI_TOKEN activo (Bearer en /mcp, login en la web)' : 'sin token (solo loopback recomendado)'}`);
  if (config.lowMemory) console.log(`  Perfil de poca memoria: máx. ${config.maxRuntimes} runtimes, export ≤ ${config.maxExportSide}px`);
  if (!config.chromiumPath) console.log('  Chromium: canal "chrome" del sistema (define MOKI_CHROMIUM_PATH si falla)');
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[moki] ${signal}: guardando y cerrando…`);
  try {
    store.flushAll();
  } catch (e) {
    console.error(e);
  }
  hub.closeAll();
  await closeMcp();
  await runtimes.closeAll();
  await closeCapture();
  await closeBrowser();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[moki] uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('[moki] unhandledRejection', e));
