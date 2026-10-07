/**
 * Markdown → PDF conversion (pure; invariant I9 — no DOM, no Tauri, no
 * React). Parses with the SAME remark/GFM grammar as the preview pipeline
 * and maps the mdast tree onto a pdfmake document definition — the same
 * walker shape as the DOCX converter (`docx.ts`), so the two exports degrade
 * identically (raw HTML dropped per invariant I6, unresolved images → alt
 * text, footnotes rendered in place). No print dialog is involved: pdfmake
 * generates the PDF bytes directly, so this path works on Android too.
 *
 * The document definition is built by `markdownToPdfDocDef` with no pdfmake
 * import at all — it is plain data (plus pdfmake layout callbacks), fully
 * testable in node. `markdownToPdfBase64` feeds it to a lazily-imported
 * pdfmake (Roboto from vfs_fonts for text, the standard-14 Courier for code).
 *
 * Fonts: the standard-14 Courier is WinAnsi-encoded — pdfkit THROWS on any
 * character it can't encode — so every mono-routed run goes through
 * `monoFont()`, which falls back to Roboto for non-Latin text (the run loses
 * mono rendering; it never crashes the export).
 *
 * Theming: a `PdfTheme` (derived from a theme plugin via `pdfThemeFromPlugin`)
 * colors the page, text, headings, links, code and rules — mirroring what the
 * injected CSS variables do to the HTML export. Embedded SVG images are the
 * one thing this file does NOT color: the resolver hands over final markup, so
 * whether a diagram is recolored is the caller's call (`export/svg-theme`).
 */

import type { Definition, List, PhrasingContent, Root, RootContent, Table as MdTable } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { ThemePlugin } from '../theme-plugins';

/** Raster formats pdfmake embeds (pdfkit decodes PNG and JPEG only). */
export type PdfImageType = 'png' | 'jpg';

/** One resolved raster image: a data: URL plus intrinsic pixel dimensions. */
export interface ResolvedPdfImage {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * One resolved vector image: SVG markup plus the size to draw it at. pdfmake
 * draws SVG natively (svg-to-pdfkit), so a diagram stays crisp instead of
 * degrading to alt text — and the caller can hand over themed markup
 * (`core/export/svg-theme`) so it matches the page.
 */
export interface ResolvedPdfSvg {
  svg: string;
  width: number;
  height: number;
}

/** Whatever an image src resolved to: raster bytes or vector markup. */
export type ResolvedPdfArt = ResolvedPdfImage | ResolvedPdfSvg;

/** Colors applied across the generated document. All values are hex. */
export interface PdfTheme {
  /** Page background; `#ffffff` skips the background layer entirely. */
  pageBg: string;
  fg: string;
  muted: string;
  border: string;
  /** Heading color per level (h1…h6). */
  headings: [string, string, string, string, string, string];
  link: string;
  codeFg: string;
  codeBg: string;
}

export interface PdfExportOptions {
  /** Document title, stamped into the PDF's metadata. */
  title?: string;
  /** Omit for the neutral print-like default (white page, near-black ink). */
  theme?: PdfTheme;
  /**
   * Resolve an image src to a data: URL (raster) or SVG markup (vector) plus
   * dimensions, or null to skip it (external URLs, unsupported formats,
   * unreadable files). Omit to skip all images.
   */
  resolveImage?: (src: string) => Promise<ResolvedPdfArt | null>;
}

/** True for an SVG path/src — pdfmake draws these as vector, not as an image. */
export function isPdfSvg(pathOrSrc: string): boolean {
  return pathOrSrc.toLowerCase().endsWith('.svg');
}

/** The embed type for a file path/src, or null when pdfkit can't decode it. */
export function pdfImageType(pathOrSrc: string): PdfImageType | null {
  const lower = pathOrSrc.toLowerCase();
  if (lower.endsWith('.png')) {
    return 'png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'jpg';
  }
  return null; // gif/bmp/webp/… — pdfkit has no decoder for these (svg is vector)
}

/** Neutral print-like defaults: white paper, near-black ink, Word-blue links. */
export const DEFAULT_PDF_THEME: PdfTheme = {
  pageBg: '#ffffff',
  fg: '#1a1a1a',
  muted: '#666666',
  border: '#bbbbbb',
  headings: ['#1a1a1a', '#1a1a1a', '#1a1a1a', '#1a1a1a', '#1a1a1a', '#1a1a1a'],
  link: '#0563c1',
  codeFg: '#1a1a1a',
  codeBg: '#f2f2f2',
};

/** pdfkit wants hex; theme plugins may hold `rgb()`/named colors — refuse those. */
function hexOr(fallback: string, ...candidates: (string | undefined)[]): string {
  for (const value of candidates) {
    if (value !== undefined && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())) {
      return value.trim();
    }
  }
  return fallback;
}

