/**
 * StatusBar — mode segment control, caret position, word count, and the
 * transient notice area (editor errors now; flush errors / hints later). On
 * a git tab the segments' room holds GitStatusBar instead (branch picker,
 * Fetch / Pull / Push).
 *
 * Reads the active tab's mode + word count from the tabs store and the caret
 * readout from the ui store (kept separate so caret moves don't re-render the
 * TabBar). The three-segment control switches raw ⇄ split ⇄ wysiwyg via the
 * store's `setMode`, which drives the tab's ModeSync.
 */

import type { MouseEvent as ReactMouseEvent } from 'react';

import { deckSummary, slideIndexForLine, splitSlides } from '../../core/deck';
import { allowedModesFor, docFamilyForTab, modeLabel, type DocFamily } from '../../core/doc-family';
import { formatClockTime, isLiveEditTab } from '../../core/live-edit';
import type { EditorMode } from '../../core/types';
import { useLiveEditStore } from '../stores/live-edit';
import { usePdfViewStore } from '../stores/pdf-view';
import { useSettingsStore } from '../stores/settings';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { useUiStore } from '../stores/ui';
import { downloadAndInstall, useUpdateStore } from '../update';
import { GitStatusBar } from './git/GitStatusBar';

/**
 * Tooltip per mode; the label comes from `modeLabel` (core/doc-family) and
 * WHICH ones a tab offers from its doc family. `read` on a code file is
 * Review — the structural view — so its hint differs too.
 */
const MODE_HINTS: Record<EditorMode, string> = {
  raw: 'Source (Ctrl/Cmd+1)',
  split: 'Source + preview (Ctrl/Cmd+2)',
  wysiwyg: 'WYSIWYG (Ctrl/Cmd+3)',
  read: 'Reader — read-only (Ctrl/Cmd+4)',
  // No digit chord: mod+1..4 are the markdown modes, and mod+1 is Raw on an
  // .svg tab too.
  draw: 'Vector graphics',
  // Never rendered: the status bar is hidden entirely on a terminal tab, and
  // 'term' is the only mode its family allows so there is nothing to pick.
  term: 'Shell',
  // Likewise never rendered: a tool tab's family allows only this mode, so the
  // segment strip has nothing to offer and is not drawn.
  tool: 'Git',
};
const REVIEW_HINT = 'Review — the structure of the code, read-only (Ctrl/Cmd+4)';
const PRESENT_HINT = 'Present — the slides with their notes; F11 for the show (Ctrl/Cmd+4)';
const PDF_REVIEW_HINT = 'Review — the PDF, read-only';
const DECK_EDIT_HINT =
  'Edit the slides — reorder, restyle, click any text to change it (Ctrl/Cmd+3)';
const BOARD_SPLIT_HINT = 'Source + drawing, each following the other (Ctrl/Cmd+2)';

/** The one hint that differs per family besides `read`: Split on a drawing. */
function splitHint(family: DocFamily): string {
  return family === 'svg' ? BOARD_SPLIT_HINT : MODE_HINTS.split;
}

function readHint(family: DocFamily): string {
  return family === 'code'
    ? REVIEW_HINT
    : family === 'deck'
      ? PRESENT_HINT
      : family === 'pdf'
        ? PDF_REVIEW_HINT
        : MODE_HINTS.read;
}

function ModeSegments({
  activeMode,
  tabId,
  family,
}: {
  activeMode: EditorMode;
  tabId: string;
  family: DocFamily;
}) {
  return (
    <div className="mode-segments" role="group" aria-label="Edit mode">
      {allowedModesFor(family).map((mode) => (
        <button
          key={mode}
          className={`mode-segment${mode === activeMode ? ' mode-segment-active' : ''}`}
          aria-pressed={mode === activeMode}
          title={
            mode === 'read'
              ? readHint(family)
              : mode === 'split'
                ? splitHint(family)
                : mode === 'wysiwyg' && family === 'deck'
                  ? DECK_EDIT_HINT
                  : MODE_HINTS[mode]
          }
          onClick={() => tabsStore.getState().setMode(tabId, mode)}
        >
          {modeLabel(mode, family)}
        </button>
      ))}
    </div>
  );
}

/**
 * Unobtrusive update chip: appears only when a newer release is
 * known; one click downloads, installs, and relaunches. Never a dialog.
 */
function UpdateChip() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  if (phase !== 'available' && phase !== 'downloading') {
    return null;
  }
  const busy = phase === 'downloading';
  return (
    <button
      className="statusbar-update-chip"
      disabled={busy}
      title={busy ? 'Downloading update…' : `Update to v${version} and restart`}
      onClick={() => void downloadAndInstall()}
    >
      {busy ? 'Updating…' : `Update available: v${version}`}
    </button>
  );
}

