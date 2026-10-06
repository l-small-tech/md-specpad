/**
 * Shared types for the session controller's section factories: the injected
 * dependency surface (`SessionControllerDeps`), the controller's public shape
 * (`SessionController`), and `SessionCtx` — the closure state the former
 * single-file `createSessionController` shared between its sections, now
 * carried explicitly so each `src/ui/session/*` factory can read (and, for
 * `notesDir`/`existingNoteFiles`, write) the same live values.
 */

import type { DebouncedFlusher } from '../../core/session/debounce';
import type { FlushIo, PersistedTab, SessionManifest } from '../../core/session/plan-flush';
import type { Ipc } from '../../ipc/commands';
import type { SessionPaths } from '../../ipc/paths';
import type { TabEntry } from '../stores/tabs';
import type {
  ConfirmDialog,
  ConfirmRememberDialog,
  OpenFilesDialog,
  PickDirectoryDialog,
  PickFileDialog,
  SaveDiscardCancelDialog,
  SaveFileDialog,
  TabWindowInfo,
} from './facade';

/** The slice of `ipc` the controller uses — narrowed so tests fake less. */
export type SessionIpc = Pick<
  Ipc,
  | 'atomicWriteText'
  | 'renamePath'
  | 'deletePath'
  | 'listNotes'
  | 'readTextFile'
  | 'statPath'
  | 'listDir'
  | 'readFileBase64'
  | 'writeFileBase64'
  | 'copyPath'
  | 'createDir'
> & {
  // Not a raw `Ipc` command: `refresh` lives on the StorageProvider (only the
  // synced backend implements it), so it's added here rather than Pick'd.
  // Optional — tests fake the provider without it.
  refresh?: (dir: string) => Promise<void>;
};

export interface SessionControllerDeps {
  paths: SessionPaths;
  /** The bundled documentation folder (a Tauri resource), or null if unresolvable. */
  docsDir?: string | null;
  /**
   * Multi-window (M8): each window owns its own manifest file inside the one
   * sessionDir — 'session.json' (the default) for the main window,
   * 'session-<label>.json' for torn-off tab windows. Buffers stay shared
   * (they're keyed by tab id, which is globally unique).
   */
  manifestName?: string;
  /**
   * A manifest handed over by the window that spawned this one (tab tear-off).
   * When set, restore() builds the tab set from it instead of reading the
   * manifest file, then persists it as this window's own manifest.
   */
  initialManifest?: SessionManifest | null;
  /**
   * False in torn-off windows. Secondaries never self-heal by reopening recent
   * notes (that would duplicate the main window's tabs) and refuse the
   * notes-dir change flow (the other windows' flushers can't be repointed).
   */
  isMain?: boolean;
  /**
   * Opens a new OS window that adopts `manifest` (one torn-off tab), at `pos`
   * (screen CSS px) or OS-placed when null, and resolves with the new
   * window's label. `focus: false` spawns it unfocused (a live tear-off keeps
   * the pointer — and therefore focus — with the dragging window until
   * release). Injected by main.tsx (Tauri WebviewWindow) so this module stays
   * Tauri-import-free.
   */
  spawnTabWindow?: (
    manifest: SessionManifest,
    pos: { x: number; y: number } | null,
    opts?: { focus?: boolean },
  ) => Promise<string>;
  /**
   * The label of the app window currently under the cursor (never this one,
   * never `excludeLabel` — a live tear-off passes the window riding the
   * cursor, which would otherwise always win the hit-test), or null. Injected
   * by main.tsx (Tauri global cursor + window geometry); resolves null on
   * platforms without trustworthy global coordinates (Wayland), which turns
   * every outside release into a plain tear-off.
   */
  findDropWindow?: (excludeLabel?: string) => Promise<string | null>;
  /**
   * Tell the live-torn-off window `label` (the one that just rode the cursor)
   * to hand its tab to window `target` and close — the drag released over
   * `target`. Fire-and-forget with retries inside: the torn-off window may
   * still be booting. Injected by main.tsx.
   */
  commandTornWindowDrop?: (label: string, target: string) => void;
  /** Focus the window labelled `label` (best-effort). Injected by main.tsx. */
  focusWindow?: (label: string) => void;
  /**
   * Deliver tab descriptors to the window labelled `label` over the
   * adopt-tabs / adopt-ack event pair (the same one a closing window uses).
   * Resolves true once the receiver acknowledged — it has adopted the tabs
   * AND flushed, so its manifest claims them. False on timeout: the caller
   * still owns the tabs and must keep (re-adopt) them.
   */
  sendTabsToWindow?: (label: string, tabs: PersistedTab[]) => Promise<boolean>;
  /**
   * The OTHER app windows (label + display title), most recently focused
   * first, for the context menu's explicit "Move to window …" rows — the
   * coordinate-free route that also works on Wayland. Injected by main.tsx.
   */
  listOtherWindows?: () => Promise<TabWindowInfo[]>;
  ipc?: SessionIpc;
  confirm?: ConfirmDialog;
  confirmRemember?: ConfirmRememberDialog;
  openDialog?: OpenFilesDialog;
  saveDialog?: SaveFileDialog;
  saveDiscardCancel?: SaveDiscardCancelDialog;
  pickDirectory?: PickDirectoryDialog;
  pickFile?: PickFileDialog;
  /** Injectable clock so `.bad-<timestamp>` naming is deterministic in tests. */
  now?: () => number;
  onError?: (error: unknown) => void;
  /** Boot restore progress: the file names whose reads are still outstanding
   *  (empty once all are done). The boot splash shows them. */
  onRestoreProgress?: (waitingOn: string[]) => void;
}