/**
 * A `PdfTheme` from a theme plugin's branding, mirroring the CSS fallback
 * chains of the HTML export (`--md-heading1 → --md-heading → --fg`, `--md-link
 * → --accent`, …). Non-hex values (plugins allow any safe CSS color) fall back
 * to the neutral default for that slot. `null` returns the default theme.
 */
export function pdfThemeFromPlugin(plugin: ThemePlugin | null): PdfTheme {
  if (!plugin) {
    return DEFAULT_PDF_THEME;
  }
  const d = DEFAULT_PDF_THEME;
  const palette = plugin.branding;
  const syntax = plugin.syntax;
  const fg = hexOr(d.fg, palette.fg);
  const headingBase = hexOr(fg, syntax?.heading);
  const headingKeys = [
    syntax?.heading1,
    syntax?.heading2,
    syntax?.heading3,
    syntax?.heading4,
    syntax?.heading5,
    syntax?.heading6,
  ];
  return {
    pageBg: hexOr(d.pageBg, palette.editorBg, palette.bg),
    fg,
    muted: hexOr(d.muted, palette.fgMuted),
    border: hexOr(d.border, palette.border),
    headings: headingKeys.map((key) => hexOr(headingBase, key)) as PdfTheme['headings'],
    link: hexOr(d.link, syntax?.link, palette.accent),
    codeFg: hexOr(fg, syntax?.code),
    codeBg: hexOr(d.codeBg, palette.bgAlt),
  };
}

/* ---- Document-definition building types ----------------------------------
   Structural (not imported from pdfmake) so the builder stays pure data and
   the test suite can assert on it without pdfmake in the loop. The final
   definition is shape-compatible with pdfmake's TDocumentDefinitions. */

export interface PdfRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
  decoration?: 'lineThrough' | 'underline';
  color?: string;
  background?: string;
  font?: string;
  link?: string;
  sup?: boolean;
}

/** A block of the generated document (paragraph, list, table, canvas, …). */
export type PdfBlock = Record<string, unknown>;

export interface PdfDocDef {
  info: { title: string };
  pageSize: 'A4';
  pageMargins: [number, number, number, number];
  defaultStyle: { font: string; fontSize: number; lineHeight: number; color: string };
  background?: (currentPage: number, pageSize: { width: number; height: number }) => PdfBlock;
  content: PdfBlock[];
}

const BODY_SIZE = 10.5;
/** Heading font sizes for h1…h6 (pt). */
const HEADING_SIZES = [24, 20, 16, 14, 12, 11] as const;
const CODE_SIZE = 9.5;
/** A4 content width: 595.28pt − 2×40pt margins. */
const CONTENT_WIDTH = 515;
/** CSS px → pt (96dpi → 72dpi). */
const PX_TO_PT = 0.75;
const PARA_SPACING: [number, number, number, number] = [0, 0, 0, 8];

/**
 * The characters WinAnsi (the standard-14 fonts' encoding) covers: ASCII,
 * Latin-1, and the handful of typographic marks Windows-1252 squeezes into
 * 0x80–0x9F. Anything else must NOT reach Courier — pdfkit throws.
 */
const WINANSI_ONLY = new RegExp(
  '^[\\u0020-\\u007E\\u00A0-\\u00FF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192' +
    '\\u02C6\\u02DC\\u2013\\u2014\\u2018\\u2019\\u201A\\u201C\\u201D\\u201E\\u2020\\u2021' +
    '\\u2022\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122]*$',
);

