import { ExportDialog } from '../panels/ExportDialog';
import { ThemeToggle } from '../ThemeToggle';
import { useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../router';
import { copyText } from '../clipboard';

interface Resource {
  id: string;
  name: string;
  type: 'file' | 'folder';
  parentId?: string | null;
  updatedAt?: number;
  createdAt?: number;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : null) as T;
}

function timeAgo(ms?: number): string {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(ms).toLocaleDateString();
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <span className="moki-logo" style={{ fontSize: size }}>
      <span className="moki-logo-dot" />
      moki
    </span>
  );
}

export function Dashboard() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [exporting, setExporting] = useState<Resource | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Carpeta sobre la que se está arrastrando (null = raíz; undefined = ninguna). */
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string>(`${location.origin}/mcp`);
  const [authRequired, setAuthRequired] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{
        resources?: Resource[];
        files?: { id: string; name: string; folderId?: string | null; updatedAt?: number; createdAt?: number }[];
        folders?: { id: string; name: string; parentId?: string | null; updatedAt?: number; createdAt?: number }[];
      }>('/api/resources');
      const list: Resource[] = r.resources ?? [
        ...(r.folders ?? []).map((f) => ({ ...f, type: 'folder' as const })),
        ...(r.files ?? []).map((f) => ({ id: f.id, name: f.name, parentId: f.folderId ?? null, updatedAt: f.updatedAt, createdAt: f.createdAt, type: 'file' as const })),
      ];
      list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      setResources(list);
      setError(null);
    } catch (e) {
      setError(`No se pudo contactar con el servidor de Moki (${(e as Error).message})`);
    }
  }, []);

  useEffect(() => {
    load();
    api<{ mcpUrl?: string; authRequired?: boolean }>('/api/info')
      .then((i) => {
        if (i?.mcpUrl) setMcpUrl(i.mcpUrl);
        setAuthRequired(!!i?.authRequired);
      })
      .catch(() => undefined);
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const createFile = async () => {
    const r = await api<{ id?: string; fileId?: string }>('/api/files', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sin título', folderId: folder }),
    });
    const id = r.id ?? r.fileId;
    if (id) navigate(`/file/${id}`);
  };
  const createFolder = async () => {
    const name = prompt('Nombre de la carpeta', 'Nueva carpeta');
    if (!name) return;
    await api('/api/folders', { method: 'POST', body: JSON.stringify({ name, parentId: folder }) });
    load();
  };
  const rename = async (r: Resource, name: string) => {
    setRenaming(null);
    if (!name.trim() || name === r.name) return;
    await api(`/api/${r.type === 'file' ? 'files' : 'folders'}/${r.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    load();
  };
  const remove = async (r: Resource) => {
    if (!confirm(`¿Eliminar "${r.name}"?`)) return;
    await api(`/api/${r.type === 'file' ? 'files' : 'folders'}/${r.id}`, { method: 'DELETE' });
    load();
  };
  /** Ids de una carpeta y todas sus subcarpetas (una carpeta no puede ir dentro de sí misma). */
  const subtreeOf = (folderId: string): Set<string> => {
    const out = new Set([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of resources) {
        if (r.type === 'folder' && r.parentId && out.has(r.parentId) && !out.has(r.id)) {
          out.add(r.id);
          grew = true;
        }
      }
    }
    return out;
  };
  const canMoveInto = (r: Resource, target: string | null) =>
    (r.parentId ?? null) !== target && !(r.type === 'folder' && target !== null && subtreeOf(r.id).has(target));
  const move = async (r: Resource, target: string | null) => {
    setMoving(null);
    if (!canMoveInto(r, target)) return;
    const body = r.type === 'file' ? { folderId: target } : { parentId: target };
    await api(`/api/${r.type === 'file' ? 'files' : 'folders'}/${r.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    load();
  };
  /** Ruta "A / B / C" de una carpeta (para el menú Mover a…). */
  const pathOf = (id: string): string => {
    const names: string[] = [];
    let cur = resources.find((x) => x.id === id);
    while (cur) {
      names.unshift(cur.name);
      cur = cur.parentId ? resources.find((x) => x.id === cur!.parentId) : undefined;
    }
    return names.join(' / ');
  };
  const dragProps = (r: Resource) => ({
    draggable: renaming !== r.id,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('application/x-moki-resource', r.id);
      e.dataTransfer.effectAllowed = 'move';
      setDragging(r.id);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropTarget(undefined);
    },
  });
  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const r = resources.find((x) => x.id === dragging);
      if (!r || !canMoveInto(r, target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget(undefined),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const r = resources.find((x) => x.id === e.dataTransfer.getData('application/x-moki-resource'));
      setDropTarget(undefined);
      if (r) move(r, target);
    },
  });
  const moveMenu = (r: Resource) => {
    const options: { id: string | null; label: string }[] = [
      { id: null, label: 'Diseños (raíz)' },
      ...resources.filter((x) => x.type === 'folder').map((x) => ({ id: x.id, label: pathOf(x.id) })).sort((a, b) => a.label.localeCompare(b.label)),
    ].filter((o) => canMoveInto(r, o.id));
    return (
      <div className="dash-move-menu" onMouseLeave={() => setMoving(null)}>
        <div className="dash-move-title">Mover a…</div>
        {options.length === 0 && <div className="muted pad">No hay otras carpetas</div>}
        {options.map((o) => (
          <button key={o.id ?? 'root'} className="dash-move-item" onClick={() => move(r, o.id)}>
            {o.id ? '📁 ' : '⌂ '}
            {o.label}
          </button>
        ))}
      </div>
    );
  };

  const importFile = async (f: File) => {
    // .json (fichero exportado) o .moki.zip (bundle editable con sus imágenes). Se importa en la
    // carpeta que se está viendo.
    const isZip = /\.zip$/i.test(f.name) || f.type === 'application/zip';
    try {
      const qs = folder ? `?folderId=${encodeURIComponent(folder)}` : '';
      const res = await fetch(`/api/files/import${qs}`, {
        method: 'POST',
        headers: { 'content-type': isZip ? 'application/zip' : 'application/json' },
        body: isZip ? await f.arrayBuffer() : await f.text(),
      });
      const r = (await res.json().catch(() => ({}))) as { id?: string; fileId?: string; message?: string };
      if (!res.ok) throw new Error(r.message ?? `HTTP ${res.status}`);
      load();
      const id = r?.id ?? r?.fileId;
      if (id) navigate(`/file/${id}`);
    } catch (e) {
      alert(`No se pudo importar: ${(e as Error).message}`);
    }
  };

  const cmd = `claude mcp add --transport http moki ${mcpUrl}${authRequired ? ' --header "Authorization: Bearer <MOKI_TOKEN>"' : ''}`;
  const visible = resources.filter((r) => (r.parentId ?? null) === folder);
  const folders = visible.filter((r) => r.type === 'folder');
  const files = visible.filter((r) => r.type === 'file');
  const currentFolder = resources.find((r) => r.id === folder);

  return (
    <div className="dash">
      <header className="dash-header">
        <Logo size={20} />
        <div className="dash-actions">
          <ThemeToggle />
          <button className="btn" onClick={() => importRef.current?.click()}>
            Importar
          </button>
          <button className="btn" onClick={createFolder}>
            Nueva carpeta
          </button>
          <button className="btn btn-primary" onClick={createFile}>
            + Nuevo diseño
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json,application/zip,.zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      <main className="dash-main">
        <section className="dash-mcp">
          <div>
            <h3>Conecta un agente</h3>
            <p>
              Moki expone un servidor MCP local. Añádelo a Claude Code (o a cualquier cliente MCP con transporte
              HTTP) y el agente podrá leer y diseñar en tus ficheros mientras lo ves en directo.
            </p>
          </div>
          <div className="dash-cmd">
            <code title={cmd}>{cmd}</code>
            <button
              className="btn"
              onClick={() => {
                copyText(cmd).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copiado ✓' : 'Copiar'}
            </button>
          </div>
        </section>

        {error && <div className="dash-error">{error}</div>}

        <div className="dash-crumbs">
          <button className={`link${dropTarget === null ? ' drop-target' : ''}`} onClick={() => setFolder(null)} {...dropProps(null)}>
            Diseños
          </button>
          {(() => {
            const chain: Resource[] = [];
            let cur = currentFolder;
            while (cur) {
              chain.unshift(cur);
              cur = cur.parentId ? resources.find((x) => x.id === cur!.parentId) : undefined;
            }
            return chain.map((c) => (
              <span key={c.id} className="dash-crumb">
                <span>/</span>
                <button className={`link${dropTarget === c.id ? ' drop-target' : ''}`} onClick={() => setFolder(c.id)} {...dropProps(c.id)}>
                  {c.name}
                </button>
              </span>
            ));
          })()}
          {dragging && <span className="muted">Suelta sobre una carpeta (o sobre la ruta) para mover</span>}
        </div>

        <div className="dash-grid">
          {folders.map((r) => (
            <div
              key={r.id}
              className={`dash-card dash-folder${dropTarget === r.id ? ' drop-target' : ''}${dragging === r.id ? ' dragging' : ''}`}
              onDoubleClick={() => setFolder(r.id)}
              {...dragProps(r)}
              {...dropProps(r.id)}
            >
              <div className="dash-thumb folder" onClick={() => setFolder(r.id)}>
                📁
              </div>
              <CardFooter r={r} renaming={renaming === r.id} onRename={(n) => rename(r, n)} onStartRename={() => setRenaming(r.id)} onDelete={() => remove(r)} onMove={() => setMoving(moving === r.id ? null : r.id)} onExport={() => setExporting(r)} />
              {moving === r.id && moveMenu(r)}
            </div>
          ))}
          {files.map((r) => (
            <div key={r.id} className={`dash-card${dragging === r.id ? ' dragging' : ''}`} {...dragProps(r)}>
              <a
                className="dash-thumb"
                href={`/file/${r.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/file/${r.id}`);
                }}
              >
                <span className="dash-thumb-dot" />
              </a>
              <CardFooter r={r} renaming={renaming === r.id} onRename={(n) => rename(r, n)} onStartRename={() => setRenaming(r.id)} onDelete={() => remove(r)} onMove={() => setMoving(moving === r.id ? null : r.id)} onExport={() => setExporting(r)} />
              {moving === r.id && moveMenu(r)}
            </div>
          ))}
          {folders.length + files.length === 0 && !error && (
            <div className="dash-empty">
              Aún no hay diseños aquí.{' '}
              <button className="link" onClick={createFile}>
                Crea el primero
              </button>{' '}
              o pídeselo a tu agente.
            </div>
          )}
        </div>
      </main>
      {exporting && (
        <ExportDialog
          title={`Exportar ${exporting.type === 'folder' ? 'la carpeta' : 'el proyecto'} «${exporting.name}»`}
          initialScope={exporting.type === 'folder' ? 'folder' : 'file'}
          scopes={[
            exporting.type === 'folder'
              ? { scope: 'folder', label: 'Toda la carpeta (con subcarpetas)' }
              : { scope: 'file', label: 'Proyecto completo (todas las páginas)' },
          ]}
          base={exporting.type === 'folder' ? { folderId: exporting.id } : { fileId: exporting.id }}
          formats={['png', 'jpg', 'webp', 'pdf', 'pdf-combined', 'moki']}
          onClose={() => setExporting(null)}
        />
      )}
    </div>
  );
}

