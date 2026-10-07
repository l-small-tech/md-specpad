/**
 * cm6.ts — the CodeMirror 6 source editor adapter (recipe in ./README.md).
 *
 * Used by both `raw` and `split` modes; mode-sync never re-creates it when
 * toggling between them. The adapter is a projection of the DocModel
 * (invariant I1): editor edits push into the model, model changes from
 * elsewhere (file reload, WYSIWYG write-back) are applied back with a single
 * transaction. Echo is suppressed with the reentrancy-flag pattern from
 * doc-model.ts's header.
 *
 * Theming is deliberately CSS-variable driven: the base theme and the syntax
 * HighlightStyle reference `var(--fg)`, `var(--accent)`, … from base.css, so
 * a light/dark flip (which only rewrites `data-theme` on <html>) restyles the
 * editor with zero reconfiguration — no cross-layer coupling to the settings
 * store. The theme/font/wrap Compartments exist as the reconfiguration hooks
 * M6 will drive (font size and word wrap), and to keep the recipe's shape.
 */

import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  placeholder,
  type DecorationSet,
} from '@codemirror/view';
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import { diffToChanges } from '../core/diff';
import { joinDictation } from '../core/dictation-insert';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { foldNodeProp, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { highlightStyle, listMarkStyling } from './markdown-highlight';
import { xmlHighlightStyle, xmlLanguage } from './xml-highlight';
import { codeHighlightStyle, rustLanguage, tsLanguage } from './code-highlight';
import { reindentLists } from './list-indent';
import { plainDotsExtension } from './plain-dots';
import { headingMarksExtension } from './heading-marks-cm6';
import { headingFoldExtension } from './heading-fold-cm6';
import type { DocModel } from '../core/doc-model';
import type { EditorAdapter } from '../core/mode-sync';
import type { CursorPos } from '../core/types';
import { imageFilesFromDataTransfer, readImageFile } from './image-paste';
import { createKeyboardDismissGesture } from './dismiss-keyboard';

export interface Cm6Options {
  /**
   * Reports the caret on doc, selection, or focus changes. `line`/`col` drive
   * the status bar; `anchor`/`head` are the document offsets the session
   * flusher persists (and restores via `initialSelection`).
   */
  onSelection?: (pos: { line: number; col: number; anchor: number; head: number }) => void;
  /** Initial soft-wrap state (M6 toggles it via `setWordWrap`). */
  wordWrap?: boolean;
  /** Initial line-number gutter state (OFF by default — Notepad feel). */
  lineNumbers?: boolean;
  /**
   * Initial fold-gutter state (OFF by default): collapsible heading sections,
   * with a heading marked running collapsing on its own (heading-fold-cm6.ts).
   * Markdown only — ignored for every other language.
   */
  collapsibleHeadings?: boolean;
  /**
   * Ghost text shown while the document is EMPTY (never once there is a
   * character in it). Multi-line; rendered `pre-wrap`.
   */
  placeholder?: string;
  /** Caret to restore on attach (from the persisted session). Clamped to length. */
  initialSelection?: CursorPos;
  /**
   * Save a pasted image and return how to reference it (alt + src), or null on
   * failure. When set, a paste carrying image files is intercepted and the
   * reference inserted at the caret instead of the raw bytes.
   */
  saveImage?: (data: {
    base64: string;
    ext: string;
    name: string | null;
  }) => Promise<{ alt: string; src: string } | null>;
  /**
   * Transform text on its way to the clipboard (Ctrl/Cmd+C with a selection).
   * Used to append `@path` mentions for linked files/images — the same
   * enrichment the ribbon's copy-raw-text button applies. Returning the input
   * unchanged falls through to the editor's native copy.
   */
  enrichCopy?: (text: string) => string;
  /**
   * Dismiss the soft keyboard on a double-tap in the editor (blurs the content
   * DOM). Only meaningful on touch platforms — wired on Android.
   */
  dismissKeyboardOnDoubleTap?: boolean;
  /**
   * Which grammar to highlight with. Default 'markdown'. 'xml' is used for the
   * Raw view of an `.svg` whiteboard (core/doc-family decides), and also drops
   * the markdown-only editing behaviours — auto-bullets, list Tab indentation —
   * which would be actively wrong in SVG source. 'ts' and 'rust' (the code
   * family's languages — core/code/parse decides) use the same Lezer grammars
   * the Review model parses with; 'plain' (any other file — a config) highlights
   * nothing. All three drop the markdown behaviours.
   */
  language?: 'markdown' | 'xml' | 'plain' | 'ts' | 'rust';
}

/** Ribbon formatting actions the adapter can apply to the current selection. */
export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'codeBlock'
  | 'heading'
  | 'quote'
  | 'bulletList'
  | 'orderedList'
  | 'link';

/** The concrete adapter type — superset of EditorAdapter with M2/M6 hooks. */
export interface Cm6Adapter extends EditorAdapter {
  /** Center the given 1-based line, put the caret at its start, and focus. */
  revealLine(line: number): void;
  /**
   * The 1-based line at the top of the viewport, for the mode-switch scroll
   * anchor (`core/mode-scroll`). Null while detached or laid out at zero
   * height (a hidden tab) — a measurement nobody should act on.
   */
  getTopLine(): number | null;
  /** The 1-based line the caret is on, or null while detached. */
  getCaretLine(): number | null;
  /**
   * Put that line back at the top of the viewport. Unlike `revealLine` this
   * moves nothing but the scroll: no caret, no focus — the reader is arriving
   * from another mode, not jumping to a search hit.
   */
  scrollToLine(line: number): void;
  getSelection(): CursorPos;
  setSelection(anchor: number, head: number): void;
  setWordWrap(on: boolean): void;
  setLineNumbers(on: boolean): void;
  setCollapsibleHeadings(on: boolean): void;
  setFontSize(px: number): void;
  /** Apply a ribbon formatting action to the current selection/line, then refocus. */
  format(action: FormatAction): void;
  /** Insert a file/image reference at the caret (from the ribbon's link pickers). */
  insertLinkTo(label: string, url: string, image: boolean): void;
  /** Voice typing: put a dictated phrase at the caret (`joinDictation` spacing). */
  insertText(text: string): void;
  /**
   * Live Edit: highlight the lines covering these document ranges. 'added'
   * is text that just arrived from another person's save (green, fades on
   * its own); 'removed' is text a pending merge is about to take away (red,
   * steady until `clearFlash('removed')` or the timer). Both map through
   * subsequent edits.
   */
  flashRanges(ranges: { from: number; to: number }[], kind: FlashKind): void;
  /** Drop every highlight of that kind now (the merge landed). */
  clearFlash(kind: FlashKind): void;
  /**
   * Split mode's raw ⇄ draw link: mark the source of what is selected in the
   * other pane. A steady highlight, not a flash — it is a statement about
   * where you are, and it lasts until the selection changes. `[]` clears it.
   * `reveal` scrolls the first range into view if it is off screen; the caret
   * and the focus are deliberately left alone, because the other pane's
   * selection must never interrupt typing in this one.
   */
  setLinkedRanges(ranges: { from: number; to: number }[], reveal?: boolean): void;
  /**
   * Put the caret on `[from, to)`, centre it and take focus — the explicit
   * "show me this in the source" jump, as opposed to the passive highlight.
   */
  revealRange(from: number, to: number): void;
  /**
   * Watch the caret. Same payload `onSelection` gets; unlike that option (one
   * consumer, the session/status bar) this is a subscription, because Split
   * mode's link is a second listener with its own lifetime.
   */
  subscribeSelection(
    listener: (pos: CursorPos & { line: number; col: number }) => void,
  ): () => void;
}

/**
 * How far below the viewport's top edge `getTopLine` samples. A line the
 * scroll anchor just aligned to the edge sits at height 0 of the viewport,
 * where sub-pixel rounding can still report the line above it.
 */
const TOP_LINE_SLOP_PX = 2;

/* ---- Live Edit merge highlight ------------------------------------------ */

export type FlashKind = 'added' | 'removed';
type FlashRange = { from: number; to: number };

const addFlash = StateEffect.define<{ kind: FlashKind; ranges: FlashRange[] }>({
  map: ({ kind, ranges }, change) => ({
    kind,
    ranges: ranges.map((r) => ({ from: change.mapPos(r.from), to: change.mapPos(r.to) })),
  }),
});
const clearFlash = StateEffect.define<FlashKind>();
const FLASH_CLASS: Record<FlashKind, string> = {
  added: 'cm-live-merged',
  removed: 'cm-live-removed',
};

/** One decoration set per flash kind, so clearing one leaves the other. */
function flashField(kind: FlashKind): StateField<DecorationSet> {
  const lineDeco = Decoration.line({ class: FLASH_CLASS[kind] });
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      let next = deco.map(tr.changes);
      for (const effect of tr.effects) {
        if (effect.is(clearFlash) && effect.value === kind) {
          next = Decoration.none;
        } else if (effect.is(addFlash) && effect.value.kind === kind) {
          const doc = tr.state.doc;
          const marks = [];
          for (const r of effect.value.ranges) {
            const from = Math.max(0, Math.min(r.from, doc.length));
            const to = Math.max(from, Math.min(r.to, doc.length));
            const first = doc.lineAt(from).number;
            const last = doc.lineAt(to).number;
            for (let n = first; n <= last; n += 1) {
              marks.push(lineDeco.range(doc.line(n).from));
            }
          }
          next = next.update({ add: marks, sort: true });
        }
      }
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
const addedFlashField = flashField('added');
const removedFlashField = flashField('removed');

/* ---- Split-mode raw ⇄ draw link ----------------------------------------- */

/**
 * The source of what the other pane has selected. A MARK decoration, not a
 * line one (which is what the merge flashes use): a `<line>` and its label may
 * share a line in a hand-authored file, and highlighting the whole row would
 * then claim both. It maps through edits like any decoration, so a stroke
 * drawn on the board re-lands its own highlight without a recompute.
 */
const setLinked = StateEffect.define<FlashRange[]>({
  map: (ranges, change) =>
    ranges.map((r) => ({ from: change.mapPos(r.from), to: change.mapPos(r.to) })),
});

const linkedMark = Decoration.mark({ class: 'cm-wb-linked' });

const linkedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setLinked)) {
        continue;
      }
      const doc = tr.state.doc;
      next = Decoration.none.update({
        add: effect.value
          .map((r) => {
            const from = Math.max(0, Math.min(r.from, doc.length));
            const to = Math.max(from, Math.min(r.to, doc.length));
            return { from, to };
          })
          // A zero-length mark is not renderable and CM6 rejects it.
          .filter((r) => r.to > r.from)
          .map((r) => linkedMark.range(r.from, r.to)),
        sort: true,
      });
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** How long each highlight stays before it is dropped. The green CSS fade is
 *  a little shorter than its timer, so the removal is invisible; the red one
 *  is normally cleared by the merge landing — the timer is the backstop. */
