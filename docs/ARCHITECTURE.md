# Moki — Architecture

Moki is a **local, dockerizable, agent-first** design tool. The design is **real DOM**
(HTML + CSS): every document node is an HTML/SVG element with inline styles, the browser computes
the layout and the editor measures the result. An MCP server lets agents (Claude Code, Cursor…)
read and design on the canvas while the user watches it live.

Based on a private clean-room behavioral study of Paper (v0.5.16), not included in this
repository. It contains no Paper code.

## 1. Overview

```
Agent (Claude Code, Cursor…)
   │ MCP Streamable HTTP  http://127.0.0.1:7410/mcp      (or stdio via bin/moki-mcp.mjs)
   ▼
┌──────────────────────────── Node server (src/server) ──────────────────────────────┐
│ HTTP: /api/*, /file-assets/*, static files (dist/)                                  │
│ WS  : /sync/<fileId>?kind=human|runtime   (LWW sync hub + presence + RPC)           │
│ MCP : /mcp  → tools/list from src/core/mcp/tools.ts                                 │
│        tools/call → scope "app": resolved on the server                             │
│                     scope "file": page.evaluate(window.mokiRuntime.handleToolCall)   │
│ Headless Chromium (playwright-core):                                                 │
│   · 1 "runtime" page per file with MCP activity: /file/<id>?runtime=1               │
│   · 1 shared "capture" page: /?capture=1 (screenshots, PNG/JPG/PDF export…)         │
│ Persistence: data/files/<id>.json, data/folders.json, data/comments/<id>.json,      │
│              data/assets/<fileId>/<imageId>.<ext>, data/exports/                    │
└─────────────────────────────────────────────────────────────────────────────────────┘
   ▲ WS (kind=human)                                   ▲ WS (kind=runtime)
User's browser: editor (src/web)                 Headless runtime: same editor without UI +
                                                  MCP handlers (src/web/mcp)
```

**Why a headless runtime:** MCP tools need a real layout engine (positions of flex children,
screenshots, HTML parsing with DOMParser). Paper runs them in the editor tab (Electron). Moki runs
exactly the same editor code in a Chromium managed by the server, so the MCP works **even when no
tab is open**, and it can also measure **every** page (Paper only measures the active one). The
user sees the changes live because the runtime is just another sync client.

## 2. Document model (`src/core/types.ts`)

- `MokiFile`: `pages[]`, `nodes{id→TreeNode}`, `nodeRelationships{childId→"parentId:sortKey"}`,
  `counter`, `labelCounter`, `theme.tokens`, `images`.
- Flat tree. Ordering with an ASCII 33–126 fractional index (`src/core/fractional.ts`).
- One root per page: `root_node_<pageId>`, free layout (`styles.display === "*"`).
- **Artboard** = a `Frame` that is a direct child of the root.
- Ids: node `<counter36>-<clientIndex36>`, page `p-…`, token `t:…`. The server assigns a unique,
  increasing `clientIndex` per connection (persisted), so there are no collisions.
- Node types: `Frame`, `Text` (plain text in `textValue`, no rich text), `Rectangle`, `SVG`,
  `SVGVisualElement` (`tag` + `attrs`).
- `styles`: **camelCase CSS** (single source of truth). Tokens referenced as `var(t:<id>)`.
  `display: "*"` = free container (children with `position:absolute` + left/top).
- Shorthand and longhands are never mixed on a node (`mergeStyles` in `src/core/css.ts`).
- Soft delete with `"~": true` (nodes, pages, tokens).

## 3. Sync (`src/core/protocol.ts`, `src/core/edits.ts`)

- JSON-patch-style edits `{path, type: add|update|remove|splice}`; **last-writer-wins per path**.
  No CRDT/OT: the flat model minimizes conflicts (move = 1 update).
- Client: `DocStore` (MobX) + `deepObserve` → every mutation produces an edit (sync) and its
  inverse (undo). Remote edits are applied with the observer paused.
