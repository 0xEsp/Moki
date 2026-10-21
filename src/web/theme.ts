// Tema de la interfaz: sistema (por defecto), claro u oscuro. Se guarda por navegador y se aplica
// como <html data-theme="light|dark">; los colores viven en variables CSS (styles.css).

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'moki.theme';
const listeners = new Set<(t: Theme) => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolvedTheme(pref = getThemePref()): Theme {
  if (pref !== 'system') return pref;
  return media?.matches ? 'dark' : 'light';
}

function apply() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  for (const l of listeners) l(t);
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* sin almacenamiento: dura esta sesión */
  }
  apply();
}

/** Ciclo del botón: sistema → claro → oscuro → sistema. */
export function cycleThemePref(): ThemePref {
  const order: ThemePref[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length]!;
  setThemePref(next);
  return next;
}

export function onThemeChange(l: (t: Theme) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Llamar una vez al arrancar la app (antes de pintar, para evitar parpadeo). */
export function initTheme() {
  apply();
  media?.addEventListener('change', () => {
    if (getThemePref() === 'system') apply();
  });
  // Otras pestañas de Moki cambian la preferencia → se sincroniza.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply();
  });
}