const FLASH_MS: Record<FlashKind, number> = { added: 2600, removed: 4000 };

const baseTheme = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    // The same paper as the Edit-mode editor (wysiwyg.css) so Raw and Edit match
    // in every theme — see .editor-stack in app.css.
    backgroundColor: 'var(--bg)',
    height: '100%',
  },
  // Blend the gutters into the writing surface and drop CM6's default
  // light-grey background + right border, which otherwise read as a white
  // band between the file explorer and the text (in dark mode especially).
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg-muted)',
    border: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    overflow: 'auto',
    // Touch overscroll past the end of the document must stop here, not
    // chain up and pan the app shell (Android).
    overscrollBehavior: 'contain',
  },
  '.cm-content': {
    caretColor: 'var(--fg)',
    padding: '10px 12px',
  },
  '&.cm-focused': { outline: 'none' },
  // Caret width (and underscore geometry) is settings-driven via --caret-width,
  // set per data-cursor in base.css; the fallback matches the 'bar' default.
  '.cm-cursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: 'var(--caret-width, 2px)' },
  '.cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-alt)',
    color: 'var(--fg)',
    borderColor: 'var(--border)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-textfield': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
  },
  '.cm-button': {
    backgroundColor: 'var(--bg-hover)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    backgroundImage: 'none',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--selection)' },
  // Fold gutter + the "…" placeholder of a collapsed section (heading-fold-cm6.ts).
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--bg-hover)',
    border: '1px solid var(--border)',
    color: 'var(--fg-muted)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent)' },
});

