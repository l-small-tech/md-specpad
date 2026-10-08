/**
 * PDF vocabulary and the pure logic behind the PDF tab's Review mode: which
 * paths are PDFs, the zoom menu, the page-number field, and the document
 * outline flattened for the Outline panel.
 *
 * A PDF opens in the same tab kind as the import card (`kind: 'import'`, see
 * core/types.ts) and is routed to the PDF viewer by this extension check, the
 * way audio rides on `kind: 'image'` — so the session manifest needs no new
 * kind and an older build degrades to the import card. Its document family is
 * `pdf` (core/doc-family.ts), whose one mode is Review.
 */

import { extName } from './session/plan-flush';

export function isPdfPath(path: string): boolean {
  return extName(path).toLowerCase() === '.pdf';
}

/**
 * The fitted zooms pdf.js understands as a `currentScaleValue`. `auto` is
 * page-width capped at 125 % — the size a page reads well at in a wide window
 * without turning into a poster.
 */
export const PDF_FIT_ZOOMS = ['auto', 'page-width', 'page-fit', 'page-actual'] as const;

export type PdfFitZoom = (typeof PDF_FIT_ZOOMS)[number];

/** The fixed percentages the zoom menu offers below the fitted ones. */
export const PDF_ZOOM_PERCENTS = [50, 75, 100, 125, 150, 200, 300, 400] as const;

/** pdf.js clamps to this range too (MIN_SCALE / MAX_SCALE in pdf_viewer). */
export const PDF_MIN_SCALE = 0.1;
export const PDF_MAX_SCALE = 10;

const FIT_LABELS: Record<PdfFitZoom, string> = {
  auto: 'Automatic',
  'page-width': 'Fit width',
  'page-fit': 'Fit page',
  'page-actual': 'Actual size',
};

export function isFitZoom(value: string): value is PdfFitZoom {
  return (PDF_FIT_ZOOMS as readonly string[]).includes(value);
}

export function fitZoomLabel(value: PdfFitZoom): string {
  return FIT_LABELS[value];
}

/** `1.25` → `125%` — the readout beside the zoom buttons. */
export function zoomPercentLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * The page the user typed into the page field, or null when it is not a page
 * of this document. Leading/trailing space is forgiven; anything that is not a
 * whole number in 1..pages is not.
 */
export function parsePageInput(text: string, pages: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const page = Number(trimmed);
  return page >= 1 && page <= pages ? page : null;
}

/**
 * One node of pdf.js `getOutline()` — only the fields this app reads. `dest`
 * is opaque here (a named destination string or an explicit array); the
 * viewer hands it back to pdf.js's link service untouched.
 */
export interface PdfOutlineNode {
  readonly title: string;
  readonly dest?: unknown;
  readonly url?: string | null;
  readonly items?: readonly PdfOutlineNode[];
}

/** A row of the Outline panel. `level` is 1-based, like a markdown heading's. */
export interface PdfOutlineEntry {
  readonly title: string;
  readonly level: number;
  readonly dest: unknown;
  readonly url: string | null;
}

/**
 * Depth-first flattening of the bookmark tree into indented rows — the same
 * shape the Outline panel draws markdown headings in. Titles are collapsed to
 * one line (PDF producers love embedded newlines and runs of spaces); levels
 * are capped so a pathologically deep tree cannot indent off the panel.
 */
export function flattenPdfOutline(
  nodes: readonly PdfOutlineNode[] | null | undefined,
  maxLevel = 6,
): PdfOutlineEntry[] {
  const out: PdfOutlineEntry[] = [];
  const walk = (list: readonly PdfOutlineNode[], level: number): void => {
    for (const node of list) {
      out.push({
        title: node.title.replace(/\s+/g, ' ').trim(),
        level: Math.min(level, maxLevel),
        dest: node.dest ?? null,
        url: node.url ?? null,
      });
      if (node.items && node.items.length > 0) {
        walk(node.items, level + 1);
      }
    }
  };
  walk(nodes ?? [], 1);
  return out;
}

/**
 * pdf.js find-controller states (`FindState` in pdf_viewer), mirrored so the
 * find bar's text is pure and testable.
 */
export const PdfFindState = {
  FOUND: 0,
  NOT_FOUND: 1,
  WRAPPED: 2,
  PENDING: 3,
} as const;

/** The find bar's status text. Empty while there is nothing to say. */
export function findStatusText(
  query: string,
  state: number | null,
  current: number,
  total: number,
): string {
  if (query.trim() === '' || state === null) {
    return '';
  }
  if (state === PdfFindState.PENDING && total === 0) {
    return 'Searching…';
  }
  if (state === PdfFindState.NOT_FOUND || total === 0) {
    return 'No matches';
  }
  return `${Math.max(current, 1)} of ${total}`;
}
