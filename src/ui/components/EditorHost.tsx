/**
 * EditorHost — THE never-remount component (invariant I7, src/ui/README).
 *
 * One instance per open tab, all mounted simultaneously; inactive ones are
 * hidden with `display: none`, never unmounted. The editor for a tab is
 * created exactly once, in an effect keyed on `tabId` only — mode changes go
 * through `modeSync.setMode` (a store action), never through props that would
 * re-run the effect and re-create editors.
 *
 * DOM shape: a stable editor pane (the mode-sync host) plus, in split mode, a
 * sibling preview pane. The editor pane node is identical across raw/split —
 * toggling only shows/hides the preview column, so CM6 is never disturbed.
 *
 * Split on an `.svg` tab puts the whiteboard EDITOR in that second pane
 * instead of a preview, over the same DocModel — so the drawing follows the
 * source and the source follows the drawing, and `ui/svg-split.ts` links what
 * each side is pointing at. It is the same shape as the preview column and
 * for the same reason: the source editor is mode-sync's and must survive
 * raw ⇄ split untouched (I7), while the board is built and torn down with the
 * mode, which costs it only its undo timeline — the documented price of every
 * whiteboard mode switch.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { codeLanguageFor } from '../../core/code/parse';
import { identifierHint } from '../../core/code/vocab';
import { isMarpDocument } from '../../core/deck';
import { docFamilyFor, docFamilyForTab } from '../../core/doc-family';
import { NEW_NOTE_HINT } from '../../core/new-note-hint';
import { localImageToInline } from '../../core/images';
import { headingIndexForLine, lineForHeadingIndex, scrollSurfaceFor } from '../../core/mode-scroll';
import { createModeSync, type AdapterFactory, type AdapterKind } from '../../core/mode-sync';
import { extractOutline } from '../../core/outline';
import { dirName, relativePath } from '../../core/session/plan-flush';
import type { EditorMode } from '../../core/types';
import { svgImageSources } from '../../core/whiteboard/color-mode';
import type { BoardColorMode } from '../../core/whiteboard/scene';
import { createCm6Adapter, type Cm6Adapter } from '../../editors/cm6';
import type { DeckEditorAdapter } from '../../editors/deck-editor';
import { createEditSwitchAdapter } from '../../editors/edit-switch';
import type { MilkdownAdapter } from '../../editors/milkdown';
import type { WhiteboardAdapter, WhiteboardAdapterOptions } from '../../editors/whiteboard';
import { linkSvgSplit, type SvgSplitLink } from '../svg-split';
import { NORMALIZATION_HINT } from '../../editors/wysiwyg-normalize';
import { attachCodeReviewPane, type CodeReviewPane } from '../../preview/code-review';
import { attachDeckPane } from '../../preview/deck';
import {
  applyMarpBrowser,
  createImageResolver,
  inlineDeckImages,
  mountSlide,
  renderDeck,
  stripLineStamps,
} from '../../preview/marp';
import { attachPreviewPane } from '../../preview/pane';
import { createReviewGit } from '../code-review-git';
import {
  clearScrollAnchor,
  peekScrollAnchor,
  registerScrollAnchor,
  scrollSurfaceToLine,
  takeScrollAnchor,
  unregisterScrollAnchor,
} from '../mode-scroll';
import {
  getSourceAdapter,
  registerEditAdapter,
  registerSourceAdapter,
  unregisterEditAdapter,
  unregisterSourceAdapter,
} from '../editor-registry';
import {
  enrichCopiedText,
  getCursor,
  noteCursor,
  openNotePath,
  pickImagePath,
  savePastedImageForTab,
  takePendingReveal,
} from '../session';
import {
  boardColorMenuStore,
  registerImageRefresher,
  unregisterImageRefresher,
} from '../stores/board-color-menu';
import { codeReviewStore, reviewStateFor } from '../stores/code-review';
import { diagramViewerStore } from '../stores/diagram-viewer';
import { externalLinkStore } from '../stores/external-link';
import { settingsStore } from '../stores/settings';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import {
  boardViewKey,
  clearWhiteboardAdapter,
  currentToolSettings,
  registerWhiteboardAdapter,
  unregisterWhiteboardAdapter,
  whiteboardStore,
} from '../stores/whiteboard';
import {
  previewNavStore,
  registerPreviewGoBack,
  registerPreviewReveal,
  unregisterPreviewGoBack,
  unregisterPreviewReveal,
} from '../stores/preview-nav';
import { isDark, subscribeDark } from '../theme';
import { isAndroid } from '../platform';
import { capturePhotoForScan, pickPhotoForScan } from '../scan-photo';
import { createScanDebugSaver } from '../scan-debug';
import { scanTextRecognizer } from '../scan-ocr';
import {
  clearReveal,
  deleteNote,
  dropMarks,
  editNote,
  loadMarks,
  openNoteAtLine,
  REVEAL_TTL_MS,
  useVoiceStore,
  voiceStore,
} from '../voice-comments';
import { openOverview } from '../notes-overview';
import { registerDeckPane, unregisterDeckPane } from '../stores/deck-show';
import { unitNoteLabel } from '../../core/note-marks';
import { pathKey } from '../../core/tab-workspaces';
import type { VoiceComment } from '../../core/comments';
import { ConflictBanner } from './ConflictBanner';
import { LiveEditBanner } from './LiveEditBanner';
import { DiffView } from './DiffView';
import { NoteComposer } from './NoteComposer';
import { diffViewStore, useDiffView } from '../stores/diff-view';

/** A stable empty list, so the panes' `setNotes` sees no change tick to tick. */
const NO_NOTES: readonly VoiceComment[] = [];