function fontSizeTheme(fontSize: string) {
  return EditorView.theme({ '.cm-content': { fontSize }, '.cm-gutters': { fontSize } });
}

/**
 * Tab / Shift+Tab on list lines: re-indent one level, cycling bullet markers
 * with depth and renumbering ordered siblings. All the logic lives in the pure
 * {@link reindentLists}; this is just the CM6 glue. Applies to every line the
 * selection spans, but only when ALL of them are list items; otherwise the
 * command reports "not handled" and Tab keeps its default behavior (focus
 * navigation), which also keeps plain text out of harm's way. Raw (CM6) mode
 * only — the WYSIWYG editor has its own list handling.
 */
function changeListIndent(view: EditorView, delta: 1 | -1): boolean {
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from).number;
  const endLine = state.doc.lineAt(range.to).number;

  const lines = state.doc.toString().split('\n');
  const next = reindentLists(lines, startLine - 1, endLine - 1, delta);
  if (!next) return false;

  const changes = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const replacement = next[n - 1] ?? line.text;
    if (replacement !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: replacement });
    }
  }
  if (changes.length === 0) {
    return true; // all list items, nothing to do (e.g. Shift+Tab at column 0)
  }
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet, 1),
    userEvent: delta === 1 ? 'input.indent' : 'delete.dedent',
  });
  return true;
}

