/**
 * Heading marks in the source editor (Raw / Split; markdown only).
 *
 * - A line decoration tints every ATX heading that ends in a mark glyph
 *   (`core/heading-mark.ts`), so a running or complete section stands out.
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
import { parseHeadingLine, setHeadingLineMark } from '../core/heading-mark';
import { headingMarkClass, openHeadingMarkMenu } from './heading-mark-menu';

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** Is this line an ATX heading per the parse tree (not code, not setext)? */
function isAtxHeadingLine(state: EditorState, line: Line): boolean {
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

function build(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (!node.name.startsWith('ATXHeading')) {
          return;
        }
        const line = state.doc.lineAt(node.from);
        const mark = parseHeadingLine(line.text)?.mark;
        if (mark) {
          marks.push(Decoration.line({ class: headingMarkClass(mark) }).range(line.from));
        }
        return false;
      },
    });
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
