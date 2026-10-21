import { useEffect, useState } from 'react';

// Router mínimo sobre la History API.

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  for (const l of listeners) l();
}

window.addEventListener('popstate', () => {
  for (const l of listeners) l();
});

export function usePathname(): string {
  const [p, setP] = useState(location.pathname);
  useEffect(() => {
    const l = () => setP(location.pathname);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return p;
}

export function parseFileRoute(path: string): { fileId: string; pageId: string | null } | null {
  const m = /^\/file\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path);
  if (!m) return null;
  return { fileId: decodeURIComponent(m[1]!), pageId: m[2] ? decodeURIComponent(m[2]) : null };
}