/** Keymap for the list Tab behavior (see {@link changeListIndent}). */
const bulletIndentKeymap = keymap.of([
  { key: 'Tab', run: (view) => changeListIndent(view, 1) },
  { key: 'Shift-Tab', run: (view) => changeListIndent(view, -1) },
]);

/**
 * Toggle an inline markdown wrapper (`**` / `*`) around the main selection.
 * Recognises markers already present just inside or just outside the selection
 * and strips them, so the ribbon button is a true toggle. With no selection it
 * drops an empty pair and parks the caret between the markers.
 */
function toggleInlineWrap(view: EditorView, marker: string): void {
  const { state } = view;
  const range = state.selection.main;
  const doc = state.doc;
  const len = marker.length;

  const selected = doc.sliceString(range.from, range.to);
  if (selected.length >= 2 * len && selected.startsWith(marker) && selected.endsWith(marker)) {
    // Markers sit inside the selection — unwrap.
    const inner = selected.slice(len, selected.length - len);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: inner },
      selection: { anchor: range.from, head: range.from + inner.length },
    });
    return;
  }

  const before = doc.sliceString(Math.max(0, range.from - len), range.from);
  const after = doc.sliceString(range.to, Math.min(doc.length, range.to + len));
  if (before === marker && after === marker) {
    // Markers hug the selection on the outside — strip them.
    view.dispatch({
      changes: [
        { from: range.from - len, to: range.from },
        { from: range.to, to: range.to + len },
      ],
      selection: { anchor: range.from - len, head: range.to - len },
    });
    return;
  }

  if (range.empty) {
    view.dispatch({
      changes: { from: range.from, insert: marker + marker },
      selection: { anchor: range.from + len },
    });
    return;
  }
  view.dispatch({
    changes: [
      { from: range.from, insert: marker },
      { from: range.to, insert: marker },
    ],
    selection: { anchor: range.from + len, head: range.to + len },
  });
}

/**
 * Toggle a fenced code block (```` ``` ````) around the lines the selection
 * spans. If those lines are already fenced — a ``` line directly above the
 * first and directly below the last — the fences are stripped; otherwise they
 * are added. A collapsed caret drops an empty fenced block and parks the caret
 * on the blank line inside it.
 */
function toggleCodeBlock(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const doc = state.doc;
  const startLine = doc.lineAt(range.from);
  const endLine = doc.lineAt(range.to);

  // Already fenced? Strip the ``` lines hugging the selected block.
  const above = startLine.number > 1 ? doc.line(startLine.number - 1) : null;
  const below = endLine.number < doc.lines ? doc.line(endLine.number + 1) : null;
  if (
    above &&
    below &&
    above.text.trim().startsWith('```') &&
    below.text.trim().startsWith('```')
  ) {
    // Remove "```\n" above the block and "\n```" below it; map the selection
    // through the deletions so the same content stays selected.
    const changes = state.changes([
      { from: above.from, to: startLine.from },
      { from: endLine.to, to: below.to },
    ]);
    view.dispatch({ changes, selection: state.selection.map(changes) });
    return;
  }

  // Collapsed caret: insert an empty block on its own lines, caret in the middle.
  if (range.empty) {
    const prefix = range.from === startLine.from ? '' : '\n';
    const suffix = range.from === startLine.to ? '' : '\n';
    const insert = `${prefix}\`\`\`\n\n\`\`\`${suffix}`;
    view.dispatch({
      changes: { from: range.from, insert },
      selection: { anchor: range.from + prefix.length + 4 }, // just past "```\n"
    });
    return;
  }

  // Wrap the selected lines: fence above and below, content untouched.
  const changes = state.changes([
    { from: startLine.from, insert: '```\n' },
    { from: endLine.to, insert: '\n```' },
  ]);
  view.dispatch({
    changes,
    // Both selection ends sit past the 4-char opening fence; keep them on the text.
    selection: { anchor: range.from + 4, head: range.to + 4 },
  });
}

