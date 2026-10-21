import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

// Puerta de acceso cuando el servidor tiene MOKI_TOKEN (p. ej. Moki en una Raspberry de la
// LAN). Si no hay token configurado, no muestra nada y deja pasar.

type SessionState = 'checking' | 'ok' | 'login' | 'offline';

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>('checking');

  useEffect(() => {
    fetch('/api/session', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ authRequired: boolean; authenticated: boolean }>)
      .then((s) => setState(!s.authRequired || s.authenticated ? 'ok' : 'login'))
      .catch(() => setState('offline'));
  }, []);

  if (state === 'ok') return <>{children}</>;
  if (state === 'checking') return null;
  if (state === 'offline') return <Shell>No se puede contactar con el servidor de Moki.</Shell>;
  return <LoginForm onDone={() => setState('ok')} />;
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (r.ok) onDone();
      else setError('Token incorrecto');
    } catch {
      setError('No se puede contactar con el servidor');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 280 }}>
        <div style={{ fontSize: 13, color: 'var(--ui-muted-2)' }}>Este Moki está protegido. Introduce el token de acceso (MOKI_TOKEN).</div>
        <input
          autoFocus
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token"
          style={{ height: 34, padding: '0 10px', border: '1px solid var(--ui-border)', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: 'var(--ui-surface)', color: 'var(--ui-text)' }}
        />
        {error && <div style={{ fontSize: 12, color: 'var(--ui-danger-text)' }}>{error}</div>}
        <button
          type="submit"
          disabled={busy || !token.trim()}
          style={{ height: 34, border: 0, borderRadius: 8, background: 'var(--ui-primary)', color: 'var(--ui-on-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy || !token.trim() ? 0.5 : 1 }}
        >
          Entrar
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, fontFamily: 'Inter, system-ui, sans-serif', background: 'var(--ui-panel-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 20 }}>
        <span style={{ width: 18, height: 18, borderRadius: 9, background: '#FF5B3A', border: '3px solid var(--ui-text)' }} />
        moki
      </div>
      {children}
    </div>
  );
}
