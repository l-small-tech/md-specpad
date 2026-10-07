/**
 * Tabs store — the app's central model of open documents.
 *
 * A vanilla Zustand store (src/README "Store conventions"): non-React code
 * (the session flusher, the keyboard dispatcher) subscribes to `tabsStore`
 * directly; components use `useTabsStore` with narrow selectors.
 *
 * Each tab owns two non-serializable objects that must never leak into
 * anything persisted (planFlush receives a serializable view in M2):
 *   - `model`    — the canonical DocModel (invariant I1).
 *   - `modeSync` — the mode-switch state machine, registered by EditorHost
 *     once the editor is mounted (I7: attached exactly once per tab).
 *
 * Derived, cached-in-entry fields kept in sync with the model:
 *   - `title`     = customTitle ?? deriveTitle(text)  (recomputed on change)
 *   - `wordCount` = words in the current text          (for the status bar)
 * Both update inside a single model subscription so a keystroke re-renders
 * the TabBar exactly once.
 *
 * Session persistence (M2) lives at the edges of this store:
 *   - Every user-driven change calls `requestFlush()` (see flush-signal.ts).
 *     Caret moves are the exception — those persist opportunistically at the
 *     next flush, captured by the session controller, not routed through here.
 *   - Discarding a note tab records its file in `closedNotePaths`; closing a
 *     file tab records its id in `obsoleteBufferTabIds`. The next flush deletes
 *     them and calls `applyFlushResult` to consume the tombstones.
 *   - `restoreSession` rebuilds the whole tab set from a parsed manifest at
 *     boot; the initial auto-created tab is replaced wholesale.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { nanoid } from 'nanoid';
import { createDocModel, type DocModel } from '../../core/doc-model';
import { deriveTitle, slugifyTitle, stripExtension } from '../../core/title';
import { baseName } from '../../core/session/plan-flush';
import {
  defaultModeFor,
  docFamilyFor,
  docFamilyForTab,
  isModeAllowed,
} from '../../core/doc-family';
import { resolveTerminalProfile } from '../../core/settings';
import type { ModeSync } from '../../core/mode-sync';
import type { EditorMode, TabKind, TabState, TerminalSnapshot } from '../../core/types';
import { orderTabsByWorkspace, pathKey } from '../../core/tab-workspaces';
import { workspaceCueFor } from '../workspace-cues';
import { captureScrollAnchor } from '../mode-scroll';
import { settingsStore } from './settings';
import { activePaneCwd, terminalsStore } from './terminals';
import { liveEditStore } from './live-edit';
import { requestFlush } from './flush-signal';
import { isMarpDocument } from '../../core/deck';
import { isMobile } from '../platform';

/**
 * A tab entry = the serializable {@link TabState} plus the live objects and
 * derived display fields. Only the TabState-shaped subset is ever persisted.
 */
export interface TabEntry extends TabState {
  model: DocModel;
  /** Null until EditorHost mounts and calls `registerModeSync`. */
  modeSync: ModeSync | null;
  /** Displayed tab label: customTitle ?? deriveTitle(text). */
  title: string;
  wordCount: number;
  /** Character count of the current text (status bar); kept live with wordCount. */
  charCount: number;
  /**
   * The text's frontmatter says `marp: true` (`core/deck isMarpDocument`),
   * which makes a markdown tab a slide deck (`docFamilyForTab` → 'deck').
   * Kept live with wordCount, so adding or removing the frontmatter re-derives
   * the family — and the modes offered — while the tab is open.
   */
  deck: boolean;
  /** kind='file' only: model.isDirty('file'), cached for the TabBar dot (M3). */
  dirty: boolean;
  /** kind='file' only: the file changed on disk since savedMtimeMs (M3 ConflictBanner). */
  conflict: boolean;
  /**
   * VSCode-style preview tab: opened by a single explorer click, shown in
   * italic, and reused (replaced) when another file is previewed. Cleared —
   * promoted to a permanent tab — on the first user edit, an explorer
   * double-click, or "Keep open". Never persisted (restore yields permanent
   * tabs); a session-only display flag like `title`/`dirty`.
   */
  preview: boolean;
  /**
   * The file lives in a read-only workspace (the bundled docs): the mode is
   * pinned to 'read' and save/rename are refused. Not persisted — recomputed
   * from the file's path against settings at open/restore time (session.ts).
   */
  readOnly: boolean;
  /**
   * kind='terminal' only: the focused pane's OSC 0/2 title, mirrored here by
   * the terminals store so `tabDisplayTitle` stays a pure function of the tab.
   * Null until a shell sets one — the profile name is the fallback.
   */
  terminalTitle: string | null;
  /**
   * kind='terminal' only: the focused pane's working directory — its last
   * OSC 7, else the directory it was spawned in — mirrored from the terminals
   * store (see the subscription beside `setTerminalCwd`). It is what places a
   * terminal in a workspace for the strip's color cue (`workspaceCueFor`), so
   * a shell that `cd`s into another workspace changes color, and one that
   * leaves every open workspace loses it. Not persisted: the pane cwds in the
   * terminal snapshot are the durable record.
   */
  terminalCwd: string | null;
  /**
   * kind='git' only: the repository's MAIN root — the tab's identity (one git
   * tab per repository per window, deduped by `pathKey`). Null on every other
   * kind.
   */
  gitRoot: string | null;
  /**
   * kind='git' only: the checkout the panel shows — the main root or one of
   * its linked worktrees. Persisted with the root so a restart reopens the
   * same worktree; the workspace colour cue follows it (`workspaceCueFor`).
   */
  gitCheckout: string | null;
}

