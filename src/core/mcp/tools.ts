import { z } from 'zod';
import { PAGE_ICONS, TOKEN_TYPES } from '../types';

// Tabla única de herramientas MCP de Moki. La usan:
//  - el servidor: `tools/list` (JSON Schema) y validación de argumentos;
//  - el runtime (editor headless): despacho a los handlers.
// Las descripciones están escritas para agentes: qué hace, cuándo usarla y qué devuelve.

export type ToolScope =
  /** Sin fichero: se resuelve en el servidor. */
  | 'app'
  /** `fileId` opcional: por defecto el fichero que el usuario está viendo. */
  | 'file-optional-id'
  /** `fileId` obligatorio. */
  | 'file';

export type ToolGate = 'none' | 'open' | 'read' | 'write';

export interface ToolDef {
  name: string;
  scope: ToolScope;
  gate: ToolGate;
  description: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  schema: z.ZodObject;
}

const pageId = z
  .string()
  .optional()
  .describe('Page to operate on. Defaults to the page the user is viewing, which can change between calls — prefer explicit page IDs.');

const iconEnum = z
  .enum(PAGE_ICONS as [string, ...string[]])
  .describe(
    'Decorative icon shown next to the page name. "arrow" highlights the key page of a file, "design" marks a design page, "junk" marks discarded explorations.',
  );

const tokenType = z.enum(TOKEN_TYPES as [string, ...string[]]);
const tokenName = z.string().regex(/^--[a-zA-Z0-9_-]+$/);

const exportSetting = z.object({
  format: z.enum(['avif', 'jpg', 'mp4', 'pdf', 'png', 'svg', 'webm', 'webp']),
  scale: z
    .string()
    .regex(/^\d+(\.\d+)?(x|w|h|p)$/)
    .describe('Number + unit: "2x" multiplier, "1200w" target width, "800h" target height, "1080p" short side.'),
  durationSeconds: z.number().min(1).max(300).optional(),
  pdfQuality: z.enum(['low', 'medium', 'high']).optional(),
  pdfResampling: z.enum(['detailed', 'basic']).optional(),
});

const moveBefore = z.strictObject({ nodeId: z.string(), before: z.string().describe('Sibling to place the node right before.') });
const moveAfter = z.strictObject({ nodeId: z.string(), after: z.string().describe('Sibling to place the node right after.') });
const moveInto = z.strictObject({
  nodeId: z.string(),
  parentId: z.string().describe('New parent. "root" = the page root of the page the node lives on.'),
  index: z.number().int().min(0).optional().describe('Position among the parent children. Omit to append at the end.'),
});

