import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { AgentActivityKind } from '../../core/protocol';
import type { EditorState } from '../editor/editor-state';
import { unionRects, type Rect } from './geometry';
import type { CanvasController, Handle } from './interactions';
import { computeDistances, formatDistance, type Distances } from './measure-distances';

// Overlays en espacio de pantalla: hover, selección, handles, etiquetas de artboard,
// selecciones de otras pestañas y actividad de agentes.

const ACCENT = '#FF5B3A';
/** Color de componentes (mains e instancias), como en las herramientas de diseño habituales. */
export const COMPONENT_COLOR = '#8B5CF6';
const REMOTE = '#3B82F6';
const AGENT = '#7C3AED';
const AGENT_ACTIVE_MS = 40_000;
/** Rojo de las cotas (Option): se lee bien sobre canvas claro y oscuro. */
const MEASURE = '#F24822';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

export const Overlay = observer(function Overlay({ editor, controller }: { editor: EditorState; controller: CanvasController }) {
  void editor.camera;
  void editor.measure.version;
  const toScreen = (r: Rect) => editor.worldRectToScreen(r);
  const doc = editor.doc;

  const hover = editor.hoverId && !editor.selection.includes(editor.hoverId) ? editor.measure.rect(editor.hoverId) : null;
  const selRects = editor.selection.map((id) => editor.measure.rect(id)).filter((r): r is Rect => !!r);
  const selUnion = unionRects(selRects);
  const single = editor.selection.length === 1 ? editor.selection[0]! : null;
  const showHandles = single && !editor.editingTextId && editor.tool === 'move' && !doc.isEffectivelyLocked(single) && !doc.isVirtual(single);
  const isComp = (id: string) => !!doc.node(id)?.isComponent || doc.isInsideInstance(id);

  // Selecciones de otras pestañas humanas en esta página.
  const remote: Rect[] = [];
  for (const u of editor.session.users.values()) {
    if (u.kind !== 'human' || u.clientId === editor.session.sync.clientId || u.pageId !== editor.activePageId) continue;
    for (const id of u.selectedNodes ?? []) {
      const r = editor.measure.rect(id);
      if (r) remote.push(r);
    }
  }

  // Agentes trabajando: nodos con actividad reciente de escritura/edición.
  const working = new Map<string, string>();
  const agentArtboards = new Map<string, string>();
  for (const a of editor.session.remoteAgents) {
    const label = a.harness ?? 'Agente';
    for (const n of a.nodes) {
      if (editor.now - n.at > AGENT_ACTIVE_MS) continue;
      if (n.kind === 'write' || n.kind === 'edit') working.set(n.nodeId, label);
      const ab = doc.node(n.nodeId) ? doc.artboardOf(n.nodeId) : null;
      if (ab) agentArtboards.set(ab, label);
    }
    if (a.lastArtboardId && a.nodes.some((n) => editor.now - n.at < AGENT_ACTIVE_MS)) agentArtboards.set(a.lastArtboardId, label);
  }

  const artboards = doc.childIds(editor.rootId).filter((id) => doc.node(id)?.component === 'Frame');

  const m = measurement(editor, selUnion);

  return (
    <div className="canvas-overlay">
      <svg className="overlay-svg" width="100%" height="100%">
        {[...working.keys()].map((id) => {
          const r = editor.measure.rect(id);
          if (!r) return null;
          const s = toScreen(r);
          return <rect key={`w-${id}`} x={s.x} y={s.y} width={s.width} height={s.height} fill="none" stroke={AGENT} strokeOpacity={0.45} strokeDasharray="4 3" />;
        })}
        {remote.map((r, i) => {
          const s = toScreen(r);
          return <rect key={`r-${i}`} x={s.x} y={s.y} width={s.width} height={s.height} fill="none" stroke={REMOTE} strokeWidth={1.5} />;
        })}
        {hover && !m && <RectOutline r={toScreen(hover)} color={editor.hoverId && isComp(editor.hoverId) ? COMPONENT_COLOR : ACCENT} width={1} />}
        {m && <MeasureLines editor={editor} m={m} />}
        {editor.selection.map((id, i) => {
          const r = editor.measure.rect(id);
          return r ? <RectOutline key={`s-${i}`} r={toScreen(r)} color={isComp(id) ? COMPONENT_COLOR : ACCENT} width={1.5} /> : null;
        })}
        {selRects.length > 1 && selUnion && <RectOutline r={toScreen(selUnion)} color={ACCENT} width={1} dashed />}
        {editor.marquee && (
          <rect
            {...svgRect(toScreen(editor.marquee))}
            fill="rgba(255,91,58,0.08)"
            stroke={ACCENT}
            strokeWidth={1}
          />
        )}
        {editor.drawRect && <rect {...svgRect(toScreen(editor.drawRect))} fill="rgba(255,91,58,0.06)" stroke={ACCENT} strokeWidth={1} />}
        {editor.dropIndicator && (
          <>
            {editor.dropIndicator.parentRect && <RectOutline r={toScreen(editor.dropIndicator.parentRect)} color={ACCENT} width={1} dashed />}
            <line
              x1={editor.worldToScreen(editor.dropIndicator.x1, editor.dropIndicator.y1).x}
              y1={editor.worldToScreen(editor.dropIndicator.x1, editor.dropIndicator.y1).y}
              x2={editor.worldToScreen(editor.dropIndicator.x2, editor.dropIndicator.y2).x}
              y2={editor.worldToScreen(editor.dropIndicator.x2, editor.dropIndicator.y2).y}
              stroke={ACCENT}
              strokeWidth={2.5}
            />
          </>
        )}
      </svg>

      {artboards.map((id) => {
        const r = editor.measure.rect(id);
        const n = doc.node(id);
        if (!r || !n) return null;
        const s = toScreen(r);
        const selected = editor.selection.includes(id);
        const agentLabel = agentArtboards.get(id);
        return (
          <div key={`l-${id}`}>
            <div
              className={`artboard-label${selected ? ' selected' : ''}${n.isComponent || n.instanceOf ? ' component' : ''}`}
              style={{ left: s.x, top: s.y - 20, maxWidth: Math.max(40, s.width - (agentLabel ? 110 : 0)) }}
              onPointerDown={(e) => {
                if (editor.tool !== 'move' || e.button !== 0) return;
                controller.startLabelDrag(id, e);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                const name = prompt('Nombre del artboard', n.label);
                if (name) doc.setLabel(id, name);
              }}
            >
              {n.isComponent ? '◇ ' : n.instanceOf ? '◆ ' : ''}
              {n.label}
            </div>
            {agentLabel && (
              <div className="agent-label" style={{ left: s.x + s.width, top: s.y - 21 }}>
                <span className="agent-dot" /> {agentLabel}
              </div>
            )}
          </div>
        );
      })}

      {m && <MeasureLabels editor={editor} d={m.d} />}

      {selUnion && selRects.length > 0 && !editor.editingTextId && !m && (
        <div className="size-badge" style={{ left: toScreen(selUnion).x + toScreen(selUnion).width / 2, top: toScreen(selUnion).y + toScreen(selUnion).height + 6 }}>
          {Math.round(selUnion.width)} × {Math.round(selUnion.height)}
        </div>
      )}

      {showHandles &&
        (() => {
          const r = editor.measure.rect(single!);
          if (!r) return null;
          const s = toScreen(r);
          return HANDLES.map((h) => {
            const x = h.includes('w') ? s.x : h.includes('e') ? s.x + s.width : s.x + s.width / 2;
            const y = h.includes('n') ? s.y : h.includes('s') ? s.y + s.height : s.y + s.height / 2;
            if ((h === 'n' || h === 's') && s.width < 24) return null;
            if ((h === 'e' || h === 'w') && s.height < 24) return null;
            return (
              <div
                key={h}
                className="resize-handle"
                style={{ left: x, top: y, cursor: HANDLE_CURSOR[h] }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  controller.startResize(single!, h, e);
                }}
              />
            );
          });
        })()}

      <AgentAnimations editor={editor} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Medición con Option (como Figma/Paper).

interface Measurement {
  target: Rect;
  d: Distances;
}

/**
 * Con Option y una selección: distancias hasta el nodo bajo el puntero. Si el puntero está sobre la
 * propia selección o sobre el canvas vacío, hasta el frame padre de la selección.
 */
function measurement(editor: EditorState, sel: Rect | null): Measurement | null {
  if (!editor.altDown || !sel || !editor.selection.length || editor.tool !== 'move' || editor.editingTextId) return null;
  if (!editor.pointerWorld) return null;
  const doc = editor.doc;
  let targetId = editor.hoverId;
  if (!targetId || editor.selection.includes(targetId)) {
    const parent = doc.parentId(editor.selection[0]!);
    targetId = parent && parent !== editor.rootId ? parent : null;
  }
  if (!targetId) return null;
  const target = editor.measure.rect(targetId);
  if (!target) return null;
  const d = computeDistances(sel, target);
  return d.lines.length ? { target, d } : null;
}

function MeasureLines({ editor, m }: { editor: EditorState; m: Measurement }) {
  const p = (x: number, y: number) => editor.worldToScreen(x, y);
  return (
    <g>
      <RectOutline r={editor.worldRectToScreen(m.target)} color={MEASURE} width={1} />
      {m.d.guides.map((g, i) => {
        const a = p(g.x1, g.y1);
        const b = p(g.x2, g.y2);
        return <line key={`g${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={MEASURE} strokeWidth={1} strokeDasharray="3 3" />;
      })}
      {m.d.lines.map((l, i) => {
        const a = p(l.x1, l.y1);
        const b = p(l.x2, l.y2);
        const vertical = Math.abs(a.x - b.x) < 0.5;
        // Remates perpendiculares en los extremos.
        const cap = (q: { x: number; y: number }) =>
          vertical ? <line x1={q.x - 3} y1={q.y} x2={q.x + 3} y2={q.y} stroke={MEASURE} strokeWidth={1} /> : <line x1={q.x} y1={q.y - 3} x2={q.x} y2={q.y + 3} stroke={MEASURE} strokeWidth={1} />;
        return (
          <g key={`l${i}`}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={MEASURE} strokeWidth={1} />
            {cap(a)}
            {cap(b)}
          </g>
        );
      })}
    </g>
  );
}

function MeasureLabels({ editor, d }: { editor: EditorState; d: Distances }) {
  return (
    <>
      {d.lines.map((l, i) => {
        const c = editor.worldToScreen((l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2);
        return (
          <div
            key={`ml${i}`}
            className="measure-label"
            style={{
              position: 'absolute',
              left: c.x,
              top: c.y,
              transform: 'translate(-50%, -50%)',
              background: MEASURE,
              color: '#fff',
              font: '600 11px/1 var(--ui-font, system-ui, sans-serif)',
              padding: '3px 5px',
              borderRadius: 4,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
              zIndex: 3,
            }}
          >
            {formatDistance(l.value)}
          </div>
        );
      })}
    </>
  );
}

function svgRect(r: Rect) {
  return { x: r.x, y: r.y, width: Math.max(0, r.width), height: Math.max(0, r.height) };
}

function RectOutline({ r, color, width, dashed }: { r: Rect; color: string; width: number; dashed?: boolean }) {
  return <rect {...svgRect(r)} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dashed ? '4 3' : undefined} />;
}

// ---------------------------------------------------------------------------
// Animaciones de actividad de agentes (read ↑, write ↓, edit pulso, delete fundido).

interface Anim {
  key: string;
  nodeId: string;
  kind: AgentActivityKind;
  rect: Rect | null;
}

const DURATION: Record<AgentActivityKind, number> = { read: 1500, write: 1500, edit: 1000, delete: 800 };

const AgentAnimations = observer(function AgentAnimations({ editor }: { editor: EditorState }) {
  const [anims, setAnims] = useState<Anim[]>([]);

  useEffect(() => {
    const seen = new Set<string>();
    let first = true;
    return reaction(
      () => editor.session.remoteAgents,
      (agents) => {
        const fresh: Anim[] = [];
        const now = Date.now();
        for (const a of agents) {
          for (const n of a.nodes) {
            const key = `${a.sessionId}:${n.nodeId}:${n.kind}:${n.at}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (first || now - n.at > 5000) continue;
            if (editor.doc.pageIdOf(n.nodeId) !== editor.activePageId && n.kind !== 'delete') continue;
            // Para el borrado guardamos el rect ahora (el nodo desaparece enseguida).
            fresh.push({ key, nodeId: n.nodeId, kind: n.kind, rect: n.kind === 'delete' ? editor.measure.peek(n.nodeId) : null });
          }
        }
        first = false;
        if (!fresh.length) return;
        setAnims((prev) => [...prev, ...fresh]);
        for (const f of fresh) {
          setTimeout(() => setAnims((prev) => prev.filter((x) => x.key !== f.key)), DURATION[f.kind] + 50);
        }
      },
      { fireImmediately: true },
    );
  }, [editor]);

  void editor.camera;
  void editor.measure.version;
  return (
    <>
      {anims.map((a) => {
        const r = a.rect ?? editor.measure.rect(a.nodeId);
        if (!r) return null;
        const s = editor.worldRectToScreen(r);
        return (
          <div
            key={a.key}
            className={`agent-anim agent-anim-${a.kind}`}
            style={{ left: s.x, top: s.y, width: s.width, height: s.height, animationDuration: `${DURATION[a.kind]}ms` }}
          />
        );
      })}
    </>
  );
});
