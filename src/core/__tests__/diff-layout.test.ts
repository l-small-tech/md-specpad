import { describe, expect, test } from 'vitest';
import { buildDiffRows, diffLines } from '../diff';
import {
  buildUnifiedRows,
  changeBlocks,
  drawnIndex,
  drawnRows,
  expandFold,
  foldRows,
  rulerMarks,
  sideLayoutRows,
  stepChange,
  unifiedLayoutRows,
  type LayoutRow,
} from '../diff-layout';

function sideRows(a: string, b: string) {
  return buildDiffRows(diffLines(a, b));
}

/** `n` numbered lines, `L1`…`Ln`. */
function lines(n: number, edit?: (i: number) => string | null): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const l = edit ? edit(i) : `L${i}`;
    if (l !== null) {
      out.push(l);
    }
  }
  return out.join('\n');
}

/** Layout rows from a compact spec: '.' unchanged, '-' del, '+' ins, '~' mod. */
function spec(s: string): LayoutRow[] {
  return [...s].map((c, i) => ({
    change: c === '.' ? 'none' : c === '-' ? 'del' : c === '+' ? 'ins' : 'mod',
    oldNum: i + 1,
  }));
}

describe('buildUnifiedRows', () => {
  test('a modified pair becomes its removal then its addition, ranges kept', () => {
    const rows = buildUnifiedRows(sideRows('a\nbXc\nd', 'a\nbYc\nd'));
    expect(rows).toEqual([
      { kind: 'equal', oldNum: 1, newNum: 1, text: 'a', hi: null },
      { kind: 'del', oldNum: 2, newNum: null, text: 'bXc', hi: [1, 2] },
      { kind: 'ins', oldNum: null, newNum: 2, text: 'bYc', hi: [1, 2] },
      { kind: 'equal', oldNum: 3, newNum: 3, text: 'd', hi: null },
    ]);
  });

  test('a multi-line block lists every removal before any addition', () => {
    const rows = buildUnifiedRows(sideRows('a\nb\nc\nz', 'A\nB\nz'));
    expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
      'del:a',
      'del:b',
      'del:c',
      'ins:A',
      'ins:B',
      'equal:z',
    ]);
    expect(rows.map((r) => [r.oldNum, r.newNum])).toEqual([
      [1, null],
      [2, null],
      [3, null],
      [null, 1],
      [null, 2],
      [4, 3],
    ]);
  });

  test('pure insertions and deletions', () => {
    expect(buildUnifiedRows(sideRows('a', 'a\nb')).map((r) => r.kind)).toEqual(['equal', 'ins']);
    expect(buildUnifiedRows(sideRows('a\nb', 'b')).map((r) => r.kind)).toEqual(['del', 'equal']);
  });
});

describe('changeBlocks', () => {
  test('runs of changed rows, with their kind', () => {
    expect(changeBlocks(spec('..--..++..~-..'))).toEqual([
      { start: 2, end: 4, kind: 'del' },
      { start: 6, end: 8, kind: 'ins' },
      { start: 10, end: 12, kind: 'mod' },
    ]);
  });

  test('a run mixing removals and additions is a modification', () => {
    expect(changeBlocks(spec('-+'))).toEqual([{ start: 0, end: 2, kind: 'mod' }]);
  });

  test('side and inline layouts find the same number of blocks', () => {
    const a = lines(30);
    const b = lines(30, (i) => (i === 5 ? 'five' : i === 20 ? null : `L${i}`));
    const side = sideRows(a, b);
    expect(changeBlocks(sideLayoutRows(side))).toHaveLength(2);
    expect(changeBlocks(unifiedLayoutRows(buildUnifiedRows(side)))).toHaveLength(2);
  });
});

describe('stepChange', () => {
  const blocks = changeBlocks(spec('..-...+...-.'));
  // starts: 2, 6, 10

  test('forward takes the first block after the anchor, wrapping', () => {
    expect(stepChange(blocks, -1, 1)).toBe(0);
    expect(stepChange(blocks, 2, 1)).toBe(1);
    expect(stepChange(blocks, 5.5, 1)).toBe(1);
    expect(stepChange(blocks, 10, 1)).toBe(0);
  });

  test('backward takes the last block before the anchor, wrapping', () => {
    expect(stepChange(blocks, 10, -1)).toBe(1);
    expect(stepChange(blocks, 11, -1)).toBe(2);
    expect(stepChange(blocks, 2, -1)).toBe(2);
  });

  test('null without changes', () => {
    expect(stepChange([], 0, 1)).toBeNull();
  });
});

