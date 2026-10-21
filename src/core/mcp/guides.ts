// Guías que sirve la herramienta `get_guide`. Redactadas para agentes, en inglés.

export const BUNDLED_FONT_FAMILIES = [
  'Inter', 'Geist', 'Geist Mono', 'Roboto', 'Manrope', 'DM Sans', 'Space Grotesk', 'IBM Plex Sans',
  'Outfit', 'Work Sans', 'Bricolage Grotesque', 'Playfair Display', 'Fraunces', 'Source Serif 4',
  'JetBrains Mono', 'Instrument Serif', 'Montserrat', 'Source Sans 3', 'Pixelify Sans',
];

const MAIN = `# Designing with Moki

Moki turns HTML with inline styles into layers on a live canvas. The user watches you work in real time, so work like a careful designer sitting next to them: small, deliberate steps, frequent visual checks, no big-bang rewrites.

## 1. Mandatory brief (before the first mutation)

Before you create or change anything in a new design, post a short brief in the chat:
1. Three candidate mood words, each tied to a physical scene (e.g. "harbor at dawn", "library reading room", "citrus market stall"). Pick one and say why. Distrust your first idea — the first mood that comes to mind is usually the most generic one.
2. A palette of 5–6 hex colors with roles (background, surface, text, muted text, accent, optional secondary accent), every color taken from objects in that scene.
3. Typography: families (check them with get_font_family_info) and a type scale (e.g. 56 / 32 / 20 / 16 / 13 px) with weights.
4. Layout direction in one or two sentences: grid, density, where the one strong color moment goes.

Skip the brief only when the user provides a design system or is asking for a small edit.

## 2. Design quality

- Restraint with a human touch: few elements, each with a purpose; one or two details that feel hand-made rather than templated.
- Spacing is a design tool. Vary it on purpose: tight within a group, generous between groups. Avoid one uniform gap everywhere.
- Use contrast of scale and asymmetry: a big headline next to small, quiet metadata reads more confidently than everything at medium size.
- Typography in the spirit of Swiss editorial design: strong weight contrast (e.g. 700 headline vs 400 body), tight tracking on large sizes (-0.02em to -0.04em), comfortable line-height on body (1.4–1.6 × font size, expressed in px).
- Default to light mode unless the context calls for dark.
- Put information directly on surfaces. Do not wrap every piece of content in a card with a shadow and a border.
- Avoid tired late-2010s tropes: purple-to-blue gradients, glassmorphism everywhere, floating 3D blobs, giant drop shadows, emoji as icons.
- When the brief calls for joy or a brand with personality, a playful register is welcome: several accent colors, sticker-like shapes, offset hard shadows, hand-drawn-looking strokes. When asked for several directions, make them genuinely different, not color swaps.

## 3. Color method

- Start from the mood word and its scene; every color should be something you could point at in that scene.
- One intense color moment per screen. Everything else supports it.
- Neutrals: pure white is the usual base. Warm off-whites only when the mood really is warm/paper-like. Greys should come from the scene or be true neutral greys — avoid accidental blue-grey.
- Secondary accents: sparingly, for status or data.
- Text contrast is non-negotiable: body text at least 4.5:1 against its background, large text 3:1.
- Avoid text at 12 px or smaller except in dense UIs (tables, toolbars, metadata).

Pairings that tend to work (background → accent): white → vermilion; warm paper → deep forest green; near-black → acid yellow; pale sky → ink navy; sand → terracotta; cool grey → electric orange.
Pairings to avoid (overused lately): dark navy → neon cyan; lavender → violet gradients; black → purple glow; beige → sage green everywhere.

## 4. Content

Use realistic content: real-sounding names, prices, dates, numbers and sentences that fit the product. No lorem ipsum. If the design needs to mention design software, mention Moki.

## 5. Alignment rails

In repeated rows (lists, menus, tables, settings), every row must share the same vertical rails. Give leading icons/avatars and trailing actions/values fixed-width slots with flexShrink: 0, and let the middle column flex. Verify with a screenshot that columns line up.

## 6. Workflow

1. get_basic_info first: pages, artboards, sizes, fonts and tokens. Typical artboard widths: 1440 (desktop), 375 (mobile). Mobile artboards start with a status bar (get_guide "mobile-status-bar").
2. Pages: pass pageId to work on a page the user is not viewing. The page list may contain dividers and decorative icons.
3. Reuse the file's existing tokens via var(--token-name) in styles. To create a token set, use Tailwind v4 theme namespaces: --color-*, --font-*, --text-*, --font-weight-*, --tracking-*, --leading-*, --spacing-*, --radius-*, --opacity-*, --breakpoint-*, --container-*. For a token with transparency use color-mix(var(--color-x) 40%, transparent).
4. Every tool result for a file starts with a header {"file":{"id","name"},"contentHash":{"tokens":…}}. Use it to confirm you are in the right file; if the tokens hash changed since you last looked, re-read tokens before using them.
5. Read with get_selection, get_tree_summary, get_children, get_node_info. Use get_screenshot at scale 1 for layout and scale 2 only for fine detail.
6. Never show node IDs to the user.

### Creating a new design
- Brief → create_artboard → build in small pieces with write_html: one visual group per call, roughly 15 lines of HTML at most. The user sees each piece appear.
- After each section, get_screenshot and review it against this checklist: spacing rhythm, typography hierarchy, contrast, alignment to rails, content fitting the artboard, no accidental repetition. Summarize in one line ("Hero: OK" / "Hero: CTA too close to subtitle, fixing"). Fix with targeted edits (update_styles, set_text_content, move_nodes); do not delete and start over.
- If content overflows the artboard, set the artboard height to "fit-content".
- To repeat a structure, duplicate_nodes and tweak the copies, or use <x-moki-clone node-id="…" style="…"></x-moki-clone> inside write_html (deep copy of an existing node with style overrides on the copy root).
- SVG icons accept tokens in fill and stroke.
- Finish with finish_working_on_nodes.

### HTML that works well
- Inline style="" only. No <style> blocks, no class names, no external CSS.
- Flexbox for layout (display:flex, flexDirection, gap, padding, alignItems, justifyContent). Avoid margins (use gap), display:inline, CSS grid and tables.
- Sizes in px; width:"100%" or flex:1 to fill; fit-content to hug.
- box-sizing is always border-box.
- layer-name="Header" names a layer. Text is plain: one text node = one style (no rich text inside a single text layer).
- <img src> accepts http(s) URLs, data: URLs and local asset URLs; the image becomes a background fill. Use object-fit to control cropping.

### Editing an existing design
- Restructure with move_nodes (before/after/parentId) rather than deleting and rewriting.
- Use find_nodes to locate all usages of a color, token, font or text before changing them.
- update_styles reports ignoredStyles when a property has no effect in that context (e.g. flex-child props in a non-flex parent) — adjust instead of retrying blindly.
- Finish with finish_working_on_nodes.

### Components (reuse instead of copy)
- Anything that repeats (buttons, inputs, list rows, cards, tab bars, nav bars) should be a component: build it once, create_component on its frame (keep mains on a page named "Components"), then place it with create_instance or <x-moki-instance component-id="…" style="…"></x-moki-instance> inside write_html.
- Editing the main component (update_styles, set_text_content, write_html inside it) updates every instance. list_components shows what already exists — check it before building a new button.
- Instance children have virtual IDs "<instanceId>::<mainChildId>" (see get_tree_summary). update_styles / set_text_content on them write per-instance overrides (e.g. a different label or color); delete_nodes hides them in that instance only. You cannot add, move or rename layers inside an instance: edit the main, or detach_instance first. reset_overrides restores an instance (or one of its layers) to the main.
- Component variants: make one main per variant (e.g. "Button / Primary", "Button / Secondary").

### Exporting to code
- get_jsx (inline styles or Tailwind), get_computed_styles and get_fill_image give exact values. Screenshots are only for visual verification.
- Adapt the output to the conventions of the user's codebase; pass includeNodeIds: false for clean code.

## 7. Text

- Prefer the font families already used in the file.
- Call get_font_family_info before your first typographic styling in a session. Bundled families (always available, offline): ${BUNDLED_FONT_FAMILIES.join(', ')}. Generic families (system-ui, sans-serif, serif, monospace) also work.
- Units: px for font-size, em for letter-spacing, px for line-height.
`;

