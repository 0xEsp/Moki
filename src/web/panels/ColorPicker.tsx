import { converter, formatHex, formatHex8, parse } from 'culori';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';

// Selector de color propio (el nativo de Chrome abre siempre en RGB y no se puede configurar).
// HEX es el formato por defecto; RGB y HSL como alternativas. Emite siempre #RRGGBB o #RRGGBBAA.

const toHsv = converter('hsv');

export interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

export function parseToHsva(value: string | null | undefined): Hsva | null {
  if (!value) return null;
  try {
    const c = parse(value);
    if (!c) return null;
    const hsv = toHsv(c);
    return { h: hsv.h ?? 0, s: hsv.s ?? 0, v: hsv.v ?? 0, a: hsv.alpha ?? 1 };
  } catch {
    return null;
  }
}

export function hsvaToHex({ h, s, v, a }: Hsva): string {
  const c = { mode: 'hsv' as const, h, s, v, alpha: a };
  return ((a < 1 ? formatHex8(c) : formatHex(c)) ?? '#000000').toUpperCase();
}

/** Color CSS literal → #RRGGBB(AA) en mayúsculas; null si no es un color literal (token, color-mix…). */
export function toHexDisplay(value: string | null | undefined): string | null {
  if (!value || /var\(|color-mix\(|currentcolor|transparent|inherit/i.test(value)) return null;
  const hsva = parseToHsva(value);
  return hsva ? hsvaToHex(hsva) : null;
}

type Format = 'hex' | 'rgb' | 'hsl';

export function ColorPicker({
  anchor,
  value,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  value: string;
  /** Se llama en vivo mientras se arrastra (`final=false`) y al soltar / confirmar (`final=true`). */
  onChange: (hex: string, final: boolean) => void;
  onClose: () => void;
}) {
  const [hsva, setHsva] = useState<Hsva>(() => parseToHsva(value) ?? { h: 0, s: 0, v: 0, a: 1 });
  const [format, setFormat] = useState<Format>('hex');
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const hex = hsvaToHex(hsva);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = 232;
    const h = rootRef.current?.offsetHeight ?? 300;
    let left = r.left - w - 8;
    if (left < 8) left = Math.min(window.innerWidth - w - 8, r.right + 8);
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, r.top - 40));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  const update = (next: Hsva, final: boolean) => {
    setHsva(next);
    onChange(hsvaToHex(next), final);
  };

  const drag = (e: ReactPointerEvent<HTMLDivElement>, apply: (fx: number, fy: number) => Hsva) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const at = (ev: { clientX: number; clientY: number }, final: boolean) => {
      const r = el.getBoundingClientRect();
      const fx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const fy = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      update(apply(fx, fy), final);
    };
    at(e, false);
    const move = (ev: PointerEvent) => at(ev, false);
    const up = (ev: PointerEvent) => {
      at(ev, true);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const pure = hsvaToHex({ h: hsva.h, s: 1, v: 1, a: 1 });
  const opaque = hsvaToHex({ ...hsva, a: 1 });
  const eyeDropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;

  return createPortal(
    <div className="color-picker" ref={rootRef} style={{ left: pos.left, top: pos.top }} onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="cp-sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})` }}
        onPointerDown={(e) => drag(e, (fx, fy) => ({ ...hsva, s: fx, v: 1 - fy }))}
      >
        <div className="cp-thumb" style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%`, background: opaque }} />
      </div>
      <div className="cp-row">
        {eyeDropper && (
          <button
            className="icon-btn cp-eyedropper"
            title="Cuentagotas"
            onClick={async () => {
              try {
                const r = await new eyeDropper().open();
                const next = parseToHsva(r.sRGBHex);
                if (next) update({ ...next, a: hsva.a }, true);
              } catch {
                /* cancelado */
              }
            }}
          >
            ⌖
          </button>
        )}
        <div className="cp-sliders">
          <div className="cp-hue" onPointerDown={(e) => drag(e, (fx) => ({ ...hsva, h: fx * 360 }))}>
            <div className="cp-slider-thumb" style={{ left: `${(hsva.h / 360) * 100}%`, background: pure }} />
          </div>
          <div className="cp-alpha" onPointerDown={(e) => drag(e, (fx) => ({ ...hsva, a: Math.round(fx * 100) / 100 }))}>
            <div className="cp-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${opaque})` }} />
            <div className="cp-slider-thumb" style={{ left: `${hsva.a * 100}%`, background: opaque }} />
          </div>
        </div>
      </div>
      <div className="cp-inputs">
        <select className="cp-format" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
          <option value="hex">HEX</option>
          <option value="rgb">RGB</option>
          <option value="hsl">HSL</option>
        </select>
        <FormatInput format={format} hsva={hsva} onCommit={(next) => update(next, true)} />
        <AlphaInput a={hsva.a} onCommit={(a) => update({ ...hsva, a }, true)} />
      </div>
      <div className="cp-footer mono">{hex}</div>
    </div>,
    document.body,
  );
}

function FormatInput({ format, hsva, onCommit }: { format: Format; hsva: Hsva; onCommit: (h: Hsva) => void }) {
  const display = (() => {
    const hex = hsvaToHex({ ...hsva, a: 1 });
    if (format === 'hex') return hex.slice(1);
    const c = parse(hex)!;
    if (format === 'rgb') {
      const rgb = converter('rgb')(c);
      return [rgb.r, rgb.g, rgb.b].map((x) => Math.round((x ?? 0) * 255)).join(', ');
    }
    const hsl = converter('hsl')(c);
    return `${Math.round(hsl.h ?? 0)}, ${Math.round((hsl.s ?? 0) * 100)}%, ${Math.round((hsl.l ?? 0) * 100)}%`;
  })();
  const [text, setText] = useState(display);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setText(display), [display]);
  useEffect(() => {
    if (format === 'hex') ref.current?.select();
  }, [format]);
  const commit = () => {
    let css = text.trim();
    if (format === 'hex') css = css.startsWith('#') ? css : `#${css}`;
    else if (format === 'rgb') css = `rgb(${css})`;
    else css = `hsl(${css.replace(/%/g, '').split(/\s*,\s*/).map((p, i) => (i === 0 ? p : `${p}%`)).join(', ')})`;
    const next = parseToHsva(css);
    if (next) onCommit({ ...next, a: format === 'hex' && /^#?[0-9a-f]{8}$/i.test(text.trim()) ? next.a : hsva.a });
    else setText(display);
  };
  return (
    <input
      ref={ref}
      autoFocus={format === 'hex'}
      className="input mono cp-value"
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

function AlphaInput({ a, onCommit }: { a: number; onCommit: (a: number) => void }) {
  const display = `${Math.round(a * 100)}%`;
  const [text, setText] = useState(display);
  useEffect(() => setText(display), [display]);
  const commit = () => {
    const n = parseFloat(text);
    if (Number.isFinite(n)) onCommit(Math.max(0, Math.min(100, n)) / 100);
    else setText(display);
  };
  return (
    <input
      className="input mono cp-alpha-input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

/**
 * Sustituye en un valor CSS los colores funcionales (rgb(), hsl(), oklch(), lab()…) por su HEX, para
 * mostrar. No toca var(), color-mix(), gradientes con tokens ni nombres de propiedad.
 */
export function hexifyCss(value: string): string {
  if (!/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(value)) return value;
  return value.replace(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi, (m, _fn, offset: number, all: string) => {
    // Dentro de color-mix(...) el color forma parte de una expresión: se respeta.
    const before = all.slice(0, offset);
    if (/color-mix\([^)]*$/i.test(before)) return m;
    return toHexDisplay(m) ?? m;
  });
}
