/**
 * Flush + restore — the crash-safety core of the session controller: view
 * assembly → planFlush → executeFlushPlan on the debounced cadence, manifest
 * restore (or self-heal) at boot, and the Ctrl+S file-tab save the flush's
 * live-save pass reuses. See index.ts for the flush lifecycle overview.
 */

import { createDebouncedFlusher, type DebouncedFlusher } from '../../core/session/debounce';
import {
  baseName,
  bufferPathFor,
  executeFlushPlan,
  joinPath,
  parseManifest,
  planFlush,
  type AppSessionView,
  type PersistedTab,
  type SessionManifest,
} from '../../core/session/plan-flush';
import { nanoid } from 'nanoid';
import { isCommentsPath } from '../../core/comments';
import { ipc as nativeIpc } from '../../ipc/commands';
import { setFlushRequester } from '../stores/flush-signal';
import { settingsStore } from '../stores/settings';
import { tabsStore, type RestoredTabInit } from '../stores/tabs';
import { terminalsStore } from '../stores/terminals';
import { uiStore } from '../stores/ui';
import { isAndroid } from '../platform';
import { probeTabConflict } from './conflict-probe';
import type { SessionCtx } from './context';
import { hasPendingMerge, isTabLive } from './live-merge';
import { cursorByTab, pathKey, persistedToInit } from './facade';