/**
 * Live Edit chip: shown while the active tab merges changes from a shared
 * folder. The dot pulses once per merge (the keyed span remounts, restarting
 * its animation) and the tooltip says when the last change landed. Not a
 * button — the toggle lives in the Save menu, where a stray click can't
 * silently turn merging off.
 */
function LiveChip({ tabId }: { tabId: string }) {
  const kind = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.kind ?? null);
  const filePath = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  const override = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.liveEdit ?? null);
  const workspaces = useSettingsStore((s) => s.settings.workspaces);
  const activity = useLiveEditStore((s) => s.byTab[tabId]);
  if (kind === null || !isLiveEditTab({ kind, filePath, liveEdit: override }, workspaces)) {
    return null;
  }
  const title = activity
    ? `Live edit — last merged a change from disk at ${formatClockTime(activity.lastMergeAt)}. This file saves as you type; turn it off from the Save menu.`
    : 'Live edit — this file saves as you type and merges changes other people save to it. Turn it off from the Save menu.';
  return (
    <span className="statusbar-live-chip" title={title} role="status">
      <span
        key={activity?.merges ?? 0}
        className="statusbar-live-dot"
        data-pulse={activity ? '' : undefined}
        aria-hidden="true"
      />
      Live
    </span>
  );
}

export function StatusBar() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const cursor = useUiStore((s) => s.cursor);
  const notice = useUiStore((s) => s.notice);
  const pdfInfo = usePdfViewStore((s) => (active ? s.byTab[active.id] : undefined));

  // Right-click anywhere on the bar: nothing here has a menu of its own, so
  // swallow the event rather than let the webview default (Back / Reload /
  // Inspect) through. Mirrors the same guard in Ribbon.
  const swallowContextMenu = (e: ReactMouseEvent) => e.preventDefault();

  if (!active) {
    return <div className="statusbar" onContextMenu={swallowContextMenu} />;
  }

  const words = active.wordCount;
  const chars = active.charCount;
  const family = docFamilyForTab(active);
  // A family with ONE mode (a tool tab — the git tab; a terminal never gets
  // here) has nothing to pick and no text to count: the git tab puts its
  // branch picker and network buttons where the segments would sit, and the
  // bar keeps its notice area and the chips. A PDF has one mode too, but it
  // is a document: its lone Review segment says what you are looking at, and
  // the readout counts pages.
  const pdf = family === 'pdf';
  const singleMode = allowedModesFor(family).length === 1 && !pdf;
  const gitRoot = active.kind === 'git' ? active.gitRoot : null;
  // A deck reads in slides, not lines: the caret becomes `Slide 4 / 12` and
  // the word count a talk length (core/deck). The split is cheap — it is a
  // line scan of a document that is, by nature, short.
  const slides = family === 'deck' ? splitSlides(active.model.getText()) : null;
  const caret = pdf
    ? pdfInfo && pdfInfo.pages > 0
      ? `Page ${pdfInfo.page} / ${pdfInfo.pages}`
      : ''
    : slides
      ? `Slide ${slideIndexForLine(slides, cursor?.line ?? 1) + 1} / ${slides.length}`
      : cursor
        ? `Ln ${cursor.line}, Col ${cursor.col}`
        : 'Ln 1, Col 1';

  return (
    <div className="statusbar" onContextMenu={swallowContextMenu}>
      {gitRoot !== null ? (
        <GitStatusBar root={gitRoot} />
      ) : singleMode ? null : active.readOnly && !pdf ? (
        <span className="statusbar-readonly" title="This document can be read but not edited">
          Read-only
        </span>
      ) : (
        <ModeSegments activeMode={active.mode} tabId={active.id} family={family} />
      )}
      {import.meta.env.DEV && (
        <span className="statusbar-dev" title="Running from a development build (tauri dev)">
          dev
        </span>
      )}
      <div className="statusbar-notice" role="status">
        {notice}
      </div>
      <LiveChip tabId={active.id} />
      <UpdateChip />
      {singleMode ? null : (
        <div className="statusbar-meta">
          <span className="statusbar-caret">{caret}</span>
          {pdf ? null : slides ? (
            <span
              className="statusbar-words"
              title="Slides, and a talk length at about 130 words a minute"
            >
              {deckSummary(slides.length, words)}
            </span>
          ) : (
            <>
              <span className="statusbar-words">
                {words} {words === 1 ? 'word' : 'words'}
              </span>
              <span className="statusbar-chars">
                {chars} {chars === 1 ? 'char' : 'chars'}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
