import { splitCssValue } from '../../core/css';

// CSS (camelCase) → clases de Tailwind v4. Mapeo pragmático de las propiedades comunes; lo
// demás usa valores arbitrarios `[prop:valor]`. Lo que no cabe en una clase vuelve como estilo.

const SPACING_PX = 4; // --spacing = 0.25rem = 4px

const arb = (v: string) => v.trim().replace(/\s+/g, '_');

function spacing(v: string): string | null {
  const s = v.trim();
  if (s === '0' || s === '0px') return '0';
  if (s === 'auto') return 'auto';
  if (s === '100%') return 'full';
  const m = /^(-?\d*\.?\d+)px$/.exec(s);
  if (m) {
    const n = Number(m[1]) / SPACING_PX;
    if (Number.isInteger(n * 2) && n >= 0) return String(n);
  }
  const v4var = /^var\((--[\w-]+)\)$/.exec(s);
  if (v4var) return `(${v4var[1]})`;
  return `[${arb(s)}]`;
}

function withNeg(prefix: string, v: string): string {
  const s = v.trim();
  if (/^-\d/.test(s)) {
    const sp = spacing(s.slice(1));
    if (sp && !sp.startsWith('[')) return `-${prefix}-${sp}`;
  }
  return `${prefix}-${spacing(s)}`;
}

function colorValue(v: string): string {
  const s = v.trim().toLowerCase();
  if (s === 'white' || s === '#fff' || s === '#ffffff' || s === 'rgb(255, 255, 255)') return 'white';
  if (s === 'black' || s === '#000' || s === '#000000' || s === 'rgb(0, 0, 0)') return 'black';
  if (s === 'transparent') return 'transparent';
  if (s === 'currentcolor') return 'current';
  const vv = /^var\((--[\w-]+)\)$/.exec(v.trim());
  if (vv) return `(${vv[1]})`;
  return `[${arb(v)}]`;
}

const SIZE_KEYWORDS: Record<string, string> = {
  '100%': 'full', 'fit-content': 'fit', auto: 'auto', 'max-content': 'max', 'min-content': 'min', '100vw': 'screen', '100vh': 'screen',
};

function size(prefix: string, v: string): string {
  const k = SIZE_KEYWORDS[v.trim()];
  if (k) return `${prefix}-${k}`;
  return `${prefix}-${spacing(v)}`;
}

const WEIGHTS: Record<string, string> = {
  '100': 'thin', '200': 'extralight', '300': 'light', '400': 'normal', '500': 'medium', '600': 'semibold', '700': 'bold', '800': 'extrabold', '900': 'black', bold: 'bold', normal: 'normal',
};

const ALIGN: Record<string, string> = { center: 'center', 'flex-start': 'start', start: 'start', 'flex-end': 'end', end: 'end', stretch: 'stretch', baseline: 'baseline' };
const JUSTIFY: Record<string, string> = { center: 'center', 'flex-start': 'start', start: 'start', 'flex-end': 'end', end: 'end', 'space-between': 'between', 'space-around': 'around', 'space-evenly': 'evenly', stretch: 'stretch' };

function box(prefixes: [string, string, string, string, string, string, string], v: string): string[] {
  // prefixes: all, x, y, t, r, b, l
  const [all, x, y, t, r, b, l] = prefixes;
  const p = splitCssValue(v);
  const [a, bb = a, c = a, d = bb] = p as [string, string?, string?, string?];
  if (p.length === 1) return [withNeg(all, a)];
  if (a === c && bb === d) return [withNeg(y, a), withNeg(x, bb!)];
  return [withNeg(t, a), withNeg(r, bb!), withNeg(b, c!), withNeg(l, d!)];
}

/** Convierte estilos a clases. Devuelve también los estilos que quedan como `style`. */
export function stylesToTailwind(styles: Record<string, string>): { classes: string[]; rest: Record<string, string> } {
  const classes: string[] = [];
  const rest: Record<string, string> = {};
  for (const [k, raw] of Object.entries(styles)) {
    const v = raw.trim();
    const c = one(k, v);
    if (c === null) rest[k] = v;
    else if (c !== '') classes.push(...c.split(' '));
  }
  return { classes, rest };
}

