import { action, computed, makeObservable, observable, runInAction, toJS } from 'mobx';
import { computedFn, deepObserve } from 'mobx-utils';
import { applyEdit, joinPath, splitPath } from '../../core/edits';
import { compareKeys, keyBetween, keysBetween } from '../../core/fractional';
import { nextNodeId, nextPageId, nextTokenId, rootNodeIdFor } from '../../core/ids';
import { mergeStyles } from '../../core/css';
import { canHaveChildren, makeRel, parseRel, isRootId } from '../../core/tree';
import { ComponentResolver, isVirtualId, mergeOverride, VSEP, type NodeOverride } from '../../core/components';
import { planInstanceConversion } from '../../core/instance-convert';
import {
  FREEFORM_DISPLAY,
  type ComponentType,
  type Edit,
  type MokiFile,
  type Page,
  type StyleValue,
  type Styles,
  type Token,
  type TokenType,
  type TreeNode,
} from '../../core/types';
import { DEFAULT_CANVAS_COLOR } from '../../core/new-file';

// Documento observable + generación de ediciones.
//
// Cualquier mutación de `data` (dentro de una action) la detecta `deepObserve`, que produce a
// la vez la edición (para sync) y su inversa (para undo). Las ediciones remotas se aplican con
// el observador en pausa: ni rebotan al servidor ni entran en el historial local.

export type EditListener = (edits: Edit[]) => void;

interface UndoEvent {
  undo: Edit[]; // inversas, en orden de aplicación (ya invertido)
  redo: Edit[];
  selection?: string[];
  pageId?: string;
}

export const INSTANCE_CHILDREN_ERROR =
  'Cannot add children inside a component instance; edit the main component or detach the instance';

const GROUP_MS = 250;
const HISTORY_LIMIT = 250;

export class DocStore {
  data: MokiFile;
  clientIndex: number;

  private applyingRemote = 0;
  private ignoreUndo = 0;
  private pending: Edit[] = [];
  private flushScheduled = false;
  private listeners = new Set<EditListener>();
  private disposeObserver: () => void;

  // Undo / redo
  private history: UndoEvent[] = [];
  private future: UndoEvent[] = [];
  private current: UndoEvent | null = null;
  private lastEditAt = 0;
  private gestureDepth = 0;
  /** Selección/página a guardar con el evento de undo (lo rellena el editor). */
  snapshotUiState: (() => { selection: string[]; pageId: string }) | null = null;
  restoreUiState: ((s: { selection?: string[]; pageId?: string }) => void) | null = null;
  historyVersion = 0;

  constructor(file: MokiFile, clientIndex: number) {
    this.data = observable(file, undefined, { deep: true, proxy: true });
    this.clientIndex = clientIndex;
    makeObservable<DocStore, 'bumpHistory'>(this, {
      data: observable.ref,
      childrenIndex: computed({ keepAlive: true }),
      pages: computed,
      canvasPages: computed,
      liveTokens: computed,
      mainComponents: computed,
      instancesByMain: computed,
      historyVersion: observable,
      canUndo: computed,
      canRedo: computed,
      bumpHistory: action,
    });
    this.disposeObserver = this.observe();
  }

