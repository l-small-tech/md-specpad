/**
 * Workspaces — the M6 notes-dir change flow plus workspace management: adding
 * a local folder, adding an Android synced (SAF) folder, removing a synced
 * workspace (tab eviction + permission release), and the read-only bundled
 * docs workspace.
 */

import { baseName, joinPath } from '../../core/session/plan-flush';
import { pickUnusedColor } from '../../core/settings';
import { planNoteMoves } from '../../core/notes-move';
import { ipc as nativeIpc } from '../../ipc/commands';
import { settingsStore } from '../stores/settings';
import { tabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';
import { pathKey } from './facade';

export function createWorkspaces(
  ctx: SessionCtx,
  openPaths: (paths: string[], opts?: { preview?: boolean }) => Promise<void>,
  closeTabInteractive: (id: string) => Promise<void>,
) {
  /**
   * M6 — repoint the notes directory. Picks a folder, optionally moves the
   * existing note files (default yes), then updates the setting + the live
   * `notesDir` so the next flush writes to the new location. Files that can't
   * be moved (locked, name collision) are left in the old dir and reported;
   * successfully-moved notes have their tabs' `notePath` retargeted so restore
   * and the next flush stay consistent.
   */
  async function changeNotesDir(): Promise<void> {
    if (!ctx.isMain) {
      // Other windows' flushers hold the old dir in a closure and would keep
      // writing notes there — the flow is main-window-only until that's wired.
      uiStore.getState().showNotice('Change the notes folder from the main window.');
      return;
    }
    const picked = await ctx.pickDirectory();
    if (!picked || picked === ctx.notesDir) {
      return;
    }
    const moves = planNoteMoves(ctx.existingNoteFiles, ctx.notesDir, picked);

    let proceed = true;
    if (moves.length > 0) {
      proceed = await ctx.confirm(
        `Move ${moves.length} existing note(s) to the new folder?`,
        'Change notes folder',
      );
    }

    const failures: string[] = [];
    const renamedPaths: Record<string, string> = {};
    if (proceed && moves.length > 0) {
      let done = 0;
      for (const move of moves) {
        try {
          await ctx.ipc.renamePath(move.from, move.to);
          renamedPaths[move.from] = move.to;
        } catch (error) {
          failures.push(baseName(move.from));
          ctx.deps.onError?.(error);
        }
        done += 1;
        uiStore.getState().showNotice(`Moving notes… ${done}/${moves.length}`);
      }
      // Retarget the tabs of notes that actually moved (M2's applyFlushResult
      // already knows how to remap notePath by old→new path).
      if (Object.keys(renamedPaths).length > 0) {
        tabsStore.getState().applyFlushResult({
          assignedNotePaths: {},
          renamedPaths,
          consumedClosedNotePaths: [],
          consumedObsoleteBufferTabIds: [],
        });
      }
    }

    // Point the app at the new dir regardless of the move outcome; a fresh
    // listing seeds the clobber-guard for the new location.
    ctx.notesDir = picked;
    settingsStore.getState().update({ notesDir: picked });
    await ctx.refreshNoteListing();

    if (failures.length > 0) {
      uiStore
        .getState()
        .showNotice(
          `Left ${failures.length} note(s) in the old folder (couldn't move): ${failures.join(', ')}`,
        );
    } else if (proceed && moves.length > 0) {
      uiStore.getState().showNotice(`Moved ${moves.length} note(s) to the new folder.`);
    }

    ctx.flusher.request();
  }

  /**
   * Add-workspace flow: pick a folder (the native picker doubles as "create a
   * new folder"), reject duplicates of the default workspace or an existing
   * entry, then persist it to settings. Removal never deletes files, so the
   * whole feature is non-destructive.
   */
  async function addWorkspaceFromDialog(): Promise<void> {
    const picked = await ctx.pickDirectory();
    if (!picked) {
      return;
    }
    const key = pathKey(picked);
    const { settings, update } = settingsStore.getState();
    if (key === pathKey(ctx.notesDir) || settings.workspaces.some((w) => pathKey(w.path) === key)) {
      uiStore.getState().showNotice('That folder is already a workspace.');
      return;
    }
    const name = baseName(picked) || picked;
    // Auto-assign a color not already in use (the default workspace's color
    // counts as used too); the user can change or clear it afterwards.
    const color = pickUnusedColor([
      settings.defaultWorkspaceColor,
      ...settings.workspaces.map((w) => w.color),
    ]);
    update({ workspaces: [...settings.workspaces, { name, path: picked, color }] });
    // A freshly added workspace is what the user is about to work in — make it
    // the active one right away (pastes, new files and terminals target it).
    uiStore.getState().setSelectedExplorerDir(picked);
  }

  /**
   * Android "Add synced folder": launch the SAF system picker (any installed
   * storage provider — Drive, OneDrive, Dropbox, SD card), take a persistable
   * permission, and add the tree as a workspace. Its root id is
   * `saf://<encodeURIComponent(treeUri)>`; all its ops route through the
   * SafProvider. Duplicates (the same tree picked twice → the same URI) are
   * rejected. Non-destructive: removal only forgets it (see
   * {@link removeSyncedWorkspace}).
   */
  async function addCloudWorkspaceFromDialog(): Promise<void> {
    let picked: { treeUri: string; displayName?: string };
    try {
      picked = await nativeIpc.pickSyncedTree();
    } catch {
      return; // user cancelled the picker
    }
    if (!picked.treeUri) {
      return;
    }
    const rootId = `saf://${encodeURIComponent(picked.treeUri)}`;
    const key = pathKey(rootId);
    const { settings, update } = settingsStore.getState();
    if (settings.workspaces.some((w) => pathKey(w.path) === key)) {
      uiStore.getState().showNotice('That synced folder is already a workspace.');
      return;
    }
    const name = picked.displayName?.trim() || 'Synced folder';
    const color = pickUnusedColor([
      settings.defaultWorkspaceColor,
      ...settings.workspaces.map((w) => w.color),
    ]);
    update({
      workspaces: [
        ...settings.workspaces,
        { name, path: rootId, color, kind: 'synced', treeUri: picked.treeUri },
      ],
    });
    // Same as the local flow: a just-added workspace becomes the active one.
    uiStore.getState().setSelectedExplorerDir(rootId);
    if (!uiStore.getState().explorerOpen) {
      uiStore.getState().toggleExplorer();
    }
  }

  /**
   * Remove a synced (`saf://`) workspace. Unlike a local removal (pure settings
   * surgery), a synced root needs teardown in order: (1) close any open tabs
   * whose file lives under the removed root — a post-release flush/read would
   * otherwise fail ugly — each through the interactive close, so unsaved edits
   * are saved or explicitly discarded; a Cancel on any of them abandons the
   * removal (the workspace stays); (2) best-effort release the persisted
   * folder permission; (3) drop the settings entry. Non-destructive: no files
   * are deleted (the folder still lives in Drive/OneDrive/…).
   */
  async function removeSyncedWorkspace(path: string): Promise<void> {
    const prefix = `${path}/`;
    const owned = tabsStore
      .getState()
      .tabs.filter((t) => {
        const p = t.filePath ?? t.notePath;
        return p && (p === path || p.startsWith(prefix));
      })
      .map((t) => t.id);
    for (const id of owned) {
      await closeTabInteractive(id);
      if (tabsStore.getState().tabs.some((t) => t.id === id)) {
        return; // the user cancelled (or the save failed) — keep the workspace
      }
    }
    // Read settings only now: the prompts above were awaited.
    const { settings, update } = settingsStore.getState();
    const entry = settings.workspaces.find((w) => pathKey(w.path) === pathKey(path));
    if (entry?.treeUri) {
      await nativeIpc.releaseSyncedTree(entry.treeUri).catch(() => {
        // Best effort — the workspace is forgotten regardless of the release.
      });
    }
    const latest = settingsStore.getState().settings.workspaces;
    update({ workspaces: latest.filter((w) => pathKey(w.path) !== pathKey(path)) });
  }

  /**
   * Settings "Open docs": register the bundled documentation folder as a
   * read-only workspace (idempotent — an existing entry for that path is
   * upgraded to read-only rather than duplicated), reveal it in the explorer,
   * and open a page pinned to Review mode — the start page, or `page` when a
   * caller wants a specific guide (the Themes menu's Help opens 'themes.md').
   */
  async function openDocsWorkspace(page?: string): Promise<void> {
    const docsDir = ctx.deps.docsDir ?? null;
    if (!docsDir) {
      uiStore.getState().showNotice('Documentation is not available in this build.');
      return;
    }
    try {
      if (!(await ctx.ipc.statPath(docsDir)).exists) {
        uiStore.getState().showNotice('The documentation folder could not be found.');
        return;
      }
    } catch {
      // A transient stat failure shouldn't block the flow; list_dir will
      // surface a real problem as an empty workspace.
    }
    const key = pathKey(docsDir);
    const { settings, update } = settingsStore.getState();
    const existing = settings.workspaces.find((w) => pathKey(w.path) === key);
    if (existing) {
      if (existing.readOnly !== true) {
        update({
          workspaces: settings.workspaces.map((w) =>
            pathKey(w.path) === key ? { ...w, readOnly: true } : w,
          ),
        });
      }
    } else {
      const color = pickUnusedColor([
        settings.defaultWorkspaceColor,
        ...settings.workspaces.map((w) => w.color),
      ]);
      update({
        workspaces: [
          ...settings.workspaces,
          { name: 'Documentation', path: docsDir, color, readOnly: true },
        ],
      });
    }
    if (!uiStore.getState().explorerOpen) {
      uiStore.getState().toggleExplorer();
    }
    // Opened AFTER the workspace exists so isReadOnlyPath pins the tab to read
    // mode.
    await openPaths([joinPath(docsDir, page ?? 'README.md')]);
  }

  return {
    changeNotesDir,
    addWorkspaceFromDialog,
    addCloudWorkspaceFromDialog,
    removeSyncedWorkspace,
    openDocsWorkspace,
  };
}
