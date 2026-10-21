import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { MessageType } from '../../core/protocol';
import { LOCAL_USER, type CommentThread } from '../../core/types';
import { isRootId } from '../../core/tree';
import { shortId } from '../../core/ids';
import type { EditorState } from '../editor/editor-state';

// Comentarios sobre el canvas: pins anclados a nodo + offset, compositor y popover del hilo.

export function threadPosition(editor: EditorState, t: { nodeId: string; xOffset: number; yOffset: number }) {
  if (isRootId(t.nodeId)) return { x: t.xOffset, y: t.yOffset };
  const r = editor.measure.rect(t.nodeId);
  if (!r) return null;
  return { x: r.x + t.xOffset, y: r.y + t.yOffset };
}

export function sendThreadStatus(editor: EditorState, threadId: string, status: 'open' | 'resolved') {
  editor.session.sync.send({ $t: MessageType.CommentThreadUpdate, threadId, status });
}

export function replyToThread(editor: EditorState, threadId: string, text: string) {
  const now = Date.now();
  editor.session.sync.send({
    $t: MessageType.CommentMessageCreate,
    threadId,
    message: { id: shortId('cm'), userId: LOCAL_USER.id, text, mentions: [], reactions: [], attachments: [], createdAt: now, updatedAt: now },
  });
}

export const CommentLayer = observer(function CommentLayer({ editor }: { editor: EditorState }) {
  void editor.camera;
  void editor.measure.version;
  const showPins = editor.showComments || editor.tool === 'comment';
  const threads = [...editor.session.threads.values()].filter(
    (t) => !t.deletedAt && t.pageId === editor.activePageId && (t.status === 'open' || t.id === editor.openThreadId),
  );
  const draft = editor.commentDraft;
  const draftPos = draft ? threadPosition(editor, draft) : null;
  const open = editor.openThreadId ? editor.session.threads.get(editor.openThreadId) : undefined;
  const openPos = open ? threadPosition(editor, open) : null;

  return (
    <div className="comment-layer">
      {showPins &&
        threads.map((t, i) => {
          const p = threadPosition(editor, t);
          if (!p) return null;
          const s = editor.worldToScreen(p.x, p.y);
          return (
            <button
              key={t.id}
              className={`comment-pin${t.status === 'resolved' ? ' resolved' : ''}${editor.openThreadId === t.id ? ' active' : ''}`}
              style={{ left: s.x, top: s.y }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                runInAction(() => {
                  editor.openThreadId = editor.openThreadId === t.id ? null : t.id;
                  editor.commentDraft = null;
                });
              }}
              title={t.messages[0]?.text}
            >
              {i + 1}
            </button>
          );
        })}

      {draft && draftPos && (
        <Composer
          editor={editor}
          at={editor.worldToScreen(draftPos.x, draftPos.y)}
          onCancel={() => runInAction(() => (editor.commentDraft = null))}
          onSubmit={(text) => {
            const now = Date.now();
            const thread: CommentThread = {
              id: shortId('ct'),
              fileId: editor.session.fileId,
              pageId: draft.pageId,
              nodeId: draft.nodeId,
              xOffset: draft.xOffset,
              yOffset: draft.yOffset,
              status: 'open',
              userId: LOCAL_USER.id,
              messages: [{ id: shortId('cm'), userId: LOCAL_USER.id, text, mentions: [], reactions: [], attachments: [], createdAt: now, updatedAt: now }],
              createdAt: now,
              updatedAt: now,
            };
            editor.session.sync.send({ $t: MessageType.CommentThreadCreate, thread });
            runInAction(() => {
              editor.commentDraft = null;
              editor.showComments = true;
            });
          }}
        />
      )}

      {open && openPos && <ThreadPopover editor={editor} thread={open} at={editor.worldToScreen(openPos.x, openPos.y)} />}
    </div>
  );
});

function Composer({
  at,
  onSubmit,
  onCancel,
}: {
  editor: EditorState;
  at: { x: number; y: number };
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="comment-popover" style={{ left: at.x + 14, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        autoFocus
        className="input"
        placeholder="Añade un comentario…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
            e.preventDefault();
            onSubmit(text.trim());
          }
        }}
      />
      <div className="comment-actions">
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
          Comentar
        </button>
      </div>
    </div>
  );
}

export const ThreadView = observer(function ThreadView({ editor, thread }: { editor: EditorState; thread: CommentThread }) {
  const [reply, setReply] = useState('');
  const msgs = thread.messages.filter((m) => !m.deletedAt);
  return (
    <div className="thread">
      <div className="thread-head">
        <span className={`thread-status ${thread.status}`}>{thread.status === 'open' ? 'Abierto' : 'Resuelto'}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => sendThreadStatus(editor, thread.id, thread.status === 'open' ? 'resolved' : 'open')}>
          {thread.status === 'open' ? 'Resolver' : 'Reabrir'}
        </button>
        <button
          className="icon-btn"
          title="Eliminar hilo"
          onClick={() => {
            if (!confirm('¿Eliminar este hilo?')) return;
            editor.session.sync.send({ $t: MessageType.CommentThreadDelete, threadId: thread.id });
            runInAction(() => (editor.openThreadId = null));
          }}
        >
          🗑
        </button>
      </div>
      {msgs.map((m) => (
        <div key={m.id} className="thread-msg">
          <div className="thread-msg-meta">
            <b>{m.userId === LOCAL_USER.id ? LOCAL_USER.name : m.userId}</b> · {new Date(m.createdAt).toLocaleString()}
          </div>
          <div className="thread-msg-text">{m.text}</div>
        </div>
      ))}
      <textarea
        className="input"
        placeholder="Responder…"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && reply.trim()) {
            e.preventDefault();
            replyToThread(editor, thread.id, reply.trim());
            setReply('');
          }
        }}
      />
    </div>
  );
});

const ThreadPopover = observer(function ThreadPopover({ editor, thread, at }: { editor: EditorState; thread: CommentThread; at: { x: number; y: number } }) {
  return (
    <div className="comment-popover wide" style={{ left: at.x + 16, top: at.y }} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <button className="popover-close icon-btn" onClick={() => runInAction(() => (editor.openThreadId = null))}>
        ×
      </button>
      <ThreadView editor={editor} thread={thread} />
    </div>
  );
});