/**
 * Cycle the heading level of the caret's line: none → # → ## → ### → none.
 * The caret rides through the prefix change (default selection mapping).
 */
function cycleHeading(view: EditorView): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const match = /^(#{1,6})\s+/.exec(line.text);
  let insert: string;
  let to = line.from;
  if (match) {
    const level = match[1]!.length;
    to = line.from + match[0].length;
    insert = level >= 3 ? '' : `${'#'.repeat(level + 1)} `;
  } else {
    insert = '# ';
  }
  // Map the caret FORWARD through the change (assoc 1) so a caret sitting at
  // the line start rides to the far side of an inserted `# ` prefix rather
  // than being stranded before it.
  const changes = state.changes({ from: line.from, to, insert });
  view.dispatch({ changes, selection: state.selection.map(changes, 1) });
}

/**
 * Toggle a line-level markdown prefix across every line the selection spans.
 * If all spanned lines already carry the prefix it is stripped; otherwise it
 * is added to the lines that lack it. `prefixFor` receives the running ordinal
 * so ordered lists can number 1., 2., 3., …
 */
function toggleLinePrefix(
  view: EditorView,
  detect: RegExp,
  prefixFor: (ordinal: number) => string,
): void {
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);

  const lines = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    lines.push(state.doc.line(n));
  }
  const allPrefixed = lines.every((line) => detect.test(line.text));

  const changes = [];
  let ordinal = 0;
  for (const line of lines) {
    const match = detect.exec(line.text);
    if (allPrefixed && match) {
      changes.push({ from: line.from, to: line.from + match[0].length });
    } else if (!allPrefixed && !match) {
      ordinal += 1;
      changes.push({ from: line.from, insert: prefixFor(ordinal) });
    }
  }
  if (changes.length > 0) {
    // Bind the caret to the RIGHT of the inserted prefix (assoc 1). Without
    // this, clicking "bullet list" on a line drops the caret behind the dash
    // (`|- text`), so the next keystroke lands in the wrong place; assoc 1
    // parks it after `- ` where typing continues the item.
    const changeSet = state.changes(changes);
    view.dispatch({ changes: changeSet, selection: state.selection.map(changeSet, 1) });
  }
}

/**
 * Wrap the selection as a markdown link, `[text](url)`, and leave `url`
 * selected so the user can type the destination immediately. With no selection
 * a `text` placeholder is inserted and left selected instead.
 */
function insertLink(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const label = state.doc.sliceString(range.from, range.to) || 'text';
  const snippet = `[${label}](url)`;
  const urlFrom = range.from + label.length + 3; // past `[label](`
  const selection = range.empty
    ? { anchor: range.from + 1, head: range.from + 1 + label.length } // select the placeholder label
    : { anchor: urlFrom, head: urlFrom + 3 }; // select `url`
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: snippet },
    selection,
  });
}

/**
 * Insert a link (`[label](url)`) or image (`![label](url)`) reference at the
 * caret, replacing any selection with the reference and leaving the caret just
 * past it. A `url` containing whitespace is wrapped in angle brackets so the
 * markdown destination stays valid (CommonMark `<…>` form).
 */
function insertReference(view: EditorView, label: string, url: string, image: boolean): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.doc.sliceString(range.from, range.to);
  const finalLabel = selected || label;
  const dest = /\s/.test(url) ? `<${url}>` : url;
  const snippet = `${image ? '!' : ''}[${finalLabel}](${dest})`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: snippet },
    selection: { anchor: range.from + snippet.length },
  });
  view.focus();
}

function applyFormat(view: EditorView, action: FormatAction): void {
  switch (action) {
    case 'bold':
      toggleInlineWrap(view, '**');
      break;
    case 'italic':
      toggleInlineWrap(view, '*');
      break;
    case 'strikethrough':
      toggleInlineWrap(view, '~~');
      break;
    case 'codeBlock':
      toggleCodeBlock(view);
      break;
    case 'heading':
      cycleHeading(view);
      break;
    case 'quote':
      toggleLinePrefix(view, /^> /, () => '> ');
      break;
    case 'bulletList':
      toggleLinePrefix(view, /^- /, () => '- ');
      break;
    case 'orderedList':
      toggleLinePrefix(view, /^\d+\. /, (n) => `${n}. `);
      break;
    case 'link':
      insertLink(view);
      break;
  }
  view.focus();
}

