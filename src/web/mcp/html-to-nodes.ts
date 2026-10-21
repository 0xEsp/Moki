import { toJS } from 'mobx';
import { mergeStyles, parseStyleAttribute, pxValue, splitCssValue } from '../../core/css';
import { externalToInternal } from '../../core/tokens';
import { FREEFORM_DISPLAY, type ComponentType, type MokiFile, type Styles, type TreeNode } from '../../core/types';
import { isRootId } from '../../core/tree';
import type { DocStore } from '../state/doc-store';

// HTML (con estilos inline) → árboles de nodos de diseño.
// Solo se leen estilos inline. El layout lo hará el navegador al pintar; aquí solo se decide
// la estructura (Frame / Text / Rectangle / SVG) y se resuelve la tipografía heredada.

/** ¿Es ya un asset servido por este Moki? */
function isOwnAsset(u: string): boolean {
  try {
    const url = new URL(u, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith('/file-assets/');
  } catch {
    return false;
  }
}

export interface NodeSpec {
  component: ComponentType;
  label?: string;
  labelIsModified?: boolean;
  styles: Styles;
  textValue?: string;
  tag?: string;
  attrs?: Record<string, string>;
  isVisible?: boolean;
  isLocked?: boolean;
  svgNonRendered?: string;
  isComponent?: true;
  instanceOf?: string;
  overrides?: TreeNode['overrides'];
}

export interface ParsedTree {
  node: NodeSpec;
  children: ParsedTree[];
}

export interface ImportedImage {
  url: string;
  width?: number;
  height?: number;
}

export interface HtmlParseContext {
  doc: DocStore;
  /** Padre en el que se insertarán los árboles (para herencia y contexto de layout). */
  insertionParentId: string;
  importImage: (src: string) => Promise<ImportedImage>;
}

export interface HtmlParseResult {
  trees: ParsedTree[];
  notes: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------

const VOID_TAGS = 'area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr';
const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'title', 'template', 'noscript', 'head', 'base']);
const INLINE_TAGS = new Set(['span', 'a', 'strong', 'em', 'b', 'i', 'u', 'label', 'button', 'input', 'select', 'textarea', 'svg', 'img', 'code', 'small', 'mark', 's', 'sub', 'sup', 'abbr', 'cite', 'q', 'del', 'ins', 'kbd', 'var', 'time', 'font']);
const INLINE_BLOCK_DEFAULT = new Set(['span', 'a', 'strong', 'em', 'b', 'i', 'u', 'label', 'button', 'input', 'select', 'textarea', 'svg']);
const SIMPLE_INLINE = new Set(['span', 'a', 'strong', 'em', 'b', 'i', 'u', 'code', 'small', 'mark', 's', 'sub', 'sup', 'abbr', 'cite', 'q', 'del', 'ins', 'kbd', 'var', 'time', 'font', 'label']);
const TEXTY_PROPS = new Set([
  'color', 'fontWeight', 'fontStyle', 'fontFamily', 'fontSize', 'letterSpacing', 'textTransform', 'lineHeight',
  'textDecoration', 'textDecorationLine', 'textDecorationColor', 'textDecorationStyle', 'fontVariant', 'display',
]);

/** Propiedades tipográficas que heredan los Text. */
const INHERITED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'color', 'textAlign',
  'textTransform', 'whiteSpace', 'textWrap', 'textShadow', 'WebkitTextStroke', 'WebkitTextStrokeWidth',
  'WebkitTextStrokeColor', 'fontVariant', 'wordBreak', 'overflowWrap', 'textIndent', 'fontStretch',
  'fontFeatureSettings', 'fontVariationSettings', 'textDecoration', 'textDecorationLine', 'textDecorationColor',
  'textDecorationStyle', 'textDecorationThickness', 'textUnderlineOffset', 'WebkitTextFillColor', 'fontKerning',
  'hyphens', 'direction',
];

const SVG_VISUAL = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g', 'text', 'use', 'image', 'foreignObject']);

const DEFAULT_FONT_FAMILY = 'Inter';
const DEFAULT_FONT_SIZE = '16px';
const DEFAULT_COLOR = '#000000';

type Inherited = Record<string, string>;

interface Ctx {
  inherited: Inherited;
  parentDisplay: string | undefined;
  /** Hay un ancestro con white-space nowrap/pre. */
  pre: boolean;
}

/** Árbol intermedio con información de contexto para los post-procesos. */
interface IR extends ParsedTree {
  children: IR[];
  /** Para reubicar absolutos: este nodo es bloque contenedor de absolutos. */
  positioned: boolean;
  /** Bloque contenedor de fixed (transform, filter…). */
  fixedContainer: boolean;
  /** El elemento era fixed (se convierte a absolute). */
  wasFixed?: boolean;
}

// ---------------------------------------------------------------------------

export function presanitize(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  const re = new RegExp(`<(?!(?:${VOID_TAGS})\\b)([a-zA-Z][\\w:-]*)((?:\\s+[^<>]*?)?)\\s*\\/>`, 'g');
  s = s.replace(re, '<$1$2></$1>');
  return s;
}

