import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useRef, useState } from 'react';
import type { PageIcon } from '../../core/types';
import type { EditorState } from '../editor/editor-state';
import { ComponentsPanel } from './ComponentsPanel';

const PAGE_ICON_GLYPH: Record<PageIcon, string> = {
  arrow: '➜', padlock: '🔒', check: '✓', cross: '✕', info: 'ℹ', question: '?', design: '✎', vector: '✒',
  images: '▣', table: '▦', presentation: '▭', blueprint: '⌗', swatches: '◐', 'bar-chart': '▥',
  'line-chart': '⟋', 'pie-chart': '◔', junk: '🗑',
};

const COMPONENT_GLYPH: Record<string, string> = {
  Frame: '#', Text: 'T', Rectangle: '▭', SVG: '◇', SVGVisualElement: '◇',
};

const PAGES_MIN = 58; // título + una fila
const LAYERS_MIN = 120;
const PAGES_HEIGHT_KEY = 'moki.pagesHeight';

function readPagesHeight(): number | null {
  try {
    const v = Number(localStorage.getItem(PAGES_HEIGHT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export const LeftSidebar = observer(function LeftSidebar({ editor }: { editor: EditorState }) {
  // Páginas y Capas comparten la columna: un divisor arrastrable reparte la altura (como en
  // Figma). Doble clic en el divisor ajusta Páginas para que se vean todas sin scroll.
  const asideRef = useRef<HTMLElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pagesHeight, setPagesHeight] = useState<number | null>(readPagesHeight);
  const clamp = (h: number) => {
    const total = asideRef.current?.clientHeight ?? 800;
    return Math.round(Math.max(PAGES_MIN, Math.min(h, total - LAYERS_MIN)));
  };
  const save = (h: number) => {
    try {
      localStorage.setItem(PAGES_HEIGHT_KEY, String(h));
    } catch {
      /* sin almacenamiento: solo dura esta sesión */
    }
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = pagesRef.current?.getBoundingClientRect().height ?? PAGES_MIN;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = startH;
    const move = (ev: PointerEvent) => {
      last = clamp(startH + ev.clientY - startY);
      setPagesHeight(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      save(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const fitPages = () => {
    const list = pagesRef.current;
    if (!list) return;
    const h = clamp(list.scrollHeight + 2);
    setPagesHeight(h);
    save(h);
  };
  return (
    <aside className="left-sidebar" ref={asideRef}>
      <div className="pages-pane" ref={pagesRef} style={pagesHeight ? { height: pagesHeight } : undefined}>
        <PagesList editor={editor} />
      </div>
      <div
        className="sidebar-splitter"
        role="separator"
        aria-orientation="horizontal"
        title="Arrastra para repartir el espacio · doble clic: ver todas las páginas"
        onPointerDown={onPointerDown}
        onDoubleClick={fitPages}
      />
      <LayersTree editor={editor} />
    </aside>
  );
});

const PagesList = observer(function PagesList({ editor }: { editor: EditorState }) {
  const { doc } = editor;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const pages = doc.pages;
  const activity = new Set(editor.session.remoteAgents.flatMap((a) => a.nodes.filter((n) => editor.now - n.at < 40000).map((n) => doc.pageIdOf(n.nodeId))));

  const drop = () => {
    if (dragId === null || dropAt === null) return;
    const ids = pages.map((p) => p.id).filter((id) => id !== dragId);
    const from = pages.findIndex((p) => p.id === dragId);
    const at = dropAt > from ? dropAt - 1 : dropAt;
    ids.splice(at, 0, dragId);
    doc.breakUndoGroup();
    doc.setPageOrder(ids);
    setDragId(null);
    setDropAt(null);
  };

  return (
    <div className="pages">
      <div className="section-title">
        <span>Páginas</span>
        <span>
          <button
            className="icon-btn"
            title="Añadir separador"
            onClick={() => {
              doc.breakUndoGroup();
              doc.addPage({ isDivider: true, afterPageId: editor.activePageId });
            }}
          >
            ―
          </button>
          <button
            className="icon-btn"
            title="Nueva página"
            onClick={() => {
              doc.breakUndoGroup();
              const id = doc.addPage({ afterPageId: editor.activePageId });
              editor.setPage(id);
            }}
          >
            +
          </button>
        </span>
      </div>
      <div className="pages-list" onDragLeave={() => setDropAt(null)}>
        {pages.map((p, i) => (
          <div
            key={p.id}
            draggable={renaming !== p.id}
            onDragStart={(e) => {
              setDragId(p.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop();
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropAt(null);
            }}
            className={`page-row${p.isDivider ? ' divider' : ''}${p.id === editor.activePageId ? ' active' : ''}${dropAt === i ? ' drop-before' : ''}${dropAt === i + 1 && i === pages.length - 1 ? ' drop-after' : ''}`}
            onClick={() => !p.isDivider && editor.setPage(p.id)}
            onDoubleClick={() => !p.isDivider && setRenaming(p.id)}
          >
            {p.isDivider ? (
              <div className="divider-line" />
            ) : (
              <>
                <span className="page-icon">{p.icon ? PAGE_ICON_GLYPH[p.icon] : '▤'}</span>
                {renaming === p.id ? (
                  <input
                    className="input input-inline"
                    autoFocus
                    defaultValue={p.label}
                    onBlur={(e) => {
                      if (e.target.value.trim()) doc.updatePage(p.id, { label: e.target.value.trim() });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="page-name">{p.label}</span>
                )}
                {activity.has(p.id) && <span className="agent-dot" title="Un agente está trabajando aquí" />}
              </>
            )}
            {(p.isDivider || doc.canvasPages.length > 1) && (
              <button
                className="icon-btn row-action"
                title="Eliminar"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!p.isDivider && !confirm(`¿Eliminar la página "${p.label}"?`)) return;
                  doc.breakUndoGroup();
                  doc.deletePage(p.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Árbol de capas

interface LayerDrag {
  id: string;
}

const LayersTree = observer(function LayersTree({ editor }: { editor: EditorState }) {
  const [drag, setDrag] = useState<LayerDrag | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: 'before' | 'after' | 'inside' } | null>(null);
  const { doc } = editor;
  const roots = doc.childIds(editor.rootId);

  const applyDrop = () => {
    if (!drag || !drop) return;
    const { id } = drag;
    if (doc.isWithin(drop.id, id)) return;
    doc.breakUndoGroup();
    doc.transact(() => {
      let parentId: string;
      let index: number | undefined;
      if (drop.pos === 'inside') {
        parentId = drop.id;
        index = undefined;
      } else {
        parentId = doc.parentId(drop.id)!;
        const sibs = doc.childIds(parentId).filter((s) => s !== id);
        const i = sibs.indexOf(drop.id);
        index = drop.pos === 'before' ? i : i + 1;
      }
      const oldParent = doc.parentId(id);
      const rect = editor.measure.peek(id);
      doc.moveNode(id, parentId, doc.sortKeyForIndex(parentId, index, id));
      if (oldParent !== parentId) {
        if (doc.isFreeform(parentId)) {
          const pr = parentId === editor.rootId ? { x: 0, y: 0 } : (editor.measure.peek(parentId) ?? { x: 0, y: 0 });
          if (rect) doc.setStyles(id, { left: `${Math.round(rect.x - pr.x)}px`, top: `${Math.round(rect.y - pr.y)}px`, right: null, bottom: null });
        } else if (oldParent && doc.isFreeform(oldParent)) {
          // De un padre libre a uno de flujo: pasa a formar parte del flujo.
          doc.setStyles(id, { position: null, left: null, top: null, right: null, bottom: null });
        }
      }
    });
    editor.select([id]);
    setDrag(null);
    setDrop(null);
  };

  const [tab, setTabState] = useState<'layers' | 'components'>(() => {
    try {
      return localStorage.getItem('moki.leftTab') === 'components' ? 'components' : 'layers';
    } catch {
      return 'layers';
    }
  });
  const setTab = (t: 'layers' | 'components') => {
    setTabState(t);
    try {
      localStorage.setItem('moki.leftTab', t);
    } catch {
      /* sin almacenamiento: no pasa nada */
    }
  };
  const tabs = (
    <div className="layers-tabs">
      <button className={`layers-tab${tab === 'layers' ? ' active' : ''}`} onClick={() => setTab('layers')}>
        Capas
      </button>
      <button className={`layers-tab${tab === 'components' ? ' active' : ''}`} onClick={() => setTab('components')}>
        Componentes{doc.mainComponents.length ? ` · ${doc.mainComponents.length}` : ''}
      </button>
    </div>
  );
  if (tab === 'components') {
    return (
      <div className="layers">
        {tabs}
        <ComponentsPanel editor={editor} />
      </div>
    );
  }

  return (
    <div className="layers" onDragEnd={() => (setDrag(null), setDrop(null))}>
      {tabs}
      {roots.length === 0 && <div className="muted pad">Página vacía</div>}
      {roots.map((id) => (
        <LayerRow key={id} id={id} depth={0} editor={editor} drag={drag} setDrag={setDrag} drop={drop} setDrop={setDrop} onDrop={applyDrop} />
      ))}
    </div>
  );
});

const LayerRow = observer(function LayerRowView({
  id,
  depth,
  editor,
  drag,
  setDrag,
  drop,
  setDrop,
  onDrop,
}: {
  id: string;
  depth: number;
  editor: EditorState;
  drag: LayerDrag | null;
  setDrag: (d: LayerDrag | null) => void;
  drop: { id: string; pos: 'before' | 'after' | 'inside' } | null;
  setDrop: (d: { id: string; pos: 'before' | 'after' | 'inside' } | null) => void;
  onDrop: () => void;
}) {
  const { doc } = editor;
  const node = doc.node(id);
  const [renaming, setRenaming] = useState(false);
  if (!node) return null;
  const kids = doc.childIds(id);
  const expanded = editor.expanded.has(id);
  const selected = editor.selection.includes(id);
  const container = node.component === 'Frame' || node.component === 'SVG';
  const hidden = node.isVisible === false;
  const label = node.component === 'Text' && !node.labelIsModified && node.textValue ? node.textValue.slice(0, 40) : node.label;
  // Hijos de una instancia: filas de solo lectura en estructura (sin arrastrar ni renombrar).
  const virtual = doc.isVirtual(id);
  const insideInstance = doc.isInsideInstance(id);
  const kind = node.isComponent ? ' component' : node.instanceOf ? ' instance' : virtual ? ' virtual' : '';

  return (
    <>
      <div
        className={`layer-row${kind}${selected ? ' selected' : ''}${editor.hoverId === id ? ' hover' : ''}${hidden ? ' hidden' : ''}${drop?.id === id ? ` drop-${drop.pos}` : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming && !virtual}
        onDragStart={(e) => {
          setDrag({ id });
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!drag || drag.id === id || doc.isWithin(id, drag.id) || virtual) return;
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const t = (e.clientY - r.top) / r.height;
          setDrop({ id, pos: container && !insideInstance && t > 0.25 && t < 0.75 ? 'inside' : t < 0.5 ? 'before' : 'after' });
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
        onMouseEnter={() => editor.setHover(id)}
        onMouseLeave={() => editor.setHover(null)}
        onClick={(e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) editor.toggleSelect(id);
          else editor.select([id]);
        }}
        onDoubleClick={() => !virtual && setRenaming(true)}
      >
        <span
          className={`caret${kids.length ? '' : ' empty'}`}
          onClick={(e) => {
            e.stopPropagation();
            runInAction(() => (expanded ? editor.expanded.delete(id) : editor.expanded.add(id)));
          }}
        >
          {kids.length ? (expanded ? '▾' : '▸') : ''}
        </span>
        {node.isComponent || node.instanceOf ? (
          <span className="layer-icon component-glyph">{node.isComponent ? '◇' : '◆'}</span>
        ) : (
          <span className={`layer-icon c-${node.component}`}>{doc.isArtboard(id) ? '▢' : (COMPONENT_GLYPH[node.component] ?? '•')}</span>
        )}
        {renaming ? (
          <input
            className="input input-inline"
            autoFocus
            defaultValue={node.label}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== node.label) doc.setLabel(id, v.slice(0, 200));
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="layer-name">{label}</span>
        )}
        <span className="layer-actions">
          {!virtual && <button
            className={`icon-btn${node.isLocked ? ' on' : ''}`}
            title={node.isLocked ? 'Desbloquear' : 'Bloquear'}
            onClick={(e) => {
              e.stopPropagation();
              doc.breakUndoGroup();
              doc.setLocked(id, !node.isLocked);
            }}
          >
            {node.isLocked ? '🔒' : '🔓'}
          </button>}
          <button
            className={`icon-btn${hidden ? ' on' : ''}`}
            title={hidden ? 'Mostrar' : 'Ocultar'}
            onClick={(e) => {
              e.stopPropagation();
              doc.breakUndoGroup();
              doc.setVisible(id, hidden);
            }}
          >
            {hidden ? '◌' : '◉'}
          </button>
        </span>
      </div>
      {expanded &&
        kids.map((c) => (
          <LayerRow key={c} id={c} depth={depth + 1} editor={editor} drag={drag} setDrag={setDrag} drop={drop} setDrop={setDrop} onDrop={onDrop} />
        ))}
    </>
  );
});
