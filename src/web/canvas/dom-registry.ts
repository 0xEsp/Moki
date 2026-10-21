// Índice bidireccional nodo ↔ elemento DOM de un árbol renderizado.

export type NodeElement = HTMLElement | SVGElement;

export class DomRegistry {
  private byId = new Map<string, NodeElement>();
  private byEl = new WeakMap<Element, string>();
  private listeners = new Set<(id: string, el: NodeElement | null) => void>();

  register(id: string, el: NodeElement) {
    this.byId.set(id, el);
    this.byEl.set(el, id);
    for (const l of this.listeners) l(id, el);
  }

  unregister(id: string, el: NodeElement) {
    if (this.byId.get(id) === el) this.byId.delete(id);
    for (const l of this.listeners) l(id, null);
  }

  el(id: string): NodeElement | undefined {
    return this.byId.get(id);
  }

  idOf(el: Element): string | undefined {
    return this.byEl.get(el);
  }

  ids(): IterableIterator<string> {
    return this.byId.keys();
  }

  /** Notificación de montaje/desmontaje (para medir). */
  onChange(l: (id: string, el: NodeElement | null) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