const STATUS_BAR = `# Mobile status bar

Mobile artboards (375 px wide) should begin with a status bar, unless the screen is a full-bleed experience (video player, camera, splash). Paste this as the first child of the artboard. Do not alter it except for the color: it is white by default; on light backgrounds change every "#FFFFFF" to "#000000".

\`\`\`html
<div layer-name="Status Bar" style="display:flex;align-items:center;justify-content:space-between;width:100%;height:54px;padding:0 28px 0 34px;flex-shrink:0;color:#FFFFFF">
  <div layer-name="Time" style="font-family:Inter;font-size:17px;font-weight:600;letter-spacing:-0.01em;line-height:22px;color:#FFFFFF">9:41</div>
  <div layer-name="Indicators" style="display:flex;align-items:center;gap:6px">
    <svg layer-name="Signal" width="18" height="12" viewBox="0 0 18 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="8" width="3" height="4" rx="1" fill="#FFFFFF"/>
      <rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="#FFFFFF"/>
      <rect x="10" y="3" width="3" height="9" rx="1" fill="#FFFFFF"/>
      <rect x="15" y="0" width="3" height="12" rx="1" fill="#FFFFFF"/>
    </svg>
    <svg layer-name="Wi-Fi" width="16" height="12" viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.2-1.3C13.3 1.5 10.8.4 8 .4S2.7 1.5.8 3.3L2 4.6c1.6-1.5 3.7-2.4 6-2.4Z" fill="#FFFFFF"/>
      <path d="M8 5.6c1.4 0 2.6.5 3.6 1.4l1.2-1.3C11.5 4.5 9.8 3.8 8 3.8s-3.5.7-4.8 1.9L4.4 7c1-.9 2.2-1.4 3.6-1.4Z" fill="#FFFFFF"/>
      <path d="M8 9c.6 0 1.1.2 1.5.6L8 11.4 6.5 9.6C6.9 9.2 7.4 9 8 9Z" fill="#FFFFFF"/>
    </svg>
    <svg layer-name="Battery" width="27" height="13" viewBox="0 0 27 13" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="#FFFFFF" stroke-opacity="0.4"/>
      <rect x="2" y="2" width="20" height="9" rx="2" fill="#FFFFFF"/>
      <path d="M25 4.5v4c.8-.3 1.5-1.1 1.5-2s-.7-1.7-1.5-2Z" fill="#FFFFFF" fill-opacity="0.4"/>
    </svg>
  </div>
</div>
\`\`\`
`;

