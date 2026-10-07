/**
 * Collapsible headings in the source editor (Raw / Split; markdown only).
 *
 * Behind the `collapsibleHeadings` setting (core/settings.ts). The markdown
 * grammar already knows how to fold a heading's section (everything below
 * the heading line up to the next heading of the same or a higher level),
 * so this is the standard CM6 fold gutter and keymap, plus one rule of our
 * own: a heading that has just been MARKED RUNNING (`core/heading-mark.ts`)
 * folds by itself. The mark can arrive from the right-click menu, from Edit
 * mode's write-back, or from another process saving the file (an agent
 * marking the section it is working on), so the trigger is the document
 * change rather than the menu: any edit that turns a heading line into a
 * running one collapses that section. Editing a heading that is already
 * running (rewording it, clearing or re-setting the mark later) leaves the
 * fold state alone — only the transition to running counts.
 *
 * The fold is dispatched from a microtask after the triggering update, since
 * CM6 forbids dispatching while an update is being applied.
 */

import {
  codeFolding,
  foldGutter,
  foldKeymap,
  foldable,
  foldEffect,
  foldedRanges,
} from '@codemirror/language';
import type { ChangeSet, EditorState, Extension, Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { parseHeadingLine } from '../core/heading-mark';
import { isAtxHeadingLine } from './heading-marks-cm6';

/**
 * 1-based numbers of the lines (in the document AFTER `changes`) that a
 * change just turned into a running heading: the line now ends in ⏳ and the
 * line it replaced did not. Pure over the two documents, so it is testable
 * without a view; the syntax-tree check (is it really a heading, not a `#`
 * line inside a code fence) happens at fold time.
 */
export function linesTurnedRunning(before: Text, after: Text, changes: ChangeSet): number[] {
  const out: number[] = [];
  const toOld = changes.invertedDesc;
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const first = after.lineAt(fromB).number;
    const last = after.lineAt(toB).number;
    for (let n = first; n <= last; n += 1) {
      const line = after.line(n);
      if (parseHeadingLine(line.text)?.mark !== 'running') {
        continue;
      }
      const old = before.lineAt(toOld.mapPos(line.from));
      if (parseHeadingLine(old.text)?.mark !== 'running' && !out.includes(n)) {
        out.push(n);
      }
    }
  });
  return out;
}

/** The section a heading line folds to, or null (not a heading, or nothing under it). */
function sectionFold(state: EditorState, lineNumber: number): { from: number; to: number } | null {
  if (lineNumber > state.doc.lines) {
    return null;
  }
  const line = state.doc.line(lineNumber);
  if (parseHeadingLine(line.text)?.mark !== 'running' || !isAtxHeadingLine(state, line)) {
    return null;
  }
  return foldable(state, line.from, line.to);
}

function alreadyFolded(state: EditorState, from: number, to: number): boolean {
  let found = false;
  foldedRanges(state).between(from, from, (a, b) => {
    if (a === from && b === to) {
      found = true;
    }
  });
  return found;
}

const autoCollapseRunning = EditorView.updateListener.of((update) => {
  if (!update.docChanged) {
    return;
  }
  const lines = linesTurnedRunning(update.startState.doc, update.state.doc, update.changes);
  if (lines.length === 0) {
    return;
  }
  const { view } = update;
  const doc = update.state.doc;
  queueMicrotask(() => {
    // Re-read: another transaction may have landed first; if the document
    // moved on, the line numbers no longer mean anything and we let it go.
    if (view.state.doc !== doc) {
      return;
    }
    const effects = [];
    for (const n of lines) {
      const range = sectionFold(view.state, n);
      if (range && !alreadyFolded(view.state, range.from, range.to)) {
        effects.push(foldEffect.of(range));
      }
    }
    if (effects.length > 0) {
      view.dispatch({ effects });
    }
  });
});

/**
 * The gutter marker: a chevron drawn as an inline SVG so it scales with the
 * editor font and sits dead centre in its cell (the stock "⌄"/"›" text glyphs
 * are tiny and hug the left edge). Open sections point down, folded ones
 * right — `.cm-fold-marker-closed` rotates the same path, see the theme in
 * cm6.ts.
 */
function foldMarker(open: boolean): HTMLElement {
  const svgNS = 'http://www.w3.org/2000/svg';
  const span = document.createElement('span');
  span.className = `cm-fold-marker ${open ? 'cm-fold-marker-open' : 'cm-fold-marker-closed'}`;
  span.title = open ? 'Fold section' : 'Unfold section';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M4 6l4 4 4-4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

export const headingFoldExtension: Extension = [
  codeFolding(),
  foldGutter({ markerDOM: foldMarker }),
  keymap.of(foldKeymap),
  autoCollapseRunning,
];
