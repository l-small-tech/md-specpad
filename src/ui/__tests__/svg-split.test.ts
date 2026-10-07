/**
 * The Split-mode raw ⇄ draw link.
 *
 * Both adapters are stubbed down to the four methods the link actually uses,
 * over a REAL DocModel — the subscription order between the board and the link
 * is part of what is being tested, and a fake model would let it drift.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createDocModel, type DocModel } from '../../core/doc-model';
import type { ElementRef } from '../../core/whiteboard/layers';
import type { Cm6Adapter } from '../../editors/cm6';
import type { WhiteboardAdapter } from '../../editors/whiteboard';
import { linkSvgSplit, type SvgSplitLink } from '../svg-split';

const BOARD = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-specpad:whiteboard" viewBox="0 0 800 600" width="800" height="600">
  <g wb:layer="L1" wb:name="Layer 1">
    <rect x="100" y="120" width="80" height="40" fill="none" stroke="#1a1a1a" stroke-width="2"/>
    <ellipse cx="300" cy="200" rx="50" ry="25" fill="none" stroke="#1a1a1a" stroke-width="2"/>
  </g>
</svg>
`;

const RECT: ElementRef = { layerId: 'L1', index: 0 };
const ELLIPSE: ElementRef = { layerId: 'L1', index: 1 };

/** The source editor, reduced to what the link calls. */
function fakeSource() {
  const listeners = new Set<
    (pos: { line: number; col: number; anchor: number; head: number }) => void
  >();
  const marked: Array<Array<{ from: number; to: number }>> = [];
  const revealed: Array<{ from: number; to: number }> = [];
  const adapter = {
    setLinkedRanges: (ranges: { from: number; to: number }[]) => marked.push(ranges),
    revealRange: (from: number, to: number) => revealed.push({ from, to }),
    subscribeSelection: (
      listener: (pos: { line: number; col: number; anchor: number; head: number }) => void,
    ) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Cm6Adapter;
  return {
    adapter,
    marked,
    revealed,
    /** The last marks actually handed over, as source slices. */
    lastMarkedIn: (text: string) =>
      (marked[marked.length - 1] ?? []).map((r) => text.slice(r.from, r.to)),
    moveCaret(head: number) {
      for (const listener of [...listeners]) {
        listener({ line: 1, col: 1, anchor: head, head });
      }
    },
  };
}

/**
 * The board, reduced likewise. `selectRefs` reports back through the link's
 * own `boardSelection` hook, exactly as the real adapter's `onSelectionChange`
 * does — that feedback path is what the no-op tests below exercise.
 */
function fakeBoard(model: DocModel) {
  let selection: readonly ElementRef[] = [];
  const reveals: number[] = [];
  let link: SvgSplitLink | null = null;
  const adapter = {
    getSelection: () => selection,
    selectRefs: (refs: readonly ElementRef[], reveal?: boolean) => {
      selection = refs;
      if (reveal) {
        reveals.push(refs.length);
      }
      link?.boardSelection(refs);
    },
  } as unknown as WhiteboardAdapter;
  // The real board clears its selection on every external change, before the
  // link's own model subscription runs. Subscribing first reproduces that.
  model.subscribe(() => {
    selection = [];
    link?.boardSelection(selection);
  });
  return {
    adapter,
    reveals,
    selected: () => selection,
    use(created: SvgSplitLink) {
      link = created;
    },
    /** A board edit: the adapter re-serializes and pushes. */
    push(text: string) {
      model.pushText(text, 'programmatic');
    },
  };
}

function setup(text = BOARD) {
  const model = createDocModel(text);
  const source = fakeSource();
  const board = fakeBoard(model);
  const link = linkSvgSplit({ model, source: source.adapter, board: board.adapter });
  board.use(link);
  return { model, source, board, link };
}

/** Marks are written on a microtask — see the header of ui/svg-split.ts. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('board → source', () => {
  it('marks the selected elements markup, in source order', async () => {
    const { source, link } = setup();
    link.boardSelection([ELLIPSE, RECT]);
    await settle();
    expect(source.lastMarkedIn(BOARD)).toEqual([
      '<rect x="100" y="120" width="80" height="40" fill="none" stroke="#1a1a1a" stroke-width="2"/>',
      '<ellipse cx="300" cy="200" rx="50" ry="25" fill="none" stroke="#1a1a1a" stroke-width="2"/>',
    ]);
  });

  it('clears the marks when nothing is selected', async () => {
    const { source, link } = setup();
    link.boardSelection([RECT]);
    await settle();
    link.boardSelection([]);
    await settle();
    expect(source.marked[source.marked.length - 1]).toEqual([]);
  });

  it('says nothing twice for an unchanged selection', async () => {
    const { source, link } = setup();
    link.boardSelection([RECT]);
    await settle();
    const count = source.marked.length;
    link.boardSelection([RECT]);
    await settle();
    expect(source.marked.length).toBe(count);
  });

  it('re-issues the marks after the board itself edits the document', async () => {
    const { source, board, link } = setup();
    link.boardSelection([ELLIPSE]);
    await settle();
    // A nudge: the same element, further down the file.
    const moved = BOARD.replace('<rect x="100"', '<rect x="140"').replace(
      '<g wb:layer="L1" wb:name="Layer 1">',
      '<g wb:layer="L1" wb:name="Layer 1">\n    <line x1="0" y1="0" x2="1" y2="1" stroke="#000"/>',
    );
    board.push(moved);
    // The board keeps its own selection across its own push, but the indices
    // moved — the ellipse is element 2 now, so what was marked must change.
    link.boardSelection([{ layerId: 'L1', index: 2 }]);
    await settle();
    expect(source.lastMarkedIn(moved)).toEqual([
      '<ellipse cx="300" cy="200" rx="50" ry="25" fill="none" stroke="#1a1a1a" stroke-width="2"/>',
    ]);
  });

  it('marks nothing while the text does not parse', async () => {
    const { model, source, link } = setup();
    model.pushText('<svg><rect x="1"', 'cm6');
    link.boardSelection([RECT]);
    await settle();
    expect(source.marked[source.marked.length - 1]).toEqual([]);
  });
});

describe('source → board', () => {
  it('selects the element the caret lands in, and reveals it', () => {
    const { source, board } = setup();
    source.moveCaret(BOARD.indexOf('cx="300"'));
    expect(board.selected()).toEqual([ELLIPSE]);
    expect(board.reveals).toEqual([1]);
  });

  it('follows the caret from one element to the next', () => {
    const { source, board } = setup();
    source.moveCaret(BOARD.indexOf('cx="300"'));
    source.moveCaret(BOARD.indexOf('x="100"'));
    expect(board.selected()).toEqual([RECT]);
  });

  it('clears the selection when the caret leaves every element', () => {
    const { source, board } = setup();
    source.moveCaret(BOARD.indexOf('cx="300"'));
    source.moveCaret(0);
    expect(board.selected()).toEqual([]);
  });

  it('does not re-select on every keystroke within one element', () => {
    const { source, board } = setup();
    source.moveCaret(BOARD.indexOf('cx="300"'));
    const reveals = board.reveals.length;
    source.moveCaret(BOARD.indexOf('cy="200"'));
    expect(board.reveals.length).toBe(reveals);
  });

  it('re-asserts itself after a document change cleared the board selection', () => {
    const { model, source, board } = setup();
    const at = BOARD.indexOf('cx="300"');
    source.moveCaret(at);
    expect(board.selected()).toEqual([ELLIPSE]);
    // Typing in the source pane: the board drops its selection, and the caret
    // report that follows the push has to put it back.
    const edited = BOARD.replace('rx="50"', 'rx="55"');
    model.pushText(edited, 'cm6');
    expect(board.selected()).toEqual([]);
    source.moveCaret(edited.indexOf('cx="300"'));
    expect(board.selected()).toEqual([ELLIPSE]);
  });

  it('leaves the board alone while the text does not parse', () => {
    const { model, source, board } = setup();
    source.moveCaret(BOARD.indexOf('cx="300"'));
    model.pushText('<svg><rect x="1"', 'cm6');
    source.moveCaret(5);
    expect(board.selected()).toEqual([]); // cleared by the change, not re-set
  });
});

describe('reveal in source', () => {
  it('puts the caret on the elements markup', () => {
    const { source, link } = setup();
    link.revealInSource([ELLIPSE]);
    expect(source.revealed).toHaveLength(1);
    const { from, to } = source.revealed[0]!;
    expect(BOARD.slice(from, to)).toContain('<ellipse');
  });

  it('does nothing for a ref that is no longer there', () => {
    const { source, link } = setup();
    link.revealInSource([{ layerId: 'L1', index: 7 }]);
    expect(source.revealed).toEqual([]);
  });
});

describe('dispose', () => {
  let live: ReturnType<typeof setup>;
  beforeEach(() => {
    live = setup();
  });

  it('clears the marks and stops listening to both sides', async () => {
    const { source, board, link, model } = live;
    link.boardSelection([RECT]);
    await settle();
    const marks = source.marked.length;
    link.dispose();
    const selected = board.selected();

    source.moveCaret(BOARD.indexOf('cx="300"'));
    model.pushText(BOARD.replace('rx="50"', 'rx="60"'), 'cm6');
    await settle();

    // One final clear on dispose, and nothing after it.
    expect(source.marked.length).toBe(marks + 1);
    expect(source.marked[marks]).toEqual([]);
    expect(board.selected()).toEqual(selected);
  });
});
