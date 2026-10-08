/**
 * Heading marks in Edit mode (Milkdown) — the ProseMirror twin of
 * `heading-marks-cm6.ts`, imported only by `milkdown.ts` so it stays in the
 * lazily loaded wysiwyg chunk (I8).
 *
 * The mark is the trailing glyph of the heading's text (`core/heading-mark.ts`),
 * so a node decoration tints any heading whose text ends in one (and every
 * top-level block of its section), and the
 * right-click menu rewrites only that tail: the glyph and the blank before
 * it, never the rest of the heading (its inline marks and links survive) —
 * on that heading, and for Focus on the one that held it before.
 * The edit is an ordinary transaction — NOT tagged programmatic — so the
 * write-back guard pushes it to the model like any keystroke.
 */

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import {
  bandContinues,
  markOfText,
  sectionMarkOwners,
  stripMark,
  UNIQUE_MARK,
  withMarkText,
  type HeadingMark,
} from '../core/heading-mark';
import { headingMarkClass, openHeadingMarkMenu, sectionMarkClass } from './heading-mark-menu';

/** A top-level block that continues the band of the block above it. */
const HEADING_MARK_JOINED = 'heading-mark-joined';

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
  const headings = blocks
    .filter((b) => b.node.type.name === 'heading')
    .map((b) => ({
      level: Number(b.node.attrs.level) || 1,
      mark: markOfText(b.node.textContent),
    }));
  const owners = sectionMarkOwners(headings);
  let mark: HeadingMark | null = null;
  let h = -1;
  for (const { node, pos } of blocks) {
    // Joined: the block above is in the same band, so the margin between
    // them turns into padding (app.css) and the bar runs on unbroken.
    let joined = mark !== null;
    if (node.type.name === 'heading') {
      joined = h >= 0 && bandContinues(headings, owners, h);
      h++;
      mark = headings[owners[h]!]?.mark ?? null;
    }
    if (!mark) {
      continue;
    }
    // An own-marked heading already carries its class (the pass above).
    const classes = own.has(pos) ? [] : [sectionMarkClass(mark)];
    if (joined) {
      classes.push(HEADING_MARK_JOINED);
    }
    if (classes.length > 0) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: classes.join(' ') }));
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

/**
 * Rewrite one heading's trailing mark in `tr`. Positions: content starts one
 * past the node's opening token. The tail past the stripped text is plain
 * text (the mark regex matched it), so text offsets map 1:1 onto document
 * positions there.
 */
function retail(tr: Transaction, node: ProseNode, pos: number, mark: HeadingMark | null): void {
  const text = node.textContent;
  const kept = stripMark(text);
  const wanted = withMarkText(text, mark);
  if (wanted === text) {
    return;
  }
  const contentEnd = pos + 1 + node.content.size;
  const tailFrom = contentEnd - (text.length - kept.length);
  // A bare text node, not insertText: the glyph must not inherit the bold or
  // link the heading's last word carries.
  const tail = wanted.slice(kept.length);
  if (tail === '') {
    tr.delete(tailFrom, contentEnd);
  } else {
    tr.replaceWith(tailFrom, contentEnd, tr.doc.type.schema.text(tail));
  }
}

function applyMark(view: EditorView, at: number, mark: HeadingMark | null): void {
  const found = headingAt(view, at);
  if (!found) {
    return;
  }
  // The heading to set, plus — for the unique mark (Focus) — every other
  // heading holding it, cleared in the same transaction (one undo). Applied
  // last-first so earlier positions stay valid.
  const edits: { node: ProseNode; pos: number; mark: HeadingMark | null }[] = [{ ...found, mark }];
  if (mark === UNIQUE_MARK) {
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        if (pos !== found.pos && markOfText(node.textContent) === mark) {
          edits.push({ node, pos, mark: null });
        }
        return false;
      }
      return true;
    });
  }
  const { tr } = view.state;
  for (const edit of edits.sort((x, y) => y.pos - x.pos)) {
    retail(tr, edit.node, edit.pos, edit.mark);
  }
  if (tr.docChanged) {
    view.dispatch(tr);
  }
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