/** Everything needed to rebuild one tab at restore time (content already read). */
export interface RestoredTabInit {
  id: string;
  kind: TabKind;
  notePath: string | null;
  filePath: string | null;
  customTitle: string | null;
  mode: EditorMode;
  savedMtimeMs: number | null;
  /** kind='file': Live Edit override (default null = follow the workspace). */
  liveEdit?: boolean | null;
  text: string;
  /**
   * kind='file' restored from its session buffer (unsaved edits survived a
   * kill): the model's clean-by-construction snapshot would otherwise hide
   * this, so the caller (session.ts) says so explicitly. Default false.
   */
  dirty?: boolean;
  /** The file lies in a read-only workspace (see TabEntry.readOnly). Default false. */
  readOnly?: boolean;
  /** kind='terminal' only: the pane layout to respawn (from the manifest). */
  terminal?: TerminalSnapshot | null;
  /** kind='terminal' only: profile for a NEW session (ignored when `terminal` is set). */
  terminalProfileId?: string;
  /** kind='terminal' only: inherited working directory for a new session. */
  terminalCwd?: string | null;
  /** kind='terminal' only: a line typed into the new shell once it is ready (never persisted). */
  terminalInitialInput?: string | null;
  /** kind='git' only: the repository (main root) and the checkout last shown. */
  git?: { root: string; checkout?: string } | null;
}

/** What the session controller applies back after a flush completes. */
export interface FlushResultPatch {
  /** New note tabs → the path this flush assigned them. */
  assignedNotePaths: Record<string, string>;
  /** Successful renames as { [oldPath]: newPath }. */
  renamedPaths: Record<string, string>;
  /** Closed-note tombstones this flush handled (removed from the store). */
  consumedClosedNotePaths: string[];
  /** Obsolete-buffer tombstones this flush handled. */
  consumedObsoleteBufferTabIds: string[];
}

export interface TabsState {
  tabs: TabEntry[];
  activeTabId: string;
  /** The tab whose label is being edited inline, or null. */
  renamingTabId: string | null;
  /** Note files discarded since the last flush; the flusher deletes them. */
  closedNotePaths: string[];
  /** File tabs closed since the last flush; their session buffers are stale. */
  obsoleteBufferTabIds: string[];
  /**
   * The mode the user most recently switched to, seeded from
   * settings.defaultMode. Newly opened file tabs adopt it instead of always
   * reverting to the default — so reading in 'read' mode and flipping through
   * files keeps each new preview in Review mode. Session-only (not persisted).
   */
  lastFileMode: EditorMode;

  newTab: () => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  activateAdjacent: (direction: 1 | -1) => void;
  /**
   * Drag-reorder: the tab lands at `toIndex` (an index into the array WITHOUT
   * it, clamped). With `groupTabsByWorkspace` on, the strip is re-arranged
   * into contiguous per-workspace runs afterwards, so a drop that would split
   * a workspace's run snaps back into it.
   */
  reorderTab: (id: string, toIndex: number) => void;
  /** Commit an inline rename. Empty/whitespace reverts to auto-derived title. */
  renameTab: (id: string, title: string) => void;
  beginRename: (id: string) => void;
  cancelRename: () => void;
  setMode: (id: string, mode: EditorMode) => void;
  registerModeSync: (id: string, sync: ModeSync) => void;
  activeTab: () => TabEntry | undefined;
  /**
   * Remove a tab WITHOUT the close-tab tombstones — its note file and session
   * buffer stay on disk because another window is adopting them (tab tear-off,
   * M8). Behaves like closeTab otherwise: neighbor activation, and the last
   * tab leaves one fresh Untitled.
   */
  detachTab: (id: string) => void;
  /**
   * Append already-read tabs from another window (tear-off adoption / a
   * closing secondary window handing its tabs back). Ids are preserved so
   * session buffers and caret bookkeeping keyed by id line up; the last
   * adopted tab is activated.
   */
  adoptTabs: (tabs: RestoredTabInit[]) => void;
  /** Replace all tabs from a restored session (boot only). */
  restoreSession: (payload: { tabs: RestoredTabInit[]; activeTabId: string | null }) => void;
  /** Apply the outcome of a completed flush. Never re-requests a flush. */
  applyFlushResult: (patch: FlushResultPatch) => void;

