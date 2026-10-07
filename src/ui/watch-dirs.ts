/**
 * Which directories the OS file watcher covers, re-armed from current state.
 *
 * Extracted from main.tsx so the git store can call it: `git worktree remove`
 * fails on Windows while the watcher holds a handle on the directory, so the
 * store awaits `refreshWatchedDirs()` — with the worktree's workspace entry
 * already gone — before asking git to delete it.
 *
 * The set is: every local workspace root, the folders of Live Edit files
 * opened from outside them (`core/live-edit.ts`), and the checkouts of every
 * repository a git tab shows that no watched root already covers (a linked
 * worktree outside its main root, or a repository opened from a file that is
 * in no workspace). A linked worktree's `.git` is a file pointing into
 * `<main>/.git/worktrees/<name>`, so watching the main root is what makes
 * `git-changed` fire for it. Desktop only — Android has no watch command.
 */

import { extraGitWatchDirs } from '../core/git/checkouts';
import { extraLiveWatchDirs } from '../core/live-edit';
import { ipc } from '../ipc/commands';
import { isAndroid } from './platform';
import { getDefaultWorkspacePath } from './session';
import { gitStore } from './stores/git';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';

let watchedSignature = '';

/**
 * Re-arm the watcher from current state. Cheap when nothing changed (the
 * root list is compared to the last one sent); resolves once Rust has
 * replaced its watch set, so a caller can rely on dropped directories being
 * released.
 */
export async function refreshWatchedDirs(): Promise<void> {
  if (isAndroid()) {
    return;
  }
  const defaultPath = getDefaultWorkspacePath();
  const { workspaces } = settingsStore.getState().settings;
  const roots = [
    ...(defaultPath === null ? [] : [defaultPath]),
    ...workspaces.filter((w) => w.kind !== 'synced').map((w) => w.path),
  ];
  // Live Edit: a shared file opened from OUTSIDE every workspace (per-tab
  // override) still needs its folder watched, or its merges would only
  // happen on window focus.
  roots.push(...extraLiveWatchDirs(tabsStore.getState().tabs, workspaces, roots));
  roots.push(...extraGitWatchDirs(gitStore.getState().watchRoots(), roots));
  // Shown hidden entries need their changes reported too (Rust changed_roots).
  const { showHiddenFiles } = settingsStore.getState().settings;
  const signature = JSON.stringify([roots, showHiddenFiles]);
  if (signature === watchedSignature) {
    return;
  }
  watchedSignature = signature;
  try {
    await ipc.watchDirs(roots, showHiddenFiles);
  } catch {
    // No watcher (a browser dev session) — the explorer keeps its manual refresh.
  }
}

/**
 * Arm the watcher and keep it armed: on every settings and tab change, and —
 * debounced, since a refresh ticks the git store several times — whenever
 * the set of open repositories or their checkouts changes. Called once from
 * main.tsx.
 */
export function startWatchingDirs(): void {
  if (isAndroid()) {
    return;
  }
  const sync = (): void => void refreshWatchedDirs();
  sync();
  settingsStore.subscribe(sync);
  tabsStore.subscribe(sync);
  let gitTimer: ReturnType<typeof setTimeout> | null = null;
  gitStore.subscribe(() => {
    if (gitTimer !== null) {
      clearTimeout(gitTimer);
    }
    gitTimer = setTimeout(() => {
      gitTimer = null;
      sync();
    }, 250);
  });
}