export const TOOL_DEFS: ToolDef[] = [
  // ------------------------------------------------------------------ app
  {
    name: 'get_guide',
    scope: 'app',
    gate: 'none',
    annotations: { readOnlyHint: true },
    description:
      'Read a Moki usage guide. Read "moki-mcp-instructions" once per session before designing. Topics: "moki-mcp-instructions" (how to design well with Moki), "mobile-status-bar" (ready-to-paste iOS-like status bar for mobile artboards), "figma-import" (bringing designs from Figma).',
    schema: z.object({ topic: z.string().describe('Guide topic.') }),
  },
  {
    name: 'open_file',
    scope: 'app',
    gate: 'open',
    annotations: { readOnlyHint: true },
    description:
      'Open a Moki file so the other tools can work on it, and return the same overview as get_basic_info. Accepts a bare file ID, a /file/<id> path or a full Moki URL. If the user already has the file open, the page they are looking at is not changed.',
    schema: z.object({
      fileId: z.string().min(1).describe('File ID, /file/<id> path or Moki URL.'),
      pageId: z.string().optional().describe('Page to show when the file is not open yet.'),
    }),
  },
  {
    name: 'list_resources',
    scope: 'app',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'List local Moki files and folders, most recently updated first. Files currently open in a browser tab come first and are flagged with open/active.',
    schema: z.object({ limit: z.number().int().min(1).max(200).optional().describe('Max items (default 50).') }),
  },
  {
    name: 'create_file',
    scope: 'app',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Create a new Moki file (optionally as a copy of another). Returns { fileId, url }. It is not opened automatically: call open_file next.',
    schema: z.object({
      cloneFileId: z.string().optional().describe('File to copy.'),
      name: z.string().optional().describe('Display name.'),
    }),
  },
  {
    name: 'rename_resource',
    scope: 'app',
    gate: 'write',
    annotations: { destructiveHint: true },
    description: 'Rename a file or folder.',
    schema: z.object({ resourceId: z.string(), name: z.string() }),
  },

  // ------------------------------------------------------------------ pages
  {
    name: 'create_page',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Add a page after the active one without switching the user to it. Returns { pageId, name, icon }. Default name is "Page N".',
    schema: z.object({ name: z.string().optional(), icon: iconEnum.optional() }),
  },
  {
    name: 'update_pages',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description: 'Rename pages and/or change their icon (icon: null restores the default). Does not change the active page.',
    schema: z.object({
      updates: z.array(
        z.object({ pageId: z.string(), name: z.string().optional(), icon: iconEnum.nullable().optional() }),
      ),
    }),
  },
  {
    name: 'arrange_pages',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Reorder the page list and add/remove dividers. All-or-nothing: `order` must contain every existing page and divider ID exactly once (except dividers in removeDividerIds); use { "type": "divider" } to insert a new divider. Pages are never deleted.',
    schema: z.object({
      order: z.array(z.union([z.string(), z.strictObject({ type: z.literal('divider') })])),
      removeDividerIds: z.array(z.string()).optional(),
    }),
  },

  // ------------------------------------------------------------------ read
  {
    name: 'get_basic_info',
    scope: 'file-optional-id',
    gate: 'none',
    annotations: { readOnlyHint: true },
    description:
      'Overview of a file page: file and page names, rootNodeId, node and artboard counts, artboards with size and position, the page list (with dividers), fonts used and design tokens. Start here.',
    schema: z.object({ pageId }),
  },
  {
    name: 'get_selection',
    scope: 'file-optional-id',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description: 'Nodes the user currently has selected (up to 100), with size, position, artboard and parent.',
    schema: z.object({}),
  },
  {
    name: 'get_node_info',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'Details of one node: component, size, position (world and relative to parent), visibility, lock, parent, child IDs (up to 100), artboard and text content for Text nodes.',
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: 'get_children',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description: 'Direct children of a node, in order (up to 100), with component, child count and position.',
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: 'get_tree_summary',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'Compact indented text outline of a subtree: component, name, ID, size and the start of text content. Cheaper than walking with get_children.',
    schema: z.object({
      nodeId: z.string(),
      depth: z.number().optional().describe('Depth to traverse (default 3, max 10).'),
    }),
  },
  {
    name: 'get_screenshot',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'Render a node (usually an artboard or a section) to an image to check the design visually. scale 1 (default) for layout; 2 for small text and fine detail.',
    schema: z.object({ nodeId: z.string(), scale: z.number().optional() }),
  },
  {
    name: 'get_jsx',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'Generate JSX for a node and its visible descendants, with inline styles (default) or Tailwind classes. Use it to turn designs into code. Pass includeNodeIds: false for clean code.',
    schema: z.object({
      nodeId: z.string(),
      format: z.enum(['inline-styles', 'tailwind']).optional(),
      includeNodeIds: z.boolean().optional().describe('Add id="<nodeId>" to each element (default true).'),
      includeRootPositioning: z.boolean().optional().describe('Keep position/insets of the root node (default false).'),
    }),
  },
  {
    name: 'get_computed_styles',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description: 'Effective CSS (camelCase) of each node. Tokens appear as var(--name). Unknown IDs map to null.',
    schema: z.object({ nodeIds: z.array(z.string()) }),
  },
  {
    name: 'get_fill_image',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description: 'Return the image used as fill (background image) of a node, as JPEG, plus its original URL and size.',
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: 'find_nodes',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'Search nodes by text content and/or style. Matching is case-insensitive; "*" is a wildcard anchored to the whole value. Style names accept kebab or camel case and match shorthands/longhands (padding ↔ paddingTop). Colors match by equivalence (#fff = white) and also find usages through tokens. Filters are ANDed. Scope: nodeId subtree, else pageId, else the whole file. Max 200 results.',
    schema: z
      .object({
        pageId: z.string().optional(),
        nodeId: z.string().optional(),
        textValue: z.string().optional().describe('Match Text node content.'),
        filters: z
          .array(
            z
              .object({ styleName: z.string().optional(), styleValue: z.string().optional() })
              .refine((f) => f.styleName !== undefined || f.styleValue !== undefined, 'Each filter needs styleName or styleValue'),
          )
          .min(1)
          .optional(),
      })
      .refine((a) => a.textValue !== undefined || (a.filters && a.filters.length > 0), 'Provide textValue or at least one filter'),
  },
  {
    name: 'get_font_family_info',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'Check that font families are available and list their styles/weights. Call before the first typographic styling in a session.',
    schema: z.object({ familyNames: z.array(z.string()) }),
  },

  // ------------------------------------------------------------------ comments
  {
    name: 'list_comment_threads',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'List comment threads left by the user on the canvas (default: open ones), with a preview of the first message and the node they are pinned to.',
    schema: z.object({
      pageId: z.string().optional(),
      currentPageOnly: z.boolean().optional(),
      nodeId: z.string().optional(),
      status: z.enum(['open', 'resolved', 'all']).optional(),
      search: z.string().optional(),
      searchScope: z.enum(['first-message', 'all-messages']).optional(),
      participantUserId: z.string().optional(),
      threadAuthorUserId: z.string().optional(),
      sortField: z.enum(['page', 'createdAt', 'updatedAt']).optional(),
      sortDirection: z.enum(['asc', 'desc']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      previewLength: z.number().int().min(20).max(1000).optional(),
    }),
  },
  {
    name: 'get_comment_thread',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description: 'Read a full comment thread with all its messages.',
    schema: z.object({ commentThreadId: z.string().min(1) }),
  },
  {
    name: 'list_comment_thread_authors',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description: 'People who started or replied to comment threads, with activity counts.',
    schema: z.object({ pageId: z.string().optional() }),
  },
  {
    name: 'set_comment_thread_status',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description: 'Resolve a comment thread once its feedback is addressed, or reopen it.',
    schema: z.object({ commentThreadId: z.string().min(1), status: z.enum(['open', 'resolved']) }),
  },

  // ------------------------------------------------------------------ write
  {
    name: 'create_artboard',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Create an artboard (top-level frame) on a page. It is placed automatically in free space (any left/top you pass is overridden; move it later with update_styles). Defaults to a vertical flex column. Typical widths: 1440 desktop, 375 mobile.',
    schema: z.object({
      pageId,
      name: z.string().describe('Layer name.'),
      styles: z
        .object({
          width: z.string().describe('Whole pixel value, e.g. "1440px".'),
          height: z.string().describe('Whole pixel value, e.g. "900px". Use update_styles height:"fit-content" later if content grows.'),
        })
        .catchall(z.union([z.string(), z.number()])),
    }),
  },
  {
    name: 'write_html',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Turn HTML with inline styles into design nodes. "insert-children" appends to targetNodeId; "replace" swaps targetNodeId for the new nodes in the same place. Write small pieces (one visual group, ~15 lines) per call so the user sees progress. Only inline style="" is read (no <style>, no classes). Use flexbox, px sizes, gap instead of margins. <img src> accepts http(s), data: and local asset URLs. <x-moki-clone node-id="…" style="…"> deep-copies an existing node with style overrides. layer-name="…" sets the layer name.',
    schema: z.object({
      html: z.string(),
      targetNodeId: z.string(),
      mode: z.enum(['insert-children', 'replace']),
    }),
  },
  {
    name: 'delete_nodes',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description: 'Delete nodes and their descendants. Validates all IDs first; nothing is deleted if one is invalid.',
    schema: z.object({ nodeIds: z.array(z.string()) }),
  },
  {
    name: 'set_text_content',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description: 'Replace the text of Text nodes (plain text; use \\n for line breaks).',
    schema: z.object({ updates: z.array(z.object({ nodeId: z.string(), textContent: z.string() })) }),
  },
  {
    name: 'rename_nodes',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description: 'Rename layers (max 200 characters).',
    schema: z.object({ updates: z.array(z.object({ nodeId: z.string(), name: z.string() })) }),
  },
  {
    name: 'update_styles',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Set CSS on nodes, camelCase like React.CSSProperties ({ "backgroundColor": "#fff", "padding": "20px" }). Pass null or "" to remove a property. var(--token) references existing tokens. Styles that have no effect in the node context (e.g. flex child props in a non-flex parent) are dropped and reported in ignoredStyles.',
    schema: z.object({
      updates: z.array(
        z.object({
          nodeIds: z.array(z.string()),
          styles: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
        }),
      ),
    }),
  },
  {
    name: 'duplicate_nodes',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Deep-copy nodes. The copy goes right after the original (or into parentId). Duplicated artboards are placed in free space next to the original. Returns the new IDs and a descendantIdMap (original → copy) so you can edit the copies.',
    schema: z.object({ nodes: z.array(z.object({ id: z.string(), parentId: z.string().optional() })) }),
  },
  {
    name: 'move_nodes',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Reorder or reparent nodes without recreating them. Each move is { nodeId, before } | { nodeId, after } | { nodeId, parentId, index? }. Moves run in sequence. In flex parents order is visual order; in free-form parents the last child is on top. Reparenting keeps the on-canvas position.',
    schema: z.object({ moves: z.array(z.union([moveBefore, moveAfter, moveInto])).min(1) }),
  },
  {
    name: 'finish_working_on_nodes',
    scope: 'file',
    gate: 'none',
    annotations: { readOnlyHint: true },
    description:
      'Tell the user you are done with some nodes (or with everything if nodeIds is omitted): clears your "working" indicators on the canvas. Always call it when you finish a task.',
    schema: z.object({ nodeIds: z.array(z.string()).optional() }),
  },

  // ------------------------------------------------------------------ componentes
  {
    name: 'create_component',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Turn a frame into a main component. Its instances (create_instance) mirror it: editing the main updates every instance. Use components for anything repeated (buttons, inputs, cards, list rows, nav bars). Keep mains on a "Components" page.',
    schema: z.object({ nodeId: z.string(), name: z.string().optional().describe('Component name (layer name).') }),
  },
  {
    name: 'create_instance',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Place an instance of a main component as a child of targetNodeId (at index, or appended). styles sets the instance own styles (position in free-form parents, width…). The instance children have virtual IDs "<instanceId>::<mainChildId>": read them with get_tree_summary; update_styles / set_text_content / delete_nodes on them write per-instance overrides.',
    schema: z.object({
      componentId: z.string(),
      targetNodeId: z.string().describe('Parent node for the new instance (a page root or a frame).'),
      index: z.number().int().min(0).optional(),
      styles: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    }),
  },
  {
    name: 'convert_to_instances',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Replace hand-made copies of a component with instances of it, in place: each node keeps its id, position and look, and whatever differs from the main (texts, sizes, colors, hidden layers) becomes a per-instance override. A copy must have the same layer structure as the main (same layer types, SVG content and number of children); the ones that do not are reported with the reason and left untouched. Use it to componentize existing designs; use dryRun first to see which copies match and how many overrides each would need (many overrides usually means a different variant that deserves its own main).',
    schema: z.object({
      componentId: z.string(),
      nodeIds: z.array(z.string()).min(1).max(500),
      dryRun: z.boolean().optional().describe('Only report what would happen.'),
    }),
  },
  {
    name: 'list_components',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description: 'List the main components of the file (all pages, or one page) with their size and how many instances use them.',
    schema: z.object({ pageId: z.string().optional() }),
  },
  {
    name: 'detach_instance',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Convert an instance into regular editable nodes (overrides applied); it stops following the main component. Returns descendantIdMap (main child id → new node id).',
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: 'reset_overrides',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Drop the overrides of an instance (keeping its position and size) or of one node inside an instance, so it matches the main component again.',
    schema: z.object({ nodeId: z.string() }),
  },

  // ------------------------------------------------------------------ tokens
  {
    name: 'get_tokens',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'Read the file design tokens (CSS variables) as JSON, a :root CSS block or a Tailwind v4 @theme block. Filter by type and by name glob (e.g. "--color-*").',
    schema: z.object({
      types: z.array(tokenType).optional(),
      namePattern: z.string().optional(),
      format: z.enum(['json', 'css', 'tailwind']).optional(),
    }),
  },
  {
    name: 'create_tokens',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description:
      'Create design tokens. Value can be a literal (color, px number, etc.) or var(--other) to alias. An identical existing token (same type, name and value) is reused. Order colors semantic-first (neutrals, primary, secondary, accent), and other types from small to large.',
    schema: z.object({
      tokens: z
        .array(
          z.object({
            type: tokenType,
            name: tokenName.describe('CSS custom property name, e.g. "--color-primary".'),
            value: z.union([z.string(), z.number()]),
            description: z.string().max(1024).optional(),
          }),
        )
        .min(1),
    }),
  },
  {
    name: 'set_tokens',
    scope: 'file',
    gate: 'write',
    annotations: { destructiveHint: true },
    description: 'Update, rename or delete existing tokens. delete: true wins over other fields; description "" clears it.',
    schema: z.object({
      tokens: z
        .array(
          z.object({
            name: tokenName,
            newName: tokenName.optional(),
            value: z.union([z.string(), z.number()]).optional(),
            description: z.string().max(1024).optional(),
            delete: z.boolean().optional(),
          }),
        )
        .min(1),
    }),
  },

  // ------------------------------------------------------------------ export
  {
    name: 'export',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description:
      'Export nodes to files (png, jpg, webp, avif, svg for SVG nodes, pdf). nodes is either { "<nodeId>": [settings] } (empty array = node defaults) or "nodes-with-exports-only" to export every node on the page that has export settings. Alternatively pass scope "page" (every artboard of pageId / the active page) or "file" (every artboard of every page) with format (png, jpg, webp, svg, pdf = one per artboard, pdf-combined = one per page, moki = editable source bundle) and scale: the result is a single ZIP (or one file if there is only one output). Returns the written file paths and download URLs.',
    schema: z
      .object({
        pageId,
        type: z.enum(['image', 'video']).optional(),
        nodes: z.union([z.literal('nodes-with-exports-only'), z.record(z.string(), z.array(exportSetting))]).optional(),
        scope: z.enum(['page', 'file']).optional().describe('Export a whole page or the whole file instead of specific nodes.'),
        format: z.enum(['png', 'jpg', 'webp', 'svg', 'pdf', 'pdf-combined', 'moki']).optional().describe('Format for scope exports (default png).'),
        scale: z.number().min(0.5).max(4).optional().describe('Scale for raster scope exports (default 2).'),
        includeSource: z.boolean().optional().describe('With scope: also include the editable .moki.zip source.'),
      })
      .refine((a) => a.nodes !== undefined || a.scope !== undefined, 'Provide nodes or scope'),
  },
  {
    name: 'export_combined_pdf',
    scope: 'file',
    gate: 'read',
    annotations: { readOnlyHint: true },
    description: 'Export several nodes into one PDF, one page per node, ordered top-to-bottom then left-to-right.',
    schema: z.object({ nodeIds: z.array(z.string()).min(1) }),
  },
];

export const TOOL_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

export const FILE_ID_DESCRIPTION_REQUIRED = 'The Moki file to operate on (ID from list_resources / open_file).';
export const FILE_ID_DESCRIPTION_OPTIONAL = 'The Moki file to operate on. Omit to use the file the user is viewing.';

/** Schema final de una herramienta, con `fileId` según su scope. */
export function schemaWithFileId(def: ToolDef): z.ZodType {
  if (def.scope === 'app') return def.schema;
  const fileId =
    def.scope === 'file'
      ? z.string().describe(FILE_ID_DESCRIPTION_REQUIRED)
      : z.string().optional().describe(FILE_ID_DESCRIPTION_OPTIONAL);
  // `extend` no está disponible en objetos con refinamientos: los envolvemos.
  return z.intersection(def.schema, z.object({ fileId }));
}

/** JSON Schema para `tools/list`. */
export function toolJsonSchema(def: ToolDef): Record<string, unknown> {
  if (def.scope === 'app') return z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const base = z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  } & Record<string, unknown>;
  const properties = { ...(base.properties ?? {}) };
  properties.fileId = {
    type: 'string',
    description: def.scope === 'file' ? FILE_ID_DESCRIPTION_REQUIRED : FILE_ID_DESCRIPTION_OPTIONAL,
  };
  const required = [...(base.required ?? [])];
  if (def.scope === 'file') required.push('fileId');
  return { ...base, type: 'object', properties, required };
}