  /**
   * M3 — Ctrl+O: append a new file tab from already-read disk content. Returns
   * its id. When `preview` is set, it opens as a preview tab (reusing/replacing
   * any current preview tab) instead of appending a persistent one.
   */
  openFileTab: (input: {
    filePath: string;
    text: string;
    savedMtimeMs: number;
    preview?: boolean;
    readOnly?: boolean;
  }) => string;
  /**
   * Tab sync: open a second tab (a "mirror") on the same file as file tab
   * `id`, right beside it — Markdown in one, Present/Review/Draw in the other.
   * It starts from the source's CURRENT text and on-disk baseline, so unsaved
   * edits carry over and it is dirty exactly when the source is; from then on
   * ui/doc-sync.ts keeps the two in step. Returns the new id, or null when the
   * tab is not a saved file.
   */
  duplicateFileTab: (id: string) => string | null;
  /** Image viewer tab — read-only, never flushed beyond the manifest. Returns its id. */
  /**
   * Open a terminal tab. The label is the profile's name until the shell sets
   * its own OSC title (see `setTerminalTitle`). Desktop only — callers gate
   * on `isAndroid()`.
   */
  openTerminalTab: (input: {
    profileId: string;
    /** Inherited working directory for the first pane. */
    cwd?: string | null;
    /** A restored layout (manifest), which wins over profileId/cwd. */
    snapshot?: TerminalSnapshot | null;
    /**
     * A command line typed into the shell once it is ready, Enter included —
     * how the Settings dialog runs an agent's install command in plain sight.
     * Never persisted: a restored terminal is a fresh shell.
     */
    initialInput?: string | null;
  }) => string;
  /**
   * Open the git tab for a repository, or activate the one already open for
   * it (one per repository per window, deduped by `pathKey(root)`). `root` is
   * the repository's MAIN root; `checkout` preselects a worktree. Returns the
   * tab's id. Desktop only — callers gate on `isAndroid()`.
   */
  openGitTab: (input: { root: string; checkout?: string | null }) => string;
  /** The git tab switched checkouts (main ⇄ a worktree); persisted with the tab. */
  setGitCheckout: (tabId: string, checkout: string) => void;
  /** Mirror the focused pane's shell title onto the tab label. */
  setTerminalTitle: (tabId: string, title: string | null) => void;
  /**
   * Mirror the focused pane's working directory onto the tab (see
   * `TabEntry.terminalCwd`). With `groupTabsByWorkspace` on, a terminal that
   * moved into another workspace is re-slotted into that workspace's run.
   */
  setTerminalCwd: (tabId: string, cwd: string | null) => void;
  openImageTab: (input: {
    filePath: string;
    savedMtimeMs: number | null;
    preview?: boolean;
    readOnly?: boolean;
  }) => string;
  /** Import card tab (PDF/DOCX) — read-only, never flushed beyond the manifest.
   *  Renders an inline "Import as Markdown" offer instead of an editor. */
  openImportTab: (input: {
    filePath: string;
    savedMtimeMs: number | null;
    preview?: boolean;
    readOnly?: boolean;
  }) => string;
  /** Promote a preview tab to a permanent one (idempotent; no-op otherwise). */
  promoteTab: (id: string) => void;
  /**
   * M3 — Save (existing file tab, same path): `savedText` was just written to
   * (or read back from) the tab's file at `mtimeMs`. Records THAT text as
   * persisted — pass the string actually written, not the model's text after
   * the await: edits made during a slow write must stay dirty. Clears the
   * dirty dot only when nothing was typed since, clears any conflict banner,
   * and marks any leftover session buffer stale (obsoleteBufferTabIds).
   */
  markSaved: (id: string, mtimeMs: number, savedText: string) => void;
  /**
   * M3 — Save As: `savedText` was written at a new `filePath`. Converts a note
   * tab to a file tab (queuing its old note file for deletion — "the note
   * graduated") or simply retargets an existing file tab to the new path.
   * Persisted state follows `savedText` exactly as in {@link markSaved}.
   */
  saveToPath: (id: string, input: { filePath: string; mtimeMs: number; savedText: string }) => void;
  /**
   * Rename-on-disk: a file tab's file was just renamed to `filePath` at
   * `mtimeMs`. Only retargets the path + mtime baseline — content and dirty
   * state are untouched (the rename moved the bytes, it didn't save them).
   */
  retargetFilePath: (id: string, input: { filePath: string; mtimeMs: number }) => void;
  /**
   * The explorer MOVED a note tab's file out of the notes dir (into another
   * workspace, or into a subfolder). A note's identity is "a file directly in
   * the notes dir whose name follows the tab title", so the tab has to
   * graduate to a plain file tab at `filePath` — otherwise the flusher would
   * rename the file back into the notes dir on the next title change, and
   * closing the tab would delete it.
   *
   * Like {@link saveToPath} minus the note-file tombstone: the file was MOVED,
   * not superseded, so queuing its old path for deletion would be wrong (and
   * could delete a brand-new note that later takes the freed name).
   */
  adoptMovedNoteAsFile: (id: string, input: { filePath: string; mtimeMs: number }) => void;
  /** M3 — external-change detection: show/hide the per-tab ConflictBanner. */
  setConflict: (id: string, conflict: boolean) => void;
  /**
   * M3 — "Keep mine": dismiss the conflict banner and adopt `mtimeMs` as the
   * new baseline so the next save proceeds instead of re-flagging a conflict.
   * Deliberately does NOT touch the model or the dirty flag.
   */
  acknowledgeConflict: (id: string, mtimeMs: number) => void;
  /**
   * Quietly advance a tab's on-disk baseline (and drop any conflict flag)
   * WITHOUT requesting a flush — for flush bookkeeping (recording a note
   * write's mtime) and for the conflict probe adopting a benign mtime move.
   * The manifest picks the new value up on the next natural flush.
   */
  adoptBaseline: (id: string, mtimeMs: number) => void;
  /** Live Edit: set (true/false) or clear (null) a file tab's per-tab override. */
  setLiveEdit: (id: string, liveEdit: boolean | null) => void;
  /**
   * Live Edit: a change from disk was just merged into the model. `diskText`
   * is what the file holds NOW — it becomes the 'file' baseline (so the tab
   * is dirty exactly when the merged text still differs from disk, and the
   * next live save writes it) — and `mtimeMs` its mtime. Clears any conflict.
   */
  adoptMergedText: (id: string, input: { diskText: string; mtimeMs: number }) => void;
}

/**
 * The name shown on a tab. It mirrors the file the tab maps to, minus the
 * extension (the user's rule: "tab name and .md file name should match"):
 *   - file tab  → its filename without extension, casing/spaces preserved
 *     ("Budget Q3.md" → "Budget Q3").
 *   - note tab  → the slug that is (or will be) its note filename
 *     ("My Report" → "my-report"), so the label matches the on-disk file
 *     without waiting for a flush. A brand-new empty note reads "Untitled".
 */
