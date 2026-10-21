# Moki

**Moki is an interface design tool that runs on your machine (or on your Raspberry Pi), built to
work hand in hand with AI agents.**

- **The design is real HTML/CSS.** Every layer is a DOM element with inline styles; the browser
  does the layout (flexbox, text, `fit-content`…). What you see is exactly what gets exported to
  code.
- **Agent-first.** Ships with an **MCP** server with 42 tools: Claude Code, Cursor or any MCP
  client can read your designs, create screens, edit styles, use your tokens and components, take
  screenshots and export — while you watch it live on the canvas.
- **Local and private.** No accounts, no cloud: one Docker container, your files in a folder.
  Works offline (fonts are bundled).

> Moki is inspired by the behavior of tools like Paper and Figma, but it is an independent
> implementation written from scratch. It contains no code from either of them.

---

## Table of contents

1. [What you can do](#what-you-can-do)
2. [Getting started](#getting-started)
3. [Connecting an agent (MCP)](#connecting-an-agent-mcp)
4. [Editor quick guide](#editor-quick-guide)
5. [Bringing designs over from Paper](#bringing-designs-over-from-paper)
6. [Components](#components)
7. [Exporting](#exporting)
8. [MCP tools](#mcp-tools)
9. [Configuration](#configuration)
10. [Data and backups](#data-and-backups)
11. [For developers](#for-developers)

---

## What you can do

| Area | Features |
|---|---|
| **Files** | Dashboard with folders and subfolders, move designs by dragging or with *Mover a…* (Move to…), rename, import and export |
| **Canvas** | Pages (with icons and separators), artboards, frames, rectangles, text and SVG; smooth zoom and pan, crisp at any zoom level |
| **Editing** | Move, resize, reorder within flex, wrap in a frame, duplicate, copy/paste, undo/redo, lock/hide |
| **Properties** | Layout (free / flex / block), padding and gap, alignment, fill, border, shadow, typography, opacity, clipping and a **free-form CSS editor** with every property |
| **Color** | Custom picker with **HEX by default** (plus RGB/HSL), opacity and eyedropper; all colors are displayed in hex |
| **Design system** | **Tokens** (colors, typography, spacing, radii…) and **components** with instances and overrides |
| **Measuring** | Hold **⌥ Option** with something selected and hover another layer to see the distances in px |
| **Code** | *Código* (Code) tab with the JSX of the selection (inline styles or Tailwind) |
| **Collaboration** | Comments anchored to layers; multiple tabs (and agents) editing at the same time in real time |
| **Agents** | You see on the canvas what the agent reads and writes; its changes don't go into your undo history |
| **Import** | Paste what you copied in **Paper** (⌘C → ⌘V), drag in images, import `.json` / `.moki.zip` files |
| **Export** | A frame, a page, a whole project or an entire folder: PNG, JPG, WebP, SVG, PDF or editable file, in a ZIP |
| **Interface** | Light, dark or system theme; resizable *Páginas*/*Capas* (Pages/Layers) panels |

---

## Getting started

### Option A — Docker on your computer (recommended)

```bash
docker compose up -d --build
```

- Editor: <http://localhost:7410>
- MCP: `http://localhost:7410/mcp`
- Your designs live in `./data` (exports in `./data/exports`).
- It only listens on `127.0.0.1`: nobody else on your network can reach it.

### Option B — Raspberry Pi or another home server (e.g. a Mac mini)

Moki deploys with a single command from the Mac: it builds the `arm64` image, copies it to the
server and activates it after backing up the data. `MOKI_DEPLOY_PROFILE=pi` (default) uses the
low-memory profile; `server` is for machines with RAM to spare, such as a Mac mini with OrbStack.

```bash
bash scripts/deploy/deploy.sh
```

The first time, you need to configure the target and the token: **[docs/DEPLOY.md](docs/DEPLOY.md)**.
Pi requirements and details: [docs/RASPBERRY.md](docs/RASPBERRY.md). When exposed on the network,
Moki **requires a token** (`MOKI_TOKEN`) for both the web UI and the MCP.

### Option C — Development (without Docker)

```bash
npm install
npm run dev
```

Server on `:7410` and the editor with hot reload at <http://localhost:5173>. Requires Google
Chrome installed (or `MOKI_CHROMIUM_PATH`) for the MCP runtime and screenshots.

---

## Connecting an agent (MCP)

**Claude Code** (Moki running locally):

```bash
claude mcp add --transport http moki http://localhost:7410/mcp
```

**Claude Code** (Moki on a remote server, with the token stored in the macOS Keychain):

```bash
bash scripts/deploy/claude-mcp-add.sh
```

**Stdio-only clients:** `node bin/moki-mcp.mjs` (relays stdio → HTTP; uses `MOKI_URL` and
`MOKI_TOKEN` if needed).

Then ask it things like *"open my Moki file and design the settings screen with our tokens"*.
Tools with an optional `fileId` use the file you have open in the browser. The agent has a
built-in design guide (`get_guide` → `moki-mcp-instructions`).

> **How it works under the hood:** MCP tools run in a headless Chromium that the server opens
> with the same editor (without the UI). That way they work even when you have no tab open, they
> measure real layouts, and screenshots are identical to the canvas. You see the changes live
> because that "runtime" is just another sync client.

---

## Editor quick guide

### Tools and shortcuts

| Action | Shortcut |
|---|---|
| Move / select | `V` |
| Frame (artboard if you draw on the empty canvas) | `F` or `A` |
| Rectangle | `R` |
| Text | `T` (double-click a text to edit it) |
| Hand (pan) | `H`, or hold `Space` |
| Comment | `C` |
| Undo / redo | `⌘Z` / `⇧⌘Z` |
| Duplicate | `⌘D` |
| Copy / cut / paste | `⌘C` / `⌘X` / `⌘V` |
| Wrap the selection in a flex frame | `⌘G` |
| Hide / lock | `⇧⌘H` / `⇧⌘L` |
| Select all (siblings) | `⌘A` |
| Enter children / go up to parent | `Enter` / `⇧Enter` or `Esc` |
| Nudge 1 px / 10 px | Arrows / `⇧` + arrows |
| Zoom | `⌘+` `⌘−` · `⌘0` = 100 % · `⇧1` zoom to fit all · `⇧2` zoom to selection · `Ctrl` or pinch + wheel |
| Measure distances | Hold `⌥` with a selection and hover another layer |
| Create component / detach instance | `⌥⌘K` / `⌥⌘B` |

### Selection (as in Figma)
- Click: selects the top-level element of the artboard (or one at the same level as the selection).
- Double-click: goes one level deeper (or edits the text). `⌘`+click: selects the deepest element.
- Click an artboard's name: selects the artboard.

### Panels
- **Left:** *Páginas* (Pages) and *Capas* (Layers), separated by a draggable divider
  (double-click = show all pages). The *Componentes* (Components) tab lists the file's components.
- **Right:** *Diseño* (Design: properties and tokens), *Código* (Code: JSX) and *Comentarios*
  (Comments).

---

## Bringing designs over from Paper

In Paper, select **the whole artboard** (click its name) — or several — and press `⌘C`. In Moki,
press `⌘V`. You get the structure, styles, text, SVGs, the tokens they use and the images (which
are **copied** to your local storage; they don't stay linked to Paper).

If you copy only layers from inside a screen, Moki rebuilds the containing frame (position, size,
layout and an approximate background) so that the status bar and safe area stay inside the screen.

---

## Components

1. Select a frame and press `⌥⌘K`: it becomes a **main component** (◇).
2. Insert **instances** (◆) from the *Componentes* tab (click or drag onto the canvas).
3. Whatever you change in the main component applies to all instances. Whatever you change in an
   instance (text, colors, visibility) is kept as an *override* on that instance only.
4. In the panel: *Ir al componente* (Go to component), *Restablecer cambios* (Reset changes) and
   *Desvincular* (Detach).

---

## Exporting

The **Exportar** (Export) button in the top bar lets you choose **what** to export:

| Scope | What it includes |
|---|---|
| *Selección* (Selection) | The selected frames/layers |
| *Página actual* (Current page) | All artboards on the page |
| *Proyecto completo* (Whole project) | All artboards on all pages |
| *Carpeta* (Folder, from the dashboard) | All designs in the folder and its subfolders |

Formats: **PNG, JPG, WebP** (1x/2x/3x), **SVG** (SVG layers only), **PDF** (one per artboard or
one per page) and **editable Moki** (`.moki.zip`, re-importable losslessly, images included).
With *Incluir el fichero editable* (Include the editable file), the `.moki.zip` is added alongside
the images.

- If the result is a single file it is downloaded as is; if there are several, you get a ZIP
  organized like this: `Folder/Subfolder/Design/Page/Artboard@2x.png` (per-page PDFs as
  `Design/Page.pdf`).
- In the dashboard, every design and every folder has a **⇩** button with the same dialog, and
  *Importar* (Import) accepts both `.json` and `.moki.zip`.
- Long exports show progress.
- From the properties panel you can still export the selected layer with its own settings.
- Agents can export a page or the whole project with the `export` tool
  (`scope: "page" | "file"`). Over HTTP: `POST /api/export` (see `src/server/bulk-export.ts`).

---

## MCP tools

| Group | Tools |
|---|---|
| Files | `list_resources`, `open_file`, `create_file`, `rename_resource`, `get_guide` |
| Pages | `create_page`, `update_pages`, `arrange_pages` |
| Read | `get_basic_info`, `get_selection`, `get_node_info`, `get_children`, `get_tree_summary`, `get_screenshot`, `get_jsx`, `get_computed_styles`, `get_fill_image`, `find_nodes`, `get_font_family_info` |
| Write | `create_artboard`, `write_html`, `update_styles`, `set_text_content`, `rename_nodes`, `duplicate_nodes`, `move_nodes`, `delete_nodes`, `finish_working_on_nodes` |
| Components | `create_component`, `create_instance`, `list_components`, `detach_instance`, `reset_overrides` |
| Tokens | `get_tokens`, `create_tokens`, `set_tokens` |
| Comments | `list_comment_threads`, `get_comment_thread`, `list_comment_thread_authors`, `set_comment_thread_status` |
| Export | `export`, `export_combined_pdf` |

`write_html` converts HTML with inline styles into layers (including `<svg>`, `<img>`,
`<x-moki-clone>` and `<x-moki-instance>`). Out of scope for now: AI image generation and video
export.

---

## Configuration

Server environment variables (with Docker, in `docker-compose.yml` or `.env`):

| Variable | Default | Purpose |
|---|---|---|
| `MOKI_PORT` | `7410` | HTTP / WebSocket / MCP port |
| `MOKI_HOST` | `127.0.0.1` | Listening interface (`0.0.0.0` inside Docker) |
| `MOKI_DATA_DIR` | `./data` | Files, comments, images and exports |
| `MOKI_TOKEN` | — | Access token: `Bearer` on `/mcp`, login (cookie) on the web UI |
| `MOKI_ALLOWED_HOSTS` | — | Hosts accepted in addition to localhost (requires `MOKI_TOKEN`) |
| `MOKI_PUBLIC_ORIGIN` | `http://localhost:7410` | Public URL returned by the tools |
| `MOKI_CHROMIUM_PATH` | auto-detected | Chromium/Chrome for the runtime and screenshots |
| `MOKI_LOW_MEMORY` | — | `1` = Raspberry Pi profile (fewer processes, idle shutdowns) |
| `MOKI_MAX_RUNTIMES` | 8 (2 in low-mem) | Files with a Chromium runtime at the same time |
| `MOKI_RUNTIME_IDLE_MS` / `MOKI_CAPTURE_IDLE_MS` / `MOKI_BROWSER_IDLE_MS` | 15/10/15 min (5/2/3 in low-mem) | Idle shutdowns |
| `MOKI_MAX_EXPORT_SIDE` | 16000 (8000 in low-mem) | Maximum side length of a raster export |
| `MOKI_EXPORT_HOST_DIR` | — | Host path returned in exports (Docker) |
| `MOKI_LOCALHOST_ALIAS` | — | Rewrites `localhost` when importing images (Docker: `host.docker.internal`) |
| `MOKI_LOCAL_ASSET_ROOTS` | — | Folders from which importing `file://` images is allowed |
| `MOKI_CHROMIUM_ARGS` | — | Extra Chromium flags |

---

## Data and backups

Everything lives in `data/` (or in `MOKI_DATA_DIR`):

```
data/
├─ files/<id>.json        one design (full document)
├─ folders.json           folders
├─ comments/<id>.json     comment threads
├─ assets/<id>/…          each design's images
└─ exports/               exports
```

To back up, just copy the folder. On the Raspberry Pi, every deployment first saves a copy to
`releases/moki-data-*.tar.gz` (the last 5 are kept). From the editor you can also export a design
as an editable `.moki.zip`.

---

## For developers

- **[AGENTS.md](AGENTS.md)** — code map, invariants, conventions and recipes, for humans and AI
  agents. `CLAUDE.md` is a link to this same file.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — architecture and design decisions.
- **[docs/DEPLOY.md](docs/DEPLOY.md)** and **[docs/RASPBERRY.md](docs/RASPBERRY.md)** — deployment.

```bash
npm test                                  # unit tests (vitest)
npm run typecheck                         # strict TypeScript
node scripts/mcp-e2e.mjs 7410 /tmp/out    # full MCP suite against a running server
```

The e2e suites (`scripts/*e2e*.mjs`, `scripts/replicate-paper-flow.mjs`) accept `MOKI_URL` and
`MOKI_TOKEN` to test against a remote deployment.

---

## License

[MIT](LICENSE) © 0xEsp