export async function htmlToNodes(html: string, pctx: HtmlParseContext): Promise<HtmlParseResult> {
  const notes: string[] = [];
  const errors: string[] = [];
  const parsed = new DOMParser().parseFromString(`<!doctype html><html><body>${presanitize(html)}</body></html>`, 'text/html');
  const body = parsed.body;
  transformDom(body);

  const file = pctx.doc.data;
  const imageJobs: Promise<void>[] = [];
  const failedImages: string[] = [];

  const parentNode = pctx.doc.node(pctx.insertionParentId);
  const initialInherited: Inherited = {};
  // Herencia desde el padre de inserción y sus ancestros (el más cercano gana).
  for (const id of [...pctx.doc.ancestors(pctx.insertionParentId)].reverse().concat(pctx.insertionParentId)) {
    const n = pctx.doc.node(id);
    if (!n) continue;
    for (const k of INHERITED) if (n.styles[k] !== undefined) initialInherited[k] = String(n.styles[k]);
  }
  const ctx0: Ctx = {
    inherited: initialInherited,
    parentDisplay: parentNode ? (isRootId(parentNode.id) ? FREEFORM_DISPLAY : String(parentNode.styles.display ?? '')) : undefined,
    pre: /^(pre|nowrap|pre-wrap|pre-line)$/.test(initialInherited.whiteSpace ?? ''),
  };

  // ------------------------------------------------------------------ helpers

  const toInternal = (styles: Styles): Styles => {
    const out: Styles = {};
    for (const [k, v] of Object.entries(styles)) out[k] = typeof v === 'string' ? externalToInternal(file, v) : v;
    return out;
  };

  const readStyles = (el: Element): Styles => {
    const raw = parseStyleAttribute(el.getAttribute('style') ?? '');
    const expanded: Styles = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'font') Object.assign(expanded, expandFont(String(v)));
      else expanded[k] = v;
    }
    // `background: <color>` → backgroundColor (el panel de Relleno y find_nodes trabajan con él).
    if (typeof expanded.background === 'string' && !/url\(|gradient\(|\s/.test(expanded.background.trim().replace(/\s*\/\s*/g, '/').replace(/\([^)]*\)/g, '()'))) {
      if (expanded.backgroundColor === undefined) expanded.backgroundColor = expanded.background;
      delete expanded.background;
    }
    return toInternal(mergeStyles({}, expanded));
  };

  const childInherited = (inh: Inherited, styles: Styles): Inherited => {
    const out = { ...inh };
    for (const k of INHERITED) if (styles[k] !== undefined) out[k] = String(styles[k]);
    return out;
  };

  /** Estilos tipográficos resueltos para un Text. */
  const textStyles = (own: Styles, inh: Inherited): Styles => {
    const s: Styles = {};
    for (const k of INHERITED) {
      if (own[k] !== undefined) continue;
      if (inh[k] !== undefined) s[k] = inh[k]!;
    }
    if (own.fontFamily === undefined && s.fontFamily === undefined) s.fontFamily = DEFAULT_FONT_FAMILY;
    if (own.fontSize === undefined && s.fontSize === undefined) s.fontSize = DEFAULT_FONT_SIZE;
    if (own.color === undefined && s.color === undefined && own.WebkitTextFillColor === undefined) s.color = DEFAULT_COLOR;
    return { ...s, ...own };
  };

  const labelFor = (el: Element): { label?: string; labelIsModified?: boolean } => {
    const ln = el.getAttribute('layer-name');
    if (ln) return { label: truncateLabel(ln), labelIsModified: true };
    const def = el.getAttribute('data-moki-default-name') ?? (el.tagName.toLowerCase() === 'button' ? 'Button' : null);
    if (def) return { label: def };
    return {};
  };

  const textLabel = (t: string) => {
    const one = t.replace(/\s+/g, ' ').trim();
    return one.length > 40 ? one.slice(0, 40) + '…' : one || undefined;
  };

  const makeIR = (node: NodeSpec, children: IR[] = []): IR => {
    const pos = String(node.styles.position ?? '');
    return {
      node,
      children,
      positioned: pos === 'relative' || pos === 'absolute' || pos === 'fixed' || pos === 'sticky' || node.styles.transform !== undefined || node.styles.display === FREEFORM_DISPLAY,
      fixedContainer: ['transform', 'filter', 'perspective', 'contain', 'willChange', 'backdropFilter'].some((k) => node.styles[k] !== undefined && node.styles[k] !== 'none'),
    };
  };

  // ------------------------------------------------------------------ texto

  const collapse = (s: string, pre: boolean) => (pre ? s : s.replace(/[ \t\n\r\f]+/g, ' '));

  /** ¿El elemento es un inline simple aplanable (solo tipografía y contenido simple)? */
  const isSimpleInline = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return true;
    if (!SIMPLE_INLINE.has(tag)) return false;
    const st = parseStyleAttribute(el.getAttribute('style') ?? '');
    for (const k of Object.keys(st)) if (!TEXTY_PROPS.has(k)) return false;
    if (st.display && st.display !== 'inline') return false;
    if (el.hasAttribute('layer-name')) return false;
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === Node.ELEMENT_NODE && !isSimpleInline(c as Element)) return false;
    }
    return true;
  };

  /** Aplana nodos (texto + inlines simples + br) a un texto con color dominante. */
  const flatten = (nodes: ChildNode[], inh: Inherited, pre: boolean): { text: string; color?: string } => {
    const counts = new Map<string, number>();
    let text = '';
    const walk = (n: ChildNode, color: string | undefined, pre2: boolean) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = collapse(n.textContent ?? '', pre2);
        text += t;
        if (color) counts.set(color, (counts.get(color) ?? 0) + t.trim().length);
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const el = n as Element;
      if (el.tagName.toLowerCase() === 'br') {
        text += '\n';
        return;
      }
      const st = parseStyleAttribute(el.getAttribute('style') ?? '');
      const c = st.color !== undefined ? externalToInternal(file, String(st.color)) : color;
      const p = pre2 || /^(pre|pre-wrap|pre-line)$/.test(String(st.whiteSpace ?? ''));
      for (const k of Array.from(el.childNodes)) walk(k, c, p);
    };
    for (const n of nodes) walk(n, inh.color, pre);
    if (!pre) {
      text = text
        .split('\n')
        .map((l) => l.replace(/ {2,}/g, ' ').trim())
        .join('\n');
      text = text.replace(/\n+$/, (m) => (m.length > 1 ? m.slice(1) : '')); // un <br> final no cuenta
    }
    let best: string | undefined;
    let bestN = -1;
    for (const [c, n] of counts) if (n > bestN) [best, bestN] = [c, n];
    return { text, color: best };
  };

  // ------------------------------------------------------------------ elementos

  const processChildren = (el: Element, ownStyles: Styles, ctx: Ctx, display: string | undefined): IR[] => {
    const out: IR[] = [];
    const kids = Array.from(el.childNodes).filter(
      (c) => c.nodeType === Node.TEXT_NODE || (c.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has((c as Element).tagName.toLowerCase())),
    );
    const isFlexGrid = /flex|grid/.test(display ?? '');
    const inheritedHere = childInherited(ctx.inherited, ownStyles);
    const pre = ctx.pre || /^(pre|pre-wrap|pre-line|nowrap)$/.test(String(ownStyles.whiteSpace ?? ''));
    const preWs = ctx.pre || /^(pre|pre-wrap|pre-line)$/.test(String(ownStyles.whiteSpace ?? ''));
    const childCtx: Ctx = { inherited: inheritedHere, parentDisplay: display, pre };
    const hasComplex = kids.some((k) => k.nodeType === Node.ELEMENT_NODE && !isSimpleInline(k as Element));

    let run: ChildNode[] = [];
    const flushRun = () => {
      if (run.length === 0) return;
      const { text, color } = flatten(run, inheritedHere, preWs);
      run = [];
      if (text.trim() === '' && !text.includes('\n')) {
        // Espacio entre inlines: se añade al texto anterior.
        if (text.length > 0 && out.length > 0) {
          const prev = out[out.length - 1]!;
          if (prev.node.component === 'Text' && prev.node.textValue !== undefined && !prev.node.textValue.endsWith(' ')) prev.node.textValue += ' ';
        }
        return;
      }
      const t = text;
      const st = textStyles(color ? { color } : {}, inheritedHere);
      // Hereda background-clip:text del padre.
      if (/text/.test(String(ownStyles.backgroundClip ?? ownStyles.WebkitBackgroundClip ?? ''))) {
        for (const k of ['backgroundImage', 'background', 'backgroundClip', 'WebkitBackgroundClip', 'WebkitTextFillColor', 'backgroundSize', 'backgroundPosition']) {
          if (ownStyles[k] !== undefined) st[k] = ownStyles[k]!;
        }
        if (st.WebkitTextFillColor === undefined) st.WebkitTextFillColor = 'transparent';
      }
      if (hasComplex && !isFlexGrid) st.display = 'inline-block';
      out.push(makeIR({ component: 'Text', styles: st, textValue: t, label: textLabel(t) }));
    };

    for (const k of kids) {
      if (k.nodeType === Node.TEXT_NODE || (k.nodeType === Node.ELEMENT_NODE && isSimpleInline(k as Element) && !(isFlexGrid && (k as Element).tagName.toLowerCase() === 'br'))) {
        if (isFlexGrid && k.nodeType === Node.ELEMENT_NODE) {
          // En flex/grid cada inline es un ítem propio.
          flushRun();
          const ir = processElement(k as Element, childCtx);
          if (ir) out.push(...ir);
          continue;
        }
        if (isFlexGrid && k.nodeType === Node.TEXT_NODE) {
          flushRun();
          run.push(k);
          flushRun();
          continue;
        }
        run.push(k);
        continue;
      }
      flushRun();
      const tag = (k as Element).tagName.toLowerCase();
      if (tag === 'br') {
        // Línea vacía en flex/grid.
        out.push(makeIR({ component: 'Text', styles: { ...textStyles({}, inheritedHere), display: 'block' }, textValue: '' }));
        continue;
      }
      const ir = processElement(k as Element, childCtx);
      if (ir) out.push(...ir);
    }
    flushRun();
    return out;
  };

  const processElement = (el: Element, ctx: Ctx): IR[] | null => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;

    if (tag === 'x-moki-clone' || tag === 'x-paper-clone') {
      const srcId = el.getAttribute('node-id');
      const src = srcId ? pctx.doc.node(srcId) : undefined;
      if (!src || !srcId) return null;
      const tree = cloneSpec(pctx.doc, srcId);
      const overrides = readStyles(el);
      tree.node.styles = mergeStyles(tree.node.styles, overrides);
      const ln = el.getAttribute('layer-name');
      if (ln) Object.assign(tree.node, { label: truncateLabel(ln), labelIsModified: true });
      return [toIR(tree)];
    }

    if (tag === 'x-moki-instance') {
      const mainId = el.getAttribute('component-id') ?? el.getAttribute('node-id');
      const main = mainId ? pctx.doc.node(mainId) : undefined;
      if (!mainId || !main?.isComponent) {
        errors.push(`<x-moki-instance>: ${mainId ?? '(no component-id)'} is not a main component`);
        return null;
      }
      const ln = el.getAttribute('layer-name');
      const node: NodeSpec = {
        component: 'Frame',
        styles: readStyles(el),
        label: ln ? truncateLabel(ln) : main.label,
        labelIsModified: !!ln,
        instanceOf: mainId,
      };
      return [makeIR(node)];
    }

    if (tag === 'svg') return [parseSvg(el, ctx)];

    let styles = readStyles(el);
    const { label, labelIsModified } = labelFor(el);
    let isVisible: boolean | undefined;
    if (el.hasAttribute('hidden') || styles.display === 'none') {
      isVisible = false;
      delete styles.display;
    }
    const pos = String(styles.position ?? '');
    if (pos === '' || pos === 'static' || pos === 'sticky') {
      for (const k of ['top', 'left', 'right', 'bottom', 'inset']) delete styles[k];
      if (pos === 'sticky' || pos === 'static') delete styles.position;
    }
    for (const k of ['boxSizing', 'WebkitFontSmoothing', 'MozOsxFontSmoothing', 'textSizeAdjust', 'WebkitTextSizeAdjust', 'textRendering']) delete styles[k];
    if (styles.display === 'list-item') delete styles.display;
    // Inline → inline-block (salvo en flex/grid, donde todo hijo es ya un ítem de bloque).
    if (styles.display === undefined && INLINE_BLOCK_DEFAULT.has(tag) && !/flex|grid/.test(ctx.parentDisplay ?? '')) styles.display = 'inline-block';
    if (tag === 'button' && styles.display === 'block') styles.alignContent = 'center';
    // width:min-content en contexto nowrap → max-content.
    if (styles.width === 'min-content' && (ctx.inherited.whiteSpace === 'nowrap' || styles.whiteSpace === 'nowrap')) styles.width = 'max-content';
    const wasFixed = styles.position === 'fixed';
    if (wasFixed) styles.position = 'absolute';
    const isLocked = el.hasAttribute('data-moki-locked') || el.hasAttribute('data-paper-locked') ? true : undefined;
    const display = styles.display !== undefined ? String(styles.display) : undefined;

    if (tag === 'img') {
      const node: NodeSpec = { component: 'Rectangle', styles, label: label ?? 'Image', labelIsModified, isVisible, isLocked };
      applyImage(el as HTMLImageElement, node);
      const ir = makeIR(node);
      ir.wasFixed = wasFixed;
      return [ir];
    }

    const childNodes = Array.from(el.childNodes).filter(
      (c) => (c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').length > 0) || (c.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has((c as Element).tagName.toLowerCase())),
    );
    const meaningful = childNodes.filter((c) => c.nodeType === Node.ELEMENT_NODE || (c.textContent ?? '').trim() !== '');
    const markedText = el.getAttribute('data-moki-component') === 'Text' || el.getAttribute('data-paper-component') === 'Text';
    const forceRect = el.getAttribute('data-moki-node') === 'Rectangle' || el.getAttribute('paper-node') === 'Rectangle';

    // ¿Solo texto + inlines simples? → aplanar.
    const allSimple = meaningful.length > 0 && childNodes.every((c) => c.nodeType === Node.TEXT_NODE || isSimpleInline(c as Element));
    const pieces = meaningful.length;
    const isFlexGrid = /flex|grid/.test(display ?? '');
    const onlyText = meaningful.length > 0 && meaningful.every((c) => c.nodeType === Node.TEXT_NODE);
    if (!forceRect && allSimple && (onlyText || pieces >= 2 || markedText || !isFlexGrid)) {
      const inhHere = childInherited(ctx.inherited, styles);
      const preWs = ctx.pre || /^(pre|pre-wrap|pre-line)$/.test(String(styles.whiteSpace ?? ''));
      const { text, color } = flatten(childNodes, inhHere, preWs);
      const t = preWs ? text : text.trim();
      if (t !== '' || text.includes('\n')) {
        const hasBg = ['background', 'backgroundColor', 'backgroundImage'].some((k) => styles[k] !== undefined) && !/text/.test(String(styles.backgroundClip ?? styles.WebkitBackgroundClip ?? ''));
        const nowrapWithWidth = styles.whiteSpace === 'nowrap' && styles.width !== undefined;
        if (!hasBg && !nowrapWithWidth) {
          const own = { ...styles };
          if (color && own.color === undefined) own.color = color;
          else if (color && color !== own.color) own.color = color;
          const st = textStyles(own, ctx.inherited);
          const ir = makeIR({ component: 'Text', styles: st, textValue: t, label: label ?? textLabel(t), labelIsModified, isVisible, isLocked });
          ir.wasFixed = wasFixed;
          return [ir];
        }
      }
    }

    const children = forceRect ? [] : processChildren(el, styles, ctx, display);
    const component: ComponentType = forceRect ? 'Rectangle' : children.length > 0 || el.hasAttribute('layer-name') ? 'Frame' : 'Rectangle';
    // Un Frame que contenía solo texto-hijo heredado mueve el background-clip:text al hijo.
    if (children.some((c) => c.node.styles.WebkitTextFillColor === 'transparent') && /text/.test(String(styles.backgroundClip ?? styles.WebkitBackgroundClip ?? ''))) {
      for (const k of ['backgroundImage', 'background', 'backgroundClip', 'WebkitBackgroundClip', 'WebkitTextFillColor', 'backgroundSize', 'backgroundPosition']) delete styles[k];
    }
    const ir = makeIR({ component, styles, label, labelIsModified, isVisible, isLocked }, children);
    ir.wasFixed = wasFixed;
    return [ir];
  };

  // ------------------------------------------------------------------ imágenes

  const applyImage = (img: HTMLImageElement, node: NodeSpec) => {
    const src = img.getAttribute('src') ?? '';
    const s = node.styles;
    const fit = String(s.objectFit ?? 'fill');
    delete s.objectFit;
    const size = fit === 'fill' ? '100% 100%' : fit === 'none' ? 'auto' : fit === 'scale-down' ? 'contain' : fit;
    s.backgroundSize = size;
    s.backgroundPosition = s.objectPosition !== undefined ? String(s.objectPosition) : 'center';
    delete s.objectPosition;
    s.backgroundRepeat = 'no-repeat';
    if (s.display === 'inline-block') delete s.display;
    const attrW = img.getAttribute('width');
    const attrH = img.getAttribute('height');
    if (s.width === undefined && attrW && /^\d+(\.\d+)?$/.test(attrW)) s.width = `${attrW}px`;
    if (s.height === undefined && attrH && /^\d+(\.\d+)?$/.test(attrH)) s.height = `${attrH}px`;
    if (!src) return;
    imageJobs.push(
      pctx
        .importImage(src)
        .then((res) => {
          s.backgroundImage = `url(${res.url})`;
          if (res.width && res.height) {
            const hasW = s.width !== undefined;
            const hasH = s.height !== undefined;
            if (!hasW && !hasH) {
              s.width = `${res.width}px`;
              s.height = `${res.height}px`;
              s.aspectRatio = `${res.width} / ${res.height}`;
            } else if (hasW !== hasH) {
              s.aspectRatio = `${res.width} / ${res.height}`;
            }
          }
        })
        .catch((e: unknown) => {
          failedImages.push(`${src.slice(0, 120)}: ${e instanceof Error ? e.message : String(e)}`);
        }),
    );
  };

  // ------------------------------------------------------------------ SVG

  const SVG_PRESENTATION_ATTRS = new Set([
    'fill', 'stroke', 'color', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-width',
    'stop-color', 'stop-opacity', 'flood-color', 'lighting-color',
  ]);

  const parseSvg = (svg: Element, ctx: Ctx): IR => {
    const styles = readStyles(svg);
    const attrs: Record<string, string> = {};
    for (const a of Array.from(svg.attributes)) {
      if (['style', 'layer-name', 'xmlns', 'class', 'data-moki-locked'].includes(a.name) || a.name.startsWith('xmlns:')) continue;
      attrs[a.name] = a.value;
    }
    // width/height de atributos → estilos (px).
    for (const dim of ['width', 'height'] as const) {
      const v = attrs[dim];
      if (v !== undefined && styles[dim] === undefined) {
        styles[dim] = /^\d+(\.\d+)?$/.test(v) ? `${v}px` : v;
      }
      delete attrs[dim];
    }
    if (styles.width === undefined && styles.height === undefined && attrs.viewBox) {
      const vb = attrs.viewBox.split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb.every(Number.isFinite)) {
        styles.width = `${vb[2]}px`;
        styles.height = `${vb[3]}px`;
      }
    }
    if (styles.display === undefined && !/flex|grid/.test(ctx.parentDisplay ?? '')) styles.display = 'inline-block';
    if (styles.overflow === undefined) styles.overflow = 'visible';
    const usesCurrent = svg.outerHTML.includes('currentColor');
    if (usesCurrent && styles.color === undefined && ctx.inherited.color) styles.color = ctx.inherited.color;
    const nonRendered: string[] = [];
    const children: IR[] = [];
    const walk = (parent: Element, out: IR[]) => {
      for (const c of Array.from(parent.children)) {
        const tag = c.tagName.toLowerCase();
        const ctag = c.tagName; // conserva mayúsculas de SVG (linearGradient…)
        if (!SVG_VISUAL.has(tag) && !SVG_VISUAL.has(ctag)) {
          nonRendered.push(c.outerHTML);
          continue;
        }
        const st = readStyles(c);
        const at: Record<string, string> = {};
        for (const a of Array.from(c.attributes)) {
          if (a.name === 'style' || a.name === 'layer-name') continue;
          // Los atributos de presentación no resuelven var(): con un token pasan a ser estilo.
          if (a.value.includes('var(') && SVG_PRESENTATION_ATTRS.has(a.name)) {
            const prop = a.name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
            if (st[prop] === undefined) st[prop] = externalToInternal(file, a.value);
            continue;
          }
          at[a.name] = a.value;
        }
        const node: NodeSpec = { component: 'SVGVisualElement', tag: ctag, styles: st, attrs: at, ...labelFor(c) };
        if (!node.label) node.label = svgLabel(tag);
        if (tag === 'text') node.textValue = c.textContent ?? '';
        const ir = makeIR(node);
        if (tag === 'g') walk(c, ir.children);
        out.push(ir);
      }
    };
    walk(svg, children);
    const { label, labelIsModified } = labelFor(svg);
    const node: NodeSpec = { component: 'SVG', styles, attrs, label: label ?? 'SVG', labelIsModified };
    if (nonRendered.length) node.svgNonRendered = nonRendered.join('');
    if (svg.hasAttribute('data-moki-locked')) node.isLocked = true;
    return makeIR(node, children);
  };

  // ------------------------------------------------------------------ recorrido

  let roots: IR[] = [];
  for (const c of Array.from(body.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) {
      const t = collapse(c.textContent ?? '', ctx0.pre).trim();
      if (t) roots.push(makeIR({ component: 'Text', styles: textStyles({}, ctx0.inherited), textValue: t, label: textLabel(t) }));
      continue;
    }
    if (c.nodeType !== Node.ELEMENT_NODE) continue;
    const ir = processElement(c as Element, ctx0);
    if (ir) roots.push(...ir);
  }

  // Fondos con url() remota o data: → se importan al almacén local (el diseño no debe depender
  // de que esa URL siga viva ni de tener red).
  const localizeBackgrounds = (irs: IR[]) => {
    for (const ir of irs) {
      const st = ir.node.styles;
      for (const prop of ['backgroundImage', 'background'] as const) {
        const v = st[prop];
        if (typeof v !== 'string' || !/url\(/.test(v)) continue;
        const urls = [...v.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]!).filter((u) => /^(https?:|data:)/i.test(u) && !isOwnAsset(u));
        for (const u of new Set(urls)) {
          imageJobs.push(
            pctx
              .importImage(u)
              .then((res) => {
                st[prop] = String(st[prop]).split(u).join(res.url);
              })
              .catch((e: unknown) => {
                failedImages.push(`${u.slice(0, 120)}: ${e instanceof Error ? e.message : String(e)}`);
              }),
          );
        }
      }
      localizeBackgrounds(ir.children);
    }
  };
  localizeBackgrounds(roots);

  await Promise.all(imageJobs);
  if (failedImages.length === 1) errors.push(`Failed to load image ${failedImages[0]}`);
  else if (failedImages.length > 1) errors.push(`Failed to load ${failedImages.length} images: ${failedImages.slice(0, 5).join('; ')}`);

  // ------------------------------------------------------------------ post-procesos
  roots = relocateAbsolutes(roots);
  for (const r of roots) postProcess(r, ctx0.parentDisplay);
  roots = reorderByZ(roots, false);
  roots = roots.filter((r) => !shouldPrune(r, ctx0.parentDisplay));

  return { trees: roots, notes, errors };
}