const FIGMA_IMPORT = `# Bringing a Figma design into Moki

write_html only understands literal CSS values. Figma tools usually hand you code full of variables, utility classes and placeholders, so translate everything before writing.

## Workflow
1. Read the Figma frame with the Figma tools (design context / code, screenshot and variable definitions).
2. Resolve every design token, variable and utility class to a literal value:
   - colors → hex / rgb literals (or var(--token) only if you first created the matching Moki token);
   - sizes → px values, or the equivalent flex properties (fill → flex:1 or width:100%, hug → fit-content);
   - typography → font-family, font-size (px), font-weight, line-height (px), letter-spacing (em);
   - spacing → padding / gap in px.
3. Images: put the asset URL directly in <img src="…"> or background-image:url(…). Asset URLs served by the Figma MCP on localhost are fine.
4. Vectors: use the exact SVG markup from Figma. Never replace an icon or illustration with an approximation.
5. Tiled backgrounds: a div with background-image and background-repeat.
6. Build in sections (one write_html per visual group), screenshot each section and compare it against the Figma screenshot.
7. Figma instance IDs that contain ";" refer to nested instances — use the last segment.

## Checklist before each write_html
- No var(--…) that does not exist in Moki, no class names, no Tailwind utilities.
- Every element that needs a size has one (px, %, fit-content or flex).
- No leftover token names or placeholder text.
- All images and SVGs are inlined or referenced by URL.
`;

export const GUIDES: Record<string, string> = {
  'moki-mcp-instructions': MAIN,
  'mobile-status-bar': STATUS_BAR,
  'figma-import': FIGMA_IMPORT,
};

export const GUIDE_TOPICS: { topic: string; summary: string }[] = [
  { topic: 'moki-mcp-instructions', summary: 'How to design well with Moki: brief, quality, color, workflow, tokens, code export' },
  { topic: 'mobile-status-bar', summary: 'Paste-ready status bar markup for mobile artboards' },
  { topic: 'figma-import', summary: 'Workflow for bringing Figma designs into Moki' },
];

/** Texto de la guía, o un mensaje (no error) con los topics disponibles. */
export function guideText(topic: string): string {
  const g = GUIDES[topic];
  if (g) return g;
  return `Unknown guide topic "${topic}". Available topics:\n${GUIDE_TOPICS.map((t) => `- "${t.topic}" — ${t.summary}`).join('\n')}`;
}
