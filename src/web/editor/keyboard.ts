import { tryPastePaper } from '../import/paste-paper';
import { runInAction } from 'mobx';
import type { EditorState } from './editor-state';
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  insertImageFile,
  nudgeSelection,
  pasteFromText,
  pasteInternal,
  wrapSelection,
} from './actions';
import { createComponentFromSelection, detachSelection } from './component-actions';

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

/** Atajos globales del editor. Devuelve la función de limpieza. */
export function installKeyboard(editor: EditorState): () => void {
  const { doc } = editor;

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' && editor.editingTextId) {
      editor.stopTextEdit();
      return;
    }
    if (e.key === 'Alt') {
      // Option: medir distancias (no interfiere con escribir texto).
      if (!isTypingTarget(e.target)) e.preventDefault();
      editor.setAlt(true);
      return;
    }
    if (isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();

    if (k === ' ' && !e.repeat) {
      runInAction(() => (editor.spaceDown = true));
      e.preventDefault();
      return;
    }

    // Componentes (como en Figma): Cmd/Ctrl+Alt+K crea, Cmd/Ctrl+Alt+B desvincula.
    if (mod && e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      createComponentFromSelection(editor);
      return;
    }
    if (mod && e.altKey && e.code === 'KeyB') {
      e.preventDefault();
      detachSelection(editor);
      return;
    }

    if (mod) {
      switch (k) {
        case 'z':
          e.preventDefault();
          if (e.shiftKey) doc.redo();
          else doc.undo();
          return;
        case 'y':
          e.preventDefault();
          doc.redo();
          return;
        case 'd':
          e.preventDefault();
          duplicateSelection(editor);
          return;
        case 'g':
          e.preventDefault();
          wrapSelection(editor);
          return;
        case 'a': {
          e.preventDefault();
          const p = editor.selection.length ? doc.parentId(editor.selection[0]!) : editor.rootId;
          if (p) editor.select(doc.childIds(p));
          return;
        }
        case '=':
        case '+':
          e.preventDefault();
          editor.zoomIn();
          return;
        case '-':
          e.preventDefault();
          editor.zoomOut();
          return;
        case '0':
          e.preventDefault();
          editor.zoomAt(1);
          return;
        case '1':
          e.preventDefault();
          editor.zoomToFit();
          return;
        case 'h':
          if (e.shiftKey) {
            e.preventDefault();
            const vis = editor.selection.some((id) => doc.node(id)?.isVisible !== false);
            doc.breakUndoGroup();
            doc.transact(() => editor.selection.forEach((id) => doc.setVisible(id, !vis)));
          }
          return;
        case 'l':
          if (e.shiftKey) {
            e.preventDefault();
            const locked = editor.selection.every((id) => doc.node(id)?.isLocked);
            doc.breakUndoGroup();
            doc.transact(() => editor.selection.forEach((id) => doc.setLocked(id, !locked)));
          }
          return;
      }
      return; // c/v/x los gestionan los eventos copy/paste/cut
    }

    if (e.shiftKey && (e.code === 'Digit1' || k === '1')) {
      e.preventDefault();
      editor.zoomToFit();
      return;
    }
    if (e.shiftKey && (e.code === 'Digit2' || k === '2')) {
      e.preventDefault();
      editor.zoomToSelection();
      return;
    }

    switch (k) {
      case 'v':
        editor.setTool('move');
        return;
      case 'f':
      case 'a':
        editor.setTool('frame');
        return;
      case 'r':
        editor.setTool('rect');
        return;
      case 't':
        editor.setTool('text');
        return;
      case 'h':
        editor.setTool('hand');
        return;
      case 'c':
        editor.setTool('comment');
        return;
      case 'delete':
      case 'backspace':
        e.preventDefault();
        deleteSelection(editor);
        return;
      case 'escape':
        if (editor.tool !== 'move') editor.setTool('move');
        else selectParent(editor);
        return;
      case 'enter': {
        e.preventDefault();
        if (e.shiftKey) {
          selectParent(editor);
          return;
        }
        const one = editor.selection.length === 1 ? doc.node(editor.selection[0]) : undefined;
        if (one?.component === 'Text') {
          editor.startTextEdit(one.id);
          return;
        }
        const kids = editor.selection.flatMap((id) => doc.childIds(id));
        if (kids.length) editor.select(kids);
        return;
      }
      case 'arrowleft':
      case 'arrowright':
      case 'arrowup':
      case 'arrowdown': {
        if (!editor.selection.length) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
        const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
        nudgeSelection(editor, dx, dy);
        return;
      }
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') runInAction(() => (editor.spaceDown = false));
    if (e.key === 'Alt') editor.setAlt(false);
  };
  // Si la ventana pierde el foco con Option pulsado no llega el keyup: se suelta aquí.
  const onBlur = () => {
    editor.setAlt(false);
    runInAction(() => (editor.spaceDown = false));
  };

  const onCopy = (e: ClipboardEvent) => {
    if (isTypingTarget(e.target) || !editor.selection.length) return;
    e.preventDefault();
    copySelection(editor);
  };
  const onCut = (e: ClipboardEvent) => {
    if (isTypingTarget(e.target) || !editor.selection.length) return;
    e.preventDefault();
    cutSelection(editor);
  };
  const onPaste = (e: ClipboardEvent) => {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    const html = e.clipboardData?.getData('text/html') ?? '';
    if (html && tryPastePaper(editor, html)) return;
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      for (const f of files) insertImageFile(editor, f).catch((err) => console.error(err));
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text) pasteFromText(editor, text);
    else pasteInternal(editor);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('copy', onCopy);
  window.addEventListener('cut', onCut);
  window.addEventListener('paste', onPaste);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('copy', onCopy);
    window.removeEventListener('cut', onCut);
    window.removeEventListener('paste', onPaste);
  };
}

function selectParent(editor: EditorState) {
  const parents = editor.selection.map((id) => editor.doc.parentId(id)).filter((p): p is string => !!p && !p.startsWith('root_node_'));
  editor.select(parents);
}