/** Courier when WinAnsi can encode `text`; Roboto (losing mono) otherwise. */
export function monoFont(text: string): 'Courier' | 'Roboto' {
  return WINANSI_ONLY.test(text) ? 'Courier' : 'Roboto';
}

/** Inline style flags accumulated while descending emphasis/strong/delete. */
interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  /** Inside a link — runs take the link color + underline + this target. */
  link?: string;
}

/** Mutable per-conversion state shared by the walkers. */
interface Ctx {
  opts: PdfExportOptions;
  theme: PdfTheme;
  /** Link/image reference definitions (`[id]: url`), by lowercased id. */
  definitions: Map<string, Definition>;
}

function run(text: string, style: InlineStyle, ctx: Ctx, extra?: Partial<PdfRun>): PdfRun {
  const out: PdfRun = { text };
  if (style.bold) {
    out.bold = true;
  }
  if (style.italics) {
    out.italics = true;
  }
  // pdfmake's `decoration` is single-valued; strikethrough beats the link
  // underline when both apply (the color still marks it as a link).
  if (style.strike) {
    out.decoration = 'lineThrough';
  } else if (style.link !== undefined) {
    out.decoration = 'underline';
  }
  if (style.link !== undefined) {
    out.link = style.link;
    out.color = ctx.theme.link;
  }
  return { ...out, ...extra };
}

async function imageBlockOrRun(
  src: string,
  alt: string,
  style: InlineStyle,
  ctx: Ctx,
): Promise<PdfRun | PdfBlock> {
  const resolved = ctx.opts.resolveImage ? await ctx.opts.resolveImage(src) : null;
  if (!resolved || resolved.width <= 0 || resolved.height <= 0) {
    return run(alt || src, { ...style, italics: true }, ctx);
  }
  const width = Math.min(Math.round(resolved.width * PX_TO_PT), CONTENT_WIDTH);
  return 'svg' in resolved
    ? { svg: resolved.svg, width, margin: [0, 4, 0, 8] }
    : { image: resolved.dataUrl, width, margin: [0, 4, 0, 8] };
}

/**
 * Phrasing content → pdfmake runs. Images inside a paragraph are emitted as
 * separate blocks via `extraBlocks` (pdfmake has no inline images), appearing
 * directly after the paragraph — same reading order, block presentation.
 */
async function runsFrom(
  nodes: PhrasingContent[],
  style: InlineStyle,
  ctx: Ctx,
  extraBlocks: PdfBlock[],
): Promise<PdfRun[]> {
  const out: PdfRun[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        // Soft line breaks inside a paragraph collapse to spaces, as in HTML.
        out.push(run(node.value.replaceAll('\n', ' '), style, ctx));
        break;
      case 'strong':
        out.push(...(await runsFrom(node.children, { ...style, bold: true }, ctx, extraBlocks)));
        break;
      case 'emphasis':
        out.push(...(await runsFrom(node.children, { ...style, italics: true }, ctx, extraBlocks)));
        break;
      case 'delete':
        out.push(...(await runsFrom(node.children, { ...style, strike: true }, ctx, extraBlocks)));
        break;
      case 'inlineCode':
        out.push(
          run(node.value, style, ctx, {
            font: monoFont(node.value),
            background: ctx.theme.codeBg,
            color: style.link !== undefined ? ctx.theme.link : ctx.theme.codeFg,
          }),
        );
        break;
      case 'break':
        out.push({ text: '\n' });
        break;
      case 'link':
        out.push(
          ...(await runsFrom(node.children, { ...style, link: node.url }, ctx, extraBlocks)),
        );
        break;
      case 'linkReference': {
        const def = ctx.definitions.get(node.identifier.toLowerCase());
        const linked: InlineStyle = def ? { ...style, link: def.url } : style;
        out.push(...(await runsFrom(node.children, linked, ctx, extraBlocks)));
        break;
      }
      case 'image': {
        const block = await imageBlockOrRun(node.url, node.alt ?? '', style, ctx);
        if ('text' in block) {
          out.push(block as PdfRun);
        } else {
          extraBlocks.push(block);
        }
        break;
      }
      case 'imageReference': {
        const def = ctx.definitions.get(node.identifier.toLowerCase());
        if (!def) {
          out.push(run(node.alt ?? node.identifier, { ...style, italics: true }, ctx));
          break;
        }
        const block = await imageBlockOrRun(def.url, node.alt ?? '', style, ctx);
        if ('text' in block) {
          out.push(block as PdfRun);
        } else {
          extraBlocks.push(block);
        }
        break;
      }
      case 'footnoteReference':
        out.push(run(`[${node.identifier}]`, style, ctx, { sup: true }));
        break;
      default:
        // Raw HTML — dropped, mirroring the preview sanitizer (I6).
        break;
    }
  }
  return out;
}