function svgLabel(tag: string) {
  const names: Record<string, string> = { path: 'Path', rect: 'Rectangle', circle: 'Ellipse', ellipse: 'Ellipse', line: 'Line', polyline: 'Polyline', polygon: 'Polygon', g: 'Group', text: 'Text', use: 'Use', image: 'Image' };
  return names[tag] ?? 'Shape';
}

export function truncateLabel(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// ---------------------------------------------------------------------------
// Transformaciones del DOM previas al recorrido (formularios, fieldset, cajas, centrados).

function setStyle(el: Element, styles: Styles) {
  el.setAttribute(
    'style',
    Object.entries(styles)
      .map(([k, v]) => `${k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
      .join(';'),
  );
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'number', 'tel', 'url', 'date', 'time', 'datetime-local', 'month', 'week']);

function transformDom(body: HTMLElement) {
  const doc = body.ownerDocument;

  // Formularios
  for (const el of Array.from(body.querySelectorAll('input, textarea, select'))) {
    const tag = el.tagName.toLowerCase();
    const st = parseStyleAttribute(el.getAttribute('style') ?? '');
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      if (st.appearance === 'none' || st.WebkitAppearance === 'none') {
        const d = doc.createElement('div');
        copyAttrs(el, d);
        el.replaceWith(d);
        continue;
      }
      const checked = el.hasAttribute('checked');
      const accent = String(st.accentColor ?? '#2563EB');
      const box = doc.createElement('div');
      copyAttrs(el, box);
      box.setAttribute('data-moki-default-name', type === 'checkbox' ? 'Checkbox' : 'Radio');
      const base: Styles = {
        width: '13px', height: '13px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '3px 3px 3px 4px', borderRadius: type === 'radio' ? '50%' : '2px',
        backgroundColor: checked ? accent : '#FFFFFF',
        border: checked ? `1px solid ${accent}` : '1px solid #8F8F8F',
      };
      delete st.accentColor;
      setStyle(box, { ...base, ...st });
      if (checked) {
        const mark = doc.createElement('div');
        mark.setAttribute('layer-name', type === 'checkbox' ? 'Check' : 'Dot');
        setStyle(
          mark,
          type === 'checkbox'
            ? { width: '3px', height: '7px', borderRight: '2px solid #FFFFFF', borderBottom: '2px solid #FFFFFF', rotate: '45deg', marginTop: '-2px' }
            : { width: '5px', height: '5px', borderRadius: '50%', backgroundColor: '#FFFFFF' },
        );
        box.appendChild(mark);
      }
      el.replaceWith(box);
      continue;
    }
    if (tag === 'input' && !TEXT_INPUT_TYPES.has(type) && type !== 'submit' && type !== 'button') continue;
    let value = '';
    let isPlaceholder = false;
    if (tag === 'select') {
      const sel = (el.querySelector('option[selected]') ?? el.querySelector('option')) as HTMLOptionElement | null;
      value = sel?.textContent?.trim() ?? '';
    } else if (tag === 'textarea') {
      value = el.textContent ?? '';
    } else {
      value = el.getAttribute('value') ?? '';
    }
    if (!value) {
      const ph = el.getAttribute('placeholder') ?? '';
      if (ph) {
        value = ph;
        isPlaceholder = true;
      }
    }
    if (tag === 'input' && type === 'password' && !isPlaceholder) value = '•'.repeat(value.length);
    const box = doc.createElement('div');
    copyAttrs(el, box);
    box.setAttribute('data-moki-default-name', tag === 'select' ? 'Select' : tag === 'textarea' ? 'Text Area' : type === 'submit' || type === 'button' ? 'Button' : 'Input');
    const boxStyles: Styles = { display: 'flex', ...(tag === 'textarea' ? {} : { alignItems: 'center' }), ...st };
    setStyle(box, boxStyles);
    const text = doc.createElement('div');
    text.setAttribute('data-moki-component', 'Text');
    const phStyles = el.getAttribute('data-moki-placeholder-styles') ?? el.getAttribute('data-paper-placeholder-styles');
    const textStyles: Styles = {
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: tag === 'textarea' ? 'pre-wrap' : 'nowrap', flexGrow: 1, minWidth: '0px',
      ...(isPlaceholder ? (phStyles ? parseStyleAttribute(phStyles) : { opacity: 0.5 }) : {}),
    };
    if (!value) textStyles.minHeight = '1lh';
    setStyle(text, textStyles);
    text.textContent = value;
    box.appendChild(text);
    el.replaceWith(box);
  }

  // fieldset / legend
  for (const fs of Array.from(body.querySelectorAll('fieldset'))) {
    const st = parseStyleAttribute(fs.getAttribute('style') ?? '');
    const layoutKeys = ['display', 'flexDirection', 'flexWrap', 'gap', 'rowGap', 'columnGap', 'alignItems', 'justifyContent', 'alignContent'];
    const inner: Styles = {};
    for (const k of layoutKeys) if (st[k] !== undefined) {
      inner[k] = st[k]!;
      delete st[k];
    }
    const outer = doc.createElement('div');
    copyAttrs(fs, outer);
    setStyle(outer, { ...st, display: 'flex', flexDirection: 'column' });
    if (!fs.hasAttribute('layer-name')) outer.setAttribute('data-moki-default-name', 'Fieldset');
    const legend = fs.querySelector(':scope > legend');
    const content = doc.createElement('div');
    content.setAttribute('layer-name', 'Fieldset Content');
    setStyle(content, inner);
    for (const c of Array.from(fs.childNodes)) if (c !== legend) content.appendChild(c);
    if (legend) {
      const lg = doc.createElement('div');
      copyAttrs(legend, lg);
      for (const c of Array.from(legend.childNodes)) lg.appendChild(c);
      outer.appendChild(lg);
    }
    outer.appendChild(content);
    fs.replaceWith(outer);
  }

  for (const el of Array.from(body.querySelectorAll('[style]'))) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const st = parseStyleAttribute(el.getAttribute('style') ?? '');
    let changed = false;
    // content-box → border-box
    if (st.boxSizing === 'content-box') {
      const box = mergeStyles({}, st);
      const side = (k: string) => pxValue(box[k] as string | undefined) ?? 0;
      const bw = (s: string) => pxValue(box[`border${s}Width`] as string | undefined) ?? borderWidthFrom(box[`border${s}`] ?? box.border);
      const w = pxValue(st.width as string | undefined);
      if (w !== null) {
        st.width = `${w + side('paddingLeft') + side('paddingRight') + bw('Left') + bw('Right')}px`;
      }
      const h = pxValue(st.height as string | undefined);
      if (h !== null) {
        st.height = `${h + side('paddingTop') + side('paddingBottom') + bw('Top') + bw('Bottom')}px`;
      }
      delete st.boxSizing;
      changed = true;
    }
    // Absolutos centrados con márgenes auto.
    if (st.position === 'absolute' || st.position === 'fixed') {
      const m = mergeStyles({}, st);
      const tr: string[] = ['0', '0'];
      let centered = false;
      if (m.marginLeft === 'auto' && m.marginRight === 'auto' && st.width !== undefined && (m.left ?? '0') === (m.right ?? '0')) {
        st.left = '50%';
        delete st.right;
        tr[0] = '-50%';
        centered = true;
        delete m.marginLeft;
        delete m.marginRight;
      }
      if (m.marginTop === 'auto' && m.marginBottom === 'auto' && st.height !== undefined && (m.top ?? '0') === (m.bottom ?? '0')) {
        st.top = '50%';
        delete st.bottom;
        tr[1] = '-50%';
        centered = true;
        delete m.marginTop;
        delete m.marginBottom;
      }
      if (centered) {
        delete st.margin;
        for (const k of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft']) {
          if (m[k] !== undefined) st[k] = m[k]!;
          else delete st[k];
        }
        delete st.inset;
        st.translate = `${tr[0]} ${tr[1]}`;
        changed = true;
      }
    }
    if (changed) setStyle(el, st);
  }
}

function borderWidthFrom(v: unknown): number {
  if (v === undefined) return 0;
  for (const p of splitCssValue(String(v))) {
    const n = pxValue(p);
    if (n !== null) return n;
  }
  return 0;
}

function copyAttrs(from: Element, to: Element) {
  for (const a of Array.from(from.attributes)) {
    if (['type', 'value', 'placeholder', 'checked', 'name', 'id', 'for'].includes(a.name)) continue;
    to.setAttribute(a.name, a.value);
  }
}

/** Expande el shorthand `font` a longhands (aproximado). */
export function expandFont(v: string): Styles {
  const out: Styles = {};
  const parts = splitCssValue(v);
  let i = 0;
  for (; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === 'italic' || p === 'oblique') out.fontStyle = p;
    else if (/^(bold|bolder|lighter|[1-9]00)$/.test(p)) out.fontWeight = p;
    else if (p === 'normal' || p === 'small-caps') continue;
    else break;
  }
  const sizePart = parts[i];
  if (sizePart) {
    const [size, lh] = sizePart.split('/');
    out.fontSize = size!;
    if (lh) out.lineHeight = lh;
    i++;
  }
  if (parts[i] === '/' && parts[i + 1]) {
    out.lineHeight = parts[i + 1]!;
    i += 2;
  }
  const fam = parts.slice(i).join(' ');
  if (fam) out.fontFamily = fam;
  return out;
}

// ---------------------------------------------------------------------------
// Clonado de un nodo existente como spec (ids nuevos al insertar).

export function cloneSpec(doc: DocStore, id: string): ParsedTree {
  // Un nodo dentro de una instancia se copia como nodo normal (con sus overrides aplicados);
  // una instancia se copia como instancia (sin hijos: vienen del main).
  const virtual = doc.isVirtual(id);
  const n = virtual ? doc.node(id)! : doc.data.nodes[id]!;
  const snap = toJS(n) as TreeNode;
  const { id: _id, ['~']: _del, ...rest } = snap;
  void _id;
  void _del;
  if (!rest.instanceOf) delete rest.overrides;
  const kids = rest.instanceOf ? [] : virtual ? doc.childIds(id) : doc.realChildIds(id);
  return {
    node: rest as NodeSpec,
    children: kids.map((c) => cloneSpec(doc, c)),
  };
}

function toIR(t: ParsedTree): IR {
  const ir: IR = {
    node: t.node,
    children: t.children.map(toIR),
    positioned: true,
    fixedContainer: false,
  };
  return ir;
}

// ---------------------------------------------------------------------------
// Post-procesos

const isAbs = (s: Styles) => s.position === 'absolute' || s.position === 'fixed';

/** Reubica absolutos en su bloque contenedor y fixed en su contenedor de fixed. */
function relocateAbsolutes(roots: IR[]): IR[] {
  const moves: { child: IR; from: IR; target: IR | null }[] = [];
  const visit = (node: IR, ancestors: IR[]) => {
    const chain = [node, ...ancestors];
    for (const child of node.children) {
      let target: IR | null = node;
      if (child.wasFixed) target = chain.find((a) => a.fixedContainer) ?? null;
      else if (isAbs(child.node.styles)) target = chain.find((a) => a.positioned) ?? null;
      if (target !== node) moves.push({ child, from: node, target });
      visit(child, chain);
    }
  };
  for (const r of roots) visit(r, []);
  const top = [...roots];
  for (const m of moves) {
    m.from.children = m.from.children.filter((c) => c !== m.child);
    (m.target ? m.target.children : top).push(m.child);
  }
  return top;
}

function postProcess(ir: IR, parentDisplay: string | undefined) {
  const s = ir.node.styles;
  for (const c of ir.children) postProcess(c, String(s.display ?? ''));
  const kids = ir.children;
  // Bloque cuyos hijos son todos absolutos → contenedor libre.
  if (ir.node.component === 'Frame' && (s.display === undefined || s.display === 'block') && kids.length > 0 && kids.every((k) => isAbs(k.node.styles))) {
    s.display = FREEFORM_DISPLAY;
    for (const k of kids) delete k.node.styles.position;
  }
  // Márgenes uniformes entre hermanos flex sin gap → gap.
  if (/flex/.test(String(s.display ?? '')) && s.gap === undefined && s.rowGap === undefined && s.columnGap === undefined) {
    const flow = kids.filter((k) => !isAbs(k.node.styles));
    const column = /column/.test(String(s.flexDirection ?? ''));
    const nowrap = !/wrap/.test(String(s.flexWrap ?? ''));
    if (flow.length >= 2 && nowrap) {
      const after = column ? 'marginBottom' : 'marginRight';
      const before = column ? 'marginTop' : 'marginLeft';
      const vAfter = flow.slice(0, -1).map((k) => k.node.styles[after]);
      const vBefore = flow.slice(1).map((k) => k.node.styles[before]);
      const uniform = (vals: unknown[]) => vals.length > 0 && vals[0] !== undefined && vals[0] !== 'auto' && vals.every((v) => v === vals[0]);
      if (uniform(vAfter) && flow.every((k, i) => i === flow.length - 1 || k.node.styles[before] === undefined) && flow[flow.length - 1]!.node.styles[after] === undefined) {
        s.gap = vAfter[0] as string;
        for (const k of flow) delete k.node.styles[after];
      } else if (uniform(vBefore) && flow[0]!.node.styles[before] === undefined && flow.every((k) => k.node.styles[after] === undefined)) {
        s.gap = vBefore[0] as string;
        for (const k of flow) delete k.node.styles[before];
      }
    }
  }
  ir.children = reorderByZ(ir.children, true).filter((k) => !shouldPrune(k, String(s.display ?? '')));
  void parentDisplay;
}

/** Reordena hijos para que el orden refleje el z-index (los de flujo conservan su orden). */
function reorderByZ(kids: IR[], _nested: boolean): IR[] {
  const z = (k: IR) => {
    const v = k.node.styles.zIndex;
    return v === undefined || v === 'auto' ? null : Number(v);
  };
  if (!kids.some((k) => z(k) !== null)) return kids;
  const flow = kids.filter((k) => !isAbs(k.node.styles));
  const abs = kids.filter((k) => isAbs(k.node.styles));
  const neg = abs.filter((k) => (z(k) ?? 0) < 0).sort((a, b) => z(a)! - z(b)!);
  const pos = abs.filter((k) => (z(k) ?? 0) >= 0).sort((a, b) => (z(a) ?? 0) - (z(b) ?? 0));
  const flowHasZ = flow.some((k) => z(k) !== null);
  if (!flowHasZ) for (const k of pos) delete k.node.styles.zIndex;
  return [...neg, ...flow, ...pos];
}

function shouldPrune(ir: IR, parentDisplay: string | undefined): boolean {
  const s = ir.node.styles;
  const abs = isAbs(s) || parentDisplay === FREEFORM_DISPLAY;
  if (isAbs(s)) {
    if (s.opacity !== undefined && Number(s.opacity) === 0) return true;
    if (s.visibility === 'hidden') return true;
    const w = pxValue(s.width as string | undefined);
    const h = pxValue(s.height as string | undefined);
    const clips = /hidden|clip/.test(String(s.overflow ?? ''));
    if (clips && ((w !== null && w <= 1) || (h !== null && h <= 1))) return true;
  }
  const empty =
    ir.children.length === 0 &&
    !ir.node.instanceOf &&
    (ir.node.component === 'Frame' || ir.node.component === 'Rectangle') &&
    !ir.node.attrs &&
    Object.keys(s).filter((k) => k !== 'position' && k !== 'display').length === 0 &&
    !ir.node.labelIsModified;
  if (empty && (abs || !/flex|grid/.test(parentDisplay ?? ''))) return true;
  return false;
}

export type { MokiFile };