  dispose() {
    this.disposeObserver();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ edits

  private observe() {
    return deepObserve(this.data, (change, path) => {
      if (this.applyingRemote > 0) return;
      const base = path ? path.split('/') : [];
      const edits: Edit[] = [];
      const inverses: Edit[] = [];
      const c = change as unknown as {
        type: string;
        observableKind: string;
        name?: string | number;
        index?: number;
        newValue?: unknown;
        oldValue?: unknown;
        added?: unknown[];
        removed?: unknown[];
        removedCount?: number;
        addedCount?: number;
      };
      if (c.observableKind === 'array') {
        const p = joinPath(base);
        if (c.type === 'splice') {
          const added = (c.added ?? []).map((v) => toJS(v));
          const removed = (c.removed ?? []).map((v) => toJS(v));
          edits.push({ path: p, type: 'splice', index: c.index!, removedCount: removed.length, added });
          inverses.push({ path: p, type: 'splice', index: c.index!, removedCount: added.length, added: removed });
        } else if (c.type === 'update') {
          const ip = joinPath([...base, c.index!]);
          edits.push({ path: ip, type: 'update', value: toJS(c.newValue) });
          inverses.push({ path: ip, type: 'update', value: toJS(c.oldValue) });
        }
      } else {
        const p = joinPath([...base, String(c.name)]);
        if (c.type === 'add') {
          edits.push({ path: p, type: 'add', value: toJS(c.newValue) });
          inverses.push({ path: p, type: 'remove' });
        } else if (c.type === 'update') {
          edits.push({ path: p, type: 'update', value: toJS(c.newValue) });
          inverses.push({ path: p, type: 'update', value: toJS(c.oldValue) });
        } else if (c.type === 'remove' || c.type === 'delete') {
          edits.push({ path: p, type: 'remove' });
          inverses.push({ path: p, type: 'add', value: toJS(c.oldValue) });
        }
      }
      if (edits.length === 0) return;
      this.pending.push(...edits);
      this.scheduleFlush();
      if (this.ignoreUndo === 0) this.recordUndo(edits, inverses);
    });
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** Envía ya las ediciones pendientes (también se llama sola al final de cada microtask). */
  flush() {
    this.flushScheduled = false;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const l of this.listeners) l(batch);
  }

  /** Suscribe al flujo de ediciones locales (sync, persistencia…). */
  onLocalEdits(l: EditListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Aplica ediciones remotas sin rebote ni undo. */
  applyRemoteEdits(edits: Edit[]) {
    this.applyingRemote++;
    try {
      runInAction(() => {
        for (const e of edits) applyEdit(this.data as unknown as Record<string, unknown>, e);
      });
    } finally {
      this.applyingRemote--;
    }
  }

  /** Sustituye el documento entero (p. ej. snapshot al reconectar). Sin undo ni sync. */
  replaceData(file: MokiFile) {
    this.applyingRemote++;
    try {
      runInAction(() => {
        const d = this.data as unknown as Record<string, unknown>;
        for (const k of Object.keys(d)) if (!(k in file)) delete d[k];
        for (const [k, v] of Object.entries(file)) d[k] = v;
      });
    } finally {
      this.applyingRemote--;
    }
    this.history = [];
    this.future = [];
    this.current = null;
    this.bumpHistory();
  }

  // ------------------------------------------------------------------ undo

  private recordUndo(edits: Edit[], inverses: Edit[]) {
    const now = Date.now();
    const grouping = this.gestureDepth > 0 || (this.current && now - this.lastEditAt < GROUP_MS);
    if (!this.current || !grouping) {
      this.current = { undo: [], redo: [], ...this.uiSnapshot() };
      this.history.push(this.current);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    }
    this.lastEditAt = now;
    this.current.redo.push(...edits);
    // Las inversas se aplican en orden inverso: las anteponemos.
    this.current.undo.unshift(...inverses.reverse());
    this.future = [];
    this.bumpHistory();
  }

  private uiSnapshot() {
    const s = this.snapshotUiState?.();
    return s ? { selection: s.selection, pageId: s.pageId } : {};
  }

  private bumpHistory() {
    this.historyVersion++;
  }

  get canUndo() {
    void this.historyVersion;
    return this.history.length > 0;
  }
  get canRedo() {
    void this.historyVersion;
    return this.future.length > 0;
  }

  /** Agrupa todo lo que ocurra hasta `endGesture` en un único evento de undo. */
  startGesture() {
    if (this.gestureDepth === 0) this.current = null;
    this.gestureDepth++;
  }
  endGesture() {
    this.gestureDepth = Math.max(0, this.gestureDepth - 1);
    if (this.gestureDepth === 0) this.current = null;
  }

  /** Ejecuta `fn` sin registrar undo (contadores, cambios del agente…). */
  withoutUndo<T>(fn: () => T): T {
    this.ignoreUndo++;
    try {
      return runInAction(fn);
    } finally {
      this.ignoreUndo--;
    }
  }

  /** Acción con undo (agrupada si llega dentro de 250 ms de la anterior). */
  transact<T>(fn: () => T): T {
    return runInAction(fn);
  }

  /** Cierra el grupo actual para que la siguiente edición abra un evento nuevo. */
  breakUndoGroup() {
    if (this.gestureDepth === 0) this.current = null;
  }

  undo() {
    const ev = this.history.pop();
    if (!ev) return;
    this.current = null;
    this.ignoreUndo++;
    try {
      runInAction(() => {
        for (const e of ev.undo) applyEdit(this.data as unknown as Record<string, unknown>, e);
      });
    } finally {
      this.ignoreUndo--;
    }
    this.future.push(ev);
    this.restoreUiState?.({ selection: ev.selection, pageId: ev.pageId });
    this.bumpHistory();
  }

  redo() {
    const ev = this.future.pop();
    if (!ev) return;
    this.current = null;
    this.ignoreUndo++;
    try {
      runInAction(() => {
        for (const e of ev.redo) applyEdit(this.data as unknown as Record<string, unknown>, e);
      });
    } finally {
      this.ignoreUndo--;
    }
    this.history.push(ev);
    this.bumpHistory();
  }

  // ------------------------------------------------------------------ lectura

  /** padre → hijos vivos ordenados. */
  get childrenIndex(): Map<string, string[]> {
    const tmp = new Map<string, { id: string; key: string }[]>();
    const nodes = this.data.nodes;
    for (const [childId, rel] of Object.entries(this.data.nodeRelationships)) {
      const r = parseRel(rel);
      if (!r) continue;
      const n = nodes[childId];
      if (!n || n['~']) continue;
      let list = tmp.get(r.parentId);
      if (!list) tmp.set(r.parentId, (list = []));
      list.push({ id: childId, key: r.sortKey });
    }
    const out = new Map<string, string[]>();
    for (const [p, list] of tmp) {
      list.sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.id, b.id));
      out.set(p, list.map((x) => x.id));
    }
    return out;
  }