export interface SessionController {
  /** Read the manifest and rebuild the tab set (or self-heal). Boot only. */
  restore(): Promise<void>;
  /** Debounced flush request; cheap, call on every change. */
  request(): void;
  /** Drain: resolves once everything requested so far has been flushed. */
  flushNow(): Promise<void>;
  /** Cancel timers and wait out any in-flight flush (does not flush pending). */
  dispose(): Promise<void>;
  /** Close a tab, confirming first when that would discard user content. */
  closeTabInteractive(id: string): Promise<void>;
  /** Close every tab, confirming per-tab where that discards content. */
  closeAllTabsInteractive(): Promise<void>;
  /** Ctrl+O: native open dialog, then {@link openPaths}. */
  openFileDialog(): Promise<void>;
  /**
   * Android: copy external files (content:// URIs from the picker or incoming
   * "Open with"/"Share" intents) into the notes dir and open the local copies.
   */
  openIncoming(uris: string[]): Promise<void>;
  /**
   * Open each path as a file tab; focuses the existing tab if already open.
   * `preview` opens a reusable italic preview tab (explorer single-click).
   */
  openPaths(paths: string[], opts?: { preview?: boolean }): Promise<void>;
  /** Ctrl+S: save the active tab (Save As if it's a note tab). */
  saveActive(): Promise<void>;
  /** Ctrl+Shift+S: native save dialog, then write + retarget the active tab. */
  saveAsActive(): Promise<void>;
  /** Probe one file/note tab against disk (mtime, then content); sets/clears
   *  its ConflictBanner. See src/ui/session/conflict-probe.ts. */
  checkConflict(tabId: string): Promise<void>;
  /** {@link checkConflict} for every open file and note tab (window focus,
   *  restore, fs-changed watcher). */
  checkAllFileConflicts(): Promise<void>;
  /** ConflictBanner "Reload": replace the model with the on-disk content. */
  reloadFromDisk(tabId: string): Promise<void>;
  /** ConflictBanner "Keep mine": dismiss the banner, next save overwrites. */
  keepMine(tabId: string): Promise<void>;
  /** ConflictBanner "View diff": open the inline disk ↔ editor DiffView. */
  viewDiff(tabId: string): Promise<void>;
  /** M6 settings: pick a new notes folder, optionally moving existing notes. */
  changeNotesDir(): Promise<void>;
  /** M8: flush, detach the tab, and hand it to a freshly spawned window.
   *  Resolves with the new window's label, or null when nothing spawned. */
  moveTabToNewWindow(id: string, pos: { x: number; y: number } | null): Promise<string | null>;
  /**
   * M8.6: a LIVE tear-off's drag released — the torn-off window `label` is
   * riding the cursor. Lands its tab in the window under the cursor when
   * there is one (via {@link SessionControllerDeps.commandTornWindowDrop}),
   * else just focuses the dropped window where it is.
   */
  dropTornWindow(label: string): Promise<void>;
  /**
   * M8: a drag released outside this window — move the tab into the window
   * under the cursor when there is one (it adopts the tab), else tear it off
   * into a new window at `pos`.
   */
  dropTabOut(id: string, pos: { x: number; y: number } | null): Promise<void>;
  /** M8: move a tab into the EXISTING window `label` (context-menu route). */
  moveTabToWindow(id: string, label: string): Promise<void>;
  /** M8: adopt tabs handed over by another window (skips already-owned files). */
  adoptTabs(persisted: PersistedTab[]): Promise<void>;
  /** M8: flush, then describe every meaningful tab for a window-close handoff. */
  exportTabsForHandoff(): Promise<PersistedTab[]>;
  /** M8: delete this window's manifest file (after a successful handoff). */
  discardManifest(): Promise<void>;
  /** M8: last window standing — fold `tabs` into main's manifest, drop ours. */
  bequeathTabsToMain(tabs: PersistedTab[]): Promise<void>;
}

