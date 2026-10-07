/**
 * FileExplorer — a left-side drawer listing markdown files and images grouped
 * by workspace. A workspace is just a folder: the notes dir is the built-in
 * default; extra folders are added via the native picker and persisted in
 * settings. Subfolders expand in place (listed lazily, one level per
 * `list_dir` call). Each workspace can carry an accent color (a named token
 * from WORKSPACE_COLORS, rendered as a stripe down its section; new
 * workspaces auto-pick an unused color). Right-clicking a workspace header
 * opens its context menu ("Set active" + new file/folder + color swatches,
 * plus "Remove workspace" for added workspaces); folder rows add "Rename",
 * file rows get a "Rename"-only menu (inline input in the row; extension
 * preserved). Workspace roots aren't renamable — their path anchors the
 * settings entry. Removing a workspace only forgets it — files are never
 * touched.
 *
 * Cut/copy/paste (the drawer's own clipboard, `ui/stores/explorer.ts`): a
 * file or folder row's context menu offers Cut/Copy, any writable folder or
 * workspace header offers Paste, and Ctrl+X/C/V do the same to the row last
 * clicked (`is-row-selected`; a cut row dims until the paste). A cut moves and
 * empties the clipboard; a copy duplicates under a free "… copy" name and
 * keeps it, so it can be pasted into several folders. It is an IN-APP
 * clipboard — the OS one can't carry a file list from a webview.
 *
 * Getting files IN:
 * - Paste (Ctrl+V with focus in the drawer, and nothing on the drawer's own
 *   clipboard): clipboard images/files are
 *   written into the SELECTED workspace/folder (click a folder row to select;
 *   workspace headers require an explicit action — right-click → "Set
 *   active" — since a plain click only collapses/expands, and adding a
 *   workspace makes it active. The default workspace is selected initially;
 *   the active workspace wears a small check on its header). The selection
 *   lives in `uiStore.selectedExplorerDir`, which is also the directory a new
 *   terminal tab starts in (see `terminal-open.ts`).
 * - OS drag-drop: main.tsx hit-tests Tauri's drag-drop events against the
 *   `data-drop-dir` attributes rendered here and copies the dropped md/image
 *   files into the hovered dir (`uiStore.dropTargetDir` drives the highlight).
 *   Dropping image(s) onto an md file row (`data-drop-file`) instead embeds
 *   them into that file (`appendImagesToMd`, which confirms first).
 *
 * Moving files: drag a file/image row onto ANY writable folder row or
 * workspace header — its own workspace or another one — to MOVE it there via
 * `moveExplorerEntryInto` (the controller confirms first, VSCode-style, unless
 * the user suppressed that in settings; read-only workspaces render no
 * `data-drop-dir` and so accept nothing). Dragging an IMAGE row onto an md file row embeds it into that file
 * instead of moving it (`appendImagesToMd`). Implemented with raw pointer
 * events, NOT HTML5 drag-and-drop:
 * Tauri's OS drag-drop interception (which the Explorer-to-app drop feature
 * needs) swallows webview-internal HTML5 drags on Windows — `dragstart` never
 * fires and the OS shows a forbidden cursor. Pointer events are untouched by
 * that interception; targets are hit-tested against the same `data-drop-dir`
 * attributes the OS-drop path in main.tsx uses. The drag machinery lives in
 * `file-explorer/useFileDrag.ts`.
 *
 * The header carries the drawer-wide actions: add workspace, collapse/expand
 * the whole tree (one button that flips with `isTreeOpen`), and refresh.
 *
 * The drawer is resizable via the divider on its right edge; the width is
 * session-only (module scope), like EditorHost's split ratio.
 *
 * Data comes through `session`'s module dispatch (listNoteFiles/openNotePath/
 * addWorkspace/removeWorkspace/setWorkspaceColor/savePastedFileInto) so the
 * component never holds a controller reference.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { isAudioPath } from '../../core/audio';
import { bytesToBase64, isImagePath } from '../../core/images';
import { baseName, dirName } from '../../core/session/plan-flush';
import { isImportablePath } from '../../core/import/registry';
import { stripExtension } from '../../core/title';
import {
  isEditableTextPath,
  isMarkdownPath,
  showAllFilesState,
  showsAllFiles,
} from '../../core/text-files';
import { type WorkspaceColor } from '../../core/types';
import { ipc } from '../../ipc/commands';
import { currentProvider } from '../../ipc/provider';
import { isAndroid } from '../platform';
import {
  addCloudWorkspace,
  addWorkspace,
  createNewFileIn,
  createNewFolderIn,
  getDefaultWorkspacePath,
  openNotePath,
  openNotePathPinned,
  pasteExplorerEntryInto,
  refreshWorkspaces,
  renameExplorerEntry,
  savePastedFileInto,
  toggleShowHiddenFiles,
  type ExplorerEntry,
} from '../session';
import { explorerStore, useExplorerStore } from '../stores/explorer';
import { settingsStore, useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { uiStore, useUiStore } from '../stores/ui';
import { ExplorerContextMenu } from './file-explorer/ContextMenu';
import {
  dirIndent,
  fileBadge,
  isTreeOpen,
  listWithTimeout,
  MIME_EXT,
  toggleTreeAll,
} from './file-explorer/helpers';
import { RenameInput } from './file-explorer/RenameInput';
import { useFileDrag } from './file-explorer/useFileDrag';
import { createWorkspace } from '../workspace-init';

interface WorkspaceView {
  path: string;
  name: string;
  color: WorkspaceColor | null;
  /** The default (notes dir) workspace can't be removed. */
  removable: boolean;
  /** Read-only workspace (the docs): no create/rename/move/delete/paste/drop. */
  readOnly: boolean;
  /** Synced (SAF) workspace — gets a cloud glyph so it's distinguishable. */
  synced: boolean;
  /**
   * Live Edit (shared folder) state, or undefined where the toggle is not
   * offered: the default notes dir, read-only and synced workspaces.
   */
  liveEdit?: boolean;
}

