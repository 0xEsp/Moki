import { action, makeObservable, observable, reaction, runInAction } from 'mobx';
import { Focus, MessageType, type WorldRect } from '../../core/protocol';
import { rootNodeIdFor } from '../../core/ids';
import type { FileSession } from '../state/file-session';
import type { DocStore } from '../state/doc-store';
import { DomRegistry } from '../canvas/dom-registry';
import { rectContainsPoint, rectsIntersect, unionRects, type Rect } from '../canvas/geometry';
import { MeasureCache } from '../canvas/measure-cache';
import { navigate } from '../router';

export type Tool = 'move' | 'frame' | 'rect' | 'text' | 'hand' | 'comment';

export interface Camera {
  x: number; // pan en px de pantalla
  y: number;
  scale: number;
}

export const ZOOM_LEVELS = [0.02, 0.03, 0.06, 0.13, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;

export interface CommentDraft {
  nodeId: string;
  pageId: string;
  xOffset: number;
  yOffset: number;
}

/** Estado de UI de un fichero abierto en el editor. */
export class EditorState {
  readonly registry = new DomRegistry();
  readonly measure: MeasureCache;
  activePageId: string;
  selection: string[] = [];
  hoverId: string | null = null;
  tool: Tool = 'move';
  camera: Camera = { x: 0, y: 0, scale: 1 };
  viewport = { width: 1, height: 1, left: 0, top: 0 };
  editingTextId: string | null = null;
  /** Nodo de texto recién creado (si queda vacío al salir, se borra). */
  newTextId: string | null = null;
  spaceDown = false;
  /** Option/Alt pulsado: medir distancias entre la selección y lo que hay bajo el puntero. */
  altDown = false;
  /** Última posición del puntero en mundo sobre el canvas (null si está fuera). */
  pointerWorld: { x: number; y: number } | null = null;
  expanded = new Set<string>();
  commentDraft: CommentDraft | null = null;
  openThreadId: string | null = null;
  showComments = false;
  rightTab: 'design' | 'code' = 'design';
  /** Marquee en coordenadas de mundo durante el arrastre. */
  marquee: Rect | null = null;
  /** Indicador de inserción (línea en mundo) durante drags. */
  dropIndicator: { x1: number; y1: number; x2: number; y2: number; parentRect?: Rect } | null = null;
  /** Rectángulo que se está dibujando con las herramientas frame/rect. */
  drawRect: Rect | null = null;
  now = Date.now();

  private cameraStash = new Map<string, Camera>();
  private disposers: (() => void)[] = [];
  private lastCameraSent = 0;
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFocusSent = 0;

  constructor(
    readonly session: FileSession,
    readonly doc: DocStore,
    initialPageId: string | null,
  ) {
    const pages = doc.canvasPages;
    this.activePageId = (initialPageId && pages.find((p) => p.id === initialPageId)?.id) || pages[0]?.id || 'p-1-0';
    this.measure = new MeasureCache(this);
    makeObservable(this, {
      activePageId: observable,
      selection: observable.ref,
      hoverId: observable,
      tool: observable,
      camera: observable.ref,
      viewport: observable.ref,
      editingTextId: observable,
      spaceDown: observable,
      altDown: observable,
      pointerWorld: observable.ref,
      expanded: observable,
      commentDraft: observable.ref,
      openThreadId: observable,
      showComments: observable,
      rightTab: observable,
      marquee: observable.ref,
      dropIndicator: observable.ref,
      drawRect: observable.ref,
      now: observable,
      setPage: action,
      select: action,
      setHover: action,
      setAlt: action,
      refreshHover: action,
      setTool: action,
      setCamera: action,
      setViewport: action,
      startTextEdit: action,
      stopTextEdit: action,
    });

    doc.snapshotUiState = () => ({ selection: this.selection.slice(), pageId: this.activePageId });
    doc.restoreUiState = (s) => {
      if (s.pageId && s.pageId !== this.activePageId && doc.page(s.pageId)) this.setPage(s.pageId);
      if (s.selection) this.select(s.selection.filter((id) => doc.node(id)));
    };

    const send = session.sync.send.bind(session.sync);
    this.disposers.push(
      reaction(
        () => this.selection,
        (sel) => send({ $t: MessageType.UserSelectNode, nodeIds: sel }),
      ),
      reaction(
        () => this.activePageId,
        (pageId) => {
          send({ $t: MessageType.UserPageChange, pageId });
          navigate(`/file/${session.fileId}/${pageId}`, true);
        },
        { fireImmediately: true },
      ),
      // Si la página activa se borra, saltamos a otra.
      reaction(
        () => doc.canvasPages.map((p) => p.id).join(','),
        () => {
          if (!doc.page(this.activePageId)) {
            const first = doc.canvasPages[0];
            if (first) this.setPage(first.id);
          }
        },
      ),
      // Selección: purgar nodos borrados (p. ej. por un agente).
      reaction(
        () => this.selection.filter((id) => !doc.node(id)).length,
        (n) => {
          if (n > 0) this.select(this.selection.filter((id) => doc.node(id)));
        },
      ),
      // Al reconectar, re-anunciamos nuestro estado.
      reaction(
        () => session.status,
        (s) => {
          if (s === 'connected') {
            send({ $t: MessageType.UserPageChange, pageId: this.activePageId });
            send({ $t: MessageType.UserSelectNode, nodeIds: this.selection });
            this.sendFocus(document.hasFocus() ? Focus.Canvas : Focus.Blurred, true);
            this.broadcastCamera(true);
          }
        },
      ),
    );

    const onFocus = () => this.sendFocus(Focus.Canvas, true);
    const onBlur = () => this.sendFocus(Focus.Blurred, true);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    const tick = setInterval(() => runInAction(() => (this.now = Date.now())), 1000);
    this.disposers.push(() => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      clearInterval(tick);
    });
    if (document.hasFocus()) this.sendFocus(Focus.Canvas, true);
  }

  dispose() {
    for (const d of this.disposers) d();
    this.measure.dispose();
    this.doc.snapshotUiState = null;
    this.doc.restoreUiState = null;
  }

  get rootId() {
    return rootNodeIdFor(this.activePageId);
  }
  get activePage() {
    return this.doc.page(this.activePageId);
  }

  /** Marca actividad del usuario (la pestaña más reciente es "la del usuario" para el MCP). */
  sendFocus(focus: Focus, force = false) {
    const now = Date.now();
    if (!force && now - this.lastFocusSent < 4000) return;
    this.lastFocusSent = now;
    this.session.sync.send({ $t: MessageType.UserFocusChange, focus });
  }

  // ------------------------------------------------------------------ páginas

  setPage(pageId: string) {
    if (pageId === this.activePageId) return;
    this.cameraStash.set(this.activePageId, this.camera);
    this.activePageId = pageId;
    this.selection = [];
    this.hoverId = null;
    this.editingTextId = null;
    const stashed = this.cameraStash.get(pageId);
    if (stashed) this.camera = stashed;
    else this.pendingFit = true;
  }
  /** Al cambiar a una página sin cámara guardada, encuadrar cuando esté medida. */
  pendingFit = true;

  // ------------------------------------------------------------------ selección

  select(ids: string[]) {
    const uniq = [...new Set(ids)].filter((id) => !id.startsWith('root_node_'));
    if (uniq.length === this.selection.length && uniq.every((x, i) => x === this.selection[i])) return;
    this.selection = uniq;
    // Desplegar ancestros en el árbol de capas.
    for (const id of uniq) for (const a of this.doc.ancestors(id)) this.expanded.add(a);
  }
  toggleSelect(id: string) {
    if (this.selection.includes(id)) this.select(this.selection.filter((x) => x !== id));
    else this.select([...this.selection, id]);
  }
  setHover(id: string | null) {
    this.hoverId = id;
  }
  setAlt(down: boolean) {
    if (this.altDown === down) return;
    this.altDown = down;
    this.refreshHover();
  }
  /**
   * Recalcula el hover con la última posición del puntero. Con Option se mide hasta la capa más
   * profunda bajo el cursor (como Figma); sin Option, reglas de selección por niveles.
   */
  refreshHover(deep = false) {
    const p = this.pointerWorld;
    if (!p || this.tool !== 'move' || this.spaceDown) return;
    const path = this.hitPath(p.x, p.y);
    this.hoverId = this.altDown && this.selection.length ? (path[path.length - 1] ?? null) : this.pickForClick(path, deep);
  }
  setTool(t: Tool) {
    this.tool = t;
    if (t !== 'comment') this.commentDraft = null;
  }

  // ------------------------------------------------------------------ cámara

  setViewport(v: { width: number; height: number; left: number; top: number }) {
    this.viewport = v;
  }

  setCamera(c: Camera) {
    const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.scale));
    this.camera = { x: c.x, y: c.y, scale };
    this.broadcastCamera();
  }

  private broadcastCamera(force = false) {
    const now = Date.now();
    const doSend = () => {
      this.lastCameraSent = Date.now();
      this.session.sync.send({ $t: MessageType.UserCameraChange, view: this.visibleWorldRect() });
    };
    if (force || now - this.lastCameraSent > 33) {
      doSend();
    } else if (!this.cameraTimer) {
      this.cameraTimer = setTimeout(() => {
        this.cameraTimer = null;
        doSend();
      }, 40);
    }
  }

  visibleWorldRect(): WorldRect {
    const { x, y, scale } = this.camera;
    return {
      minX: -x / scale,
      minY: -y / scale,
      maxX: (this.viewport.width - x) / scale,
      maxY: (this.viewport.height - y) / scale,
    };
  }

  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.camera.x) / this.camera.scale, y: (sy - this.camera.y) / this.camera.scale };
  }
  worldToScreen(wx: number, wy: number) {
    return { x: wx * this.camera.scale + this.camera.x, y: wy * this.camera.scale + this.camera.y };
  }
  worldRectToScreen(r: Rect): Rect {
    const p = this.worldToScreen(r.x, r.y);
    return { x: p.x, y: p.y, width: r.width * this.camera.scale, height: r.height * this.camera.scale };
  }

  zoomAt(scale: number, sx = this.viewport.width / 2, sy = this.viewport.height / 2) {
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    const w = this.screenToWorld(sx, sy);
    this.setCamera({ scale: s, x: sx - w.x * s, y: sy - w.y * s });
  }
  zoomIn() {
    const next = ZOOM_LEVELS.find((z) => z > this.camera.scale * 1.001) ?? MAX_ZOOM;
    this.zoomAt(next);
  }
  zoomOut() {
    const prev = [...ZOOM_LEVELS].reverse().find((z) => z < this.camera.scale / 1.001) ?? MIN_ZOOM;
    this.zoomAt(prev);
  }
  zoomToRect(r: Rect | null, padding = 50) {
    if (!r || r.width <= 0 || r.height <= 0) {
      this.setCamera({ x: this.viewport.width / 2, y: this.viewport.height / 2, scale: 1 });
      return;
    }
    const vw = Math.max(1, this.viewport.width - padding * 2);
    const vh = Math.max(1, this.viewport.height - padding * 2);
    const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(vw / r.width, vh / r.height, 1)));
    this.setCamera({
      scale,
      x: this.viewport.width / 2 - (r.x + r.width / 2) * scale,
      y: this.viewport.height / 2 - (r.y + r.height / 2) * scale,
    });
  }
  zoomToFit() {
    const rects = this.doc
      .childIds(this.rootId)
      .map((id) => this.measure.rect(id))
      .filter((r): r is Rect => !!r);
    this.zoomToRect(unionRects(rects));
  }
  zoomToSelection() {
    const rects = this.selection.map((id) => this.measure.rect(id)).filter((r): r is Rect => !!r);
    if (rects.length) this.zoomToRect(unionRects(rects));
  }

  // ------------------------------------------------------------------ texto

  startTextEdit(id: string, isNew = false) {
    this.editingTextId = id;
    this.newTextId = isNew ? id : null;
    this.selection = [id];
  }
  stopTextEdit() {
    const id = this.editingTextId;
    if (!id) return;
    this.editingTextId = null;
    const n = this.doc.node(id);
    if (n && this.newTextId === id && !(n.textValue ?? '').trim()) {
      this.doc.deleteNodes([id]);
      this.selection = [];
    }
    this.newTextId = null;
    this.doc.breakUndoGroup();
  }

  // ------------------------------------------------------------------ hit testing

  /** Ruta [artboard, …, más profundo] de nodos bajo el punto de mundo (sin la raíz). */
  hitPath(wx: number, wy: number, opts: { includeLocked?: boolean; exclude?: Set<string> } = {}): string[] {
    const doc = this.doc;
    const tol = 2 / this.camera.scale;
    const visit = (id: string): string[] | null => {
      const kids = doc.childIds(id);
      for (let i = kids.length - 1; i >= 0; i--) {
        const c = kids[i]!;
        if (opts.exclude?.has(c)) continue;
        const n = doc.node(c);
        if (!n || n.isVisible === false) continue;
        if (!opts.includeLocked && n.isLocked) continue;
        const r = this.measure.rect(c);
        const inside = r ? rectContainsPoint({ x: r.x - tol, y: r.y - tol, width: r.width + 2 * tol, height: r.height + 2 * tol }, wx, wy) : false;
        const clips = isClipping(n.styles.overflow) || doc.isArtboard(c);
        if (inside || !clips) {
          const sub = visit(c);
          if (sub) return [c, ...sub];
          if (inside) return [c];
        }
      }
      return null;
    };
    return visit(this.rootId) ?? [];
  }

  /** Nodo que recibe un clic, con las reglas de selección por niveles. */
  pickForClick(path: string[], deep: boolean): string | null {
    if (path.length === 0) return null;
    if (deep) return path[path.length - 1]!;
    // Por defecto: mismo nivel que la selección actual, o hijo directo del artboard.
    const selParents = new Set(this.selection.map((s) => this.doc.parentId(s)).filter((p) => p && p !== this.rootId));
    let def: string | undefined = path.find((id) => selParents.has(this.doc.parentId(id)));
    if (!def) def = this.doc.isArtboard(path[0]!) ? (path[1] ?? path[0]!) : path[0]!;
    // Si hay algo seleccionado igual de profundo o más bajo el puntero, se mantiene (para arrastrarlo).
    const defIdx = path.indexOf(def);
    for (let i = path.length - 1; i >= defIdx; i--) if (this.selection.includes(path[i]!)) return path[i]!;
    return def;
  }

  /** Nodos de nivel "scope" que intersectan un rectángulo de mundo. */
  nodesInRect(r: Rect): string[] {
    const doc = this.doc;
    const scopeParent = this.selection.length ? doc.parentId(this.selection[0]!) : null;
    const candidates = scopeParent && scopeParent !== this.rootId ? doc.childIds(scopeParent) : doc.childIds(this.rootId);
    return candidates.filter((id) => {
      const n = doc.node(id);
      if (!n || n.isVisible === false || n.isLocked) return false;
      const nr = this.measure.rect(id);
      return !!nr && rectsIntersect(nr, r);
    });
  }

  /** Contenedor (Frame) más profundo bajo el punto, o la raíz. */
  containerAt(wx: number, wy: number, exclude?: Set<string>): string {
    const path = this.hitPath(wx, wy, { exclude });
    for (let i = path.length - 1; i >= 0; i--) {
      const n = this.doc.node(path[i]!);
      // Dentro de una instancia no se puede insertar: el contenedor es el padre de la instancia.
      if (n?.component === 'Frame' && !this.doc.isInsideInstance(path[i]!)) return path[i]!;
    }
    return this.rootId;
  }
}

export function isClipping(v: unknown): boolean {
  return v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
}
