import { action, makeObservable, observable } from 'mobx';
import type { EditorState } from '../editor/editor-state';
import { worldRectOf, type Rect } from './geometry';

// Caché de rectángulos de mundo de los nodos renderizados de la página activa.
// El navegador hace el layout; aquí solo leemos el resultado. Se re-mide (en un rAF) cuando
// cambia el DOM del diseño o el tamaño de algún nodo; la cámara no invalida (coordenadas de mundo).

export class MeasureCache {
  version = 0;
  private rects = new Map<string, Rect>();
  private scheduled = false;
  private mo: MutationObserver | null = null;
  private ro: ResizeObserver;
  private scope: HTMLElement | null = null;
  private unsubRegistry: () => void;

  constructor(private editor: EditorState) {
    makeObservable<MeasureCache, 'bump'>(this, { version: observable, bump: action });
    this.ro = new ResizeObserver(() => this.schedule());
    this.unsubRegistry = editor.registry.onChange((_id, el) => {
      if (el) this.ro.observe(el as Element);
      this.schedule();
    });
    document.fonts?.addEventListener?.('loadingdone', () => this.schedule());
  }

  /** Elemento que contiene el DOM del diseño (para observar mutaciones). */
  attach(scope: HTMLElement | null) {
    this.mo?.disconnect();
    this.scope = scope;
    if (!scope) return;
    this.mo = new MutationObserver(() => this.schedule());
    this.mo.observe(scope, { subtree: true, childList: true, attributes: true, characterData: true });
    this.schedule();
  }

  dispose() {
    this.mo?.disconnect();
    this.ro.disconnect();
    this.unsubRegistry();
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.measureNow();
    });
  }

  measureNow() {
    const { registry, rootId, camera } = this.editor;
    const origin = registry.el(rootId);
    if (!origin) return;
    const next = new Map<string, Rect>();
    for (const id of registry.ids()) {
      const el = registry.el(id);
      if (!el || !el.isConnected) continue;
      if (id === rootId) continue;
      next.set(id, worldRectOf(el, origin, camera.scale));
    }
    this.rects = next;
    this.bump();
  }

  private bump() {
    this.version++;
  }

  /** Rectángulo de mundo (lectura reactiva: depende de `version`). */
  rect(id: string): Rect | null {
    void this.version;
    return this.rects.get(id) ?? null;
  }

  /** Lectura no reactiva. */
  peek(id: string): Rect | null {
    return this.rects.get(id) ?? null;
  }
}
