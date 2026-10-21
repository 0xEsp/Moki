import { useEffect, useRef, useState } from 'react';
import type { BulkExportFormat, BulkExportJob, BulkExportRequest, BulkExportScope } from '../../core/protocol';

// Diálogo de exportación masiva: selección, página, proyecto (fichero) o carpeta. Lanza un job
// en el servidor (POST /api/export?async=1), muestra el progreso y descarga el resultado (un zip
// si hay más de un fichero).

export interface ExportScopeOption {
  scope: BulkExportScope;
  label: string;
  disabled?: boolean;
}

const FORMATS: { value: BulkExportFormat; label: string }[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'webp', label: 'WebP' },
  { value: 'svg', label: 'SVG (solo nodos SVG)' },
  { value: 'pdf', label: 'PDF (uno por artboard)' },
  { value: 'pdf-combined', label: 'PDF (uno por página)' },
  { value: 'moki', label: 'Moki (editable, .moki.zip)' },
];

const RASTER = new Set<BulkExportFormat>(['png', 'jpg', 'webp']);

export function triggerDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ExportDialog({
  title,
  scopes,
  initialScope,
  base,
  formats = FORMATS.map((f) => f.value),
  onClose,
}: {
  title: string;
  scopes: ExportScopeOption[];
  initialScope: BulkExportScope;
  /** Identificadores del objeto a exportar (fileId, pageId, nodeIds, folderId). */
  base: Omit<BulkExportRequest, 'scope' | 'format' | 'scale' | 'includeSource'>;
  formats?: BulkExportFormat[];
  onClose: () => void;
}) {
  const [scope, setScope] = useState<BulkExportScope>(initialScope);
  const [format, setFormat] = useState<BulkExportFormat>(() => {
    try {
      const f = localStorage.getItem('moki.exportFormat') as BulkExportFormat | null;
      return f && formats.includes(f) ? f : 'png';
    } catch {
      return 'png';
    }
  });
  const [scale, setScale] = useState(2);
  const [includeSource, setIncludeSource] = useState(false);
  const [job, setJob] = useState<BulkExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && job?.status !== 'running') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [job, onClose]);

  const running = job?.status === 'running';

  const run = async () => {
    setError(null);
    try {
      localStorage.setItem('moki.exportFormat', format);
    } catch {
      /* sin almacenamiento */
    }
    const body: BulkExportRequest = {
      ...base,
      scope,
      format,
      ...(RASTER.has(format) ? { scale } : {}),
      ...(format !== 'moki' && includeSource ? { includeSource: true } : {}),
    };
    try {
      const res = await fetch('/api/export?async=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const started = (await res.json()) as BulkExportJob & { message?: string };
      if (!res.ok) throw new Error(started.message ?? `HTTP ${res.status}`);
      setJob(started);
      let current = started;
      while (alive.current && current.status === 'running') {
        await new Promise((r) => setTimeout(r, 500));
        const r = await fetch(`/api/export/jobs/${current.id}`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        current = (await r.json()) as BulkExportJob;
        if (alive.current) setJob(current);
      }
      if (current.status === 'error') throw new Error(current.error ?? 'Error al exportar');
      if (current.result) triggerDownload(current.result.downloadUrl);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  };

  const result = job?.status === 'done' ? job.result : undefined;
  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal export-dialog" role="dialog" aria-label={title}>
        <div className="modal-title">{title}</div>

        <div className="export-field">
          <div className="export-label">Qué exportar</div>
          <div className="export-scopes">
            {scopes.map((s) => (
              <label key={s.scope} className={`export-scope${s.disabled ? ' disabled' : ''}`}>
                <input
                  type="radio"
                  name="export-scope"
                  checked={scope === s.scope}
                  disabled={s.disabled || running}
                  onChange={() => setScope(s.scope)}
                />
                {s.label}
              </label>
            ))}
          </div>
        </div>

        <div className="export-row">
          <label className="export-field grow">
            <span className="export-label">Formato</span>
            <select className="input" value={format} disabled={running} onChange={(e) => setFormat(e.target.value as BulkExportFormat)}>
              {FORMATS.filter((f) => formats.includes(f.value)).map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {RASTER.has(format) && (
            <label className="export-field">
              <span className="export-label">Escala</span>
              <select className="input" value={scale} disabled={running} onChange={(e) => setScale(Number(e.target.value))}>
                {[1, 2, 3].map((s) => (
                  <option key={s} value={s}>
                    {s}x
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {format !== 'moki' && (
          <label className="export-check">
            <input type="checkbox" checked={includeSource} disabled={running} onChange={(e) => setIncludeSource(e.target.checked)} />
            Incluir el fichero editable (.moki.zip)
          </label>
        )}

        {job && (
          <div className="export-progress">
            <div className="export-bar">
              <div style={{ width: `${job.status === 'done' ? 100 : pct}%` }} />
            </div>
            <div className="export-status muted">
              {job.status === 'running' && (job.total ? `${job.done}/${job.total} · ${job.current ?? ''}` : 'Preparando…')}
              {result && `✓ ${result.count} ${result.count === 1 ? 'fichero' : 'ficheros'} · ${result.name}`}
            </div>
            {result && result.errors.length > 0 && (
              <details className="export-errors">
                <summary>{result.errors.length} no se pudieron exportar</summary>
                <ul>
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      <b>{e.name}</b>: {e.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {result && (
              <button className="link" onClick={() => triggerDownload(result.downloadUrl)}>
                Descargar de nuevo
              </button>
            )}
          </div>
        )}
        {error && <div className="error-text">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={running}>
            {result ? 'Cerrar' : 'Cancelar'}
          </button>
          <button className="btn btn-primary" onClick={run} disabled={running || scopes.find((s) => s.scope === scope)?.disabled}>
            {running ? 'Exportando…' : 'Exportar'}
          </button>
        </div>
      </div>
    </div>
  );
}
