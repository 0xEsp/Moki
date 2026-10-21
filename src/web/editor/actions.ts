import { toJS } from 'mobx';
import { keysBetween } from '../../core/fractional';
import { pxValue } from '../../core/css';
import { FREEFORM_DISPLAY, type Styles, type TreeNode } from '../../core/types';
import type { DocStore } from '../state/doc-store';
import { unionRects, type Rect } from '../canvas/geometry';
import type { EditorState } from './editor-state';

// Operaciones de edición de alto nivel (cada una = un paso de undo).

const round = (n: number) => Math.round(n);

/** ¿El nodo se posiciona libremente (left/top) dentro de su padre? */
export function isFreeChild(doc: DocStore, id: string): boolean {
  const p = doc.parentId(id);
  if (!p) return false;
  const n = doc.node(id);
  if (!n) return false;
  return doc.isFreeform(p) || n.styles.position === 'absolute' || n.styles.position === 'fixed';
}

/** Posición (left/top) relativa al padre a partir de las medidas. */
export function measuredOffset(editor: EditorState, id: string): { x: number; y: number } | null {
  const r = editor.measure.peek(id);
  const p = editor.doc.parentId(id);
  if (!r || !p) return null;
  if (p === editor.rootId) return { x: r.x, y: r.y };
  const pr = editor.measure.peek(p);
  if (!pr) return null;
  const pn = editor.doc.node(p);
  const bl = pxValue(pn?.styles.borderLeftWidth ?? pn?.styles.borderWidth) ?? 0;
  const bt = pxValue(pn?.styles.borderTopWidth ?? pn?.styles.borderWidth) ?? 0;
  return { x: r.x - pr.x - bl, y: r.y - pr.y - bt };
}

/** Normaliza un hijo libre a left/top en px (quitando right/bottom). */
export function ensureLeftTop(editor: EditorState, id: string): { left: number; top: number } {
  const n = editor.doc.node(id)!;
  let left = pxValue(n.styles.left);
  let top = pxValue(n.styles.top);
  if (left === null || top === null || n.styles.right !== undefined || n.styles.bottom !== undefined) {
    const off = measuredOffset(editor, id) ?? { x: 0, y: 0 };
    left = left ?? off.x;
    top = top ?? off.y;
    if (n.styles.right !== undefined || n.styles.bottom !== undefined) {
      left = off.x;
      top = off.y;
      editor.doc.setStyles(id, { right: null, bottom: null, left: `${round(left)}px`, top: `${round(top)}px` });
    }
  }
  return { left, top };
}

export interface CreateOpts {
  component: 'Frame' | 'Rectangle' | 'Text';
  worldRect: Rect;
  /** Contenedor destino. */
  parentId: string;
  textValue?: string;
  extraStyles?: Styles;
}

/** Crea un nodo con la geometría dibujada en coordenadas de mundo. */
export function createShape(editor: EditorState, o: CreateOpts): string {
  const { doc } = editor;
  const isRoot = o.parentId === editor.rootId;
  const parentFree = doc.isFreeform(o.parentId);
  const styles: Styles = {};
  if (o.component === 'Frame') {
    if (isRoot) Object.assign(styles, { display: 'flex', flexDirection: 'column', backgroundColor: '#FFFFFF', overflow: 'clip' });
    else Object.assign(styles, { display: 'flex', flexDirection: 'column', backgroundColor: '#FFFFFF' });
  } else if (o.component === 'Rectangle') {
    styles.backgroundColor = '#D9D9D9';
  } else {
    Object.assign(styles, { fontFamily: 'Inter', fontSize: '16px', lineHeight: '24px', color: '#000000' });
  }
  if (o.component !== 'Text') {
    styles.width = `${round(o.worldRect.width)}px`;
    styles.height = `${round(o.worldRect.height)}px`;
  }
  if (isRoot || parentFree) {
    let x = o.worldRect.x;
    let y = o.worldRect.y;
    if (!isRoot) {
      const pr = editor.measure.peek(o.parentId);
      if (pr) {
        x -= pr.x;
        y -= pr.y;
      }
    }
    styles.left = `${round(x)}px`;
    styles.top = `${round(y)}px`;
  }
  if (o.component !== 'Text' && !(isRoot || parentFree)) styles.flexShrink = 0;
  for (const [k, v] of Object.entries(o.extraStyles ?? {})) {
    if (v === '') delete styles[k];
    else styles[k] = v;
  }
  const id = doc.createNode(o.component, o.parentId, {
    styles,
    ...(o.component === 'Text' ? { textValue: o.textValue ?? '' } : {}),
  });
  return id;
}

export function deleteSelection(editor: EditorState) {
  if (!editor.selection.length) return;
  editor.doc.breakUndoGroup();
  editor.doc.deleteNodes(editor.selection.filter((id) => !editor.doc.isEffectivelyLocked(id)));
  editor.select([]);
  editor.doc.breakUndoGroup();
}

