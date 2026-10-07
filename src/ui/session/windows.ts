/**
 * Windows + interactive close — the confirming close flows and the M8
 * multi-window machinery: tab tear-off into a new OS window, adopting tabs
 * moved over from another window, the quit-time handoff export, and the
 * last-window-standing manifest fold-back into main.
 */

import { nanoid } from 'nanoid';
import { defaultModeFor, docFamilyFor } from '../../core/doc-family';
import { isAudioPath } from '../../core/audio';
import { isImagePath } from '../../core/images';
import { isImportablePath } from '../../core/import/registry';
import {
  joinPath,
  parseManifest,
  type PersistedTab,
  type SessionManifest,
} from '../../core/session/plan-flush';
import { gitStore, repoKey } from '../stores/git';
import { settingsStore } from '../stores/settings';
import { tabsStore, type RestoredTabInit, type TabEntry } from '../stores/tabs';
import { terminalsStore } from '../stores/terminals';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';
import { cursorByTab, pathKey } from './facade';

export function createWindows(
  ctx: SessionCtx,
  saveFileTab: (id: string) => Promise<boolean>,
  readNoteTabs: (
    persisted: PersistedTab[],
  ) => Promise<{ tabs: RestoredTabInit[]; missing: string[] }>,
) {
  async function closeTabInteractive(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    if (tab.kind === 'terminal') {
      // A terminal holds no document to save — the only question is whether a
      // shell is still running in it, since closing the tab kills it.
      const live = terminalsStore.getState();
      const running = Object.values(live.panes).filter((p) => p.tabId === id && !p.exited);
      if (settingsStore.getState().settings.terminalConfirmCloseRunning && running.length > 0) {
        const what = running.length === 1 ? 'a running shell' : `${running.length} running shells`;
        // "Close and don't ask again" flips the same setting the Terminal
        // settings page exposes, so the prompt stays re-enablable.
        const choice = await ctx.confirmRemember(
          `Close "${tab.title}"? It still has ${what}, which will be killed.`,
          'Close terminal',
          { confirm: 'Close', never: "Close, don't ask again" },
        );
        if (choice === 'cancel') {
          return;
        }
        if (choice === 'never') {
          settingsStore.getState().update({ terminalConfirmCloseRunning: false });
        }
      }
      tabsStore.getState().closeTab(id);
      return;
    }
    if (tab.kind === 'git') {
      // Nothing to save either — but a fetch / push streaming in, or a
      // finish-worktree flow mid-step, is state this window alone holds
      // (the git store is per window and never persisted). Closing the tab
      // forgets the repository, so ask first.
      const repo = tab.gitRoot ? gitStore.getState().repos[repoKey(tab.gitRoot)] : undefined;
      const busy = repo?.op?.running ? 'an operation running' : null;
      const finishing =
        repo?.finish && !repo.finish.finished ? 'a finish-worktree flow in progress' : null;
      const what = busy ?? finishing;
      if (what) {
        const ok = await ctx.confirm(
          `Close "${tab.title}"? It has ${what}; its progress will no longer be shown.`,
          'Close git tab',
        );
        if (!ok) {
          return;
        }
      }
      tabsStore.getState().closeTab(id);
      return;
    }
    const text = tab.model.getText();
    if (tab.kind === 'note' && text.trim().length > 0) {
      const ok = await ctx.confirm(`Close "${tab.title}"? Its note will be deleted.`, 'Close note');
      if (!ok) {
        return;
      }
    } else if (tab.kind === 'file' && tab.model.isDirty('file')) {
      const choice = await ctx.saveDiscardCancel(
        `Save changes to "${tab.title}" before closing?`,
        'Close file',
      );
      if (choice === 'cancel') {
        return;
      }
      if (choice === 'save') {
        const saved = await saveFileTab(id);
        if (!saved) {
          return; // save failed, or a conflict banner is now blocking it — keep the tab open
        }
      }
    }
    tabsStore.getState().closeTab(id);
  }

  /**
   * Close every open tab, oldest-first, each through {@link closeTabInteractive}
   * so unsaved file edits and non-empty notes still prompt. A cancel on any tab
   * stops the sweep (VSCode-style) rather than silently skipping it. The last
   * close leaves one fresh Untitled tab (the store's Notepad invariant).
   */
  async function closeAllTabsInteractive(): Promise<void> {
    for (const id of tabsStore.getState().tabs.map((t) => t.id)) {
      await closeTabInteractive(id);
      if (tabsStore.getState().tabs.some((t) => t.id === id)) {
        return; // the user cancelled this tab's close — stop here
      }
    }
  }

  /* ---- M8: multi-window tab tear-off ---------------------------------- */

  /** Serializable manifest entry for `tab`, exactly as a flush would write it.
   *  Only meaningful AFTER a flushNow(): the note file / session buffer it
   *  references must already exist on disk.
   *
   *  `handover` marks a descriptor that travels to a LIVE window (a tab
   *  dragged out or dropped onto another window): a terminal then names the
   *  ptys it is leaving running, so the receiver attaches to the same shells.
   *  Without it the descriptor is manifest-safe — it may be written to disk,
   *  where a pty id from this run of the app would be a lie. */
  function persistedDescriptor(tab: TabEntry, opts?: { handover?: boolean }): PersistedTab {
    return {
      id: tab.id,
      kind: tab.kind,
      notePath: tab.notePath,
      filePath: tab.filePath,
      customTitle: tab.customTitle,
      mode: tab.mode,
      savedMtimeMs: tab.savedMtimeMs,
      hasBuffer: tab.kind === 'file' && tab.model.isDirty('file'),
      cursor: cursorByTab.get(tab.id) ?? null,
      ...(tab.liveEdit !== null ? { liveEdit: tab.liveEdit } : {}),
      // A terminal's layout goes over with the pty id of every live pane, so
      // the receiving window attaches to the SAME shells rather than
      // respawning them (see `pty_attach`). Read BEFORE detachTab, which
      // releases the session.
      ...(tab.kind === 'terminal'
        ? { terminal: terminalsStore.getState().snapshot(tab.id, opts) }
        : {}),
      // A git tab travels as its repository; the receiving window asks git
      // afresh (its finish-flow state, if any, stays behind by design).
      ...(tab.kind === 'git' && tab.gitRoot
        ? { git: { root: tab.gitRoot, ...(tab.gitCheckout ? { checkout: tab.gitCheckout } : {}) } }
        : {}),
    };
  }

  /**
   * Adopt tabs handed over by another window (a tear-off landing here at boot
   * goes through restore() instead; this serves a tab dragged or moved onto
   * this window). A NOTE some tab here already owns is skipped — a note's file
   * follows exactly one tab. A file tab is always taken: landing beside a tab
   * on the same file just makes the two mirrors (tab sync, ui/doc-sync.ts).
   */
  async function adoptPersistedTabs(persisted: PersistedTab[]): Promise<void> {
    const fresh = persisted.filter((pt) => {
      if (pt.kind === 'file') {
        return true;
      }
      if (pt.kind === 'git') {
        // One git tab per repository per window: a second one for a root this
        // window already shows is dropped (the sender's tab is simply gone).
        const root = pt.git?.root;
        return (
          root !== undefined &&
          !tabsStore
            .getState()
            .tabs.some((t) => t.kind === 'git' && pathKey(t.gitRoot ?? '') === pathKey(root))
        );
      }
      const path = pt.filePath ?? pt.notePath;
      return path === null || !ctx.tabOwning(pathKey(path));
    });
    if (fresh.length === 0) {
      return;
    }
    const { tabs, missing } = await readNoteTabs(fresh);
    for (const t of tabs) {
      const cursor = fresh.find((pt) => pt.id === t.id)?.cursor;
      if (cursor) {
        cursorByTab.set(t.id, cursor);
      }
    }
    tabsStore.getState().adoptTabs(tabs);
    if (missing.length > 0) {
      uiStore
        .getState()
        .showNotice(`${missing.length} file(s) could not be found — those tabs were skipped.`);
    }
    ctx.flusher.request();
  }

  /**
   * Tear a tab off into its own OS window. Ownership handoff order is the
   * whole trick:
   *   1. flush — the note file / session buffer the descriptor references
   *      must exist before anything else happens;
   *   2. detach + flush — THIS window's manifest stops claiming the tab
   *      before the new window ever writes its own, so a crash in between
   *      can't restore the tab in two windows at once (worst case it's in
   *      neither manifest, but its files are safely on disk);
   *   3. spawn the window with the descriptor. If that fails, adopt the tab
   *      right back rather than losing it.
   *
   * Resolves with the new window's label (a live tear-off follows/commands it
   * by label), or null when nothing spawned. `opts.focus: false` spawns the
   * window unfocused — a live tear-off keeps focus with the dragging window
   * until release.
   */
  async function moveTabOut(
    id: string,
    pos: { x: number; y: number } | null,
    opts?: { focus?: boolean },
  ): Promise<string | null> {
    const spawn = ctx.deps.spawnTabWindow;
    if (!spawn) {
      return null;
    }
    await ctx.flusher.flushNow();
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab) {
      return null;
    }
    const descriptor = persistedDescriptor(tab, { handover: true });
    tabsStore.getState().detachTab(id);
    await ctx.flusher.flushNow();
    try {
      return await spawn({ schema: 1, activeTabId: descriptor.id, tabs: [descriptor] }, pos, opts);
    } catch (error) {
      await adoptPersistedTabs([descriptor]);
      uiStore.getState().showNotice('Could not open a new window.');
      ctx.deps.onError?.(error);
      return null;
    }
  }

  /**
   * Move a tab into an EXISTING window (a drag dropped onto it, Chrome-style).
   * The ownership handoff order is moveTabOut's exactly — flush, detach, flush
   * — but delivery is the adopt-tabs / adopt-ack event pair (the same one a
   * closing window uses) instead of a spawn. No ack — the receiver is gone or
   * hung — adopts the tab right back rather than losing it; the receiver's
   * adopt dedupes by path, so the worst a late ack can produce is a skipped
   * duplicate, never two owners of one file.
   */
  async function moveTabToWindow(id: string, targetLabel: string): Promise<void> {
    const send = ctx.deps.sendTabsToWindow;
    if (!send) {
      return;
    }
    await ctx.flusher.flushNow();
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    const descriptor = persistedDescriptor(tab, { handover: true });
    tabsStore.getState().detachTab(id);
    await ctx.flusher.flushNow();
    const acked = await send(targetLabel, [descriptor]).catch(() => false);
    if (!acked) {
      await adoptPersistedTabs([descriptor]);
      uiStore.getState().showNotice('Could not move the tab to that window.');
    }
  }

  /**
   * A drag released outside this window: land the tab in the app window under
   * the cursor when there is one, else tear it off into a new window at `pos`.
   * A failed hit-test (no injected finder, Wayland, a Tauri call erroring)
   * degrades to the tear-off — the release always does SOMETHING visible.
   */
  async function dropTabOut(id: string, pos: { x: number; y: number } | null): Promise<void> {
    const target = ctx.deps.findDropWindow
      ? await ctx.deps.findDropWindow().catch(() => null)
      : null;
    if (target !== null && ctx.deps.sendTabsToWindow) {
      await moveTabToWindow(id, target);
      return;
    }
    await moveTabOut(id, pos);
  }

  /**
   * A LIVE tear-off's drag released (M8.6): the tab already left this window
   * at the tear-off moment and its new window is riding the cursor. If the
   * release lands on another app window, command the torn-off window to hand
   * its tab over and close (it owns the tab now — this window only owns the
   * pointer); otherwise just focus it where it was dropped. Every failure
   * degrades to the window staying put — never a lost tab.
   */
  async function dropTornWindow(label: string): Promise<void> {
    const target = ctx.deps.findDropWindow
      ? await ctx.deps.findDropWindow(label).catch(() => null)
      : null;
    if (target !== null && ctx.deps.commandTornWindowDrop) {
      ctx.deps.commandTornWindowDrop(label, target);
      return;
    }
    ctx.deps.focusWindow?.(label);
  }

  /**
   * Open a file from the explorer straight into its own OS window (never a tab
   * here first). If a tab in THIS window already owns the file, this is just a
   * tear-off — {@link moveTabOut} — preserving its unsaved edits and mode
   * (one-owner-per-file, applied across windows). Otherwise a fresh descriptor
   * is spawned: the new window reads the file off disk itself, so no handoff
   * dance is needed — nothing here owns it yet.
   */
  async function openFileInNewWindow(path: string): Promise<void> {
    const spawn = ctx.deps.spawnTabWindow;
    if (!spawn) {
      return;
    }
    const owner = ctx.tabOwning(pathKey(path));
    if (owner) {
      await moveTabOut(owner.id, null);
      return;
    }
    try {
      const stat = await ctx.ipc.statPath(path);
      if (!stat.exists) {
        throw new Error(`not found: ${path}`);
      }
      // Mirrors openPaths' routing: an .svg is a whiteboard (a file tab in draw
      // mode), not an image viewer.
      const family = docFamilyFor(path);
      const descriptor: PersistedTab = {
        id: nanoid(),
        kind: isImportablePath(path)
          ? 'import'
          : (isImagePath(path) && family !== 'svg') || isAudioPath(path)
            ? 'image'
            : 'file',
        notePath: null,
        filePath: path,
        customTitle: null,
        mode: defaultModeFor(family, settingsStore.getState().settings.defaultMode),
        savedMtimeMs: stat.mtimeMs,
        hasBuffer: false,
        cursor: null,
      };
      await spawn({ schema: 1, activeTabId: descriptor.id, tabs: [descriptor] }, null);
    } catch (error) {
      uiStore.getState().showNotice('Could not open a new window.');
      ctx.deps.onError?.(error);
    }
  }

  /**
   * Tab sync: open a MIRROR of file tab `id` in a new window. Nothing is handed
   * over — this window keeps its tab — so the descriptor is a fresh id with no
   * buffer: the new window reads the file off disk, says hello, and this
   * window's doc sync answers with any unsaved text (core/doc-sync.ts).
   */
  async function duplicateTabToNewWindow(id: string): Promise<void> {
    const spawn = ctx.deps.spawnTabWindow;
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!spawn || !tab || tab.kind !== 'file' || tab.filePath === null) {
      return;
    }
    const descriptor: PersistedTab = {
      ...persistedDescriptor(tab),
      id: nanoid(),
      hasBuffer: false,
    };
    try {
      await spawn({ schema: 1, activeTabId: descriptor.id, tabs: [descriptor] }, null);
    } catch (error) {
      uiStore.getState().showNotice('Could not open a new window.');
      ctx.deps.onError?.(error);
    }
  }

  /**
   * mod+N: spawn a fresh OS window with nothing in it. An EMPTY manifest is
   * handed over so the new window skips its own manifest file and boots the
   * way a first launch does — `restoreSession([])` makes the one Untitled
   * note — while still inheriting this window's workspace (spawnTabWindow
   * puts it in the URL).
   */
  async function openEmptyWindow(): Promise<void> {
    const spawn = ctx.deps.spawnTabWindow;
    if (!spawn) {
      return;
    }
    try {
      await spawn({ schema: 1, activeTabId: null, tabs: [] }, null);
    } catch (error) {
      uiStore.getState().showNotice('Could not open a new window.');
      ctx.deps.onError?.(error);
    }
  }

  /**
   * Quit-time export (a last-standing secondary window closing): flush
   * everything, then describe each tab worth keeping. A pristine never-flushed
   * Untitled is dropped — folding an empty placeholder into main's manifest
   * would just add noise.
   */
  async function exportTabsForHandoff(): Promise<PersistedTab[]> {
    await ctx.flusher.flushNow();
    return (
      tabsStore
        .getState()
        .tabs.filter(
          (t) =>
            !(
              t.kind === 'note' &&
              t.notePath === null &&
              t.customTitle === null &&
              t.model.getText().length === 0
            ),
        )
        // Not a pty handover: this window is closing, which kills its shells
        // whatever the manifest says, and these descriptors may be written to
        // main's session.json (`bequeathTabsToMain`) where a pty id would rot.
        .map((tab) => persistedDescriptor(tab))
    );
  }

  /**
   * Last-window-standing close (secondary windows): fold this window's tabs
   * into MAIN's manifest and delete our own, so the next launch opens a
   * single main window holding everything instead of resurrecting this
   * window alongside it. Manifest-file surgery rather than an adopt event —
   * there is no window left alive to adopt the tabs.
   *
   * Our manifest is deleted BEFORE session.json is written (same order as
   * moveTabOut): a crash in between leaves the tabs in neither manifest —
   * their note files / buffers are safely on disk — never in both, which
   * would restore duplicate owners of the same file.
   */
  async function bequeathTabsToMain(tabs: PersistedTab[]): Promise<void> {
    const mainManifestPath = joinPath(ctx.sessionDir, 'session.json');
    // Missing/corrupt session.json → null: these tabs become the whole session.
    const main: SessionManifest | null = await ctx.ipc
      .readTextFile(mainManifestPath)
      .then((r) => parseManifest(r.text))
      .catch(() => null);
    // One-owner-per-file across manifests, mirroring adoptTabs.
    const taken = new Set(
      (main?.tabs ?? [])
        .map((t) => t.filePath ?? t.notePath)
        .filter((p): p is string => p !== null)
        .map(pathKey),
    );
    const fresh = tabs.filter((t) => {
      const path = t.filePath ?? t.notePath;
      return path === null || !taken.has(pathKey(path));
    });
    const activeTabId = tabsStore.getState().activeTabId;
    const merged: SessionManifest = {
      schema: 1,
      // This window's active tab is what the user last touched; fall back to
      // main's remembered one when dedupe dropped ours.
      activeTabId: fresh.some((t) => t.id === activeTabId)
        ? activeTabId
        : (main?.activeTabId ?? fresh[0]?.id ?? null),
      tabs: [...(main?.tabs ?? []), ...fresh],
    };
    await ctx.ipc.deletePath(ctx.manifestPath);
    await ctx.ipc.atomicWriteText(mainManifestPath, JSON.stringify(merged, null, 2));
  }

  return {
    closeTabInteractive,
    closeAllTabsInteractive,
    adoptPersistedTabs,
    moveTabOut,
    moveTabToWindow,
    dropTabOut,
    dropTornWindow,
    openFileInNewWindow,
    duplicateTabToNewWindow,
    exportTabsForHandoff,
    openEmptyWindow,
    bequeathTabsToMain,
  };
}
