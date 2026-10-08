/**
 * Diff layout — everything the DiffView decides about WHICH rows to draw and
 * WHERE the changes are, kept pure so it is tested here instead of in the
 * component. No DOM, no React.
 *
 *   - `buildUnifiedRows(rows)` — the inline (single-column) view: each block
 *     of changed side-by-side rows becomes all of its removed lines, then all
 *     of its added lines (VS Code's inline order), intra-line ranges kept.
 *   - `sideRowChange` / `unifiedRowChange` — one `RowChange` per row, the
 *     common currency of the functions below, so both views share them.
 *   - `changeBlocks(rows)` — maximal runs of changed rows: what ↑/↓ steps
 *     through and what the overview ruler marks.
 *   - `foldRows(rows, expansions)` — long runs of unchanged rows collapse to
 *     one "⋯ N unchanged lines" bar, keeping `context` rows next to each
 *     change. A fold is keyed by the OLD line number its unchanged run starts
 *     at, which is the same in both views — so an expansion survives an
 *     inline ⇄ side-by-side switch.
 *   - `rulerMarks(blocks, segments)` — each block's position as a fraction of
 *     the drawn height, counting a fold bar as one row.
 *   - `stepChange(blocks, from, dir)` — the next / previous block, wrapping.
 */

import type { DiffRow } from './diff';

/** A row of the inline view. */
export interface UnifiedRow {
  kind: 'equal' | 'del' | 'ins';
  /** 1-based line numbers; null on the side the row does not exist in. */
  oldNum: number | null;
  newNum: number | null;
  text: string;
  /** Intra-line changed char range `[start, end)`, as in `DiffSide.hi`. */
  hi: [number, number] | null;
}

/** What a drawn row shows: nothing changed, a removal, an addition, or (a
 *  side-by-side row pairing the two) a modification. */
export type RowChange = 'none' | 'del' | 'ins' | 'mod';

/** The two facts the layout needs about a row of either view. */
export interface LayoutRow {
  change: RowChange;
  /** The row's old-side line number (always set on unchanged rows). */
  oldNum: number | null;
}

export function sideRowChange(row: DiffRow): RowChange {
  const del = row.left?.changed ?? false;
  const ins = row.right?.changed ?? false;
  if (del && ins) {
    return 'mod';
  }
  return del ? 'del' : ins ? 'ins' : 'none';
}

export function unifiedRowChange(row: UnifiedRow): RowChange {
  return row.kind === 'equal' ? 'none' : row.kind;
}

export function sideLayoutRows(rows: readonly DiffRow[]): LayoutRow[] {
  return rows.map((row) => ({ change: sideRowChange(row), oldNum: row.left?.num ?? null }));
}

export function unifiedLayoutRows(rows: readonly UnifiedRow[]): LayoutRow[] {
  return rows.map((row) => ({ change: unifiedRowChange(row), oldNum: row.oldNum }));
}

/** Side-by-side rows → inline rows. */
export function buildUnifiedRows(rows: readonly DiffRow[]): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (sideRowChange(row) === 'none') {
      out.push({
        kind: 'equal',
        oldNum: row.left?.num ?? null,
        newNum: row.right?.num ?? null,
        text: row.left?.text ?? row.right?.text ?? '',
        hi: null,
      });
      i += 1;
      continue;
    }
    let end = i;
    while (end < rows.length && sideRowChange(rows[end]!) !== 'none') {
      end += 1;
    }
    for (let j = i; j < end; j += 1) {
      const left = rows[j]!.left;
      if (left) {
        out.push({ kind: 'del', oldNum: left.num, newNum: null, text: left.text, hi: left.hi });
      }
    }
    for (let j = i; j < end; j += 1) {
      const right = rows[j]!.right;
      if (right) {
        out.push({ kind: 'ins', oldNum: null, newNum: right.num, text: right.text, hi: right.hi });
      }
    }
    i = end;
  }
  return out;
}

/* ------------------------------ change blocks ----------------------------- */

/** A maximal run of changed rows `[start, end)`. `kind` is 'mod' when the
 *  run both removes and adds. */
export interface ChangeBlock {
  start: number;
  end: number;
  kind: 'del' | 'ins' | 'mod';
}

export function changeBlocks(rows: readonly LayoutRow[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.change === 'none') {
      i += 1;
      continue;
    }
    const start = i;
    let del = false;
    let ins = false;
    while (i < rows.length && rows[i]!.change !== 'none') {
      const c = rows[i]!.change;
      del ||= c === 'del' || c === 'mod';
      ins ||= c === 'ins' || c === 'mod';
      i += 1;
    }
    blocks.push({ start, end: i, kind: del && ins ? 'mod' : del ? 'del' : 'ins' });
  }
  return blocks;
}

/**
 * The block to move to from row `from` (a fractional row is fine: pass
 * `top - 0.5` so a block starting exactly at the viewport top counts as
 * "next"). Forward takes the first block starting after `from`, backward the
 * last one starting before it; both wrap around. Null when there are none.
 */
