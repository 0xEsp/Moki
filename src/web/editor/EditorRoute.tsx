import { ThemeToggle } from '../ThemeToggle';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { FileSession } from '../state/file-session';
import { EditorState, type Tool } from './editor-state';
import { installKeyboard } from './keyboard';
import { Canvas } from '../canvas/Canvas';
import { LeftSidebar } from '../panels/LeftSidebar';
import { RightSidebar } from '../panels/Properties';
import { Logo } from '../dashboard/Dashboard';
import { navigate } from '../router';
import { TextInput } from '../panels/controls';
import { ExportDialog } from '../panels/ExportDialog';

export function EditorRoute({ fileId, initialPageId }: { fileId: string; initialPageId: string | null }) {
  const [session] = useState(() => new FileSession(fileId, 'human'));
  const [editor, setEditor] = useState<EditorState | null>(null);

  useEffect(() => {
    session.start();
    let ed: EditorState | null = null;
    let disposeKeys: (() => void) | null = null;
    let cancelled = false;
    session.ready().then((doc) => {
      if (cancelled) return;
      ed = new EditorState(session, doc, initialPageId);
      disposeKeys = installKeyboard(ed);
      if (import.meta.env.DEV) (window as unknown as { __mokiEditor: EditorState }).__mokiEditor = ed;
      setEditor(ed);
    });
    return () => {
      cancelled = true;
      disposeKeys?.();
      ed?.dispose();
      session.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  if (!editor) return <LoadingScreen session={session} />;
  return <Editor editor={editor} />;
}

const LoadingScreen = observer(function LoadingScreen({ session }: { session: FileSession }) {
  return (
    <div className="loading-screen">
      <Logo size={22} />
      {session.status === 'not_found' ? (
        <>
          <p>Este fichero no existe.</p>
          <button className="btn" onClick={() => navigate('/')}>
            Volver a mis diseños
          </button>
        </>
      ) : session.status === 'error' ? (
        <p>No se pudo cargar el fichero.</p>
      ) : (
        <p className="muted">{session.status === 'disconnected' ? 'Reconectando…' : 'Cargando…'}</p>
      )}
    </div>
  );
});

const Editor = observer(function Editor({ editor }: { editor: EditorState }) {
  return (
    <div className="editor">
      <TopBar editor={editor} />
      <div className="editor-body">
        <LeftSidebar editor={editor} />
        <Canvas editor={editor} />
        <RightSidebar editor={editor} />
      </div>
    </div>
  );
});

const TOOLS: { tool: Tool; label: string; key: string; title: string }[] = [
  { tool: 'move', label: '↖', key: 'V', title: 'Mover' },
  { tool: 'frame', label: '#', key: 'F', title: 'Frame / artboard' },
  { tool: 'rect', label: '▭', key: 'R', title: 'Rectángulo' },
  { tool: 'text', label: 'T', key: 'T', title: 'Texto' },
  { tool: 'hand', label: '✋', key: 'H', title: 'Mano' },
  { tool: 'comment', label: '💬', key: 'C', title: 'Comentario' },
];

const TopBar = observer(function TopBar({ editor }: { editor: EditorState }) {
  const { doc, session } = editor;
  const agents = new Map<string, number>();
  for (const a of session.remoteAgents) {
    const active = a.nodes.some((n) => editor.now - n.at < 40_000);
    if (active) agents.set(a.harness ?? 'Agente', (agents.get(a.harness ?? 'Agente') ?? 0) + 1);
  }
  const otherTabs = [...session.users.values()].filter((u) => u.kind === 'human' && u.clientId !== session.sync.clientId).length;
  const statusLabel =
    session.status === 'connected' ? 'Guardado' : session.status === 'connecting' ? 'Conectando…' : session.status === 'disconnected' ? 'Sin conexión (los cambios se enviarán al reconectar)' : 'Error';

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn logo-btn" title="Mis diseños" onClick={() => navigate('/')}>
          <span className="moki-logo-dot" />
        </button>
        <TextInput value={doc.data.name} className="file-name" onCommit={(v) => v.trim() && doc.setFileName(v.trim())} />
        <span className="muted topbar-page">/ {editor.activePage?.label}</span>
      </div>
      <div className="tools">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            className={`tool-btn${editor.tool === t.tool ? ' on' : ''}`}
            title={`${t.title} (${t.key})`}
            onClick={() => editor.setTool(t.tool)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="topbar-right">
        <ThemeToggle />
        {[...agents.entries()].map(([name]) => (
          <span key={name} className="agent-pill" title="Un agente está trabajando en este fichero">
            <span className="agent-dot pulse" /> {name} trabajando
          </span>
        ))}
        {otherTabs > 0 && <span className="muted small">{otherTabs + 1} pestañas</span>}
        <span className={`status-dot ${session.status}`} title={statusLabel} />
        <button className="icon-btn" title="Deshacer (⌘Z)" disabled={!doc.canUndo} onClick={() => doc.undo()}>
          ↶
        </button>
        <button className="icon-btn" title="Rehacer (⇧⌘Z)" disabled={!doc.canRedo} onClick={() => doc.redo()}>
          ↷
        </button>
        <ExportButton editor={editor} />
        <ZoomMenu editor={editor} />
      </div>
    </header>
  );
});

/** Botón "Exportar" de la barra superior → diálogo (selección, página o proyecto entero). */
const ExportButton = observer(function ExportButton({ editor }: { editor: EditorState }) {
  const [open, setOpen] = useState(false);
  // Los hijos de instancias (ids virtuales) no son nodos exportables por sí mismos.
  const selected = editor.selection.filter((id) => !id.includes('::'));
  const page = editor.doc.page(editor.activePageId);
  return (
    <>
      <button className="btn btn-sm" title="Exportar la selección, la página o el proyecto" onClick={() => setOpen(true)}>
        Exportar
      </button>
      {open && (
        <ExportDialog
          title="Exportar"
          initialScope={selected.length ? 'nodes' : 'page'}
          scopes={[
            { scope: 'nodes', label: selected.length ? `Selección (${selected.length})` : 'Selección (nada seleccionado)', disabled: !selected.length },
            { scope: 'page', label: `Página actual${page ? ` · ${page.label}` : ''}` },
            { scope: 'file', label: `Proyecto completo · ${editor.doc.data.name}` },
          ]}
          base={{ fileId: editor.doc.data.id, pageId: editor.activePageId, nodeIds: selected }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
});

const ZoomMenu = observer(function ZoomMenu({ editor }: { editor: EditorState }) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(editor.camera.scale * 100);
  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  return (
    <div className="zoom-menu">
      <button className="btn btn-sm zoom-btn" onClick={() => setOpen((o) => !o)}>
        {pct}%
      </button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={act(() => editor.zoomIn())}>Acercar <kbd>⌘+</kbd></button>
          <button onClick={act(() => editor.zoomOut())}>Alejar <kbd>⌘−</kbd></button>
          <button onClick={act(() => editor.zoomAt(1))}>100% <kbd>⌘0</kbd></button>
          <button onClick={act(() => editor.zoomToFit())}>Ajustar todo <kbd>⇧1</kbd></button>
          <button disabled={!editor.selection.length} onClick={act(() => editor.zoomToSelection())}>
            Ajustar selección <kbd>⇧2</kbd>
          </button>
          <button onClick={act(() => runInAction(() => (editor.showComments = !editor.showComments)))}>
            {editor.showComments ? 'Ocultar' : 'Mostrar'} comentarios
          </button>
        </div>
      )}
    </div>
  );
});