function one(k: string, v: string): string | null {
  switch (k) {
    case 'boxSizing':
      return '';
    case 'display':
      return v === 'none' ? 'hidden' : ['flex', 'inline-flex', 'block', 'inline-block', 'grid', 'inline-grid', 'inline', 'contents'].includes(v) ? v : `[display:${arb(v)}]`;
    case 'flexDirection':
      return { column: 'flex-col', row: 'flex-row', 'column-reverse': 'flex-col-reverse', 'row-reverse': 'flex-row-reverse' }[v] ?? null;
    case 'flexWrap':
      return { wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' }[v] ?? null;
    case 'alignItems':
      return ALIGN[v] ? `items-${ALIGN[v]}` : `[align-items:${arb(v)}]`;
    case 'alignSelf':
      return ALIGN[v] ? `self-${ALIGN[v]}` : v === 'auto' ? 'self-auto' : `[align-self:${arb(v)}]`;
    case 'alignContent':
      return JUSTIFY[v] ? `content-${JUSTIFY[v]}` : `[align-content:${arb(v)}]`;
    case 'justifyContent':
      return JUSTIFY[v] ? `justify-${JUSTIFY[v]}` : `[justify-content:${arb(v)}]`;
    case 'gap':
      return splitCssValue(v).length === 2 ? `gap-y-${spacing(splitCssValue(v)[0]!)} gap-x-${spacing(splitCssValue(v)[1]!)}` : `gap-${spacing(v)}`;
    case 'rowGap':
      return `gap-y-${spacing(v)}`;
    case 'columnGap':
      return `gap-x-${spacing(v)}`;
    case 'padding':
      return box(['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl'], v).join(' ');
    case 'margin':
      return box(['m', 'mx', 'my', 'mt', 'mr', 'mb', 'ml'], v).join(' ');
    case 'paddingTop': return withNeg('pt', v);
    case 'paddingRight': return withNeg('pr', v);
    case 'paddingBottom': return withNeg('pb', v);
    case 'paddingLeft': return withNeg('pl', v);
    case 'marginTop': return withNeg('mt', v);
    case 'marginRight': return withNeg('mr', v);
    case 'marginBottom': return withNeg('mb', v);
    case 'marginLeft': return withNeg('ml', v);
    case 'width': return size('w', v);
    case 'height': return size('h', v);
    case 'minWidth': return size('min-w', v);
    case 'minHeight': return size('min-h', v);
    case 'maxWidth': return size('max-w', v);
    case 'maxHeight': return size('max-h', v);
    case 'top': return withNeg('top', v);
    case 'left': return withNeg('left', v);
    case 'right': return withNeg('right', v);
    case 'bottom': return withNeg('bottom', v);
    case 'inset': return withNeg('inset', v);
    case 'position':
      return ['absolute', 'relative', 'fixed', 'sticky', 'static'].includes(v) ? v : null;
    case 'overflow':
      return ['hidden', 'clip', 'auto', 'scroll', 'visible'].includes(v) ? `overflow-${v}` : `[overflow:${arb(v)}]`;
    case 'overflowX':
      return `overflow-x-${v}`;
    case 'overflowY':
      return `overflow-y-${v}`;
    case 'flexGrow':
      return v === '1' ? 'grow' : v === '0' ? 'grow-0' : `grow-${v}`;
    case 'flexShrink':
      return v === '1' ? 'shrink' : v === '0' ? 'shrink-0' : `shrink-${v}`;
    case 'flex':
      return v === '1' || v === '1 1 0%' || v === '1 1 0px' ? 'flex-1' : v === 'none' ? 'flex-none' : v === 'auto' ? 'flex-auto' : `flex-[${arb(v)}]`;
    case 'flexBasis':
      return size('basis', v);
    case 'order':
      return `order-${v}`;
    case 'backgroundColor':
      return `bg-${colorValue(v)}`;
    case 'background':
      return /url\(|gradient/.test(v) ? `bg-[${arb(v)}]` : `bg-${colorValue(v)}`;
    case 'backgroundImage':
      return `bg-[${arb(v)}]`;
    case 'backgroundSize':
      return v === 'cover' ? 'bg-cover' : v === 'contain' ? 'bg-contain' : v === 'auto' ? 'bg-auto' : `bg-size-[${arb(v)}]`;
    case 'backgroundPosition':
      return v === 'center' ? 'bg-center' : ['top', 'bottom', 'left', 'right'].includes(v) ? `bg-${v}` : `bg-position-[${arb(v)}]`;
    case 'backgroundRepeat':
      return v === 'no-repeat' ? 'bg-no-repeat' : v === 'repeat' ? 'bg-repeat' : `[background-repeat:${arb(v)}]`;
    case 'color':
      return `text-${colorValue(v)}`;
    case 'fontSize':
      return /^var\(/.test(v) ? `text-(length:${v.slice(4, -1)})` : `text-[${arb(v)}]`;
    case 'fontWeight':
      return WEIGHTS[v] ? `font-${WEIGHTS[v]}` : `font-[${arb(v)}]`;
    case 'fontFamily': {
      const first = v.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
      if (/^var\(/.test(v)) return `font-(family-name:${v.slice(4, -1)})`;
      if (v.split(',').length > 1) return null;
      return /\s/.test(first) ? `font-['${first.replace(/\s+/g, '_')}']` : `font-[${first}]`;
    }
    case 'fontStyle':
      return v === 'italic' ? 'italic' : v === 'normal' ? 'not-italic' : null;
    case 'lineHeight':
      return `leading-[${arb(v)}]`;
    case 'letterSpacing':
      return `tracking-[${arb(v)}]`;
    case 'textAlign':
      return ['left', 'center', 'right', 'justify', 'start', 'end'].includes(v) ? `text-${v}` : null;
    case 'textTransform':
      return { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' }[v] ?? null;
    case 'textDecoration':
    case 'textDecorationLine':
      return { underline: 'underline', 'line-through': 'line-through', none: 'no-underline', overline: 'overline' }[v] ?? null;
    case 'whiteSpace':
      return ['nowrap', 'pre', 'pre-wrap', 'pre-line', 'normal', 'break-spaces'].includes(v) ? `whitespace-${v}` : null;
    case 'textOverflow':
      return v === 'ellipsis' ? 'text-ellipsis' : v === 'clip' ? 'text-clip' : null;
    case 'borderRadius':
      return v === '9999px' || v === '50%' || v === '999px' ? 'rounded-full' : v === '0px' || v === '0' ? 'rounded-none' : `rounded-[${arb(v)}]`;
    case 'border': {
      const parts = splitCssValue(v);
      const out: string[] = [];
      for (const p of parts) {
        if (/^\d*\.?\d+px$/.test(p)) out.push(p === '1px' ? 'border' : `border-[${p}]`);
        else if (['solid', 'dashed', 'dotted', 'double', 'none'].includes(p)) {
          if (p !== 'solid') out.push(`border-${p}`);
        } else out.push(`border-${colorValue(p)}`);
      }
      return out.join(' ');
    }
    case 'borderWidth':
      return v === '1px' ? 'border' : `border-[${arb(v)}]`;
    case 'borderColor':
      return `border-${colorValue(v)}`;
    case 'borderStyle':
      return `border-${v}`;
    case 'opacity': {
      const n = Number(v);
      if (Number.isFinite(n) && Number.isInteger(n * 100)) return `opacity-${Math.round(n * 100)}`;
      return `opacity-[${arb(v)}]`;
    }
    case 'boxShadow':
      return v === 'none' ? 'shadow-none' : `shadow-[${arb(v)}]`;
    case 'zIndex':
      return `z-[${arb(v)}]`;
    case 'aspectRatio':
      return `aspect-[${v.replace(/\s*\/\s*/, '/').replace(/\s+/g, '_')}]`;
    case 'cursor':
      return `cursor-${v}`;
    case 'objectFit':
      return `object-${v}`;
    case 'rotate':
      return `rotate-[${arb(v)}]`;
    default: {
      if (/['"]/.test(v)) return null;
      const kebab = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()).replace(/^webkit-/, '-webkit-').replace(/^moz-/, '-moz-');
      return `[${kebab}:${arb(v)}]`;
    }
  }
}