/** A paragraph block plus any images that appeared inline in it. */
async function paragraphBlocks(
  nodes: PhrasingContent[],
  style: InlineStyle,
  ctx: Ctx,
  extra?: PdfBlock,
): Promise<PdfBlock[]> {
  const extraBlocks: PdfBlock[] = [];
  const runs = await runsFrom(nodes, style, ctx, extraBlocks);
  const out: PdfBlock[] = [];
  if (runs.length > 0) {
    out.push({ text: runs, margin: PARA_SPACING, ...extra });
  }
  out.push(...extraBlocks);
  return out;
}

/** A fenced code block → a one-cell filled table of monospace lines. */
function codeBlock(value: string, ctx: Ctx): PdfBlock {
  const lines = value.replaceAll('\t', '    ').split('\n');
  const stack = lines.map((line) => ({
    // A blank line still needs height — a single space keeps the row.
    text: line.length > 0 ? line : ' ',
    font: monoFont(line),
    fontSize: CODE_SIZE,
    color: ctx.theme.codeFg,
    preserveLeadingSpaces: true,
  }));
  return {
    table: { widths: ['*'], body: [[{ stack, fillColor: ctx.theme.codeBg }]] },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => 8,
      paddingBottom: () => 8,
    },
    margin: PARA_SPACING,
  };
}

/** A blockquote → a one-cell table whose layout draws only a left rule. */
function quoteBlock(children: PdfBlock[], ctx: Ctx): PdfBlock {
  return {
    table: { widths: ['*'], body: [[{ stack: children }]] },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i: number) => (i === 0 ? 3 : 0),
      vLineColor: () => ctx.theme.muted,
      paddingLeft: () => 12,
      paddingRight: () => 0,
      paddingTop: () => 2,
      paddingBottom: () => 0,
    },
    margin: PARA_SPACING,
  };
}

async function tableBlock(node: MdTable, ctx: Ctx): Promise<PdfBlock> {
  // GFM lets a body row have fewer or more cells than the header, and pdfmake
  // throws on a missing cell. Square every row to the header, as the preview
  // does: pad a short row with empty cells, drop cells past the header's count.
  const columns = Math.max(1, node.children[0]?.children.length ?? 1);
  const body: PdfBlock[][] = [];
  for (const [rowIndex, row] of node.children.entries()) {
    const cells: PdfBlock[] = [];
    for (const cell of row.children.slice(0, columns)) {
      const style: InlineStyle = rowIndex === 0 ? { bold: true } : {};
      const extraBlocks: PdfBlock[] = [];
      const runs = await runsFrom(cell.children, style, ctx, extraBlocks);
      cells.push({
        text: runs.length > 0 ? runs : ' ',
        fillColor: rowIndex === 0 ? ctx.theme.codeBg : undefined,
      });
    }
    while (cells.length < columns) {
      cells.push({ text: ' ' });
    }
    body.push(cells);
  }
  return {
    table: { headerRows: 1, widths: Array.from({ length: columns }, () => 'auto'), body },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => ctx.theme.border,
      vLineColor: () => ctx.theme.border,
    },
    margin: PARA_SPACING,
  };
}