export function duplicateSelection(editor: EditorState) {
  const { doc } = editor;
  if (!editor.selection.length) return;
  doc.breakUndoGroup();
  const created: string[] = [];
  doc.transact(() => {
    for (const id of editor.selection) {
      const res = doc.cloneNode(id);
      if (!res) continue;
      created.push(res.newId);
      if (doc.isArtboard(id)) {
        const r = editor.measure.peek(id);
        const n = doc.node(id)!;
        const left = pxValue(n.styles.left) ?? r?.x ?? 0;
        doc.setStyles(res.newId, { left: `${round(left + (r?.width ?? 0) + 80)}px` });
      } else if (isFreeChild(doc, id) && !doc.isArtboard(id)) {
        const n = doc.node(res.newId)!;
        const left = pxValue(n.styles.left);
        const top = pxValue(n.styles.top);
        if (left !== null && top !== null) doc.setStyles(res.newId, { left: `${left + 10}px`, top: `${top + 10}px` });
      }
    }
  });
  editor.select(created);
  doc.breakUndoGroup();
}

/** Envuelve la selección en un Frame (flex, o libre si los nodos eran libres). */
export function wrapSelection(editor: EditorState) {
  const { doc } = editor;
  const sel = editor.selection.filter((id) => doc.node(id) && !doc.isVirtual(id));
  if (!sel.length) return;
  const parentId = doc.parentId(sel[0]!);
  if (!parentId || doc.isInsideInstance(parentId)) return;
  const siblings = doc.childIds(parentId);
  const ordered = siblings.filter((s) => sel.includes(s));
  if (!ordered.length) return;
  doc.breakUndoGroup();
  const free = doc.isFreeform(parentId);
  let frameId = '';
  doc.transact(() => {
    const firstIdx = siblings.indexOf(ordered[0]!);
    const key = doc.sortKeyForIndex(parentId, firstIdx);
    if (free) {
      const rects = ordered.map((id) => editor.measure.peek(id)).filter((r): r is Rect => !!r);
      const u = unionRects(rects) ?? { x: 0, y: 0, width: 100, height: 100 };
      const pr = parentId === editor.rootId ? { x: 0, y: 0 } : (editor.measure.peek(parentId) ?? { x: 0, y: 0 });
      frameId = doc.createNode('Frame', parentId, {
        sortKey: key,
        styles: {
          display: FREEFORM_DISPLAY,
          left: `${round(u.x - pr.x)}px`,
          top: `${round(u.y - pr.y)}px`,
          width: `${round(u.width)}px`,
          height: `${round(u.height)}px`,
        },
      });
      const keys = keysBetween(null, null, ordered.length);
      ordered.forEach((id, i) => {
        const r = editor.measure.peek(id);
        doc.moveNode(id, frameId, keys[i]!);
        if (r) doc.setStyles(id, { left: `${round(r.x - u.x)}px`, top: `${round(r.y - u.y)}px`, right: null, bottom: null });
      });
    } else {
      const parent = doc.node(parentId);
      frameId = doc.createNode('Frame', parentId, {
        sortKey: key,
        styles: { display: 'flex', flexDirection: (parent?.styles.flexDirection as string) ?? 'column', gap: parent?.styles.gap ?? '0px' },
      });
      const keys = keysBetween(null, null, ordered.length);
      ordered.forEach((id, i) => doc.moveNode(id, frameId, keys[i]!));
    }
  });
  editor.select([frameId]);
  doc.breakUndoGroup();
}

export function nudgeSelection(editor: EditorState, dx: number, dy: number) {
  const { doc } = editor;
  doc.transact(() => {
    for (const id of editor.selection) {
      if (doc.isVirtual(id) || !isFreeChild(doc, id) || doc.isEffectivelyLocked(id)) continue;
      const { left, top } = ensureLeftTop(editor, id);
      doc.setStyles(id, { left: `${round(left + dx)}px`, top: `${round(top + dy)}px` });
    }
  });
}

// ------------------------------------------------------------------ portapapeles

export interface ClipNode {
  node: TreeNode;
  children: ClipNode[];
}

export const CLIP_MARKER = 'moki/clipboard:';

export function serializeSubtree(doc: DocStore, id: string): ClipNode | null {
  const n = doc.node(id);
  if (!n) return null;
  // Una instancia se copia como instancia (sin hijos: vienen del main); un nodo dentro de una
  // instancia se copia como nodos normales con sus overrides aplicados.
  const node = toJS(n);
  if (!node.instanceOf) delete node.overrides;
  return {
    node,
    children: node.instanceOf ? [] : doc.childIds(id).map((c) => serializeSubtree(doc, c)).filter((x): x is ClipNode => !!x),
  };
}

export function insertSubtree(doc: DocStore, clip: ClipNode, parentId: string, sortKey?: string): string {
  const { id: _old, ...rest } = clip.node;
  void _old;
  delete (rest as Partial<TreeNode>)['~'];
  const newId = doc.addNode({ ...rest, styles: { ...rest.styles } }, parentId, sortKey);
  const keys = keysBetween(null, null, clip.children.length);
  clip.children.forEach((c, i) => insertSubtree(doc, c, newId, keys[i]));
  return newId;
}

