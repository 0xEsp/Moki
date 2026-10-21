# AGENTS.md — guide to working on the Moki codebase

This file is for anyone who is going to **modify** Moki: AI agents (Claude Code, Codex, Cursor…)
and humans. `CLAUDE.md` is a symlink to this file. To **use** Moki from an agent via MCP, the
guide lives inside the server itself (`get_guide` → `moki-mcp-instructions`).

> Also read [README.md](README.md) (what Moki does) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> (why it is built this way).

---

## 1. Moki in 30 seconds

A local, *agent-first* design tool. A Node server (`src/server`) serves a React editor
(`src/web`) and exposes an MCP server. **The design is real DOM**: every document node is rendered
as an HTML/SVG element with inline CSS and the browser computes the layout. MCP tools run
**inside a headless Chromium** that loads the same editor without the UI (the "runtime"), so they
measure real layouts and work without any tab open.

```
Agent ──MCP HTTP──▶ src/server/mcp.ts ──page.evaluate──▶ headless runtime (src/web/runtime + src/web/mcp)
                        │                                         │ WebSocket ("runtime" client)
Browser ──WS sync──▶ src/server/sync.ts ◀─────────────────────────┘
(editor src/web)        └─ src/server/store.ts → data/files/<id>.json
Screenshots/exports: src/server/capture.ts ──Playwright──▶ page /?capture=1 (src/web/capture)
```

## 2. Code map

| Path | Responsibility |
|---|---|
| `src/core/` | **Isomorphic** (server, editor and runtime). No DOM or Node dependencies. |
| `src/core/types.ts` | Document model: `MokiFile`, `TreeNode`, `Page`, `Token`, `Edit`… |
| `src/core/edits.ts` | Apply/invert JSON-patch edits (sync and undo). |
| `src/core/fractional.ts` | Fractional indexes for ordering children. |
| `src/core/tree.ts` · `ids.ts` · `new-file.ts` | Helpers for the flat tree, ids and the empty file. |
| `src/core/css.ts` | CSS names, units, shorthands (`mergeStyles`). |
| `src/core/render-style.ts` | **The single place** that decides a node's effective CSS (canvas, screenshots, JSX). |
| `src/core/tokens.ts` | Tokens: `var(t:id)` references, serialization, parsing, hashing. |
| `src/core/components.ts` | Components and instances (virtual ids, overrides, detach). |
| `src/core/protocol.ts` | WebSocket messages (`$t`) and RPC. |
| `src/core/mcp/tools.ts` | **MCP tool table** (zod + descriptions). |
| `src/core/mcp/guides.ts` · `instructions.ts` | Guides and instructions sent to agents. |
| `src/server/http.ts` · `index.ts` | HTTP routes, static files, startup. |
| `src/server/sync.ts` | WebSocket hub: authoritative in-memory doc, presence, comments, RPC. |
| `src/server/store.ts` | Persistence in `data/` (JSON with atomic, debounced writes). |
| `src/server/mcp.ts` | MCP Streamable HTTP transport, sessions, routing to the runtime. |
| `src/server/runtime.ts` · `browser.ts` | Headless Chromium: per-file runtime pages, lifecycle. |
| `src/server/capture.ts` | Screenshots, exports (PNG/JPG/WebP/AVIF/PDF), image import. |
| `src/server/bulk-export.ts` · `export-plan.ts` | Scoped export (nodes/page/file/folder) to a streamed ZIP, jobs with progress, `.moki.zip` bundle. |
| `src/server/auth.ts` · `config.ts` | Token, allowed hosts, environment variables. |
| `src/web/state/` | `DocStore` (MobX + `deepObserve` → edits + undo) and `FileSession`. |
| `src/web/sync/` | WebSocket client with reconnection and RPC. |
| `src/web/editor/` | `EditorState` (selection, camera, tools), actions and keyboard. |
| `src/web/canvas/` | Document rendering (`render-node.tsx`), overlay, interactions, measurement. |
| `src/web/panels/` | Left sidebar, properties, tokens, code, export, color picker. |
| `src/web/mcp/` | **MCP tool handlers**, HTML→nodes parser, JSX, search… |
| `src/web/runtime/` | Headless runtime bootstrap (`window.mokiRuntime`). |
| `src/web/capture/` | Page that renders an isolated node to capture it. |
| `src/web/import/` | Pasting from Paper (clipboard format → nodes). |
| `scripts/` | Fonts (`build-fonts.mjs`), e2e tests, deployment (`scripts/deploy/`). |
| `bin/moki-mcp.mjs` | stdio → HTTP relay for MCP clients without HTTP support. |

## 3. Invariants (don't break them)

1. **Flat tree.** `nodes{id → node}` + `nodeRelationships{child → "parent:sortKey"}`. Moving a
   node means rewriting a single entry. Never store child lists.
2. **Soft delete** with `"~": true` (nodes, pages, tokens). Never delete physically.
3. **`styles` is camelCase CSS** and the single source of truth for appearance. Never shorthand
   and longhands at the same time (use `mergeStyles`). `display: "*"` = free container (absolutely
   positioned children).
4. **Tokens are stored internally as `var(t:<id>)`**; externally (MCP, JSX) as `var(--name)`.
   Convert with `externalToInternal` / `internalToExternal`.
5. **Every document mutation goes through `DocStore`** inside a MobX action. That is what
   generates the sync edits and the undo inverses. Agent changes use `withoutUndo`.
