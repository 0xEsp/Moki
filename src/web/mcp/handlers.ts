import { readingOrder } from '../../core/layout-order';
import { toJS } from 'mobx';
import { compactStyles, pxValue } from '../../core/css';
import { keyBetween, keysBetween } from '../../core/fractional';
import { TOOL_BY_NAME, schemaWithFileId, type ToolDef } from '../../core/mcp/tools';
import { guideText } from '../../core/mcp/guides';
import { FILE_SIZE_LIMIT_BYTES, MessageType, type ExportRequestItem } from '../../core/protocol';
import { computeNodeStyle } from '../../core/render-style';
import type { ToolCallContext, ToolContent, ToolResult } from '../../core/runtime';
import {
  cssNameOf,
  externalCssValue,
  liveTokens,
  parseTokenValue,
  tokenByCssName,
  tokensContentHash,
  wouldCreateCycle,
} from '../../core/tokens';
import { canHaveChildren, isRootId } from '../../core/tree';
import {
  FREEFORM_DISPLAY,
  LOCAL_USER,
  TOKEN_TYPE_ORDER,
  type CommentThread,
  type ExportEntry,
  type PageIcon,
  type StyleValue,
  type Styles,
  type TokenType,
  type TreeNode,
} from '../../core/types';
import type { Rect } from '../canvas/geometry';
import { INSTANCE_CHILDREN_ERROR, type DocStore } from '../state/doc-store';
import type { FileSession } from '../state/file-session';
import { AgentActivityTracker } from './agent-activity';
import { computeAgentStyles, normalizeIncoming } from './apply-css';
import { matchNode, wildcardMatch, type StyleFilter } from './find-nodes';
import { htmlToNodes, truncateLabel, type ParsedTree } from './html-to-nodes';
import { generateJsx } from './jsx';
import { ARTBOARD_GAP, findPlacement } from './placement';
import { serializeSvgNode } from './svg-export';
import { planInstanceConversion } from '../../core/instance-convert';

// Handlers de las herramientas MCP de scope "file". Se ejecutan dentro del runtime (editor
// headless), que tiene el documento vivo, un motor de layout real y la conexión de sync.