/** What both Review panes offer the review-notes wiring below. */
interface NotesPane {
  setLineHold(on: boolean): void;
  setNotes(notes: readonly VoiceComment[]): void;
  unmountComposer(): void;
  revealNotes(target: { line: number; unit?: string }): void;
}

/**
 * The review-notes half of a Review pane's store sync: the hold gesture and
 * the markers follow the toggle (loading the tab's notes when it comes on),
 * the inline composer is mounted while it is open on this tab, and a pending
 * reveal for this tab's document is taken and carried out. `mount` is how
 * this pane places the composer (by line, or by card).
 */
function syncNotesPane(
  tabId: string,
  pane: NotesPane,
  on: boolean,
  mount: (state: { line: number; unitId: string | null }) => void,
): void {
  const state = voiceStore.getState();
  pane.setLineHold(on);
  pane.setNotes(on ? (state.marks[tabId] ?? NO_NOTES) : NO_NOTES);
  if (on) {
    void loadMarks(tabId);
  }
  if (on && state.phase !== 'closed' && state.tabId === tabId && state.line !== null) {
    mount({ line: state.line, unitId: state.unitId });
  } else {
    pane.unmountComposer();
  }
  const { reveal } = state;
  if (!on || !reveal) {
    return;
  }
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  const path = tab ? (tab.filePath ?? tab.notePath) : null;
  if (!path || pathKey(path) !== pathKey(reveal.path)) {
    return;
  }
  clearReveal(reveal.seq);
  if (Date.now() - reveal.at <= REVEAL_TTL_MS) {
    pane.revealNotes({ line: reveal.line, ...(reveal.unit ? { unit: reveal.unit } : {}) });
  }
}

/**
 * Split-divider position, shared by every tab (module scope, not React
 * state — dragging fires on every pointermove and must never trigger a
 * re-render). Persists across tab switches for the session; not saved to
 * the manifest (splitting hairs over pixels isn't worth a persisted field).
 */
let splitRatio = 0.5;
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

