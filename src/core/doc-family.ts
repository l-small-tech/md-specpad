/**
 * What KIND of document a path holds, and therefore which editor modes make
 * sense for it.
 *
 * Until the whiteboard, every editable tab was markdown and every mode applied
 * everywhere. An `.svg` tab is still an ordinary `kind:'file'` tab — same dirty
 * tracking, session buffering, Ctrl+S, conflict detection, tear-off — it just
 * offers a different set of modes: Draw (the whiteboard editor), Raw (the CM6
 * source view, which is a free SVG source editor) and Split (both at once).
 *
 * Deliberately keyed on the mode, not the tab kind: `parseManifest` hard-
 * validates `kind` but never validates `mode`, so a `mode:'draw'` file tab
 * round-trips through an OLD build of the app, where `kindFor` degrades it to
 * the source editor instead of self-healing the whole session away.
 */

import { isAudioPath } from './audio';
import { isImagePath } from './images';
import { isImportablePath } from './import/registry';
import { isPdfPath } from './pdf';
import { extName } from './session/plan-flush';
import { isEditableTextPath } from './text-files';
import type { EditorMode, TabKind } from './types';

export type DocFamily = 'markdown' | 'svg' | 'code' | 'terminal' | 'deck' | 'tool' | 'pdf';

/**
 * Order matters: this is the order the mode segments are drawn in. Every
 * family leads with `raw`, so the source view sits in the same place on every
 * kind of tab. It is NOT the default-mode order — that lives in
 * `FAMILY_DEFAULTS` below.
 */
const MARKDOWN_MODES: readonly EditorMode[] = ['raw', 'split', 'wysiwyg', 'read'];
/**
 * Split on a drawing is the SOURCE beside the BOARD — the same `split` value
 * markdown uses (so mod+2, the manifest and `isModeAllowed` need nothing new),
 * with the whiteboard editor in the second pane instead of the preview. Both
 * halves are live: an edit on either side lands in the one DocModel and the
 * other re-reads it, and the two panes point at each other's current element
 * (`core/whiteboard/locate.ts`).
 */
const SVG_MODES: readonly EditorMode[] = ['raw', 'split', 'draw'];
/**
 * Any other file (`.ts`, `.json`, `Makefile`…) — listed where the user shows
 * unsupported files. It is not markdown, so rendering it (Edit, split preview)
 * would mangle it: the source editor applies, plus `read`, which for this
 * family is *Review* — the structural, read-only view of a code file
 * (`preview/code-review.ts`; review_plan.md §1). The mode VALUE stays `read`
 * so session manifests, the mode picker, mod+4 and `isModeAllowed` all work
 * unchanged; only the label is *Review* (`modeLabel`).
 */
const CODE_MODES: readonly EditorMode[] = ['raw', 'read'];
/**
 * A terminal offers exactly one mode. It still goes through this table so the
 * mode picker and the mod+1..4 shortcuts filter it out with the same
 * `isModeAllowed` check everything else uses, instead of a special case each.
 */
const TERMINAL_MODES: readonly EditorMode[] = ['term'];
/**
 * A tool tab (the git tab) likewise offers exactly one mode. Kept apart from
 * the terminal family so the two can differ in chrome: a terminal hides the
 * whole document chrome, a tool tab keeps the explorer and the status bar.
 */
const TOOL_MODES: readonly EditorMode[] = ['tool'];
/**
 * A Marp slide deck: a markdown file whose frontmatter says `marp: true`
 * (`core/deck.ts isMarpDocument`). Detection is CONTENT-keyed — the one
 * family that is — so it arrives through `docFamilyForTab`'s `deck` flag,
 * which the tabs store keeps live as the text changes; `docFamilyFor` (a
 * path alone) can never say 'deck'.
 *
 * Raw and Split as for markdown (Split's preview column shows slides), and
 * `read` — labelled *Present* — is the light table: full-width slides with
 * their speaker notes, and the show itself when the window is full screen (F11).
 *
 * Edit is the same `wysiwyg` VALUE markdown uses (so mod+3, the manifest and
 * the default-mode setting need nothing new) but NOT the same editor: a
 * Milkdown round-trip would mangle Marp's directive comments
 * (`<!-- _class: lead -->`) and `![bg]` alt syntax, so on a deck the mode is
 * the deck editor (`editors/deck-editor.ts`) — filmstrip, rendered slide,
 * inspector — whose every gesture is a line-precise source edit
 * (`core/deck-edit.ts`). `editors/edit-switch.ts` picks between the two by
 * content, and swaps them if the frontmatter arrives or leaves mid-Edit.
 */
