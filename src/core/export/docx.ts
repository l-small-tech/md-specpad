/**
 * Markdown → DOCX conversion (pure; invariant I9 — no DOM, no Tauri, no
 * React). Parses with the SAME remark/GFM grammar as the preview pipeline
 * (`src/preview/pipeline.ts`), then maps the mdast tree onto `docx` document
 * objects — so what exports is what the preview parses. Raw HTML in the
 * source is skipped, mirroring the preview's sanitizer (invariant I6).
 *
 * Images are inline nodes whose bytes/dimensions the caller supplies through
 * `resolveImage` (measuring an image needs a DOM `Image`, which the ui layer
 * has and this module must not touch). An unresolved image degrades to its
 * alt text, exactly like a broken <img> would read.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { IImageOptions, ParagraphChild } from 'docx';
import type { Definition, List, PhrasingContent, Root, RootContent, Table as MdTable } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/** Raster formats `docx`'s ImageRun accepts without an SVG fallback dance. */
export type DocxImageType = 'png' | 'jpg' | 'gif' | 'bmp';

/** One resolved image: bytes (raw or base64) plus intrinsic pixel dimensions. */
export interface ResolvedDocxImage {
  data: Uint8Array | string;
  type: DocxImageType;
  width: number;
  height: number;
}

export interface DocxExportOptions {
  /**
   * Resolve an image src to bytes + dimensions, or null to skip it (external
   * URLs, unsupported formats, unreadable files). Omit to skip all images.
   */
  resolveImage?: (src: string) => Promise<ResolvedDocxImage | null>;
}

/** The ImageRun type for a file path/src, or null when docx can't embed it. */
export function docxImageType(pathOrSrc: string): DocxImageType | null {
  const lower = pathOrSrc.toLowerCase();
  if (lower.endsWith('.png')) {
    return 'png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'jpg';
  }
  if (lower.endsWith('.gif')) {
    return 'gif';
  }
  if (lower.endsWith('.bmp')) {
    return 'bmp';
  }
  return null; // webp/svg/… — ImageRun has no plain raster type for these
}

/** Word's default page: 8.5in − 2×1in margins at 96dpi ≈ 624px of column. */
const MAX_IMAGE_WIDTH_PX = 620;
/** One indent step (0.5in) in twips — Word's own list-indent unit. */
const INDENT_STEP = 720;
const CODE_FONT = 'Consolas';
/** Half-points: 10pt code, matching Word's own "HTML Code" convention. */
const CODE_SIZE = 20;
const CODE_SHADING = { type: ShadingType.CLEAR, fill: 'F2F2F2' } as const;
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** Inline style flags accumulated while descending emphasis/strong/delete. */
interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  /** Inside a link — text runs take Word's built-in Hyperlink style. */
  hyperlink?: boolean;
}

/** Block-level context: active list nesting and blockquote depth. */
interface BlockState {
  listLevel: number;
  quoteDepth: number;
}

/** Mutable per-conversion state shared by the walkers. */
interface Ctx {
  opts: DocxExportOptions;
  /** Link/image reference definitions (`[id]: url`), by lowercased id. */
  definitions: Map<string, Definition>;
  /** One numbering reference per ordered list so each restarts at 1. */
  orderedRefs: string[];
}

function textRun(text: string, style: InlineStyle, extra?: object): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    style: style.hyperlink ? 'Hyperlink' : undefined,
    ...extra,
  });
}

async function imageRun(
  src: string,
  alt: string,
  style: InlineStyle,
  ctx: Ctx,
): Promise<ParagraphChild> {
  const resolved = ctx.opts.resolveImage ? await ctx.opts.resolveImage(src) : null;
  if (!resolved || resolved.width <= 0 || resolved.height <= 0) {
    return textRun(alt || src, { ...style, italics: true });
  }
  const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / resolved.width);
  return new ImageRun({
    // The union type wants the exact literal per format; the options are
    // shape-identical for every raster type, so one cast keeps this generic.
    type: resolved.type,
    data: resolved.data,
    transformation: {
      width: Math.round(resolved.width * scale),
      height: Math.round(resolved.height * scale),
    },
  } as IImageOptions);
}

