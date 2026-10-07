/**
 * The git store's real dependencies, wired once at bootstrap (main.tsx).
 *
 * `stores/git.ts` cannot import the session facade, the tabs store or the
 * terminal opener without a cycle, so it takes them injected
 * (`GitStoreDeps`) and this module — plain ui code, free to import all of
 * them — is where the app's real ones are assembled. Tests hand the store a
 * fake instead and never load this file.
 *
 * Nothing here types into a terminal: `openTerminalAt` opens a shell or the
 * harness IN a directory (`git-open.ts`), and that is the whole of it.
 */

import { pickUnusedColor } from '../core/settings';
import { baseName } from '../core/session/plan-flush';
import { pathKey } from '../core/tab-workspaces';
import { getClipboard } from '../ipc/clipboard';
import { ipc } from '../ipc/commands';
import { startGitNetOp } from '../ipc/git-ops';
import { openTerminalAt } from './git-open';
import { getDefaultWorkspacePath, openNotePath, removeWorkspace, saveTab } from './session';
import { installGitDeps } from './stores/git';
import { settingsStore } from './stores/settings';
import { tabDisplayTitle, tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';
import { refreshWatchedDirs } from './watch-dirs';

/**
 * Add a folder as a workspace (a worktree the user just created). Mirrors the
 * explorer's `addWorkspaceFromDialog` minus the picker: duplicates of the
 * default workspace or an existing entry are a no-op, the colour is the next
 * unused one, and the new workspace becomes the active one.
 */
function addWorkspace(path: string): void {
  const key = pathKey(path);
  const { settings, update } = settingsStore.getState();
  const defaultPath = getDefaultWorkspacePath();
  if (
    (defaultPath !== null && key === pathKey(defaultPath)) ||
    settings.workspaces.some((w) => pathKey(w.path) === key)
  ) {
    uiStore.getState().setSelectedExplorerDir(path);
    return;
  }
  const name = baseName(path) || path;
  const color = pickUnusedColor([
    settings.defaultWorkspaceColor,
    ...settings.workspaces.map((w) => w.color),
  ]);
  update({ workspaces: [...settings.workspaces, { name, path, color }] });
  uiStore.getState().setSelectedExplorerDir(path);
}

/**
 * Forget the workspace entry of a worktree about to be removed, returning a
 * function that puts it back as it was (name, colour, flags, position) should
 * git then refuse the removal — or undefined when there was no entry.
 */
function forgetWorkspace(path: string): (() => void) | undefined {
  const key = pathKey(path);
  const before = settingsStore.getState().settings.workspaces;
  const index = before.findIndex((w) => pathKey(w.path) === key);
  const entry = before[index];
  removeWorkspace(path);
  if (!entry) {
    return undefined;
  }
  return () => {
    const { settings, update } = settingsStore.getState();
    if (settings.workspaces.some((w) => pathKey(w.path) === key)) {
      return;
    }
    const next = [...settings.workspaces];
    next.splice(Math.min(index, next.length), 0, entry);
    update({ workspaces: next });
  };
}

/**
 * Save the FILE tab holding `absPath` if it is dirty — the store does this
 * before `git add`ing a resolved conflict, so what git stages is what the
 * editor shows.
 */
async function saveTabAt(absPath: string): Promise<void> {
  const key = pathKey(absPath);
  const tab = tabsStore
    .getState()
    .tabs.find((t) => t.kind === 'file' && t.filePath !== null && pathKey(t.filePath) === key);
  if (tab && tab.model.isDirty('file')) {
    await saveTab(tab.id);
  }
}

/**
 * Close tabs by id — terminals inside a worktree about to be removed. The
 * panes' unmount kills their shells; the short wait afterwards gives that
 * IPC a moment, since `git worktree remove` fails on Windows while a shell
 * still holds the directory.
 */
async function closeTabs(ids: string[]): Promise<void> {
  for (const id of ids) {
    tabsStore.getState().closeTab(id);
  }
  if (ids.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Wire the app's real dependencies into the git store. Call once, at bootstrap. */
export function installAppGitDeps(dialogs: {
  confirm: (message: string, title: string) => Promise<boolean>;
}): void {
  installGitDeps({
    ipc,
    net: startGitNetOp,
    baseBranchSetting: () => settingsStore.getState().settings.reviewBaseBranch,
    activeWorkspaceDir: () => uiStore.getState().selectedExplorerDir ?? getDefaultWorkspacePath(),
    terminalTabs: () =>
      tabsStore
        .getState()
        .tabs.filter((t) => t.kind === 'terminal')
        .map((t) => ({ id: t.id, title: tabDisplayTitle(t), cwd: t.terminalCwd })),
    confirm: dialogs.confirm,
    notice: (message) => uiStore.getState().showNotice(message),
    clipboard: getClipboard,
    openTerminalAt,
    openFile: (absPath) => openNotePath(absPath),
    saveTabAt,
    addWorkspace,
    removeWorkspace: forgetWorkspace,
    closeTabs,
    refreshWatchedDirs,
  });
}
