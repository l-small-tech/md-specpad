/**
 * Heading marks in the source editor (Raw / Split; markdown only).
 *
 * - A line decoration tints every ATX heading that ends in a mark glyph
 *   (`core/heading-mark.ts`), and every line of its section — body text and
 *   unmarked sub-headings, down to the next heading of the same or a higher
 *   level — takes the same hue, so a running or complete section stands out.
 * - Right-clicking a heading line offers the mark menu (folded into the
 *   native one on Windows, so spelling suggestions stay; see
 *   `heading-mark-menu.ts`) and rewrites just that line — an ordinary user edit, so it lands in
 *   undo history and writes back to the model like typing would.
 *
 * Heading detection goes through the markdown syntax tree, never a regex
 * over the line alone, so a `#` line inside a fenced code block is left be.
 */

import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Line, Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  parseHeadingLine,
  sectionMarks,
  setHeadingLineMark,
  type HeadingMark,
} from '../core/heading-mark';
import { headingMarkClass, openHeadingMarkMenu, sectionMarkClass } from './heading-mark-menu';

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** Is this line an ATX heading per the parse tree (not code, not setext)? */
export function isAtxHeadingLine(state: EditorState, line: Line): boolean {
  const start = line.from + (line.text.length - line.text.trimStart().length);
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(start, 1);
    node;
    node = node.parent
  ) {
    if (node.name.startsWith('ATXHeading')) {
      return true;
    }
  }
  return false;
}

/**
 * The marked sections as line-number spans (inclusive), from the TOP-LEVEL
 * headings (ATX and setext — both end a section). Each span starts at its
 * heading line and stops before the next heading of any level, minus the
 * blank lines in front of it; `sectionMarks` says which mark each shows.
 */
export function markedSectionLines(
  state: EditorState,
): { first: number; last: number; mark: HeadingMark }[] {
  const { doc } = state;
  const headings: { line: number; level: number; mark: HeadingMark | null }[] = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    const m = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
    if (!m) {
      continue;
    }
    const line = doc.lineAt(node.from);
    headings.push({
      line: line.number,
      level: Number(m[2]),
      mark: m[1] === 'ATX' ? (parseHeadingLine(line.text)?.mark ?? null) : null,
    });
  }
  const shown = sectionMarks(headings);
  const out: { first: number; last: number; mark: HeadingMark }[] = [];
  headings.forEach((heading, i) => {
    const mark = shown[i];
    if (!mark) {
      return;
    }
    let last = (headings[i + 1]?.line ?? doc.lines + 1) - 1;
    while (last > heading.line && doc.line(last).text.trim() === '') {
      last--;
    }
    out.push({ first: heading.line, last, mark });
  });
  return out;
}

function build(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const { state } = view;
  const { doc } = state;
  // Lines whose own heading carries a mark; they keep the heading style.
  const own = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (!node.name.startsWith('ATXHeading')) {
          return;
        }
        const line = doc.lineAt(node.from);
        const mark = parseHeadingLine(line.text)?.mark;
        if (mark) {
          own.add(line.number);
          marks.push(Decoration.line({ class: headingMarkClass(mark) }).range(line.from));
        }
        return false;
      },
    });
  }

  // Everything under a marked heading — text and unmarked sub-headings —
  // shares its hue, up to the next heading of the same or a higher level.
  // Sections come from the whole document (one may open above the
  // viewport); decorations only for the visible lines.
  const visible = view.visibleRanges.map(({ from, to }) => [
    doc.lineAt(from).number,
    doc.lineAt(to).number,
  ]);
  for (const { first, last, mark } of markedSectionLines(state)) {
    const deco = Decoration.line({ class: sectionMarkClass(mark) });
    for (const [lo, hi] of visible) {
      for (let n = Math.max(lo!, first); n <= Math.min(hi!, last); n++) {
        if (!own.has(n)) {
          marks.push(deco.range(doc.line(n).from));
        }
      }
    }
  }
  return Decoration.set(marks, true);
}

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const menu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) {
      return false;
    }
    const line = view.state.doc.lineAt(pos);
    const parsed = parseHeadingLine(line.text);
    if (!parsed || !isAtxHeadingLine(view.state, line)) {
      return false;
    }
    return openHeadingMarkMenu(parsed.mark, event, (mark) => {
      // Re-read: the document may have changed while the menu was open.
      const current = view.state.doc.lineAt(Math.min(line.from, view.state.doc.length));
      const next = setHeadingLineMark(current.text, mark);
      if (next !== null && next !== current.text) {
        view.dispatch({
          changes: { from: current.from, to: current.to, insert: next },
          userEvent: 'input.heading-mark',
        });
      }
    });
  },
});

export const headingMarksExtension: Extension = [decorations, menu];
