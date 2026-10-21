import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatHex, parse } from 'culori';
import { ColorPicker, toHexDisplay } from './ColorPicker';

// Controles compactos del panel de propiedades. Todos confirman al pulsar Enter o al perder
// el foco (un cambio = un paso de undo).

export function TextInput({
  value,
  onCommit,
  placeholder,
  className = '',
  title,
  mono,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
  title?: string;
  mono?: boolean;
}) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <input
      className={`input ${mono ? 'mono ' : ''}${className}`}
      value={local}
      title={title}
      placeholder={placeholder}
      onFocus={(e) => {
        focused.current = true;
        e.target.select();
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(e) => setLocal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setLocal(value);
          focused.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Campo numérico con etiqueta "scrub" (arrastrar para cambiar). Valores sin unidad → px. */
export function NumField({
  label,
  value,
  onCommit,
  unit = 'px',
  step = 1,
  min,
  title,
}: {
  label: ReactNode;
  value: string;
  onCommit: (v: string) => void;
  unit?: string;
  step?: number;
  min?: number;
  title?: string;
}) {
  const normalize = (v: string) => {
    const t = v.trim();
    if (t === '') return '';
    if (/^-?\d*\.?\d+$/.test(t)) return unit ? `${t}${unit}` : t;
    return t;
  };
  const scrub = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const base = parseFloat(value) || 0;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = value;
    const move = (ev: PointerEvent) => {
      let n = base + Math.round((ev.clientX - startX) / 2) * step * (ev.shiftKey ? 10 : 1);
      if (min !== undefined) n = Math.max(min, n);
      const next = `${Math.round(n * 100) / 100}${unit}`;
      if (next !== last) {
        last = next;
        onCommit(next);
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <label className="num-field" title={title}>
      <span className="num-label" onPointerDown={scrub}>
        {label}
      </span>
      <TextInput value={value} onCommit={(v) => onCommit(normalize(v))} />
    </label>
  );
}

export function colorToHex(v: string): string | null {
  try {
    const c = parse(v);
    return c ? (formatHex(c) ?? null) : null;
  } catch {
    return null;
  }
}

export function ColorField({
  value,
  onCommit,
  swatchValue,
}: {
  value: string;
  onCommit: (v: string) => void;
  /** Color resuelto para el swatch (si `value` es un token). */
  swatchValue?: string;
}) {
  const [open, setOpen] = useState(false);
  const swatchRef = useRef<HTMLButtonElement>(null);
  // Los colores literales se muestran siempre en HEX (#RRGGBB o #RRGGBBAA); tokens y expresiones
  // (var(), color-mix…) se muestran tal cual.
  const shown = toHexDisplay(value) ?? value;
  return (
    <div className="color-field">
      <button
        ref={swatchRef}
        type="button"
        className="swatch"
        title="Elegir color"
        style={{ background: swatchValue ?? value }}
        onClick={() => setOpen((o) => !o)}
      />
      <TextInput value={shown} onCommit={(v) => onCommit(normalizeColorInput(v))} mono />
      {open && swatchRef.current && (
        <ColorPicker anchor={swatchRef.current} value={swatchValue ?? value} onChange={(hex) => onCommit(hex)} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/** "ff5b3a" → "#FF5B3A"; el resto (rgb(), var(), nombres…) se respeta. */
export function normalizeColorInput(v: string): string {
  const t = v.trim();
  if (/^[0-9a-f]{3,8}$/i.test(t) && [3, 4, 6, 8].includes(t.length)) return `#${t.toUpperCase()}`;
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return t.toUpperCase();
  return t;
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} title={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="panel-section">
      <div className="section-title">
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="prop-row">{children}</div>;
}
