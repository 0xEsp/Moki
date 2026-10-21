import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { internalToRender } from '../../core/tokens';
import { toCssValue } from '../../core/css';
import type { EditorState } from '../editor/editor-state';

// Edición de texto plano: un <textarea> colocado en coordenadas de mundo dentro de la cámara
// (escala con el zoom y resuelve las variables de tokens), con la tipografía del nodo.

const FONT_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign',
  'textTransform', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontVariationSettings',
] as const;

export const TextEditor = observer(function TextEditor({ editor }: { editor: EditorState }) {
  const id = editor.editingTextId;
  if (!id) return null;
  return <TextArea key={id} editor={editor} id={id} />;
});

const TextArea = observer(function TextArea({ editor, id }: { editor: EditorState; id: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const node = editor.doc.node(id);
  const rect = editor.measure.rect(id);
  const [fontStyle, setFontStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    const el = editor.registry.el(id);
    if (!el) return;
    const cs = getComputedStyle(el);
    const s: Record<string, string> = {};
    for (const p of FONT_PROPS) s[p] = cs[p as keyof CSSStyleDeclaration] as string;
    setFontStyle(s as CSSProperties);
  }, [editor, id, node?.styles.fontSize, node?.styles.fontFamily, node?.styles.fontWeight]);

  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    const focus = () => {
      t.focus();
      if (editor.newTextId !== id) t.select();
    };
    focus();
    requestAnimationFrame(focus);
  }, [editor, id]);

  if (!node) return null;
  const autoWidth = node.styles.width === undefined || node.styles.width === 'fit-content' || node.styles.width === 'max-content';
  const parentEl = editor.registry.el(id)?.parentElement;
  const color = node.styles.color !== undefined ? internalToRender(toCssValue('color', node.styles.color)) : parentEl ? getComputedStyle(parentEl).color : '#000';
  const r = rect ?? { x: 0, y: 0, width: 20, height: 24 };

  return (
    <textarea
      ref={ref}
      className="text-edit"
      spellCheck={false}
      value={node.textValue ?? ''}
      style={{
        ...fontStyle,
        color,
        position: 'absolute',
        left: r.x,
        top: r.y,
        width: autoWidth ? Math.max(r.width, 8) + 40 : r.width,
        height: Math.max(r.height, 16),
        whiteSpace: autoWidth ? 'pre' : 'pre-wrap',
      }}
      onChange={(e) => editor.doc.setText(id, e.target.value)}
      onBlur={() => editor.stopTextEdit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          editor.stopTextEdit();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
});
