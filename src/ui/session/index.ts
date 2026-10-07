/**
 * The session controller — the app-wide glue that keeps every tab crash-safe.
 *
 * It owns the debounced flusher and the two pieces of state planFlush needs
 * that don't live in the tabs store: the cached `existingNoteFiles` listing
 * (so a new note never clobbers a file no tab owns) and the per-tab caret
 * positions (kept OUT of the tabs array so caret moves don't re-render the
 * TabBar — same rationale as uiStore's cursor readout).
 *
 * Everything is assembled behind a factory so tests can inject a fake ipc and
 * confirm dialog; `main.tsx` builds the one real instance at boot. The factory
 * is intentionally Tauri-import-free: window/close wiring stays in main.tsx,
 * the confirm dialog arrives as a dependency.
 *
 * Flush lifecycle (see src/core/README.md "how the pieces compose"):
 *   change → requestFlush() → (idle 1s / maxWait 5s) → flushSession()
 *     assemble AppSessionView → planFlush → executeFlushPlan (manifest last)
 *     → apply assigned paths + successful renames → markPersisted('session')
 *     → refresh existingNoteFiles from disk.
 *
 * Split across src/ui/session/ by section: `facade.ts` (module-level dispatch
 * indirections + shared types), `context.ts` (SessionCtx, the shared closure
 * state), and one factory per section — `flush-restore`, `open-save`,
 * `workspaces`, `import-images`, `explorer-ops`, `windows`. This index wires
 * them together and re-exports the whole former `src/ui/session.ts` surface.
 */

import { baseName, dirName, joinPath, type FlushIo } from '../../core/session/plan-flush';
import type { DebouncedFlusher } from '../../core/session/debounce';
import { base64ToBytes, imageMimeType } from '../../core/images';
import { isCommentsPath } from '../../core/comments';
import { sortExplorerEntries } from '../../core/explorer-sort';
import { showsAllFiles } from '../../core/text-files';
import { currentProvider } from '../../ipc/provider';
import { settingsStore } from '../stores/settings';
import { tabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionController, SessionControllerDeps, SessionCtx } from './context';
import {
  isReadOnlyPath,
  pathKey,
  setAddCloudWorkspaceDispatch,
  setAddWorkspaceDispatch,
  setAppendImagesDispatch,
  setBuildExportPreviewHtmlDispatch,
  setChangeNotesDirDispatch,
  setWorkspaceRootForDispatch,
  setCloseAllTabsDispatch,
  setCreateDeckDispatch,
  setCreateDeckHereDispatch,
  setCreateNewFileDispatch,
  setCreateNewFolderDispatch,
  setCreateScanImageDispatch,
  setCreateWhiteboardDispatch,
  setCreateWhiteboardHereDispatch,
  setDefaultWorkspaceDispatch,
  setDeleteEntryDispatch,
  setDropTabOutDispatch,
  setDuplicateTabToNewWindowDispatch,
  setDropTornWindowDispatch,
  setDeleteFolderDispatch,
  setImportDocumentDispatch,
  setImportFilesDispatch,
  setImportStatusDispatch,
  setInsertFileLinkDispatch,
  setInteractiveCloser,
  setKeepMineDispatch,
  setViewDiffDispatch,
  setListNotesDispatch,
  setListOtherTabWindowsDispatch,
  setMoveEntryDispatch,
  setPasteEntryDispatch,
  setMoveTabToNewWindowDispatch,
  setMoveTabToWindowDispatch,
  setDocsDirDispatch,
  setOpenDocsDispatch,
  setOpenExportPreviewDispatch,
  setOpenExportPreviewForFileDispatch,
  setOpenFileDispatch,
  setOpenFileInNewWindowDispatch,
  setNewWindowDispatch,
  setOpenNotePathDispatch,
  setOpenNotePathPinnedDispatch,
  setPickImagePathDispatch,
  setPickPhotoDispatch,
  setReadBytesDispatch,
  setReadImageDispatch,
  setReloadDispatch,
  setRefreshWorkspacesDispatch,
  setRemoveSyncedWorkspaceDispatch,
  setRenameEntryDispatch,
  setRenameTabDispatch,
  setRunExportFromPreviewDispatch,
  setSaveAsDispatch,
  setSaveDispatch,
  setSaveTabDispatch,
  setSavePastedFileDispatch,
  setSavePastedImageDispatch,
  setTearOffTabDispatch,
} from './facade';
import { createExplorerOps } from './explorer-ops';
import { createExport } from './export';
import { createFlushRestore } from './flush-restore';
import { createImportImages } from './import-images';
import { createOpenSave } from './open-save';
import { createWindows } from './windows';
import { createWorkspaces } from './workspaces';

