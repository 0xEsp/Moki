// Contrato servidor ↔ runtime (editor headless que ejecuta las herramientas MCP).
//
// El servidor abre, en un Chromium headless, `http://127.0.0.1:<port>/file/<fileId>?runtime=1`.
// Esa página carga el editor completo (sin paneles), se conecta al sync como cliente
// `kind=runtime` y expone `window.mokiRuntime`. El servidor invoca las herramientas con
// `page.evaluate(...)`, igual que el main de Electron hacía `executeJavaScript` sobre la pestaña.

export interface ToolCallContext {
  /** Id de la sesión MCP (= "agente"). */
  sessionId: string;
  clientInfo?: { name?: string; version?: string } | null;
  transport: 'http' | 'stdio';
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface MokiRuntimeApi {
  /** true cuando el fichero está cargado y la página activa medida. */
  ready: boolean;
  fileId: string;
  handleToolCall(ctx: ToolCallContext, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Borra la actividad del agente (sesión MCP cerrada). */
  removeAgent(sessionId: string): void;
}

declare global {
  interface Window {
    mokiRuntime?: MokiRuntimeApi;
  }
}

export const RUNTIME_QUERY_PARAM = 'runtime';
