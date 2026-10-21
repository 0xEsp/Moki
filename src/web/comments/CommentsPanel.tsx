import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { EditorState } from '../editor/editor-state';
import { threadPosition, ThreadView } from './CommentLayer';

export const CommentsPanel = observer(function CommentsPanel({ editor }: { editor: EditorState }) {
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const threads = [...editor.session.threads.values()]
    .filter((t) => !t.deletedAt && (filter === 'all' || t.status === filter))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="panel-scroll">
      <div className="panel-section">
        <div className="section-title">
          Comentarios
          <select className="input input-sm" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="open">Abiertos</option>
            <option value="resolved">Resueltos</option>
            <option value="all">Todos</option>
          </select>
        </div>
        {!editor.session.threadsLoaded && <div className="muted">Cargando…</div>}
        {threads.length === 0 && editor.session.threadsLoaded && (
          <div className="muted">Sin comentarios. Pulsa C y haz clic en el canvas para añadir uno.</div>
        )}
        {threads.map((t) => {
          const page = editor.doc.page(t.pageId);
          const node = editor.doc.node(t.nodeId);
          const isOpen = editor.openThreadId === t.id;
          return (
            <div key={t.id} className={`thread-card${isOpen ? ' active' : ''}`}>
              <div
                className="thread-card-head"
                onClick={() => {
                  if (t.pageId !== editor.activePageId) editor.setPage(t.pageId);
                  runInAction(() => (editor.openThreadId = isOpen ? null : t.id));
                  setTimeout(() => {
                    const p = threadPosition(editor, t);
                    if (p && !isOpen) editor.zoomToRect({ x: p.x - 200, y: p.y - 150, width: 400, height: 300 });
                  }, 50);
                }}
              >
                <div className="thread-card-meta">
                  {page?.label ?? '—'} · {node?.label ?? 'Canvas'}
                </div>
                <div className="thread-card-text">{t.messages.find((m) => !m.deletedAt)?.text}</div>
                <div className="thread-card-meta">
                  {t.messages.length - 1 > 0 ? `${t.messages.length - 1} respuestas · ` : ''}
                  {t.status === 'resolved' ? 'Resuelto' : 'Abierto'}
                </div>
              </div>
              {isOpen && <ThreadView editor={editor} thread={t} />}
            </div>
          );
        })}
      </div>
    </div>
  );
});
