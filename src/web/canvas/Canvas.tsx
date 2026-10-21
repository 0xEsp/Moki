import { DEFAULT_CANVAS_COLOR } from '../../core/new-file';
import { autorun, reaction, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef } from 'react';
import type { EditorState } from '../editor/editor-state';
import { insertImageFile } from '../editor/actions';
import { insertInstance } from '../editor/component-actions';
import { COMPONENT_DRAG_TYPE } from '../panels/ComponentsPanel';
import { RenderTree, TokenVars } from './render-node';
import { CanvasController } from './interactions';
import { Overlay } from './Overlay';
import { TextEditor } from './TextEditor';
import { CommentLayer } from '../comments/CommentLayer';

const CURSORS: Record<string, string> = {
  move: 'default',
  frame: 'crosshair',
  rect: 'crosshair',
  text: 'text',
  hand: 'grab',
  comment: 'copy',
};

export const Canvas = observer(function Canvas({ editor }: { editor: EditorState }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const controller = useMemo(() => new CanvasController(editor), [editor]);

  // Cámara → transform (sin re-render de React).
  //
  // Nitidez: con `will-change: transform` permanente Chrome rasteriza la capa UNA vez y luego solo
  // escala ese bitmap, así que al hacer zoom el texto se ve borroso/pixelado. Se activa solo
  // mientras la cámara se mueve (pan/zoom fluidos) y se quita al parar, lo que obliga a
  // re-rasterizar a la escala real.
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const dispose = autorun(() => {
      const { x, y, scale } = editor.camera;
      const el = cameraRef.current;
      if (!el) return;
      el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      el.toggleAttribute('data-pixelated', scale > 1.5);
      el.style.willChange = 'transform';
      clearTimeout(settle);
      settle = setTimeout(() => {
        el.style.willChange = 'auto';
      }, 150);
    });
    return () => {
      clearTimeout(settle);
      dispose();
    };
  }, [editor]);

  // Tamaño del viewport.
  useEffect(() => {
    const el = viewportRef.current!;
    const update = () => {
      const r = el.getBoundingClientRect();
      editor.setViewport({ width: r.width, height: r.height, left: r.left, top: r.top });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [editor]);

  // Rueda y gestos (listeners no pasivos).
  useEffect(() => {
    const el = viewportRef.current!;
    el.addEventListener('wheel', controller.onWheel, { passive: false });
    el.addEventListener('gesturestart', controller.onGestureStart);
    el.addEventListener('gesturechange', controller.onGestureChange);
    return () => {
      el.removeEventListener('wheel', controller.onWheel);
      el.removeEventListener('gesturestart', controller.onGestureStart);
      el.removeEventListener('gesturechange', controller.onGestureChange);
    };
  }, [controller]);

  // Medición: observar el DOM del diseño de la página activa.
  useEffect(() => {
    editor.measure.attach(scopeRef.current);
    return () => editor.measure.attach(null);
  }, [editor, editor.activePageId]);

  // Encuadre inicial de cada página (cuando ya hay medidas).
  useEffect(
    () =>
      reaction(
        () => [editor.measure.version, editor.activePageId, editor.viewport.width] as const,
        () => {
          if (!editor.pendingFit || editor.viewport.width <= 1) return;
          const hasNodes = editor.doc.childIds(editor.rootId).length > 0;
          if (hasNodes && editor.measure.version === 0) return;
          editor.pendingFit = false;
          if (hasNodes) editor.zoomToFit();
          else editor.setCamera({ x: editor.viewport.width / 2 - 200, y: editor.viewport.height / 2 - 200, scale: 1 });
        },
        { fireImmediately: true },
      ),
    [editor],
  );

  const page = editor.activePage;
  const cursor = editor.spaceDown ? 'grab' : (CURSORS[editor.tool] ?? 'default');

  return (
    <div
      ref={viewportRef}
      className="canvas-viewport"
      // El gris por defecto sigue al tema de la interfaz (#ECECEC claro / #1E1E1E oscuro); un color
      // elegido por el usuario se respeta siempre.
      style={{ background: isDefaultCanvas(page?.canvasColor) ? 'var(--ui-canvas-default)' : page!.canvasColor, cursor }}
      onPointerDown={controller.onPointerDown}
      onPointerMove={controller.onPointerMove}
      onPointerUp={controller.onPointerUp}
      onPointerCancel={controller.onPointerUp}
      onPointerLeave={() => {
        if (controller.drag) return;
        editor.setHover(null);
        runInAction(() => (editor.pointerWorld = null));
      }}
      onDoubleClick={controller.onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(COMPONENT_DRAG_TYPE)) e.preventDefault();
      }}
      onDrop={(e) => {
        const mainId = e.dataTransfer.getData(COMPONENT_DRAG_TYPE);
        if (mainId) {
          e.preventDefault();
          const v = editor.viewport;
          insertInstance(editor, mainId, editor.screenToWorld(e.clientX - v.left, e.clientY - v.top));
          return;
        }
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        const v = editor.viewport;
        let w = editor.screenToWorld(e.clientX - v.left, e.clientY - v.top);
        for (const f of files) {
          insertImageFile(editor, f, w).catch((err) => alert(`No se pudo subir la imagen: ${err.message}`));
          w = { x: w.x + 24, y: w.y + 24 };
        }
      }}
    >
      <div ref={cameraRef} className="canvas-camera">
        <div ref={scopeRef} className="moki-canvas-scope">
          <TokenVars doc={editor.doc} scope=".moki-canvas-scope" />
          <RenderTree
            key={editor.rootId}
            doc={editor.doc}
            rootId={editor.rootId}
            registry={editor.registry}
            editingTextId={editor.editingTextId}
          />
          <TextEditor editor={editor} />
        </div>
      </div>
      <Overlay editor={editor} controller={controller} />
      <CommentLayer editor={editor} />
      <ZoomHint editor={editor} />
    </div>
  );
});

const ZoomHint = observer(function ZoomHint({ editor }: { editor: EditorState }) {
  const empty = editor.doc.childIds(editor.rootId).length === 0;
  if (!empty) return null;
  return (
    <div className="canvas-empty-hint">
      Pulsa <kbd>F</kbd> y arrastra para crear un artboard, o pide a tu agente que diseñe aquí.
    </div>
  );
});

function isDefaultCanvas(color: string | undefined): boolean {
  return !color || color.toUpperCase() === DEFAULT_CANVAS_COLOR.toUpperCase();
}
