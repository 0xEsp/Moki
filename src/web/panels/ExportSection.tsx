import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { ExportRequestItem } from '../../core/protocol';
import type { DocStore } from '../state/doc-store';
import type { EditorState } from '../editor/editor-state';
import { Section } from './controls';

type SerializeSvg = (doc: DocStore, nodeId: string) => string;
const svgModules = import.meta.glob('../mcp/svg-export.ts');

async function svgMarkup(doc: DocStore, nodeId: string): Promise<string | undefined> {
  const loader = svgModules['../mcp/svg-export.ts'];
  if (!loader) return undefined;
  const m = (await loader()) as { serializeSvgNode: SerializeSvg };
  return m.serializeSvgNode(doc, nodeId);
}

export async function exportNode(
  editor: EditorState,
  nodeId: string,
  format: ExportRequestItem['format'],
  scale: number,
): Promise<void> {
  const node = editor.doc.node(nodeId);
  if (!node) return;
  const suffix = scale === 1 ? '' : `@${scale}x`;
  const item: ExportRequestItem = { nodeId, format, scale, fileName: `${node.label}${suffix}.${format}` };
  if (format === 'svg') item.svgMarkup = await svgMarkup(editor.doc, nodeId);
  const res = await editor.session.sync.rpc('exportFiles', { items: [item] });
  if (res.errors.length) throw new Error(res.errors.map((e) => e.error).join('\n'));
  for (const ex of res.exports) {
    const a = document.createElement('a');
    a.href = ex.downloadUrl;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

export const ExportSection = observer(function ExportSection({ editor, nodeId }: { editor: EditorState; nodeId: string }) {
  const node = editor.doc.node(nodeId);
  const [format, setFormat] = useState<ExportRequestItem['format']>(node?.component === 'SVG' ? 'svg' : 'png');
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Exportar">
      <div className="prop-row">
        <select className="input" value={scale} onChange={(e) => setScale(Number(e.target.value))} disabled={format === 'svg'}>
          {[0.5, 1, 2, 3, 4].map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        <select className="input" value={format} onChange={(e) => setFormat(e.target.value as ExportRequestItem['format'])}>
          {(['png', 'jpg', 'webp', 'avif', 'svg', 'pdf'] as const).map((f) => (
            <option key={f} value={f}>
              {f.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <button
        className="btn grow"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await exportNode(editor, nodeId, format, format === 'pdf' || format === 'svg' ? 1 : scale);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Exportando…' : `Exportar ${node?.label ?? ''}`}
      </button>
      {error && <div className="error-text">{error}</div>}
    </Section>
  );
});