export function stepChange(
  blocks: readonly ChangeBlock[],
  from: number,
  dir: 1 | -1,
): number | null {
  if (blocks.length === 0) {
    return null;
  }
  if (dir === 1) {
    const next = blocks.findIndex((b) => b.start > from);
    return next === -1 ? 0 : next;
  }
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]!.start < from) {
      return i;
    }
  }
  return blocks.length - 1;
}

/* --------------------------------- folding -------------------------------- */

export interface FoldOptions {
  /** Unchanged rows kept visible next to each change. */
  context: number;
  /** A run hides only when at least this many rows would go — folding two
   *  lines behind a bar saves nothing. */
  minHidden: number;
}

export const DEFAULT_FOLD: FoldOptions = { context: 3, minHidden: 5 };

/** Rows revealed at the top / bottom edge of a fold. `Infinity` = all. */
export interface FoldExpansion {
  top: number;
  bottom: number;
}

export type FoldExpansions = Readonly<Record<string, FoldExpansion>>;

export type DiffSegment =
  | { type: 'rows'; start: number; end: number }
  /** Hidden rows `[start, end)`; `key` identifies the fold for expansion. */
  | { type: 'fold'; key: string; start: number; end: number };

/**
 * Cut `rows` into drawn runs and folds. Changed rows are never folded. A
 * diff with no change at all folds nothing — there would be nothing left to
 * look at.
 */
export function foldRows(
  rows: readonly LayoutRow[],
  expansions: FoldExpansions = {},
  options: FoldOptions = DEFAULT_FOLD,
): DiffSegment[] {
  const n = rows.length;
  const segments: DiffSegment[] = [];
  const pushRows = (start: number, end: number): void => {
    if (end <= start) {
      return;
    }
    const last = segments[segments.length - 1];
    if (last && last.type === 'rows' && last.end === start) {
      last.end = end;
    } else {
      segments.push({ type: 'rows', start, end });
    }
  };
  if (!rows.some((r) => r.change !== 'none')) {
    pushRows(0, n);
    return segments;
  }
  let i = 0;
  while (i < n) {
    if (rows[i]!.change !== 'none') {
      const start = i;
      while (i < n && rows[i]!.change !== 'none') {
        i += 1;
      }
      pushRows(start, i);
      continue;
    }
    const runStart = i;
    while (i < n && rows[i]!.change === 'none') {
      i += 1;
    }
    const runEnd = i;
    const key = String(rows[runStart]!.oldNum ?? `r${runStart}`);
    const exp = expansions[key] ?? { top: 0, bottom: 0 };
    const hideStart = Math.min(
      runEnd,
      runStart + (runStart > 0 ? options.context : 0) + Math.max(0, exp.top),
    );
    const hideEnd = Math.max(
      hideStart,
      runEnd - (runEnd < n ? options.context : 0) - Math.max(0, exp.bottom),
    );
    if (hideEnd - hideStart < options.minHidden) {
      pushRows(runStart, runEnd);
      continue;
    }
    pushRows(runStart, hideStart);
    segments.push({ type: 'fold', key, start: hideStart, end: hideEnd });
    pushRows(hideEnd, runEnd);
  }
  return segments;
}

/** Reveal a fold: all of it, or `step` more rows at its top or bottom edge. */
export function expandFold(
  expansions: FoldExpansions,
  key: string,
  how: 'all' | 'top' | 'bottom',
  step = 20,
): FoldExpansions {
  const cur = expansions[key] ?? { top: 0, bottom: 0 };
  const next: FoldExpansion =
    how === 'all'
      ? { top: Infinity, bottom: cur.bottom }
      : how === 'top'
        ? { top: cur.top + step, bottom: cur.bottom }
        : { top: cur.top, bottom: cur.bottom + step };
  return { ...expansions, [key]: next };
}

/* ------------------------------ overview ruler ---------------------------- */

/** Drawn height of a layout, in rows (a fold bar counts as one). */
export function drawnRows(segments: readonly DiffSegment[]): number {
  let total = 0;
  for (const s of segments) {
    total += s.type === 'rows' ? s.end - s.start : 1;
  }
  return total;
}

/** Drawn row index of row `row` (a hidden row maps to its fold bar). */
export function drawnIndex(segments: readonly DiffSegment[], row: number): number {
  let at = 0;
  for (const s of segments) {
    if (row < s.end) {
      return s.type === 'rows' ? at + Math.max(0, row - s.start) : at;
    }
    at += s.type === 'rows' ? s.end - s.start : 1;
  }
  return at;
}

export interface RulerMark {
  /** Index into the blocks list. */
  block: number;
  kind: ChangeBlock['kind'];
  /** Fractions of the drawn height, in [0, 1]. */
  top: number;
  height: number;
}

export function rulerMarks(
  blocks: readonly ChangeBlock[],
  segments: readonly DiffSegment[],
): RulerMark[] {
  const total = drawnRows(segments);
  if (total === 0) {
    return [];
  }
  return blocks.map((b, block) => {
    const top = drawnIndex(segments, b.start);
    return { block, kind: b.kind, top: top / total, height: (b.end - b.start) / total };
  });
}
