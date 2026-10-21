import { pxValue } from '../../core/css';
import type { EditorState } from '../editor/editor-state';
import { pasteClips } from '../editor/actions';
import { convertPaperClipboard, parsePaperClipboard } from './paper-clipboard';

// Pegar en Moki lo copiado en Paper (Cmd+C en Paper → Cmd+V en Moki).

/** Devuelve true si el portapapeles traía nodos de Paper (y se ha gestionado el pegado). */
export function tryPastePaper(editor: EditorState, html: string): boolean {
  const data = parsePaperClipboard(html);
  if (!data) return false;
  void pastePaper(editor, data);
  return true;
}

async function pastePaper(editor: EditorState, data: NonNullable<ReturnType<typeof parsePaperClipboard>>) {
  const { doc, session } = editor;
  const t0 = performance.now();
  doc.breakUndoGroup();
  doc.startGesture(); // tokens + nodos = un solo paso de deshacer
  try {
    const res = await convertPaperClipboard(data, {
      doc,
      importImage: async (src) => {
        const r = await session.sync.rpc('importImage', { src });
        return { url: r.url };
      },
    });
    if (!res.clips.length) return;
    // Conserva la disposición relativa entre las raíces copiadas; en un padre libre se colocan
    // dentro de la zona visible. (En un padre flex `pasteClips` descarta left/top.)
    const minX = Math.min(...res.positions.map((p) => p.x));
    const minY = Math.min(...res.positions.map((p) => p.y));
    const v = editor.visibleWorldRect();
    res.clips.forEach((c, i) => {
      const s = c.node.styles;
      if (pxValue(s.left) === null || editor.selection.length === 0) {
        s.left = `${Math.round(v.minX + 40 + res.positions[i]!.x - minX)}px`;
        s.top = `${Math.round(v.minY + 40 + res.positions[i]!.y - minY)}px`;
        delete s.right;
        delete s.bottom;
      }
    });
    pasteClips(editor, res.clips);
    const n = res.clips.reduce((a, c) => a + count(c), 0);
    console.info(
      `[paste] Paper → Moki: ${n} nodos, ${res.createdTokens} tokens nuevos en ${Math.round(performance.now() - t0)} ms`,
      res.warnings.length ? res.warnings : '',
    );
  } catch (e) {
    console.error('[paste] no se pudo importar desde Paper', e);
  } finally {
    doc.endGesture();
    doc.breakUndoGroup();
  }
}

function count(c: { children: { children: unknown[] }[] }): number {
  return 1 + c.children.reduce((a, x) => a + count(x as typeof c), 0);
}
