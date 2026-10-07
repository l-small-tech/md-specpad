/**
 * workspace-init.ts — the state and side effects behind the Initialize
 * Workspace dialog (`components/InitWorkspaceDialog.tsx`).
 *
 * The decisions are `core/workspace-modules.ts` (what AGENTS.md becomes, which
 * files get written, what is never overwritten); this file only gathers its
 * inputs — the folder, the user's modules folder, the files already there —
 * and performs the writes it plans. Opened with a `root` it is the
 * "Workspace directives…" re-run on an existing workspace: the ticks start
 * from the modules AGENTS.md already carries. Opened by "Create new
 * workspace" it asks for a name and a location instead of a folder, and
 * makes the folder on Create.
 */

import { openPath } from '@tauri-apps/plugin-opener';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { errorDetail } from '../core/error-text';
import { baseName, joinPath } from '../core/session/plan-flush';
import { defaultWorkspaceParent, folderNameError } from '../core/new-workspace';
import { pickUnusedColor } from '../core/settings';
import { pathKey } from '../core/tab-workspaces';
import {
  BUILTIN_MODULES,
  HARNESS_STUBS,
  initPlanPaths,
  installedModuleIds,
  RETIRED_MODULE_IDS,
  planWorkspaceInit,
  userModuleFrom,
  type WorkspaceModule,
} from '../core/workspace-modules';
import { IpcError, ipc } from '../ipc/commands';
import { pickDirectory } from '../ipc/dialog';
import { resolveAgentModulesDir, resolveAppAndDocumentsDirs } from '../ipc/paths';
import { getDefaultWorkspacePath } from './session';
import { settingsStore } from './stores/settings';
import { uiStore } from './stores/ui';

export interface WorkspaceInitState {
  open: boolean;
  /** The folder being initialized; null until one is picked. */
  root: string | null;
  /** True when opened on an existing workspace (the folder is fixed). */
  rerun: boolean;
  /**
   * True while the folder is still to be made: the dialog asks for `newName`
   * in `newParent`, and Create makes `newParent/newName` before writing.
   */
  creating: boolean;
  newName: string;
  newParent: string | null;
  modules: WorkspaceModule[];
  selected: string[];
  /** Module ids AGENTS.md in `root` already carries. */
  installed: string[];
  stubs: string[];
  modulesDir: string | null;
  busy: boolean;
  error: string | null;
}

const initial: WorkspaceInitState = {
  open: false,
  root: null,
  rerun: false,
  creating: false,
  newName: '',
  newParent: null,
  modules: [...BUILTIN_MODULES],
  selected: [],
  installed: [],
  stubs: HARNESS_STUBS.map((s) => s.path),
  modulesDir: null,
  busy: false,
  error: null,
};

export const workspaceInitStore = createStore<WorkspaceInitState>()(() => initial);

export const useWorkspaceInit = <T>(selector: (s: WorkspaceInitState) => T): T =>
  useStore(workspaceInitStore, selector);

const set = (patch: Partial<WorkspaceInitState>) => workspaceInitStore.setState(patch);

async function readOrNull(path: string): Promise<string | null> {
  try {
    return (await ipc.readTextFile(path)).text;
  } catch {
    return null;
  }
}

/** Built-ins plus every `.md` in the user's modules folder (created on first use). */
async function loadModules(): Promise<{ modules: WorkspaceModule[]; dir: string | null }> {
  const modules = [...BUILTIN_MODULES];
  try {
    const dir = await resolveAgentModulesDir();
    await ipc.createDir(dir).catch(() => {});
    for (const entry of await ipc.listDir(dir, true)) {
      if (entry.isDir || !/\.(md|markdown)$/i.test(entry.path)) {
        continue;
      }
      const text = await readOrNull(entry.path);
      const mod = text === null ? null : userModuleFrom(baseName(entry.path), text);
      if (mod && !modules.some((m) => m.id === mod.id)) {
        modules.push(mod);
      }
    }
    return { modules, dir };
  } catch {
    return { modules, dir: null };
  }
}

/** Point the dialog at a folder: tick what its AGENTS.md already has, else the recommended set. */
async function adoptRoot(root: string): Promise<void> {
  const agents = await readOrNull(joinPath(root, 'AGENTS.md'));
  const installed = agents === null ? [] : installedModuleIds(agents);
  const { modules } = workspaceInitStore.getState();
  set({
    root,
    installed,
    selected:
      installed.length > 0
        ? installed.filter((id) => modules.some((m) => m.id === id))
        : modules.filter((m) => m.recommended).map((m) => m.id),
  });
}

/** Show the dialog on `root` (null = no folder yet); `rerun` fixes the folder. */
async function showInit(root: string | null, rerun: boolean): Promise<void> {
  set({ ...initial, open: true, rerun, root });
  const { modules, dir } = await loadModules();
  set({
    modules,
    modulesDir: dir,
    selected: modules.filter((m) => m.recommended).map((m) => m.id),
  });
  if (root !== null) {
    await adoptRoot(root);
  }
}

export async function openWorkspaceInit(root?: string): Promise<void> {
  await showInit(root ?? null, root !== undefined);
}