export function tabDisplayTitle(tab: {
  kind: TabKind;
  notePath: string | null;
  filePath: string | null;
  customTitle: string | null;
  title: string;
  charCount: number;
  terminalTitle?: string | null;
  gitRoot?: string | null;
}): string {
  if (tab.kind === 'terminal') {
    // A shell's own OSC title wins; a user rename beats even that. `title`
    // holds the profile name, set when the tab was opened.
    return tab.customTitle ?? tab.terminalTitle ?? tab.title;
  }
  if (tab.kind === 'git') {
    // Named after the repository's main folder, whichever worktree is shown.
    return tab.customTitle ?? `Git: ${baseName(tab.gitRoot ?? '') || tab.gitRoot || 'repository'}`;
  }
  if ((tab.kind === 'file' || tab.kind === 'image' || tab.kind === 'import') && tab.filePath) {
    return stripExtension(baseName(tab.filePath));
  }
  if (!tab.customTitle && tab.charCount === 0) {
    return 'Untitled';
  }
  return slugifyTitle(tab.title);
}

/** Word count = whitespace-delimited tokens; empty text is zero. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

export const tabsStore = createStore<TabsState>()((set, get) => {
  /**
   * Build a tab entry and wire its title/word-count subscription. With no
   * argument it is a fresh empty note; with `init` it restores one from the
   * manifest (id preserved so cursor bookkeeping keyed by id lines up). The
   * subscription closes over `id` (not the entry) so it survives the immutable
   * array replacements every action performs.
   */
  function makeTab(init?: RestoredTabInit): TabEntry {
    const id = init?.id ?? nanoid();
    const text = init?.text ?? '';
    const model = createDocModel(text);
    const customTitle = init?.customTitle ?? null;
    const entry: TabEntry = {
      id,
      kind: init?.kind ?? ('note' satisfies TabKind),
      notePath: init?.notePath ?? null,
      filePath: init?.filePath ?? null,
      customTitle,
      // A read-only tab is pinned to Review mode regardless of what the
      // manifest recorded (the flag itself is recomputed by the caller).
      // Otherwise the recorded mode is filtered through the document family, so
      // a whiteboard restored from an old manifest opens in Draw rather than
      // rendering its SVG source as markdown.
      mode: init?.readOnly
        ? 'read'
        : defaultModeFor(
            docFamilyForTab({
              kind: init?.kind ?? 'note',
              filePath: init?.filePath,
              notePath: init?.notePath,
              deck: isMarpDocument(text),
            }),
            init?.mode ?? settingsStore.getState().settings.defaultMode,
          ),
      savedMtimeMs: init?.savedMtimeMs ?? null,
      liveEdit: init?.liveEdit ?? null,
      model,
      modeSync: null,
      title: customTitle ?? deriveTitle(text),
      wordCount: countWords(text),
      charCount: text.length,
      deck: isMarpDocument(text),
      dirty: init?.dirty ?? false,
      conflict: false,
      preview: false,
      readOnly: init?.readOnly ?? false,
      terminalTitle: null,
      terminalCwd: null,
      gitRoot: init?.git?.root ?? null,
      gitCheckout: init?.git?.checkout ?? init?.git?.root ?? null,
    };

    // A git tab's label is the repository's folder; the title subscription
    // below never fires for it (its model stays empty), so it is set once.
    if (entry.kind === 'git') {
      entry.title = customTitle ?? tabDisplayTitle(entry);
    }

    // A terminal tab's "content" is its pane layout, so it is created here —
    // the one place every tab (new, restored, reordered) is built — rather
    // than in each caller. `openSession` is idempotent per tab id.
    if (entry.kind === 'terminal') {
      const settings = settingsStore.getState().settings;
      const profileId =
        init?.terminal?.panes[0]?.profileId ??
        init?.terminalProfileId ??
        settings.defaultTerminalProfile;
      terminalsStore.getState().openSession(id, {
        profileId,
        cwd: init?.terminalCwd ?? null,
        snapshot: init?.terminal ?? null,
        initialInput: init?.terminalInitialInput ?? null,
      });
      // The label until the shell sets its own OSC title.
      entry.title = customTitle ?? resolveTerminalProfile(settings, profileId).name;
      // The spawn directory is the best guess until the shell's first OSC 7 —
      // for a restored layout, the focused pane's recorded cwd.
      entry.terminalCwd = activePaneCwd(terminalsStore.getState(), id);
    }

    model.subscribe((change) => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) {
        return;
      }
      // Every text change must survive a crash — request a flush before the
      // title/word-count short-circuit (an intra-line edit changes neither).
      requestFlush();
      const title = tab.customTitle ?? deriveTitle(change.text);
      const wordCount = countWords(change.text);
      const charCount = change.text.length;
      const deck = isMarpDocument(change.text);
      // file tabs only: the TabBar dirty dot. Note tabs have no save concept.
      const dirty = tab.kind === 'file' && tab.model.isDirty('file');
      // A genuine user edit (from an editor, not a programmatic/file-load push)
      // promotes a preview tab to a permanent one — VSCode behavior.
      const preview =
        tab.preview &&
        (change.source === 'cm6' || change.source === 'milkdown' || change.source === 'deck-edit')
          ? false
          : tab.preview;
      if (
        title === tab.title &&
        wordCount === tab.wordCount &&
        charCount === tab.charCount &&
        deck === tab.deck &&
        dirty === tab.dirty &&
        preview === tab.preview
      ) {
        return;
      }
      // The frontmatter came or went: the family changed under an open tab.
      // A mode the new family lacks (Edit on a fresh deck) self-heals the same
      // way a stale manifest does; every other mode is shared and stays.
      const mode =
        deck === tab.deck ? tab.mode : defaultModeFor(docFamilyForTab({ ...tab, deck }), tab.mode);
      set({
        tabs: state.tabs.map((t) =>
          t.id === id ? { ...t, title, wordCount, charCount, deck, dirty, preview, mode } : t,
        ),
      });
      if (mode !== tab.mode) {
        void tab.modeSync?.setMode(mode);
      }
    });

    return entry;
  }

  /**
   * Insert a freshly built tab and activate it. A `preview` tab REPLACES the
   * current preview tab (if any) in place — reusing the single preview slot and
   * its position, VSCode-style — recording the displaced tab's tombstones the
   * same way `closeTab` does (a note's file is discarded, a file's buffer goes
   * stale). Any other open is a plain append.
   */
  function addTab(tab: TabEntry, preview: boolean): void {
    set((s) => {
      const idx = preview ? s.tabs.findIndex((t) => t.preview) : -1;
      if (idx < 0) {
        return { tabs: [...s.tabs, tab], activeTabId: tab.id };
      }
      const displaced = s.tabs[idx]!;
      const tabs = [...s.tabs];
      tabs[idx] = tab;
      return {
        tabs,
        activeTabId: tab.id,
        closedNotePaths:
          displaced.kind === 'note' && displaced.notePath
            ? [...s.closedNotePaths, displaced.notePath]
            : s.closedNotePaths,
        obsoleteBufferTabIds:
          displaced.kind === 'file'
            ? [...s.obsoleteBufferTabIds, displaced.id]
            : s.obsoleteBufferTabIds,
      };
    });
  }

  /**
   * The optional auto-arrange (settings.groupTabsByWorkspace): pull each
   * workspace's tabs into one contiguous run. Off — the default — the order
   * is whatever the user dragged it into and this is the identity function.
   */
  function arrangeByWorkspace(tabs: readonly TabEntry[]): TabEntry[] {
    const list = [...tabs];
    if (!settingsStore.getState().settings.groupTabsByWorkspace) {
      return list;
    }
    const order = orderTabsByWorkspace(
      list.map((t) => ({ id: t.id, workspaceKey: workspaceCueFor(t)?.key ?? null })),
    );
    const byId = new Map(list.map((t) => [t.id, t]));
    return order.map((o) => byId.get(o.id)!);
  }

  // The one place the terminals store writes back into this one: every
  // terminal tab mirrors its FOCUSED pane's cwd (`TabEntry.terminalCwd`),
  // whether it changed because the shell `cd`d (OSC 7), because focus moved
  // to another pane, or because a pane closed. Title changes — the frequent
  // ones — fall through untouched, which is what keeps the two stores apart.
  terminalsStore.subscribe((terminals) => {
    for (const tab of get().tabs) {
      if (tab.kind !== 'terminal' || !terminals.sessions[tab.id]) {
        continue;
      }
      const cwd = activePaneCwd(terminals, tab.id);
      if (cwd !== tab.terminalCwd) {
        get().setTerminalCwd(tab.id, cwd);
      }
    }
  });

  const first = makeTab();

  return {
    tabs: [first],
    activeTabId: first.id,
    renamingTabId: null,
    closedNotePaths: [],
    obsoleteBufferTabIds: [],
    // Mobile reads first: opened files default to 'read' rather than the
    // (edit-oriented) settings.defaultMode. Switching modes still updates this
    // via setMode, so flipping through files preserves the user's choice.
    lastFileMode: isMobile() ? 'read' : settingsStore.getState().settings.defaultMode,

    newTab() {
      const tab = makeTab();
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      requestFlush();
    },

    closeTab(id) {
      const s = get();
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) {
        return;
      }
      const closing = s.tabs[idx]!;
      // Deliberate Notepad semantics: closing a note
      // tab DISCARDS its file; closing a file tab makes its session buffer
      // stale. Both are recorded here and swept by the next flush.
      const closedNotePaths =
        closing.kind === 'note' && closing.notePath
          ? [...s.closedNotePaths, closing.notePath]
          : s.closedNotePaths;
      const obsoleteBufferTabIds =
        closing.kind === 'file' ? [...s.obsoleteBufferTabIds, closing.id] : s.obsoleteBufferTabIds;
      // A terminal tab's ptys die with it: the panes unmount and kill their
      // children, and this drops the layout so nothing outlives the tab.
      if (closing.kind === 'terminal') {
        terminalsStore.getState().closeSession(id);
      }
      liveEditStore.getState().forget(id);

      const remaining = s.tabs.filter((t) => t.id !== id);
      // Notepad behavior: closing the last tab leaves one fresh Untitled.
      if (remaining.length === 0) {
        const fresh = makeTab();
        set({
          tabs: [fresh],
          activeTabId: fresh.id,
          renamingTabId: null,
          closedNotePaths,
          obsoleteBufferTabIds,
        });
        requestFlush();
        return;
      }
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        // Prefer the right neighbor, else the left (browser-tab behavior).
        // After removal the old right neighbor sits at `idx` in `remaining`;
        // clamp so closing the last tab falls back to the left neighbor.
        activeTabId = remaining[Math.min(idx, remaining.length - 1)]!.id;
      }
      set({
        tabs: remaining,
        activeTabId,
        renamingTabId: s.renamingTabId === id ? null : s.renamingTabId,
        closedNotePaths,
        obsoleteBufferTabIds,
      });
      requestFlush();
    },

    detachTab(id) {
      const s = get();
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) {
        return;
      }
      // No closedNotePaths / obsoleteBufferTabIds entries: the tab's files are
      // being handed to another window, not discarded. A terminal tab lets go
      // of its panes the same way — released, not closed, so the shells keep
      // running and the receiving window attaches to the very same ptys
      // instead of starting fresh ones.
      if (s.tabs[idx]!.kind === 'terminal') {
        terminalsStore.getState().releaseSession(id);
      }
      liveEditStore.getState().forget(id);
      const remaining = s.tabs.filter((t) => t.id !== id);
      if (remaining.length === 0) {
        const fresh = makeTab();
        set({ tabs: [fresh], activeTabId: fresh.id, renamingTabId: null });
        requestFlush();
        return;
      }
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        activeTabId = remaining[Math.min(idx, remaining.length - 1)]!.id;
      }
      set({
        tabs: remaining,
        activeTabId,
        renamingTabId: s.renamingTabId === id ? null : s.renamingTabId,
      });
      requestFlush();
    },

    adoptTabs(inits) {
      if (inits.length === 0) {
        return;
      }
      const entries = inits.map((t) => makeTab(t));
      set((s) => {
        // A pristine window (exactly one never-flushed empty Untitled) yields
        // its placeholder to the adopted tabs instead of keeping a stray note.
        const only = s.tabs.length === 1 ? s.tabs[0]! : null;
        const pristine =
          only !== null &&
          only.kind === 'note' &&
          only.notePath === null &&
          only.charCount === 0 &&
          !only.customTitle;
        return {
          tabs: [...(pristine ? [] : s.tabs), ...entries],
          activeTabId: entries[entries.length - 1]!.id,
        };
      });
      requestFlush();
    },

    activateTab(id) {
      const s = get();
      if (s.activeTabId === id || !s.tabs.some((t) => t.id === id)) {
        return;
      }
      set({ activeTabId: id });
      requestFlush();
    },

    activateAdjacent(direction) {
      const s = get();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx < 0 || s.tabs.length < 2) {
        return;
      }
      const next = s.tabs[(idx + direction + s.tabs.length) % s.tabs.length]!;
      set({ activeTabId: next.id });
      requestFlush();
    },

    reorderTab(id, toIndex) {
      const s = get();
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from < 0) {
        return;
      }
      const rest = s.tabs.filter((t) => t.id !== id);
      const clamped = Math.max(0, Math.min(toIndex, rest.length));
      rest.splice(clamped, 0, s.tabs[from]!);
      // With workspace arranging on, a drop that lands mid-way through another
      // workspace's run is pulled back into its own — the same "runs stay
      // contiguous" contract the old tab groups had, just derived.
      set({ tabs: arrangeByWorkspace(rest) });
      requestFlush();
    },

    renameTab(id, rawTitle) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) {
        return;
      }
      const trimmed = rawTitle.trim();
      const customTitle = trimmed.length > 0 ? trimmed : null;
      const title = customTitle ?? deriveTitle(tab.model.getText());
      set({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, customTitle, title } : t)),
        renamingTabId: s.renamingTabId === id ? null : s.renamingTabId,
      });
      requestFlush();
    },

    beginRename(id) {
      if (get().tabs.some((t) => t.id === id)) {
        set({ renamingTabId: id });
      }
    },

    cancelRename() {
      set({ renamingTabId: null });
    },

    setMode(id, mode) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      // Read-only tabs are pinned to Review mode (the status bar shows a
      // "Read-only" badge instead of the mode segments).
      if (!tab || tab.mode === mode || tab.readOnly) {
        return;
      }
      // A mode the document family doesn't have (Edit on an .svg, Draw on a
      // note) can only arrive from a stale keybinding or an old manifest.
      if (!isModeAllowed(docFamilyForTab(tab), mode)) {
        return;
      }
      // Where the reader is, measured while the OUTGOING mode is still on
      // screen: the incoming surface puts that source line back on top
      // (ui/mode-scroll, core/mode-scroll).
      captureScrollAnchor(id, tab.mode);
      // Remember this choice so the next file opened adopts it (see
      // lastFileMode) — but only for markdown modes: 'draw' means "this file is
      // a whiteboard", not "open the next note differently".
      set({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, mode } : t)),
        lastFileMode: mode === 'draw' ? s.lastFileMode : mode,
      });
      void tab.modeSync?.setMode(mode);
      requestFlush();
    },

    registerModeSync(id, sync) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, modeSync: sync } : t)),
      }));
    },

    activeTab() {
      const s = get();
      return s.tabs.find((t) => t.id === s.activeTabId);
    },

    restoreSession({ tabs, activeTabId }) {
      // The whole tab set is replaced, so every terminal layout the old set
      // owned goes with it (their panes unmount and kill their ptys).
      for (const old of get().tabs) {
        if (old.kind === 'terminal') {
          terminalsStore.getState().closeSession(old.id);
        }
      }
      const made = tabs.length > 0 ? tabs.map((t) => makeTab(t)) : [makeTab()];
      // Restore respects the recorded order, then applies the workspace
      // arrangement if the setting is on (a manifest written with it off, or
      // by an older build, still comes back arranged).
      const entries = arrangeByWorkspace(made);
      const active =
        activeTabId && entries.some((e) => e.id === activeTabId) ? activeTabId : entries[0]!.id;
      // Continue flipping in whatever mode the restored active tab was in, so a
      // Review-mode session stays Review-mode across a restart. Read-only tabs are
      // pinned to 'read' regardless, so fall back to the default for those.
      // Mobile reads first: every session starts back at 'read' no matter what
      // mode the restored tabs were left in — a phone is primarily a reader,
      // and one editing session shouldn't flip the device's default for good.
      const activeEntry = entries.find((e) => e.id === active)!;
      set({
        tabs: entries,
        activeTabId: active,
        renamingTabId: null,
        closedNotePaths: [],
        obsoleteBufferTabIds: [],
        // 'draw' is a property of the FILE, not a preference — never let a
        // restored whiteboard become the default mode for the next note.
        lastFileMode: isMobile()
          ? 'read'
          : activeEntry.readOnly || activeEntry.mode === 'draw'
            ? settingsStore.getState().settings.defaultMode
            : activeEntry.mode,
      });
    },

    applyFlushResult(patch) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          const assigned = patch.assignedNotePaths[t.id];
          const renamed = t.notePath !== null ? patch.renamedPaths[t.notePath] : undefined;
          const notePath = assigned ?? renamed;
          return notePath && notePath !== t.notePath ? { ...t, notePath } : t;
        }),
        closedNotePaths: s.closedNotePaths.filter(
          (p) => !patch.consumedClosedNotePaths.includes(p),
        ),
        obsoleteBufferTabIds: s.obsoleteBufferTabIds.filter(
          (id) => !patch.consumedObsoleteBufferTabIds.includes(id),
        ),
      }));
    },

    openFileTab({ filePath, text, savedMtimeMs, preview = false, readOnly = false }) {
      // Content already came straight from disk (session.ts's openPaths) — the
      // model's clean-by-construction snapshot is exactly right here.
      const tab: TabEntry = {
        ...makeTab({
          id: nanoid(),
          kind: 'file',
          notePath: null,
          filePath,
          customTitle: null,
          // Adopt the last mode the user switched to, not the static default,
          // so flipping through files preserves e.g. Review mode. A whiteboard
          // ignores that preference entirely: `lastFileMode` is a MARKDOWN
          // preference, and 'raw' happens to be legal for svg too — inheriting
          // it would open a fresh board as XML source (bit UAT in phase 5, via
          // Import › Whiteboard scan…, which then found no draw adapter).
          // Raw for a board is an explicit per-tab switch, never a default.
          mode:
            docFamilyFor(filePath) === 'svg'
              ? 'draw'
              : defaultModeFor(docFamilyFor(filePath), get().lastFileMode),
          savedMtimeMs,
          text,
          readOnly,
        }),
        preview,
      };
      addTab(tab, preview);
      requestFlush();
      return tab.id;
    },

    duplicateFileTab(id) {
      const source = get().tabs.find((t) => t.id === id);
      if (!source || source.kind !== 'file' || source.filePath === null) {
        return null;
      }
      const tab = makeTab({
        id: nanoid(),
        kind: 'file',
        notePath: null,
        filePath: source.filePath,
        customTitle: null,
        mode: source.mode,
        savedMtimeMs: source.savedMtimeMs,
        liveEdit: source.liveEdit,
        text: source.model.getText(),
        dirty: source.dirty,
        readOnly: source.readOnly,
      });
      tab.model.markPersistedAs('file', source.model.getPersisted('file'));
      set((s) => {
        const at = s.tabs.findIndex((t) => t.id === id);
        const tabs = [...s.tabs];
        tabs.splice(at + 1, 0, tab);
        return { tabs, activeTabId: tab.id };
      });
      requestFlush();
      return tab.id;
    },

    openTerminalTab({ profileId, cwd = null, snapshot = null, initialInput = null }) {
      const tab = makeTab({
        id: nanoid(),
        kind: 'terminal',
        notePath: null,
        filePath: null,
        customTitle: null,
        mode: 'term',
        savedMtimeMs: null,
        text: '',
        terminalProfileId: profileId,
        terminalCwd: cwd,
        terminal: snapshot,
        terminalInitialInput: initialInput,
      });
      addTab(tab, false);
      requestFlush();
      return tab.id;
    },

    openGitTab({ root, checkout = null }) {
      const key = pathKey(root);
      const existing = get().tabs.find((t) => t.kind === 'git' && pathKey(t.gitRoot ?? '') === key);
      if (existing) {
        // One tab per repository: a second open activates it (and switches
        // it to the requested checkout when the caller named one).
        if (checkout && pathKey(existing.gitCheckout ?? '') !== pathKey(checkout)) {
          get().setGitCheckout(existing.id, checkout);
        }
        get().activateTab(existing.id);
        return existing.id;
      }
      const tab = makeTab({
        id: nanoid(),
        kind: 'git',
        notePath: null,
        filePath: null,
        customTitle: null,
        mode: 'tool',
        savedMtimeMs: null,
        text: '',
        git: { root, ...(checkout ? { checkout } : {}) },
      });
      addTab(tab, false);
      requestFlush();
      return tab.id;
    },

    setGitCheckout(tabId, checkout) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'git' || tab.gitCheckout === checkout) {
        return;
      }
      // Re-arranged like a terminal's cwd change: the colour cue follows the
      // checkout, so with grouping on the tab belongs in that workspace's run.
      set({
        tabs: arrangeByWorkspace(
          s.tabs.map((t) => (t.id === tabId ? { ...t, gitCheckout: checkout } : t)),
        ),
      });
      requestFlush();
    },

    setTerminalTitle(tabId, title) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.terminalTitle === title) {
        return;
      }
      set({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, terminalTitle: title } : t)),
      });
    },

    setTerminalCwd(tabId, cwd) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'terminal' || tab.terminalCwd === cwd) {
        return;
      }
      // Re-arranged rather than just recolored: with grouping on, a terminal
      // standing in another workspace belongs in that workspace's run, or the
      // strip's bands and its colors would disagree.
      set({
        tabs: arrangeByWorkspace(
          s.tabs.map((t) => (t.id === tabId ? { ...t, terminalCwd: cwd } : t)),
        ),
      });
    },

    openImageTab({ filePath, savedMtimeMs, preview = false, readOnly = false }) {
      const tab: TabEntry = {
        ...makeTab({
          id: nanoid(),
          kind: 'image',
          notePath: null,
          filePath,
          customTitle: null,
          // Semantically closest mode (read-only viewer); no editor is created.
          mode: 'read',
          savedMtimeMs,
          text: '',
          readOnly,
        }),
        preview,
      };
      addTab(tab, preview);
      requestFlush();
      return tab.id;
    },

    openImportTab({ filePath, savedMtimeMs, preview = false, readOnly = false }) {
      const tab: TabEntry = {
        ...makeTab({
          id: nanoid(),
          kind: 'import',
          notePath: null,
          filePath,
          customTitle: null,
          // Read-only card, no editor is created; 'read' is the closest mode.
          mode: 'read',
          savedMtimeMs,
          text: '',
          readOnly,
        }),
        preview,
      };
      addTab(tab, preview);
      requestFlush();
      return tab.id;
    },

    promoteTab(id) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || !tab.preview) {
        return;
      }
      set({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) });
    },

    markSaved(id, mtimeMs, savedText) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) {
        return;
      }
      // The write (or reload-read) made file and session content agree on
      // `savedText` — NOT necessarily the model's text now: keystrokes typed
      // while a slow write was in flight are not on disk and stay dirty.
      tab.model.markPersistedAs('file', savedText);
      tab.model.markPersistedAs('session', savedText);
      const dirty = tab.kind === 'file' && tab.model.isDirty('file');
      set({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, savedMtimeMs: mtimeMs, dirty, conflict: false } : t,
        ),
        // Any session buffer from prior unsaved edits is now stale; delete_path
        // is idempotent so this is harmless when no buffer ever existed.
        obsoleteBufferTabIds: s.obsoleteBufferTabIds.includes(id)
          ? s.obsoleteBufferTabIds
          : [...s.obsoleteBufferTabIds, id],
      });
      requestFlush();
    },

    saveToPath(id, { filePath, mtimeMs, savedText }) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      // Only document tabs may become file tabs — rewriting a terminal (or
      // image) tab to kind:'file' would unmount its pane and kill the shell.
      if (!tab || (tab.kind !== 'note' && tab.kind !== 'file' && tab.kind !== 'import')) {
        return;
      }
      // Save-As on a note tab converts it to a file tab; the note file is
      // queued for deletion the same way a closed note tab's file is (the
      // note graduated — one source of truth per document). planFlush skips
      // the delete when `filePath` IS that note file (Save As onto its own
      // name in the notes dir).
      const closedNotePaths =
        tab.kind === 'note' && tab.notePath
          ? [...s.closedNotePaths, tab.notePath]
          : s.closedNotePaths;
      // Persisted = what was written; text typed during the write stays dirty.
      tab.model.markPersistedAs('file', savedText);
      tab.model.markPersistedAs('session', savedText);
      const dirty = tab.model.isDirty('file');
      set({
        tabs: s.tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                kind: 'file',
                notePath: null,
                filePath,
                savedMtimeMs: mtimeMs,
                dirty,
                conflict: false,
              }
            : t,
        ),
        closedNotePaths,
        obsoleteBufferTabIds: s.obsoleteBufferTabIds.includes(id)
          ? s.obsoleteBufferTabIds
          : [...s.obsoleteBufferTabIds, id],
      });
      requestFlush();
    },

    adoptMovedNoteAsFile(id, { filePath, mtimeMs }) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== 'note') {
        return;
      }
      // The caller drained the flusher before moving, so the bytes at
      // `filePath` are the note's session snapshot — what that flush wrote.
      // Anything typed since stays dirty (and gets a buffer next flush). No
      // closedNotePaths entry — see the action's doc.
      tab.model.markPersistedAs('file', tab.model.getPersisted('session'));
      const dirty = tab.model.isDirty('file');
      set({
        tabs: s.tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                kind: 'file',
                notePath: null,
                filePath,
                savedMtimeMs: mtimeMs,
                dirty,
                conflict: false,
              }
            : t,
        ),
      });
      requestFlush();
    },

    retargetFilePath(id, { filePath, mtimeMs }) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || (tab.kind !== 'file' && tab.kind !== 'image' && tab.kind !== 'import')) {
        return;
      }
      // Mirrors (tab sync — other tabs on the same file) follow the file too,
      // or their next save would recreate it under the old name.
      const oldKey = tab.filePath === null ? null : pathKey(tab.filePath);
      const follows = (t: TabEntry): boolean =>
        t.id === id ||
        (oldKey !== null &&
          t.kind === tab.kind &&
          t.filePath !== null &&
          pathKey(t.filePath) === oldKey);
      set({
        tabs: s.tabs.map((t) => (follows(t) ? { ...t, filePath, savedMtimeMs: mtimeMs } : t)),
      });
      requestFlush();
    },

    setConflict(id, conflict) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.conflict === conflict) {
        return;
      }
      set({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, conflict } : t)) });
    },

    adoptBaseline(id, mtimeMs) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || (tab.savedMtimeMs === mtimeMs && !tab.conflict)) {
        return;
      }
      set({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, savedMtimeMs: mtimeMs, conflict: false } : t,
        ),
      });
    },

    setLiveEdit(id, liveEdit) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== 'file' || tab.liveEdit === liveEdit) {
        return;
      }
      set({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, liveEdit } : t)) });
      requestFlush();
    },

    adoptMergedText(id, { diskText, mtimeMs }) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== 'file') {
        return;
      }
      tab.model.markPersistedAs('file', diskText);
      const dirty = tab.model.isDirty('file');
      set({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, savedMtimeMs: mtimeMs, dirty, conflict: false } : t,
        ),
      });
      requestFlush();
    },

    acknowledgeConflict(id, mtimeMs) {
      const s = get();
      if (!s.tabs.some((t) => t.id === id)) {
        return;
      }
      // Deliberately does not touch the model or the dirty flag: "keep mine"
      // means the local edits stay unsaved until the user explicitly saves.
      set({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, savedMtimeMs: mtimeMs, conflict: false } : t,
        ),
      });
      requestFlush();
    },
  };
});

export const useTabsStore = <T>(selector: (s: TabsState) => T): T => useStore(tabsStore, selector);