const DECK_MODES: readonly EditorMode[] = ['raw', 'split', 'wysiwyg', 'read'];
/**
 * A PDF: Review only, read-only for now. The mode VALUE is `read` (labelled
 * Review, as on a code file) so the manifest, mod+4 and `isModeAllowed` need
 * nothing new; the tab itself is an `import`-kind viewer tab routed to the
 * PDF viewer by extension (core/pdf.ts), not an editor.
 */
const PDF_MODES: readonly EditorMode[] = ['read'];

/**
 * No path (an unsaved note) is markdown. Images and the other importable
 * documents stay 'markdown' too: they open as viewer/import tabs, never
 * through a mode. A PDF is its own family — the viewer is its Review mode.
 */
export function docFamilyFor(path: string | null | undefined): DocFamily {
  if (!path) {
    return 'markdown';
  }
  if (extName(path).toLowerCase() === '.svg') {
    return 'svg';
  }
  if (isPdfPath(path)) {
    return 'pdf';
  }
  return isEditableTextPath(path) ||
    isImagePath(path) ||
    isAudioPath(path) ||
    isImportablePath(path)
    ? 'markdown'
    : 'code';
}

/**
 * The family of a whole tab. A terminal tab has no path at all, so the
 * path-keyed function above cannot see it — callers holding a tab use this
 * one, callers holding only a path use `docFamilyFor`.
 */
export function docFamilyForTab(tab: {
  kind: TabKind;
  filePath?: string | null;
  notePath?: string | null;
  /** The text declares `marp: true` (tabs store `deck`). Only a markdown tab can. */
  deck?: boolean;
}): DocFamily {
  if (tab.kind === 'terminal') {
    return 'terminal';
  }
  if (tab.kind === 'git') {
    return 'tool';
  }
  const family = docFamilyFor(tab.filePath ?? tab.notePath);
  return family === 'markdown' && tab.deck === true ? 'deck' : family;
}

export function allowedModesFor(family: DocFamily): readonly EditorMode[] {
  switch (family) {
    case 'svg':
      return SVG_MODES;
    case 'code':
      return CODE_MODES;
    case 'terminal':
      return TERMINAL_MODES;
    case 'tool':
      return TOOL_MODES;
    case 'deck':
      return DECK_MODES;
    case 'pdf':
      return PDF_MODES;
    default:
      return MARKDOWN_MODES;
  }
}

export function isModeAllowed(family: DocFamily, mode: EditorMode): boolean {
  return allowedModesFor(family).includes(mode);
}

const MODE_LABELS: Record<EditorMode, string> = {
  raw: 'Raw',
  split: 'Split',
  wysiwyg: 'Edit',
  read: 'Review',
  draw: 'Draw',
  term: 'Terminal',
  tool: 'Git',
};

/**
 * The name a mode is shown under for a document family — the ONE place the
 * label is decided, so the status bar, the palette and any tooltip agree.
 * `read` is *Review* for every family (for code, the same mode value renders
 * the file's structure instead of markdown) except a deck, where it is
 * *Present* — the same mode value, the light table of slides.
 */
export function modeLabel(mode: EditorMode, family: DocFamily): string {
  return mode === 'read' && family === 'deck' ? 'Present' : MODE_LABELS[mode];
}

/**
 * The mode a family falls back to. Kept separate from the segment order in
 * the tables above, because for SVG the two disagree: Raw is drawn first (so
 * it lines up with every other family's first segment) but opening a drawing
 * should land you in Draw.
 */
const FAMILY_DEFAULTS: Record<DocFamily, EditorMode> = {
  markdown: 'raw',
  svg: 'draw',
  code: 'raw',
  terminal: 'term',
  tool: 'tool',
  // Source beside slides: where a deck being written (usually by an agent)
  // is watched. Edit is one segment away once it is time to tweak.
  deck: 'split',
  pdf: 'read',
};

/**
 * `preferred` if this family supports it, else the family's natural default
 * (Draw for a whiteboard, the caller's markdown mode otherwise). This is the
 * self-heal for a manifest — or a `lastFileMode` — carrying a mode from the
 * other family.
 */
export function defaultModeFor(family: DocFamily, preferred: EditorMode): EditorMode {
  return allowedModesFor(family).includes(preferred) ? preferred : FAMILY_DEFAULTS[family];
}