async function listBlock(node: List, ctx: Ctx): Promise<PdfBlock> {
  const ordered = node.ordered === true;
  const items: (PdfBlock | PdfBlock[])[] = [];
  for (const item of node.children) {
    const blocks: PdfBlock[] = [];
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        const extraBlocks: PdfBlock[] = [];
        let runs = await runsFrom(child.children, {}, ctx, extraBlocks);
        if (item.checked === true || item.checked === false) {
          // Roboto has no ☑/☐ glyphs — literal markers, like GitHub's plain text.
          runs = [{ text: item.checked ? '[x] ' : '[ ] ' }, ...runs];
        }
        blocks.push({ text: runs, margin: [0, 0, 0, 2] });
        blocks.push(...extraBlocks);
      } else {
        blocks.push(...(await blocksFrom([child], ctx)));
      }
    }
    items.push(blocks.length === 1 && blocks[0] !== undefined ? blocks[0] : { stack: blocks });
  }
  const list = ordered
    ? {
        ol: items,
        ...(node.start !== null && node.start !== undefined && node.start !== 1
          ? { start: node.start }
          : {}),
      }
    : { ul: items };
  return { ...list, margin: PARA_SPACING };
}

/** Top-level (and nested) mdast blocks → pdfmake blocks. */
async function blocksFrom(nodes: RootContent[], ctx: Ctx): Promise<PdfBlock[]> {
  const out: PdfBlock[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push(...(await paragraphBlocks(node.children, {}, ctx)));
        break;
      case 'heading': {
        const level = Math.min(node.depth, 6);
        out.push(
          ...(await paragraphBlocks(node.children, { bold: true }, ctx, {
            fontSize: HEADING_SIZES[level - 1],
            color: ctx.theme.headings[level - 1],
            margin: [0, level === 1 ? 4 : 10, 0, 6],
          })),
        );
        break;
      }
      case 'code':
        out.push(codeBlock(node.value, ctx));
        break;
      case 'blockquote':
        out.push(quoteBlock(await blocksFrom(node.children, ctx), ctx));
        break;
      case 'list':
        out.push(await listBlock(node, ctx));
        break;
      case 'table':
        out.push(await tableBlock(node, ctx));
        break;
      case 'thematicBreak':
        out.push({
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: CONTENT_WIDTH,
              y2: 0,
              lineWidth: 0.5,
              lineColor: ctx.theme.border,
            },
          ],
          margin: [0, 8, 0, 8],
        });
        break;
      case 'footnoteDefinition': {
        // Rendered in place as "[id] …", mirroring the DOCX converter.
        const [first, ...rest] = node.children;
        if (first?.type === 'paragraph') {
          const extraBlocks: PdfBlock[] = [];
          const runs = await runsFrom(first.children, {}, ctx, extraBlocks);
          out.push({ text: [{ text: `[${node.identifier}] ` }, ...runs], margin: PARA_SPACING });
          out.push(...extraBlocks);
          out.push(...(await blocksFrom(rest, ctx)));
        } else {
          out.push({ text: `[${node.identifier}]`, margin: PARA_SPACING });
          out.push(...(await blocksFrom(node.children, ctx)));
        }
        break;
      }
      case 'definition':
        break; // consumed by the reference pre-pass
      default:
        break; // raw HTML / yaml — dropped (I6)
    }
  }
  return out;
}

/** Every `[id]: url` definition in the tree, keyed by lowercased identifier. */
function collectDefinitions(root: Root): Map<string, Definition> {
  const defs = new Map<string, Definition>();
  function walk(nodes: RootContent[]): void {
    for (const node of nodes) {
      if (node.type === 'definition') {
        defs.set(node.identifier.toLowerCase(), node);
      }
      if ('children' in node) {
        walk(node.children as RootContent[]);
      }
    }
  }
  walk(root.children);
  return defs;
}

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Build the pdfmake document definition for `markdown` — pure data (plus
 * pdfmake layout callbacks), no pdfmake import. Never rejects on content it
 * can't map; unsupported constructs degrade exactly like the DOCX export.
 */
