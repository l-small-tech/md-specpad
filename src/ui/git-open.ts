/**
 * Entry points into the git tab: the palette command, the mod+Shift+G chord
 * and the explorer's "Git" row all land here, as does the store's way of
 * opening a shell or the harness in a checkout.
 *
 * Two rules this file keeps for the whole feature:
 *
 * - THE APP NEVER TYPES INTO A TERMINAL. `openTerminalAt(cwd, harness)` is
 *   the feature's only terminal call and it passes exactly two arguments to
 *   `openTerminal`: which profile, and where. There is no third argument —
 *   no initial input of any kind — and `__tests__/git-open.test.ts` pins that.
 * - One git tab per repository per window, keyed by the repository's MAIN
 *   root (`GitRepoInfo.mainRoot`), whichever worktree or file it was opened
 *   from. `tabsStore.openGitTab` dedupes; this module only resolves the root.
 *
 * Desktop only: Android has no git commands, and a synced (`saf://`) root is
 * not a path git can be run in — both get a notice instead of a tab.
 */

import { gitFailureText } from '../core/git/hints';
import { baseName } from '../core/session/plan-flush';
import { pathKey } from '../core/tab-workspaces';
import { HARNESS_PROFILE_ID } from '../core/types';
import { ipc, IpcError, isGitUnavailable, type GitRepoInfo } from '../ipc/commands';
import { isAndroid } from './platform';
import { getDefaultWorkspacePath } from './session';
import { gitStore } from './stores/git';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';
import { openTerminal } from './terminal-open';

/**
 * Open a shell (`harness === false`) or the configured harness (`true`) as a
 * terminal tab whose working directory is `cwd`. Nothing is typed into it:
 * the profile's own program starts, and that is all. Never add a third
 * argument here.
 */
export function openTerminalAt(cwd: string, harness: boolean): void {
  openTerminal(harness ? HARNESS_PROFILE_ID : undefined, cwd);
}

/**
 * The notice for a `gitRepoInfo` failure at open time: the two "unavailable"
 * cases get a sentence that names the path, everything else the shared
 * `gitFailureText` reading.
 */
function openFailureText(err: unknown, path: string): string {
  if (err instanceof IpcError) {
    switch (err.code) {
      case 'GIT_NOT_FOUND':
        return 'Git was not found — install git and make sure it is on your PATH.';
      case 'GIT_NOT_A_REPO':
        return `${baseName(path) || path} is not inside a git repository.`;
      case 'GIT_UNTRUSTED':
        return `Git does not trust ${baseName(path) || path} — the folder is owned by another user.`;
      default:
        return gitFailureText(err);
    }
  }
  return 'Git is unavailable.';
}

/**
 * Open (or activate) the git tab for the repository that contains
 * `pathOrRoot` — a file, a folder, a worktree or the main root. Resolves with
 * the tab's id, or null when nothing opened (a notice says why).
 */
export async function openGitTab(
  pathOrRoot: string,
  opts?: { checkout?: string | null },
): Promise<string | null> {
  const { showNotice } = uiStore.getState();
  if (isAndroid()) {
    showNotice('Git is available on desktop only.');
    return null;
  }
  if (pathOrRoot.startsWith('saf://')) {
    showNotice('Git is not available for a synced folder.');
    return null;
  }
  const base = settingsStore.getState().settings.reviewBaseBranch;
  const repoInfo = () => ipc.gitRepoInfo(pathOrRoot, base === '' ? undefined : base);
  let info: GitRepoInfo;
  try {
    try {
      info = await repoInfo();
    } catch (err) {
      // git's "dubious ownership" refusal: offer to trust the folder (the
      // store confirms first), then ask once more.
      if (
        !(err instanceof IpcError && err.code === 'GIT_UNTRUSTED') ||
        !(await gitStore.getState().trustFolder(pathOrRoot))
      ) {
        throw err;
      }
      info = await repoInfo();
    }
  } catch (err) {
    showNotice(openFailureText(err, pathOrRoot));
    if (!isGitUnavailable(err)) {
      console.warn('[git] open failed', err);
    }
    return null;
  }
  const checkout = opts?.checkout ?? info.root;
  const id = tabsStore.getState().openGitTab({ root: info.mainRoot, checkout });
  gitStore.getState().ensureRepo(info.mainRoot, checkout);
  return id;
}

/**
 * Where the active tab "is", for the chord and the palette: its file, its
 * shell's directory, the repository it already shows, the explorer's active
 * folder, or the default workspace.
 */
export function activeGitPath(): string | null {
  const tab = tabsStore.getState().activeTab();
  return (
    tab?.filePath ??
    tab?.notePath ??
    tab?.terminalCwd ??
    tab?.gitCheckout ??
    tab?.gitRoot ??
    uiStore.getState().selectedExplorerDir ??
    getDefaultWorkspacePath()
  );
}

/** mod+Shift+G / "Git: source control": the git tab for whatever is in front. */
export async function openGitTabForActiveTab(): Promise<string | null> {
  const path = activeGitPath();
  if (path === null) {
    uiStore.getState().showNotice('Open a file or a workspace first.');
    return null;
  }
  return openGitTab(path);
}

/** "Git: new worktree…": the git tab for the active repository, with the dialog open. */
export async function openNewWorktreeForActiveTab(): Promise<void> {
  const id = await openGitTabForActiveTab();
  if (id === null) {
    return;
  }
  const root = tabsStore.getState().tabs.find((t) => t.id === id)?.gitRoot;
  if (root) {
    gitStore.getState().openNewWorktree(root);
  }
}

/**
 * Forget a repository once its last git tab in this window closes: the store
 * stops refreshing it and the watcher stops covering its checkouts. Installed
 * once at bootstrap (main.tsx); returns the unsubscribe.
 */
export function watchGitTabClosures(): () => void {
  const rootsOf = (tabs: readonly { kind: string; gitRoot: string | null }[]) => {
    const roots = new Map<string, string>();
    for (const t of tabs) {
      if (t.kind === 'git' && t.gitRoot) {
        roots.set(pathKey(t.gitRoot), t.gitRoot);
      }
    }
    return roots;
  };
  return tabsStore.subscribe((state, prev) => {
    if (state.tabs === prev.tabs) {
      return;
    }
    const now = rootsOf(state.tabs);
    for (const [key, root] of rootsOf(prev.tabs)) {
      if (!now.has(key)) {
        gitStore.getState().forget(root);
      }
    }
  });
}