/** Phrasing content → docx runs (text, links, images, breaks). */
async function runsFrom(
  nodes: PhrasingContent[],
  style: InlineStyle,
  ctx: Ctx,
): Promise<ParagraphChild[]> {
  const out: ParagraphChild[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        // Soft line breaks inside a paragraph collapse to spaces, as in HTML.
        out.push(textRun(node.value.replaceAll('\n', ' '), style));
        break;
      case 'strong':
        out.push(...(await runsFrom(node.children, { ...style, bold: true }, ctx)));
        break;
      case 'emphasis':
        out.push(...(await runsFrom(node.children, { ...style, italics: true }, ctx)));
        break;
      case 'delete':
        out.push(...(await runsFrom(node.children, { ...style, strike: true }, ctx)));
        break;
      case 'inlineCode':
        out.push(textRun(node.value, style, { font: CODE_FONT, shading: CODE_SHADING }));
        break;
      case 'break':
        out.push(new TextRun({ break: 1 }));
        break;
      case 'link': {
        const children = await runsFrom(node.children, { ...style, hyperlink: true }, ctx);
        out.push(new ExternalHyperlink({ children, link: node.url }));
        break;
      }
      case 'linkReference': {
        const def = ctx.definitions.get(node.identifier.toLowerCase());
        if (def) {
          const children = await runsFrom(node.children, { ...style, hyperlink: true }, ctx);
          out.push(new ExternalHyperlink({ children, link: def.url }));
        } else {
          out.push(...(await runsFrom(node.children, style, ctx)));
        }
        break;
      }
      case 'image':
        out.push(await imageRun(node.url, node.alt ?? '', style, ctx));
        break;
      case 'imageReference': {
        const def = ctx.definitions.get(node.identifier.toLowerCase());
        out.push(
          def
            ? await imageRun(def.url, node.alt ?? '', style, ctx)
            : textRun(node.alt ?? node.identifier, { ...style, italics: true }),
        );
        break;
      }
      case 'footnoteReference':
        out.push(textRun(`[${node.identifier}]`, style, { superScript: true }));
        break;
      default:
        // Raw HTML — dropped, mirroring the preview sanitizer (I6).
        break;
    }
  }
  return out;
}

/** Paragraph options shared by quote/list placement. */
function blockOpts(state: BlockState): {
  indent?: { left: number };
  border?: object;
} {
  if (state.quoteDepth <= 0) {
    return {};
  }
  return {
    indent: { left: INDENT_STEP * state.quoteDepth },
    border: {
      left: { style: BorderStyle.SINGLE, size: 18, color: 'BBBBBB', space: 8 },
    },
  };
}

/** A fenced code block → one shaded monospace paragraph per line. */
function codeBlock(value: string, state: BlockState): Paragraph[] {
  const lines = value.split('\n');
  return lines.map(
    (line, i) =>
      new Paragraph({
        children: [new TextRun({ text: line, font: CODE_FONT, size: CODE_SIZE })],
        shading: CODE_SHADING,
        spacing: { before: 0, after: i === lines.length - 1 ? 120 : 0 },
        ...blockOpts(state),
      }),
  );
}

