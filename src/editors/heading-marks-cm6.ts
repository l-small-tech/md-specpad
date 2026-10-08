/**
 * Heading marks in the source editor (Raw / Split; markdown only).
 *
 * - A line decoration tints every ATX heading that ends in a mark glyph
 *   (`core/heading-mark.ts`), and every line of its section — body text and
 *   unmarked sub-headings, down to the next heading of the same or a higher
 *   level — takes the same hue, so a running or complete section stands out.
 * - Right-clicking a heading line — or inside a selection that starts with
 *   one — offers the mark menu (folded into the native one on Windows, so
 *   spelling suggestions stay; see `heading-mark-menu.ts`) and rewrites just
 *   that line (plus, for Focus, the heading that held it before) — an
 *   ordinary user edit, so it lands in undo history and writes back to the
 *   model like typing would.
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
  bandContinues,
  parseHeadingLine,
  sectionMarkOwners,
  setHeadingLineMark,
  UNIQUE_MARK,
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
 * blank lines in front of it unless that heading carries the band on
 * (`bandContinues`); `sectionMarkOwners` says which mark each shows.
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
  const owners = sectionMarkOwners(headings);
  const out: { first: number; last: number; mark: HeadingMark }[] = [];
  headings.forEach((heading, i) => {
    const mark = headings[owners[i]!]?.mark;
    if (!mark) {
      return;
    }
    let last = (headings[i + 1]?.line ?? doc.lines + 1) - 1;
    // The blank lines in front of a sub-heading inside the same band stay
    // tinted, so the band reads as one; only its outer end is trimmed.
    const trim = !bandContinues(headings, owners, i);
    while (trim && last > heading.line && doc.line(last).text.trim() === '') {
      last--;
    }
    out.push({ first: heading.line, last, mark });
  });
  return out;
}

/**
 * The edits that set `mark` on the heading line at `pos`: that line, plus —
 * for the unique mark (Focus) — clearing it from every other ATX heading in
 * the document, all in one change so one undo puts everything back.
 */
export function headingMarkChanges(
  state: EditorState,
  pos: number,
  mark: HeadingMark | null,
): { from: number; to: number; insert: string }[] {
  const { doc } = state;
  // Re-read: the document may have changed while the menu was open.
  const target = doc.lineAt(Math.min(pos, doc.length));
  const out: { from: number; to: number; insert: string }[] = [];
  if (mark === UNIQUE_MARK) {
    syntaxTree(state).iterate({
      enter(node) {
        if (!node.name.startsWith('ATXHeading')) {
          return;
        }
        const line = doc.lineAt(node.from);
        if (line.number !== target.number && parseHeadingLine(line.text)?.mark === mark) {
          out.push({ from: line.from, to: line.to, insert: setHeadingLineMark(line.text, null)! });
        }
        return false;
      },
    });
  }
  const next = setHeadingLineMark(target.text, mark);
  if (next !== null && next !== target.text) {
    out.push({ from: target.from, to: target.to, insert: next });
  }
  return out.sort((x, y) => x.from - y.from);
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

/**
 * The heading line a right-click at `pos` marks, or null for none. A click
 * inside a selection whose first line is a heading marks that heading (the
 * selection's top, wherever in it the click landed); otherwise only a click
 * on a heading line itself does.
 */
export function menuHeadingLine(state: EditorState, pos: number): Line | null {
  const { doc } = state;
  const { from, to } = state.selection.main;
  const clicked = doc.lineAt(pos).number;
  if (from < to && clicked >= doc.lineAt(from).number && clicked <= doc.lineAt(to).number) {
    // The top is the first line with selected text on it: a selection
    // starting at the very end of a line, or on blank lines, starts below.
    let top = doc.lineAt(from);
    while (top.number < doc.lines && top.to < to && (from >= top.to || top.text.trim() === '')) {
      top = doc.line(top.number + 1);
    }
    if (parseHeadingLine(top.text) && isAtxHeadingLine(state, top)) {
      return top;
    }
  }
  const line = doc.lineAt(pos);
  return parseHeadingLine(line.text) && isAtxHeadingLine(state, line) ? line : null;
}

const menu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) {
      return false;
    }
    const line = menuHeadingLine(view.state, pos);
    const parsed = line ? parseHeadingLine(line.text) : null;
    if (!line || !parsed) {
      return false;
    }
    return openHeadingMarkMenu(parsed.mark, event, (mark) => {
      const changes = headingMarkChanges(view.state, line.from, mark);
      if (changes.length > 0) {
        view.dispatch({ changes, userEvent: 'input.heading-mark' });
      }
    });
  },
});

export const headingMarksExtension: Extension = [decorations, menu];