describe('foldRows', () => {
  test('a long unchanged run between changes folds, keeping 3 rows each side', () => {
    const rows = spec(`-${'.'.repeat(20)}+`);
    expect(foldRows(rows)).toEqual([
      { type: 'rows', start: 0, end: 4 },
      { type: 'fold', key: '2', start: 4, end: 18 },
      { type: 'rows', start: 18, end: 22 },
    ]);
  });

  test('leading and trailing runs keep context only on the change side', () => {
    const rows = spec(`${'.'.repeat(10)}-${'.'.repeat(10)}`);
    expect(foldRows(rows)).toEqual([
      { type: 'fold', key: '1', start: 0, end: 7 },
      { type: 'rows', start: 7, end: 14 },
      { type: 'fold', key: '12', start: 14, end: 21 },
    ]);
  });

  test('short runs are not folded', () => {
    // 10 unchanged rows between changes: 3 + 4 hidden + 3 → under minHidden 5.
    const rows = spec(`-${'.'.repeat(10)}-`);
    expect(foldRows(rows)).toEqual([{ type: 'rows', start: 0, end: 12 }]);
    // A short file with one change folds nothing.
    expect(foldRows(spec('...-...'))).toEqual([{ type: 'rows', start: 0, end: 7 }]);
  });

  test('a diff with no change folds nothing', () => {
    expect(foldRows(spec('.'.repeat(50)))).toEqual([{ type: 'rows', start: 0, end: 50 }]);
  });

  test('expansion reveals rows at an edge, then the whole fold', () => {
    const rows = spec(`-${'.'.repeat(60)}+`);
    const folded = foldRows(rows);
    expect(folded[1]).toEqual({ type: 'fold', key: '2', start: 4, end: 58 });
    let exp = expandFold({}, '2', 'top');
    expect(foldRows(rows, exp)[1]).toEqual({ type: 'fold', key: '2', start: 24, end: 58 });
    exp = expandFold(exp, '2', 'bottom');
    expect(foldRows(rows, exp)[1]).toEqual({ type: 'fold', key: '2', start: 24, end: 38 });
    // What would stay hidden drops under minHidden → shown in full.
    exp = expandFold(exp, '2', 'bottom');
    expect(foldRows(rows, exp)).toEqual([{ type: 'rows', start: 0, end: 62 }]);
    expect(foldRows(rows, expandFold({}, '2', 'all'))).toEqual([
      { type: 'rows', start: 0, end: 62 },
    ]);
  });

  test('fold keys are old line numbers, shared by both views', () => {
    const a = lines(40);
    const b = lines(40, (i) => (i === 2 ? 'two' : i === 35 ? 'x' : `L${i}`));
    const side = sideRows(a, b);
    const keys = (rows: LayoutRow[]) =>
      foldRows(rows).flatMap((s) => (s.type === 'fold' ? [s.key] : []));
    expect(keys(sideLayoutRows(side))).toEqual(['3']);
    expect(keys(unifiedLayoutRows(buildUnifiedRows(side)))).toEqual(['3']);
  });
});

describe('ruler', () => {
  const rows = spec(`-${'.'.repeat(20)}+`);
  const segments = foldRows(rows);

  test('drawn height counts a fold bar as one row', () => {
    expect(drawnRows(segments)).toBe(9);
    expect(drawnIndex(segments, 0)).toBe(0);
    expect(drawnIndex(segments, 10)).toBe(4); // hidden → its bar
    expect(drawnIndex(segments, 21)).toBe(8);
  });

  test('marks sit at their drawn position', () => {
    expect(rulerMarks(changeBlocks(rows), segments)).toEqual([
      { block: 0, kind: 'del', top: 0, height: 1 / 9 },
      { block: 1, kind: 'ins', top: 8 / 9, height: 1 / 9 },
    ]);
  });

  test('no rows, no marks', () => {
    expect(rulerMarks([], [])).toEqual([]);
  });
});
