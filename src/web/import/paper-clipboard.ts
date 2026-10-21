import { formatHex, formatHex8 } from 'culori';
import { keyBetween } from '../../core/fractional';
import { parseTokenValue, tokenByCssName } from '../../core/tokens';
import { FREEFORM_DISPLAY, type ComponentType, type Styles, type TokenType, type TreeNode } from '../../core/types';
import type { DocStore } from '../state/doc-store';
import type { ClipNode } from '../editor/actions';

// Importación de lo que Paper deja en el portapapeles al copiar (Cmd+C).
//
// Paper escribe un `text/html` con un comentario `<paper-paste-start data-embed="{json}">`. El
// JSON trae los nodos copiados (con ids temporales), el índice padre → hijos, las imágenes y los
// tokens que usan. Su modelo es muy parecido al de Moki (CSS camelCase en `styles`), salvo que
// rellenos, bordes, sombras, fuente y color SVG van estructurados en `styleMeta`, los colores en
// OKLCH y las referencias a tokens como ids pelados ("t:1b-0"). Aquí se traduce todo a CSS.

const EMBED_START = '<paper-paste-start data-embed="';
const EMBED_END = '"></paper-paste-start>';

interface PaperColorValue {
  mode: string;
  l?: number;
  c?: number;
  h?: number;
  alpha?: number;
  r?: number;
  g?: number;
  b?: number;
}
type PaperColor = string | { value?: PaperColorValue; mode?: string } | { type: 'alpha'; base: PaperColor; alpha: number | string };

interface PaperNode {
  id: string;
  label?: string;
  labelIsModified?: boolean;
  component: string;
  tag?: string;
  textValue?: string;
  isVisible?: boolean;
  isLocked?: boolean;
  styles?: Record<string, string | number | null>;
  styleMeta?: Record<string, unknown>;
  props?: Record<string, unknown>;
  svgNonRenderedElements?: SvgElementTree[];
  '~'?: boolean;
}

interface SvgElementTree {
  name: string;
  type: string;
  value?: string;
  attributes?: Record<string, string>;
  children?: SvgElementTree[];
}

interface PaperToken {
  id: string;
  name: string;
  type: TokenType;
  value: unknown;
  description?: string;
}

export interface PaperClipboard {
  fileId: string;
  topLevelNodeIds: string[];
  nodes: Record<string, PaperNode>;
  images: Record<string, { id: string; extension: string; width?: number; height?: number }>;
  parentToChildrenIndex: Record<string, string[]>;
  positions: Record<string, number[]>;
  tokens?: Record<string, PaperToken>;
}