function CardFooter({
  r,
  renaming,
  onRename,
  onStartRename,
  onDelete,
  onMove,
  onExport,
}: {
  r: Resource;
  renaming: boolean;
  onRename: (n: string) => void;
  onStartRename: () => void;
  onDelete: () => void;
  onMove: () => void;
  onExport: () => void;
}) {
  return (
    <div className="dash-card-footer">
      <div className="dash-card-text">
        {renaming ? (
          <input
            className="input"
            autoFocus
            defaultValue={r.name}
            onBlur={(e) => onRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') onRename(r.name);
            }}
          />
        ) : (
          <div className="dash-card-name" onDoubleClick={onStartRename} title="Doble clic para renombrar">
            {r.name}
          </div>
        )}
        <div className="dash-card-meta">{timeAgo(r.updatedAt)}</div>
      </div>
      <div className="dash-card-menu">
        <button className="icon-btn" title={r.type === 'folder' ? 'Exportar la carpeta…' : 'Exportar el proyecto…'} onClick={onExport}>
          ⇩
        </button>
        <button className="icon-btn" title="Mover a carpeta…" onClick={onMove}>
          ⇢
        </button>
        <button className="icon-btn" title="Renombrar" onClick={onStartRename}>
          ✎
        </button>
        <button className="icon-btn" title="Eliminar" onClick={onDelete}>
          🗑
        </button>
      </div>
    </div>
  );
}