export {
  addCloudWorkspace,
  addWorkspace,
  appendImagesToMd,
  checkImportStatus,
  closeAllTabs,
  closeTab,
  createDeck,
  createDeckIn,
  createNewFileIn,
  createNewFolderIn,
  createScanImageIn,
  createWhiteboard,
  createWhiteboardIn,
  deleteExplorerEntry,
  deleteExplorerFolder,
  dropTabOut,
  dropTornWindow,
  duplicateTabToNewWindow,
  buildExportPreviewHtml,
  enrichCopiedText,
  getCursor,
  getDefaultWorkspacePath,
  getDocsDir,
  importDocumentInto,
  importFilesInto,
  insertFileLink,
  isReadOnlyPath,
  keepMineTab,
  viewDiffTab,
  listNoteFiles,
  listOtherTabWindows,
  loadFileBytes,
  loadImageDataUrl,
  moveExplorerEntryInto,
  moveTabToNewWindow,
  moveTabToWindow,
  noteCursor,
  openDocs,
  openExportPreview,
  openExportPreviewForFile,
  openFile,
  openFileInNewWindow,
  newWindow,
  openNotePath,
  openNotePathAtLine,
  openNotePathPinned,
  pasteExplorerEntryInto,
  pickImagePath,
  pickPhotoForScan,
  pathKey,
  refreshWorkspaces,
  reloadTab,
  removeWorkspace,
  renameExplorerEntry,
  renameTab,
  requestChangeNotesDir,
  runExportFromPreview,
  saveActiveTab,
  saveActiveTabAs,
  saveTab,
  savePastedFileInto,
  savePastedImageForTab,
  toggleShowAllFilesFor,
  toggleShowHiddenFiles,
  setWorkspaceColor,
  setWorkspaceLiveEdit,
  takePendingReveal,
  tearOffTab,
} from './facade';
export { dismissLostLines, isTabLive, REMOVE_FLASH_MS, restoreLostLines } from './live-merge';
export type {
  ConfirmDialog,
  ConfirmRememberDialog,
  ExplorerEntry,
  ImageRef,
  OpenFilesDialog,
  PastedFile,
  PickDirectoryDialog,
  PickFileDialog,
  SaveDiscardCancelDialog,
  SaveFileDialog,
  ScanPhotoRef,
  TabWindowInfo,
} from './facade';
export type { SessionController, SessionControllerDeps } from './context';

