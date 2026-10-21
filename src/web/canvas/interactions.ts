import { runInAction } from 'mobx';
import { pxValue } from '../../core/css';
import { isRootId } from '../../core/tree';
import { shortId } from '../../core/ids';
import type { EditorState } from '../editor/editor-state';
import { createShape, ensureLeftTop, isFreeChild } from '../editor/actions';
import type { Rect } from './geometry';

// Entrada del canvas: el DOM del diseño no recibe eventos (pointer-events:none); todo pasa por
// aquí, con hit-testing geométrico sobre los rectángulos medidos.

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { kind: 'marquee'; wx: number; wy: number; base: string[] }
  | { kind: 'pending'; sx: number; sy: number; wx: number; wy: number }
  | { kind: 'move-free'; wx: number; wy: number; starts: { id: string; left: number; top: number }[]; moved: boolean }
  | { kind: 'move-flow'; id: string; wx: number; wy: number; grab: { x: number; y: number }; target: DropTarget | null }
  | { kind: 'draw'; wx: number; wy: number; tool: 'frame' | 'rect'; parentId: string }
  | {
      kind: 'resize';
      id: string;
      handle: Handle;
      wx: number;
      wy: number;
      rect: Rect;
      left: number;
      top: number;
      free: boolean;
    };

interface DropTarget {
  parentId: string;
  index: number | null; // null = libre (posición absoluta)
}

const DRAG_THRESHOLD = 3;
const round = (n: number) => Math.round(n);

export class CanvasController {
  drag: Drag | null = null;
  private lastPointer = { sx: 0, sy: 0 };

  constructor(private editor: EditorState) {}

  private local(e: { clientX: number; clientY: number }) {
    const v = this.editor.viewport;
    return { sx: e.clientX - v.left, sy: e.clientY - v.top };
  }

  // ------------------------------------------------------------------ eventos

  onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const ed = this.editor;
    // Evita que el mousedown mueva el foco (o seleccione texto); confirmamos inputs abiertos.
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) active.blur();
    if (ed.editingTextId) ed.stopTextEdit();
    const { sx, sy } = this.local(e);
    const w = ed.screenToWorld(sx, sy);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ed.sendFocus(0);

    if (e.button === 1 || ed.spaceDown || ed.tool === 'hand') {
      this.drag = { kind: 'pan', sx, sy, cx: ed.camera.x, cy: ed.camera.y };
      return;
    }
    if (e.button !== 0) return;

    switch (ed.tool) {
      case 'frame':
      case 'rect':
        this.drag = { kind: 'draw', wx: w.x, wy: w.y, tool: ed.tool, parentId: ed.containerAt(w.x, w.y) };
        return;
      case 'text': {
        const parentId = ed.containerAt(w.x, w.y);
        ed.doc.breakUndoGroup();
        const id = createShape(ed, { component: 'Text', parentId, worldRect: { x: w.x, y: w.y - 12, width: 0, height: 0 }, textValue: '' });
        ed.setTool('move');
        ed.startTextEdit(id, true);
        return;
      }
      case 'comment': {
        const path = ed.hitPath(w.x, w.y, { includeLocked: true });
        const nodeId = path[path.length - 1] ?? ed.rootId;
        const r = isRootId(nodeId) ? { x: 0, y: 0 } : (ed.measure.peek(nodeId) ?? { x: 0, y: 0 });
        runInAction(() => {
          ed.commentDraft = { nodeId, pageId: ed.activePageId, xOffset: w.x - r.x, yOffset: w.y - r.y };
          ed.openThreadId = null;
        });
        return;
      }
    }

    // Herramienta mover
    const deep = e.metaKey || e.ctrlKey;
    const path = ed.hitPath(w.x, w.y);
    const pick = ed.pickForClick(path, deep);
    if (!pick) {
      if (!e.shiftKey) ed.select([]);
      this.drag = { kind: 'marquee', wx: w.x, wy: w.y, base: e.shiftKey ? ed.selection.slice() : [] };
      return;
    }
    if (e.shiftKey) {
      ed.toggleSelect(pick);
      return;
    }
    if (!ed.selection.includes(pick)) ed.select([pick]);
    this.drag = { kind: 'pending', sx, sy, wx: w.x, wy: w.y };
  };

  onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ed = this.editor;
    const { sx, sy } = this.local(e);
    this.lastPointer = { sx, sy };
    const w = ed.screenToWorld(sx, sy);
    runInAction(() => (ed.pointerWorld = w));
    // El estado de Option puede perderse (p. ej. si se pulsó fuera de la ventana): se corrige aquí.
    if (e.altKey !== ed.altDown) ed.setAlt(e.altKey);
    const d = this.drag;
    if (!d) {
      if (ed.tool === 'move' && !ed.spaceDown) {
        ed.refreshHover(e.metaKey || e.ctrlKey);
      } else if (ed.tool === 'comment') {
        const path = ed.hitPath(w.x, w.y, { includeLocked: true });
        ed.setHover(path[path.length - 1] ?? null);
      } else ed.setHover(null);
      return;
    }
    switch (d.kind) {
      case 'pan':
        ed.setCamera({ x: d.cx + (sx - d.sx), y: d.cy + (sy - d.sy), scale: ed.camera.scale });
        return;
      case 'marquee': {
        const r = normRect(d.wx, d.wy, w.x, w.y);
        runInAction(() => (ed.marquee = r));
        const hits = ed.nodesInRect(r);
        ed.select([...d.base, ...hits]);
        return;
      }
      case 'pending': {
        if (Math.hypot(sx - d.sx, sy - d.sy) < DRAG_THRESHOLD) return;
        this.beginMove(d.wx, d.wy);
        this.onPointerMove(e);
        return;
      }
      case 'move-free': {
        const dx = w.x - d.wx;
        const dy = w.y - d.wy;
        d.moved = true;
        ed.doc.transact(() => {
          for (const s of d.starts) ed.doc.setStyles(s.id, { left: `${round(s.left + dx)}px`, top: `${round(s.top + dy)}px` });
        });
        return;
      }
      case 'move-flow': {
        d.target = this.computeDrop(d.id, w.x, w.y);
        return;
      }
      case 'draw': {
        runInAction(() => (ed.drawRect = normRect(d.wx, d.wy, w.x, w.y)));
        return;
      }
      case 'resize':
        this.applyResize(d, w.x, w.y, e.shiftKey);
        return;
    }
  };

  onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const ed = this.editor;
    const d = this.drag;
    this.drag = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (!d) return;
    const { sx, sy } = this.local(e);
    const w = ed.screenToWorld(sx, sy);
    switch (d.kind) {
      case 'marquee':
        runInAction(() => (ed.marquee = null));
        return;
      case 'move-free':
        ed.doc.endGesture();
        return;
      case 'move-flow':
        runInAction(() => (ed.dropIndicator = null));
        if (d.target) this.applyFlowDrop(d.id, d.target, w, d.grab);
        ed.doc.endGesture();
        return;
      case 'draw': {
        runInAction(() => (ed.drawRect = null));
        let r = normRect(d.wx, d.wy, w.x, w.y);
        if (r.width < 3 && r.height < 3) r = { x: d.wx, y: d.wy, width: 100, height: 100 };
        ed.doc.breakUndoGroup();
        const id = createShape(ed, { component: d.tool === 'frame' ? 'Frame' : 'Rectangle', parentId: d.parentId, worldRect: r });
        ed.doc.breakUndoGroup();
        ed.select([id]);
        ed.setTool('move');
        return;
      }
      case 'resize':
        ed.doc.endGesture();
        return;
    }
  };

  onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const ed = this.editor;
    if (ed.tool !== 'move') return;
    const { sx, sy } = this.local(e);
    const w = ed.screenToWorld(sx, sy);
    const path = ed.hitPath(w.x, w.y);
    if (!path.length) return;
    const sel = ed.selection[0];
    const i = sel ? path.indexOf(sel) : -1;
    const target = i >= 0 ? (path[i + 1] ?? path[i]!) : ed.pickForClick(path, false)!;
    const n = ed.doc.node(target);
    if (n?.component === 'Text' && (target === sel || i === path.length - 1 || i < 0)) {
      ed.startTextEdit(target);
      return;
    }
    ed.select([target]);
  };

  onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const ed = this.editor;
    const { sx, sy } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0025));
      ed.zoomAt(ed.camera.scale * factor, sx, sy);
    } else {
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      }
      ed.setCamera({ x: ed.camera.x - dx, y: ed.camera.y - dy, scale: ed.camera.scale });
    }
  };

  private gestureStartScale = 1;
  onGestureStart = (e: Event) => {
    e.preventDefault();
    this.gestureStartScale = this.editor.camera.scale;
  };
  onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as Event & { scale: number };
    this.editor.zoomAt(this.gestureStartScale * g.scale, this.lastPointer.sx, this.lastPointer.sy);
  };

  // ------------------------------------------------------------------ inicio de arrastres externos

  /** Arrastre desde un handle de redimensionado. */
  startResize(id: string, handle: Handle, e: React.PointerEvent) {
    const ed = this.editor;
    const rect = ed.measure.peek(id);
    if (!rect || ed.doc.isVirtual(id)) return;
    e.stopPropagation();
    const viewport = (e.currentTarget as HTMLElement).closest('.canvas-viewport') as HTMLElement | null;
    viewport?.setPointerCapture(e.pointerId);
    const { sx, sy } = this.local(e);
    const w = ed.screenToWorld(sx, sy);
    const free = isFreeChild(ed.doc, id);
    ed.doc.startGesture();
    const lt = free ? ensureLeftTop(ed, id) : { left: 0, top: 0 };
    this.drag = { kind: 'resize', id, handle, wx: w.x, wy: w.y, rect, left: lt.left, top: lt.top, free };
  }

  /** Arrastre desde la etiqueta de un artboard. */
  startLabelDrag(id: string, e: React.PointerEvent) {
    const ed = this.editor;
    e.stopPropagation();
    const viewport = (e.currentTarget as HTMLElement).closest('.canvas-viewport') as HTMLElement | null;
    viewport?.setPointerCapture(e.pointerId);
    if (e.shiftKey) ed.toggleSelect(id);
    else if (!ed.selection.includes(id)) ed.select([id]);
    const { sx, sy } = this.local(e);
    const w = ed.screenToWorld(sx, sy);
    this.drag = { kind: 'pending', sx, sy, wx: w.x, wy: w.y };
  }

  private beginMove(wx: number, wy: number) {
    const ed = this.editor;
    // Los hijos de una instancia no se mueven (su estructura viene del main).
    const sel = ed.selection.filter((id) => ed.doc.node(id) && !ed.doc.isEffectivelyLocked(id) && !ed.doc.isVirtual(id));
    if (!sel.length) {
      this.drag = null;
      return;
    }
    const free = sel.filter((id) => isFreeChild(ed.doc, id));
    ed.doc.startGesture();
    if (free.length === sel.length) {
      const starts = free.map((id) => ({ id, ...ensureLeftTop(ed, id) }));
      this.drag = { kind: 'move-free', wx, wy, starts, moved: false };
      return;
    }
    const id = sel[0]!;
    const r = ed.measure.peek(id) ?? { x: wx, y: wy, width: 0, height: 0 };
    this.drag = { kind: 'move-flow', id, wx, wy, grab: { x: wx - r.x, y: wy - r.y }, target: null };
  }

  // ------------------------------------------------------------------ flujo (reordenar / reparentar)

  private computeDrop(id: string, wx: number, wy: number): DropTarget | null {
    const ed = this.editor;
    const doc = ed.doc;
    const exclude = new Set([id]);
    const parentId = ed.containerAt(wx, wy, exclude);
    if (doc.isWithin(parentId, id)) return null;
    if (doc.isFreeform(parentId)) {
      runInAction(() => (ed.dropIndicator = null));
      return { parentId, index: null };
    }
    const parent = doc.view(parentId)!;
    const dir = String(parent.styles.flexDirection ?? (parent.styles.display === 'flex' ? 'row' : 'column'));
    const horizontal = dir.startsWith('row') && (parent.styles.display === 'flex' || parent.styles.display === 'inline-flex');
    const sibs = doc.childIds(parentId).filter((s) => s !== id && doc.node(s)?.isVisible !== false);
    const rects = sibs.map((s) => ed.measure.peek(s));
    let index = 0;
    rects.forEach((r) => {
      if (!r) return;
      const mid = horizontal ? r.x + r.width / 2 : r.y + r.height / 2;
      if ((horizontal ? wx : wy) > mid) index++;
    });
    const pr = ed.measure.peek(parentId);
    if (pr) {
      const before = rects[index - 1];
      const after = rects[index];
      let pos: number;
      if (horizontal) {
        pos = after ? after.x - 2 : before ? before.x + before.width + 2 : pr.x + 4;
        runInAction(() => (ed.dropIndicator = { x1: pos, y1: pr.y, x2: pos, y2: pr.y + pr.height, parentRect: pr }));
      } else {
        pos = after ? after.y - 2 : before ? before.y + before.height + 2 : pr.y + 4;
        runInAction(() => (ed.dropIndicator = { x1: pr.x, y1: pos, x2: pr.x + pr.width, y2: pos, parentRect: pr }));
      }
    }
    // Índice entre los hijos reales (incluyendo ocultos) del padre destino.
    const all = doc.childIds(parentId).filter((s) => s !== id);
    const anchor = sibs[index];
    const realIndex = anchor ? all.indexOf(anchor) : all.length;
    return { parentId, index: realIndex };
  }

  private applyFlowDrop(id: string, t: DropTarget, w: { x: number; y: number }, grab: { x: number; y: number }) {
    const ed = this.editor;
    const doc = ed.doc;
    doc.transact(() => {
      const key = doc.sortKeyForIndex(t.parentId, t.index ?? undefined, id);
      doc.moveNode(id, t.parentId, key);
      if (t.index === null) {
        const pr = t.parentId === ed.rootId ? { x: 0, y: 0 } : (ed.measure.peek(t.parentId) ?? { x: 0, y: 0 });
        doc.setStyles(id, { left: `${round(w.x - grab.x - pr.x)}px`, top: `${round(w.y - grab.y - pr.y)}px`, right: null, bottom: null });
      } else {
        const n = doc.node(id);
        if (n && (n.styles.position === 'absolute' || n.styles.left !== undefined)) {
          doc.setStyles(id, { position: null, left: null, top: null, right: null, bottom: null });
        }
      }
    });
  }

  // ------------------------------------------------------------------ redimensionar

  private applyResize(d: Extract<Drag, { kind: 'resize' }>, wx: number, wy: number, keepAspect: boolean) {
    const ed = this.editor;
    const dx = wx - d.wx;
    const dy = wy - d.wy;
    let { x, y, width, height } = d.rect;
    const h = d.handle;
    if (h.includes('e')) width = d.rect.width + dx;
    if (h.includes('w')) {
      width = d.rect.width - dx;
      x = d.rect.x + dx;
    }
    if (h.includes('s')) height = d.rect.height + dy;
    if (h.includes('n')) {
      height = d.rect.height - dy;
      y = d.rect.y + dy;
    }
    if (keepAspect && d.rect.width > 0 && d.rect.height > 0) {
      const ratio = d.rect.width / d.rect.height;
      if (h === 'n' || h === 's') width = height * ratio;
      else if (h === 'e' || h === 'w') height = width / ratio;
      else if (Math.abs(width / d.rect.width) > Math.abs(height / d.rect.height)) height = width / ratio;
      else width = height * ratio;
      if (h.includes('w')) x = d.rect.x + d.rect.width - width;
      if (h.includes('n')) y = d.rect.y + d.rect.height - height;
    }
    width = Math.max(1, width);
    height = Math.max(1, height);
    const patch: Record<string, string | null> = {};
    if (h !== 'n' && h !== 's') patch.width = `${round(width)}px`;
    if (h !== 'e' && h !== 'w') patch.height = `${round(height)}px`;
    if (keepAspect) {
      patch.width = `${round(width)}px`;
      patch.height = `${round(height)}px`;
    }
    if (d.free) {
      if (h.includes('w')) patch.left = `${round(d.left + (x - d.rect.x))}px`;
      if (h.includes('n')) patch.top = `${round(d.top + (y - d.rect.y))}px`;
    }
    // Un hijo flex con flexGrow pierde el "fill" al fijar tamaño en el eje principal.
    const n = ed.doc.node(d.id);
    if (n && pxValue(n.styles.flexGrow) && patch.width) patch.flexGrow = null;
    ed.doc.setStyles(d.id, patch);
  }
}

function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export const newThreadId = () => shortId('ct');
export const newMessageId = () => shortId('cm');