/** setState-style argument (value or updater) for the two tree sets below. */
type TreeSetUpdate = ReadonlySet<string> | ((prev: ReadonlySet<string>) => ReadonlySet<string>);

export function FileExplorer() {
  const open = useUiStore((s) => s.explorerOpen);
  const dropTargetDir = useUiStore((s) => s.dropTargetDir);
  const explorerRefresh = useUiStore((s) => s.explorerRefresh);
  const extraWorkspaces = useSettingsStore((s) => s.settings.workspaces);
  const defaultColor = useSettingsStore((s) => s.settings.defaultWorkspaceColor);
  // notesDir changes (M6 settings flow) must re-derive the default workspace.
  const notesDirSetting = useSettingsStore((s) => s.settings.notesDir);
  // Folders listing every file ("Show unsupported files"); a change re-lists.
  const showAllDirs = useSettingsStore((s) => s.settings.showAllFilesDirs);
  const hideAllDirs = useSettingsStore((s) => s.settings.hideUnsupportedDirs);
  const showHidden = useSettingsStore((s) => s.settings.showHiddenFiles);
  const showAllSignature = JSON.stringify([showAllDirs, hideAllDirs]);
  // Missing key = not yet loaded (show "Loading…"); an array = the listing.
  const [entriesByDir, setEntriesByDir] = useState<Record<string, ExplorerEntry[]>>({});
  // Dirs whose last listing failed or timed out — a never-loaded one (no entry
  // in entriesByDir) shows a Retry affordance instead of an endless "Loading…".
  const [failedDirs, setFailedDirs] = useState<ReadonlySet<string>>(new Set());
  // Subfolders (fileKey'd) whose whole subtree holds nothing the explorer can
  // open — rendered washed out as a "nothing to find here" hint. Local paths
  // only; saf:// folders are never checked (no recursive walk over SAF).
  const [dullDirs, setDullDirs] = useState<ReadonlySet<string>>(new Set());
  // Marp slide decks on disk, per listed dir (fileKey'd paths) — their rows
  // badge *marp* instead of *md*. Content-keyed, so it takes its own backend
  // pass after each listing; saf:// folders are never checked.
  const [decksByDir, setDecksByDir] = useState<Record<string, string[]>>({});
  // Tree shape lives in the persisted settings store, not component state: the
  // drawer unmounts whenever it's closed (and the app exits), and either one
  // would otherwise throw the shape away and reopen fully expanded.
  const collapsedWsList = useSettingsStore((s) => s.settings.explorerCollapsedWorkspaces);
  const expandedDirsList = useSettingsStore((s) => s.settings.explorerExpandedDirs);
  const collapsedWs = useMemo<ReadonlySet<string>>(
    () => new Set(collapsedWsList),
    [collapsedWsList],
  );
  const expandedDirs = useMemo<ReadonlySet<string>>(
    () => new Set(expandedDirsList),
    [expandedDirsList],
  );
  const setCollapsedWs = (update: TreeSetUpdate): void => {
    const prev = new Set(settingsStore.getState().settings.explorerCollapsedWorkspaces);
    const next = typeof update === 'function' ? update(prev) : update;
    settingsStore.getState().update({ explorerCollapsedWorkspaces: [...next] });
  };
  const setExpandedDirs = (update: TreeSetUpdate): void => {
    const prev = new Set(settingsStore.getState().settings.explorerExpandedDirs);
    const next = typeof update === 'function' ? update(prev) : update;
    settingsStore.getState().update({ explorerExpandedDirs: [...next] });
  };
  /** Entry whose context menu is open (workspace root, subfolder, or file), or null. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Where the header's "+" menu is anchored while open (the button's rect), or null. */
  const [addMenuAnchor, setAddMenuAnchor] = useState<DOMRect | null>(null);
  /** Entry being renamed inline (its row shows an input instead), or null. */
  // Path of the row being inline-renamed. Matched against rows by key, never by
  // raw string: `createNewFileIn` builds its path with core's joinPath (`/`)
  // while the listing comes back from the backend with `\` on Windows, so a
  // raw compare would silently never match and the rename input would never
  // appear on a freshly created file.
  const [renaming, setRenaming] = useState<string | null>(null);
  /**
   * Paste destination — and the directory a new terminal starts in; null = the
   * default workspace. Kept in the ui store rather than here because
   * `terminal-open.ts` reads it too.
   */
  const selectedDir = useUiStore((s) => s.selectedExplorerDir);
  /** The row the keyboard acts on, and what is on the explorer clipboard. */
  const selectedRow = useExplorerStore((s) => s.selected);
  const clipboard = useExplorerStore((s) => s.clipboard);
  const setSelectedDir = (dir: string | null) => uiStore.getState().setSelectedExplorerDir(dir);
  /** Remember the row the keyboard should act on (Ctrl+X / Ctrl+C / Ctrl+V). */
  const selectRow = (path: string, isDir: boolean) =>
    explorerStore.getState().select({ path, isDir });
  /** True while a manual refresh is in flight (Drive re-fetch can take seconds). */
  const [refreshing, setRefreshing] = useState(false);
  const { rootRef, dragConsumedClick, explorerWidth, startResizeDrag, startFileDrag } =
    useFileDrag();
  // Re-list whenever the drawer opens, or a tab is added/removed/saved (which
  // may have created or graduated a note file on disk).
  const tabSignature = useTabsStore((s) => s.tabs.map((t) => `${t.notePath ?? t.filePath}`).join());
  // Files open in a tab get a subtle highlight; the active tab's file a bit
  // more. JSON (not join) so a comma in a path can't corrupt the parse.
  const openFilesSignature = useTabsStore((s) =>
    JSON.stringify(s.tabs.map((t) => t.filePath ?? t.notePath).filter((p) => p !== null)),
  );
  // An open file's LIVE deck flag beats the on-disk check: typing (or deleting)
  // `marp: true` re-badges its row before the file is even saved.
  const openDecksSignature = useTabsStore((s) =>
    JSON.stringify(
      s.tabs.flatMap((t) => {
        const p = t.filePath ?? t.notePath;
        return p === null ? [] : [[p, t.deck] as const];
      }),
    ),
  );
  const activeFilePath = useTabsStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active ? (active.filePath ?? active.notePath) : null;
  });
  // Case/separator-insensitive keys, same rationale as session.ts's pathKey.
  const fileKey = (p: string) => p.replaceAll('\\', '/').toLowerCase();
  const openFileKeys = new Set((JSON.parse(openFilesSignature) as string[]).map(fileKey));
  const activeFileKey = activeFilePath === null ? null : fileKey(activeFilePath);
  const isRenaming = (p: string) => renaming !== null && fileKey(renaming) === fileKey(p);
  const openDecks = new Map(
    (JSON.parse(openDecksSignature) as [string, boolean][]).map(([p, d]) => [fileKey(p), d]),
  );
  const diskDecks = new Set(Object.values(decksByDir).flat());
  const isDeck = (p: string): boolean => {
    const key = fileKey(p);
    return openDecks.get(key) ?? diskDecks.has(key);
  };

  const defaultPath = getDefaultWorkspacePath();
  const workspaces: WorkspaceView[] = [
    ...(defaultPath
      ? [
          {
            path: defaultPath,
            name: 'Notes',
            color: defaultColor,
            removable: false,
            readOnly: false,
            synced: false,
          },
        ]
      : []),
    ...extraWorkspaces.map((w) => ({
      path: w.path,
      name: w.name,
      color: w.color,
      removable: true,
      readOnly: w.readOnly === true,
      synced: w.kind === 'synced',
      ...(w.readOnly === true || w.kind === 'synced' ? {} : { liveEdit: w.liveEdit === true }),
    })),
  ];
  /** Is `dir` the root of (or inside) a read-only workspace? */
  const readOnlyRoots = workspaces.filter((w) => w.readOnly).map((w) => fileKey(w.path));
  const isReadOnlyDir = (dir: string): boolean => {
    const key = fileKey(dir);
    return readOnlyRoots.some((root) => key === root || key.startsWith(`${root}/`));
  };
  // JSON, not join(): a path may itself contain the separator character.
  const workspaceSignature = JSON.stringify(workspaces.map((w) => w.path));
  const expandedSignature = JSON.stringify([...expandedDirs].sort());

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    const roots = JSON.parse(workspaceSignature) as string[];
    const expanded = JSON.parse(expandedSignature) as string[];
    for (const path of [...roots, ...expanded]) {
      void listWithTimeout(path)
        .then((list) => {
          if (!cancelled) {
            setEntriesByDir((prev) => ({ ...prev, [path]: list }));
            if (
              !path.startsWith('saf://') &&
              list.some((e) => !e.isDir && isMarkdownPath(e.path))
            ) {
              void ipc
                .listDeckFiles(path)
                .then((decks) => {
                  if (!cancelled) {
                    setDecksByDir((prev) => ({ ...prev, [path]: decks.map(fileKey) }));
                  }
                })
                .catch(() => {}); // best-effort badge — never surface an error
            } else {
              setDecksByDir((prev) => {
                if (!(path in prev)) {
                  return prev;
                }
                const { [path]: _gone, ...rest } = prev;
                return rest;
              });
            }
            // Re-check each subfolder's "anything worth finding?" flag. Cheap:
            // the walk early-exits on the first supported file it meets.
            for (const e of list) {
              if (!e.isDir || e.path.startsWith('saf://')) {
                continue;
              }
              void ipc
                .dirHasRelevantFiles(
                  e.path,
                  showsAllFiles(e.path, ...(JSON.parse(showAllSignature) as [string[], string[]])),
                  showHidden,
                )
                .then((has) => {
                  if (cancelled) {
                    return;
                  }
                  setDullDirs((prev) => {
                    const key = fileKey(e.path);
                    if (prev.has(key) === !has) {
                      return prev;
                    }
                    const next = new Set(prev);
                    if (has) {
                      next.delete(key);
                    } else {
                      next.add(key);
                    }
                    return next;
                  });
                })
                .catch(() => {}); // best-effort styling — never surface an error
            }
            // A retry (or a slow load that eventually arrived) succeeded — clear
            // any stale failure flag so the row stops offering Retry.
            setFailedDirs((prev) => {
              if (!prev.has(path)) {
                return prev;
              }
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
          }
        })
        .catch(() => {
          // Leave entriesByDir untouched: a never-loaded dir stays undefined so
          // renderDir can tell "failed load" apart from a genuinely empty folder.
          if (!cancelled) {
            setFailedDirs((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    open,
    tabSignature,
    workspaceSignature,
    expandedSignature,
    notesDirSetting,
    explorerRefresh,
    showAllSignature,
    showHidden,
  ]);

  if (!open) {
    return null;
  }

  const pasteDir = selectedDir ?? defaultPath;

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>): void {
    if (!pasteDir || isReadOnlyDir(pasteDir)) {
      return;
    }
    const files: File[] = [];
    for (const item of event.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    const usable = files.filter(
      (f) =>
        f.type in MIME_EXT ||
        isImagePath(f.name) ||
        isAudioPath(f.name) ||
        isEditableTextPath(f.name),
    );
    if (usable.length === 0) {
      return;
    }
    event.preventDefault();
    for (const file of usable) {
      const dot = file.name.lastIndexOf('.');
      const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : (MIME_EXT[file.type] ?? '.png');
      // Clipboard screenshots arrive as a generic "image.png" — those get the
      // timestamped name; genuinely named files keep theirs.
      const base = dot > 0 ? file.name.slice(0, dot) : '';
      const name = base && file.name.toLowerCase() !== 'image.png' ? base : null;
      void file
        .arrayBuffer()
        .then((buf) => savePastedFileInto(pasteDir, { base64: bytesToBase64(buf), ext, name }));
    }
  }

  /**
   * The explorer clipboard's keyboard half: Ctrl/Cmd+X, +C and +V acting on the
   * selected row (`stores/explorer.ts`). Ctrl+V with an EMPTY explorer
   * clipboard deliberately falls through to `handlePaste` — the OS clipboard's
   * images and files — so pasting a screenshot into a folder still works.
   * Reached by bubbling from the focused row button; the global keymap in
   * main.tsx binds none of these three, so nothing has to be fought for.
   */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey || event.shiftKey) {
      return;
    }
    // An inline rename is a text field: its own cut/copy/paste wins.
    if ((event.target as HTMLElement).tagName === 'INPUT') {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'v') {
      if (!clipboard) {
        return;
      }
      // A file row pastes into the folder it lives in, like VSCode; with no row
      // picked at all, the paste destination is the active workspace.
      const dest = selectedRow
        ? selectedRow.isDir
          ? selectedRow.path
          : dirName(selectedRow.path)
        : pasteDir;
      if (!dest || isReadOnlyDir(dest)) {
        return;
      }
      event.preventDefault();
      void pasteExplorerEntryInto(clipboard, dest);
      return;
    }
    if ((key !== 'c' && key !== 'x') || !selectedRow) {
      return;
    }
    // A workspace root goes on the clipboard at neither end: its path anchors
    // the settings entry, so it is removed, never moved — and copying a whole
    // workspace is not what "Copy" means here (its context menu agrees).
    const isRoot = workspaces.some((w) => fileKey(w.path) === fileKey(selectedRow.path));
    if (isRoot || (key === 'x' && isReadOnlyDir(selectedRow.path))) {
      return;
    }
    event.preventDefault();
    const name = baseName(selectedRow.path);
    explorerStore
      .getState()
      .put(
        { path: selectedRow.path, name, isDir: selectedRow.isDir },
        key === 'x' ? 'cut' : 'copy',
      );
    uiStore.getState().showNotice(`${key === 'x' ? 'Cut' : 'Copied'} "${name}".`);
  }

  /**
   * Refresh button: re-fetch every workspace root and expanded subfolder from
   * its backend, then re-list. Synced (Drive) dirs otherwise serve a stale
   * cached listing, so a note added on another device never shows up until this
   * forces the provider to re-sync. Guarded so double-taps don't stack.
   */
  async function handleRefresh(): Promise<void> {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    const dirs = [...workspaces.map((w) => w.path), ...expandedDirs];
    try {
      await refreshWorkspaces(dirs);
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * One header button for the whole tree: collapse everything while anything is
   * open, expand the workspace roots once it's all shut. Subfolders are listed
   * lazily, so "expand" deliberately stops at the roots (see toggleTreeAll).
   */
  const treeOpen = isTreeOpen(
    workspaces.map((w) => w.path),
    collapsedWs,
    expandedDirs,
  );
  function toggleAll(): void {
    const next = toggleTreeAll(
      workspaces.map((w) => w.path),
      treeOpen,
    );
    setCollapsedWs(next.collapsedWorkspaces);
    setExpandedDirs(next.expandedDirs);
  }

  const toggleSet = (set: ReadonlySet<string>, path: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    return next;
  };

  /** Clipboard-related row states, shared by file and folder rows: the row the
   *  keyboard acts on, and a row waiting to be moved by a paste. */
  const rowMarks = (path: string): string => {
    let cls = '';
    if (selectedRow && fileKey(selectedRow.path) === fileKey(path)) {
      cls += ' is-row-selected';
    }
    if (clipboard?.mode === 'cut' && fileKey(clipboard.path) === fileKey(path)) {
      cls += ' is-cut';
    }
    return cls;
  };

  const rowClass = (base: string, dir: string): string => {
    let cls = base;
    if (dir === pasteDir) {
      cls += ' is-selected';
    }
    if (dir === dropTargetDir) {
      cls += ' is-drop-target';
    }
    return cls + rowMarks(dir);
  };

  /** Commit an inline rename (null = cancelled). No-op when nothing changed. */
  function commitRename(entry: ExplorerEntry, value: string | null): void {
    setRenaming(null);
    const trimmed = value?.trim();
    const current = entry.isDir ? entry.name : stripExtension(entry.name);
    if (trimmed && trimmed !== current) {
      void renameExplorerEntry(entry.path, trimmed, entry.isDir);
    }
  }

  /**
   * Context-menu "New file": create the file, then jump straight into renaming
   * it on its explorer row (default name "untitled" pre-selected). The target
   * dir is revealed first — a collapsed workspace is expanded, a collapsed
   * subfolder opened — so the new row is actually on screen to rename.
   */
  async function startNewFile(dir: string): Promise<void> {
    setSelectedDir(dir);
    const isWorkspaceRoot = workspaces.some((w) => fileKey(w.path) === fileKey(dir));
    if (isWorkspaceRoot) {
      setCollapsedWs((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    } else {
      setExpandedDirs((prev) => new Set(prev).add(dir));
    }
    const created = await createNewFileIn(dir);
    if (created) {
      setRenaming(created);
    }
  }

  /**
   * Context-menu "New folder": mirror {@link startNewFile} — reveal the target
   * dir, create the subfolder, then jump straight into renaming its row (default
   * name "new-folder" pre-selected) so it can be named in one motion.
   */
  async function startNewFolder(dir: string): Promise<void> {
    setSelectedDir(dir);
    const isWorkspaceRoot = workspaces.some((w) => fileKey(w.path) === fileKey(dir));
    if (isWorkspaceRoot) {
      setCollapsedWs((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    } else {
      setExpandedDirs((prev) => new Set(prev).add(dir));
    }
    const created = await createNewFolderIn(dir);
    if (created) {
      setRenaming(created);
    }
  }

  function retryDir(dirPath: string): void {
    // Drop the failure flag (row returns to "Loading…"), then force a re-fetch
    // + re-list. For a synced dir this re-queries the backend; for a local dir
    // it's a plain re-list. The effect above resolves the row from there.
    setFailedDirs((prev) => {
      if (!prev.has(dirPath)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(dirPath);
      return next;
    });
    void refreshWorkspaces([dirPath]);
  }

  function renderDir(dirPath: string, depth: number, readOnly = false): ReactNode {
    const entries = entriesByDir[dirPath];
    const indent = { paddingLeft: `${dirIndent(depth) + 14}px` };
    if (entries === undefined) {
      // Never loaded: distinguish an in-flight listing from one that failed or
      // timed out (common on an unresponsive cloud folder) — the latter offers
      // a way to try again rather than spinning forever.
      if (failedDirs.has(dirPath)) {
        return (
          <div className="file-explorer-empty" style={indent}>
            Couldn’t load —{' '}
            <button type="button" className="file-explorer-retry" onClick={() => retryDir(dirPath)}>
              Retry
            </button>
          </div>
        );
      }
      return (
        <div className="file-explorer-empty" style={indent}>
          Loading…
        </div>
      );
    }
    if (entries.length === 0) {
      return (
        <div className="file-explorer-empty" style={indent}>
          {depth === 0 ? 'No notes yet' : 'Empty'}
        </div>
      );
    }
    return entries.map((entry) =>
      entry.isDir ? (
        <div key={entry.path}>
          <div className="file-explorer-dir-row">
            {isRenaming(entry.path) ? (
              <div className="file-explorer-dir" style={{ paddingLeft: `${dirIndent(depth)}px` }}>
                <span className="workspace-caret">{expandedDirs.has(entry.path) ? '▾' : '▸'}</span>
                <RenameInput initial={entry.name} onDone={(v) => commitRename(entry, v)} />
              </div>
            ) : (
              <button
                className={
                  rowClass('file-explorer-dir', entry.path) +
                  (dullDirs.has(fileKey(entry.path)) ? ' is-dull' : '')
                }
                style={{ paddingLeft: `${dirIndent(depth)}px` }}
                title={
                  readOnly
                    ? `${entry.path}\nRead-only`
                    : `${entry.path}\nRight-click: new file, rename`
                }
                data-drop-dir={readOnly ? undefined : entry.path}
                aria-expanded={expandedDirs.has(entry.path)}
                onClick={() => {
                  setSelectedDir(entry.path);
                  selectRow(entry.path, true);
                  setExpandedDirs((prev) => toggleSet(prev, entry.path));
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  selectRow(entry.path, true);
                  if (!readOnly) {
                    setMenuFor(menuFor === entry.path ? null : entry.path);
                  }
                }}
              >
                <span className="workspace-caret">{expandedDirs.has(entry.path) ? '▾' : '▸'}</span>
                <span className="file-explorer-dir-name">{entry.name}</span>
              </button>
            )}
            {menuFor === entry.path && (
              <ExplorerContextMenu
                dir={entry.path}
                showAll={showAllFilesState(entry.path, showAllDirs, hideAllDirs)}
                renameTarget={entry}
                onClose={() => setMenuFor(null)}
                onRename={setRenaming}
                onNewFile={startNewFile}
                onNewFolder={startNewFolder}
                onSelectDir={setSelectedDir}
              />
            )}
          </div>
          {expandedDirs.has(entry.path) && renderDir(entry.path, depth + 1, readOnly)}
        </div>
      ) : (
        <div key={entry.path} className="file-explorer-dir-row">
          {isRenaming(entry.path) ? (
            <div className="file-explorer-item" style={indent}>
              <RenameInput
                initial={stripExtension(entry.name)}
                onDone={(v) => commitRename(entry, v)}
              />
            </div>
          ) : (
            <button
              className={
                'file-explorer-item' +
                (openFileKeys.has(fileKey(entry.path)) ? ' is-open' : '') +
                (fileKey(entry.path) === activeFileKey ? ' is-active' : '') +
                (isImportablePath(entry.path) ? ' is-importable' : '') +
                (entry.path === dropTargetDir ? ' is-drop-target' : '') +
                rowMarks(entry.path)
              }
              style={indent}
              title={
                readOnly
                  ? `${entry.path}\nRead-only`
                  : isImportablePath(entry.path)
                    ? `${entry.path}\nClick to preview and import as Markdown · Drag into a folder to move · Right-click: rename, delete`
                    : isMarkdownPath(entry.path)
                      ? `${entry.path}\nDrag into a folder to move · Drop an image to embed it · Right-click: rename, delete`
                      : `${entry.path}\nDrag into a folder to move · Right-click: rename, delete`
              }
              data-drop-dir={readOnly ? undefined : dirPath}
              // md files double as an image-drop target (embed at end of file);
              // main.tsx hit-tests this against OS drags. Images, importable
              // documents, and plain .txt hold no markdown, so they aren't
              // embed targets.
              data-drop-file={readOnly || !isMarkdownPath(entry.path) ? undefined : entry.path}
              onPointerDown={readOnly ? undefined : (e) => startFileDrag(e, entry.path)}
              onClick={() => {
                if (dragConsumedClick.current) {
                  dragConsumedClick.current = false;
                  return;
                }
                setSelectedDir(dirPath);
                selectRow(entry.path, false);
                // Single-click opens (as a preview tab when that setting is on);
                // a double-click below promotes it to a permanent tab.
                openNotePath(entry.path);
              }}
              onDoubleClick={() => {
                setSelectedDir(dirPath);
                selectRow(entry.path, false);
                openNotePathPinned(entry.path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                selectRow(entry.path, false);
                if (!readOnly) {
                  setMenuFor(menuFor === entry.path ? null : entry.path);
                }
              }}
            >
              {(() => {
                const badge = fileBadge(entry.name, isDeck(entry.path));
                return (
                  <>
                    <span className="file-explorer-item-name">
                      {badge ? stripExtension(entry.name) : entry.name}
                    </span>
                    {badge && (
                      <span className="file-badge" data-kind={badge.kind} aria-hidden="true">
                        {badge.label}
                      </span>
                    )}
                  </>
                );
              })()}
            </button>
          )}
          {menuFor === entry.path && (
            <ExplorerContextMenu
              entry={entry}
              onClose={() => setMenuFor(null)}
              onRename={setRenaming}
            />
          )}
        </div>
      ),
    );
  }

  return (
    <>
      <div
        ref={rootRef}
        className="file-explorer"
        style={{ width: `${explorerWidth}px` }}
        aria-label="File explorer"
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
      >
        <div className="file-explorer-header">
          {/* Android has no persistent ribbon in reach of the thumb, so give the
              drawer its own way out — a back button that closes it (the ☰ toggle
              is easy to miss). Desktop keeps the ribbon toggle, so it's hidden
              there. */}
          {isAndroid() && (
            <button
              className="file-explorer-action file-explorer-back"
              aria-label="Close file explorer"
              title="Close"
              onClick={() => uiStore.getState().toggleExplorer()}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <path
                  d="M8 2.5 4 6.5l4 4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
          )}
          <span className="file-explorer-title">Workspaces</span>
          <div className="file-explorer-actions">
            {/* Android: pick a synced folder (Drive/OneDrive/SD card) via SAF.
                On desktop the Drive-for-Desktop folder is added with the plain
                "+" below, so this only shows on Android. */}
            {isAndroid() && (
              <button
                className="file-explorer-action"
                aria-label="Add synced folder"
                title="Add synced folder (Google Drive, OneDrive, SD card…)"
                onClick={() => addCloudWorkspace()}
              >
                <svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true">
                  <path
                    d="M4 10.5a2.6 2.6 0 0 1-.2-5.19A3.2 3.2 0 0 1 10 4.7a2.4 2.4 0 0 1 .3 4.79"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                  <path
                    d="M7.5 6.2v4.6M5.7 8.4l1.8-2 1.8 2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
              </button>
            )}
            {/* Desktop: "+" opens a two-item menu — add an existing folder, or
                create a new one and initialize it. Android has no init flow,
                so the button goes straight to the folder picker. */}
            {currentProvider().capabilities.canPickDir && (
              <button
                className="file-explorer-action"
                aria-label="Add workspace"
                title={isAndroid() ? 'Add workspace (pick a folder)' : 'Add workspace'}
                aria-haspopup={isAndroid() ? undefined : 'menu'}
                aria-expanded={isAndroid() ? undefined : addMenuAnchor !== null}
                onPointerDown={(e) => {
                  // The menu closes on any window pointerdown; keep the
                  // opening press from closing it in the same tick.
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  if (isAndroid()) {
                    addWorkspace();
                  } else {
                    setAddMenuAnchor(
                      addMenuAnchor ? null : e.currentTarget.getBoundingClientRect(),
                    );
                  }
                }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                  <path
                    d="M6.5 2v9M2 6.5h9"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </button>
            )}
            {addMenuAnchor && (
              <AddWorkspaceMenu anchor={addMenuAnchor} onClose={() => setAddMenuAnchor(null)} />
            )}
            {/* One button for the whole tree: a stacked DOUBLE CHEVRON — both
                pointing up while something is open (press to fold everything
                up), both pointing down once it's all shut (press to unfold).
                Same-direction chevrons on purpose: converging ones read as an
                ✕ and looked like "close this workspace". */}
            <button
              className="file-explorer-action"
              aria-label={treeOpen ? 'Collapse all' : 'Expand all'}
              aria-expanded={treeOpen}
              title={treeOpen ? 'Collapse all' : 'Expand all workspaces'}
              onClick={toggleAll}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <path
                  d={
                    treeOpen
                      ? 'M3.3 6.1 6.5 2.9l3.2 3.2M3.3 10.1 6.5 6.9l3.2 3.2'
                      : 'M3.3 2.9 6.5 6.1l3.2-3.2M3.3 6.9 6.5 10.1l3.2-3.2'
                  }
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
            {/* Global "Show hidden files" (dot-names + OS hidden flags): an eye,
                struck through while hidden entries stay hidden. */}
            <button
              className="file-explorer-action"
              aria-label="Show hidden files"
              aria-pressed={showHidden}
              title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
              onClick={() => toggleShowHiddenFiles()}
            >
              <svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true">
                <path
                  d="M1.5 6.5S3.8 2.5 7.5 2.5s6 4 6 4-2.3 4-6 4-6-4-6-4Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                  fill="none"
                />
                <circle
                  cx="7.5"
                  cy="6.5"
                  r="1.8"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  fill="none"
                />
                {!showHidden && (
                  <path
                    d="M2.5 1.5 12.5 11.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
            {/* Re-fetch every workspace from its backend and re-list. The
                headline case is a synced (Drive) folder whose remote changes the
                provider was serving from cache — see refreshWorkspaces. */}
            <button
              className={
                'file-explorer-action file-explorer-refresh' + (refreshing ? ' is-spinning' : '')
              }
              aria-label="Refresh workspaces"
              aria-busy={refreshing || undefined}
              title="Refresh (re-check synced folders for changes)"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <path
                  d="M11 6.5a4.5 4.5 0 1 1-1.32-3.18"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  fill="none"
                />
                <path
                  d="M10.8 1.4v2.4H8.4"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
          </div>
        </div>
        {/* A refresh over a synced (Drive) folder can take several seconds; the
            header glyph spins but is easy to miss on a tablet, so surface an
            explicit, unmissable strip while one is in flight. */}
        {refreshing && (
          <div className="file-explorer-refreshing" role="status" aria-live="polite">
            <span className="file-explorer-refreshing-bar" aria-hidden="true" />
            Refreshing…
          </div>
        )}
        <div className="file-explorer-list">
          {workspaces.map((ws) => {
            const isCollapsed = collapsedWs.has(ws.path);
            return (
              <div
                className="workspace-section"
                data-color={ws.color ?? undefined}
                data-drop-dir={ws.readOnly ? undefined : ws.path}
                key={ws.path}
              >
                <div className="workspace-header">
                  <button
                    className={rowClass('workspace-toggle', ws.path)}
                    title={
                      ws.readOnly
                        ? `${ws.path}\nRead-only · Right-click: workspace color, remove`
                        : `${ws.path}\nRight-click: set active, new…, workspace color${ws.removable ? ', remove' : ''}`
                    }
                    aria-expanded={!isCollapsed}
                    onClick={(e) => {
                      // Alt+click also opens the context menu; a plain click
                      // only collapses/expands — making the workspace active
                      // is an explicit action (the context menu's "Set
                      // active"; double-click was removed — too easy to
                      // trigger by accident while toggling).
                      if (e.altKey) {
                        setMenuFor(menuFor === ws.path ? null : ws.path);
                      } else {
                        setCollapsedWs((prev) => toggleSet(prev, ws.path));
                      }
                    }}
                    onContextMenu={(e) => {
                      // Right-click (the native Windows gesture) opens the
                      // context menu instead of the webview's own.
                      e.preventDefault();
                      // A plain header click only collapses/expands, so the
                      // right-click is what points the keyboard at the root.
                      selectRow(ws.path, true);
                      setMenuFor(menuFor === ws.path ? null : ws.path);
                    }}
                  >
                    <span className="workspace-caret">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="workspace-name">{ws.name}</span>
                    {ws.synced && (
                      <span
                        className="workspace-badge"
                        title="Synced folder"
                        aria-label="Synced folder"
                      >
                        <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
                          <path
                            d="M3.6 8.5a2.2 2.2 0 0 1-.17-4.4A2.8 2.8 0 0 1 9 3.6a2.1 2.1 0 0 1 .25 4.9z"
                            stroke="currentColor"
                            strokeWidth="1"
                            strokeLinejoin="round"
                            fill="none"
                          />
                        </svg>
                      </span>
                    )}
                    {/* The active workspace wears a small right-justified
                        check, in addition to its brightened title — the row's
                        background stays the workspace tint. */}
                    {ws.path === pasteDir && (
                      <span
                        className="workspace-active-badge"
                        title="Active workspace"
                        aria-label="Active workspace"
                      >
                        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                          <path
                            d="M2 5.8l2.4 2.4L9 3.2"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          />
                        </svg>
                      </span>
                    )}
                  </button>
                  {menuFor === ws.path && (
                    <ExplorerContextMenu
                      dir={ws.path}
                      wsColor={ws.color}
                      wsLiveEdit={ws.liveEdit}
                      showAll={
                        ws.readOnly
                          ? undefined
                          : showAllFilesState(ws.path, showAllDirs, hideAllDirs)
                      }
                      removableWs={ws.removable}
                      readOnly={ws.readOnly}
                      onClose={() => setMenuFor(null)}
                      onRename={setRenaming}
                      onNewFile={startNewFile}
                      onNewFolder={startNewFolder}
                      onSelectDir={setSelectedDir}
                    />
                  )}
                </div>
                {!isCollapsed && renderDir(ws.path, 0, ws.readOnly)}
              </div>
            );
          })}
        </div>
      </div>
      <div
        className="explorer-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize explorer"
        onPointerDown={startResizeDrag}
      />
    </>
  );
}

/**
 * The "+" menu in the drawer header: **Open existing folder…** is the plain
 * add-workspace picker; **Create new workspace…** opens the Initialize
 * workspace dialog asking for a name (and location), and Create makes the
 * folder. Dismissed like every other popover — a press outside,
 * Escape, the window moving.
 */
function AddWorkspaceMenu({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div
      className="tab-menu add-workspace-menu"
      role="menu"
      aria-label="Add workspace"
      // Right edge under the button's right edge; the drawer sits at the left
      // of the window, so a menu wider than the header spills rightwards.
      style={{ left: Math.max(4, anchor.right - 200), top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          onClose();
          addWorkspace();
        }}
      >
        <span className="add-workspace-menu-title">Open existing folder…</span>
        <span className="add-workspace-menu-desc">Add a folder you already have</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          onClose();
          void createWorkspace();
        }}
      >
        <span className="add-workspace-menu-title">Create new workspace…</span>
        <span className="add-workspace-menu-desc">New folder, set up for AI agents</span>
      </button>
    </div>
  );
}