/**
 * The markdown grammar offers a fold on every multi-line block, paragraphs
 * included; with the fold gutter on (heading-fold-cm6.ts) that put an arrow
 * beside ordinary prose. Headings, lists and code blocks fold; paragraphs do
 * not — the same set a code editor would collapse.
 */
const noParagraphFolds = { props: [foldNodeProp.add({ Paragraph: () => null })] };

export function createCm6Adapter(options: Cm6Options = {}): Cm6Adapter {
  const wrapCompartment = new Compartment();
  const lineNumbersCompartment = new Compartment();
  const foldCompartment = new Compartment();
  const fontSizeCompartment = new Compartment();
  const themeCompartment = new Compartment();
  /** Fixed for the adapter's lifetime — a tab's document type never changes. */
  const language = options.language ?? 'markdown';
  const isMarkdown = language === 'markdown';
  const languageExtension =
    language === 'xml'
      ? xmlLanguage
      : language === 'ts'
        ? tsLanguage
        : language === 'rust'
          ? rustLanguage
          : isMarkdown
            ? markdown({ base: markdownLanguage, extensions: [listMarkStyling, noParagraphFolds] })
            : [];
  const languageStyle =
    language === 'xml'
      ? xmlHighlightStyle
      : language === 'ts' || language === 'rust'
        ? codeHighlightStyle
        : highlightStyle;

  let view: EditorView | null = null;
  let unsubscribe: (() => void) | null = null;
  // Current word-wrap state, kept in a mutable var (not just the attach
  // options) so `setWordWrap` toggles persist across a detach → re-attach
  // cycle — e.g. toggling wrap while in wysiwyg mode, then switching back to
  // raw must show the new value, not the creation-time one.
  let wordWrap = options.wordWrap !== false;
  // Same detach-survival contract as wordWrap; defaults OFF (Notepad feel).
  let showLineNumbers = options.lineNumbers === true;
  // Same again; markdown only (the other grammars have nothing to fold).
  let collapsibleHeadings = options.collapsibleHeadings === true;
  // Reentrancy flags: `pushingSelf` guards the model→editor path against our
  // own echo; `applyingExternal` guards the editor→model path against changes
  // we are pushing INTO the editor from the model.
  let pushingSelf = false;
  let applyingExternal = false;
  const flashTimers: Record<FlashKind, ReturnType<typeof setTimeout> | null> = {
    added: null,
    removed: null,
  };

  /** Extra caret watchers beside `options.onSelection` — see subscribeSelection. */
  const selectionListeners = new Set<(pos: CursorPos & { line: number; col: number }) => void>();

  function reportSelection() {
    if (!view || (!options.onSelection && selectionListeners.size === 0)) {
      return;
    }
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    const pos = {
      line: line.number,
      col: sel.head - line.from + 1,
      anchor: sel.anchor,
      head: sel.head,
    };
    options.onSelection?.(pos);
    // Copy before iterating: a listener may unsubscribe during dispatch.
    for (const listener of [...selectionListeners]) {
      listener(pos);
    }
  }

  // Intercept a paste that carries image files: save each via options.saveImage
  // and insert the returned reference at the caret. A paste with no image files
  // (or no saveImage wired) falls through to CM6's normal text paste.
  const imagePasteHandler = EditorView.domEventHandlers({
    paste(event, view) {
      if (!options.saveImage) {
        return false;
      }
      const files = imageFilesFromDataTransfer(event.clipboardData);
      if (files.length === 0) {
        return false;
      }
      event.preventDefault();
      void (async () => {
        for (const file of files) {
          const ref = await options.saveImage!(await readImageFile(file));
          if (ref) {
            insertReference(view, ref.alt, ref.src, true);
          }
        }
      })();
      return true;
    },
  });

  // Intercept Ctrl/Cmd+C on a non-empty selection so the copied text can be
  // enriched (e.g. appended @path mentions for links it contains). An empty
  // selection, no enricher, or an unchanged result falls through to CM6's
  // native copy (which copies the current line when nothing is selected).
  const copyEnrichHandler = EditorView.domEventHandlers({
    copy(event, view) {
      if (!options.enrichCopy || !event.clipboardData) {
        return false;
      }
      const text = view.state.selection.ranges
        .filter((range) => !range.empty)
        .map((range) => view.state.sliceDoc(range.from, range.to))
        .join(view.state.lineBreak);
      if (!text) {
        return false;
      }
      const enriched = options.enrichCopy(text);
      if (enriched === text) {
        return false;
      }
      event.preventDefault();
      event.clipboardData.setData('text/plain', enriched);
      return true;
    },
  });

  function attach(host: HTMLElement, model: DocModel): void {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingExternal) {
        pushingSelf = true;
        try {
          model.pushText(update.state.doc.toString(), 'cm6');
        } finally {
          pushingSelf = false;
        }
      }
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        reportSelection();
      }
    });

    const docText = model.getText();
    // Clamp a restored caret to the current document — the note file could
    // have shrunk on disk since the selection was saved.
    const initial = options.initialSelection;
    const selection = initial
      ? {
          anchor: Math.min(initial.anchor, docText.length),
          head: Math.min(initial.head, docText.length),
        }
      : undefined;

    const state = EditorState.create({
      doc: docText,
      selection,
      extensions: [
        history(),
        // Order matters: the bullet Tab handler and the markdown keymap (Enter
        // continues a list item — "auto bullets"; Backspace deletes markup)
        // must win over the default keymap's own Enter/Backspace. Neither
        // belongs in XML source, so both are dropped there.
        ...(isMarkdown ? [bulletIndentKeymap] : []),
        keymap.of([
          ...(isMarkdown ? markdownKeymap : []),
          ...defaultKeymap,
          ...historyKeymap,
          // Mod-g / Shift-Mod-g (find next / previous) are dropped: the app
          // binds mod+Shift+G to the git tab (ui/keymap.ts), and CM6 would
          // otherwise preventDefault the chord inside a focused editor. F3 /
          // Shift+F3 and the search panel's Enter keep next / previous.
          ...searchKeymap.filter((b) => b.key !== 'Mod-g'),
        ]),
        languageExtension,
        search({ top: true }),
        imagePasteHandler,
        copyEnrichHandler,
        plainDotsExtension,
        ...(isMarkdown ? [headingMarksExtension] : []),
        addedFlashField,
        removedFlashField,
        linkedField,
        themeCompartment.of([baseTheme, syntaxHighlighting(languageStyle)]),
        // Font size defaults to the CSS variable so M1 needs no wiring; M6's
        // setFontSize reconfigures this compartment to an explicit px value.
        fontSizeCompartment.of(fontSizeTheme('var(--editor-font-size, 14px)')),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        lineNumbersCompartment.of(showLineNumbers ? lineNumbers() : []),
        foldCompartment.of(isMarkdown && collapsibleHeadings ? headingFoldExtension : []),
        ...(options.placeholder ? [placeholder(options.placeholder)] : []),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'off' }),
        // Touch-only: double-tap the text to retract the soft keyboard.
        ...(options.dismissKeyboardOnDoubleTap ? [createKeyboardDismissGesture()] : []),
        updateListener,
      ],
    });

    view = new EditorView({ state, parent: host });

    // Model → editor: apply external changes (not our own echo) as ONE
    // transaction of minimal line-level edits (core/diff.ts), so the caret,
    // selection and scroll map through — a Live Edit merge landing three
    // paragraphs up must not move the line you are typing on. Never
    // recreate the view.
    unsubscribe = model.subscribe((change) => {
      if (pushingSelf || !view) {
        return;
      }
      const current = view.state.doc.toString();
      if (change.text === current) {
        return;
      }
      applyingExternal = true;
      try {
        view.dispatch({ changes: diffToChanges(current, change.text) });
      } finally {
        applyingExternal = false;
      }
    });

    reportSelection();
  }

  function detach(): void {
    // CM6 pushes synchronously on every edit, so there is no deferred
    // write-back to flush here — the detach contract is trivially met.
    unsubscribe?.();
    unsubscribe = null;
    for (const kind of ['added', 'removed'] as const) {
      const timer = flashTimers[kind];
      if (timer !== null) {
        clearTimeout(timer);
        flashTimers[kind] = null;
      }
    }
    view?.destroy();
    view = null;
  }

  return {
    attach,
    detach,
    focus() {
      view?.focus();
    },
    revealLine(line) {
      if (!view) {
        return;
      }
      // Clamp: the outline may be a debounce behind a doc that just shrank.
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
      });
      view.focus();
    },
    getCaretLine() {
      return view ? view.state.doc.lineAt(view.state.selection.main.head).number : null;
    },
    getTopLine() {
      if (!view) {
        return null;
      }
      const box = view.scrollDOM.getBoundingClientRect();
      if (box.height === 0) {
        return null; // hidden (display:none) — every rect reads zero
      }
      // CM6 block heights are measured from the top of the DOCUMENT, while
      // `documentTop` is where that top currently sits on screen: the
      // difference is how far the viewport's top edge is into the document.
      // Sample a couple of pixels IN, or a line aligned exactly to the top
      // edge reads as the one above it and every round trip drifts up a line.
      const block = view.lineBlockAtHeight(box.top - view.documentTop + TOP_LINE_SLOP_PX);
      return view.state.doc.lineAt(block.from).number;
    },
    scrollToLine(line) {
      if (!view) {
        return;
      }
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      // yMargin: 0 — the default 5px would park the line just below the top
      // edge, leaving the line above it on screen, and every round trip
      // through another mode would then drift up by one.
      view.dispatch({
        effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 0 }),
      });
    },
    getSelection() {
      const sel = view?.state.selection.main;
      return { anchor: sel?.anchor ?? 0, head: sel?.head ?? 0 };
    },
    setSelection(anchor, head) {
      if (!view) {
        return;
      }
      const max = view.state.doc.length;
      view.dispatch({
        selection: { anchor: Math.min(anchor, max), head: Math.min(head, max) },
        scrollIntoView: true,
      });
    },
    setWordWrap(on) {
      wordWrap = on;
      view?.dispatch({
        effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []),
      });
    },
    setLineNumbers(on) {
      showLineNumbers = on;
      view?.dispatch({
        effects: lineNumbersCompartment.reconfigure(on ? lineNumbers() : []),
      });
    },
    setCollapsibleHeadings(on) {
      collapsibleHeadings = on;
      // Dropping the extension drops its fold state too, so turning the
      // setting off unfolds everything at once.
      view?.dispatch({
        effects: foldCompartment.reconfigure(isMarkdown && on ? headingFoldExtension : []),
      });
    },
    setFontSize(px) {
      view?.dispatch({
        effects: fontSizeCompartment.reconfigure(fontSizeTheme(`${px}px`)),
      });
    },
    format(action) {
      if (view) {
        applyFormat(view, action);
      }
    },
    insertLinkTo(label, url, image) {
      if (view) {
        insertReference(view, label, url, image);
      }
    },
    insertText(text) {
      if (!view) {
        return;
      }
      const { state } = view;
      const range = state.selection.main;
      const before = state.doc.sliceString(Math.max(0, range.from - 1), range.from);
      const after = state.doc.sliceString(range.to, range.to + 1);
      const insert = joinDictation(before, text, after);
      if (!insert) {
        return;
      }
      view.dispatch({
        changes: { from: range.from, to: range.to, insert },
        // Caret after the words, before any spacing added for the next one.
        selection: { anchor: range.from + insert.trimEnd().length },
        scrollIntoView: true,
        userEvent: 'input.type',
      });
      view.focus();
    },
    flashRanges(ranges, kind) {
      if (!view || ranges.length === 0) {
        return;
      }
      view.dispatch({ effects: addFlash.of({ kind, ranges }) });
      const prior = flashTimers[kind];
      if (prior !== null) {
        clearTimeout(prior);
      }
      flashTimers[kind] = setTimeout(() => {
        flashTimers[kind] = null;
        view?.dispatch({ effects: clearFlash.of(kind) });
      }, FLASH_MS[kind]);
    },
    clearFlash(kind) {
      const prior = flashTimers[kind];
      if (prior !== null) {
        clearTimeout(prior);
        flashTimers[kind] = null;
      }
      view?.dispatch({ effects: clearFlash.of(kind) });
    },
    setLinkedRanges(ranges, reveal = false) {
      if (!view) {
        return;
      }
      const first = ranges[0];
      view.dispatch({
        effects: [
          setLinked.of(ranges),
          // `y: 'nearest'` — a range already on screen must not scroll, or the
          // pane would twitch every time the other one's selection changed.
          ...(reveal && first
            ? [
                EditorView.scrollIntoView(Math.min(first.from, view.state.doc.length), {
                  y: 'nearest',
                }),
              ]
            : []),
        ],
      });
    },
    revealRange(from, to) {
      if (!view) {
        return;
      }
      const max = view.state.doc.length;
      const anchor = Math.max(0, Math.min(from, max));
      const head = Math.max(anchor, Math.min(to, max));
      view.dispatch({
        selection: { anchor, head },
        effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
      });
      view.focus();
    },
    subscribeSelection(listener) {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
  };
}
