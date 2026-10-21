import type { Edit } from './types';

// Aplicación de ediciones sobre JSON plano (servidor y clientes sin MobX).
// Semántica: último-que-escribe-gana por ruta. Soft delete con la clave "~".

export function splitPath(path: string): string[] {
  if (!path || path === '/') return [];
  return path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function joinPath(segments: (string | number)[]): string {
  return (
    '/' +
    segments.map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
  );
}

type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return typeof v === 'object' && v !== null;
}

/**
 * Aplica una edición sobre `root` (mutándolo). Devuelve false si la edición no pudo
 * aplicarse (ruta intermedia inexistente en un update, etc.).
 */
export function applyEdit(root: Record<string, unknown>, edit: Edit): boolean {
  const segs = splitPath(edit.path);
  if (segs.length === 0) return false;
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (!isContainer(cur)) return false;
    let next = (cur as Record<string, unknown>)[seg];
    if (!isContainer(next)) {
      if (edit.type === 'add') {
        next = {};
        (cur as Record<string, unknown>)[seg] = next;
      } else {
        return false;
      }
    }
    cur = next;
  }
  const last = segs[segs.length - 1]!;
  if (!isContainer(cur)) return false;

  if (Array.isArray(cur)) {
    const idx = last === '-' ? cur.length : Number(last);
    switch (edit.type) {
      case 'add':
        cur.splice(idx, 0, clone(edit.value));
        return true;
      case 'update':
        if (idx >= cur.length) return false;
        cur[idx] = clone(edit.value);
        return true;
      case 'remove':
        cur.splice(idx, 1);
        return true;
      case 'splice': {
        const arr = cur[idx];
        if (!Array.isArray(arr)) return false;
        arr.splice(edit.index, edit.removedCount, ...clone(edit.added));
        return true;
      }
    }
  }

  const obj = cur as Record<string, unknown>;
  switch (edit.type) {
    case 'add':
    case 'update':
      obj[last] = clone(edit.value);
      return true;
    case 'remove':
      delete obj[last];
      return true;
    case 'splice': {
      const arr = obj[last];
      if (!Array.isArray(arr)) return false;
      arr.splice(edit.index, edit.removedCount, ...clone(edit.added));
      return true;
    }
  }
  return false;
}

export function applyEdits(root: Record<string, unknown>, edits: Edit[]): number {
  let ok = 0;
  for (const e of edits) if (applyEdit(root, e)) ok++;
  return ok;
}

/** Lee el valor en una ruta (o undefined). */
export function getAtPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of splitPath(path)) {
    if (!isContainer(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function clone<T>(v: T): T {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  return structuredClone(v);
}

/**
 * Calcula la edición inversa de `edit` dado el estado ANTES de aplicarla.
 * Útil para undo en clientes sin MobX.
 */
export function invertEdit(rootBefore: Record<string, unknown>, edit: Edit): Edit | null {
  const before = getAtPath(rootBefore, edit.path);
  switch (edit.type) {
    case 'add':
    case 'update':
      return before === undefined
        ? { path: edit.path, type: 'remove' }
        : { path: edit.path, type: 'update', value: clone(before) };
    case 'remove':
      return before === undefined ? null : { path: edit.path, type: 'add', value: clone(before) };
    case 'splice': {
      const arr = before as unknown[] | undefined;
      if (!Array.isArray(arr)) return null;
      return {
        path: edit.path,
        type: 'splice',
        index: edit.index,
        removedCount: edit.added.length,
        added: clone(arr.slice(edit.index, edit.index + edit.removedCount)),
      };
    }
  }
}