6. **Rendering is decided in `computeNodeStyle`.** If something looks different on the canvas, in
   screenshots and in JSX, the fix goes there, not in three places.
7. **Instances have no stored children.** Their children are virtual (`instance::mainNodeId`);
   use `doc.node/childIds/view`, which already understand them.
8. **The canvas does not inherit the UI theme** (`.moki-canvas-scope` sets `color-scheme: light`
   and `color: #000`). The design must look the same in the editor, in screenshots and in exports.
9. **No secrets in the repository.** Real tokens and hosts live in `deploy.local.env` (ignored),
   in the macOS Keychain or in the target machine's `.env`.
10. **Clean-room.** Moki imitates Paper/Figma *behaviors*; do not copy their code or assets.

## 4. Commands

```bash
npm install                 # installs and generates public/fonts (postinstall)
npm run dev                 # server :7410 + Vite :5173 (needs Chrome for the runtime)
npm run typecheck           # strict TypeScript: must be clean
npm test                    # vitest
npm run build               # fonts + production build (dist/)
NODE_ENV=production npx tsx src/server/index.ts   # server serving dist/
```

E2E tests against a running server (they accept `MOKI_URL` and `MOKI_TOKEN`):

```bash
node scripts/mcp-e2e.mjs <port> <outDir>            # the main MCP tools
node scripts/mcp-e2e-parser.mjs <port> <outDir>     # write_html with complex HTML
node scripts/mcp-e2e-components.mjs <port> <outDir> # components and instances
node scripts/replicate-paper-flow.mjs <port> <dir>  # replica of a flow exported from Paper
node scripts/export-e2e.mjs <port>                  # scoped export (page, project, folder)
```

To test without touching your data: `MOKI_DATA_DIR=/tmp/moki-test MOKI_PORT=74xx NODE_ENV=production npx tsx src/server/index.ts`.

## 5. How to verify a change

- **Always:** `npm run typecheck` and `npm test`.
- **Render, parser or MCP changes:** production build, a test server and the matching e2e suite.
  Look at the screenshots it produces (`get_screenshot`): a green test does not guarantee it looks
  right.
- **UI changes:** test them in a real browser (clicks, keyboard, light and dark theme).
  Screenshots of a background tab may lag behind; confirm the state by reading the DOM or the API
  (`GET /api/files/:id`).
- **Before deploying:** `bash scripts/deploy/deploy.sh` already runs typecheck and tests.

## 6. Conventions

- Strict TypeScript, ESM. No UI libraries: custom components and CSS in `src/web/styles.css`.
- Code comments and UI text are in **Spanish**; MCP tool descriptions are in **English** (models
  read them).
- Documentation (`*.md`) is written in **English**.
- Short comments that explain the *why*, not the *what*.
- React components wrapped in `observer()`. No per-frame re-renders: the camera writes the
  `transform` directly to the DOM.
- UI colors always through variables (`var(--ui-…)`), never literals: that is what makes the
  light and dark themes work.
- New styles go at the end of `styles.css`, grouped under a section comment.

## 7. Recipes

**Adding an MCP tool**
1. Define it in `src/core/mcp/tools.ts` (`TOOL_DEFS`: name, scope, gate, zod schema, English
   description written for an agent).
2. Implement the handler in `src/web/mcp/handlers.ts` (return `{data}` or `{error}`; mutate with
   `this.mutate(...)` and record the agent activity).
3. If it changes how an agent should work, update `src/core/mcp/guides.ts`.
4. Add a case to an e2e suite. The server lists it automatically in `tools/list`.

**Adding a property to the design panel:** `src/web/panels/Properties.tsx`. Write with
`api.set({...})` (camelCase CSS); undo and sync come for free.

**Changing how something is rendered:** `src/core/render-style.ts` (and
`src/web/canvas/render-node.tsx` if it is about the element's structure).

**New paste or import format:** `src/web/import/` (clipboard) or
`POST /api/files/import` (`src/server/http.ts`).

## 8. Known pitfalls

- **Zoom sharpness:** don't leave `will-change: transform` permanently on the camera; Chrome would
  rasterize once and stretch the bitmap (blurry text). It is only enabled while the camera moves.
- **Background runtime:** Chromium throttles `requestAnimationFrame` in hidden pages. That is why
  it is launched with `--disable-background-timer-throttling` and waits use rAF with a timer
  fallback.
- **Font names with digits** (`Source Sans 3`): unquoted, they are invalid CSS. `computeNodeStyle`
  and tokens quote them.
- **SVG:** presentation attributes (`fill="var(--x)"`) don't resolve variables; the parser moves
  them into styles.
- **Remote images:** they are always copied to `data/assets` on import or paste. A design must not
  depend on external URLs.
- **Geometric hit-testing:** the design DOM has `pointer-events: none`; selection uses the measured
  rectangles (`measure-cache.ts`), not `elementFromPoint`.
- **Persistence:** the server saves with a debounce; for consistent backups, stop the container
  first (`scripts/deploy/remote-update.sh` does this).

## 9. Deployment

- Local: `docker compose up -d --build` (port 7410 on loopback).
- Raspberry Pi/server: `bash scripts/deploy/deploy.sh` (build on the Mac → `scp` → activation with
  backup). Initial setup and secrets: [docs/DEPLOY.md](docs/DEPLOY.md).