/** ¿Es ya un asset servido por este Moki? */
function isOwnAsset(u: string): boolean {
  try {
    const url = new URL(u, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith('/file-assets/');
  } catch {
    return false;
  }
}

export interface Measurer {
  /** Rectángulo en coordenadas de mundo (relativo a la raíz de su página), o null si no se pinta. */
  worldRect(id: string): Rect | null;
  /** Espera a que el DOM refleje el documento y esté medido (fuentes cargadas). */
  whenMeasured(timeoutMs: number): Promise<boolean>;
}

export interface RuntimeContext {
  session: FileSession;
  doc: DocStore;
  measurer: Measurer;
}

export class UserError extends Error {}

type HandlerResult = { data: unknown } | { error: string } | { content: ToolContent[]; isError?: boolean };
type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (ctx: ToolCallContext, args: Args) => Promise<HandlerResult> | HandlerResult;

const TOOL_TIMEOUT_MS = 60_000;
const MAX_LIST = 100;

const round = (n: number) => Math.round(n * 100) / 100;

interface FontCatalog {
  families: { family: string; category: string; variable: boolean; styles: { isItalic: boolean; minWeight: number; maxWeight: number }[] }[];
}

const GENERIC_FAMILIES = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji']);
const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

export class McpHandlers {
  readonly activity: AgentActivityTracker;
  private handlers: Record<string, Handler>;
  private fontCatalog: Promise<FontCatalog> | null = null;

  constructor(private rc: RuntimeContext) {
    this.activity = new AgentActivityTracker(
      (agents) => rc.session.sync.send({ $t: MessageType.UserAgentsChange, agents }),
      (id) => this.doc.ancestors(id).filter((a) => !isRootId(a)),
      (id) => this.doc.artboardOf(id),
    );
    this.handlers = {
      get_guide: (_c, a) => ({ content: [{ type: 'text', text: guideText(String(a.topic)) }] }),
      get_basic_info: (_c, a) => this.getBasicInfo(a.pageId),
      get_selection: (c) => this.getSelection(c),
      get_node_info: (c, a) => this.getNodeInfo(c, a.nodeId),
      get_children: (c, a) => this.getChildren(c, a.nodeId),
      get_tree_summary: (c, a) => this.getTreeSummary(c, a.nodeId, a.depth),
      get_screenshot: (c, a) => this.getScreenshot(c, a.nodeId, a.scale),
      get_jsx: (c, a) => this.getJsx(c, a),
      get_computed_styles: (c, a) => this.getComputedStyles(c, a.nodeIds),
      get_fill_image: (c, a) => this.getFillImage(c, a.nodeId),
      find_nodes: (c, a) => this.findNodes(c, a),
      get_font_family_info: (_c, a) => this.getFontFamilyInfo(a.familyNames),
      list_comment_threads: (c, a) => this.listCommentThreads(c, a),
      get_comment_thread: (c, a) => this.getCommentThread(c, a.commentThreadId),
      list_comment_thread_authors: (_c, a) => this.listCommentThreadAuthors(a.pageId),
      set_comment_thread_status: (_c, a) => this.setCommentThreadStatus(a.commentThreadId, a.status),
      create_page: (_c, a) => this.createPage(a.name, a.icon),
      update_pages: (_c, a) => this.updatePages(a.updates),
      arrange_pages: (_c, a) => this.arrangePages(a.order, a.removeDividerIds),
      create_artboard: (c, a) => this.createArtboard(c, a),
      write_html: (c, a) => this.writeHtml(c, a.html, a.targetNodeId, a.mode),
      delete_nodes: (c, a) => this.deleteNodes(c, a.nodeIds),
      set_text_content: (c, a) => this.setTextContent(c, a.updates),
      rename_nodes: (c, a) => this.renameNodes(c, a.updates),
      update_styles: async (c, a) => this.updateStyles(c, await this.localizeUpdates(a.updates)),
      duplicate_nodes: (c, a) => this.duplicateNodes(c, a.nodes),
      move_nodes: (c, a) => this.moveNodes(c, a.moves),
      finish_working_on_nodes: (c, a) => {
        this.activity.finish(c.sessionId, a.nodeIds);
        return { data: 'OK' };
      },
      get_tokens: (_c, a) => this.getTokens(a),
      create_tokens: (_c, a) => this.createTokens(a.tokens),
      set_tokens: (_c, a) => this.setTokens(a.tokens),
      export: (c, a) => this.exportNodes(c, a),
      export_combined_pdf: (c, a) => this.exportCombinedPdf(c, a.nodeIds),
      create_component: (c, a) => this.createComponent(c, a.nodeId, a.name),
      create_instance: (c, a) => this.createInstance(c, a),
      convert_to_instances: (c, a) => this.convertToInstances(c, a),
      list_components: (c, a) => this.listComponents(c, a.pageId),
      detach_instance: (c, a) => this.detachInstance(c, a.nodeId),
      reset_overrides: (c, a) => this.resetOverrides(c, a.nodeId),
    };
  }

  // ------------------------------------------------------------------ componentes

  private async createComponent(ctx: ToolCallContext, id: string, name?: string): Promise<HandlerResult> {
    this.nodeOrThrow(id);
    try {
      this.mutate(() => this.doc.createComponentFrom(id, name ? truncateLabel(name) : undefined));
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    this.activity.recordWrite(ctx, [id], 'edit');
    return { data: { componentId: id, name: this.doc.view(id)!.label } };
  }

  private async createInstance(ctx: ToolCallContext, a: Args): Promise<HandlerResult> {
    const mainId = String(a.componentId);
    const main = this.doc.view(mainId);
    if (!main) return { error: `Component not found: ${mainId}` };
    if (!main.isComponent) return { error: `Node ${mainId} is not a main component. Call create_component first.` };
    const parentId = String(a.targetNodeId);
    const parent = this.doc.view(parentId);
    if (!parent) return { error: `Node not found: ${parentId}` };
    if (!canHaveChildren(parent)) return { error: `Node ${parentId} cannot have children` };
    const styles = normalizeIncoming(this.doc.data, (a.styles ?? {}) as Record<string, StyleValue | null>);
    // En un padre libre (o el canvas) sin posición explícita: hueco libre, como un artboard.
    if (this.doc.isFreeform(parentId) && styles.left === undefined && styles.top === undefined) {
      const r = this.rectOf(mainId);
      const w = r?.width ?? (pxValue(main.styles.width as StyleValue | undefined) ?? 200);
      const h = r?.height ?? (pxValue(main.styles.height as StyleValue | undefined) ?? 100);
      if (isRootId(parentId)) {
        const pageId = parentId.slice('root_node_'.length);
        const pos = findPlacement({ obstacles: this.pageObstacles(parentId), width: w, height: h, padding: ARTBOARD_GAP, visibleArea: this.visibleAreaFor(pageId) });
        styles.left = `${pos.x}px`;
        styles.top = `${pos.y}px`;
      } else {
        styles.left = '0px';
        styles.top = '0px';
      }
    }
    let id: string;
    try {
      id = this.mutate(() => {
        const key = a.index !== undefined ? this.doc.sortKeyForIndex(parentId, Number(a.index)) : undefined;
        return this.doc.createInstance(mainId, parentId, key, styles as Styles);
      });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    this.activity.recordWrite(ctx, [id], 'write');
    await this.settle();
    const c = this.coords(id);
    return {
      data: {
        id,
        name: this.doc.view(id)!.label,
        componentId: mainId,
        ...c,
        childIds: this.doc.childIds(id).slice(0, MAX_LIST),
      },
    };
  }

  private async convertToInstances(ctx: ToolCallContext, a: Args): Promise<HandlerResult> {
    const mainId = String(a.componentId);
    const main = this.doc.node(mainId);
    if (!main?.isComponent) return { error: `Node ${mainId} is not a main component. Call create_component first.` };
    const ids = (a.nodeIds as string[]) ?? [];
    const dryRun = a.dryRun === true;
    const results: { nodeId: string; converted: boolean; overrides?: number; reason?: string }[] = [];
    if (dryRun) {
      for (const id of ids) {
        const plan = this.doc.node(id) ? planInstanceConversion(this.doc, id, mainId) : { ok: false as const, reason: `Node not found: ${id}` };
        results.push(plan.ok ? { nodeId: id, converted: false, overrides: plan.overrideCount } : { nodeId: id, converted: false, reason: plan.reason });
      }
    } else {
      let map = new Map<string, { overrideCount: number } | { error: string }>();
      this.mutate(() => {
        map = this.doc.convertToInstances(ids, mainId);
      });
      for (const id of ids) {
        const r = map.get(id);
        if (r && 'overrideCount' in r) results.push({ nodeId: id, converted: true, overrides: r.overrideCount });
        else results.push({ nodeId: id, converted: false, reason: r?.error ?? 'not processed' });
      }
    }
    const done = results.filter((r) => r.converted).map((r) => r.nodeId);
    if (done.length) {
      this.activity.recordWrite(ctx, done, 'edit');
      await this.settle();
    }
    const failed = results.filter((r) => r.reason).length;
    return { data: { componentId: mainId, dryRun, converted: done.length, matched: results.length - failed, failed, results } };
  }

  private listComponents(ctx: ToolCallContext, pageId?: string): HandlerResult {
    if (pageId !== undefined) this.resolvePageRoot(pageId);
    const items = this.doc.mainComponents
      .filter((m) => pageId === undefined || this.doc.pageIdOf(m.id) === pageId)
      .map((m) => {
        const c = this.coords(m.id);
        const pid = this.doc.pageIdOf(m.id);
        return {
          id: m.id,
          name: m.label,
          pageId: pid,
          pageName: pid ? (this.doc.page(pid)?.label ?? null) : null,
          instanceCount: this.doc.instancesByMain.get(m.id)?.length ?? 0,
          width: c.width,
          height: c.height,
        };
      });
    this.activity.recordRead(ctx, items.map((i) => i.id));
    return { data: { components: items, count: items.length } };
  }

  private async detachInstance(ctx: ToolCallContext, id: string): Promise<HandlerResult> {
    const n = this.nodeOrThrow(id);
    if (this.doc.isVirtual(id)) return { error: 'Only the instance itself can be detached (not a node inside it)' };
    if (!n.instanceOf) return { error: `Node ${id} is not a component instance` };
    let map: Record<string, string> = {};
    this.mutate(() => {
      map = this.doc.detachInstance(id);
    });
    this.activity.recordWrite(ctx, [id], 'edit');
    await this.settle();
    return { data: { nodeId: id, descendantIdMap: map } };
  }

  private async resetOverrides(ctx: ToolCallContext, id: string): Promise<HandlerResult> {
    const n = this.nodeOrThrow(id);
    if (!this.doc.isVirtual(id) && !n.instanceOf) return { error: `Node ${id} is not a component instance (or a node inside one)` };
    this.mutate(() => this.doc.resetOverrides(id));
    this.activity.recordWrite(ctx, [id], 'edit');
    await this.settle();
    return { data: { nodeId: id, reset: true } };
  }

  get doc(): DocStore {
    return this.rc.doc;
  }
  private get session(): FileSession {
    return this.rc.session;
  }
  private get m(): Measurer {
    return this.rc.measurer;
  }

  // ==================================================================== despacho

  async handleToolCall(ctx: ToolCallContext, name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
    const def = TOOL_BY_NAME.get(name);
    const handler = this.handlers[name];
    if (!def || !handler) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    const parsed = schemaWithFileId(def).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `Invalid arguments for ${name}: ${parsed.error.message}\nRetry once with corrected arguments; if it keeps failing, ask the user to restart the MCP connection to refresh tool definitions.` }],
        isError: true,
      };
    }
    const args = parsed.data as Args;
    console.log(`[moki-mcp] ${name}`, JSON.stringify(args).slice(0, 300));
    if (def.scope !== 'app') await this.m.whenMeasured(5000);

    let result: HandlerResult;
    try {
      if (def.gate === 'write' && !this.session.sync.connected) {
        throw new UserError('The file is currently disconnected from the Moki server. Try again in a moment.');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<HandlerResult>((resolve) => {
        timer = setTimeout(() => resolve({ error: 'Tool call timed out. Please check your file then try again.' }), TOOL_TIMEOUT_MS);
      });
      result = await Promise.race([Promise.resolve().then(() => handler(ctx, args)), timeout]);
      clearTimeout(timer);
    } catch (e) {
      if (e instanceof UserError) result = { error: e.message };
      else {
        console.error('[moki-mcp] handler error', e);
        result = { error: e instanceof Error ? e.message : String(e) };
      }
    } finally {
      this.doc.flush();
    }
    return this.toToolResult(def, result);
  }

  removeAgent(sessionId: string) {
    this.activity.removeAgent(sessionId);
  }

  private toToolResult(def: ToolDef, r: HandlerResult): ToolResult {
    let out: ToolResult;
    if ('content' in r) out = { content: r.content, ...(r.isError ? { isError: true } : {}) };
    else if ('error' in r) out = { content: [{ type: 'text', text: r.error }], isError: true };
    else if ('data' in r) out = { content: [{ type: 'text', text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2) }] };
    else out = { content: [{ type: 'text', text: 'Unexpected result format' }], isError: true };
    const pre: ToolContent[] = [];
    if (def.scope !== 'app') {
      pre.push({
        type: 'text',
        text: JSON.stringify({ file: { id: this.doc.data.id, name: this.doc.data.name ?? null }, contentHash: { tokens: tokensContentHash(this.doc.data) } }, null, 2),
      });
    }
    if (JSON.stringify(this.doc.data).length >= FILE_SIZE_LIMIT_BYTES) {
      pre.push({ type: 'text', text: 'Warning: this file is too large. Continuing to add content may cause data loss — move work to a new file.' });
    }
    return { ...out, content: [...pre, ...out.content] };
  }

  // ==================================================================== helpers

  /** Página que ve el usuario (pestaña humana más reciente) o la primera. */
  activePageId(): string {
    const human = this.session.primaryHuman;
    const pid = human?.pageId;
    if (pid && this.doc.canvasPages.some((p) => p.id === pid)) return pid;
    return this.doc.canvasPages[0]!.id;
  }

  private resolvePageRoot(pageId?: string): { pageId: string; rootId: string } {
    const pid = pageId ?? this.activePageId();
    const page = this.doc.data.pages.find((p) => p.id === pid && !p['~']);
    if (!page) throw new UserError(`Page not found: ${pid}. Use get_basic_info to list pages.`);
    if (page.isDivider) throw new UserError(`${pid} is a divider in the page list and has no canvas. Use a page ID.`);
    const rootId = `root_node_${pid}`;
    if (!this.doc.view(rootId)) throw new UserError(`The root node of page ${pid} is missing.`);
    return { pageId: pid, rootId };
  }

  private nodeOrThrow(id: string): TreeNode {
    const n = this.doc.view(id);
    if (!n) throw new UserError(`Node not found: ${id}. Use get_tree_summary or get_children to find valid node IDs.`);
    return n;
  }

  /** Tamaño y posición de un nodo (§ coordenadas). */
  coords(id: string): { width: number | null; height: number | null; worldX: number | null; worldY: number | null; x: number | null; y: number | null } {
    const n = this.doc.view(id);
    const r = this.m.worldRect(id);
    const parentId = this.doc.parentId(id);
    if (r) {
      let x = r.x;
      let y = r.y;
      if (parentId && !isRootId(parentId)) {
        const pr = this.m.worldRect(parentId);
        if (pr) {
          x = r.x - pr.x;
          y = r.y - pr.y;
        }
      }
      return { width: r.width ? round(r.width) : null, height: r.height ? round(r.height) : null, worldX: round(r.x), worldY: round(r.y), x: round(x), y: round(y) };
    }
    const w = n ? pxValue(n.styles.width as StyleValue | undefined) : null;
    const h = n ? pxValue(n.styles.height as StyleValue | undefined) : null;
    const left = n ? pxValue(n.styles.left as StyleValue | undefined) : null;
    const top = n ? pxValue(n.styles.top as StyleValue | undefined) : null;
    const size = { width: w || null, height: h || null };
    if (left === null || top === null) return { ...size, worldX: null, worldY: null, x: null, y: null };
    let wx = left;
    let wy = top;
    let ok = true;
    for (const a of this.doc.ancestors(id)) {
      if (isRootId(a)) break;
      const ar = this.m.worldRect(a);
      if (ar) {
        wx += ar.x;
        wy += ar.y;
        break;
      }
      const an = this.doc.view(a)!;
      const al = pxValue(an.styles.left as StyleValue | undefined);
      const at = pxValue(an.styles.top as StyleValue | undefined);
      if (al === null || at === null) {
        ok = false;
        break;
      }
      wx += al;
      wy += at;
    }
    return { ...size, worldX: ok ? wx : null, worldY: ok ? wy : null, x: left, y: top };
  }

  private rectOf(id: string): Rect | null {
    const r = this.m.worldRect(id);
    if (r) return r;
    const c = this.coords(id);
    if (c.worldX === null || c.worldY === null) return null;
    return { x: c.worldX, y: c.worldY, width: c.width ?? 0, height: c.height ?? 0 };
  }

  private visibleAreaFor(pageId: string): Rect | null {
    const human = this.session.primaryHuman;
    if (!human || human.pageId !== pageId || !human.cameraView) return null;
    const v = human.cameraView;
    return { x: v.minX, y: v.minY, width: v.maxX - v.minX, height: v.maxY - v.minY };
  }

  private mutate<T>(fn: () => T): T {
    return this.doc.withoutUndo(fn);
  }

  private async settle() {
    this.doc.flush();
    await this.m.whenMeasured(3000);
  }

  private brief(id: string) {
    const n = this.doc.view(id)!;
    const c = this.coords(id);
    return { id, name: n.label, component: n.component, worldX: c.worldX, worldY: c.worldY, x: c.x, y: c.y };
  }

  private truncatedMsg(shown: number, total: number, what: string) {
    return { truncated: true, truncatedMessage: `Showing ${shown} of ${total} ${what}.` };
  }

  // ==================================================================== lectura

  private pageListItems() {
    const active = this.activePageId();
    return this.doc.pages.map((p) =>
      p.isDivider ? { type: 'divider' as const, id: p.id } : { type: 'page' as const, id: p.id, name: p.label, icon: p.icon ?? null, isActive: p.id === active },
    );
  }

  private documentFontFamilies(): string[] {
    const set = new Set<string>();
    for (const n of Object.values(this.doc.data.nodes)) {
      if (n['~']) continue;
      const f = n.styles.fontFamily;
      if (f === undefined) continue;
      const ext = computeNodeStyle(n, { file: this.doc.data, parent: null, mode: 'resolved' }).fontFamily ?? String(f);
      const first = ext.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
      if (first) set.add(first);
    }
    return [...set];
  }

  private sortedTokens() {
    return liveTokens(this.doc.data)
      .slice()
      .sort((a, b) => TOKEN_TYPE_ORDER.indexOf(a.type) - TOKEN_TYPE_ORDER.indexOf(b.type) || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  }

  getBasicInfo(pageId?: string): HandlerResult {
    const { pageId: pid, rootId } = this.resolvePageRoot(pageId);
    const page = this.doc.page(pid)!;
    const artboardIds = this.doc.childIds(rootId).filter((id) => this.doc.isArtboard(id));
    const artboards = artboardIds.slice(0, MAX_LIST).map((id) => {
      const n = this.doc.view(id)!;
      const c = this.coords(id);
      return { id, name: n.label, childCount: this.doc.childIds(id).length, width: c.width, height: c.height, worldX: c.worldX, worldY: c.worldY };
    });
    return {
      data: {
        fileName: this.doc.data.name,
        pageName: page.label,
        pageId: pid,
        url: `${location.origin}/file/${this.doc.data.id}/${pid}`,
        rootNodeId: rootId,
        nodeCount: this.doc.descendants(rootId).length + 1,
        artboardCount: artboardIds.length,
        artboards,
        ...(artboardIds.length > MAX_LIST ? this.truncatedMsg(MAX_LIST, artboardIds.length, 'artboards') : {}),
        pages: this.pageListItems(),
        fontFamilies: this.documentFontFamilies(),
        tokens: { items: this.sortedTokens().map((t) => ({ name: cssNameOf(t), value: externalCssValue(this.doc.data, t) })) },
      },
    };
  }

  private getSelection(ctx: ToolCallContext): HandlerResult {
    const ids = (this.session.primaryHuman?.selectedNodes ?? []).filter((id) => this.doc.view(id));
    const shown = ids.slice(0, MAX_LIST);
    const selectedNodes = shown.map((id) => {
      const n = this.doc.view(id)!;
      const ab = this.doc.artboardOf(id);
      return {
        id,
        name: n.label,
        component: n.component,
        ...this.coords(id),
        artboardId: ab,
        artboardName: ab ? this.doc.view(ab)!.label : null,
        parentId: this.doc.parentId(id),
        childCount: this.doc.childIds(id).length,
      };
    });
    if (shown.length) this.activity.recordRead(ctx, shown);
    return { data: { selectedNodes, count: ids.length, ...(ids.length > MAX_LIST ? this.truncatedMsg(MAX_LIST, ids.length, 'selected nodes') : {}) } };
  }

  private getNodeInfo(ctx: ToolCallContext, id: string): HandlerResult {
    const n = this.nodeOrThrow(id);
    const kids = this.doc.childIds(id);
    this.activity.recordRead(ctx, [id]);
    return {
      data: {
        id,
        name: n.label,
        component: n.component,
        ...this.coords(id),
        isVisible: n.isVisible !== false,
        isLocked: this.doc.isEffectivelyLocked(id),
        parentId: this.doc.parentId(id),
        childIds: kids.slice(0, MAX_LIST),
        childCount: kids.length,
        artboardId: this.doc.artboardOf(id),
        textContent: n.component === 'Text' ? (n.textValue ?? '') : null,
        ...(n.isComponent ? { isComponent: true, instanceCount: this.doc.instancesByMain.get(id)?.length ?? 0 } : {}),
        ...(n.instanceOf ? { instanceOf: n.instanceOf, componentName: this.doc.data.nodes[n.instanceOf]?.label ?? null } : {}),
        ...(this.doc.isVirtual(id) ? { insideInstance: id.split('::')[0], note: 'Inside a component instance: update_styles / set_text_content write instance overrides; structure comes from the main component.' } : {}),
        ...(kids.length > MAX_LIST ? this.truncatedMsg(MAX_LIST, kids.length, 'child IDs') : {}),
      },
    };
  }

  private getChildren(ctx: ToolCallContext, id: string): HandlerResult {
    this.nodeOrThrow(id);
    const kids = this.doc.childIds(id);
    const shown = kids.slice(0, MAX_LIST);
    this.activity.recordRead(ctx, shown.length ? shown : [id]);
    return {
      data: {
        children: shown.map((c) => {
          const n = this.doc.view(c)!;
          const co = this.coords(c);
          return { id: c, name: n.label, component: n.component, childCount: this.doc.childIds(c).length, worldX: co.worldX, worldY: co.worldY, x: co.x, y: co.y };
        }),
        count: kids.length,
        ...(kids.length > MAX_LIST ? this.truncatedMsg(MAX_LIST, kids.length, 'children') : {}),
      },
    };
  }

  private getTreeSummary(ctx: ToolCallContext, id: string, depthArg?: number): HandlerResult {
    this.nodeOrThrow(id);
    const depth = Math.max(1, Math.min(10, Math.round(depthArg ?? 3)));
    const lines: string[] = [];
    const LIMIT = 1000;
    let count = 0;
    let truncated = false;
    const fmt = (v: number | null) => (v === null ? '?' : String(Math.round(v)));
    const walk = (nid: string, level: number) => {
      if (count >= LIMIT) {
        truncated = true;
        return;
      }
      count++;
      const n = this.doc.view(nid)!;
      const c = this.coords(nid);
      const pad = '  '.repeat(level);
      let line = `${pad}${isRootId(nid) ? 'Page' : n.component} "${n.label}" (${nid}) ${fmt(c.width)}×${fmt(c.height)}`;
      if (n.component === 'Text') {
        const t = (n.textValue ?? '').replace(/\n/g, '⏎');
        line += ` "${t.length > 60 ? t.slice(0, 60) + '…' : t}"`;
      }
      if (n.isComponent) line += ' [component]';
      if (n.instanceOf) line += ` [instance of "${this.doc.data.nodes[n.instanceOf]?.label ?? 'missing component'}"]`;
      if (n.isVisible === false) line += ' [hidden]';
      lines.push(line);
      const kids = this.doc.childIds(nid);
      if (kids.length === 0) return;
      if (level >= depth) {
        lines.push(`${pad}  ... ${kids.length} ${kids.length === 1 ? 'child' : 'children'}`);
        return;
      }
      for (const k of kids) walk(k, level + 1);
    };
    walk(id, 0);
    this.activity.recordRead(ctx, [id]);
    return {
      data: {
        summary: lines.join('\n'),
        nodeId: id,
        depth,
        ...(truncated ? { truncated: true, truncatedMessage: `Output truncated at ${LIMIT} nodes. Summarize a deeper node or lower the depth.` } : {}),
      },
    };
  }

  private async getScreenshot(ctx: ToolCallContext, id: string, scaleArg?: number): Promise<HandlerResult> {
    const n = this.doc.view(id);
    if (!n) return { content: [{ type: 'text', text: `Node not found: ${id}` }], isError: true };
    if (isRootId(id)) return { content: [{ type: 'text', text: 'Cannot screenshot a page root node. Screenshot an artboard instead.' }], isError: true };
    let scale = (scaleArg ?? 1) >= 2 ? 2 : 1;
    const r = this.rectOf(id);
    const notes: string[] = [];
    if (r && Math.max(r.width, r.height) * scale > 2000) {
      scale = 2000 / Math.max(r.width, r.height);
      notes.push(`Image was resized to ${Math.round(r.width * scale)}×${Math.round(r.height * scale)} to fit the 2000 px limit.`);
    }
    this.doc.flush();
    const res = await this.session.sync.rpc('capture', { nodeId: id, scale, format: 'jpeg', quality: 92, backdrop: 'visible' });
    this.activity.recordRead(ctx, [id]);
    const content: ToolContent[] = [{ type: 'image', data: res.data, mimeType: res.mimeType }];
    if (r && res.width && Math.abs(res.width - r.width * scale) > 2 && !notes.length) {
      notes.push(`Image was resized to ${res.width}×${res.height}.`);
    }
    for (const t of notes) content.push({ type: 'text', text: t });
    return { content };
  }

  private getJsx(ctx: ToolCallContext, a: Args): HandlerResult {
    const n = this.doc.view(a.nodeId);
    if (!n) return { error: `Node not found: ${a.nodeId}` };
    try {
      const jsx = generateJsx(this.doc, a.nodeId, { format: a.format, includeNodeIds: a.includeNodeIds, includeRootPositioning: a.includeRootPositioning });
      this.activity.recordRead(ctx, [a.nodeId]);
      return { data: jsx };
    } catch (e) {
      return { error: `JSX generation failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private getComputedStyles(ctx: ToolCallContext, ids: string[]): HandlerResult {
    const styles: Record<string, Record<string, string> | null> = {};
    const found: string[] = [];
    for (const id of ids) {
      const n = this.doc.view(id);
      if (!n) {
        styles[id] = null;
        continue;
      }
      found.push(id);
      const s = computeNodeStyle(n, { file: this.doc.data, parent: this.doc.parent(id), mode: 'external' });
      for (const [k, v] of Object.entries(s)) if (v === null || v === undefined || v === '') delete s[k];
      styles[id] = compactStyles(s);
    }
    if (found.length) this.activity.recordRead(ctx, found);
    return { data: { styles } };
  }

  private async getFillImage(ctx: ToolCallContext, id: string): Promise<HandlerResult> {
    const n = this.nodeOrThrow(id);
    if (n.component === 'SVG' || n.component === 'SVGVisualElement') {
      return { data: `Node ${id} is an SVG, not an image fill. Use get_jsx to read its markup.` };
    }
    const bg = [n.styles.backgroundImage, n.styles.background].filter((v) => v !== undefined).map(String).join(' ');
    const urls = [...bg.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => m[2]!);
    const url = urls[urls.length - 1];
    if (!url) return { data: `Node ${id} does not have an image fill.` };
    this.activity.recordRead(ctx, [id]);
    try {
      const res = await this.session.sync.rpc('readImageForAgent', { url });
      const meta: Record<string, unknown> = { originalUrl: url, mimeType: res.mimeType, width: res.originalWidth, height: res.originalHeight };
      if (res.width !== res.originalWidth) meta.note = `Image was resized to ${res.width}×${res.height}.`;
      return { content: [{ type: 'image', data: res.data, mimeType: res.mimeType }, { type: 'text', text: JSON.stringify(meta, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not load the image fill (${url}); the URL may have expired or be unreachable. ${e instanceof Error ? e.message : ''}` }], isError: true };
    }
  }

  private findNodes(ctx: ToolCallContext, a: Args): HandlerResult {
    let scope: string[];
    if (a.nodeId) {
      this.nodeOrThrow(a.nodeId);
      scope = [a.nodeId, ...this.doc.descendants(a.nodeId)];
    } else if (a.pageId) {
      const { rootId } = this.resolvePageRoot(a.pageId);
      scope = this.doc.descendants(rootId);
    } else {
      scope = this.doc.canvasPages.flatMap((p) => this.doc.descendants(`root_node_${p.id}`));
    }
    const LIMIT = 200;
    const out: { id: string; name: string; component: string; matched: unknown[] }[] = [];
    let truncated = false;
    for (const id of scope) {
      const n = this.doc.view(id);
      if (!n || isRootId(id)) continue;
      const m = matchNode(this.doc.data, n, { textValue: a.textValue, filters: a.filters as StyleFilter[] | undefined });
      if (!m) continue;
      if (out.length >= LIMIT) {
        truncated = true;
        break;
      }
      out.push({ id, name: n.label, component: n.component, matched: m });
    }
    if (out.length) this.activity.recordRead(ctx, out.map((o) => o.id));
    return {
      data: {
        nodes: out,
        count: out.length,
        ...(truncated ? { truncated: true, truncatedMessage: `Showing the first ${LIMIT} matches. Narrow the search with nodeId or pageId.` } : {}),
      },
    };
  }

  private catalog(): Promise<FontCatalog> {
    this.fontCatalog ??= fetch('/fonts/catalog.json')
      .then((r) => r.json() as Promise<FontCatalog>)
      .catch(() => ({ families: [] }));
    return this.fontCatalog;
  }

  private async getFontFamilyInfo(names: string[]): Promise<HandlerResult> {
    const cat = await this.catalog();
    await document.fonts.ready;
    const fontsPerFamily: Record<string, unknown[]> = {};
    const errors: string[] = [];
    for (const raw of names) {
      const name = raw.trim().replace(/^['"]|['"]$/g, '');
      const fam = cat.families.find((f) => f.family.toLowerCase() === name.toLowerCase());
      if (fam) {
        const list: unknown[] = [];
        for (const st of fam.styles) {
          for (let w = Math.ceil(st.minWeight / 100) * 100; w <= st.maxWeight; w += 100) {
            const wn = WEIGHT_NAMES[w] ?? String(w);
            list.push({
              style: st.isItalic ? (w === 400 ? 'Italic' : `${wn} Italic`) : wn,
              weight: w,
              isItalic: st.isItalic,
              ...(fam.variable ? { axes: [{ tag: 'wght', min: st.minWeight, max: st.maxWeight, default: Math.min(Math.max(400, st.minWeight), st.maxWeight) }] } : {}),
            });
          }
        }
        fontsPerFamily[fam.family] = list;
        continue;
      }
      if (GENERIC_FAMILIES.has(name.toLowerCase()) || systemFontAvailable(name)) {
        fontsPerFamily[name] = [
          { style: 'Regular', weight: 400, isItalic: false },
          { style: 'Italic', weight: 400, isItalic: true },
          { style: 'Bold', weight: 700, isItalic: false },
          { style: 'Bold Italic', weight: 700, isItalic: true },
        ];
        continue;
      }
      errors.push(`Font family "${name}" is not available. Bundled families: ${cat.families.map((f) => f.family).join(', ')}. Generic families (system-ui, sans-serif, serif, monospace) also work.`);
    }
    return { data: { ...(Object.keys(fontsPerFamily).length ? { fontsPerFamily } : {}), ...(errors.length ? { errors } : {}) } };
  }

  // ==================================================================== comentarios

  private async threadsReady() {
    const deadline = Date.now() + 5000;
    while (!this.session.threadsLoaded) {
      if (Date.now() > deadline) throw new UserError('Comment threads could not be loaded. Try again in a moment.');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private visibleThreads(): CommentThread[] {
    return [...this.session.threads.values()]
      .filter((t) => !t.deletedAt)
      .map((t) => ({ ...t, messages: t.messages.filter((m) => !m.deletedAt) }))
      .filter((t) => t.messages.length > 0);
  }

  private nodeContext(nodeId: string) {
    const n = this.doc.view(nodeId);
    if (!n) return null;
    if (isRootId(nodeId)) return { id: nodeId, name: '(page root)', component: 'PageRoot' };
    return { id: nodeId, name: n.label, component: n.component };
  }

  private resolveUser(u: string | undefined): string | undefined {
    return u === 'current-user' ? LOCAL_USER.id : u;
  }

  private displayName(_userId: string) {
    return LOCAL_USER.name;
  }

  private async listCommentThreads(ctx: ToolCallContext, a: Args): Promise<HandlerResult> {
    await this.threadsReady();
    const pageFilter = a.pageId ?? (a.currentPageOnly ? this.activePageId() : undefined);
    const status = a.status ?? 'open';
    const search = typeof a.search === 'string' ? a.search.toLowerCase() : undefined;
    const participant = this.resolveUser(a.participantUserId);
    const author = this.resolveUser(a.threadAuthorUserId);
    const previewLength = a.previewLength ?? 240;
    let threads = this.visibleThreads().filter((t) => {
      if (pageFilter && t.pageId !== pageFilter) return false;
      if (a.nodeId && t.nodeId !== a.nodeId) return false;
      if (status !== 'all' && t.status !== status) return false;
      if (author && t.userId !== author) return false;
      if (participant && t.userId !== participant && !t.messages.some((m) => m.userId === participant)) return false;
      if (search) {
        const msgs = a.searchScope === 'first-message' ? t.messages.slice(0, 1) : t.messages;
        const hay = msgs.map((m) => `${this.displayName(m.userId)} ${m.text}`).join('\n').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    const pageOrder = new Map(this.doc.pages.map((p, i) => [p.id, i]));
    const dir = a.sortDirection === 'desc' ? -1 : 1;
    const field = a.sortField ?? 'page';
    threads.sort((x, y) => {
      if (field === 'page') return dir * ((pageOrder.get(x.pageId) ?? 0) - (pageOrder.get(y.pageId) ?? 0) || x.createdAt - y.createdAt);
      return dir * ((x as unknown as Record<string, number>)[field]! - (y as unknown as Record<string, number>)[field]!);
    });
    const total = threads.length;
    const offset = a.offset ?? 0;
    const limit = a.limit ?? 50;
    threads = threads.slice(offset, offset + limit);
    const anchored = threads.map((t) => t.nodeId).filter((id) => this.doc.view(id) && !isRootId(id));
    if (anchored.length) this.activity.recordRead(ctx, anchored);
    return {
      data: {
        commentThreads: threads.map((t) => {
          const first = t.messages[0]!;
          const tr = truncateText(first.text, previewLength);
          return {
            commentThreadId: t.id,
            pageId: t.pageId,
            pageName: this.doc.page(t.pageId)?.label ?? null,
            nodeId: t.nodeId,
            node: this.nodeContext(t.nodeId),
            status: t.status,
            createdAt: new Date(t.createdAt).toISOString(),
            updatedAt: new Date(t.updatedAt).toISOString(),
            messageCount: t.messages.length,
            replyCount: Math.max(0, t.messages.length - 1),
            authorUserId: t.userId,
            authorDisplayName: this.displayName(t.userId),
            firstMessagePreview: {
              messageId: first.id,
              authorUserId: first.userId,
              authorDisplayName: this.displayName(first.userId),
              text: tr.text,
              truncated: tr.truncated,
              createdAt: new Date(first.createdAt).toISOString(),
              updatedAt: new Date(first.updatedAt).toISOString(),
            },
          };
        }),
        count: total,
        offset,
        ...(offset + threads.length < total ? { truncated: true, truncatedMessage: `Showing ${threads.length} of ${total} threads. Use offset to page.` } : {}),
      },
    };
  }

  private async getCommentThread(ctx: ToolCallContext, id: string): Promise<HandlerResult> {
    await this.threadsReady();
    const t = this.visibleThreads().find((x) => x.id === id);
    if (!t) throw new UserError(`Comment thread not found: ${id}`);
    if (this.doc.view(t.nodeId) && !isRootId(t.nodeId)) this.activity.recordRead(ctx, [t.nodeId]);
    return {
      data: {
        commentThreadId: t.id,
        pageId: t.pageId,
        pageName: this.doc.page(t.pageId)?.label ?? null,
        nodeId: t.nodeId,
        node: this.nodeContext(t.nodeId),
        status: t.status,
        xOffset: t.xOffset,
        yOffset: t.yOffset,
        createdAt: new Date(t.createdAt).toISOString(),
        updatedAt: new Date(t.updatedAt).toISOString(),
        authorUserId: t.userId,
        authorDisplayName: this.displayName(t.userId),
        messageCount: t.messages.length,
        replyCount: Math.max(0, t.messages.length - 1),
        messages: t.messages.map((m) => ({
          messageId: m.id,
          authorUserId: m.userId,
          authorDisplayName: this.displayName(m.userId),
          text: m.text,
          mentions: m.mentions,
          reactions: m.reactions,
          attachments: m.attachments,
          createdAt: new Date(m.createdAt).toISOString(),
          updatedAt: new Date(m.updatedAt).toISOString(),
        })),
      },
    };
  }

  private async listCommentThreadAuthors(pageId?: string): Promise<HandlerResult> {
    await this.threadsReady();
    const map = new Map<string, { userId: string; displayName: string; threadsStarted: number; messageCount: number; lastActivityAt: number }>();
    const get = (u: string) => {
      let e = map.get(u);
      if (!e) map.set(u, (e = { userId: u, displayName: this.displayName(u), threadsStarted: 0, messageCount: 0, lastActivityAt: 0 }));
      return e;
    };
    for (const t of this.visibleThreads()) {
      if (pageId && t.pageId !== pageId) continue;
      get(t.userId).threadsStarted++;
      for (const m of t.messages) {
        const e = get(m.userId);
        e.messageCount++;
        e.lastActivityAt = Math.max(e.lastActivityAt, m.createdAt);
      }
    }
    const authors = [...map.values()].map((e) => ({ ...e, lastActivityAt: e.lastActivityAt ? new Date(e.lastActivityAt).toISOString() : null }));
    return { data: { authors, count: authors.length } };
  }

  private async setCommentThreadStatus(id: string, status: 'open' | 'resolved'): Promise<HandlerResult> {
    await this.threadsReady();
    const t = this.visibleThreads().find((x) => x.id === id);
    if (!t) throw new UserError(`Comment thread not found: ${id}`);
    const ok = this.session.sync.send({ $t: MessageType.CommentThreadUpdate, threadId: id, status });
    if (!ok) throw new UserError('Could not update the comment thread right now. Please try again.');
    return { data: { commentThreadId: id, status } };
  }

  // ==================================================================== páginas

  private createPage(name?: string, icon?: PageIcon): HandlerResult {
    const pageId = this.mutate(() => {
      const id = this.doc.addPage({ label: name?.trim() || undefined, afterPageId: this.activePageId() });
      if (icon) this.doc.updatePage(id, { icon });
      return id;
    });
    const p = this.doc.page(pageId)!;
    return { data: { pageId, name: p.label, icon: p.icon ?? null } };
  }

  private updatePages(updates: { pageId: string; name?: string; icon?: PageIcon | null }[]): HandlerResult {
    if (!updates.length) return { error: 'No updates provided' };
    const out: unknown[] = [];
    const errors: { pageId: string; error: string }[] = [];
    this.mutate(() => {
      for (const u of updates) {
        const p = this.doc.data.pages.find((x) => x.id === u.pageId && !x['~']);
        if (!p) {
          errors.push({ pageId: u.pageId, error: 'Page not found' });
          continue;
        }
        if (p.isDivider) {
          errors.push({ pageId: u.pageId, error: 'This ID is a divider; dividers have no name or icon' });
          continue;
        }
        if (u.name === undefined && u.icon === undefined) {
          errors.push({ pageId: u.pageId, error: 'Nothing to update: pass name and/or icon' });
          continue;
        }
        this.doc.updatePage(u.pageId, { ...(u.name !== undefined ? { label: u.name } : {}), ...(u.icon !== undefined ? { icon: u.icon } : {}) } as Parameters<DocStore['updatePage']>[1]);
        const rootId = `root_node_${u.pageId}`;
        if (u.name !== undefined && this.doc.view(rootId)) this.doc.setLabel(rootId, u.name, false);
        out.push({ pageId: p.id, name: p.label, icon: p.icon ?? null });
      }
    });
    return { data: { updates: out, ...(errors.length ? { errors } : {}) } };
  }

  private arrangePages(order: (string | { type: 'divider' })[], removeDividerIds: string[] = []): HandlerResult {
    const existing = this.doc.pages;
    const byId = new Map(existing.map((p) => [p.id, p]));
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const item of order) {
      if (typeof item !== 'string') continue;
      if (seen.has(item)) problems.push(`"${item}" appears more than once in order`);
      seen.add(item);
      if (!byId.has(item)) problems.push(`"${item}" is not a page or divider of this file`);
    }
    for (const d of removeDividerIds) {
      const p = byId.get(d);
      if (!p) problems.push(`removeDividerIds: "${d}" does not exist`);
      else if (!p.isDivider) problems.push(`removeDividerIds: "${d}" is a page; only dividers can be removed`);
      if (seen.has(d)) problems.push(`"${d}" is both in order and in removeDividerIds`);
    }
    for (const p of existing) {
      if (!seen.has(p.id) && !removeDividerIds.includes(p.id)) problems.push(`${p.isDivider ? 'Divider' : 'Page'} "${p.id}"${p.isDivider ? '' : ` (${p.label})`} is missing from order`);
    }
    if (problems.length) {
      return { error: `No changes were made. Problems:\n${problems.map((x) => `- ${x}`).join('\n')}\nUse get_basic_info to see the current page list.` };
    }
    this.mutate(() => {
      for (const d of removeDividerIds) this.doc.deletePage(d);
      const finalIds: string[] = [];
      for (const item of order) {
        if (typeof item === 'string') finalIds.push(item);
        else finalIds.push(this.doc.addPage({ isDivider: true }));
      }
      this.doc.setPageOrder(finalIds);
    });
    return { data: { pages: this.pageListItems() } };
  }

  // ==================================================================== escritura de nodos

  private pageObstacles(rootId: string, exclude: Set<string> = new Set()): Rect[] {
    const out: Rect[] = [];
    for (const c of this.doc.childIds(rootId)) {
      if (exclude.has(c)) continue;
      const r = this.m.worldRect(c);
      if (r) {
        out.push(r);
        continue;
      }
      const n = this.doc.view(c)!;
      out.push({
        x: pxValue(n.styles.left as StyleValue | undefined) ?? 0,
        y: pxValue(n.styles.top as StyleValue | undefined) ?? 0,
        width: pxValue(n.styles.width as StyleValue | undefined) ?? 10000,
        height: pxValue(n.styles.height as StyleValue | undefined) ?? 10000,
      });
    }
    return out;
  }

  /** Sustituye url(http…|data:…) de los estilos por la copia local importada. */
  private async localizeStyleUrls<T extends Record<string, unknown>>(styles: T): Promise<{ styles: T; failed: string[] }> {
    const out: Record<string, unknown> = { ...styles };
    const failed: string[] = [];
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string' || !v.includes('url(')) continue;
      let next = v;
      for (const m of v.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const u = m[1]!;
        if (!/^(https?:|data:)/i.test(u) || isOwnAsset(u)) continue;
        try {
          const r = await this.session.sync.rpc('importImage', { src: u });
          next = next.split(u).join(r.url);
        } catch (e) {
          failed.push(`${u.slice(0, 120)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      out[k] = next;
    }
    return { styles: out as T, failed };
  }

  private async localizeUpdates(updates: { nodeIds: string[]; styles: Record<string, StyleValue | null> }[]) {
    const out = [];
    for (const u of updates) out.push({ ...u, styles: (await this.localizeStyleUrls(u.styles)).styles });
    return out;
  }

  private async createArtboard(ctx: ToolCallContext, a: Args): Promise<HandlerResult> {
    a = { ...a, styles: (await this.localizeStyleUrls(a.styles as Record<string, unknown>)).styles };
    const { pageId, rootId } = this.resolvePageRoot(a.pageId);
    const incoming = normalizeIncoming(this.doc.data, a.styles as Record<string, StyleValue | null>);
    const w = parseFloat(String(incoming.width ?? '')) || 1440;
    const h = parseFloat(String(incoming.height ?? '')) || 900;
    const pos = findPlacement({ obstacles: this.pageObstacles(rootId), width: w, height: h, padding: ARTBOARD_GAP, visibleArea: this.visibleAreaFor(pageId) });
    const base: Styles = { display: 'flex', flexDirection: 'column', overflow: 'clip' };
    if (incoming.background === undefined && incoming.backgroundColor === undefined && incoming.backgroundImage === undefined) base.backgroundColor = '#FFFFFF';
    const { styles } = computeAgentStyles(this.doc.data, base, { ...incoming, left: `${pos.x}px`, top: `${pos.y}px`, width: incoming.width ?? `${w}px`, height: incoming.height ?? `${h}px` }, {
      node: { component: 'Frame', id: 'new' },
      parent: this.doc.view(rootId),
    });
    delete styles.right;
    delete styles.bottom;
    const id = this.mutate(() => this.doc.createNode('Frame', rootId, { label: String(a.name ?? '').trim() || undefined, styles }));
    if (!this.doc.view(id)) return { error: 'Failed to create artboard' };
    this.mutate(() => {
      if (a.name) this.doc.setLabel(id, truncateLabel(String(a.name)));
    });
    this.activity.recordWrite(ctx, [id], 'write');
    await this.settle();
    const c = this.coords(id);
    return { data: { id, name: this.doc.view(id)!.label, worldX: c.worldX ?? pos.x, worldY: c.worldY ?? pos.y, width: c.width ?? w, height: c.height ?? h } };
  }

  /** Inserta un árbol de specs; devuelve el id raíz y acumula todos los ids creados. */
  private insertTree(tree: ParsedTree, parentId: string, sortKey: string, created: string[]): string {
    const spec = tree.node;
    const label = spec.label ?? (spec.component === 'Text' ? undefined : undefined);
    const id = this.doc.createNode(spec.component, parentId, {
      styles: { ...spec.styles },
      label: label ?? this.doc.autoLabel(spec.component === 'SVGVisualElement' ? 'Shape' : spec.component),
      textValue: spec.textValue,
      sortKey,
      tag: spec.tag,
      attrs: spec.attrs,
    });
    const n = this.doc.data.nodes[id]!;
    if (spec.labelIsModified) n.labelIsModified = true;
    if (spec.isVisible === false) n.isVisible = false;
    if (spec.isLocked) n.isLocked = true;
    if (spec.svgNonRendered) n.svgNonRendered = spec.svgNonRendered;
    if (spec.instanceOf) {
      if (!this.doc.components.canPlaceInstance(spec.instanceOf, parentId)) {
        throw new UserError('An instance cannot be placed inside its own component (it would create a cycle)');
      }
      n.instanceOf = spec.instanceOf;
      if (spec.overrides) n.overrides = toJS(spec.overrides);
    }
    if (spec.isComponent) n.isComponent = true;
    const extra = spec as unknown as Record<string, unknown>;
    if (extra.exportMeta) n.exportMeta = toJS(extra.exportMeta) as TreeNode['exportMeta'];
    created.push(id);
    const keys = keysBetween(null, null, tree.children.length);
    tree.children.forEach((c, i) => this.insertTree(c, id, keys[i]!, created));
    return id;
  }

  private async writeHtml(ctx: ToolCallContext, html: string, targetId: string, mode: 'insert-children' | 'replace'): Promise<HandlerResult> {
    const target = this.doc.view(targetId);
    if (!target) return { error: `Node not found: ${targetId}` };
    if (mode === 'replace' && isRootId(targetId)) return { error: 'Cannot replace a page root node' };
    if ((mode === 'insert-children' && this.doc.isInsideInstance(targetId)) || (mode === 'replace' && this.doc.isVirtual(targetId))) {
      return { error: INSTANCE_CHILDREN_ERROR };
    }
    if (mode === 'insert-children' && !canHaveChildren(target)) {
      return { error: `Node ${targetId} (${target.component}) cannot have children. Use mode "replace" or target its parent.` };
    }
    const parentId = mode === 'insert-children' ? targetId : (this.doc.parentId(targetId) ?? this.doc.rootOf(targetId)!);

    let parsed;
    try {
      parsed = await htmlToNodes(html, {
        doc: this.doc,
        insertionParentId: parentId,
        importImage: async (src) => {
          const r = await this.session.sync.rpc('importImage', { src });
          return { url: r.url, width: r.width, height: r.height };
        },
      });
    } catch (e) {
      return { error: `HTML parsing failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const notes = [...parsed.notes, ...parsed.errors];
    const trees = parsed.trees;
    if (trees.length === 0) return { error: 'HTML produced no design nodes' + (notes.length ? `. ${notes.join(' ')}` : '') };

    const created: string[] = [];
    const roots: string[] = [];
    const isAbs = (s: Styles) => s.position === 'absolute' || s.position === 'fixed';
    const pageId = this.doc.pageIdOf(parentId)!;

    if (mode === 'insert-children') {
      const targetIsRoot = isRootId(targetId);
      if (targetIsRoot) {
        for (const t of trees) {
          const s = t.node.styles;
          for (const k of ['position', 'top', 'left', 'right', 'bottom', 'inset', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'transform', 'translate', 'scale']) delete s[k];
          if (s.width === '100%') s.width = 'fit-content';
          if (s.height === '100%') s.height = 'fit-content';
        }
      }
      this.mutate(() => {
        if (!targetIsRoot && this.doc.isFreeform(targetId) && trees.some((t) => !isAbs(t.node.styles))) {
          // El contenedor libre pasa a columna flex; los hijos que tenía quedan absolutos.
          for (const c of this.doc.childIds(targetId)) {
            const cn = this.doc.view(c)!;
            if (!isAbs(cn.styles)) this.doc.setStyles(c, { position: 'absolute' });
          }
          const patch: Record<string, StyleValue> = { display: 'flex', flexDirection: 'column' };
          if (!this.doc.isArtboard(targetId) && !target.styles.position) patch.position = 'relative';
          this.doc.setStyles(targetId, patch);
        }
        const kids = this.doc.childIds(targetId);
        const last = kids.length ? this.doc.sortKey(kids[kids.length - 1]!) : null;
        const keys = keysBetween(last, null, trees.length);
        trees.forEach((t, i) => roots.push(this.insertTree(t, targetId, keys[i]!, created)));
      });
      if (targetIsRoot) {
        // Los nodos de primer nivel se colocan como artboards en huecos libres.
        await this.settle();
        const placed: Rect[] = [];
        for (const id of roots) {
          const r = this.m.worldRect(id);
          const w = r?.width || pxValue(this.doc.view(id)!.styles.width as StyleValue | undefined) || 400;
          const h = r?.height || pxValue(this.doc.view(id)!.styles.height as StyleValue | undefined) || 300;
          const exclude = new Set(roots);
          const pos = findPlacement({ obstacles: [...this.pageObstacles(targetId, exclude), ...placed], width: w, height: h, visibleArea: this.visibleAreaFor(pageId) });
          placed.push({ x: pos.x, y: pos.y, width: w, height: h });
          this.mutate(() => this.doc.setStyles(id, { left: `${pos.x}px`, top: `${pos.y}px` }));
        }
      }
    } else {
      const prevRect = this.rectOf(targetId);
      const targetStyles = toJS(target.styles);
      const parentFreeform = this.doc.isFreeform(parentId);
      const siblings = this.doc.childIds(parentId);
      const idx = siblings.indexOf(targetId);
      const prevKey = idx > 0 ? this.doc.sortKey(siblings[idx - 1]!) : null;
      const nextKey = idx >= 0 && idx + 1 < siblings.length ? this.doc.sortKey(siblings[idx + 1]!) : null;
      this.activity.recordWrite(ctx, [targetId], 'delete');
      this.mutate(() => {
        this.doc.deleteNodes([targetId]);
        const keys = keysBetween(prevKey, nextKey, trees.length);
        trees.forEach((t, i) => roots.push(this.insertTree(t, parentId, keys[i]!, created)));
        if (parentFreeform) {
          const parentRect = isRootId(parentId) ? { x: 0, y: 0 } : this.rectOf(parentId);
          for (const id of roots) {
            const patch: Record<string, StyleValue | null> = { right: null, bottom: null };
            if (targetStyles.left !== undefined && targetStyles.top !== undefined) {
              patch.left = targetStyles.left;
              patch.top = targetStyles.top;
            } else if (prevRect && parentRect) {
              patch.left = `${round(prevRect.x - parentRect.x)}px`;
              patch.top = `${round(prevRect.y - parentRect.y)}px`;
            }
            this.doc.setStyles(id, patch);
          }
        }
      });
    }
    this.activity.recordWrite(ctx, created, 'write');
    await this.settle();
    return {
      data: {
        ...(notes.length ? { note: notes.join(' ') } : {}),
        createdNodes: roots.map((id) => this.brief(id)),
      },
    };
  }

  private deleteNodes(ctx: ToolCallContext, ids: string[]): HandlerResult {
    for (const id of ids) {
      if (!this.doc.view(id)) return { error: `Node not found: ${id}` };
      if (isRootId(id)) return { error: 'Cannot delete a page root node' };
    }
    this.activity.recordWrite(ctx, ids, 'delete');
    this.mutate(() => this.doc.deleteNodes(ids));
    return { data: { deletedNodeIds: ids } };
  }

  private setTextContent(ctx: ToolCallContext, updates: { nodeId: string; textContent: string }[]): HandlerResult {
    if (!updates.length) return { error: 'No updates provided' };
    const out: unknown[] = [];
    const errors: { nodeId: string; error: string }[] = [];
    const touched: string[] = [];
    this.mutate(() => {
      for (const u of updates) {
        const n = this.doc.view(u.nodeId);
        if (!n) {
          errors.push({ nodeId: u.nodeId, error: 'Node not found' });
          continue;
        }
        if (n.component !== 'Text') {
          errors.push({ nodeId: u.nodeId, error: `Node is a ${n.component}, not a Text node` });
          continue;
        }
        this.doc.setText(u.nodeId, u.textContent);
        if (n.styles.overflowWrap !== undefined) this.doc.setStyles(u.nodeId, { overflowWrap: null });
        if (!n.labelIsModified) this.doc.setLabel(u.nodeId, textLabel(u.textContent) ?? n.label, false);
        touched.push(u.nodeId);
        out.push({ nodeId: u.nodeId, textContent: u.textContent });
      }
    });
    this.activity.recordWrite(ctx, touched, 'edit');
    return { data: { updates: out, ...(errors.length ? { errors } : {}) } };
  }

  private renameNodes(ctx: ToolCallContext, updates: { nodeId: string; name: string }[]): HandlerResult {
    if (!updates.length) return { error: 'No updates provided' };
    const out: unknown[] = [];
    const errors: { nodeId: string; error: string }[] = [];
    const touched: string[] = [];
    this.mutate(() => {
      for (const u of updates) {
        if (!this.doc.view(u.nodeId)) {
          errors.push({ nodeId: u.nodeId, error: 'Node not found' });
          continue;
        }
        if (this.doc.isVirtual(u.nodeId)) {
          errors.push({ nodeId: u.nodeId, error: 'Layers inside a component instance are named in the main component' });
          continue;
        }
        const name = truncateLabel(u.name);
        this.doc.setLabel(u.nodeId, name);
        touched.push(u.nodeId);
        out.push({ nodeId: u.nodeId, name });
      }
    });
    this.activity.recordWrite(ctx, touched, 'edit');
    return { data: { updates: out, ...(errors.length ? { errors } : {}) } };
  }

  private updateStyles(ctx: ToolCallContext, updates: { nodeIds: string[]; styles: Record<string, StyleValue | null> }[]): HandlerResult {
    if (!updates.length) return { error: 'No updates provided' };
    const out: { nodeId: string; ignoredStyles?: string[] }[] = [];
    const errors: { nodeId: string; error: string }[] = [];
    const touched: string[] = [];
    this.mutate(() => {
      for (const u of updates) {
        for (const id of u.nodeIds) {
          const n = this.doc.view(id);
          if (!n) {
            errors.push({ nodeId: id, error: 'Node not found' });
            continue;
          }
          if (isRootId(id)) {
            errors.push({ nodeId: id, error: 'Cannot set styles on a page root node' });
            continue;
          }
          const hasAbsoluteChildren = this.doc.childIds(id).some((c) => {
            const p = this.doc.view(c)?.styles.position;
            return p === 'absolute' || p === 'fixed';
          });
          // En la raíz de una instancia se escribe sobre sus estilos propios (el resto viene del main).
          const own = this.doc.isInstance(id) ? this.doc.node(id)! : n;
          const { styles, ignoredStyles } = computeAgentStyles(this.doc.data, toJS(own.styles), u.styles, {
            node: n,
            parent: this.doc.parent(id),
            hasAbsoluteChildren,
          });
          this.doc.replaceStyles(id, styles);
          touched.push(id);
          out.push({ nodeId: id, ...(ignoredStyles.length ? { ignoredStyles } : {}) });
        }
      }
    });
    this.activity.recordWrite(ctx, touched, 'edit');
    return { data: { updates: out, ...(errors.length ? { errors } : {}) } };
  }

  private async duplicateNodes(ctx: ToolCallContext, items: { id: string; parentId?: string }[]): Promise<HandlerResult> {
    if (!items.length) return { error: 'No node IDs provided' };
    for (const it of items) {
      const n = this.doc.view(it.id);
      if (!n) return { error: `Node not found: ${it.id}` };
      if (isRootId(it.id)) return { error: 'Cannot duplicate a page root node' };
      if (this.doc.isVirtual(it.id)) return { error: `Cannot duplicate ${it.id}: it is inside a component instance (duplicate the instance or edit the main component)` };
      if (it.parentId !== undefined) {
        const p = this.doc.view(it.parentId);
        if (!p) return { error: `Target parent not found: ${it.parentId}` };
        if (this.doc.isInsideInstance(it.parentId)) return { error: INSTANCE_CHILDREN_ERROR };
        if (!canHaveChildren(p)) return { error: `Target parent ${it.parentId} cannot have children` };
      }
    }
    const results: { sourceId: string; newId: string; map: Record<string, string> }[] = [];
    const lastAfter = new Map<string, string>(); // padre|original → último clon colocado
    const newIds = new Set<string>();
    const placed: Rect[] = [];
    // Obstáculos de cada página antes de clonar.
    for (const it of items) {
      const srcParent = this.doc.parentId(it.id)!;
      const parent = it.parentId ?? srcParent;
      this.mutate(() => {
        let key: string;
        if (parent === srcParent) {
          const anchor = lastAfter.get(`${parent}|${it.id}`) ?? it.id;
          key = this.doc.sortKeysAfter(parent, anchor, 1)[0]!;
        } else {
          key = this.doc.sortKeyForIndex(parent);
        }
        const res = this.doc.cloneNode(it.id, parent, key)!;
        lastAfter.set(`${parent}|${it.id}`, res.newId);
        newIds.add(res.newId);
        results.push({ sourceId: it.id, newId: res.newId, map: res.map });
      });
      const res = results[results.length - 1]!;
      if (isRootId(parent)) {
        // Artboard duplicado: hueco libre junto al original.
        const anchor = this.rectOf(it.id);
        const w = anchor?.width ?? (pxValue(this.doc.view(res.newId)!.styles.width as StyleValue | undefined) ?? 400);
        const h = anchor?.height ?? (pxValue(this.doc.view(res.newId)!.styles.height as StyleValue | undefined) ?? 300);
        const pageId = this.doc.pageIdOf(parent)!;
        const pos = findPlacement({
          obstacles: [...this.pageObstacles(parent, newIds), ...placed],
          width: w,
          height: h,
          anchor,
          visibleArea: this.visibleAreaFor(pageId),
        });
        placed.push({ x: pos.x, y: pos.y, width: w, height: h });
        this.mutate(() => this.doc.setStyles(res.newId, { left: `${pos.x}px`, top: `${pos.y}px`, right: null, bottom: null }));
      }
    }
    const allCreated = results.flatMap((r) => Object.values(r.map));
    this.activity.recordWrite(ctx, allCreated, 'write');
    await this.settle();
    return {
      data: {
        duplicatedNodes: results.map((r) => {
          const descendantIdMap: Record<string, string> = { ...r.map };
          delete descendantIdMap[r.sourceId];
          const b = this.brief(r.newId);
          return { sourceId: r.sourceId, newId: r.newId, name: b.name, component: b.component, worldX: b.worldX, worldY: b.worldY, x: b.x, y: b.y, descendantIdMap };
        }),
      },
    };
  }

  private moveNodes(ctx: ToolCallContext, moves: Args[]): HandlerResult {
    const out: { nodeId: string; parentId: string; index: number; note?: string }[] = [];
    const errors: { nodeId: string; error: string }[] = [];
    const affected = new Set<string>();
    const touched: string[] = [];
    for (const mv of moves) {
      const id = String(mv.nodeId);
      const n = this.doc.view(id);
      if (!n) {
        errors.push({ nodeId: id, error: 'Node not found' });
        continue;
      }
      if (isRootId(id)) {
        errors.push({ nodeId: id, error: 'Cannot move a page root node' });
        continue;
      }
      if (this.doc.isVirtual(id)) {
        errors.push({ nodeId: id, error: 'Nodes inside a component instance cannot be moved; edit the main component or detach the instance' });
        continue;
      }
      const oldParent = this.doc.parentId(id)!;
      let newParent: string;
      let key: string;
      let targetIndex: number;
      if (mv.before !== undefined || mv.after !== undefined) {
        const sib = String(mv.before ?? mv.after);
        if (!this.doc.view(sib)) {
          errors.push({ nodeId: id, error: `Sibling not found: ${sib}` });
          continue;
        }
        if (sib === id) {
          errors.push({ nodeId: id, error: 'A node cannot be moved relative to itself' });
          continue;
        }
        const sp = this.doc.parentId(sib);
        if (!sp) {
          errors.push({ nodeId: id, error: `Sibling ${sib} has no parent` });
          continue;
        }
        if (this.doc.isWithin(sp, id)) {
          errors.push({ nodeId: id, error: 'Cannot move a node into itself or one of its descendants' });
          continue;
        }
        if (this.doc.isInsideInstance(sp)) {
          errors.push({ nodeId: id, error: INSTANCE_CHILDREN_ERROR });
          continue;
        }
        newParent = sp;
        const list = this.doc.childIds(sp).filter((c) => c !== id);
        const si = list.indexOf(sib);
        targetIndex = mv.before !== undefined ? si : si + 1;
      } else {
        const pRaw = String(mv.parentId);
        const pid = pRaw === 'root' ? this.doc.rootOf(id)! : pRaw;
        const p = this.doc.view(pid);
        if (!p) {
          errors.push({ nodeId: id, error: `Parent not found: ${pRaw}` });
          continue;
        }
        if (!canHaveChildren(p)) {
          errors.push({ nodeId: id, error: `Parent ${pid} cannot have children` });
          continue;
        }
        if (this.doc.isInsideInstance(pid)) {
          errors.push({ nodeId: id, error: INSTANCE_CHILDREN_ERROR });
          continue;
        }
        if (this.doc.isWithin(pid, id)) {
          errors.push({ nodeId: id, error: 'Cannot move a node into itself or one of its descendants' });
          continue;
        }
        newParent = pid;
        const count = this.doc.childIds(pid).filter((c) => c !== id).length;
        targetIndex = mv.index === undefined ? count : Math.max(0, Math.min(Number(mv.index), count));
      }
      const others = this.doc.childIds(newParent).filter((c) => c !== id);
      if (newParent === oldParent && this.doc.childIds(oldParent).indexOf(id) === targetIndex) {
        out.push({ nodeId: id, parentId: newParent, index: targetIndex, note: 'Already in that position; nothing changed' });
        continue;
      }
      const prev = targetIndex > 0 ? this.doc.sortKey(others[targetIndex - 1]!) : null;
      const next = targetIndex < others.length ? this.doc.sortKey(others[targetIndex]!) : null;
      key = keyBetween(prev, next);
      const worldBefore = this.rectOf(id);
      const oldFreeform = this.doc.isFreeform(oldParent);
      this.mutate(() => {
        this.doc.moveNode(id, newParent, key);
        if (newParent !== oldParent) {
          const newFreeform = this.doc.isFreeform(newParent);
          if (newFreeform && worldBefore) {
            const pr = isRootId(newParent) ? { x: 0, y: 0 } : this.rectOf(newParent);
            if (pr) this.doc.setStyles(id, { left: `${round(worldBefore.x - pr.x)}px`, top: `${round(worldBefore.y - pr.y)}px`, right: null, bottom: null });
          } else if (!newFreeform && oldFreeform) {
            const patch: Record<string, null> = { left: null, top: null, right: null, bottom: null };
            this.doc.setStyles(id, n.styles.position === 'absolute' ? { ...patch, position: null } : patch);
          }
          if (n.isVisible === false) this.doc.setVisible(id, true);
        }
      });
      affected.add(oldParent);
      affected.add(newParent);
      touched.push(id);
      out.push({ nodeId: id, parentId: newParent, index: this.doc.childIds(newParent).indexOf(id) });
    }
    this.activity.recordWrite(ctx, touched, 'edit');
    const affectedParents = touched.length ? [...affected].map((p) => ({ parentId: p, childIds: this.doc.childIds(p) })) : [];
    return { data: { moves: out, ...(affectedParents.length ? { affectedParents } : {}), ...(errors.length ? { errors } : {}) } };
  }

  // ==================================================================== tokens

  private getTokens(a: Args): HandlerResult {
    const types = a.types as TokenType[] | undefined;
    const toks = this.sortedTokens().filter((t) => (!types || types.includes(t.type)) && (!a.namePattern || wildcardMatch(String(a.namePattern), cssNameOf(t))));
    const format = a.format ?? 'json';
    if (format === 'json') {
      return {
        data: {
          tokens: toks.map((t) => ({ name: cssNameOf(t), type: t.type, value: externalCssValue(this.doc.data, t), ...(t.description ? { description: t.description } : {}) })),
        },
      };
    }
    const body = toks.map((t) => `  ${cssNameOf(t)}: ${externalCssValue(this.doc.data, t)};`).join('\n');
    return { data: format === 'css' ? `:root {\n${body}\n}` : `@theme {\n${body}\n}` };
  }

  private createTokens(tokens: { type: TokenType; name: string; value: string | number; description?: string }[]): HandlerResult {
    const results: unknown[] = [];
    let count = 0;
    this.mutate(() => {
      for (const t of tokens) {
        const name = t.name.replace(/^--/, '');
        const parsed = parseTokenValue(this.doc.data, t.type, t.value);
        if (!parsed.ok) {
          results.push({ name: t.name, result: 'error', message: parsed.error });
          continue;
        }
        const dup = liveTokens(this.doc.data).find((x) => x.type === t.type && x.name === name && x.value === parsed.value);
        if (!dup) this.doc.createToken({ type: t.type, name, value: parsed.value, description: t.description?.trim() || undefined });
        results.push({ name: t.name, result: 'created' });
        count++;
      }
    });
    return { data: { tokens: results, count } };
  }

  private setTokens(tokens: { name: string; newName?: string; value?: string | number; description?: string; delete?: boolean }[]): HandlerResult {
    const results: unknown[] = [];
    let count = 0;
    this.mutate(() => {
      for (const u of tokens) {
        const t = tokenByCssName(this.doc.data, u.name);
        if (!t) {
          results.push({ name: u.name, result: 'error', message: `Token not found: ${u.name}` });
          continue;
        }
        if (u.delete) {
          this.doc.deleteToken(t.id);
          results.push({ name: u.name, result: 'deleted' });
          count++;
          continue;
        }
        let value: string | number | undefined;
        if (u.value !== undefined) {
          const parsed = parseTokenValue(this.doc.data, t.type, u.value);
          if (!parsed.ok) {
            results.push({ name: u.name, result: 'error', message: parsed.error });
            continue;
          }
          if (wouldCreateCycle(this.doc.data, t.id, parsed.value)) {
            results.push({ name: u.name, result: 'error', message: `Circular token reference: ${u.name} → ${u.value}` });
            continue;
          }
          value = parsed.value;
        }
        this.doc.updateToken(t.id, {
          ...(u.newName ? { name: u.newName.replace(/^--/, '') } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(u.description !== undefined ? { description: u.description } : {}),
        });
        results.push({ name: u.newName ?? u.name, result: 'updated' });
        count++;
      }
    });
    return { data: { tokens: results, count } };
  }

  // ==================================================================== export

  /** Factor efectivo a partir de "2x" / "1200w" / "800h" / "1080p" y los límites de 16000 px. */
  effectiveScale(scale: string, rect: { width: number; height: number } | null): number {
    const m = /^(\d+(?:\.\d+)?)(x|w|h|p)$/.exec(scale);
    if (!m) return 1;
    const n = Number(m[1]);
    const w = rect?.width || 0;
    const h = rect?.height || 0;
    let f: number;
    switch (m[2]) {
      case 'x':
        f = n;
        break;
      case 'w':
        f = w ? n / w : 1;
        break;
      case 'h':
        f = h ? n / h : 1;
        break;
      default:
        f = Math.min(w, h) ? n / Math.min(w, h) : 1;
    }
    if (!Number.isFinite(f) || f <= 0) return 1;
    if (w && h) {
      f = Math.min(f, 16000 / Math.max(w, h), Math.sqrt((16000 * 16000) / (w * h)));
    }
    return f;
  }

  private exportFileName(id: string, scale: string, ext: string) {
    const label = (this.doc.view(id)?.label ?? id).replace(/[\\/:*?"<>|\n\r]+/g, '-').trim() || id;
    return `${label}${scale === '1x' ? '' : `@${scale}`}.${ext}`;
  }

  private async exportNodes(ctx: ToolCallContext, a: Args): Promise<HandlerResult> {
    if (a.type === 'video') return { error: 'Video export is not available in Moki yet.' };
    if (a.scope === 'page' || a.scope === 'file') {
      // Exportación masiva en el servidor (desde su copia autoritativa del documento).
      const pageId = a.scope === 'page' ? this.resolvePageRoot(a.pageId).pageId : undefined;
      this.doc.flush();
      try {
        const res = await this.session.sync.rpc(
          'bulkExport',
          { scope: a.scope, fileId: this.doc.data.id, pageId, format: a.format ?? 'png', scale: a.scale ?? 2, includeSource: !!a.includeSource },
          10 * 60_000,
        );
        return {
          data: {
            export: { filePath: res.filePath, url: res.url, downloadUrl: res.downloadUrl, files: res.count },
            ...(res.errors.length ? { errors: res.errors } : {}),
          },
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
    const imageFormats = new Set(['png', 'jpg', 'webp', 'avif', 'svg', 'pdf']);
    const plan: { nodeId: string; entries: ExportEntry[] }[] = [];
    if (a.nodes === 'nodes-with-exports-only') {
      const { rootId } = this.resolvePageRoot(a.pageId);
      for (const id of this.doc.descendants(rootId)) {
        const e = this.doc.view(id)?.exportMeta?.entries?.filter((x) => imageFormats.has(x.format));
        if (e && e.length) plan.push({ nodeId: id, entries: toJS(e) });
      }
      if (plan.length === 0) return { error: 'No nodes on this page have export settings. Pass node IDs explicitly instead.' };
    } else {
      for (const [id, settings] of Object.entries(a.nodes as Record<string, Args[]>)) {
        const n = this.doc.view(id);
        if (!n) return { error: `Node not found: ${id}` };
        if (settings.length === 0) {
          const saved = n.exportMeta?.entries?.filter((x) => imageFormats.has(x.format));
          plan.push({ nodeId: id, entries: saved?.length ? toJS(saved) : [{ format: 'png', scale: '2x' }] });
        } else {
          plan.push({
            nodeId: id,
            entries: settings.map((s) => ({ format: s.format, scale: s.scale ?? (s.format === 'pdf' ? '1x' : '2x'), quality: s.pdfQuality, resampling: s.pdfResampling }) as ExportEntry),
          });
        }
      }
    }
    const items: ExportRequestItem[] = [];
    const errors: { nodeId: string; error: string }[] = [];
    for (const p of plan) {
      const rect = this.rectOf(p.nodeId);
      for (const e of p.entries) {
        const fmt = e.format as string;
        if (fmt === 'mp4' || fmt === 'webm') {
          errors.push({ nodeId: p.nodeId, error: 'Video export is not available in Moki yet.' });
          continue;
        }
        if (isRootId(p.nodeId)) {
          errors.push({ nodeId: p.nodeId, error: 'Cannot export a page root node; export its artboards instead.' });
          continue;
        }
        const item: ExportRequestItem = {
          nodeId: p.nodeId,
          format: e.format,
          scale: this.effectiveScale(e.scale, rect),
          fileName: this.exportFileName(p.nodeId, e.scale, e.format),
          ...(e.format === 'pdf' ? { pdfQuality: e.quality ?? 'high', pdfResampling: e.resampling ?? 'detailed' } : {}),
        };
        if (e.format === 'svg') {
          try {
            item.svgMarkup = serializeSvgNode(this.doc, p.nodeId);
          } catch (err) {
            errors.push({ nodeId: p.nodeId, error: err instanceof Error ? err.message : String(err) });
            continue;
          }
        }
        items.push(item);
      }
    }
    this.activity.recordRead(ctx, plan.map((p) => p.nodeId));
    let exports: { nodeId: string; filePath: string }[] = [];
    if (items.length) {
      this.doc.flush();
      const res = await this.session.sync.rpc('exportFiles', { items });
      exports = res.exports.map((x) => ({ nodeId: x.nodeId, filePath: x.filePath, ...(x.url ? { url: x.url } : {}) }));
      errors.push(...res.errors);
    }
    return { data: { exports, ...(errors.length ? { errors } : {}) } };
  }

  private async exportCombinedPdf(ctx: ToolCallContext, ids: string[]): Promise<HandlerResult> {
    for (const id of ids) if (!this.doc.view(id)) return { error: `Node not found: ${id}` };
    const withRects = ids
      .map((id) => ({ id, r: this.rectOf(id) }))
      .filter((x) => x.r && x.r.width > 0 && x.r.height > 0) as { id: string; r: Rect }[];
    if (withRects.length === 0) return { error: 'None of the nodes has a size to export.' };
    const ordered = readingOrder(withRects);
    const qRank = { low: 0, medium: 1, high: 2 } as const;
    let quality: 'low' | 'medium' | 'high' | null = null;
    let resampling: 'detailed' | 'basic' | null = null;
    for (const { id } of ordered) {
      for (const e of this.doc.view(id)?.exportMeta?.entries ?? []) {
        if (e.format !== 'pdf') continue;
        if (e.quality && (quality === null || qRank[e.quality] > qRank[quality])) quality = e.quality;
        if (e.resampling && (resampling === null || e.resampling === 'detailed')) resampling = e.resampling;
      }
    }
    this.activity.recordRead(ctx, ordered.map((o) => o.id));
    this.doc.flush();
    const name = (this.doc.data.name || 'Moki').replace(/[\\/:*?"<>|\n\r]+/g, '-');
    const res = await this.session.sync.rpc('exportCombinedPdf', {
      nodeIds: ordered.map((o) => o.id),
      fileName: `${name}.pdf`,
      pdfQuality: quality ?? 'high',
      pdfResampling: resampling ?? 'detailed',
    });
    return { data: { exports: ordered.map((o) => ({ nodeId: o.id, filePath: res.filePath, ...(res.url ? { url: res.url } : {}) })) } };
  }
}

// ---------------------------------------------------------------------------

export { readingOrder } from '../../core/layout-order';

export function truncateText(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  let cut = max;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--; // no partir pares sustitutos
  return { text: s.slice(0, cut) + '... [truncated]', truncated: true };
}

function textLabel(t: string): string | undefined {
  const one = t.replace(/\s+/g, ' ').trim();
  return one ? (one.length > 40 ? one.slice(0, 40) + '…' : one) : undefined;
}

/** ¿Hay una fuente del sistema con ese nombre? (comparando métricas con genéricas). */
function systemFontAvailable(name: string): boolean {
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return false;
    const sample = 'mmmmmmmmmmlli1WQ@#';
    for (const generic of ['monospace', 'serif', 'sans-serif']) {
      c.font = `72px ${generic}`;
      const base = c.measureText(sample).width;
      c.font = `72px "${name}", ${generic}`;
      if (c.measureText(sample).width !== base) return true;
    }
  } catch {
    /* sin canvas */
  }
  return false;
}

export { FREEFORM_DISPLAY };