function clampSplitRatio(ratio: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/**
 * Build this tab's whiteboard editor (the lazy chunk, invariant I8 — it loads
 * on the first Draw/Split attach and never at startup).
 *
 * Module-level and called from TWO places, which is the whole reason it is a
 * function: Draw mode's board is mode-sync's adapter for the editor pane,
 * Split mode's is a second instance in the column beside the source editor.
 * They are never attached at the same time, and everything per-tab they need
 * they read from the stores at call time, so the pair cannot drift.
 */
async function createBoardAdapter(
  tabId: string,
  pane: 'draw' | 'split',
  extra: Pick<WhiteboardAdapterOptions, 'onSelectionChange' | 'onRevealInSource'> = {},
): Promise<WhiteboardAdapter> {
  const { createWhiteboardAdapter } = await import('../../editors/whiteboard');
  const viewKey = boardViewKey(tabId, pane);
  return createWhiteboardAdapter({
    onOpenAsText: () => tabsStore.getState().setMode(tabId, 'raw'),
    // The ribbon owns the tool picker; the adapter reads it at the start of
    // each gesture and reports undo depth back, so neither side has to
    // subscribe to the other.
    getTool: () => currentToolSettings(),
    onStateChange: (state) => whiteboardStore.getState().reportTabState(tabId, state),
    // Bare-letter hotkeys on the focused board (V, P, T, R…): the adapter only
    // asks; the store — which the ribbon renders from — is what changes.
    onToolHotkey: (tool) => whiteboardStore.getState().setTool(tool),
    // The board clipboard lives in the store so a copy on one board can be
    // pasted on another; the adapter just reaches it.
    clipboard: {
      get: () => whiteboardStore.getState().clipboard,
      set: (clipboard) => whiteboardStore.getState().setClipboard(clipboard),
    },
    // Touch policy (phase 3): the preference lives in the store, the adapter
    // resolves it against the pen it has actually seen, and tells the store so
    // the ribbon can say so.
    getFingerDraws: () => whiteboardStore.getState().fingerDraws,
    onPenSeen: () => whiteboardStore.getState().notePenSeen(),
    // Viewport persistence is SESSION state — never the file, because panning
    // must not dirty a document. Keyed per PANE (`boardViewKey`): Draw's board
    // and Split's column are different sizes, so each keeps its own place.
    getSavedView: () => whiteboardStore.getState().viewByTab[viewKey] ?? null,
    onViewChange: (view) => whiteboardStore.getState().saveView(viewKey, view),
    // Photo acquisition is INJECTED (phase 4): the camera is an Android-only
    // IPC bridge and the picker is a native dialog, and neither belongs inside
    // an editor module. The adapter just gets two functions and a way to speak
    // to the user.
    scan: {
      capture: isAndroid() ? capturePhotoForScan : null,
      pick: isAndroid() ? null : pickPhotoForScan,
      onNotice: (message) => uiStore.getState().showNotice(message),
      // Text recognition (phase 7) is injected for the same reason: the
      // engines are platform bridges, and the null on macOS/Linux is what
      // makes the scan record "unavailable".
      recognize: scanTextRecognizer(),
      // "Debug insert": the same insert, plus every intermediate written into
      // a dated folder BESIDE the board (app-local storage only for a
      // never-saved board — see ui/scan-debug.ts). Injected for the same
      // layering reason as the camera — the editor must not know about storage.
      saveDebug: createScanDebugSaver(() => {
        const t = tabsStore.getState().tabs.find((tab) => tab.id === tabId);
        return t ? (t.filePath ?? t.notePath) : null;
      }),
      // The scan panel remembers its tuning across scans and relaunches; the
      // settings store is the persistence, the panel never sees it (I9).
      prefs: {
        get: () => ({
          preset: settingsStore.getState().settings.scanPreset,
          smoothing: settingsStore.getState().settings.scanSmoothing,
        }),
        set: ({ preset, smoothing }) =>
          settingsStore.getState().update({ scanPreset: preset, scanSmoothing: smoothing }),
      },
    },
    ...extra,
  });
}

/**
 * A board image in this tab's document was right-clicked (preview pane or
 * Edit-mode editor): open the colour-mode menu, handing it every board the
 * document references so "all boards in this document" can act on them.
 */
function openBoardColorMenu(
  tabId: string,
  info: { path: string; mode: BoardColorMode; x: number; y: number },
): void {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  const docPath = tab ? (tab.filePath ?? tab.notePath) : null;
  const dir = docPath ? dirName(docPath) : null;
  const docPaths = new Set<string>([info.path]);
  if (tab) {
    for (const raw of svgImageSources(tab.model.getText())) {
      const abs = localImageToInline(dir, raw);
      if (abs) {
        docPaths.add(abs);
      }
    }
  }
  boardColorMenuStore.getState().openFor({ ...info, docPaths: [...docPaths] });
}

function EditorHostImpl({ tabId, active }: { tabId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const previewHostRef = useRef<HTMLDivElement>(null);
  // The CM6 source adapter, captured when its factory runs, so live settings
  // changes (word wrap) can reconfigure it without re-mounting (I7). Font size
  // needs no hook here — it rides the `--editor-font-size` CSS variable.
  const sourceAdapterRef = useRef<Cm6Adapter | null>(null);
  /** The Edit adapter once created (lazy chunk) — for theme-driven image refreshes. */
  const editAdapterRef = useRef<MilkdownAdapter | null>(null);
  /** Draw mode's board (mode-sync's), once its factory has run — see below. */
  const drawAdapterRef = useRef<WhiteboardAdapter | null>(null);
  const mode = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.mode ?? 'raw');
  // A Marp deck (`marp: true` in the frontmatter) renders as slides instead
  // of a document in Split and Present. The flag is live in the store, so
  // adding the frontmatter to an open file swaps the pane in place.
  const deck = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.deck ?? false);
  // A drawing's second pane is the whiteboard editor, not a preview — same
  // element, different styling (a board owns its own scrolling).
  const boardSplit = useTabsStore((s) => {
    const t = s.tabs.find((tab) => tab.id === tabId);
    return t !== undefined && docFamilyFor(t.filePath ?? t.notePath) === 'svg';
  });
  // The inline review-note composer renders into this element; the Review
  // pane places it under the held line (`mountComposer`) — a portal, so the
  // composer is React while the pane around it is plain DOM.
  const composerSlot = useMemo(() => document.createElement('div'), []);
  const composerHere = useVoiceStore((s) => s.phase !== 'closed' && s.tabId === tabId);
  const conflict = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.conflict ?? false);
  const diffEntry = useDiffView((s) => s.byTab[tabId] ?? null);
  // The diff pane exists only while its conflict does — resolving the
  // conflict any way (Reload, Keep mine, a save, an auto-clear on re-check)
  // drops it. The store entry itself is closed by reload/keep-mine and on
  // unmount, so a re-flagged conflict starts with a fresh snapshot.
  const showDiff = conflict && diffEntry !== null;
  useEffect(
    () => () => {
      diffViewStore.getState().close(tabId);
      // The Review pane's per-tab view state is transient — it dies with the tab.
      codeReviewStore.getState().clear(tabId);
    },
    [tabId],
  );

  function startDividerDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const row = rowRef.current;
    const editorPane = hostRef.current;
    if (!row || !editorPane) {
      return;
    }
    function onMove(moveEvent: PointerEvent): void {
      const rect = row!.getBoundingClientRect();
      splitRatio = clampSplitRatio((moveEvent.clientX - rect.left) / rect.width);
      editorPane!.style.flex = `0 0 ${splitRatio * 100}%`;
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  useEffect(() => {
    const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
    const host = hostRef.current;
    if (!tab || !host) {
      return;
    }

    // Only the adapters this document family can actually use are supplied. An
    // .svg tab gets Draw (+ Raw, which is a free SVG source editor); a markdown
    // tab gets Edit. Anything else is a mode the status bar never offers.
    const family = docFamilyFor(tab.filePath ?? tab.notePath);
    // A brand-new note (not an opened file) explains itself while it is empty.
    const emptyHint = tab.kind === 'note' && family === 'markdown' ? NEW_NOTE_HINT : undefined;
    const familyAdapters: Partial<Record<AdapterKind, AdapterFactory>> =
      family === 'svg'
        ? {
            draw: async () => {
              const adapter = await createBoardAdapter(tabId, 'draw');
              // Kept so the Split column's board can hand the registry back to
              // this one on its way out (they share the tab's entry).
              drawAdapterRef.current = adapter;
              registerWhiteboardAdapter(tabId, adapter);
              return adapter;
            },
          }
        : {
            // Edit is two editors behind one adapter (editors/edit-switch.ts):
            // Milkdown for a note, the deck editor for a Marp deck — decided by
            // the CONTENT at attach time, and swapped if `marp: true` arrives
            // or leaves while Edit is showing. Both stay lazy (I8): each chunk
            // loads the first time its editor is needed, never at startup.
            wysiwyg: () => {
              const docPath = () => {
                const t = tabsStore.getState().tabs.find((tab) => tab.id === tabId);
                return t ? (t.filePath ?? t.notePath) : null;
              };
              let deckEditor: DeckEditorAdapter | null = null;
              const edit = createEditSwitchAdapter({
                isDeck: isMarpDocument,
                markdown: async () => {
                  const { createMilkdownAdapter } = await import('../../editors/milkdown');
                  const adapter = createMilkdownAdapter({
                    onNormalizationHint: () => uiStore.getState().showNotice(NORMALIZATION_HINT),
                    placeholder: emptyHint,
                    saveImage: (data) => savePastedImageForTab(tabId, data),
                    getDocPath: docPath,
                    onBoardContextMenu: (info) => openBoardColorMenu(tabId, info),
                  });
                  // The colour-mode toggle rewrites board files; the live image
                  // nodes reload theirs. Unregistered with the mode-sync below.
                  registerImageRefresher(`${tabId}:edit`, (paths) => adapter.refreshImages(paths));
                  editAdapterRef.current = adapter;
                  registerEditAdapter(tabId, adapter);
                  return adapter;
                },
                deck: async () => {
                  const { createDeckEditorAdapter } = await import('../../editors/deck-editor');
                  // Marp lives in preview/, which editors never import (I9):
                  // the engine is handed over, like the whiteboard's camera.
                  deckEditor = createDeckEditorAdapter({
                    engine: {
                      render: renderDeck,
                      mountSlide,
                      inlineImages: inlineDeckImages,
                      createImageResolver: () => createImageResolver(),
                      applyBrowser: applyMarpBrowser,
                      stripStamps: stripLineStamps,
                    },
                    getDocPath: docPath,
                    // Browse…: a path relative to the deck when there is one —
                    // a deck that travels with its images is the normal case.
                    pickImage: async () => {
                      const picked = await pickImagePath();
                      const path = docPath();
                      const relative = picked && path ? relativePath(dirName(path), picked) : null;
                      return relative ?? picked;
                    },
                    onOpenSource: (line) => {
                      tabsStore.getState().setMode(tabId, 'split');
                      // The source editor re-attaches on the mode-sync chain.
                      void tabsStore
                        .getState()
                        .tabs.find((t) => t.id === tabId)
                        ?.modeSync?.whenIdle()
                        .then(() => getSourceAdapter(tabId)?.revealLine(line));
                    },
                  });
                  return deckEditor;
                },
              });
              // Scroll anchor: neither Edit editor has source lines on screen.
              // Milkdown trades in headings and this port does the translation
              // (core/mode-scroll); the deck editor trades in slides.
              registerScrollAnchor(tabId, 'edit', {
                getTopLine: () => {
                  if (edit.activeKind() === 'deck') {
                    return deckEditor?.getCurrentLine() ?? null;
                  }
                  const index = editAdapterRef.current?.getTopHeadingIndex() ?? null;
                  if (index === null) {
                    return null;
                  }
                  return index < 0
                    ? 1
                    : lineForHeadingIndex(extractOutline(tab.model.getText()), index);
                },
                scrollToLine: (line) => {
                  if (edit.activeKind() === 'deck') {
                    deckEditor?.showLine(line);
                    return;
                  }
                  const index = headingIndexForLine(extractOutline(tab.model.getText()), line);
                  if (index >= 0) {
                    edit.revealHeading?.(index, 'start');
                  }
                },
              });
              return edit;
            },
          };

    const sync = createModeSync({
      model: tab.model,
      host,
      initialMode: tab.mode,
      adapters: {
        ...familyAdapters,
        source: () => {
          const adapter = createCm6Adapter({
            placeholder: emptyHint,
            wordWrap: settingsStore.getState().settings.wordWrap,
            lineNumbers: settingsStore.getState().settings.lineNumbers,
            collapsibleHeadings: settingsStore.getState().settings.collapsibleHeadings,
            initialSelection: getCursor(tabId) ?? undefined,
            onSelection: (pos) => {
              uiStore.getState().reportCursor(tabId, { line: pos.line, col: pos.col });
              noteCursor(tabId, { anchor: pos.anchor, head: pos.head });
            },
            saveImage: (data) => savePastedImageForTab(tabId, data),
            enrichCopy: (text) => enrichCopiedText(tabId, text),
            // Android: double-tap the text to dismiss the soft keyboard.
            dismissKeyboardOnDoubleTap: isAndroid(),
            // Raw mode on a whiteboard is an SVG source editor — highlight it
            // as XML, and drop the markdown-only auto-bullet behaviours. A code
            // file gets its language's grammar when Review can read it
            // (TypeScript/JavaScript, Rust); any other file is plain text.
            language:
              family === 'svg'
                ? 'xml'
                : family === 'code'
                  ? (codeLanguageFor(tab.filePath ?? tab.notePath) ?? 'plain')
                  : 'markdown',
          });
          sourceAdapterRef.current = adapter;
          registerSourceAdapter(tabId, adapter);
          registerScrollAnchor(tabId, 'source', {
            getTopLine: () => adapter.getTopLine(),
            scrollToLine: (line) => adapter.scrollToLine(line),
          });
          return adapter;
        },
      },
      onError: (error, failedMode) => {
        console.error(`[editor] ${failedMode} adapter failed`, error);
        uiStore.getState().showNotice(`Could not switch to ${failedMode} mode.`);
      },
    });

    tabsStore.getState().registerModeSync(tabId, sync);

    // Search "jump to line": a reveal parked for this tab's path (the file was
    // opened by search before any editor existed) fires once the initial
    // attach settles. In wysiwyg/Review mode there is no source adapter — the
    // entry is still consumed and the tab just opens (accepted degrade).
    const pendingLine = takePendingReveal(tab.filePath ?? tab.notePath);
    if (pendingLine !== null) {
      void sync.whenIdle().then(() => {
        sourceAdapterRef.current?.revealLine(pendingLine);
      });
    }

    // Live word-wrap: reconfigure the (already-mounted) CM6 editor when the
    // setting flips, instead of re-creating it. No-op while the source editor
    // hasn't been created yet (a tab that opened straight into wysiwyg) — the
    // factory reads the current setting when it eventually runs.
    let lastWordWrap = settingsStore.getState().settings.wordWrap;
    let lastLineNumbers = settingsStore.getState().settings.lineNumbers;
    let lastCollapsible = settingsStore.getState().settings.collapsibleHeadings;
    const unsubscribeSettings = settingsStore.subscribe((s) => {
      if (s.settings.wordWrap !== lastWordWrap) {
        lastWordWrap = s.settings.wordWrap;
        sourceAdapterRef.current?.setWordWrap(lastWordWrap);
      }
      if (s.settings.lineNumbers !== lastLineNumbers) {
        lastLineNumbers = s.settings.lineNumbers;
        sourceAdapterRef.current?.setLineNumbers(lastLineNumbers);
      }
      if (s.settings.collapsibleHeadings !== lastCollapsible) {
        lastCollapsible = s.settings.collapsibleHeadings;
        sourceAdapterRef.current?.setCollapsibleHeadings(lastCollapsible);
      }
      // Edit-mode boards bake the theme palette into their data URLs (like
      // the preview pane) — a palette change must re-bake them.
      if (s.settings.colorScheme !== lastScheme) {
        lastScheme = s.settings.colorScheme;
        editAdapterRef.current?.refreshTheme();
      }
    });
    let lastScheme = settingsStore.getState().settings.colorScheme;
    const unsubscribeEditDark = subscribeDark(() => editAdapterRef.current?.refreshTheme());

    return () => {
      unsubscribeSettings();
      unsubscribeEditDark();
      editAdapterRef.current = null;
      unregisterSourceAdapter(tabId);
      unregisterEditAdapter(tabId);
      unregisterScrollAnchor(tabId, 'source');
      unregisterScrollAnchor(tabId, 'edit');
      clearScrollAnchor(tabId);
      unregisterWhiteboardAdapter(tabId);
      unregisterImageRefresher(`${tabId}:edit`);
      void sync.dispose();
    };
    // tab.id only — see I7. Adding reactive deps would re-mount the editor.
  }, [tabId]);

  // The preview pane is not the source editor (I7 governs that alone) — it's a
  // plain DOM projection that mounts/unmounts with split OR Review mode. In read
  // mode it fills the row (the source editor is hidden via CSS); in split it
  // shares the row with the editor at the dragged ratio.
  useEffect(() => {
    if (mode !== 'split' && mode !== 'read') {
      return;
    }
    const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
    const host = previewHostRef.current;
    const editorPane = hostRef.current;
    if (!tab || !host || !editorPane) {
      return;
    }
    if (mode === 'split') {
      editorPane.style.flex = `0 0 ${splitRatio * 100}%`;
    }
    // Split on a drawing: the second pane holds the whiteboard EDITOR, not a
    // preview — both halves are live over the one DocModel, and `svg-split.ts`
    // links what each side is pointing at. Everything is async (the board is a
    // lazy chunk, and the source editor may still be attaching), so `cancelled`
    // guards every step: a fast Split → Raw flick must not leave a board
    // attached to a pane that is on its way out.
    if (mode === 'split' && docFamilyFor(tab.filePath ?? tab.notePath) === 'svg') {
      let cancelled = false;
      let board: WhiteboardAdapter | null = null;
      let link: SvgSplitLink | null = null;
      void (async () => {
        const created = await createBoardAdapter(tabId, 'split', {
          onSelectionChange: (refs) => link?.boardSelection(refs),
          onRevealInSource: (refs) => link?.revealInSource(refs),
        });
        if (cancelled) {
          return;
        }
        board = created;
        await created.attach(host, tab.model);
        if (cancelled) {
          created.detach();
          board = null;
          return;
        }
        // The ribbon's draw cluster drives whichever board is on screen.
        registerWhiteboardAdapter(tabId, created);
        // The source editor is mode-sync's, and the transition INTO split may
        // still be in flight (raw ⇄ split keeps CM6, but draw → split has to
        // attach it) — wait for the chain rather than racing it.
        await tabsStore
          .getState()
          .tabs.find((t) => t.id === tabId)
          ?.modeSync?.whenIdle();
        const sourceAdapter = getSourceAdapter(tabId);
        if (cancelled || !sourceAdapter) {
          return;
        }
        link = linkSvgSplit({ model: tab.model, source: sourceAdapter, board: created });
        // A board carrying a selection across a Draw → Split switch should
        // arrive with its source already marked.
        link.boardSelection(created.getSelection());
      })();
      return () => {
        cancelled = true;
        link?.dispose();
        link = null;
        board?.detach();
        board = null;
        // Hand the registry back to Draw mode's own board when this tab has
        // one; otherwise the tab simply has no board any more.
        const drawAdapter = drawAdapterRef.current;
        if (drawAdapter) {
          registerWhiteboardAdapter(tabId, drawAdapter);
        } else {
          clearWhiteboardAdapter(tabId);
        }
        editorPane.style.flex = ''; // back to the raw-mode CSS default
      };
    }
    // A code file's `read` mode is Review (core/doc-family `modeLabel`): the
    // structural pane replaces the markdown preview. Same host element, same
    // dark / voice-hold wiring; its view state lives in `stores/code-review`.
    if (mode === 'read' && docFamilyFor(tab.filePath ?? tab.notePath) === 'code') {
      const path = tab.filePath ?? tab.notePath ?? 'untitled';
      // "What changed" (review_plan.md §6): git facts arrive asynchronously and
      // are pushed into the pane; the pane renders its cards first regardless.
      // Created before the pane because the pane's first parse reports
      // synchronously through onModelChange.
      let review: CodeReviewPane | null = null;
      const reviewGit = createReviewGit({
        path,
        baseBranchSetting: () => settingsStore.getState().settings.reviewBaseBranch,
        getBaseline: () => reviewStateFor(tabId).baseline,
        setBaseline: (baseline) => codeReviewStore.getState().setBaseline(tabId, baseline),
        onGitInfo: (info) => review?.setGitInfo(info),
        onChanges: (changes, radar) => review?.setChanges(changes, radar),
      });
      review = attachCodeReviewPane(host, tab.model, {
        dark: isDark(),
        path,
        state: reviewStateFor(tabId),
        onAction: (action) => codeReviewStore.getState().dispatch(tabId, action),
        onOpenDiagram: (svg) => diagramViewerStore.getState().openWith(svg),
        onModelChange: (model, text) => reviewGit.modelChanged(model, text),
        // Review notes: holding a card opens the sheet on that declaration,
        // with the file's identifiers priming Whisper and snapping the
        // transcript, and the review context for the sidecar's preamble.
        onHoldUnit: (unit, model) =>
          void openNoteAtLine(tabId, unit.signatureLine, {
            unit: unitNoteLabel(unit),
            unitId: unit.id,
            quote: unit.signature,
            hint: identifierHint(model.identifiers),
            identifiers: model.identifiers,
            context: reviewGit.context(),
          }),
        // A card's callout edits and deletes in place; "All notes" is the overview.
        onEditNote: (id, text) => void editNote(tabId, id, text),
        onDeleteNote: (id) => void deleteNote(tabId, id),
        onOpenAllNotes: () => openOverview('current'),
      });
      const pane = review;
      let lastBaseline = reviewStateFor(tabId).baseline;
      const syncReviewState = () => {
        const next = reviewStateFor(tabId);
        pane.setState(next);
        if (next.baseline !== lastBaseline) {
          lastBaseline = next.baseline;
          reviewGit.baselineChanged();
        }
      };
      const unsubscribeReview = codeReviewStore.subscribe(syncReviewState);
      // The hold gesture, the note markers, the inline composer and reveals
      // follow the review-notes store; the composer sits under its card's head.
      const syncReviewHold = () =>
        syncNotesPane(tabId, pane, voiceStore.getState().armed, ({ unitId }) => {
          if (unitId) {
            pane.mountComposer(unitId, composerSlot);
          }
        });
      syncReviewHold();
      const unsubscribeReviewVoice = voiceStore.subscribe(syncReviewHold);
      const unsubscribeReviewDark = subscribeDark((dark) => pane.setDark(dark));
      // Git facts refresh when the tab gains focus (throttled inside), when the
      // window comes back, and at once when the base-branch setting changes.
      let wasActive = tabsStore.getState().activeTabId === tabId;
      const unsubscribeReviewFocus = tabsStore.subscribe(() => {
        const active = tabsStore.getState().activeTabId === tabId;
        if (active && !wasActive) {
          reviewGit.refresh();
        }
        wasActive = active;
      });
      const onWindowFocus = () => {
        if (tabsStore.getState().activeTabId === tabId) {
          reviewGit.refresh();
        }
      };
      window.addEventListener('focus', onWindowFocus);
      let lastBaseBranch = settingsStore.getState().settings.reviewBaseBranch;
      const unsubscribeReviewSettings = settingsStore.subscribe((s) => {
        if (s.settings.reviewBaseBranch !== lastBaseBranch) {
          lastBaseBranch = s.settings.reviewBaseBranch;
          reviewGit.refresh(true);
        }
      });
      reviewGit.refresh(true);
      registerScrollAnchor(tabId, 'rendered', {
        getTopLine: () => pane.getTopLine(),
        scrollToLine: (line) => pane.scrollToLine(line),
      });
      // Arriving from Raw: land on the card covering the line that was on
      // screen (the pane parks it until its first parse renders).
      const anchor = takeScrollAnchor(tabId);
      if (anchor !== null) {
        pane.scrollToLine(anchor);
      }
      if (wasActive) {
        host.focus();
      }
      return () => {
        unregisterScrollAnchor(tabId, 'rendered');
        unsubscribeReview();
        unsubscribeReviewVoice();
        dropMarks(tabId);
        unsubscribeReviewDark();
        unsubscribeReviewFocus();
        unsubscribeReviewSettings();
        window.removeEventListener('focus', onWindowFocus);
        reviewGit.dispose();
        pane.dispose();
      };
    }
    // A deck's Split column and Present light table are the deck pane
    // (preview/deck.ts): slides in shadow roots, notes under each in Present,
    // the cursor's slide highlighted in Split. Same anchor and review-note
    // wiring as the markdown pane; no in-pane link following, no diagrams.
    if (docFamilyForTab(tab) === 'deck') {
      const pane = attachDeckPane(host, tab.model, {
        variant: mode === 'read' ? 'read' : 'split',
        docPath: tab.filePath ?? tab.notePath,
        onOpenExternal: (url) => externalLinkStore.getState().request(url),
        onHoldLine: mode === 'read' ? (line) => void openNoteAtLine(tabId, line) : undefined,
        onEditNote: mode === 'read' ? (id, text) => void editNote(tabId, id, text) : undefined,
        onDeleteNote: mode === 'read' ? (id) => void deleteNote(tabId, id) : undefined,
        onOpenAllNotes: mode === 'read' ? () => openOverview('current') : undefined,
      });
      const syncDeckHold = () =>
        syncNotesPane(tabId, pane, mode === 'read' && voiceStore.getState().armed, ({ line }) =>
          pane.mountComposer(line, composerSlot),
        );
      syncDeckHold();
      const unsubscribeDeckVoice = voiceStore.subscribe(syncDeckHold);
      registerPreviewReveal(tabId, (index) => pane.scrollToHeading(index));
      const unsubscribeDeckPath = tabsStore.subscribe(() => {
        const t = tabsStore.getState().tabs.find((t) => t.id === tabId);
        pane.setDocPath(t ? (t.filePath ?? t.notePath) : null);
      });
      // Split: the slide under the caret follows the source editor. The ui
      // store only carries the ACTIVE tab's caret, which is the one typing.
      let unsubscribeCursor: (() => void) | null = null;
      if (mode === 'split') {
        const push = () => {
          const { cursor } = uiStore.getState();
          if (tabsStore.getState().activeTabId === tabId) {
            pane.setCursorLine(cursor?.line ?? null);
          }
        };
        push();
        unsubscribeCursor = uiStore.subscribe(push);
      }
      registerScrollAnchor(tabId, 'rendered', {
        getTopLine: () => pane.getTopLine(),
        scrollToLine: (line) => pane.scrollToLine(line),
      });
      registerDeckPane(tabId, pane);
      // Any theme change — light/dark flip or one light theme to another —
      // re-bakes the `--wb-*` palette into the deck's whiteboard images.
      const unsubscribeDeckDark = subscribeDark(() => pane.refreshTheme());
      let lastDeckScheme = settingsStore.getState().settings.colorScheme;
      const unsubscribeDeckScheme = settingsStore.subscribe(() => {
        const scheme = settingsStore.getState().settings.colorScheme;
        if (scheme !== lastDeckScheme) {
          lastDeckScheme = scheme;
          pane.refreshTheme();
        }
      });
      const anchor = mode === 'read' ? takeScrollAnchor(tabId) : peekScrollAnchor(tabId);
      if (anchor !== null) {
        pane.scrollToLine(anchor);
      }
      if (mode === 'read' && tabsStore.getState().activeTabId === tabId) {
        host.focus();
      }
      return () => {
        unregisterDeckPane(tabId);
        unregisterScrollAnchor(tabId, 'rendered');
        unsubscribeDeckVoice();
        unsubscribeDeckDark();
        unsubscribeDeckScheme();
        dropMarks(tabId);
        unsubscribeDeckPath();
        unsubscribeCursor?.();
        unregisterPreviewReveal(tabId);
        pane.dispose();
        if (mode === 'split') {
          editorPane.style.flex = '';
        }
      };
    }
    const pane = attachPreviewPane(host, tab.model, {
      dark: isDark(),
      docPath: tab.filePath ?? tab.notePath,
      // A followed link to an image (or any non-text file) opens in a tab —
      // the reader can only render markdown/text inline.
      onOpenFile: (path) => openNotePath(path),
      // Surface Back state so the fullscreen cluster can host the Back button
      // (the in-pane bar is hidden in fullscreen — see preview.css).
      onCanGoBackChange: (canGoBack) => previewNavStore.getState().setCanGoBack(tabId, canGoBack),
      // A clicked diagram opens the fullscreen zoomable viewer.
      onOpenDiagram: (svg) => diagramViewerStore.getState().openWith(svg),
      // An http(s) link is confirmed before it leaves the app — the pane never
      // opens one itself (the same prompt the app-wide link guard raises).
      onOpenExternal: (url) => externalLinkStore.getState().request(url),
      // A right-clicked board opens the theme/true colours menu.
      onBoardContextMenu: (info) => openBoardColorMenu(tabId, info),
      // Review notes: while the Review-mode toggle is armed, holding a line of
      // the rendered document opens the capture sheet for that source line.
      onHoldLine: mode === 'read' ? (line) => void openNoteAtLine(tabId, line) : undefined,
      // A block's callout edits and deletes in place; "All notes" is the overview.
      onEditNote: mode === 'read' ? (id, text) => void editNote(tabId, id, text) : undefined,
      onDeleteNote: mode === 'read' ? (id) => void deleteNote(tabId, id) : undefined,
      onOpenAllNotes: mode === 'read' ? () => openOverview('current') : undefined,
    });
    // The hold gesture, the note markers, the inline composer and reveals
    // follow the review-notes store (Review mode only); the composer sits
    // under the held line's block.
    const syncLineHold = () =>
      syncNotesPane(tabId, pane, mode === 'read' && voiceStore.getState().armed, ({ line }) =>
        pane.mountComposer(line, composerSlot),
      );
    syncLineHold();
    const unsubscribeVoice = voiceStore.subscribe(syncLineHold);
    registerPreviewGoBack(tabId, () => pane.goBack());
    registerImageRefresher(`${tabId}:preview`, (paths) => pane.refreshImages(paths));
    registerPreviewReveal(tabId, (index) => pane.scrollToHeading(index));
    const unsubscribeDark = subscribeDark((dark) => pane.setDark(dark));
    // A theme change that KEEPS the light/dark boolean (one light theme to
    // another) still recolours the `--wb-*` palette, which whiteboard images
    // bake into their data URLs — tell the pane so it re-inlines them.
    // setDark's render wins the race when both fire (same render sequence).
    let lastScheme = settingsStore.getState().settings.colorScheme;
    const unsubscribeScheme = settingsStore.subscribe(() => {
      const scheme = settingsStore.getState().settings.colorScheme;
      if (scheme !== lastScheme) {
        lastScheme = scheme;
        pane.refreshTheme();
      }
    });
    // A freshly-created untitled note has no path yet; the flusher assigns one
    // later. Keep the pane's docDir in sync so in-pane relative links/images
    // resolve once the note is saved — WITHOUT re-keying this effect (which
    // would remount the pane and lose scroll). setDocPath no-ops when the dir
    // is unchanged, so firing on every store tick is cheap.
    const unsubscribePath = tabsStore.subscribe(() => {
      const t = tabsStore.getState().tabs.find((t) => t.id === tabId);
      pane.setDocPath(t ? (t.filePath ?? t.notePath) : null);
    });
    registerScrollAnchor(tabId, 'rendered', {
      getTopLine: () => pane.getTopLine(),
      scrollToLine: (line) => pane.scrollToLine(line),
    });
    // Keep the reader's place across the switch. In Review the pane OWNS the
    // scroll position, so it consumes the anchor; in split the source editor
    // owns it and the preview column just rides along (peek, don't consume).
    const anchor = mode === 'read' ? takeScrollAnchor(tabId) : peekScrollAnchor(tabId);
    if (anchor !== null) {
      pane.scrollToLine(anchor);
    }
    // Review mode: move focus onto the scrollable reading pane so keyboard
    // scrolling works and the hidden source editor can never take a keystroke.
    if (mode === 'read' && tabsStore.getState().activeTabId === tabId) {
      host.focus();
    }
    return () => {
      unregisterScrollAnchor(tabId, 'rendered');
      unsubscribeVoice();
      dropMarks(tabId);
      unsubscribeDark();
      unsubscribeScheme();
      unsubscribePath();
      unregisterPreviewGoBack(tabId);
      unregisterPreviewReveal(tabId);
      unregisterImageRefresher(`${tabId}:preview`);
      previewNavStore.getState().clear(tabId);
      pane.dispose();
      if (mode === 'split') {
        editorPane.style.flex = ''; // back to the raw-mode CSS default
      }
    };
    // `deck` re-keys the effect on purpose: the frontmatter arriving or leaving
    // swaps the markdown pane for the deck pane (or back) in place.
  }, [tabId, mode, composerSlot, deck]);

  // The other half of the mode-switch scroll anchor: the surfaces that are
  // NOT created by the effect above. The preview pane consumes the anchor
  // itself (it is built fresh and must park the line until it renders); the
  // source editor and the rich editor are already attached — or are being
  // re-attached by mode-sync — so this waits for the transition to settle and
  // for the browser to lay the (until now `display: none`) pane out.
  useEffect(() => {
    const surface = scrollSurfaceFor(mode);
    if (surface === null || surface === 'rendered') {
      return;
    }
    const line = takeScrollAnchor(tabId);
    if (line === null) {
      return;
    }
    let cancelled = false;
    const sync = tabsStore.getState().tabs.find((t) => t.id === tabId)?.modeSync;
    void Promise.resolve(sync?.whenIdle()).then(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          scrollSurfaceToLine(tabId, surface, line);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [tabId, mode]);

  return (
    <div
      className="editor-host"
      // `display: none` on purpose, and deliberately NOT what a terminal tab
      // does (invariant I10, TerminalTab.tsx): a hidden CM6/preview must not
      // lay out, while a hidden terminal pane must keep its box or its pty is
      // resized to 1x1. Same problem, opposite right answer.
      style={{ display: active ? 'flex' : 'none' }}
      data-mode={mode satisfies EditorMode}
    >
      <ConflictBanner tabId={tabId} />
      <LiveEditBanner tabId={tabId} />
      {composerHere && createPortal(<NoteComposer />, composerSlot)}
      {showDiff && diffEntry && (
        <DiffView
          oldText={diffEntry.diskText}
          newText={
            tabsStore
              .getState()
              .tabs.find((t) => t.id === tabId)
              ?.model.getText() ?? ''
          }
          oldLabel="On disk"
          newLabel="In editor"
        />
      )}
      {/* Hidden (not unmounted) while the diff is shown — same I7 rule as an
          inactive tab: the editor must survive with its state intact. */}
      <div ref={rowRef} className="editor-row" style={showDiff ? { display: 'none' } : undefined}>
        <div ref={hostRef} className="editor-pane" />
        {mode === 'split' && (
          <div
            className="split-divider"
            onPointerDown={startDividerDrag}
            role="separator"
            aria-orientation="vertical"
          />
        )}
        {(mode === 'split' || mode === 'read') && (
          <div
            ref={previewHostRef}
            className={
              boardSplit
                ? 'split-board'
                : `preview ${mode === 'read' ? 'reader-preview' : 'split-preview'}`
            }
            tabIndex={mode === 'read' ? 0 : undefined}
          />
        )}
      </div>
    </div>
  );
}

export const EditorHost = memo(EditorHostImpl);