let internalClipboard: ClipNode[] = [];

export function copySelection(editor: EditorState) {
  const clips = editor.selection.map((id) => serializeSubtree(editor.doc, id)).filter((x): x is ClipNode => !!x);
  if (!clips.length) return;
  internalClipboard = clips;
  const text = CLIP_MARKER + JSON.stringify(clips);
  navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function cutSelection(editor: EditorState) {
  copySelection(editor);
  deleteSelection(editor);
}

/** Destino de pegado: dentro del contenedor seleccionado, junto a la selección o en la raíz. */
function pasteTarget(editor: EditorState): { parentId: string; afterId: string | null } {
  const { doc } = editor;
  let sel = editor.selection[editor.selection.length - 1];
  if (sel && doc.isVirtual(sel)) sel = sel.split('::')[0]; // nunca dentro de una instancia
  if (sel) {
    const n = doc.node(sel);
    if (n?.instanceOf && editor.selection.length === 1) {
      const p = doc.parentId(sel);
      if (p) return { parentId: p, afterId: sel };
    }
    if (n?.component === 'Frame' && editor.selection.length === 1) return { parentId: sel, afterId: null };
    const p = doc.parentId(sel);
    if (p) return { parentId: p, afterId: sel };
  }
  return { parentId: editor.rootId, afterId: null };
}

export function pasteClips(editor: EditorState, clips: ClipNode[]) {
  const { doc } = editor;
  if (!clips.length) return;
  doc.breakUndoGroup();
  const { parentId, afterId } = pasteTarget(editor);
  const created: string[] = [];
  doc.transact(() => {
    const keys = doc.sortKeysAfter(parentId, afterId, clips.length);
    clips.forEach((c, i) => {
      const clip = structuredClone(c);
      const free = doc.isFreeform(parentId);
      if (!free) {
        for (const k of ['left', 'top', 'right', 'bottom']) delete clip.node.styles[k];
        if (clip.node.styles.position === 'absolute') delete clip.node.styles.position;
      } else if (parentId === editor.rootId && pxValue(clip.node.styles.left) === null) {
        const v = editor.visibleWorldRect();
        clip.node.styles.left = `${round(v.minX + 40)}px`;
        clip.node.styles.top = `${round(v.minY + 40)}px`;
      }
      created.push(insertSubtree(doc, clip, parentId, keys[i]));
    });
  });
  editor.select(created);
  doc.breakUndoGroup();
}

export function pasteFromText(editor: EditorState, text: string) {
  if (text.startsWith(CLIP_MARKER)) {
    try {
      pasteClips(editor, JSON.parse(text.slice(CLIP_MARKER.length)) as ClipNode[]);
      return;
    } catch {
      /* texto normal */
    }
  }
  if (!text.trim()) return;
  const { doc } = editor;
  const { parentId, afterId } = pasteTarget(editor);
  doc.breakUndoGroup();
  const v = editor.visibleWorldRect();
  const free = doc.isFreeform(parentId);
  const styles: Styles = { fontFamily: 'Inter', fontSize: '16px', lineHeight: '24px', color: '#000000' };
  if (free && parentId === editor.rootId) {
    styles.left = `${round((v.minX + v.maxX) / 2)}px`;
    styles.top = `${round((v.minY + v.maxY) / 2)}px`;
  }
  const key = doc.sortKeysAfter(parentId, afterId, 1)[0];
  const id = doc.createNode('Text', parentId, { styles, textValue: text, sortKey: key });
  editor.select([id]);
  doc.breakUndoGroup();
}

export function pasteInternal(editor: EditorState) {
  pasteClips(editor, internalClipboard);
}

/** Sube un fichero de imagen y crea un Rectangle con ella como relleno. */
export async function insertImageFile(editor: EditorState, file: File, world?: { x: number; y: number }) {
  const res = await fetch(`/api/files/${encodeURIComponent(editor.session.fileId)}/assets`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  const info = (await res.json()) as { url: string; width?: number; height?: number };
  let w = info.width ?? 400;
  let h = info.height ?? 300;
  const max = 800;
  if (w > max || h > max) {
    const k = max / Math.max(w, h);
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  const v = editor.visibleWorldRect();
  const p = world ?? { x: (v.minX + v.maxX) / 2 - w / 2, y: (v.minY + v.maxY) / 2 - h / 2 };
  const parentId = editor.containerAt(p.x, p.y);
  editor.doc.breakUndoGroup();
  const id = createShape(editor, {
    component: 'Rectangle',
    parentId,
    worldRect: { x: p.x, y: p.y, width: w, height: h },
    extraStyles: {
      backgroundColor: '',
      backgroundImage: `url(${info.url})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    },
  });
  editor.doc.setLabel(id, file.name.replace(/\.[a-z0-9]+$/i, '') || 'Image');
  editor.select([id]);
  editor.doc.breakUndoGroup();
}
