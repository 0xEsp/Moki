import { describe, expect, it } from 'vitest';
import { createEmptyFile } from '../../../core/new-file';
import { DocStore } from '../../state/doc-store';
import { findPlacement } from '../placement';
import { matchNode, styleNameMatches, colorKey, wildcardMatch } from '../find-nodes';
import { computeAgentStyles, inertKeys } from '../apply-css';
import { generateJsx } from '../jsx';
import { stylesToTailwind } from '../tailwind';
import { readingOrder, truncateText } from '../handlers';
import { serializeSvgNode } from '../svg-export';

const ROOT = 'root_node_p-1-0';

function makeDoc() {
  const doc = new DocStore(createEmptyFile('Test'), 0);
  return doc;
}

describe('placement', () => {
  it('empty page → origin', () => {
    expect(findPlacement({ obstacles: [], width: 100, height: 100 })).toEqual({ x: 0, y: 0 });
  });
  it('places to the right of an obstacle with 80px gap', () => {
    const p = findPlacement({ obstacles: [{ x: 0, y: 0, width: 1440, height: 900 }], width: 375, height: 812 });
    expect(p).toEqual({ x: 1520, y: 0 });
  });
  it('never overlaps', () => {
    const obstacles = [
      { x: 0, y: 0, width: 500, height: 500 },
      { x: 580, y: 0, width: 500, height: 500 },
      { x: 0, y: 580, width: 500, height: 500 },
    ];
    const p = findPlacement({ obstacles, width: 400, height: 400 });
    for (const o of obstacles) {
      const overlap = p.x < o.x + o.width + 80 && o.x - 80 < p.x + 400 && p.y < o.y + o.height + 80 && o.y - 80 < p.y + 400;
      expect(overlap).toBe(false);
    }
  });
  it('anchor prefers right of the anchor', () => {
    const a = { x: 100, y: 100, width: 300, height: 300 };
    expect(findPlacement({ obstacles: [a], width: 300, height: 300, anchor: a })).toEqual({ x: 480, y: 100 });
  });
  it('centers in empty visible area', () => {
    const p = findPlacement({ obstacles: [], width: 200, height: 100, visibleArea: { x: 0, y: 0, width: 1000, height: 800 } });
    expect(p).toEqual({ x: 400, y: 350 });
  });
});

describe('find-nodes matcher', () => {
  it('wildcards', () => {
    expect(wildcardMatch('foo*', 'FooBar')).toBe(true);
    expect(wildcardMatch('*bar', 'foobar')).toBe(true);
    expect(wildcardMatch('foo', 'foobar')).toBe(false);
  });
  it('families and slots', () => {
    expect(styleNameMatches('padding', 'paddingTop')).toBe(true);
    expect(styleNameMatches('padding-top', 'padding')).toBe(true);
    expect(styleNameMatches('paddingTop', 'paddingLeft')).toBe(false);
    expect(styleNameMatches('radius', 'borderTopLeftRadius')).toBe(true);
    expect(styleNameMatches('borderColor', 'border')).toBe(true);
    expect(styleNameMatches('borderTopColor', 'borderBottomWidth')).toBe(false);
    expect(styleNameMatches('width', 'inlineSize')).toBe(true);
  });
  it('color equivalence, composite values and tokens', () => {
    const doc = makeDoc();
    const tid = doc.createToken({ type: 'color', name: 'color-ink', value: '#111111' });
    const a = doc.createNode('Frame', ROOT, { styles: { backgroundColor: 'white', border: '1px solid #ff0000' } });
    const b = doc.createNode('Frame', ROOT, { styles: { backgroundImage: 'linear-gradient(#fff, rgb(255 0 0))' } });
    const t = doc.createNode('Text', a, { styles: { color: `var(${tid})` }, textValue: 'Hello world' });
    expect(colorKey('#fff')).toBe(colorKey('white'));
    const m1 = matchNode(doc.data, doc.node(a)!, { filters: [{ styleName: 'background-color', styleValue: '#FFF' }] });
    expect(m1).toEqual([{ styleName: 'backgroundColor', styleValue: 'white' }]);
    const m2 = matchNode(doc.data, doc.node(a)!, { filters: [{ styleValue: 'red' }] });
    expect(m2).toEqual([{ styleName: 'border', styleValue: '#ff0000' }]);
    const m3 = matchNode(doc.data, doc.node(b)!, { filters: [{ styleName: 'background', styleValue: 'red' }] });
    expect(m3?.[0]).toMatchObject({ styleName: 'backgroundImage', styleValue: 'rgb(255 0 0)' });
    const m4 = matchNode(doc.data, doc.node(t)!, { filters: [{ styleValue: '#111' }] });
    expect(m4).toEqual([{ styleName: 'color', styleValue: 'var(--color-ink)' }]);
    const m5 = matchNode(doc.data, doc.node(t)!, { filters: [{ styleValue: 'var(--color-*)' }] });
    expect(m5).toEqual([{ styleName: 'color', styleValue: 'var(--color-ink)' }]);
    const m6 = matchNode(doc.data, doc.node(t)!, { textValue: '*world' });
    expect(m6).toEqual([{ textValue: 'Hello world' }]);
    expect(matchNode(doc.data, doc.node(a)!, { textValue: '*' })).toBeNull();
  });
  it('font family lists', () => {
    const doc = makeDoc();
    const t = doc.createNode('Text', ROOT, { styles: { fontFamily: '"Space Grotesk", sans-serif' }, textValue: 'x' });
    expect(matchNode(doc.data, doc.node(t)!, { filters: [{ styleName: 'fontFamily', styleValue: 'space grotesk' }] })).toEqual([
      { styleName: 'fontFamily', styleValue: 'Space Grotesk' },
    ]);
  });
});