/**
 * "Create new workspace" (the explorer's + menu): the dialog asks for a name,
 * with the location defaulting to beside the most recently added workspace —
 * no folder picker, since a new workspace almost always means a new folder.
 * "Use an existing folder" in the dialog is the way back to picking one.
 */
export async function createWorkspace(): Promise<void> {
  const { settings } = settingsStore.getState();
  const newParent = defaultWorkspaceParent({
    workspacePaths: settings.workspaces.map((w) => w.path),
    defaultWorkspacePath: getDefaultWorkspacePath(),
    ...(await resolveAppAndDocumentsDirs()),
  });
  await showInit(null, false);
  set({ creating: true, newParent });
}

export function setNewWorkspaceName(newName: string): void {
  set({ newName, error: null });
}

export async function pickNewWorkspaceParent(): Promise<void> {
  const { newParent } = workspaceInitStore.getState();
  const picked = await pickDirectory(newParent, 'Where should the new workspace folder go?');
  if (picked) {
    set({ newParent: picked, error: null });
  }
}

/** The folder Create will make, or null when the name or location is missing. */
export function newWorkspacePath(state: WorkspaceInitState): string | null {
  const name = state.newName.trim();
  return state.newParent && name ? joinPath(state.newParent, name) : null;
}

export function closeWorkspaceInit(): void {
  set({ open: false });
}

/** Pick an existing folder — also "Use an existing folder" out of create mode. */
export async function pickInitFolder(): Promise<void> {
  const picked = await pickDirectory(null, 'Choose or create the workspace folder');
  if (picked) {
    set({ creating: false, error: null });
    await adoptRoot(picked);
  }
}

/** Make the new workspace's folder; its path, or null with `error` set. */
async function makeNewFolder(state: WorkspaceInitState): Promise<string | null> {
  const nameError = folderNameError(state.newName.trim());
  const path = newWorkspacePath(state);
  if (nameError || !path) {
    set({ error: nameError ?? 'Choose where the workspace folder goes.' });
    return null;
  }
  try {
    await ipc.createDir(path);
  } catch (error) {
    set({
      error:
        error instanceof IpcError && error.code === 'EXISTS'
          ? `A folder named "${state.newName.trim()}" is already there — pick another name, or use it as an existing folder.`
          : errorDetail(error) || 'Could not create the folder.',
    });
    return null;
  }
  // From here the folder exists: a failed write below retries on it as-is.
  set({ creating: false, root: path });
  return path;
}

/** Show the user's directives folder in the OS file manager. */
export async function openModulesFolder(): Promise<void> {
  const dir = workspaceInitStore.getState().modulesDir;
  if (dir) {
    await openPath(dir).catch(() => {
      uiStore.getState().showNotice('Could not open the directives folder.');
    });
  }
}

export function toggleInitModule(id: string): void {
  const { selected } = workspaceInitStore.getState();
  set({ selected: selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id] });
}

export function toggleInitStub(path: string): void {
  const { stubs } = workspaceInitStore.getState();
  set({ stubs: stubs.includes(path) ? stubs.filter((s) => s !== path) : [...stubs, path] });
}

/** Add `root` to the explorer unless it (or the default workspace) already is one. */
function registerWorkspace(root: string): void {
  const { settings, update } = settingsStore.getState();
  const key = pathKey(root);
  const defaultPath = getDefaultWorkspacePath();
  const known =
    (defaultPath !== null && pathKey(defaultPath) === key) ||
    settings.workspaces.some((w) => pathKey(w.path) === key);
  if (!known) {
    const color = pickUnusedColor([
      settings.defaultWorkspaceColor,
      ...settings.workspaces.map((w) => w.color),
    ]);
    update({
      workspaces: [...settings.workspaces, { name: baseName(root) || root, path: root, color }],
    });
  }
  uiStore.getState().setSelectedExplorerDir(root);
}

export async function applyWorkspaceInit(): Promise<void> {
  const state = workspaceInitStore.getState();
  if (state.busy) {
    return;
  }
  const root = state.creating ? await makeNewFolder(state) : state.root;
  if (!root) {
    return;
  }
  set({ busy: true, error: null });
  try {
    // Selection order follows the checklist, not the order of clicks.
    const chosen = state.modules.filter((m) => state.selected.includes(m.id));
    const existing = new Map<string, string>();
    for (const rel of new Set(initPlanPaths(chosen))) {
      const text = await readOrNull(joinPath(root, rel));
      if (text !== null) {
        existing.set(rel, text);
      }
    }
    const writes = planWorkspaceInit({
      workspaceName: baseName(root) || 'Workspace',
      modules: chosen,
      knownIds: new Set([...state.modules.map((m) => m.id), ...RETIRED_MODULE_IDS]),
      stubs: state.stubs,
      existing,
    });
    for (const write of writes) {
      await ipc.atomicWriteText(joinPath(root, write.path), write.text);
    }

    registerWorkspace(root);
    uiStore.getState().refreshExplorer();
    uiStore
      .getState()
      .showNotice(
        writes.length === 0
          ? 'Workspace already up to date.'
          : `Workspace ready — ${writes.length} file${writes.length === 1 ? '' : 's'} written.`,
      );
    set({ open: false, busy: false });
  } catch (error) {
    set({ busy: false, error: errorDetail(error) || 'Could not write the workspace files.' });
  }
}
