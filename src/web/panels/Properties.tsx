import { hexifyCss } from './ColorPicker';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { expandShorthand, pxValue, toCssValue } from '../../core/css';
import { externalToInternal, internalToExternal, internalToResolved } from '../../core/tokens';
import { FREEFORM_DISPLAY, type StyleValue, type TreeNode } from '../../core/types';
import type { EditorState } from '../editor/editor-state';
import { isFreeChild, measuredOffset } from '../editor/actions';
import { ColorField, NumField, Row, Section, Seg, TextInput } from './controls';
import { TokensPanel } from './TokensPanel';
import { CodePanel } from './CodePanel';
import {
  createComponentFromSelection,
  detachSelection,
  goToMainComponent,
  instanceOfSelection,
  resetOverridesSelection,
} from '../editor/component-actions';
import { ExportSection } from './ExportSection';
import { CommentsPanel } from '../comments/CommentsPanel';

const GENERIC_FAMILIES = ['system-ui', 'sans-serif', 'serif', 'monospace', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New'];

let catalogPromise: Promise<string[]> | null = null;
function loadFamilies(): Promise<string[]> {
  catalogPromise ??= fetch('/fonts/catalog.json')
    .then((r) => r.json())
    .then((c: { families: { family: string }[] }) => c.families.map((f) => f.family))
    .catch(() => []);
  return catalogPromise;
}

export const RightSidebar = observer(function RightSidebar({ editor }: { editor: EditorState }) {
  const hasSel = editor.selection.length > 0;
  const tab = editor.showComments ? 'comments' : hasSel ? editor.rightTab : 'design';
  return (
    <aside className="right-sidebar">
      <div className="tabs">
        <button className={tab === 'design' ? 'on' : ''} onClick={() => setTab(editor, 'design')}>
          Diseño
        </button>
        <button className={tab === 'code' ? 'on' : ''} disabled={!hasSel} onClick={() => setTab(editor, 'code')}>
          Código
        </button>
        <button className={tab === 'comments' ? 'on' : ''} onClick={() => setTab(editor, 'comments')}>
          Comentarios
        </button>
      </div>
      {tab === 'comments' ? (
        <CommentsPanel editor={editor} />
      ) : tab === 'code' && hasSel ? (
        <CodePanel editor={editor} />
      ) : hasSel ? (
        <DesignPanel editor={editor} />
      ) : (
        <PagePanel editor={editor} />
      )}
    </aside>
  );
});

function setTab(editor: EditorState, t: 'design' | 'code' | 'comments') {
  runInAction(() => {
    editor.showComments = t === 'comments';
    if (t !== 'comments') editor.rightTab = t;
  });
}

// ---------------------------------------------------------------------------

const PagePanel = observer(function PagePanel({ editor }: { editor: EditorState }) {
  const page = editor.activePage;
  return (
    <div className="panel-scroll">
      {page && (
        <Section title="Página">
          <Row>
            <span className="prop-label">Fondo</span>
            <ColorField
              value={page.canvasColor ?? '#ECECEC'}
              onCommit={(v) => {
                editor.doc.breakUndoGroup();
                editor.doc.updatePage(page.id, { canvasColor: v });
              }}
            />
          </Row>
        </Section>
      )}
      <TokensPanel editor={editor} />
    </div>
  );
});

// ---------------------------------------------------------------------------

/** Acceso a los estilos de la selección (lee del primero, escribe en todos). */
function useStyleApi(editor: EditorState) {
  const { doc } = editor;
  // Vista efectiva: en instancias, estilos del main + overrides (al editar se escriben overrides).
  const nodes = editor.selection.map((id) => doc.view(id)).filter((n): n is TreeNode => !!n);
  const first = nodes[0];
  const get = (k: string): string => {
    const v = first?.styles[k];
    return v === undefined ? '' : internalToExternal(doc.data, toCssValue(k, v));
  };
  const resolved = (k: string): string => {
    const v = first?.styles[k];
    return v === undefined ? '' : internalToResolved(doc.data, toCssValue(k, v));
  };
  const set = (patch: Record<string, StyleValue | null>) => {
    const conv: Record<string, StyleValue | null> = {};
    for (const [k, v] of Object.entries(patch)) conv[k] = typeof v === 'string' ? externalToInternal(doc.data, v) : v;
    doc.transact(() => {
      for (const n of nodes) doc.setStyles(n.id, conv);
    });
  };
  const ext = (k: string, v: StyleValue) => internalToExternal(doc.data, toCssValue(k, v));
  return { nodes, first, get, resolved, set, ext };
}

const DesignPanel = observer(function DesignPanel({ editor }: { editor: EditorState }) {
  const api = useStyleApi(editor);
  const { first, nodes } = api;
  if (!first) return null;
  const isText = nodes.every((n) => n.component === 'Text');
  const isFrame = nodes.every((n) => n.component === 'Frame');
  return (
    <div className="panel-scroll">
      <div className="sel-header">
        <span className="sel-kind">{nodes.length > 1 ? `${nodes.length} capas` : editor.doc.isArtboard(first.id) ? 'Artboard' : first.component}</span>
        {nodes.length === 1 && !editor.doc.isVirtual(first.id) && (
          <TextInput value={first.label} onCommit={(v) => v.trim() && editor.doc.setLabel(first.id, v.trim().slice(0, 200))} />
        )}
        {nodes.length === 1 && editor.doc.isVirtual(first.id) && <span className="muted">{first.label}</span>}
      </div>
      {nodes.length === 1 && <ComponentSection editor={editor} id={first.id} />}
      <PositionSection editor={editor} api={api} />
      {isFrame && <LayoutSection editor={editor} api={api} />}
      <AppearanceSection api={api} />
      {isText && <TypographySection api={api} />}
      {!isText && <FillSection editor={editor} api={api} />}
      <BorderSection api={api} />
      <ShadowSection api={api} />
      <CssEditor editor={editor} api={api} />
      {nodes.length === 1 && <ExportSection editor={editor} nodeId={first.id} />}
    </div>
  );
});

type Api = ReturnType<typeof useStyleApi>;

// ---------------------------------------------------------------------------

type SizeMode = 'fixed' | 'hug' | 'fill' | 'auto' | 'custom';

function mainAxisIsRow(parent: TreeNode | undefined) {
  return String(parent?.styles.flexDirection ?? 'row').startsWith('row');
}
function parentIsFlex(parent: TreeNode | undefined) {
  const d = parent?.styles.display;
  return d === 'flex' || d === 'inline-flex';
}

function sizeMode(n: TreeNode, axis: 'width' | 'height', parent: TreeNode | undefined): SizeMode {
  const v = n.styles[axis];
  if (v === 'fit-content' || v === 'max-content') return 'hug';
  if (v === '100%') return 'fill';
  if (parentIsFlex(parent)) {
    const main = (axis === 'width') === mainAxisIsRow(parent);
    if (main && Number(n.styles.flexGrow ?? 0) > 0) return 'fill';
    if (!main && n.styles.alignSelf === 'stretch') return 'fill';
  }
  if (v === undefined) return 'auto';
  if (pxValue(v) !== null) return 'fixed';
  return 'custom';
}

const PositionSection = observer(function PositionSection({ editor, api }: { editor: EditorState; api: Api }) {
  const { doc } = editor;
  const n = api.first!;
  const parent = doc.parent(n.id);
  const free = isFreeChild(doc, n.id);
  const rect = editor.measure.rect(n.id);
  const off = !free ? measuredOffset(editor, n.id) : null;

  const setMode = (axis: 'width' | 'height', mode: SizeMode) => {
    const patch: Record<string, StyleValue | null> = {};
    const main = parentIsFlex(parent) && (axis === 'width') === mainAxisIsRow(parent);
    const cross = parentIsFlex(parent) && !main;
    if (mode === 'fixed') {
      patch[axis] = `${Math.round(rect?.[axis] ?? 100)}px`;
      if (main) patch.flexGrow = null;
      if (cross) patch.alignSelf = null;
    } else if (mode === 'hug') {
      patch[axis] = 'fit-content';
      if (main) patch.flexGrow = null;
      if (cross) patch.alignSelf = null;
    } else if (mode === 'fill') {
      if (main) Object.assign(patch, { flexGrow: 1, flexBasis: '0px', [axis]: null });
      else if (cross) Object.assign(patch, { alignSelf: 'stretch', [axis]: null });
      else patch[axis] = '100%';
    } else if (mode === 'auto') {
      patch[axis] = null;
      if (main) patch.flexGrow = null;
      if (cross) patch.alignSelf = null;
    }
    doc.breakUndoGroup();
    api.set(patch);
  };

  const sizeRow = (axis: 'width' | 'height', label: string) => {
    const mode = sizeMode(n, axis, parent);
    const shown = mode === 'fixed' || mode === 'custom' ? api.get(axis) : rect ? String(Math.round(rect[axis])) : '';
    return (
      <div className="size-row">
        <NumField label={label} value={shown} onCommit={(v) => api.set({ [axis]: v || null })} min={0} />
        <select className="input input-sm" value={mode} onChange={(e) => setMode(axis, e.target.value as SizeMode)}>
          <option value="fixed">Fijo</option>
          <option value="hug">Ajustar</option>
          <option value="fill">Llenar</option>
          <option value="auto">Auto</option>
          {mode === 'custom' && <option value="custom">Otro</option>}
        </select>
      </div>
    );
  };

  return (
    <Section title="Posición y tamaño">
      <Row>
        {free ? (
          <>
            <NumField label="X" value={api.get('left') || (off ? String(Math.round(off.x)) : '')} onCommit={(v) => api.set({ left: v || '0px', right: null })} />
            <NumField label="Y" value={api.get('top') || (off ? String(Math.round(off.y)) : '')} onCommit={(v) => api.set({ top: v || '0px', bottom: null })} />
          </>
        ) : (
          <>
            <div className="readonly-field">X {off ? Math.round(off.x) : '–'}</div>
            <div className="readonly-field">Y {off ? Math.round(off.y) : '–'}</div>
          </>
        )}
      </Row>
      {sizeRow('width', 'W')}
      {sizeRow('height', 'H')}
      <Row>
        <NumField label="↻" title="Rotación" unit="deg" value={api.get('rotate').replace('deg', '')} onCommit={(v) => api.set({ rotate: v && v !== '0deg' ? v : null })} />
        {free && !doc.isArtboard(n.id) && (
          <NumField label="Z" title="z-index" unit="" value={api.get('zIndex')} onCommit={(v) => api.set({ zIndex: v || null })} />
        )}
      </Row>
    </Section>
  );
});

// ---------------------------------------------------------------------------

const ALIGN = ['flex-start', 'center', 'flex-end'] as const;

const LayoutSection = observer(function LayoutSection({ editor, api }: { editor: EditorState; api: Api }) {
  const { doc } = editor;
  const n = api.first!;
  const display = n.styles.display === FREEFORM_DISPLAY ? 'free' : n.styles.display === 'flex' || n.styles.display === 'inline-flex' ? 'flex' : n.styles.display === 'grid' ? 'grid' : 'block';

  const setDisplay = (d: 'free' | 'flex' | 'block') => {
    doc.breakUndoGroup();
    doc.transact(() => {
      for (const node of api.nodes) {
        const kids = doc.childIds(node.id);
        if (d === 'free') {
          const offs = kids.map((k) => [k, measuredOffset(editor, k)] as const);
          doc.setStyles(node.id, { display: FREEFORM_DISPLAY, flexDirection: null, gap: null, alignItems: null, justifyContent: null, flexWrap: null });
          for (const [k, o] of offs) if (o) doc.setStyles(k, { left: `${Math.round(o.x)}px`, top: `${Math.round(o.y)}px` });
        } else {
          const wasFree = node.styles.display === FREEFORM_DISPLAY;
          doc.setStyles(node.id, d === 'flex' ? { display: 'flex', flexDirection: n.styles.flexDirection ?? 'column' } : { display: null });
          if (wasFree) for (const k of kids) if (doc.node(k)?.styles.position !== 'absolute') doc.setStyles(k, { left: null, top: null, right: null, bottom: null });
        }
      }
    });
  };

  const row = String(n.styles.flexDirection ?? 'row').startsWith('row');
  const justify = String(n.styles.justifyContent ?? 'flex-start');
  const align = String(n.styles.alignItems ?? 'stretch');
  const norm = (v: string) => (v === 'start' ? 'flex-start' : v === 'end' ? 'flex-end' : v);

  return (
    <Section title="Layout">
      <Row>
        <Seg
          value={display === 'grid' ? null : display}
          onChange={setDisplay}
          options={[
            { value: 'free', label: 'Libre', title: 'Hijos posicionados libremente' },
            { value: 'flex', label: 'Flex', title: 'Auto layout (flexbox)' },
            { value: 'block', label: 'Bloque' },
          ]}
        />
      </Row>
      {display === 'flex' && (
        <>
          <Row>
            <Seg
              value={row ? 'row' : 'column'}
              onChange={(v) => api.set({ flexDirection: v })}
              options={[
                { value: 'row', label: '→ Fila' },
                { value: 'column', label: '↓ Columna' },
              ]}
            />
            <label className="check">
              <input type="checkbox" checked={n.styles.flexWrap === 'wrap'} onChange={(e) => api.set({ flexWrap: e.target.checked ? 'wrap' : null })} /> Wrap
            </label>
          </Row>
          <div className="layout-grid">
            <div className="align-grid">
              {[0, 1, 2].map((yi) =>
                [0, 1, 2].map((xi) => {
                  const mainI = row ? xi : yi;
                  const crossI = row ? yi : xi;
                  const on = norm(justify) === ALIGN[mainI] && norm(align) === ALIGN[crossI];
                  return (
                    <button
                      key={`${xi}-${yi}`}
                      className={on ? 'on' : ''}
                      onClick={() => api.set({ justifyContent: ALIGN[mainI]!, alignItems: ALIGN[crossI]! })}
                    />
                  );
                }),
              )}
            </div>
            <div className="layout-fields">
              <NumField label="Gap" value={api.get('gap') || api.get('rowGap')} onCommit={(v) => api.set({ gap: v || null })} min={0} />
              <Seg
                value={justify === 'space-between' ? 'between' : 'packed'}
                onChange={(v) => api.set({ justifyContent: v === 'between' ? 'space-between' : 'flex-start' })}
                options={[
                  { value: 'packed', label: 'Juntos' },
                  { value: 'between', label: 'Repartir' },
                ]}
              />
            </div>
          </div>
        </>
      )}
      <PaddingFields api={api} />
    </Section>
  );
});

function PaddingFields({ api }: { api: Api }) {
  const n = api.first!;
  const p = n.styles.padding !== undefined ? expandShorthand('padding', n.styles.padding) : null;
  const side = (k: 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft') =>
    p ? api.ext(k, p[k] ?? '') : api.get(k);
  return (
    <>
      <div className="prop-sub">Padding</div>
      <Row>
        <NumField label="↑" value={side('paddingTop')} onCommit={(v) => api.set({ paddingTop: v || null })} min={0} />
        <NumField label="→" value={side('paddingRight')} onCommit={(v) => api.set({ paddingRight: v || null })} min={0} />
        <NumField label="↓" value={side('paddingBottom')} onCommit={(v) => api.set({ paddingBottom: v || null })} min={0} />
        <NumField label="←" value={side('paddingLeft')} onCommit={(v) => api.set({ paddingLeft: v || null })} min={0} />
      </Row>
    </>
  );
}

// ---------------------------------------------------------------------------

const AppearanceSection = observer(function AppearanceSection({ api }: { api: Api }) {
  const n = api.first!;
  const opacity = n.styles.opacity !== undefined ? String(Math.round(Number(n.styles.opacity) * 100)) : '100';
  return (
    <Section title="Apariencia">
      <Row>
        <NumField
          label="◐"
          title="Opacidad"
          unit="%"
          value={opacity}
          min={0}
          onCommit={(v) => {
            const num = parseFloat(v);
            api.set({ opacity: Number.isFinite(num) && num < 100 ? Math.max(0, num) / 100 : null });
          }}
        />
        <NumField label="◜" title="Radio de esquinas" value={api.get('borderRadius')} onCommit={(v) => api.set({ borderRadius: v || null })} min={0} />
      </Row>
      {n.component === 'Frame' && (
        <Row>
          <label className="check">
            <input
              type="checkbox"
              checked={n.styles.overflow === 'clip' || n.styles.overflow === 'hidden'}
              onChange={(e) => api.set({ overflow: e.target.checked ? 'clip' : null })}
            />
            Recortar contenido
          </label>
        </Row>
      )}
    </Section>
  );
});

function TokenPicker({ editor, type, onPick }: { editor: EditorState; type: string; onPick: (v: string) => void }) {
  const toks = editor.doc.liveTokens.filter((t) => t.type === type);
  if (!toks.length) return null;
  return (
    <select
      className="input input-sm token-picker"
      value=""
      title="Usar token"
      onChange={(e) => {
        if (e.target.value) onPick(`var(--${e.target.value})`);
      }}
    >
      <option value="">◆</option>
      {toks.map((t) => (
        <option key={t.id} value={t.name}>
          --{t.name}
        </option>
      ))}
    </select>
  );
}

const FillSection = observer(function FillSection({ editor, api }: { editor: EditorState; api: Api }) {
  const n = api.first!;
  const bg = api.get('backgroundColor');
  const img = api.get('backgroundImage');
  return (
    <Section
      title="Relleno"
      actions={
        !bg && (
          <button className="icon-btn" title="Añadir relleno" onClick={() => api.set({ backgroundColor: '#FFFFFF' })}>
            +
          </button>
        )
      }
    >
      {bg && (
        <Row>
          <ColorField value={bg} swatchValue={api.resolved('backgroundColor')} onCommit={(v) => api.set({ backgroundColor: v || null })} />
          <TokenPicker editor={editor} type="color" onPick={(v) => api.set({ backgroundColor: v })} />
          <button className="icon-btn" title="Quitar" onClick={() => api.set({ backgroundColor: null })}>
            −
          </button>
        </Row>
      )}
      {img && (
        <Row>
          <TextInput value={img} onCommit={(v) => api.set({ backgroundImage: v || null })} mono className="grow" />
        </Row>
      )}
      {n.component === 'Frame' && !bg && !img && <div className="muted">Sin relleno</div>}
    </Section>
  );
});

const BorderSection = observer(function BorderSection({ api }: { api: Api }) {
  const n = api.first!;
  const border = n.styles.border !== undefined ? expandShorthand('border', n.styles.border) ?? {} : {};
  const w = api.get('borderWidth') || String(border.borderWidth ?? '');
  const s = api.get('borderStyle') || String(border.borderStyle ?? '');
  const c = api.get('borderColor') || String(border.borderColor ?? '');
  const has = !!(w || s || c);
  return (
    <Section
      title="Borde"
      actions={
        has ? (
          <button className="icon-btn" title="Quitar" onClick={() => api.set({ border: null, borderWidth: null, borderStyle: null, borderColor: null })}>
            −
          </button>
        ) : (
          <button className="icon-btn" title="Añadir borde" onClick={() => api.set({ border: '1px solid #000000' })}>
            +
          </button>
        )
      }
    >
      {has && (
        <>
          <Row>
            <NumField label="W" value={w} onCommit={(v) => api.set({ borderWidth: v || null })} min={0} />
            <select className="input input-sm" value={s || 'solid'} onChange={(e) => api.set({ borderStyle: e.target.value })}>
              {['solid', 'dashed', 'dotted', 'double', 'none'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Row>
          <Row>
            <ColorField value={c || '#000000'} onCommit={(v) => api.set({ borderColor: v || null })} />
          </Row>
        </>
      )}
    </Section>
  );
});

const ShadowSection = observer(function ShadowSection({ api }: { api: Api }) {
  const v = api.get('boxShadow');
  return (
    <Section
      title="Sombra"
      actions={
        v ? (
          <button className="icon-btn" title="Quitar" onClick={() => api.set({ boxShadow: null })}>
            −
          </button>
        ) : (
          <button className="icon-btn" title="Añadir sombra" onClick={() => api.set({ boxShadow: '0px 4px 16px rgba(0, 0, 0, 0.12)' })}>
            +
          </button>
        )
      }
    >
      {v && (
        <Row>
          <TextInput value={v} onCommit={(x) => api.set({ boxShadow: x || null })} mono className="grow" />
        </Row>
      )}
    </Section>
  );
});

// ---------------------------------------------------------------------------

const TypographySection = observer(function TypographySection({ api }: { api: Api }) {
  const [families, setFamilies] = useState<string[]>([]);
  useEffect(() => {
    loadFamilies().then(setFamilies);
  }, []);
  const fam = api.get('fontFamily').replace(/["']/g, '');
  const all = [...new Set([...families, ...GENERIC_FAMILIES, ...(fam ? [fam] : [])])];
  const n = api.first!;
  return (
    <Section title="Texto">
      <Row>
        <select className="input grow" value={fam} onChange={(e) => api.set({ fontFamily: e.target.value })}>
          {!fam && <option value="">(heredada)</option>}
          {all.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
      </Row>
      <Row>
        <select className="input" value={String(n.styles.fontWeight ?? 400)} onChange={(e) => api.set({ fontWeight: Number(e.target.value) })}>
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <NumField label="Aa" title="Tamaño" value={api.get('fontSize')} onCommit={(v) => api.set({ fontSize: v || null })} min={1} />
      </Row>
      <Row>
        <NumField label="↕" title="Interlineado" value={api.get('lineHeight')} onCommit={(v) => api.set({ lineHeight: v || null })} />
        <NumField label="↔" title="Tracking" unit="em" step={0.01} value={api.get('letterSpacing')} onCommit={(v) => api.set({ letterSpacing: v || null })} />
      </Row>
      <Row>
        <Seg
          value={(n.styles.textAlign as string) ?? 'left'}
          onChange={(v) => api.set({ textAlign: v === 'left' ? null : v })}
          options={[
            { value: 'left', label: '⇤' },
            { value: 'center', label: '↔' },
            { value: 'right', label: '⇥' },
            { value: 'justify', label: '≡' },
          ]}
        />
        <Seg
          value={n.styles.fontStyle === 'italic' ? 'i' : null}
          onChange={() => api.set({ fontStyle: n.styles.fontStyle === 'italic' ? null : 'italic' })}
          options={[{ value: 'i', label: <i>I</i>, title: 'Cursiva' }]}
        />
        <Seg
          value={n.styles.textDecoration === 'underline' ? 'u' : n.styles.textDecoration === 'line-through' ? 's' : null}
          onChange={(v) => {
            const cur = n.styles.textDecoration;
            const want = v === 'u' ? 'underline' : 'line-through';
            api.set({ textDecoration: cur === want ? null : want });
          }}
          options={[
            { value: 'u', label: <u>U</u>, title: 'Subrayado' },
            { value: 's', label: <s>S</s>, title: 'Tachado' },
          ]}
        />
      </Row>
      <Row>
        <select className="input" value={String(n.styles.textTransform ?? 'none')} onChange={(e) => api.set({ textTransform: e.target.value === 'none' ? null : e.target.value })}>
          <option value="none">Aa (normal)</option>
          <option value="uppercase">MAYÚSCULAS</option>
          <option value="lowercase">minúsculas</option>
          <option value="capitalize">Capitalizar</option>
        </select>
      </Row>
      <Row>
        <ColorField value={api.get('color') || '#000000'} swatchValue={api.resolved('color') || '#000000'} onCommit={(v) => api.set({ color: v || null })} />
      </Row>
    </Section>
  );
});

// ---------------------------------------------------------------------------
// Editor CSS bruto: todas las propiedades del nodo como filas clave/valor.

const CssEditor = observer(function CssEditor({ editor, api }: { editor: EditorState; api: Api }) {
  const n = api.first!;
  const [newKey, setNewKey] = useState('');
  const entries = Object.entries(n.styles);
  const overridden = overriddenStyleKeys(editor, n.id);
  return (
    <Section title="CSS">
      <div className="css-rows">
        {entries.map(([k, v]) => (
          <div className="css-row" key={k}>
            {overridden.has(k) && <span className="override-dot" title="Cambiado en esta instancia" />}
            <TextInput
              value={k}
              mono
              className="css-key"
              onCommit={(nk) => {
                const key = nk.trim();
                if (!key || key === k) return;
                api.set({ [k]: null, [key]: v });
              }}
            />
            <TextInput
              value={hexifyCss(internalToExternal(editor.doc.data, toCssValue(k, v)))}
              mono
              className="css-val"
              onCommit={(nv) => api.set({ [k]: nv.trim() === '' ? null : nv })}
            />
            <button className="icon-btn" title="Eliminar" onClick={() => api.set({ [k]: null })}>
              ×
            </button>
          </div>
        ))}
        <div className="css-row">
          <input className="input mono css-key" placeholder="propiedad" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <input
            className="input mono css-val"
            placeholder="valor ⏎"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const val = (e.target as HTMLInputElement).value.trim();
              if (!newKey.trim() || !val) return;
              const key = newKey.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
              api.set({ [key]: val });
              setNewKey('');
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </div>
      </div>
    </Section>
  );
});

// ---------------------------------------------------------------------------
// Componentes

/** Propiedades que esta instancia (o capa de instancia) cambia respecto al main. */
function overriddenStyleKeys(editor: EditorState, id: string): Set<string> {
  const { doc } = editor;
  if (doc.isVirtual(id)) {
    const k = doc.components.overrideKey(id);
    const inst = k ? doc.node(k.instanceId) : undefined;
    return new Set(Object.keys((k && inst?.overrides?.[k.key]?.styles) ?? {}));
  }
  const n = doc.node(id);
  if (!n?.instanceOf) return new Set();
  const pos = ['position', 'left', 'top', 'right', 'bottom'];
  return new Set(Object.keys(n.styles).filter((key) => !pos.includes(key)));
}

const ComponentSection = observer(function ComponentSection({ editor, id }: { editor: EditorState; id: string }) {
  const { doc } = editor;
  const n = doc.view(id);
  if (!n) return null;
  if (n.isComponent) {
    const count = doc.instancesByMain.get(id)?.length ?? 0;
    return (
      <Section title="Componente principal">
        <div className="component-section">
          <div className="comp-title">◇ {n.label}</div>
          <div className="muted">
            {count === 0 ? 'Sin instancias todavía' : `${count} ${count === 1 ? 'instancia' : 'instancias'}`} · los cambios aquí se aplican a todas
          </div>
          {count > 0 && (
            <div className="row-buttons">
              <button className="btn" onClick={() => editor.select(doc.instancesByMain.get(id) ?? [])}>
                Ver instancias ({count})
              </button>
            </div>
          )}
        </div>
      </Section>
    );
  }
  const instId = instanceOfSelection(editor, id);
  if (instId) {
    const inst = doc.node(instId)!;
    const mainId = inst.instanceOf!;
    const main = doc.data.nodes[mainId];
    const isRootOfInstance = instId === id;
    return (
      <Section title={isRootOfInstance ? 'Instancia' : 'Dentro de una instancia'}>
        <div className="component-section">
          <div className="comp-title">◆ {main ? main.label : 'Componente no encontrado'}</div>
          {!isRootOfInstance && <div className="muted">Los cambios se guardan solo en esta instancia.</div>}
          <div className="row-buttons">
            {main && !main['~'] && (
              <button className="btn" onClick={() => goToMainComponent(editor, mainId)}>
                Ir al componente
              </button>
            )}
            <button className="btn" onClick={() => resetOverridesSelection(editor)}>
              Restablecer cambios
            </button>
            <button className="btn" title="⌘⌥B" onClick={() => detachSelection(editor)}>
              Desvincular
            </button>
          </div>
        </div>
      </Section>
    );
  }
  if (n.component === 'Frame') {
    return (
      <Section title="Componente">
        <div className="component-section">
          <div className="row-buttons">
            <button className="btn" title="⌘⌥K" onClick={() => createComponentFromSelection(editor)}>
              ◇ Crear componente
            </button>
          </div>
        </div>
      </Section>
    );
  }
  return null;
});
