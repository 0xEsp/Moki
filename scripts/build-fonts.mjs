// Genera public/fonts/{fonts.css,catalog.json} + copia los woff2 (subsets latin y latin-ext)
// desde los paquetes @fontsource. Las familias se exponen con su nombre "limpio" (Inter, no
// "Inter Variable") para que el HTML de los agentes funcione tal cual.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'public', 'fonts');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'files'), { recursive: true });

const SUBSETS = new Set(['latin', 'latin-ext']);

/** [paquete, nombre limpio, ficheros css a leer, categoría] */
const FAMILIES = [
  ['@fontsource-variable/montserrat', 'Montserrat', ['wght.css', 'wght-italic.css'], 'sans-serif'],
  ['@fontsource-variable/source-sans-3', 'Source Sans 3', ['wght.css', 'wght-italic.css'], 'sans-serif'],
  ['@fontsource-variable/pixelify-sans', 'Pixelify Sans', ['wght.css'], 'display'],
  ['@fontsource-variable/inter', 'Inter', ['wght.css', 'wght-italic.css'], 'sans-serif'],
  ['@fontsource-variable/geist', 'Geist', ['wght.css', 'wght-italic.css'], 'sans-serif'],
  ['@fontsource-variable/geist-mono', 'Geist Mono', ['wght.css', 'wght-italic.css'], 'monospace'],
  ['@fontsource-variable/roboto', 'Roboto', ['wght.css', 'wght-italic.css'], 'sans-serif'],
  ['@fontsource-variable/manrope', 'Manrope', ['wght.css'], 'sans-serif'],
  ['@fontsource-variable/dm-sans', 'DM Sans', ['wght.css', 'wght-italic.css'], 'sans-serif'],
  ['@fontsource-variable/space-grotesk', 'Space Grotesk', ['wght.css'], 'sans-serif'],
  ['@fontsource-variable/ibm-plex-sans', 'IBM Plex Sans', ['wght.css', 'wght-italic.css'], 'sans-serif'],
  ['@fontsource-variable/outfit', 'Outfit', ['wght.css'], 'sans-serif'],
  ['@fontsource-variable/work-sans', 'Work Sans', ['wght.css', 'wght-italic.css'], 'sans-serif'],
  ['@fontsource-variable/bricolage-grotesque', 'Bricolage Grotesque', ['wght.css'], 'sans-serif'],
  ['@fontsource-variable/playfair-display', 'Playfair Display', ['wght.css', 'wght-italic.css'], 'serif'],
  ['@fontsource-variable/fraunces', 'Fraunces', ['wght.css', 'wght-italic.css'], 'serif'],
  ['@fontsource-variable/source-serif-4', 'Source Serif 4', ['wght.css', 'wght-italic.css'], 'serif'],
  ['@fontsource-variable/jetbrains-mono', 'JetBrains Mono', ['wght.css', 'wght-italic.css'], 'monospace'],
  ['@fontsource/instrument-serif', 'Instrument Serif', ['latin-400.css', 'latin-400-italic.css', 'latin-ext-400.css', 'latin-ext-400-italic.css'], 'serif'],
];

let css = '/* Generado por scripts/build-fonts.mjs — no editar */\n';
const catalog = { families: [] };

for (const [pkg, name, files, category] of FAMILIES) {
  const dir = path.join(nm, pkg);
  if (!fs.existsSync(dir)) { console.warn('falta', pkg); continue; }
  const styles = new Map();
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const blocks = src.match(/\/\*[^*]*\*\/\s*@font-face\s*{[^}]*}|@font-face\s*{[^}]*}/g) ?? [];
    for (const block of blocks) {
      const subset = /\/\*\s*[^*]*?-(latin(?:-ext)?)-[^*]*\*\//.exec(block)?.[1]
        ?? /\/\*\s*([a-z-]+)\s*\*\//.exec(block)?.[1];
      const urlMatch = /url\(([^)]+\.woff2)\)/.exec(block);
      if (!urlMatch) continue;
      const rel = urlMatch[1].replace(/['"]/g, '');
      const base = path.basename(rel);
      const isLatin = /-latin-(?!ext)|-latin\./.test(base) || /latin-ext/.test(base);
      if (!isLatin && !(subset && SUBSETS.has(subset))) continue;
      if (/cyrillic|greek|vietnamese|math|symbols/.test(base)) continue;
      fs.copyFileSync(path.join(dir, rel.replace(/^\.\//, '')), path.join(out, 'files', base));
      const weight = /font-weight:\s*([^;]+);/.exec(block)?.[1].trim() ?? '400';
      const style = /font-style:\s*([^;]+);/.exec(block)?.[1].trim() ?? 'normal';
      const unicode = /unicode-range:\s*([^;]+);/.exec(block)?.[1].trim();
      css += `@font-face{font-family:'${name}';font-style:${style};font-display:block;font-weight:${weight};src:url(./files/${base}) format('woff2');${unicode ? `unicode-range:${unicode};` : ''}}\n`;
      const [wMin, wMax] = weight.split(/\s+/).map(Number);
      const key = style;
      const prev = styles.get(key);
      styles.set(key, { min: Math.min(prev?.min ?? 1000, wMin), max: Math.max(prev?.max ?? 0, wMax ?? wMin) });
    }
  }
  const variable = [...styles.values()].some((s) => s.max !== s.min);
  catalog.families.push({
    family: name,
    category,
    source: 'bundled',
    variable,
    styles: [...styles.entries()].map(([style, r]) => ({ isItalic: style === 'italic', minWeight: r.min, maxWeight: r.max })),
  });
}

fs.writeFileSync(path.join(out, 'fonts.css'), css);
fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(catalog, null, 2));
console.log(`fuentes: ${catalog.families.length} familias, ${fs.readdirSync(path.join(out, 'files')).length} ficheros`);