  get pages(): Page[] {
    return this.data.pages.filter((p) => !p['~']);
  }
  get canvasPages(): Page[] {
    return this.pages.filter((p) => !p.isDivider);
  }
  get liveTokens(): Token[] {
    return Object.values(this.data.theme.tokens).filter((t) => !t['~']);
  }

  // ------------------------------------------------------------------ componentes (lectura)

  /** Resolución de instancias: hijos virtuales `<instancia>::<idEnMain>` con overrides. */
  readonly components = new ComponentResolver({
    raw: (id) => this.data.nodes[id],
    children: (id) => this.childrenIndex.get(id) ?? [],
    parent: (id) => parseRel(this.data.nodeRelationships[id])?.parentId ?? null,
  });
  private virtualView = computedFn((id: string) => this.components.virtualView(id));
  private instanceRootView = computedFn((id: string) => {
    const n = this.data.nodes[id];
    return n ? this.components.instanceView(n) : undefined;
  });

  isVirtual(id: string | null | undefined): boolean {
    return isVirtualId(id);
  }
  /** ¿Es la raíz real de una instancia? */
  isInstance(id: string | null | undefined): boolean {
    return !!id && !isVirtualId(id) && !!this.node(id)?.instanceOf;
  }
  /** ¿Está dentro de una instancia (nodo virtual) o es una? (estructura no editable) */
  isInsideInstance(id: string | null | undefined): boolean {
    return isVirtualId(id) || this.isInstance(id);
  }
  /** Mains vivos del fichero. */
  get mainComponents(): TreeNode[] {
    return Object.values(this.data.nodes).filter((n) => n.isComponent && !n['~'] && this.rootOf(n.id));
  }
  /** main → instancias vivas (reales). */
  get instancesByMain(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const n of Object.values(this.data.nodes)) {
      if (!n.instanceOf || n['~'] || !this.rootOf(n.id)) continue;
      const l = out.get(n.instanceOf) ?? [];
      l.push(n.id);
      out.set(n.instanceOf, l);
    }
    return out;
  }

  /**
   * Nodo por id. Para ids reales devuelve el nodo guardado (mutable); para ids virtuales, una
   * vista de solo lectura con los overrides aplicados.
   */
  node(id: string | null | undefined): TreeNode | undefined {
    if (!id) return undefined;
    if (isVirtualId(id)) return this.virtualView(id);
    const n = this.data.nodes[id];
    return n && !n['~'] ? n : undefined;
  }
  /** Vista efectiva para pintar/leer estilos: como `node`, pero la raíz de una instancia trae los estilos del main. */
  view(id: string | null | undefined): TreeNode | undefined {
    if (!id) return undefined;
    if (isVirtualId(id)) return this.virtualView(id);
    const n = this.data.nodes[id];
    if (!n || n['~']) return undefined;
    return n.instanceOf ? this.instanceRootView(id) : n;
  }
  childIds(id: string): string[] {
    if (isVirtualId(id) || this.data.nodes[id]?.instanceOf) return this.components.childIds(id);
    return this.childrenIndex.get(id) ?? [];
  }
  /** Hijos reales guardados (sin los virtuales de una instancia). */
  realChildIds(id: string): string[] {
    return this.childrenIndex.get(id) ?? [];
  }
  parentId(id: string): string | null {
    if (isVirtualId(id)) return this.components.parentId(id);
    return parseRel(this.data.nodeRelationships[id])?.parentId ?? null;
  }
  /** Vista efectiva del padre (para contexto de layout). */
  parent(id: string): TreeNode | undefined {
    return this.view(this.parentId(id));
  }
  sortKey(id: string): string | null {
    if (isVirtualId(id)) return null;
    return parseRel(this.data.nodeRelationships[id])?.sortKey ?? null;
  }
  ancestors(id: string): string[] {
    const out: string[] = [];
    let p = this.parentId(id);
    while (p && !out.includes(p)) {
      out.push(p);
      p = this.parentId(p);
    }
    return out;
  }
  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (pid: string) => {
      for (const c of this.childIds(pid)) {
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  }
  rootOf(id: string): string | null {
    if (isRootId(id)) return id;
    const anc = this.ancestors(id);
    const last = anc[anc.length - 1];
    return last && isRootId(last) ? last : null;
  }
  pageIdOf(id: string): string | null {
    const r = this.rootOf(id);
    return r ? r.slice('root_node_'.length) : null;
  }
  isArtboard(id: string): boolean {
    const p = this.parentId(id);
    const n = this.node(id);
    return !!p && isRootId(p) && !!n && canHaveChildren(n);
  }
  artboardOf(id: string): string | null {
    if (this.isArtboard(id)) return id;
    for (const a of this.ancestors(id)) if (this.isArtboard(a)) return a;
    return null;
  }
  isWithin(id: string, ancestor: string): boolean {
    return id === ancestor || this.ancestors(id).includes(ancestor);
  }
  isEffectivelyVisible(id: string): boolean {
    for (const x of [id, ...this.ancestors(id)]) if (this.node(x)?.isVisible === false) return false;
    return true;
  }
  isEffectivelyLocked(id: string): boolean {
    for (const x of [id, ...this.ancestors(id)]) if (this.data.nodes[x]?.isLocked) return true;
    return false;
  }
  isFreeform(id: string): boolean {
    const n = this.view(id);
    return !!n && (isRootId(id) || n.styles.display === FREEFORM_DISPLAY);
  }
  page(pageId: string): Page | undefined {
    return this.data.pages.find((p) => p.id === pageId && !p['~']);
  }

  /** Clave de orden para insertar en `parentId` en la posición `index` (o al final). */
  sortKeyForIndex(parentId: string, index?: number, excludeId?: string): string {
    const kids = this.childIds(parentId).filter((c) => c !== excludeId);
    const i = index === undefined ? kids.length : Math.max(0, Math.min(index, kids.length));
    const prev = i > 0 ? this.sortKey(kids[i - 1]!) : null;
    const next = i < kids.length ? this.sortKey(kids[i]!) : null;
    return keyBetween(prev, next);
  }
  /** N claves consecutivas tras `afterId` (o al final). */
  sortKeysAfter(parentId: string, afterId: string | null, n: number): string[] {
    const kids = this.childIds(parentId);
    const i = afterId ? kids.indexOf(afterId) : kids.length - 1;
    const prev = i >= 0 ? this.sortKey(kids[i]!) : null;
    const next = i + 1 < kids.length ? this.sortKey(kids[i + 1]!) : null;
    return keysBetween(prev, next, n);
  }

  // ------------------------------------------------------------------ ids

  newNodeId(): string {
    return this.withoutUndo(() => nextNodeId(this.data, this.clientIndex));
  }

  /** Etiqueta automática "Frame 3", "Text 12"… */
  autoLabel(base: string): string {
    return this.withoutUndo(() => {
      const n = (this.data.labelCounter[base] ?? 0) + 1;
      this.data.labelCounter[base] = n;
      return `${base} ${n}`;
    });
  }

  // ------------------------------------------------------------------ mutaciones de nodos

  /** Inserta un nodo ya construido (sin id → se genera). */
  addNode(partial: Omit<TreeNode, 'id'> & { id?: string }, parentId: string, sortKey?: string): string {
    if (this.isInsideInstance(parentId)) throw new Error(INSTANCE_CHILDREN_ERROR);
    const id = partial.id ?? this.newNodeId();
    const key = sortKey ?? this.sortKeyForIndex(parentId);
    runInAction(() => {
      this.data.nodes[id] = { ...partial, id } as TreeNode;
      this.data.nodeRelationships[id] = makeRel(parentId, key);
    });
    return id;
  }

  createNode(
    component: ComponentType,
    parentId: string,
    opts: { styles?: Styles; label?: string; textValue?: string; sortKey?: string; tag?: string; attrs?: Record<string, string> } = {},
  ): string {
    const label = opts.label ?? this.autoLabel(component === 'SVGVisualElement' ? 'Shape' : component);
    return this.addNode(
      {
        label,
        component,
        styles: opts.styles ?? {},
        ...(opts.textValue !== undefined ? { textValue: opts.textValue } : {}),
        ...(opts.tag ? { tag: opts.tag } : {}),
        ...(opts.attrs ? { attrs: opts.attrs } : {}),
      },
      parentId,
      opts.sortKey,
    );
  }

  /** Fusiona estilos (respetando shorthands). `null`/'' borra. */
  setStyles(id: string, styles: Record<string, StyleValue | null | undefined>) {
    if (isVirtualId(id)) return this.setOverride(id, { styles });
    const n = this.node(id);
    if (!n) return;
    if (n.instanceOf) styles = this.unsetInheritedRootStyles(n, styles);
    const next = mergeStyles(toJS(n.styles), styles);
    runInAction(() => {
      const cur = n.styles as Record<string, StyleValue>;
      for (const k of Object.keys(cur)) if (!(k in next)) delete cur[k];
      for (const [k, v] of Object.entries(next)) if (cur[k] !== v) cur[k] = v;
    });
  }

  /** Sustituye todos los estilos. */
  replaceStyles(id: string, styles: Styles) {
    if (isVirtualId(id)) {
      const cur = this.node(id)?.styles ?? {};
      const patch: Record<string, StyleValue | null> = {};
      for (const k of Object.keys(cur)) if (!(k in styles)) patch[k] = null;
      for (const [k, v] of Object.entries(styles)) if (cur[k] !== v) patch[k] = v;
      return this.setOverride(id, { styles: patch });
    }
    const n = this.node(id);
    if (!n) return;
    runInAction(() => {
      const cur = n.styles as Record<string, StyleValue>;
      for (const k of Object.keys(cur)) if (!(k in styles)) delete cur[k];
      for (const [k, v] of Object.entries(styles)) if (cur[k] !== v) cur[k] = v;
    });
  }

  setText(id: string, text: string) {
    if (isVirtualId(id)) return this.setOverride(id, { textValue: text });
    const n = this.node(id);
    if (n) runInAction(() => (n.textValue = text));
  }

  setLabel(id: string, label: string, modified = true) {
    if (isVirtualId(id)) return; // las capas de una instancia se nombran en el main
    const n = this.node(id);
    if (!n) return;
    runInAction(() => {
      n.label = label;
      if (modified) n.labelIsModified = true;
    });
  }

  setVisible(id: string, visible: boolean) {
    if (isVirtualId(id)) return this.setOverride(id, { isVisible: visible });
    const n = this.node(id);
    if (!n) return;
    runInAction(() => {
      if (visible) delete n.isVisible;
      else n.isVisible = false;
    });
  }

  setLocked(id: string, locked: boolean) {
    if (isVirtualId(id)) return;
    const n = this.node(id);
    if (!n) return;
    runInAction(() => {
      if (locked) n.isLocked = true;
      else delete n.isLocked;
    });
  }

  /** Mueve (o reordena) un nodo: una sola edición en nodeRelationships. */
  moveNode(id: string, parentId: string, sortKey: string) {
    if (isVirtualId(id)) return; // la estructura de una instancia viene del main
    if (this.isInsideInstance(parentId)) throw new Error(INSTANCE_CHILDREN_ERROR);
    runInAction(() => {
      this.data.nodeRelationships[id] = makeRel(parentId, sortKey);
    });
  }

  /** Soft delete del nodo y sus descendientes. */
  deleteNodes(ids: string[]) {
    runInAction(() => {
      for (const id of ids) {
        if (isRootId(id)) continue;
        // Borrar un hijo de una instancia = ocultarlo con un override.
        if (isVirtualId(id)) {
          this.setOverride(id, { isVisible: false });
          continue;
        }
        // Los mains borrados conservan su subárbol vivo: sus instancias siguen pintándose.
        const keepSubtree = (d: string) => !!this.data.nodes[d]?.isComponent;
        const stack = [id];
        while (stack.length) {
          const d = stack.pop()!;
          const n = this.data.nodes[d];
          if (!n || n['~']) continue;
          n['~'] = true;
          // La relación del nodo raíz del borrado se elimina; las de descendientes se conservan
          // (para que deshacer resucite el subárbol entero con su estructura).
          if (!keepSubtree(d)) stack.push(...this.realChildIds(d));
        }
        delete this.data.nodeRelationships[id];
      }
    });
  }

  /**
   * Clona en profundidad `id` bajo `parentId` (o su padre) con ids nuevos.
   * Devuelve el id nuevo y el mapa original → copia.
   */
  cloneNode(id: string, parentId?: string, sortKey?: string): { newId: string; map: Record<string, string> } | null {
    if (isVirtualId(id)) return null;
    const src = this.node(id);
    if (!src) return null;
    const targetParent = parentId ?? this.parentId(id);
    if (!targetParent) return null;
    const map: Record<string, string> = {};
    const copy = (srcId: string, newParent: string, key: string): string => {
      const s = this.data.nodes[srcId]!;
      const snap = toJS(s) as TreeNode;
      delete snap['~'];
      const newId = this.newNodeId();
      map[srcId] = newId;
      this.addNode({ ...snap, id: newId }, newParent, key);
      const kids = this.realChildIds(srcId);
      const keys = keysBetween(null, null, kids.length);
      kids.forEach((k, i) => copy(k, newId, keys[i]!));
      return newId;
    };
    let newId = '';
    runInAction(() => {
      const key = sortKey ?? (targetParent === this.parentId(id) ? this.sortKeysAfter(targetParent, id, 1)[0]! : this.sortKeyForIndex(targetParent));
      newId = copy(id, targetParent, key);
    });
    return { newId, map };
  }

  // ------------------------------------------------------------------ componentes (mutación)

  /** En la raíz de una instancia, borrar algo que viene del main se guarda como 'unset'. */
  private unsetInheritedRootStyles(n: TreeNode, styles: Record<string, StyleValue | null | undefined>) {
    const main = n.instanceOf ? this.data.nodes[n.instanceOf] : undefined;
    if (!main) return styles;
    const out = { ...styles };
    for (const [k, v] of Object.entries(styles)) {
      if ((v === null || v === undefined || v === '') && main.styles[k] !== undefined) out[k] = 'unset';
    }
    return out;
  }

  /** Convierte un Frame en componente principal. */
  createComponentFrom(id: string, name?: string): string {
    const n = this.node(id);
    if (!n || isVirtualId(id)) throw new Error('Only real nodes can become components');
    if (n.component !== 'Frame' || n.instanceOf) throw new Error('Only frames (not instances) can become components');
    if (isRootId(id)) throw new Error('A page root cannot be a component');
    if (this.ancestors(id).some((a) => this.isInsideInstance(a))) throw new Error(INSTANCE_CHILDREN_ERROR);
    const label = name ?? (n.labelIsModified ? n.label : this.autoLabel('Component'));
    runInAction(() => {
      n.isComponent = true;
      n.label = label;
      n.labelIsModified = true;
    });
    return id;
  }

  /** Crea una instancia de `mainId` bajo `parentId`. */
  createInstance(mainId: string, parentId: string, sortKey?: string, styles: Styles = {}): string {
    const main = this.node(mainId);
    if (!main?.isComponent) throw new Error(`Not a component: ${mainId}`);
    if (this.isInsideInstance(parentId)) throw new Error(INSTANCE_CHILDREN_ERROR);
    if (!this.components.canPlaceInstance(mainId, parentId)) {
      throw new Error('An instance cannot be placed inside its own component (it would create a cycle)');
    }
    return this.addNode({ label: main.label, component: 'Frame', instanceOf: mainId, styles }, parentId, sortKey);
  }

  /** Aplica un override a un nodo virtual (hijo de una instancia). */
  setOverride(
    virtualId: string,
    patch: { styles?: Record<string, StyleValue | null | undefined>; textValue?: string; isVisible?: boolean },
  ) {
    const k = this.components.overrideKey(virtualId);
    if (!k) return;
    const inst = this.node(k.instanceId);
    if (!inst?.instanceOf) return;
    runInAction(() => {
      // Ojo: `a ??= {}` devuelve el objeto plano, no el proxy observable que guarda MobX.
      if (!inst.overrides) inst.overrides = {};
      const overrides = inst.overrides;
      overrides[k.key] = mergeOverride(toJS(overrides[k.key]) as NodeOverride | undefined, patch);
    });
  }

  /**
   * Restablece overrides. Sobre una instancia real: todos (y la raíz vuelve a heredar del main,
   * conservando posición y tamaño). Sobre un nodo virtual: los de ese nodo y su subárbol.
   */
  resetOverrides(id: string) {
    if (isVirtualId(id)) {
      const k = this.components.overrideKey(id);
      const inst = k ? this.node(k.instanceId) : undefined;
      if (!k || !inst?.overrides) return;
      runInAction(() => {
        for (const key of Object.keys(inst.overrides!)) {
          if (key === k.key || key.startsWith(k.key + VSEP)) delete inst.overrides![key];
        }
      });
      return;
    }
    const n = this.node(id);
    if (!n?.instanceOf) return;
    const keep = ['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf'];
    runInAction(() => {
      delete n.overrides;
      for (const k of Object.keys(n.styles)) if (!keep.includes(k)) delete (n.styles as Record<string, StyleValue>)[k];
    });
  }

  /** Convierte una instancia en nodos reales (las instancias anidadas siguen siendo instancias). */
  detachInstance(id: string): Record<string, string> {
    const inst = this.node(id);
    if (!inst?.instanceOf || isVirtualId(id)) throw new Error(`Not an instance: ${id}`);
    const clean = (st: Styles) => {
      const out: Styles = {};
      for (const [k, v] of Object.entries(st)) if (v !== 'unset') out[k] = v;
      return out;
    };
    // Primero se construye todo (la resolución virtual deja de existir al desvincular).
    interface Spec { from: string; node: Omit<TreeNode, 'id'>; children: Spec[] }
    const build = (vid: string): Spec => {
      const v = this.node(vid)!;
      const node: Omit<TreeNode, 'id'> & { id?: string } = { ...toJS(v), styles: clean(toJS(v.styles)) };
      delete node.id;
      if (!v.instanceOf) delete node.overrides;
      return { from: vid, node, children: v.instanceOf ? [] : this.childIds(vid).map(build) };
    };
    const rootStyles = clean(toJS(this.view(id)!.styles));
    const children = this.childIds(id).map(build);
    const map: Record<string, string> = {};
    runInAction(() => {
      delete inst.instanceOf;
      delete inst.overrides;
      this.replaceStyles(id, rootStyles);
      const add = (spec: Spec, parent: string, key: string) => {
        const newId = this.addNode(spec.node, parent, key);
        map[spec.from.split(VSEP).slice(1).join(VSEP)] = newId;
        const keys = keysBetween(null, null, spec.children.length);
        spec.children.forEach((c, i) => add(c, newId, keys[i]!));
      };
      const keys = keysBetween(null, null, children.length);
      children.forEach((c, i) => add(c, id, keys[i]!));
    });
    return map;
  }

  /**
   * Convierte en el sitio copias a mano de un componente en instancias suyas: conservan id,
   * posición en el padre y aspecto (las diferencias pasan a overrides). Primero se planifican
   * todas (solo lecturas) y luego se aplican en una única acción: con ficheros grandes, mutar
   * entre lecturas obligaría a recalcular los índices del árbol en cada copia.
   */
  convertToInstances(ids: string[], mainId: string): Map<string, { overrideCount: number } | { error: string }> {
    const out = new Map<string, { overrideCount: number } | { error: string }>();
    const main = this.node(mainId);
    if (!main?.isComponent) throw new Error(`Not a component: ${mainId}`);
    const wanted = new Set(ids);
    const plans: { id: string; rootStyles: Styles; overrides: Record<string, NodeOverride>; count: number; children: string[]; descendants: string[] }[] = [];
    for (const id of ids) {
      try {
        const n = this.node(id);
        if (!n || isVirtualId(id)) throw new Error(`Node not found (or inside an instance): ${id}`);
        if (id === mainId) throw new Error('A main component cannot become its own instance');
        if (n.instanceOf) throw new Error(`Already an instance: ${id}`);
        if (isRootId(id)) throw new Error('A page root cannot become an instance');
        if (this.isInsideInstance(id)) throw new Error(INSTANCE_CHILDREN_ERROR);
        if (this.ancestors(id).some((a) => wanted.has(a))) throw new Error('Inside another copy converted in the same call');
        const parent = this.parentId(id);
        if (!parent || !this.components.canPlaceInstance(mainId, parent)) {
          throw new Error('An instance cannot be placed inside its own component (it would create a cycle)');
        }
        const children = this.realChildIds(id);
        const descendants: string[] = [];
        const stack = [...children];
        while (stack.length) {
          const d = stack.pop()!;
          if (d === mainId || this.data.nodes[d]?.isComponent) throw new Error('The node contains a main component');
          descendants.push(d);
          stack.push(...this.realChildIds(d));
        }
        const plan = planInstanceConversion(this, id, mainId);
        if (!plan.ok) throw new Error(plan.reason);
        plans.push({ id, rootStyles: plan.rootStyles, overrides: plan.overrides, count: plan.overrideCount, children, descendants });
      } catch (e) {
        out.set(id, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    runInAction(() => {
      for (const p of plans) {
        const n = this.data.nodes[p.id]!;
        // Mismo resultado que deleteNodes(children), sin volver a leer el índice de hijos tras
        // cada cambio (sin observadores, MobX lo recalcularía entero en cada lectura).
        for (const d of p.descendants) this.data.nodes[d]!['~'] = true;
        for (const c of p.children) delete this.data.nodeRelationships[c];
        n.instanceOf = mainId;
        if (p.count) n.overrides = p.overrides;
        else delete n.overrides;
        this.replaceStyles(p.id, p.rootStyles);
        out.set(p.id, { overrideCount: p.count });
      }
    });
    return out;
  }

  /** Una sola copia (ver `convertToInstances`). Lanza si no encaja. */
  convertToInstance(id: string, mainId: string): { overrideCount: number } {
    const r = this.convertToInstances([id], mainId).get(id)!;
    if ('error' in r) throw new Error(r.error);
    return r;
  }

  // ------------------------------------------------------------------ páginas

  addPage(opts: { label?: string; afterPageId?: string; canvasColor?: string; isDivider?: boolean } = {}): string {
    const id = this.withoutUndo(() => nextPageId(this.data, this.clientIndex));
    const now = Date.now();
    runInAction(() => {
      const page: Page = opts.isDivider
        ? { id, label: '', createdAt: now, updatedAt: now, isDivider: true }
        : {
            id,
            label: opts.label ?? this.defaultPageName(),
            createdAt: now,
            updatedAt: now,
            canvasColor: opts.canvasColor ?? DEFAULT_CANVAS_COLOR,
          };
      const idx = opts.afterPageId ? this.data.pages.findIndex((p) => p.id === opts.afterPageId) : -1;
      if (idx >= 0) this.data.pages.splice(idx + 1, 0, page);
      else this.data.pages.push(page);
      if (!opts.isDivider) {
        const rootId = rootNodeIdFor(id);
        this.data.nodes[rootId] = { id: rootId, label: page.label, component: 'Frame', styles: { display: FREEFORM_DISPLAY } };
      }
    });
    return id;
  }

  defaultPageName(): string {
    const names = new Set(this.pages.map((p) => p.label));
    let n = this.canvasPages.length + 1;
    while (names.has(`Page ${n}`)) n++;
    return `Page ${n}`;
  }

  updatePage(pageId: string, patch: Partial<Pick<Page, 'label' | 'icon' | 'canvasColor'>> & { icon?: Page['icon'] | null }) {
    const p = this.data.pages.find((x) => x.id === pageId);
    if (!p) return;
    runInAction(() => {
      if (patch.label !== undefined) p.label = patch.label;
      if (patch.icon !== undefined) {
        if (patch.icon === null) delete p.icon;
        else p.icon = patch.icon;
      }
      if (patch.canvasColor !== undefined) p.canvasColor = patch.canvasColor;
      p.updatedAt = Date.now();
    });
  }

  deletePage(pageId: string) {
    const idx = this.data.pages.findIndex((x) => x.id === pageId);
    if (idx < 0) return;
    runInAction(() => {
      this.data.pages[idx]!['~'] = true;
    });
  }

  /** Reordena la lista completa de páginas (ids existentes) en un único splice. */
  setPageOrder(order: string[]) {
    runInAction(() => {
      const byId = new Map(this.data.pages.map((p) => [p.id, toJS(p)]));
      const deleted = this.data.pages.filter((p) => p['~']).map((p) => toJS(p));
      const next = [...order.map((id) => byId.get(id)!).filter(Boolean), ...deleted];
      this.data.pages.splice(0, this.data.pages.length, ...next);
    });
  }

  // ------------------------------------------------------------------ tokens

  createToken(t: { type: TokenType; name: string; value: string | number; description?: string }): string {
    const id = this.withoutUndo(() => nextTokenId(this.data, this.clientIndex));
    const sameType = this.liveTokens.filter((x) => x.type === t.type).sort((a, b) => compareKeys(a.sortKey, b.sortKey));
    const last = sameType[sameType.length - 1];
    runInAction(() => {
      this.data.theme.tokens[id] = {
        id,
        type: t.type,
        name: t.name,
        value: t.value,
        sortKey: keyBetween(last?.sortKey ?? null, null),
        ...(t.description ? { description: t.description } : {}),
      };
    });
    return id;
  }

  updateToken(id: string, patch: { name?: string; value?: string | number; description?: string | null }) {
    const t = this.data.theme.tokens[id];
    if (!t) return;
    runInAction(() => {
      if (patch.name !== undefined) t.name = patch.name;
      if (patch.value !== undefined) t.value = patch.value;
      if (patch.description !== undefined) {
        if (patch.description === null || patch.description === '') delete t.description;
        else t.description = patch.description;
      }
    });
  }

  deleteToken(id: string) {
    const t = this.data.theme.tokens[id];
    if (t) runInAction(() => (t['~'] = true));
  }

  // ------------------------------------------------------------------ misc

  setFileName(name: string) {
    runInAction(() => (this.data.name = name));
  }

  /** Snapshot plano del documento. */
  snapshot(): MokiFile {
    return toJS(this.data);
  }
}

/** Utilidad para depurar rutas de edición. */
export const editPathSegments = splitPath;