- On connect: full snapshot (`FilePayload`). On reconnect, the client re-applies its offline edits
  on top (an improvement over Paper, which reloaded).
- Numeric `$t` messages (presence, comments, agents, RPC ordered over the same socket).
- The server persists with a debounce (500 ms) and atomic writes.

## 4. Rendering (`src/web/canvas/render-node.tsx`, `src/core/render-style.ts`)

- `computeNodeStyle()` decides the effective CSS (`render`, `external` or `resolved` mode): a
  single place for canvas, screenshots, export and JSX.
- Editor canvas: a "camera" container with `transform: matrix(...)`, `pointer-events:none` on the
  design DOM; geometric hit-testing with measured rectangles; overlays (selection, handles, hover,
  agents) on their own layer.

## 5. MCP (`src/core/mcp/tools.ts`, `src/web/mcp/*`)

- 42 tools: 37 with the same names and input/output contracts as Paper's MCP tools (as documented
  in the private clean-room study), with original descriptions, plus 5 Moki-specific component tools
  (`create_component`, `create_instance`, `list_components`, `detach_instance`, `reset_overrides`).
- A file header is prepended to `file`-scope results:
  `{"file":{"id","name"},"contentHash":{"tokens":<hash>}}`.
- Agent changes don't go into the user's undo history.
- "Agent working" indicator: the runtime broadcasts `UserAgentsChange`; the editor animates
  read/write/edit/delete on the nodes. It expires after 40 s; `finish_working_on_nodes` clears it,
  and so does `DELETE /mcp` (session closed).
- Out of scope (SaaS features in Paper): AI image generation, quotas, telemetry, video export
  (returns an explanatory error).

## 6. Fonts

16 bundled families (fontsource, latin/latin-ext subsets) served at `/fonts/fonts.css` under
their clean name ("Inter", not "Inter Variable"), with a catalog at `/fonts/catalog.json`. Plus
the generic system families. 100 % offline.

## 7. Security (MCP server)

Listens on loopback by default. In Docker it listens on 0.0.0.0 inside the container and is
published only on `127.0.0.1`. `/mcp` rejects requests with an `Origin` header (browsers) and
`OPTIONS`, and validates `Host` (anti DNS-rebinding).

## 8. Components (`src/core/components.ts`)

- **Main**: a `Frame` with `isComponent: true`. It can live on any page (usually a "Components"
  page). Editing it updates all its instances.
- **Instance**: a `Frame` with `instanceOf: <mainId>` and **no stored children**. Its own styles
  (position, size, root overrides) are merged over the main's (excluding the main's position).
- **Virtual children**: resolved on the fly with ids `<instanceId>::<idInMain>`; each nested
  instance adds a segment (`I::J::k`). `DocStore.node/childIds/parentId/view` understand them, so
  rendering, measurement, hit-testing, layers, screenshots, JSX and MCP work without special cases.
- **Overrides**: `instance.overrides[<relative path>] = {styles, textValue, isVisible}`. Writing
  styles or text to a virtual id (UI or `update_styles`/`set_text_content`) creates an override;
  deleting a virtual child hides it. When resolving, they are applied from the inside out (the
  outer level wins).
- **Rules**: layers inside an instance cannot be added/moved/renamed (edit the main or detach);
  an instance cannot be placed inside its own main, and cycles between mains are not allowed.
  Duplicating an instance yields another instance; duplicating a main yields a new main. A deleted
  main still renders its instances (its subtree is preserved).
- **Detach** materializes the children, with their overrides, as real nodes (nested instances
  remain instances).
- **MCP**: `create_component`, `create_instance`, `list_components`, `detach_instance`,
  `reset_overrides` and `<x-moki-instance component-id="…">` in `write_html`.
- **Editor**: ⌘⌥K creates a component, ⌘⌥B detaches, the "Componentes" (Components) tab in the
  left sidebar (click or drag onto the canvas to instantiate), a component section in the design
  panel (go to main, reset, detach) and ◇/◆ markers in purple.