describe('apply-css', () => {
  it('strips inert styles and reports only passed ones', () => {
    const doc = makeDoc();
    const ab = doc.createNode('Frame', ROOT, { styles: { display: 'flex' } });
    const box = doc.createNode('Frame', ab, { styles: {} });
    const { styles, ignoredStyles } = computeAgentStyles(doc.data, {}, { gap: '8px', flexGrow: 1, zIndex: 3, color: 'red' }, { node: doc.node(box)!, parent: doc.node(ab) });
    expect(styles).toEqual({ flexGrow: 1, zIndex: 3, color: 'red' });
    expect(ignoredStyles).toEqual(['gap']);
  });
  it('flex child props in block parent are inert', () => {
    const keys = inertKeys({ flexGrow: 1, alignSelf: 'center' }, { node: { component: 'Frame', id: 'a' }, parent: { id: 'b', styles: {} } });
    expect(keys.sort()).toEqual(['alignSelf', 'flexGrow']);
  });
  it('converts token references and merges shorthands', () => {
    const doc = makeDoc();
    const id = doc.createToken({ type: 'spacing', name: 'space-4', value: 16 });
    const { styles } = computeAgentStyles(doc.data, { paddingTop: '4px', display: 'flex' }, { padding: 'var(--space-4)', 'row-gap': '2px' }, { node: { component: 'Frame', id: 'x' }, parent: null });
    expect(styles).toEqual({ display: 'flex', padding: `var(${id})`, rowGap: '2px' });
  });
});

describe('jsx', () => {
  it('generates inline-style JSX with defaults stripped', () => {
    const doc = makeDoc();
    const ab = doc.createNode('Frame', ROOT, { label: 'Card', styles: { left: '0px', top: '0px', width: '320px', height: '200px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px', backgroundColor: '#fff' } });
    doc.createNode('Text', ab, { styles: { fontSize: '16px', fontWeight: '400', color: '#111' }, textValue: 'Hello {world} <3\nsecond  line' });
    const jsx = generateJsx(doc, ab, { includeNodeIds: false });
    expect(jsx).toContain("flexDirection: 'column'");
    expect(jsx).not.toContain('position');
    expect(jsx).not.toContain("width: '320px'"); // artboard sin hijos dependientes del tamaño
    expect(jsx).toContain("{'{'}world{'}'} &lt;3<br />");
    expect(jsx).toContain("second{'  '}line");
    expect(jsx).not.toContain('fontWeight');
    expect(jsx).toContain("whiteSpace: 'pre-wrap'");
    expect(jsx.startsWith('<div style={{')).toBe(true);
  });
  it('tailwind format', () => {
    const doc = makeDoc();
    const ab = doc.createNode('Frame', ROOT, { styles: { left: '0px', top: '0px', display: 'flex', gap: '12px', padding: '16px 24px', backgroundColor: '#ffffff', borderRadius: '8px' } });
    const jsx = generateJsx(doc, ab, { format: 'tailwind', includeNodeIds: true });
    expect(jsx).toContain(`id="${ab}"`);
    expect(jsx).toContain('className="');
    expect(jsx).toContain('flex');
    expect(jsx).toContain('gap-3');
    expect(jsx).toContain('py-4 px-6');
    expect(jsx).toContain('bg-white');
    expect(jsx).toContain('rounded-[8px]');
  });
});

describe('tailwind mapping', () => {
  it('maps common properties', () => {
    const { classes, rest } = stylesToTailwind({ color: 'white', fontSize: '14px', fontWeight: '600', width: '100%', height: '13px', letterSpacing: '-0.02em', fontFamily: 'Space Grotesk', mixBlendMode: 'multiply', boxSizing: 'border-box' });
    expect(classes).toEqual(['text-white', 'text-[14px]', 'font-semibold', 'w-full', 'h-[13px]', 'tracking-[-0.02em]', "font-['Space_Grotesk']", '[mix-blend-mode:multiply]']);
    expect(rest).toEqual({});
  });
});

describe('misc', () => {
  it('reading order rows', () => {
    const items = [
      { id: 'c', r: { x: 0, y: 1000, width: 100, height: 100 } },
      { id: 'b', r: { x: 500, y: 10, width: 100, height: 100 } },
      { id: 'a', r: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    expect(readingOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
  it('truncate text', () => {
    expect(truncateText('abcdef', 3)).toEqual({ text: 'abc... [truncated]', truncated: true });
  });
  it('svg export', () => {
    const doc = makeDoc();
    const svg = doc.createNode('SVG', ROOT, { styles: { width: '24px', height: '24px', left: '0px', top: '0px' }, attrs: { viewBox: '0 0 24 24' } });
    doc.createNode('SVGVisualElement', svg, { tag: 'path', attrs: { d: 'M0 0L24 24', 'stroke-width': '2' }, styles: { stroke: '#000' } });
    const out = serializeSvgNode(doc, svg);
    expect(out).toContain('<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="24" height="24"');
    expect(out).toContain('<path d="M0 0L24 24" stroke-width="2" style="stroke:#000"/>');
  });
});
