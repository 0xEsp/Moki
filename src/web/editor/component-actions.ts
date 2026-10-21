import { runInAction } from 'mobx';
import { pxValue } from '../../core/css';
import { isVirtualId, outerInstanceOf } from '../../core/components';
import type { EditorState } from './editor-state';

// Acciones de componentes del editor (crear main, insertar instancia, desvincular, restablecer).

const round = (n: number) => Math.round(n * 100) / 100;

/** Muestra un error de forma simple (las acciones de UI no deben lanzar). */
function report(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn('[componentes]', msg);
  window.alert(msg);
}

/** Cmd+Alt+K: convierte el Frame seleccionado en componente principal. */
export function createComponentFromSelection(editor: EditorState) {
  const { doc } = editor;
  const id = editor.selection[0];
  if (!id || editor.selection.length !== 1) return;
  const n = doc.node(id);
  if (!n || n.component !== 'Frame' || n.isComponent || n.instanceOf || isVirtualId(id)) return;
  doc.breakUndoGroup();
  try {
    doc.transact(() => doc.createComponentFrom(id));
  } catch (e) {
    report(e);
  }
  doc.breakUndoGroup();
}

/**
 * Inserta una instancia de `mainId`: dentro del Frame seleccionado (si se puede), o en el
 * canvas en el centro de la vista (o en `world`, si viene de soltar en el canvas).
 */
export function insertInstance(editor: EditorState, mainId: string, world?: { x: number; y: number }) {
  const { doc } = editor;
  const main = doc.view(mainId);
  if (!main) return;
  const r = editor.measure.peek(mainId);
  const w = r?.width ?? pxValue(main.styles.width) ?? 120;
  const h = r?.height ?? pxValue(main.styles.height) ?? 48;
  let parentId = editor.rootId;
  if (world) parentId = editor.containerAt(world.x, world.y);
  else {
    const sel = editor.selection.length === 1 ? editor.selection[0]! : null;
    if (sel && doc.node(sel)?.component === 'Frame' && !doc.isInsideInstance(sel) && sel !== mainId) parentId = sel;
  }
  if (!doc.components.canPlaceInstance(mainId, parentId)) parentId = editor.rootId;
  const styles: Record<string, string> = {};
  if (doc.isFreeform(parentId)) {
    const v = editor.visibleWorldRect();
    const at = world ?? { x: (v.minX + v.maxX) / 2, y: (v.minY + v.maxY) / 2 };
    const pr = parentId === editor.rootId ? { x: 0, y: 0 } : (editor.measure.peek(parentId) ?? { x: 0, y: 0 });
    styles.left = `${round(at.x - w / 2 - pr.x)}px`;
    styles.top = `${round(at.y - h / 2 - pr.y)}px`;
  }
  doc.breakUndoGroup();
  try {
    const id = doc.transact(() => doc.createInstance(mainId, parentId, undefined, styles));
    editor.select([id]);
  } catch (e) {
    report(e);
  }
  doc.breakUndoGroup();
}

/** Desvincula la instancia seleccionada (o la que contiene a la selección). */
export function detachSelection(editor: EditorState) {
  const { doc } = editor;
  const ids = [...new Set(editor.selection.map((id) => (isVirtualId(id) ? outerInstanceOf(id) : id)))].filter((id) => doc.node(id)?.instanceOf);
  if (!ids.length) return;
  doc.breakUndoGroup();
  doc.transact(() => {
    for (const id of ids) doc.detachInstance(id);
  });
  editor.select(ids);
  doc.breakUndoGroup();
}

/** Restablece los overrides de la selección (instancias o capas dentro de instancias). */
export function resetOverridesSelection(editor: EditorState) {
  const { doc } = editor;
  const ids = editor.selection.filter((id) => doc.isInsideInstance(id));
  if (!ids.length) return;
  doc.breakUndoGroup();
  doc.transact(() => {
    for (const id of ids) doc.resetOverrides(id);
  });
  doc.breakUndoGroup();
}

/** Navega al componente principal (cambia de página si hace falta) y lo selecciona. */
export function goToMainComponent(editor: EditorState, mainId: string) {
  const { doc } = editor;
  const pageId = doc.pageIdOf(mainId);
  if (!pageId) return;
  editor.setPage(pageId);
  const focus = (tries: number) => {
    if (editor.measure.peek(mainId) || tries <= 0) {
      runInAction(() => {
        editor.pendingFit = false;
        editor.select([mainId]);
      });
      editor.zoomToSelection();
      return;
    }
    requestAnimationFrame(() => focus(tries - 1));
  };
  requestAnimationFrame(() => focus(60));
}

/** Instancia (real) a la que pertenece un id, si está dentro de una. */
export function instanceOfSelection(editor: EditorState, id: string): string | null {
  if (isVirtualId(id)) return outerInstanceOf(id);
  return editor.doc.node(id)?.instanceOf ? id : null;
}