/** Extrae el JSON de Paper de un `text/html` del portapapeles (o null si no es de Paper). */
export function parsePaperClipboard(html: string): PaperClipboard | null {
  const a = html.indexOf(EMBED_START);
  if (a < 0) return null;
  const b = html.indexOf(EMBED_END, a + EMBED_START.length);
  if (b < 0) return null;
  let raw = html.slice(a + EMBED_START.length, b);
  // Paper escapa < y > como < / > (válido en JSON). Si el HTML pasó por un parser, las
  // comillas pueden llegar como entidades.
  if (raw.includes('&quot;')) raw = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  try {
    const data = JSON.parse(raw) as PaperClipboard;
    return data && data.nodes && Array.isArray(data.topLevelNodeIds) ? data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- conversión

export interface ConvertDeps {
  doc: DocStore;
  /** Importa una URL remota al almacén local de Moki y devuelve la URL local. */
  importImage: (src: string) => Promise<{ url: string }>;
}

export interface ConvertResult {
  clips: ClipNode[];
  /** Posición en mundo de cada raíz (para colocarlas en el canvas). */
  positions: { x: number; y: number }[];
  createdTokens: number;
  warnings: string[];
}

const PAPER_ASSETS = 'https://app.paper.design/file-assets';

const SVG_CAMEL_ATTRS = new Set([
  'viewBox', 'preserveAspectRatio', 'gradientUnits', 'gradientTransform', 'patternUnits', 'patternTransform',
  'clipPathUnits', 'maskUnits', 'maskContentUnits', 'spreadMethod', 'stdDeviation', 'textLength', 'lengthAdjust',
  'markerWidth', 'markerHeight', 'refX', 'refY', 'pathLength', 'baseFrequency', 'numOctaves', 'kernelMatrix',
]);

const GENERIC = /^(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-[a-z-]+)$/i;

export async function convertPaperClipboard(data: PaperClipboard, deps: ConvertDeps): Promise<ConvertResult> {
  const { doc } = deps;
  const warnings: string[] = [];
  let createdTokens = 0;

  // 1) Tokens: se reutilizan los de Moki con el mismo nombre; si no existen, se crean.
  const tokenMap = new Map<string, string>(); // id Paper → id Moki
  const pending = Object.values(data.tokens ?? {});
  // Primero los que no son alias (para que los alias encuentren su destino).
  pending.sort((a, b) => Number(isTokenId(a.value)) - Number(isTokenId(b.value)));
  for (const t of pending) {
    const existing = tokenByCssName(doc.data, `--${t.name}`);
    if (existing) {
      tokenMap.set(t.id, existing.id);
      continue;
    }
    let value: string | number;
    if (isTokenId(t.value)) {
      const target = tokenMap.get(t.value as string);
      if (!target) {
        warnings.push(`Token ${t.name}: alias a un token que no vino en el portapapeles`);
        continue;
      }
      value = target;
    } else {
      const raw =
        t.type === 'color'
          ? (colorToCss(t.value as PaperColor, tokenMap) ?? '#000000')
          : typeof t.value === 'number' || typeof t.value === 'string'
            ? t.value
            : String(t.value);
      const parsed = parseTokenValue(doc.data, t.type, raw);
      if (!parsed.ok) {
        warnings.push(`Token ${t.name}: ${parsed.error}`);
        continue;
      }
      value = parsed.value;
    }
    tokenMap.set(t.id, doc.createToken({ type: t.type, name: t.name, value, description: t.description }));
    createdTokens++;
  }

  // 2) Imágenes: se copian al almacén local (una vez cada una).
  const imageUrls = new Map<string, string>();
  await Promise.all(
    Object.values(data.images ?? {}).map(async (img) => {
      const src = `${PAPER_ASSETS}/${data.fileId}/${img.id}.${img.extension}`;
      try {
        imageUrls.set(img.id, (await deps.importImage(src)).url);
      } catch (e) {
        warnings.push(`No se pudo importar la imagen ${img.id}: ${e instanceof Error ? e.message : String(e)}`);
        imageUrls.set(img.id, src);
      }
    }),
  );

  // 3) Nodos.
  const ref = (v: string) => {
    const m = tokenMap.get(v);
    return m ? `var(${m})` : null;
  };
  const mapValue = (v: string): string => {
    if (isTokenId(v)) return ref(v) ?? v;
    return v.replace(/var\((t:[0-9a-z]+-[0-9a-z]+)\)/g, (m, id: string) => ref(id) ?? m).replace(/\b(t:[0-9a-z]+-[0-9a-z]+)\b/g, (m, id: string) => ref(id) ?? m);
  };

  const convertNode = (pid: string): ClipNode | null => {
    const p = data.nodes[pid];
    if (!p || p['~']) return null;
    const component = mapComponent(p.component, warnings);
    const styles: Styles = {};
    for (const [k, v] of Object.entries(p.styles ?? {})) {
      if (v === null || v === undefined || v === '') continue;
      styles[k] = typeof v === 'string' ? mapValue(v) : v;
    }
    applyStyleMeta(p, component, styles, { colorToCss: (c) => colorToCss(c, tokenMap), imageUrls, mapValue });
    const node: TreeNode = {
      id: pid,
      label: p.label ?? component,
      component,
      styles,
      ...(p.labelIsModified ? { labelIsModified: true } : {}),
      ...(p.textValue !== undefined && (component === 'Text' || component === 'SVGVisualElement') ? { textValue: p.textValue } : {}),
      ...(p.isVisible === false ? { isVisible: false } : {}),
      ...(p.isLocked ? { isLocked: true } : {}),
      ...(component === 'SVGVisualElement' && p.tag ? { tag: p.tag } : {}),
    };
    if ((component === 'SVG' || component === 'SVGVisualElement') && p.props) {
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.props)) {
        if (v === null || v === undefined || typeof v === 'object') continue;
        const name = SVG_CAMEL_ATTRS.has(k) || k.includes('-') ? k : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        attrs[name] = mapValue(String(v));
      }
      if (component === 'SVG') {
        for (const dim of ['width', 'height'] as const) {
          if (attrs[dim] !== undefined) {
            if (styles[dim] === undefined) styles[dim] = /^\d+(\.\d+)?$/.test(attrs[dim]!) ? `${attrs[dim]}px` : attrs[dim]!;
            delete attrs[dim];
          }
        }
      }
      node.attrs = attrs;
    }
    if (component === 'SVG' && p.svgNonRenderedElements?.length) {
      node.svgNonRendered = p.svgNonRenderedElements.map(serializeSvgTree).join('');
    }
    const children = (data.parentToChildrenIndex[pid] ?? []).map(convertNode).filter((x): x is ClipNode => !!x);
    return { node, children };
  };

  // Raíces copiadas. Si vienen de DENTRO de un frame (Paper guarda [worldX, worldY, x, y] cuando
  // el padre no es la raíz de la página) y ese frame no viene en el portapapeles, se reconstruye un
  // frame contenedor por cada padre: así la barra de estado, la hoja, etc. siguen dentro de la
  // pantalla (con su safe area) en lugar de quedar como capas sueltas.
  type Root = { clip: ClipNode; world: { x: number; y: number }; local: { x: number; y: number } | null; paper: PaperNode };
  const roots: Root[] = [];
  for (const id of data.topLevelNodeIds) {
    const c = convertNode(id);
    if (!c) continue;
    const pos = data.positions[id] ?? [0, 0];
    const world = { x: pos[0] ?? 0, y: pos[1] ?? 0 };
    const local = pos.length >= 4 ? { x: pos[2] ?? 0, y: pos[3] ?? 0 } : null;
    roots.push({ clip: c, world, local, paper: data.nodes[id]! });
  }

  const clips: ClipNode[] = [];
  const positions: { x: number; y: number }[] = [];
  const groups = new Map<string, Root[]>();
  for (const r of roots) {
    if (!r.local) {
      clips.push(r.clip);
      positions.push(r.world);
      continue;
    }
    const key = `${round(r.world.x - r.local.x, 1)},${round(r.world.y - r.local.y, 1)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }
  let n = 0;
  for (const [key, members] of groups) {
    const [ox, oy] = key.split(',').map(Number) as [number, number];
    clips.push(rebuildParentFrame(members, ++n));
    positions.push({ x: ox, y: oy });
  }
  if (groups.size) warnings.push('Se copiaron capas de dentro de una pantalla: se ha reconstruido el frame contenedor (copia el artboard completo para conservar también su fondo y su nombre).');
  return { clips, positions, createdTokens, warnings };
}

/**
 * Alturas habituales de pantallas móviles/escritorio. Si el contenido mide casi lo mismo (p. ej. una
 * hoja que sobresale 3 px y el artboard recortaba), se usa la del dispositivo.
 */
const DEVICE_HEIGHTS = [667, 736, 780, 800, 812, 832, 844, 852, 874, 896, 915, 926, 932, 956, 1024, 1080, 1194, 1366, 900, 1024];
function snapDeviceHeight(h: number): number {
  const near = DEVICE_HEIGHTS.find((d) => h - d >= 0 && h - d <= 4); // solo si el contenido sobresale un poco
  return Math.round(near ?? h);
}

/** Tamaño conocido de una capa de Paper (px en estilos o tamaño fijado). */
function knownSize(p: PaperNode, axis: 'width' | 'height'): number | null {
  const v = p.styles?.[axis];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d*\.?\d+px$/.test(v)) return parseFloat(v);
  const pinned = (p as unknown as Record<string, unknown>)[axis === 'width' ? 'pinnedWidth' : 'pinnedHeight'];
  return typeof pinned === 'number' ? pinned : null;
}

/**
 * Frame contenedor para capas hermanas copiadas sin su padre. Deduce la maquetación: si las capas
 * en flujo están apiladas en vertical con la misma x → flex column (con el gap observado); en
 * horizontal → flex row; si no, contenedor libre con cada capa en su posición. Las capas absolutas
 * conservan sus insets.
 */
function rebuildParentFrame(members: { clip: ClipNode; local: { x: number; y: number } | null; paper: PaperNode }[], n: number): ClipNode {
  const isAbs = (m: (typeof members)[number]) => {
    const pos = m.clip.node.styles.position;
    return pos === 'absolute' || pos === 'fixed';
  };
  const flow = members.filter((m) => !isAbs(m));
  let width = 0;
  let height = 0;
  for (const m of members) {
    const w = knownSize(m.paper, 'width');
    const h = knownSize(m.paper, 'height');
    if (w !== null) width = Math.max(width, m.local!.x + w);
    if (h !== null && !isAbs(m)) height = Math.max(height, m.local!.y + h);
  }
  const styles: Styles = { width: `${Math.round(width || 393)}px`, height: `${snapDeviceHeight(height || 852)}px`, overflow: 'clip' };
  const sameX = flow.every((m) => Math.abs(m.local!.x - flow[0]!.local!.x) < 0.5);
  const sameY = flow.every((m) => Math.abs(m.local!.y - flow[0]!.local!.y) < 0.5);
  const byY = [...flow].sort((a, b) => a.local!.y - b.local!.y);
  const byX = [...flow].sort((a, b) => a.local!.x - b.local!.x);
  const gapOf = (sorted: typeof flow, axis: 'x' | 'y') => {
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const size = knownSize(prev.paper, axis === 'y' ? 'height' : 'width');
      if (size === null) return 0;
      gaps.push(sorted[i]!.local![axis] - (prev.local![axis] + size));
    }
    const g = gaps.length ? Math.min(...gaps) : 0;
    return g > 0.5 ? Math.round(g) : 0;
  };
  const children: ClipNode[] = [];
  if (flow.length && sameX && (flow.length === 1 || !sameY)) {
    styles.display = 'flex';
    styles.flexDirection = 'column';
    const gap = gapOf(byY, 'y');
    if (gap) styles.gap = `${gap}px`;
    if (flow[0]!.local!.x > 0.5) styles.paddingLeft = `${Math.round(flow[0]!.local!.x)}px`;
    if (byY[0]!.local!.y > 0.5) styles.paddingTop = `${Math.round(byY[0]!.local!.y)}px`;
  } else if (flow.length && sameY) {
    styles.display = 'flex';
    styles.flexDirection = 'row';
    const gap = gapOf(byX, 'x');
    if (gap) styles.gap = `${gap}px`;
    if (byX[0]!.local!.x > 0.5) styles.paddingLeft = `${Math.round(byX[0]!.local!.x)}px`;
    if (flow[0]!.local!.y > 0.5) styles.paddingTop = `${Math.round(flow[0]!.local!.y)}px`;
  } else {
    styles.display = FREEFORM_DISPLAY;
  }
  // Fondo: no viaja en el portapapeles. Se toma el de la capa en flujo más grande con color sólido
  // (la "hoja" de la pantalla), para que la barra de estado no quede flotando sobre el canvas.
  const withBg = members
    .filter((m) => !isAbs(m) && typeof m.clip.node.styles.backgroundColor === 'string')
    .map((m) => ({ m, area: (knownSize(m.paper, 'width') ?? 0) * (knownSize(m.paper, 'height') ?? 0) }))
    .sort((a, b) => b.area - a.area)[0];
  if (withBg) styles.backgroundColor = withBg.m.clip.node.styles.backgroundColor!;
  const freeform = styles.display === FREEFORM_DISPLAY;
  // El orden original (z-order) se respeta: las capas llegan en orden de árbol.
  for (const m of members) {
    const s = m.clip.node.styles;
    if (freeform && !isAbs(m)) {
      s.left = `${Math.round(m.local!.x)}px`;
      s.top = `${Math.round(m.local!.y)}px`;
    } else if (!isAbs(m)) {
      for (const k of ['left', 'top', 'right', 'bottom']) delete s[k];
    }
    children.push(m.clip);
  }
  // En flujo, el orden visual debe seguir la posición (arriba → abajo / izquierda → derecha);
  // las absolutas mantienen su sitio relativo para no alterar el apilado.
  if (!freeform) {
    const order = new Map((styles.flexDirection === 'row' ? byX : byY).map((m, i) => [m.clip, i]));
    const flowSlots = children.map((c, i) => (order.has(c) ? i : -1)).filter((i) => i >= 0);
    const sortedFlow = flowSlots.map((i) => children[i]!).sort((a, b) => order.get(a)! - order.get(b)!);
    flowSlots.forEach((slot, k) => (children[slot] = sortedFlow[k]!));
  }
  return { node: { id: `rebuilt_${n}`, label: `Pantalla ${n}`, component: 'Frame', styles }, children };
}

function isTokenId(v: unknown): boolean {
  return typeof v === 'string' && /^t:[0-9a-z]+-[0-9a-z]+$/.test(v);
}

function mapComponent(c: string, warnings: string[]): ComponentType {
  if (c === 'Frame' || c === 'Text' || c === 'Rectangle' || c === 'SVG' || c === 'SVGVisualElement') return c;
  if (c === 'SVGPlaceholder') return 'Frame';
  warnings.push(`Componente "${c}" no soportado en Moki: se importa como Frame`);
  return 'Frame';
}

/** Color de Paper → CSS (hex, oklch, var(token) o color-mix para alfa sobre token). */
export function colorToCss(c: PaperColor | undefined | null, tokenMap: Map<string, string>): string | null {
  if (c === undefined || c === null) return null;
  if (typeof c === 'string') {
    if (isTokenId(c)) {
      const m = tokenMap.get(c);
      return m ? `var(${m})` : null;
    }
    return c;
  }
  if ('type' in c && c.type === 'alpha') {
    const base = colorToCss(c.base, tokenMap);
    if (!base) return null;
    const a = typeof c.alpha === 'number' ? c.alpha : isTokenId(c.alpha) ? null : parseFloat(String(c.alpha));
    const pct = a === null ? 50 : Math.round(a * 1000) / 10;
    return `color-mix(${base} ${pct}%, transparent)`;
  }
  const v = (c as { value?: PaperColorValue }).value;
  if (!v) return null;
  const color = { ...v, mode: v.mode } as Parameters<typeof formatHex>[0];
  const alpha = v.alpha ?? 1;
  const preferred = (c as { mode?: string }).mode;
  if (preferred === 'oklch' || preferred === 'p3' || preferred === 'oklab') {
    if (v.mode === 'oklch') return `oklch(${round(v.l! * 100)}% ${round(v.c ?? 0, 4)} ${round(v.h ?? 0)}${alpha < 1 ? ` / ${round(alpha * 100)}%` : ''})`;
  }
  return (alpha < 1 ? formatHex8(color) : formatHex(color))?.toUpperCase() ?? null;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

interface MetaCtx {
  colorToCss: (c: PaperColor | undefined) => string | null;
  imageUrls: Map<string, string>;
  mapValue: (v: string) => string;
}

type Fill = {
  type: 'solid' | 'gradient' | 'image';
  isVisible?: boolean;
  color?: PaperColor;
  shape?: 'linear' | 'radial' | 'conic';
  stops?: { color: PaperColor; position: number | string }[];
  angle?: number | string;
  center?: { x: number; y: number };
  imageId?: string;
  sizeX?: string;
  sizeY?: string;
  positionX?: string;
  positionY?: string;
  repeat?: string;
  blendMode?: string;
};

function px(v: unknown): string {
  if (typeof v === 'number') return `${v}px`;
  const s = String(v ?? '0');
  return /^-?\d*\.?\d+$/.test(s) ? `${s}px` : s;
}

function fillToLayer(f: Fill, ctx: MetaCtx): string | null {
  if (f.type === 'solid') {
    const c = ctx.colorToCss(f.color);
    return c ? `linear-gradient(${c}, ${c})` : null;
  }
  if (f.type === 'gradient') {
    const stops = (f.stops ?? [])
      .map((s) => `${ctx.colorToCss(s.color) ?? 'transparent'} ${typeof s.position === 'number' ? `${round(s.position * (s.position <= 1 ? 100 : 1))}%` : s.position}`)
      .join(', ');
    const angle = f.angle !== undefined ? `${parseFloat(String(f.angle))}deg` : '180deg';
    const cx = f.center ? `${round(f.center.x * 100)}% ${round(f.center.y * 100)}%` : '50% 50%';
    if (f.shape === 'radial') return `radial-gradient(circle at ${cx}, ${stops})`;
    if (f.shape === 'conic') return `conic-gradient(from ${angle} at ${cx}, ${stops})`;
    return `linear-gradient(${angle}, ${stops})`;
  }
  if (f.type === 'image' && f.imageId) {
    const url = ctx.imageUrls.get(f.imageId);
    return url ? `url(${url})` : null;
  }
  return null;
}

function applyStyleMeta(p: PaperNode, component: ComponentType, s: Styles, ctx: MetaCtx) {
  const meta = (p.styleMeta ?? {}) as Record<string, unknown>;

  // Relleno. En Text es el color del texto.
  const fills = ((meta.fill as Fill[] | undefined) ?? []).filter((f) => f.isVisible !== false);
  if (fills.length) {
    if (component === 'Text') {
      const solid = fills.length === 1 && fills[0]!.type === 'solid';
      if (solid) s.color = ctx.colorToCss(fills[0]!.color) ?? '#000000';
      else {
        const layers = [...fills].reverse().map((f) => fillToLayer(f, ctx)).filter(Boolean);
        s.backgroundImage = layers.join(', ');
        s.backgroundClip = 'text';
        s.WebkitBackgroundClip = 'text';
        s.color = 'transparent';
      }
    } else if (component !== 'SVG' && component !== 'SVGVisualElement') {
      if (fills.length === 1 && fills[0]!.type === 'solid') {
        const c = ctx.colorToCss(fills[0]!.color);
        if (c) s.backgroundColor = c;
      } else {
        // CSS pinta primero la capa superior; Paper guarda de abajo arriba.
        const ordered = [...fills].reverse();
        const layers = ordered.map((f) => fillToLayer(f, ctx)).filter((x): x is string => !!x);
        if (layers.length) s.backgroundImage = layers.join(', ');
        const imgs = ordered.filter((f) => f.type === 'image');
        if (imgs.length) {
          const sizes = ordered.map((f) => (f.type === 'image' ? imageSize(f) : 'auto'));
          const positions = ordered.map((f) => (f.type === 'image' ? `${f.positionX ?? 'center'} ${f.positionY ?? 'center'}` : '0 0'));
          s.backgroundSize = sizes.join(', ');
          s.backgroundPosition = positions.join(', ');
          s.backgroundRepeat = ordered.map((f) => (f.type === 'image' && f.repeat ? f.repeat : 'no-repeat')).join(', ');
        }
      }
    }
  }

  // Bordes.
  const borders = meta.borders as Record<string, { isVisible?: boolean; width?: string | number; color?: PaperColor; style?: string }> | undefined;
  if (borders) {
    const side = (b: { isVisible?: boolean; width?: string | number; color?: PaperColor; style?: string } | undefined) =>
      b && b.isVisible !== false ? `${ctx.mapValue(px(b.width ?? 1))} ${b.style ?? 'solid'} ${ctx.colorToCss(b.color) ?? 'currentColor'}` : null;
    if (borders.all) {
      const v = side(borders.all);
      if (v) s.border = v;
    }
    for (const [k, prop] of [['top', 'borderTop'], ['right', 'borderRight'], ['bottom', 'borderBottom'], ['left', 'borderLeft']] as const) {
      const v = side(borders[k]);
      if (v) s[prop] = v;
    }
  }

  // Sombras.
  type Shadow = { color?: PaperColor; x?: string | number; y?: string | number; blur?: string | number; spread?: string | number; isVisible?: boolean };
  const shadow = (sh: Shadow, inset: boolean, text: boolean) =>
    `${inset ? 'inset ' : ''}${px(sh.x)} ${px(sh.y)} ${px(sh.blur)}${text ? '' : ` ${px(sh.spread)}`} ${ctx.colorToCss(sh.color) ?? 'rgba(0,0,0,0.25)'}`;
  const outer = ((meta.outerShadow as Shadow[] | undefined) ?? []).filter((x) => x.isVisible !== false);
  const inner = ((meta.innerShadow as Shadow[] | undefined) ?? []).filter((x) => x.isVisible !== false);
  if (component === 'Text' && outer.length) s.textShadow = outer.map((x) => shadow(x, false, true)).join(', ');
  else if (outer.length || inner.length) s.boxShadow = [...outer.map((x) => shadow(x, false, false)), ...inner.map((x) => shadow(x, true, false))].join(', ');

  // Fuente.
  const font = meta.font as { family?: string; weight?: number; isItalic?: boolean } | undefined;
  if (font) {
    if (font.family && s.fontFamily === undefined) s.fontFamily = fontStack(font.family);
    if (font.weight && s.fontWeight === undefined) s.fontWeight = font.weight;
    if (font.isItalic) s.fontStyle = 'italic';
  }

  // Decoración de texto.
  const deco = meta.textDecoration as { line?: string; type?: string; color?: PaperColor; style?: string; thickness?: string | number } | undefined;
  if (deco) {
    const line = deco.line ?? deco.type;
    if (line && line !== 'none') s.textDecorationLine = line;
    if (deco.style) s.textDecorationStyle = deco.style;
    const c = ctx.colorToCss(deco.color);
    if (c) s.textDecorationColor = c;
    if (deco.thickness !== undefined) s.textDecorationThickness = px(deco.thickness);
  }

  // Outline.
  const outline = meta.outline as { isVisible?: boolean; width?: string | number; color?: PaperColor; style?: string; offset?: string | number } | undefined;
  if (outline && outline.isVisible !== false && outline.width !== undefined) {
    s.outline = `${px(outline.width)} ${outline.style ?? 'solid'} ${ctx.colorToCss(outline.color) ?? 'currentColor'}`;
    if (outline.offset !== undefined) s.outlineOffset = px(outline.offset);
  }

  // Filtros (si vienen ya como cadena CSS).
  for (const k of ['filter', 'backdropFilter'] as const) {
    const v = meta[k];
    if (typeof v === 'string' && v) s[k] = ctx.mapValue(v);
  }

  // SVG.
  const svgFill = meta.svgFill as { color?: PaperColor } | undefined;
  if (svgFill?.color !== undefined) {
    const c = ctx.colorToCss(svgFill.color);
    if (c) s.fill = c;
  }
  const svgStroke = meta.svgStroke as { color?: PaperColor; width?: string | number } | undefined;
  if (svgStroke?.color !== undefined) {
    const c = ctx.colorToCss(svgStroke.color);
    if (c) s.stroke = c;
    if (svgStroke.width !== undefined) s.strokeWidth = px(svgStroke.width);
  }

  if (s.display === undefined && component === 'Frame' && (p.styles?.display === FREEFORM_DISPLAY)) s.display = FREEFORM_DISPLAY;
}

function imageSize(f: Fill): string {
  const x = f.sizeX ?? 'cover';
  if (x === 'cover' || x === 'contain' || x === 'auto') return x;
  if (x === 'fill' || x === 'stretch') return '100% 100%';
  return `${x} ${f.sizeY ?? 'auto'}`;
}

function fontStack(family: string): string {
  if (family === 'System Sans-Serif') return 'system-ui, sans-serif';
  if (family === 'System Serif') return 'ui-serif, serif';
  if (family === 'System Monospace') return 'ui-monospace, monospace';
  if (GENERIC.test(family)) return family;
  return `"${family.replace(/"/g, '')}", system-ui, sans-serif`;
}

function serializeSvgTree(el: SvgElementTree): string {
  if (el.type === 'text') return escapeXml(el.value ?? '');
  const attrs = Object.entries(el.attributes ?? {})
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('');
  const kids = (el.children ?? []).map(serializeSvgTree).join('');
  return `<${el.name}${attrs}>${kids || escapeXml(el.value ?? '')}</${el.name}>`;
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Claves de orden consecutivas (utilidad para el pegado). */
export const nextKeys = (n: number) => {
  const out: string[] = [];
  let k: string | null = null;
  for (let i = 0; i < n; i++) out.push((k = keyBetween(k, null)));
  return out;
};