export async function markdownToPdfDocDef(
  markdown: string,
  opts: PdfExportOptions = {},
): Promise<PdfDocDef> {
  const theme = opts.theme ?? DEFAULT_PDF_THEME;
  const root = parser.parse(markdown) as Root;
  const ctx: Ctx = { opts, theme, definitions: collectDefinitions(root) };
  const content = await blocksFrom(root.children, ctx);
  const def: PdfDocDef = {
    info: { title: opts.title ?? 'Document' },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { font: 'Roboto', fontSize: BODY_SIZE, lineHeight: 1.3, color: theme.fg },
    content,
  };
  if (theme.pageBg.toLowerCase() !== '#ffffff' && theme.pageBg.toLowerCase() !== '#fff') {
    def.background = (_page, pageSize) => ({
      canvas: [
        { type: 'rect', x: 0, y: 0, w: pageSize.width, h: pageSize.height, color: theme.pageBg },
      ],
    });
  }
  return def;
}

/** Roboto (embedded via vfs_fonts) + the standard-14 Courier for code. */
const FONTS = {
  Roboto: {
    normal: 'Roboto-Regular.ttf',
    bold: 'Roboto-Medium.ttf',
    italics: 'Roboto-Italic.ttf',
    bolditalics: 'Roboto-MediumItalic.ttf',
  },
  Courier: {
    normal: 'Courier',
    bold: 'Courier-Bold',
    italics: 'Courier-Oblique',
    bolditalics: 'Courier-BoldOblique',
  },
};

/**
 * Convert `markdown` to a complete PDF, returned base64-encoded (ready for
 * `ipc.writeFileBase64`). pdfmake and its ~1 MB font bundle load lazily on
 * first use — mirroring how the DOCX generator and mammoth are loaded.
 */
export async function markdownToPdfBase64(
  markdown: string,
  opts: PdfExportOptions = {},
): Promise<string> {
  const def = await markdownToPdfDocDef(markdown, opts);
  // The UMD builds export via module.exports; interop differs between Vite
  // and node, hence the `default ?? module` guards. vfs_fonts has shipped
  // both `{ pdfMake: { vfs } }`, `{ vfs }` and a bare font map across 0.2.x.
  const pdfMakeModule = (await import('pdfmake/build/pdfmake')) as unknown as Record<
    string,
    unknown
  >;
  const pdfMake = (pdfMakeModule.default ?? pdfMakeModule) as {
    createPdf: (
      def: unknown,
      tableLayouts?: unknown,
      fonts?: unknown,
      vfs?: unknown,
    ) => { getBase64: (cb: (data: string) => void) => void };
  };
  const vfsModule = (await import('pdfmake/build/vfs_fonts')) as unknown as Record<string, unknown>;
  const vfsRoot = (vfsModule.default ?? vfsModule) as Record<string, unknown>;
  const robotoVfs = ((vfsRoot.pdfMake as Record<string, unknown> | undefined)?.vfs ??
    vfsRoot.vfs ??
    vfsRoot) as Record<string, string>;
  // Passing a custom vfs REPLACES pdfmake's built-in one, which is where the
  // standard-14 font metrics live — so Courier's .afm files must come along.
  // They ship inside @foliojs-fork/pdfkit (pdfmake's own pdfkit), as raw text.
  const afms = await Promise.all([
    import('@foliojs-fork/pdfkit/js/data/Courier.afm?raw'),
    import('@foliojs-fork/pdfkit/js/data/Courier-Bold.afm?raw'),
    import('@foliojs-fork/pdfkit/js/data/Courier-Oblique.afm?raw'),
    import('@foliojs-fork/pdfkit/js/data/Courier-BoldOblique.afm?raw'),
  ]);
  const vfs: Record<string, string> = {
    ...robotoVfs,
    'data/Courier.afm': afms[0].default,
    'data/Courier-Bold.afm': afms[1].default,
    'data/Courier-Oblique.afm': afms[2].default,
    'data/Courier-BoldOblique.afm': afms[3].default,
  };
  return new Promise((resolve) => {
    pdfMake.createPdf(def, undefined, FONTS, vfs).getBase64(resolve);
  });
}