export function createSessionController(deps: SessionControllerDeps): SessionController {
  // Route all fs I/O through the active storage provider (local FS today; a
  // future cloud drive swaps in via setProvider). Tests still inject deps.ipc.
  const ipc = deps.ipc ?? currentProvider();
  const confirm = deps.confirm ?? (async () => true);
  const confirmRemember = deps.confirmRemember ?? (async () => 'confirm' as const);
  // Safe defaults for when a dependency is never injected (e.g. a test that
  // doesn't exercise file dialogs): open/save do nothing rather than guess a
  // destination; the close prompt refuses rather than risk silent data loss.
  const openDialog = deps.openDialog ?? (async () => null);
  const saveDialog = deps.saveDialog ?? (async () => null);
  const saveDiscardCancel = deps.saveDiscardCancel ?? (async () => 'cancel' as const);
  const pickDirectory = deps.pickDirectory ?? (async () => null);
  const pickFile = deps.pickFile ?? (async () => null);
  const now = deps.now ?? (() => Date.now());
  const { sessionDir } = deps.paths;
  const manifestPath = joinPath(sessionDir, deps.manifestName ?? 'session.json');

  const io: FlushIo = {
    atomicWriteText: (path, text) => ipc.atomicWriteText(path, text),
    renamePath: (from, to) => ipc.renamePath(from, to),
    deletePath: (path) => ipc.deletePath(path),
  };

  const ctx: SessionCtx = {
    deps,
    ipc,
    confirm,
    confirmRemember,
    openDialog,
    saveDialog,
    saveDiscardCancel,
    pickDirectory,
    pickFile,
    now,
    // Mutable: the M6 notes-dir change flow repoints it live; every flush reads
    // the current value through the ctx ("next flush writes
    // there"). sessionDir is fixed (never user-configurable).
    notesDir: deps.paths.notesDir,
    sessionDir,
    isMain: deps.isMain ?? true,
    manifestPath,
    io,
    existingNoteFiles: [],
    openingPaths: new Set<string>(),
    pinOnOpen: new Set<string>(),
    renameFailures: new Map<string, number>(),
    flushInFlight: null,

    async refreshNoteListing(): Promise<void> {
      try {
        const notes = await ipc.listNotes(ctx.notesDir);
        ctx.existingNoteFiles = notes.map((n) => baseName(n.path));
      } catch {
        // Missing/unreadable notes dir → keep the last good cache; the next
        // successful flush recreates the dir and re-lists.
      }
    },

    /** First free `base.ext`, `base-2.ext`, … inside `dir` (case handled by FS). */
    async uniquePathIn(dir: string, base: string, ext: string): Promise<string> {
      let candidate = joinPath(dir, `${base}${ext}`);
      for (let i = 2; ; i++) {
        try {
          if (!(await ipc.statPath(candidate)).exists) {
            return candidate;
          }
        } catch {
          // Can't stat → let the write/copy itself report the real problem.
          return candidate;
        }
        candidate = joinPath(dir, `${base}-${i}${ext}`);
      }
    },

    /** Shared refusal for writes aimed at a read-only workspace (the docs). */
    refuseReadOnly(path: string): boolean {
      if (isReadOnlyPath(path)) {
        uiStore.getState().showNotice('The documentation is read-only.');
        return true;
      }
      return false;
    },

    /** The workspace root containing `path` (longest matching root), or its own
     *  directory when it lies outside every known workspace. */
    workspaceRootFor(path: string): string {
      const roots = [
        ctx.notesDir,
        ...settingsStore.getState().settings.workspaces.map((w) => w.path),
      ];
      const key = pathKey(path);
      let best: string | null = null;
      for (const root of roots) {
        const rootKey = pathKey(root);
        if (key === rootKey || key.startsWith(`${rootKey}/`)) {
          if (best === null || rootKey.length > pathKey(best).length) {
            best = root;
          }
        }
      }
      return best ?? dirName(path);
    },

    /** Finds an open tab (file OR note) that already owns the path (by key). */
    tabOwning(key: string) {
      return tabsStore
        .getState()
        .tabs.find(
          (t) =>
            (t.filePath && pathKey(t.filePath) === key) ||
            (t.notePath && pathKey(t.notePath) === key),
        );
    },

    // Late-wired below, in factory order — see each factory's doc.
    flusher: null as unknown as DebouncedFlusher,
    checkAllFileConflicts: async () => {},
    importDocumentBytes: async () => {},
  };

  const flushRestore = createFlushRestore(ctx);
  ctx.flusher = flushRestore.flusher;
  const openSave = createOpenSave(ctx, flushRestore.saveFileTab);
  ctx.checkAllFileConflicts = openSave.checkAllFileConflicts;
  const workspaces = createWorkspaces(ctx, openSave.openPaths);
  const importImages = createImportImages(ctx, openSave.openPaths);
  ctx.importDocumentBytes = importImages.importDocumentBytes;
  const explorerOps = createExplorerOps(ctx, openSave.openPaths, openSave.renameFileTab);
  const windows = createWindows(ctx, flushRestore.saveFileTab, flushRestore.readNoteTabs);
  const exporter = createExport(ctx);

  setInteractiveCloser((id) => void windows.closeTabInteractive(id));
  setCloseAllTabsDispatch(() => void windows.closeAllTabsInteractive());
  if (deps.spawnTabWindow) {
    setMoveTabToNewWindowDispatch((id, pos) => void windows.moveTabOut(id, pos));
    setTearOffTabDispatch((id, pos, opts) => windows.moveTabOut(id, pos, opts));
    setDropTabOutDispatch((id, pos) => void windows.dropTabOut(id, pos));
    setDropTornWindowDispatch((label) => void windows.dropTornWindow(label));
    setOpenFileInNewWindowDispatch((path) => void windows.openFileInNewWindow(path));
    setNewWindowDispatch(() => void windows.openEmptyWindow());
    setDuplicateTabToNewWindowDispatch((id) => void windows.duplicateTabToNewWindow(id));
  }
  if (deps.sendTabsToWindow) {
    setMoveTabToWindowDispatch((id, label) => void windows.moveTabToWindow(id, label));
  }
  if (deps.listOtherWindows) {
    setListOtherTabWindowsDispatch(deps.listOtherWindows);
  }
  setOpenFileDispatch(() => void openSave.openFileDialog());
  setOpenExportPreviewDispatch((tabId) => exporter.openExportPreview(tabId));
  setOpenExportPreviewForFileDispatch((path) => void exporter.openExportPreviewForFile(path));
  setRunExportFromPreviewDispatch(exporter.runExportFromPreview);
  setBuildExportPreviewHtmlDispatch(exporter.buildPreviewHtml);
  setSaveDispatch(() => void openSave.saveActive());
  setSaveTabDispatch((id) => flushRestore.saveFileTab(id));
  setSaveAsDispatch(() => void openSave.saveAsActive());
  setReloadDispatch((id) => void openSave.reloadFromDisk(id));
  setKeepMineDispatch((id) => void openSave.keepMine(id));
  setViewDiffDispatch((id) => void openSave.viewDiff(id));
  setChangeNotesDirDispatch(() => void workspaces.changeNotesDir());
  setWorkspaceRootForDispatch((path) => ctx.workspaceRootFor(path));
  setListNotesDispatch(async (dir?: string) => {
    const target = dir ?? ctx.notesDir;
    const { showAllFilesDirs, hideUnsupportedDirs, showHiddenFiles } =
      settingsStore.getState().settings;
    const entries = await ipc.listDir(
      target,
      showsAllFiles(target, showAllFilesDirs, hideUnsupportedDirs),
      showHiddenFiles,
    );
    return sortExplorerEntries(
      entries
        // Voice-note sidecars (`*.comments.md`) kept BESIDE their note are
        // hidden from the explorer — they're managed from the note. In the
        // shared-folder mode they are the point of the folder (a person or an
        // agent opens them), so they stay visible.
        .filter(
          (e) =>
            e.isDir ||
            settingsStore.getState().settings.voiceNotesLocation !== 'nextToFile' ||
            !isCommentsPath(e.path),
        )
        .map((e) => ({
          path: e.path,
          name: baseName(e.path),
          isDir: e.isDir,
          mtimeMs: e.mtimeMs,
        })),
    );
  });
  setReadImageDispatch(
    async (path: string) => `data:${imageMimeType(path)};base64,${await ipc.readFileBase64(path)}`,
  );
  setReadBytesDispatch(async (path: string) => base64ToBytes(await ipc.readFileBase64(path)));
  setDefaultWorkspaceDispatch(() => ctx.notesDir);
  setAddWorkspaceDispatch(() => void workspaces.addWorkspaceFromDialog());
  setAddCloudWorkspaceDispatch(() => void workspaces.addCloudWorkspaceFromDialog());
  setRemoveSyncedWorkspaceDispatch((path) => void workspaces.removeSyncedWorkspace(path));
  setOpenDocsDispatch((page) => void workspaces.openDocsWorkspace(page));
  setDocsDirDispatch(() => ctx.deps.docsDir ?? null);
  setImportFilesDispatch(importImages.importFiles);
  setImportDocumentDispatch(importImages.importDocument);
  setImportStatusDispatch(importImages.importStatusFor);
  setAppendImagesDispatch(importImages.appendImagesToMarkdown);
  setSavePastedImageDispatch(importImages.savePastedImage);
  setSavePastedFileDispatch(importImages.savePastedFile);
  setCreateNewFileDispatch(explorerOps.createNewFile);
  setCreateNewFolderDispatch(explorerOps.createNewFolder);
  setCreateWhiteboardDispatch(explorerOps.createNewWhiteboard);
  setCreateWhiteboardHereDispatch(explorerOps.createNewWhiteboardHere);
  setCreateDeckDispatch(explorerOps.createNewDeck);
  setCreateDeckHereDispatch(explorerOps.createNewDeckHere);
  setCreateScanImageDispatch(explorerOps.createScanImage);
  // Whiteboard scan (desktop): the native picker plus a base64 read, turned
  // into the self-contained data: URL the scan screen decodes.
  setPickPhotoDispatch(async () => {
    const path = await ctx.pickFile('image');
    if (path === null) {
      return null;
    }
    const base64 = await ipc.readFileBase64(path);
    return { dataUrl: `data:${imageMimeType(path)};base64,${base64}`, width: 0, height: 0 };
  });
  setPickImagePathDispatch(() => ctx.pickFile('image'));
  setRenameEntryDispatch(explorerOps.renameEntry);
  setMoveEntryDispatch(explorerOps.moveEntry);
  setPasteEntryDispatch(explorerOps.pasteEntry);
  setDeleteEntryDispatch(explorerOps.deleteEntry);
  setDeleteFolderDispatch(explorerOps.deleteFolder);
  setRefreshWorkspacesDispatch(async (dirs) => {
    // Best-effort: refresh every dir in parallel; a backend that can't refresh
    // (local FS) or one dir that fails must not block the others or the re-list.
    await Promise.all(dirs.map((dir) => Promise.resolve(ipc.refresh?.(dir)).catch(() => {})));
  });
  setRenameTabDispatch((id, newName) => {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (
      tab &&
      (tab.kind === 'file' || tab.kind === 'image' || tab.kind === 'import') &&
      tab.filePath
    ) {
      void openSave.renameFileTab(id, newName);
    } else {
      // Note tab: set the title; the flush renames the note file to the new
      // slug. The tab label (a slug of the title) updates immediately.
      tabsStore.getState().renameTab(id, newName);
    }
  });
  setInsertFileLinkDispatch((opts) => void openSave.insertLinkFromDialog(opts));
  setOpenNotePathDispatch((path) => {
    // Never open a second editor over a file some tab already owns (would let
    // two tabs write the same path) — focus the existing one instead. New
    // files reuse the tested file-tab open path. Preview-tab behavior is opt-in
    // via settings; openPaths handles the reuse/replace of the preview slot.
    const existing = ctx.tabOwning(pathKey(path));
    if (existing) {
      tabsStore.getState().activateTab(existing.id);
      return;
    }
    void openSave.openPaths([path], { preview: settingsStore.getState().settings.previewTabs });
  });
  setOpenNotePathPinnedDispatch((path) => {
    // Explorer double-click: open (or promote) the file as a PERMANENT tab.
    const existing = ctx.tabOwning(pathKey(path));
    if (existing) {
      tabsStore.getState().activateTab(existing.id);
      tabsStore.getState().promoteTab(existing.id);
      return;
    }
    void openSave.openPaths([path]);
  });

  return {
    restore: flushRestore.restore,
    request: () => flushRestore.flusher.request(),
    flushNow: () => flushRestore.flusher.flushNow(),
    dispose: () => flushRestore.flusher.dispose(),
    closeTabInteractive: windows.closeTabInteractive,
    closeAllTabsInteractive: windows.closeAllTabsInteractive,
    openFileDialog: openSave.openFileDialog,
    openIncoming: openSave.copyInExternal,
    openPaths: openSave.openPaths,
    saveActive: openSave.saveActive,
    saveAsActive: openSave.saveAsActive,
    checkConflict: openSave.checkConflict,
    checkAllFileConflicts: openSave.checkAllFileConflicts,
    reloadFromDisk: openSave.reloadFromDisk,
    keepMine: openSave.keepMine,
    viewDiff: openSave.viewDiff,
    changeNotesDir: workspaces.changeNotesDir,
    moveTabToNewWindow: windows.moveTabOut,
    dropTabOut: windows.dropTabOut,
    dropTornWindow: windows.dropTornWindow,
    moveTabToWindow: windows.moveTabToWindow,
    adoptTabs: windows.adoptPersistedTabs,
    exportTabsForHandoff: windows.exportTabsForHandoff,
    discardManifest: () => ipc.deletePath(manifestPath),
    bequeathTabsToMain: windows.bequeathTabsToMain,
  };
}
