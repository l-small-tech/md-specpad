/**
 * Heading marks in Edit mode (Milkdown) — the ProseMirror twin of
 * `heading-marks-cm6.ts`, imported only by `milkdown.ts` so it stays in the
 * lazily loaded wysiwyg chunk (I8).
 *
 * The mark is the trailing glyph of the heading's text (`core/heading-mark.ts`),
 * so a node decoration tints any heading whose text ends in one (and every
 * top-level block of its section), and the
 * right-click menu rewrites only that tail: the glyph and the blank before
 * it, never the rest of the heading (its inline marks and links survive).
 * The edit is an ordinary transaction — NOT tagged programmatic — so the
 * write-back guard pushes it to the model like any keystroke.
 */

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import {
  markOfText,
  sectionMarks,
  stripMark,
  withMarkText,
  type HeadingMark,
} from '../core/heading-mark';
import { headingMarkClass, openHeadingMarkMenu, sectionMarkClass } from './heading-mark-menu';

const key = new PluginKey<DecorationSet>('md-specpad-heading-marks');

function build(doc: ProseNode): DecorationSet {
  const decos: Decoration[] = [];
  const own = new Set<number>();
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const mark = markOfText(node.textContent);
      if (mark) {
        own.add(pos);
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: headingMarkClass(mark) }));
      }
      return false;
    }
    return true;
  });

  // Sections over the top-level blocks: everything after a marked heading
  // (paragraphs, lists, code, unmarked sub-headings) shares its hue up to
  // the next heading of the same or a higher level.
  const blocks: { node: ProseNode; pos: number }[] = [];
  doc.forEach((node, pos) => blocks.push({ node, pos }));
  const headings = blocks.filter((b) => b.node.type.name === 'heading');
  const shown = sectionMarks(
    headings.map((b) => ({
      level: Number(b.node.attrs.level) || 1,
      mark: markOfText(b.node.textContent),
    })),
  );
  let mark: HeadingMark | null = null;
  let h = 0;
  for (const { node, pos } of blocks) {
    if (node.type.name === 'heading') {
      mark = shown[h++] ?? null;
    }
    if (mark && !own.has(pos)) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: sectionMarkClass(mark) }));
    }
  }
  return DecorationSet.create(doc, decos);
}

/** The heading containing a document position, with its start offset. */
function headingAt(view: EditorView, pos: number): { node: ProseNode; pos: number } | null {
  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === 'heading') {
      return { node, pos: $pos.before(depth) };
    }
  }
  // A click right on a heading's edge resolves to its parent; check the node after.
  const after = $pos.nodeAfter;
  return after?.type.name === 'heading' ? { node: after, pos } : null;
}

function applyMark(view: EditorView, at: number, mark: HeadingMark | null): void {
  const found = headingAt(view, at);
  if (!found) {
    return;
  }
  const text = found.node.textContent;
  const kept = stripMark(text);
  const wanted = withMarkText(text, mark);
  if (wanted === text) {
    return;
  }
  // Positions: content starts one past the node's opening token. The tail
  // past `kept` is plain text (the mark regex matched it), so text offsets
  // map 1:1 onto document positions there.
  const contentEnd = found.pos + 1 + found.node.content.size;
  const tailFrom = contentEnd - (text.length - kept.length);
  // A bare text node, not insertText: the glyph must not inherit the bold or
  // link the heading's last word carries.
  const tail = wanted.slice(kept.length);
  const { tr, schema } = view.state;
  view.dispatch(
    tail === ''
      ? tr.delete(tailFrom, contentEnd)
      : tr.replaceWith(tailFrom, contentEnd, schema.text(tail)),
  );
}

export const headingMarksPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => build(state.doc),
        apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
      },
      props: {
        decorations: (state) => key.getState(state),
        handleDOMEvents: {
          contextmenu(view, event) {
            const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const found = hit ? headingAt(view, hit.pos) : null;
            if (!hit || !found) {
              return false;
            }
            const current = markOfText(found.node.textContent);
            return openHeadingMarkMenu(current, event, (mark) =>
              applyMark(view, Math.min(hit.pos, view.state.doc.content.size), mark),
            );
          },
        },
      },
    }),
);