async function tableFrom(node: MdTable, ctx: Ctx): Promise<Table> {
  // GFM lets a body row have fewer or more cells than the header. Square every
  // row to the header, as the preview does — pad a short row with empty cells,
  // drop cells past the header's count — rather than write a ragged Word table.
  const columns = Math.max(1, node.children[0]?.children.length ?? 1);
  const rows: TableRow[] = [];
  for (const [rowIndex, row] of node.children.entries()) {
    const cells: TableCell[] = [];
    for (const cell of row.children.slice(0, columns)) {
      const style: InlineStyle = rowIndex === 0 ? { bold: true } : {};
      cells.push(
        new TableCell({
          children: [new Paragraph({ children: await runsFrom(cell.children, style, ctx) })],
        }),
      );
    }
    while (cells.length < columns) {
      cells.push(new TableCell({ children: [new Paragraph({})] }));
    }
    rows.push(new TableRow({ children: cells, tableHeader: rowIndex === 0 }));
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

async function listBlocks(node: List, state: BlockState, ctx: Ctx): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = [];
  const level = Math.min(state.listLevel, 8);
  const ordered = node.ordered === true;
  let reference: string | undefined;
  if (ordered) {
    reference = `md-ordered-${ctx.orderedRefs.length}`;
    ctx.orderedRefs.push(reference);
  }
  for (const item of node.children) {
    let first = true;
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        let runs = await runsFrom(child.children, {}, ctx);
        if (item.checked === true || item.checked === false) {
          runs = [new TextRun({ text: item.checked ? '☑ ' : '☐ ' }), ...runs];
        }
        const marker = first
          ? ordered && reference
            ? { numbering: { reference, level } }
            : { bullet: { level } }
          : { indent: { left: INDENT_STEP * (level + 1) } };
        out.push(new Paragraph({ children: runs, ...marker }));
        first = false;
      } else if (child.type === 'list') {
        out.push(...(await listBlocks(child, { ...state, listLevel: level + 1 }, ctx)));
      } else {
        out.push(...(await blocksFrom([child], { ...state, listLevel: level + 1 }, ctx)));
        first = false;
      }
    }
  }
  return out;
}

/** Top-level (and blockquote-nested) mdast blocks → docx children. */
async function blocksFrom(
  nodes: RootContent[],
  state: BlockState,
  ctx: Ctx,
): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push(
          new Paragraph({ children: await runsFrom(node.children, {}, ctx), ...blockOpts(state) }),
        );
        break;
      case 'heading':
        out.push(
          new Paragraph({
            children: await runsFrom(node.children, {}, ctx),
            heading: HEADINGS[Math.min(node.depth, 6) - 1],
            ...blockOpts(state),
          }),
        );
        break;
      case 'code':
        out.push(...codeBlock(node.value, state));
        break;
      case 'blockquote':
        out.push(
          ...(await blocksFrom(node.children, { ...state, quoteDepth: state.quoteDepth + 1 }, ctx)),
        );
        break;
      case 'list':
        out.push(...(await listBlocks(node, state, ctx)));
        break;
      case 'table':
        out.push(await tableFrom(node, ctx));
        break;
      case 'thematicBreak':
        out.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB' } },
            spacing: { before: 120, after: 120 },
          }),
        );
        break;
      case 'footnoteDefinition': {
        // Rendered in place as "[id] …" — Word's real footnote machinery is
        // more than a notepad's markdown needs.
        const [first, ...rest] = node.children;
        if (first?.type === 'paragraph') {
          out.push(
            new Paragraph({
              children: [
                textRun(`[${node.identifier}] `, {}),
                ...(await runsFrom(first.children, {}, ctx)),
              ],
              ...blockOpts(state),
            }),
          );
          out.push(...(await blocksFrom(rest, state, ctx)));
        } else {
          out.push(new Paragraph({ children: [textRun(`[${node.identifier}]`, {})] }));
          out.push(...(await blocksFrom(node.children, state, ctx)));
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
 * Convert `markdown` to a complete .docx file, returned base64-encoded
 * (ready for `ipc.writeFileBase64`). Never rejects on content it can't map —
 * unsupported constructs degrade (images → alt text, HTML → dropped).
 */
export async function markdownToDocxBase64(
  markdown: string,
  opts: DocxExportOptions = {},
): Promise<string> {
  const root = parser.parse(markdown) as Root;
  const ctx: Ctx = { opts, definitions: collectDefinitions(root), orderedRefs: [] };
  const children = await blocksFrom(root.children, { listLevel: 0, quoteDepth: 0 }, ctx);

  const doc = new Document({
    numbering: {
      config: ctx.orderedRefs.map((reference) => ({
        reference,
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: {
            paragraph: {
              indent: { left: INDENT_STEP * (level + 1), hanging: INDENT_STEP / 2 },
            },
          },
        })),
      })),
    },
    sections: [{ children }],
  });
  return Packer.toBase64String(doc);
}
