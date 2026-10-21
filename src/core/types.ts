// Modelo de documento de Moki.
//
// El documento es un único objeto JSON. El árbol es plano: `nodes` (id → nodo) y
// `nodeRelationships` (childId → "parentId:sortKey"). Mover un nodo = reescribir una
// sola entrada, lo que hace que el sync "último que escribe gana por ruta" sea robusto.

export const SCHEMA_VERSION = 20261021;

/** Valor centinela de `styles.display` para un contenedor libre (hijos absolutos). */
export const FREEFORM_DISPLAY = '*';

/** Prefijo del nodo raíz de cada página. */
export const ROOT_PREFIX = 'root_node_';

export type ComponentType = 'Frame' | 'Text' | 'Rectangle' | 'SVG' | 'SVGVisualElement';

export type StyleValue = string | number;
export type Styles = Record<string, StyleValue>;

export interface ExportEntry {
  format: 'png' | 'jpg' | 'webp' | 'avif' | 'svg' | 'pdf';
  scale: string; // "1x", "2x", "1080w", "720h", "1080p"
  suffix?: string;
  quality?: 'low' | 'medium' | 'high';
  resampling?: 'detailed' | 'basic';
}

export interface TreeNode {
  id: string;
  label: string;
  labelIsModified?: boolean;
  component: ComponentType;
  /** Tag SVG para `SVGVisualElement` (path, circle, rect, g…). */
  tag?: string;
  /** Atributos SVG/HTML no estilísticos (d, viewBox, cx…). */
  attrs?: Record<string, string>;
  textValue?: string;
  /** Solo se guarda `false`. */
  isVisible?: boolean;
  isLocked?: boolean;
  /** CSS en camelCase. Las referencias a tokens se guardan como `var(t:…)`. */
  styles: Styles;
  /** Elementos SVG no renderizables como nodos (defs, style…), serializados. */
  svgNonRendered?: string;
  exportMeta?: { entries: ExportEntry[] };
  /** Componente principal (main): sus instancias se pintan a partir de él. */
  isComponent?: true;
  /** Instancia de un componente: id del main. No guarda hijos (se resuelven desde el main). */
  instanceOf?: string;
  /** Overrides de la instancia, por ruta relativa (`<idEnMain>` o `<idInstanciaAnidada>::<id>`). */
  overrides?: Record<string, { styles?: Styles; textValue?: string; isVisible?: boolean }>;
  /** Soft delete. */
  '~'?: boolean;
}

export type PageIcon =
  | 'arrow' | 'padlock' | 'check' | 'cross' | 'info' | 'question' | 'design' | 'vector'
  | 'images' | 'table' | 'presentation' | 'blueprint' | 'swatches' | 'bar-chart'
  | 'line-chart' | 'pie-chart' | 'junk';

export const PAGE_ICONS: PageIcon[] = [
  'arrow', 'padlock', 'check', 'cross', 'info', 'question', 'design', 'vector', 'images',
  'table', 'presentation', 'blueprint', 'swatches', 'bar-chart', 'line-chart', 'pie-chart', 'junk',
];

export interface Page {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  canvasColor?: string;
  icon?: PageIcon;
  /** Separador visual en la lista de páginas (no tiene canvas). */
  isDivider?: boolean;
  '~'?: boolean;
}

export type TokenType =
  | 'breakpoint' | 'color' | 'container' | 'fontFamily' | 'fontSize' | 'fontWeight'
  | 'letterSpacing' | 'lineHeight' | 'opacity' | 'radius' | 'spacing';

export const TOKEN_TYPES: TokenType[] = [
  'breakpoint', 'color', 'container', 'fontFamily', 'fontSize', 'fontWeight',
  'letterSpacing', 'lineHeight', 'opacity', 'radius', 'spacing',
];

/** Orden de presentación de tipos en `get_tokens`. */
export const TOKEN_TYPE_ORDER: TokenType[] = [
  'color', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'opacity',
  'breakpoint', 'container', 'spacing', 'radius',
];

export interface Token {
  id: string; // "t:<n>-<c>"
  type: TokenType;
  sortKey: string;
  /** Nombre sin el prefijo `--`. */
  name: string;
  description?: string;
  /**
   * Valor CSS canónico (string) o número (px / ratio según tipo), o id de otro token (alias).
   */
  value: string | number;
  modes?: Record<string, string | number>;
  '~'?: boolean;
}

export interface ImageInfo {
  id: string;
  status: 'uploading' | 'ready' | 'error';
  name?: string;
  extension: string;
  width?: number;
  height?: number;
  /** URL servida por Moki (`/file-assets/<fileId>/<id>.<ext>`). */
  url: string;
  /** URL original si vino de la red. */
  sourceUrl?: string;
}

export interface MokiFile {
  id: string; // ULID
  name: string;
  folderId?: string | null;
  createdAt: number;
  updatedAt: number;
  schema: number;
  pages: Page[];
  nodes: Record<string, TreeNode>;
  nodeRelationships: Record<string, string>;
  counter: { pages: number; nodes: number; tokens: number; modes: number };
  labelCounter: Record<string, number>;
  theme: { tokens: Record<string, Token>; modes: Record<string, { id: string; name: string }> };
  images: Record<string, ImageInfo>;
}

// ---------------------------------------------------------------------------
// Ediciones (JSON-patch simplificado). `path` es relativo al fichero: "/nodes/1-0/styles/width".

export type Edit =
  | { path: string; type: 'add'; value: unknown }
  | { path: string; type: 'update'; value: unknown }
  | { path: string; type: 'remove' }
  | { path: string; type: 'splice'; index: number; removedCount: number; added: unknown[] };

// ---------------------------------------------------------------------------
// Comentarios (no viven en el documento; los guarda el servidor aparte).

export interface CommentMessage {
  id: string;
  userId: string;
  text: string;
  mentions: string[];
  reactions: { userId: string; emoji: string }[];
  attachments: { url: string; type: 'image' | 'video' | 'file'; name?: string }[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface CommentThread {
  id: string;
  fileId: string;
  pageId: string;
  nodeId: string;
  xOffset: number;
  yOffset: number;
  status: 'open' | 'resolved';
  userId: string;
  messages: CommentMessage[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

// ---------------------------------------------------------------------------
// Recursos (dashboard).

export interface FolderInfo {
  id: string;
  name: string;
  parentId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FileSummary {
  id: string;
  name: string;
  folderId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Usuario local único. Moki es mono-usuario; varias pestañas = varios clientes. */
export const LOCAL_USER = { id: 'local-user', name: 'Tú' } as const;