export function createFlushRestore(ctx: SessionCtx) {
  async function flushSession(): Promise<void> {
    // Publish this run so the conflict probe can wait it out (fs-changed
    // fires for our own writes; probing mid-flush would misread them).
    let release!: () => void;
    ctx.flushInFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await flushSessionInner();
    } finally {
      ctx.flushInFlight = null;
      release();
    }
  }

  async function flushSessionInner(): Promise<void> {
    // Multi-window: another window's flusher may have created note files since
    // our last flush; re-list so planFlush's clobber guard sees them. (Cheap —
    // one readdir — and it also keeps the single-window cache honest.)
    await ctx.refreshNoteListing();

    // Live save (settings.liveSave): write dirty FILE tabs straight to their
    // own path at the flush cadence, so no explicit Ctrl+S is needed. Runs
    // before view assembly so a saved tab is no longer fileDirty and gets no
    // session buffer (markSaved also queues any stale buffer for deletion by
    // THIS flush). Conflicted tabs are skipped — the banner must be resolved
    // first — and a save that fails or newly detects an on-disk change falls
    // back to the buffer path below, keeping the edits crash-safe either way.
    // Live Edit tabs (a shared cloud folder) save the same way whatever the
    // global setting says — the other side can only see what is on disk.
    const liveSave = settingsStore.getState().settings.liveSave;
    for (const t of tabsStore.getState().tabs) {
      if (
        t.kind === 'file' &&
        t.filePath &&
        !t.conflict &&
        t.model.isDirty('file') &&
        (liveSave || isTabLive(t)) &&
        // A live tab mid red-flash is about to adopt a change from disk;
        // writing its stale text now would clobber that change.
        !hasPendingMerge(t.id)
      ) {
        await saveFileTab(t.id);
      }
    }

    // Pre-write guard for NOTE tabs: a note's file is written straight to
    // disk by this flush (no Ctrl+S, no saveFileTab mtime check), so an
    // external edit — vim on the note file — would be silently clobbered.
    // Probe every note we are about to write; a detected conflict raises the
    // banner and this flush leaves that file untouched (the edits stay in the
    // model until the user resolves the banner).
    const noteProbeIds = tabsStore
      .getState()
      .tabs.filter(
        (t) =>
          t.kind === 'note' &&
          t.notePath !== null &&
          t.savedMtimeMs !== null &&
          !t.conflict &&
          t.model.isDirty('session'),
      )
      .map((t) => t.id);
    await Promise.all(noteProbeIds.map((id) => probeTabConflict(ctx, id)));

    const { tabs, activeTabId, closedNotePaths, obsoleteBufferTabIds } = tabsStore.getState();

    // Snapshot the text we are about to write per tab, so we only advance the
    // "session-persisted" baseline for tabs the user did NOT edit during the
    // async write (otherwise a mid-flush keystroke would be marked clean).
    const assemblyTexts = new Map(tabs.map((t) => [t.id, t.model.getText()]));

    // Prune caret entries for tabs that no longer exist.
    const liveIds = new Set(tabs.map((t) => t.id));
    for (const id of [...cursorByTab.keys()]) {
      if (!liveIds.has(id)) {
        cursorByTab.delete(id);
      }
    }

    const suppressedRenamePaths = new Set(
      [...ctx.renameFailures].filter(([, count]) => count >= 3).map(([from]) => from),
    );
    // A conflicted note is left COMPLETELY untouched — no write (above) and
    // no title-derived rename either, so the external editor keeps a stable
    // path until the banner is resolved.
    for (const t of tabs) {
      if (t.kind === 'note' && t.conflict && t.notePath) {
        suppressedRenamePaths.add(t.notePath);
      }
    }

    const view: AppSessionView = {
      notesDir: ctx.notesDir,
      sessionDir: ctx.sessionDir,
      manifestName: ctx.deps.manifestName,
      activeTabId,
      tabs: tabs.map((t) => ({
        id: t.id,
        kind: t.kind,
        notePath: t.notePath,
        filePath: t.filePath,
        customTitle: t.customTitle,
        title: t.title,
        text: assemblyTexts.get(t.id)!,
        mode: t.mode,
        // A conflicted note is NOT written: the on-disk file holds someone
        // else's changes until the banner is resolved (guard above).
        sessionDirty: t.model.isDirty('session') && !(t.kind === 'note' && t.conflict),
        fileDirty: t.model.isDirty('file'),
        savedMtimeMs: t.savedMtimeMs,
        liveEdit: t.liveEdit,
        cursor: cursorByTab.get(t.id) ?? null,
        // Terminal tabs contribute no text and no buffer — only their layout.
        terminal: t.kind === 'terminal' ? terminalsStore.getState().snapshot(t.id) : null,
        // A git tab likewise: the repository it shows and the checkout picked.
        git:
          t.kind === 'git' && t.gitRoot
            ? { root: t.gitRoot, ...(t.gitCheckout ? { checkout: t.gitCheckout } : {}) }
            : null,
      })),
      existingNoteFiles: ctx.existingNoteFiles,
      closedNotePaths,
      obsoleteBufferPaths: obsoleteBufferTabIds.map((id) => bufferPathFor(ctx.sessionDir, id)),
      suppressedRenamePaths,
    };

    const plan = planFlush(view);
    const result = await executeFlushPlan(plan, ctx.io);

    // Sort renames into succeeded / failed and update the strike counters.
    const failed = new Set(result.renameFailures.map((r) => r.from));
    const renamedPaths: Record<string, string> = {};
    for (const rename of plan.noteRenames) {
      if (failed.has(rename.from)) {
        ctx.renameFailures.set(rename.from, (ctx.renameFailures.get(rename.from) ?? 0) + 1);
      } else {
        ctx.renameFailures.delete(rename.from);
        renamedPaths[rename.from] = rename.to;
      }
    }

    tabsStore.getState().applyFlushResult({
      assignedNotePaths: result.assignedNotePaths,
      renamedPaths,
      consumedClosedNotePaths: closedNotePaths,
      consumedObsoleteBufferTabIds: obsoleteBufferTabIds,
    });

    // Advance the session baseline only for tabs untouched since assembly —
    // and never for a conflicted note, whose file this flush did not write.
    for (const t of tabsStore.getState().tabs) {
      const written = assemblyTexts.get(t.id);
      if (
        written !== undefined &&
        t.model.getText() === written &&
        !(t.kind === 'note' && t.conflict)
      ) {
        t.model.markPersisted('session');
      }
    }

    // Record the on-disk baseline for every note file this flush wrote (path
    // taken AFTER applyFlushResult, so renames/assignments are reflected).
    // This is what arms the conflict probe for note tabs.
    const writtenNoteIds = view.tabs
      .filter((t) => t.kind === 'note' && t.sessionDirty)
      .map((t) => t.id);
    await Promise.all(
      writtenNoteIds.map(async (id) => {
        const tab = tabsStore.getState().tabs.find((t) => t.id === id);
        if (!tab || tab.kind !== 'note' || !tab.notePath) {
          return;
        }
        try {
          const stat = await ctx.ipc.statPath(tab.notePath);
          if (stat.mtimeMs !== null) {
            tabsStore.getState().adoptBaseline(id, stat.mtimeMs);
          }
        } catch {
          // Leave the baseline; the probe's content compare self-heals later.
        }
      }),
    );

    await ctx.refreshNoteListing();
  }

  const flusher: DebouncedFlusher = createDebouncedFlusher({
    idleMs: 1000,
    maxWaitMs: 5000,
    run: flushSession,
    onError: (error) => {
      console.error('[session] flush failed', error);
      uiStore.getState().showNotice('Could not save session — will retry.');
      ctx.deps.onError?.(error);
    },
  });

  setFlushRequester(() => flusher.request());

  /**
   * Read every persisted tab back. The reads run CONCURRENTLY: a session can
   * hold tabs on slow storage — a cloud-streaming drive, or a `\\wsl.localhost`
   * share whose VM has to boot first — and run one after another their
   * latencies stacked up while the window sat on the boot splash. Tab order is
   * kept; `onRestoreProgress` names what is still outstanding.
   */
  async function readNoteTabs(persisted: PersistedTab[]): Promise<{
    tabs: RestoredTabInit[];
    missing: string[];
  }> {
    const waiting = new Map<number, string>();
    const report = () => ctx.deps.onRestoreProgress?.([...waiting.values()]);
    const results = await Promise.all(
      persisted.map(async (pt, i) => {
        const label = restoreLabel(pt);
        if (label !== null) {
          waiting.set(i, label);
          report();
        }
        try {
          return await readPersistedTab(pt);
        } finally {
          if (waiting.delete(i)) {
            report();
          }
        }
      }),
    );
    const restored: RestoredTabInit[] = [];
    const missing: string[] = [];
    for (const result of results) {
      if (result === null) {
        continue;
      }
      if ('tab' in result) {
        restored.push(result.tab);
      } else {
        missing.push(result.missing);
      }
    }
    return { tabs: restored, missing };
  }

  /** The file name the boot splash shows while `pt` is being read, if any. */
  function restoreLabel(pt: PersistedTab): string | null {
    const path = pt.kind === 'git' ? (pt.git?.root ?? null) : (pt.notePath ?? pt.filePath);
    return path ? baseName(path) : null;
  }

  async function readPersistedTab(
    pt: PersistedTab,
  ): Promise<{ tab: RestoredTabInit } | { missing: string } | null> {
    if (pt.kind === 'terminal') {
      // Nothing to read: a terminal tab is pane metadata only, and the
      // shells respawn when the panes mount — unless the descriptor came
      // from a live window handing the tab over, in which case it names the
      // ptys still running and the panes attach to those instead. Android
      // has no pty, so a manifest written on a desktop simply loses its
      // terminal tabs there.
      if (!isAndroid()) {
        return { tab: persistedToInit(pt, '') };
      }
      return null;
    }
    if (pt.kind === 'git') {
      // A git tab holds no text either; what has to still be true is that
      // its root is a repository. Ask git (the same call the tab makes on
      // open; the native ipc, not the storage provider — git is a desktop
      // command, never a SAF one): a deleted or moved repo drops the tab
      // with the "missing" notice rather than restoring an empty panel.
      // Android has no git commands at all, so a desktop manifest loses
      // its git tabs there.
      const root = pt.git?.root;
      if (isAndroid() || !root) {
        return null;
      }
      try {
        await nativeIpc.gitRepoInfo(root);
        return { tab: persistedToInit(pt, '') };
      } catch {
        return { missing: `Git: ${baseName(root)}` };
      }
    }
    if (pt.kind === 'image' || pt.kind === 'import') {
      // Image and import tabs hold no text; just confirm the file still exists.
      if (!pt.filePath) {
        return null;
      }
      try {
        const stat = await ctx.ipc.statPath(pt.filePath);
        if (stat.exists) {
          return { tab: persistedToInit(pt, '') };
        } else {
          return { missing: baseName(pt.filePath) };
        }
      } catch {
        // A transient stat failure shouldn't drop the tab; restore it and
        // let the viewer surface a load error if the file is really gone.
        return { tab: persistedToInit(pt, '') };
      }
    }
    if (pt.kind === 'note') {
      if (pt.notePath === null) {
        // A never-flushed empty note: no file, restore it empty.
        return { tab: persistedToInit(pt, '') };
      }
      try {
        const { text, mtimeMs } = await ctx.ipc.readTextFile(pt.notePath);
        // The read's mtime becomes the note's conflict baseline: the model
        // now holds exactly this on-disk state, so any later mtime move is
        // a real external candidate (probe verifies content before flagging).
        return { tab: persistedToInit({ ...pt, savedMtimeMs: mtimeMs }, text) };
      } catch {
        return { missing: baseName(pt.notePath) };
      }
    } else {
      // File tabs: the buffer (unsaved edits) wins over the on-disk file
      // when present — that's exactly what "restore edits after a kill"
      // means. Falling back to the file itself makes the tab dirty=false;
      // reading the buffer makes it dirty=true (the write to filePath never
      // happened). checkAllFileConflicts (called after restoreSession)
      // separately catches an on-disk change while the app was closed.
      let text: string | null = null;
      let dirty = false;
      if (pt.hasBuffer) {
        try {
          text = (await ctx.ipc.readTextFile(bufferPathFor(ctx.sessionDir, pt.id))).text;
          dirty = true;
        } catch {
          text = null;
        }
      }
      if (text === null && pt.filePath) {
        try {
          text = (await ctx.ipc.readTextFile(pt.filePath)).text;
          dirty = false;
        } catch {
          text = null;
        }
      }
      if (text === null) {
        if (pt.filePath) {
          return { missing: baseName(pt.filePath) };
        }
        return null;
      }
      return { tab: persistedToInit(pt, text, dirty) };
    }
  }

  /** Self-heal: reopen the 20 most recent notes as fresh tabs. */
  async function selfHeal(hadCorruptManifest: boolean): Promise<void> {
    if (hadCorruptManifest) {
      try {
        await ctx.ipc.renamePath(ctx.manifestPath, `${ctx.manifestPath}.bad-${ctx.now()}`);
      } catch {
        // Best effort; a failed quarantine must not block startup.
      }
    }
    let recent: RestoredTabInit[];
    try {
      const notes = (await ctx.ipc.listNotes(ctx.notesDir)).filter((n) => !isCommentsPath(n.path));
      const reads = await Promise.all(
        notes.slice(0, 20).map(async (n) => {
          try {
            const { text } = await ctx.ipc.readTextFile(n.path);
            return { path: n.path, text };
          } catch {
            return null;
          }
        }),
      );
      recent = reads
        .filter((r): r is { path: string; text: string } => r !== null)
        .map((r) => ({
          id: nanoid(),
          kind: 'note' as const,
          notePath: r.path,
          filePath: null,
          customTitle: null,
          mode: 'raw' as const,
          savedMtimeMs: null,
          text: r.text,
        }));
    } catch {
      recent = [];
    }
    tabsStore.getState().restoreSession({ tabs: recent, activeTabId: recent[0]?.id ?? null });
  }

  /**
   * The bundled docs live inside the install location, which can move between
   * launches (an AppImage mounts at a fresh path every run; installers may
   * relocate resources on update). Settings persist the docs workspace path,
   * so before restore, retarget every read-only workspace entry to the current
   * docs dir (dropping duplicates and, in builds without docs, dead entries).
   * Returns the stale roots so manifest tab paths can be remapped too.
   */
  function reconcileDocsWorkspaces(): string[] {
    const docsDir = ctx.deps.docsDir ?? null;
    const { settings, update } = settingsStore.getState();
    const stale = settings.workspaces.filter(
      (w) => w.readOnly === true && (docsDir === null || pathKey(w.path) !== pathKey(docsDir)),
    );
    if (stale.length === 0) {
      return [];
    }
    if (docsDir === null) {
      update({ workspaces: settings.workspaces.filter((w) => w.readOnly !== true) });
      return [];
    }
    const seen = new Set<string>();
    const next = [];
    for (const w of settings.workspaces) {
      const entry = w.readOnly === true ? { ...w, path: docsDir } : w;
      const key = pathKey(entry.path);
      if (!seen.has(key)) {
        seen.add(key);
        next.push(entry);
      }
    }
    update({ workspaces: next });
    return stale.map((w) => w.path);
  }

  /** Remap a path under one of the stale docs roots onto the current docs dir. */
  function remapDocsPath(path: string | null, staleRoots: string[]): string | null {
    const docsDir = ctx.deps.docsDir;
    if (path === null || !docsDir) {
      return path;
    }
    const key = pathKey(path);
    for (const root of staleRoots) {
      const rootKey = pathKey(root);
      if (key.startsWith(`${rootKey}/`)) {
        return joinPath(docsDir, path.slice(root.length + 1));
      }
    }
    return path;
  }

  async function restore(): Promise<void> {
    await ctx.refreshNoteListing();

    // A tear-off window receives its manifest from the spawning window (via
    // deps) instead of reading it from disk; the flush at the end of restore
    // then persists it as this window's own manifest file.
    let raw: string | null = null;
    let manifest: SessionManifest | null = ctx.deps.initialManifest ?? null;
    if (manifest === null) {
      try {
        raw = (await ctx.ipc.readTextFile(ctx.manifestPath)).text;
      } catch {
        // NOT_FOUND (first launch) or unreadable — either way, no manifest.
        raw = null;
      }
      manifest = raw !== null ? parseManifest(raw) : null;
    }

    const staleDocsRoots = reconcileDocsWorkspaces();
    if (manifest !== null && staleDocsRoots.length > 0) {
      for (const t of manifest.tabs) {
        t.filePath = remapDocsPath(t.filePath, staleDocsRoots);
      }
    }

    if (manifest === null) {
      if (!ctx.isMain) {
        // A secondary window never reopens recent notes — that would duplicate
        // tabs the main window owns. It just starts fresh (one Untitled).
        tabsStore.getState().restoreSession({ tabs: [], activeTabId: null });
      } else {
        // A file that existed but wouldn't parse is corrupt → quarantine it.
        await selfHeal(raw !== null);
      }
    } else {
      const { tabs, missing } = await readNoteTabs(manifest.tabs);
      for (const t of tabs) {
        const cursor = manifest.tabs.find((pt) => pt.id === t.id)?.cursor;
        if (cursor) {
          cursorByTab.set(t.id, cursor);
        }
      }
      const activeTabId = tabs.some((t) => t.id === manifest.activeTabId)
        ? manifest.activeTabId
        : (tabs[0]?.id ?? null);
      tabsStore.getState().restoreSession({ tabs, activeTabId });
      if (missing.length > 0) {
        uiStore
          .getState()
          .showNotice(`${missing.length} file(s) could not be found — those tabs were skipped.`);
      }
      // File tab restore honors hasBuffer (above); this catches the OTHER
      // half — the on-disk file itself changing while the app was closed.
      await ctx.checkAllFileConflicts();
    }

    // Persist a fresh manifest once at boot: a self-heal has a new tab set to
    // record, and even a clean restore benefits from re-anchoring the manifest.
    flusher.request();
  }

  /**
   * Save an existing FILE tab to its own path (Ctrl+S; also the "save" branch
   * of the close-tab prompt). Re-stats first — "before every save"
   * — so a real external change is never silently clobbered: the save is
   * refused and the ConflictBanner takes over instead. Returns whether the
   * tab ended up clean (false = failed or blocked by a conflict).
   */
  async function saveFileTab(id: string): Promise<boolean> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'file' || !tab.filePath) {
      return false;
    }
    const filePath = tab.filePath;
    if (hasPendingMerge(id)) {
      // The red flash is showing: the text is about to change under us.
      // The next flush (a second away) saves the merged result instead.
      return false;
    }
    try {
      const stat = await ctx.ipc.statPath(filePath);
      // A Live Edit tab probes (reads + merges) before EVERY write — see the
      // probe for why mtime alone is not trusted on cloud drives.
      if (
        stat.exists &&
        ((stat.mtimeMs !== null && stat.mtimeMs !== tab.savedMtimeMs) || isTabLive(tab))
      ) {
        // An mtime move alone may be benign (touch, identical rewrite) — the
        // probe reads and compares content, adopting the baseline when
        // nothing really changed so the save may proceed.
        if (await probeTabConflict(ctx, id)) {
          uiStore
            .getState()
            .showNotice(`"${tab.title}" changed on disk — resolve it before saving.`);
          return false;
        }
      }
      // A missing file (deleted while open) is not a conflict: atomic_write_text
      // below simply recreates it.
    } catch {
      // A transient stat failure must not block the save.
    }
    try {
      // Record exactly what was written: on a slow drive the user keeps
      // typing during the await, and those edits must stay dirty.
      const text = tab.model.getText();
      await ctx.ipc.atomicWriteText(filePath, text);
      const after = await ctx.ipc.statPath(filePath);
      tabsStore.getState().markSaved(id, after.mtimeMs ?? ctx.now(), text);
      return !tab.model.isDirty('file');
    } catch (error) {
      uiStore.getState().showNotice(`Could not save "${tab.title}".`);
      ctx.deps.onError?.(error);
      return false;
    }
  }

  return { flusher, restore, saveFileTab, readNoteTabs };
}