/**
 * The state one `createSessionController` call shares across its section
 * factories — formerly the factory's closure variables. Built (and the
 * late-wired members assigned) by `createSessionController` in `index.ts`.
 */
export interface SessionCtx {
  deps: SessionControllerDeps;
  ipc: SessionIpc;
  confirm: ConfirmDialog;
  confirmRemember: ConfirmRememberDialog;
  openDialog: OpenFilesDialog;
  saveDialog: SaveFileDialog;
  saveDiscardCancel: SaveDiscardCancelDialog;
  pickDirectory: PickDirectoryDialog;
  pickFile: PickFileDialog;
  now: () => number;
  // Mutable: the M6 notes-dir change flow repoints it live; every flush reads
  // the current value through this ctx ("next flush writes
  // there"). sessionDir is fixed (never user-configurable).
  notesDir: string;
  sessionDir: string;
  isMain: boolean;
  manifestPath: string;
  io: FlushIo;
  /** Basenames on disk in notesDir; refreshed at restore and after each flush. */
  existingNoteFiles: string[];
  /** Lowercased paths currently being opened — dedupes concurrent open requests
   *  (e.g. a double-click in the file explorer) so no two tabs race onto one file. */
  openingPaths: Set<string>;
  /** Lowercased paths a pinned open requested while a preview open was still in
   *  flight — the creator promotes the tab once it exists (explorer dbl-click). */
  pinOnOpen: Set<string>;
  /** `from` path → consecutive rename-failure count (3-strikes suppression). */
  renameFailures: Map<string, number>;
  /**
   * The flush currently writing, or null. The conflict probe awaits it so a
   * check triggered mid-flush (fs-changed fires for our own note writes)
   * never misreads our own write — the write's baseline is recorded before
   * this resolves. Set/cleared by flushSession only.
   */
  flushInFlight: Promise<void> | null;
  refreshNoteListing(): Promise<void>;
  /** First free `base.ext`, `base-2.ext`, … inside `dir` (case handled by FS). */
  uniquePathIn(dir: string, base: string, ext: string): Promise<string>;
  /** Shared refusal for writes aimed at a read-only workspace (the docs). */
  refuseReadOnly(path: string): boolean;
  /** The workspace root containing `path` (longest matching root), or its own
   *  directory when it lies outside every known workspace. */
  workspaceRootFor(path: string): string;
  /** Finds an open tab (file OR note) that already owns the path (by key). */
  tabOwning(key: string): TabEntry | undefined;
  /** The debounced flusher — created by the flush-restore factory, assigned
   *  back onto the ctx before any other factory runs. */
  flusher: DebouncedFlusher;
  /** Late-wired (open-save factory): restore() re-checks file conflicts. */
  checkAllFileConflicts(): Promise<void>;
  /** Late-wired (import-images factory): copyInExternal converts documents. */
  importDocumentBytes(
    dir: string,
    bytes: string,
    name: string,
    options?: { allowDuplicate?: boolean },
  ): Promise<void>;
}
