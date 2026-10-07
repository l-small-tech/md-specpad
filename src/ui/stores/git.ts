/**
 * Git store — every decision the git tab makes lives here (rule I5: Rust only
 * runs git; policy is TypeScript's), computed with the pure `core/git`
 * modules and carried out through an injected `GitStoreDeps`, so the whole
 * store runs under Vitest against a scripted fake.
 *
 * Keyed by the repository's MAIN root (`pathKey(mainRoot)`): one entry per
 * repository, however many workspaces or tabs point at it. Within an entry,
 * `selectedCheckout` is the checkout (main or a linked worktree) whose
 * status, branches, log and changes the panel shows; worktree actions name
 * their checkout explicitly.
 *
 * Two rules every action keeps:
 * - Nothing here types into a terminal. `deps.openTerminalAt(cwd, harness)`
 *   opens a shell or the harness IN a directory and that is all; conflicts
 *   are handed to the user's agent by putting a prompt on the CLIPBOARD
 *   (`copyConflictPrompt`), never by driving a pty.
 * - A stale answer is dropped. Every async refresh carries a sequence number
 *   (the `code-review-git.ts` pattern); a response for an older request, or
 *   for a checkout no longer selected, is ignored.
 *
 * This file's CONTRACT (types + `installGitDeps`) is fixed; the
 * implementation is tested end to end against a scripted fake in
 * `__tests__/git.test.ts`. Reading the code, the shape is:
 *
 * - `refresh` → `gitRepoInfo` + `gitWorktrees` for the repository, then
 *   `gitStatus` / `gitBranches` / `gitLog` for the SELECTED checkout, each
 *   part behind its own sequence number and throttled to once a second per
 *   repository unless forced.
 * - Every mutation goes through `mutate`: the call, a recorded + noticed
 *   failure, then a forced targeted refresh — the watcher is belt and braces.
 * - A merge that stops on conflicts arms `conflictTracker` and switches the
 *   panel to that checkout; `scanMarkers` re-reads the unmerged files on
 *   every poke, and `reconcileTracker` retires the tracker when git no
 *   longer reports the merge (HEAD moved = committed, else aborted).
 * - The finish flow is `core/git/finish-flow.ts`'s machine: `runFinish`
 *   asks `nextAction`, runs one step (`runStep`), feeds the event back, and
 *   stops when a step waits for the user or the agent.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { ClipboardProvider } from '../../ipc/clipboard';
import type { Ipc } from '../../ipc/commands';
import { isGitUnavailable, type GitRepoInfo } from '../../ipc/commands';
import type { GitNetOp, GitNetRunner } from '../../ipc/git-ops';
import {
  buildCheckouts,
  checkoutKey,
  pickSelected,
  terminalsInside,
} from '../../core/git/checkouts';
import { continueGate, countConflictBlocks } from '../../core/git/conflicts';
import { eolOnlyDifference, isBinaryText, normalizeEol } from '../../core/git/diff-text';
import {
  createFinishState,
  currentStep,
  finishPreflight,
  nextAction,
  reduceFinish,
  type FinishEvent,
  type FinishPreflightFacts,
} from '../../core/git/finish-flow';
import { errorCode, gitFailureText, networkHint } from '../../core/git/hints';
import { conflictPrompt } from '../../core/git/prompts';
import { branchForWorktree, validateBranchName } from '../../core/git/refs';
import { emptyGroups, groupStatus, mergingInto } from '../../core/git/status';
import type {
  ConflictTracker,
  FinishState,
  FinishStepId,
  GitBranch,
  GitCheckout,
  GitCommit,
  GitFileDelta,
  GitMergeOutcome,
  GitNetKind,
  GitNetResult,
  GitOutputLine,
  GitStatus,
  GitStatusEntry,
  DiffGroup,
  SelectedItem,
  StatusGroups,
} from '../../core/git/types';
import {
  appendMissingLines,
  planNewWorktree,
  WORKTREES_IGNORE_LINE,
} from '../../core/git/worktree-plan';
import { joinPath } from '../../core/session/plan-flush';

/* ------------------------------ dependencies ----------------------------- */

/** The slice of `Ipc` the store calls — a test fake implements just these. */
export type GitIpc = Pick<
  Ipc,
  | 'gitRepoInfo'
  | 'gitShowFile'
  | 'gitStatus'
  | 'gitBranches'
  | 'gitLog'
  | 'gitCommitFiles'
  | 'gitDiffNames'
  | 'gitWorktrees'
  | 'gitCheckIgnore'
  | 'gitStage'
  | 'gitUnstage'
  | 'gitDiscard'
  | 'gitCommit'
  | 'gitSwitch'
  | 'gitCreateBranch'
  | 'gitDeleteBranch'
  | 'gitMerge'
  | 'gitMergeAbort'
  | 'gitWorktreeAdd'
  | 'gitWorktreeRemove'
  | 'gitTrustDirectory'
  | 'readTextFile'
  | 'atomicWriteText'
>;

/** A terminal tab as the worktree dashboard sees it (for "a shell is open here"). */
export interface GitTerminalTab {
  id: string;
  title: string;
  /** The shell's current directory (OSC 7), or null before the first report. */
  cwd: string | null;
}

export interface GitStoreDeps {
  ipc: GitIpc;
  /** fetch / pull / push, streamed (src/ipc/git-ops.ts). */
  net: GitNetRunner;
  now?: () => number;
  /** The `reviewBaseBranch` setting ('' = auto-detect). */
  baseBranchSetting: () => string;
  /** The explorer's active directory, to pick the checkout a tab opens on. */
  activeWorkspaceDir: () => string | null;
  /** This window's terminal tabs. */
  terminalTabs: () => GitTerminalTab[];
  /** Native confirm (session ctx). Resolves true to proceed. */
  confirm: (message: string, title: string) => Promise<boolean>;
  /** Status-bar notice. */
  notice: (message: string) => void;
  clipboard: () => ClipboardProvider;
  /**
   * Open a shell (`harness === false`) or the configured harness (`true`) as
   * a terminal tab whose cwd is `cwd`. Nothing is typed into it — by design
   * there is no third argument.
   */
  openTerminalAt: (cwd: string, harness: boolean) => void;
  /** Open a file as an ordinary file tab (a conflicted file, a changed file). */
  openFile: (absPath: string) => void;
  /** Save the tab holding `absPath` if it is dirty (before `git add`). */
  saveTabAt: (absPath: string) => Promise<void>;
  /** Add a folder as a workspace (a new worktree) / forget one (a removed worktree). */
  addWorkspace: (path: string) => void;
  removeWorkspace: (path: string) => void;
  /** Close tabs (terminals inside a worktree about to be removed). */
  closeTabs: (ids: string[]) => Promise<void>;
  /**
   * Re-arm the file watcher from current state. Awaited BEFORE
   * `gitWorktreeRemove` so the watcher's handle on the directory is gone
   * (Windows refuses to delete a watched directory).
   */
  refreshWatchedDirs: () => Promise<void>;
}

/* ---------------------------------- state --------------------------------- */

export interface GitDiffView {
  path: string;
  /** null = the file did not exist on that side (added / deleted). */
  leftText: string | null;
  rightText: string | null;
  leftLabel: string;
  rightLabel: string;
  binary: boolean;
  /** The two sides differ only in line endings. */
  eolOnly: boolean;
}

export interface GitOpState {
  kind: GitNetKind;
  /** Streamed output, oldest first, capped (the drawer shows the tail). */
  lines: GitOutputLine[];
  running: boolean;
  result: GitNetResult | null;
  /** A one-line reading of a failure's stderr (core/git/hints.ts), or null. */
  hint: string | null;
  /** Rejected outright (`GIT_BUSY`, `GIT_CANCELLED`, …): the error text. */
  error: string | null;
}

export type NewWorktreeTerminal = 'none' | 'shell' | 'harness';

export interface NewWorktreeDraft {
  open: boolean;
  slug: string;
  /** Branch prefix, e.g. `feat/`. */
  prefix: string;
  /** Start point: a local branch name; '' = the base branch. */
  base: string;
  openTerminal: NewWorktreeTerminal;
  /** Validation or git error to show under the field. */
  error: string | null;
  busy: boolean;
}

/** `untrusted`: git's `safe.directory` check refused the repository (`GIT_UNTRUSTED`). */
export type RepoUnavailable = 'no-git' | 'not-a-repo' | 'untrusted';

function unavailableKind(code: string | null): RepoUnavailable {
  return code === 'GIT_NOT_FOUND'
    ? 'no-git'
    : code === 'GIT_UNTRUSTED'
      ? 'untrusted'
      : 'not-a-repo';
}

export type RefreshPart = 'status' | 'branches' | 'log' | 'worktrees';

export interface RepoState {
  mainRoot: string;
  info: GitRepoInfo | null;
  checkouts: GitCheckout[];
  /** Absolute path of the checkout shown; `mainRoot` until the user picks. */
  selectedCheckout: string;
  status: GitStatus | null;
  /** `status.entries` grouped for the four change sections (core/git/status.ts `groupStatus`). */
  groups: StatusGroups;
  branches: GitBranch[];
  log: GitCommit[];
  logExhausted: boolean;
  /** sha → the commit's files, once fetched. */
  commitFiles: Record<string, GitFileDelta[]>;
  /** worktree path → its files vs the base branch, once fetched. */
  worktreeDiffs: Record<string, GitFileDelta[]>;
  selected: SelectedItem | null;
  diff: GitDiffView | null;
  diffLoading: boolean;
  commitDraft: string;
  amend: boolean;
  branchFilter: string;
  loading: Record<RefreshPart, boolean>;
  /** The last failed call, for the header's error line. */
  error: { code: string; message: string } | null;
  unavailable: RepoUnavailable | null;
  op: GitOpState | null;
  conflictTracker: ConflictTracker | null;
  finish: FinishState | null;
  newWorktree: NewWorktreeDraft;
}

export interface GitState {
  /** `pathKey(mainRoot)` → the repository's state. */
  repos: Record<string, RepoState>;

  /* lifecycle */
  /** Start tracking a repository (idempotent); `checkout` preselects a worktree. */
  ensureRepo: (mainRoot: string, checkout?: string | null) => void;
  /** The last git tab for this repository closed. */
  forget: (mainRoot: string) => void;
  /**
   * Answer a `GIT_UNTRUSTED` refusal for the repository holding `path`:
   * confirm, then add it to git's global `safe.directory`. A tracked repo in
   * the `untrusted` state is refreshed. Resolves true once trusted.
   */
  trustFolder: (path: string) => Promise<boolean>;
  /** Re-ask git; throttled per repository unless `force`. */
  refresh: (mainRoot: string, opts?: { force?: boolean; parts?: RefreshPart[] }) => Promise<void>;
  /** Watcher / focus entry points (main.tsx). */
  onRepoChanged: (roots: string[]) => void;
  onFocus: () => void;
  /** Checkout roots the watcher should cover (core/git/checkouts.ts `extraGitWatchDirs`). */
  watchRoots: () => { mainRoot: string; checkoutPaths: string[] }[];

  /* selection */
  selectCheckout: (mainRoot: string, path: string) => void;
  select: (mainRoot: string, item: SelectedItem | null) => void;
  loadMoreLog: (mainRoot: string) => Promise<void>;
  setBranchFilter: (mainRoot: string, text: string) => void;

  /* changes + commit (in the selected checkout) */
  stage: (mainRoot: string, paths: string[]) => Promise<void>;
  unstage: (mainRoot: string, paths: string[]) => Promise<void>;
  /** Confirms, then restores tracked paths and deletes untracked ones. */
  discard: (mainRoot: string, paths: string[]) => Promise<void>;
  setCommitDraft: (mainRoot: string, text: string) => void;
  toggleAmend: (mainRoot: string) => void;
  commit: (mainRoot: string) => Promise<void>;

  /* branches (in the selected checkout) */
  switchBranch: (mainRoot: string, branch: GitBranch) => Promise<void>;
  createBranch: (
    mainRoot: string,
    name: string,
    startPoint: string | null,
    switchTo: boolean,
  ) => Promise<void>;
  deleteBranch: (mainRoot: string, name: string, opts?: { force?: boolean }) => Promise<void>;
  /**
   * Merge `target` into the checkout at `root` (default: the selected one).
   * `into` names the branch the caller EXPECTS that checkout to be on ("merge
   * into development" from a worktree row); when the checkout is on another
   * branch the merge is refused with a notice instead of landing there.
   */
  merge: (
    mainRoot: string,
    target: string,
    opts?: { root?: string; into?: string },
  ) => Promise<void>;

  /* conflicts (of the checkout the tracker names, else the selected one) */
  abortMerge: (mainRoot: string) => Promise<void>;
  /** `commit --no-edit`; only enabled once the tracker says every file is clean and staged. */
  continueMerge: (mainRoot: string) => Promise<void>;
  markResolved: (mainRoot: string, path: string) => Promise<void>;
  /** Put the agent-ready conflict prompt on the clipboard. */
  copyConflictPrompt: (mainRoot: string) => Promise<void>;

  /* network (in the selected checkout) */
  fetch: (mainRoot: string, opts?: { remote?: string | null; prune?: boolean }) => Promise<void>;
  pull: (mainRoot: string) => Promise<void>;
  push: (
    mainRoot: string,
    opts?: { remote?: string | null; setUpstream?: boolean },
  ) => Promise<void>;
  cancelOp: (mainRoot: string) => void;
  dismissOp: (mainRoot: string) => void;

  /* worktrees */
  openNewWorktree: (mainRoot: string) => void;
  closeNewWorktree: (mainRoot: string) => void;
  setNewWorktreeField: (
    mainRoot: string,
    patch: Partial<Pick<NewWorktreeDraft, 'slug' | 'prefix' | 'base' | 'openTerminal'>>,
  ) => void;
  createWorktree: (mainRoot: string) => Promise<void>;
  removeWorktree: (mainRoot: string, path: string, opts?: { force?: boolean }) => Promise<void>;
  openWorktreeAsWorkspace: (mainRoot: string, path: string) => void;
  openTerminalIn: (mainRoot: string, path: string, harness: boolean) => void;

  /* finish-worktree flow (one per repository at a time) */
  startFinish: (mainRoot: string, worktreePath: string) => Promise<void>;
  continueFinish: (mainRoot: string) => Promise<void>;
  skipFinishStep: (mainRoot: string) => Promise<void>;
  retryFinishStep: (mainRoot: string) => Promise<void>;
  abortFinish: (mainRoot: string) => Promise<void>;
  dismissFinish: (mainRoot: string) => void;
}

/* ------------------------------- construction ----------------------------- */

/** Case-folded, forward-slashed key — the same rule `core/tab-workspaces.ts` uses. */
export function repoKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export const EMPTY_NEW_WORKTREE: NewWorktreeDraft = {
  open: false,
  slug: '',
  prefix: 'feat/',
  base: '',
  openTerminal: 'harness',
  error: null,
  busy: false,
};

export function emptyRepoState(mainRoot: string, checkout?: string | null): RepoState {
  return {
    mainRoot,
    info: null,
    checkouts: [],
    selectedCheckout: checkout ?? mainRoot,
    status: null,
    groups: { staged: [], unstaged: [], untracked: [], conflicted: [] },
    branches: [],
    log: [],
    logExhausted: false,
    commitFiles: {},
    worktreeDiffs: {},
    selected: null,
    diff: null,
    diffLoading: false,
    commitDraft: '',
    amend: false,
    branchFilter: '',
    loading: { status: false, branches: false, log: false, worktrees: false },
    error: null,
    unavailable: null,
    op: null,
    conflictTracker: null,
    finish: null,
    newWorktree: EMPTY_NEW_WORKTREE,
  };
}

/** A refresh within this window of the previous one is skipped unless forced. */
export const REFRESH_THROTTLE_MS = 1000;
/** Commits per `git log` page. */
export const LOG_PAGE = 50;
/** Streamed output lines kept per network op (the drawer shows the tail). */
/** The pause before the second `git worktree remove` when a just-closed shell still holds the directory. */
export const WORKTREE_REMOVE_RETRY_MS = 400;

export const OP_LINE_CAP = 500;

const ALL_PARTS: readonly RefreshPart[] = ['worktrees', 'status', 'branches', 'log'];

/** Per-repository bookkeeping that is not view state. */
interface RepoInternals {
  seq: { info: number; status: number; branches: number; log: number; diff: number; scan: number };
  lastRefresh: number;
  /** Mutations, network ops and finish steps in flight — watcher pokes wait. */
  inflight: number;
  /** The checkout was chosen (by the opener, the user, or the first load). */
  explicitCheckout: boolean;
  opToken: number;
  opCancel: (() => void) | null;
  finishRunning: boolean;
  /** HEAD of the tracker's checkout when it was armed — moved = merge committed. */
  trackerHead: string | null;
}

const newInternals = (): RepoInternals => ({
  seq: { info: 0, status: 0, branches: 0, log: 0, diff: 0, scan: 0 },
  lastRefresh: -Infinity,
  inflight: 0,
  explicitCheckout: false,
  opToken: 0,
  opCancel: null,
  finishRunning: false,
  trackerHead: null,
});

const sameCheckout = (a: string, b: string) => checkoutKey(a) === checkoutKey(b);

/** `worktrees/x` for a checkout under the main root, else the path itself. */
function relCheckout(mainRoot: string, path: string): string {
  const key = checkoutKey(path);
  const root = checkoutKey(mainRoot);
  return key.startsWith(`${root}/`) ? path.replace(/\\/g, '/').slice(root.length + 1) : path;
}

function mergeNotice(outcome: GitMergeOutcome, target: string): string {
  switch (outcome.outcome) {
    case 'merged':
      return `Merged ${target}`;
    case 'fast-forward':
      return `Fast-forwarded to ${target}`;
    case 'up-to-date':
      return `Already up to date with ${target}`;
    case 'conflicts':
      return `Merge of ${target} stopped on ${outcome.conflicted.length} conflicted ${
        outcome.conflicted.length === 1 ? 'file' : 'files'
      } — copy the conflict prompt for your agent`;
  }
}

/**
 * Build a store over `deps`. The app installs its real deps once at bootstrap
 * (`installGitDeps`, from ui code that may import the session facade, the
 * tabs store and the terminal opener — this module cannot without a cycle);
 * tests pass a fake directly.
 */
export function createGitStore(getDeps: () => GitStoreDeps) {
  const internals = new Map<string, RepoInternals>();

  return createStore<GitState>()((set, get) => {
    /* ------------------------------ plumbing ------------------------------ */

    const repo = (mainRoot: string): RepoState | undefined => get().repos[repoKey(mainRoot)];

    const it = (mainRoot: string): RepoInternals => {
      const key = repoKey(mainRoot);
      let found = internals.get(key);
      if (!found) {
        found = newInternals();
        internals.set(key, found);
      }
      return found;
    };

    const now = () => getDeps().now?.() ?? Date.now();

    /**
     * `git worktree remove`, tried twice. The terminals inside the directory
     * were closed a moment ago, but a pty's kill is fire-and-forget from the
     * pane's unmount, so on Windows the shell can still hold the directory
     * when git first tries; git says so ("being used by another process",
     * "Permission denied", "Directory not empty") and a second try a beat
     * later succeeds. Any other failure is reported at once.
     *
     * The command itself finishes what git leaves behind: when git has already
     * dropped the worktree's record but could not delete its folder (paths
     * beyond MAX_PATH under pnpm's node_modules, a directory still held for a
     * moment), it deletes the folder with a long-path-aware remove and its own
     * retries, so the second call here only ever sees a folder git no longer
     * lists — which it also recognises and deletes.
     */
    const removeWorktreeDir = async (mainRoot: string, path: string, force: boolean) => {
      try {
        await getDeps().ipc.gitWorktreeRemove(mainRoot, path, force);
      } catch (err) {
        const text = err instanceof Error ? err.message.toLowerCase() : '';
        const held =
          text.includes('being used by another process') ||
          text.includes('permission denied') ||
          text.includes('directory not empty');
        if (!held) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, WORKTREE_REMOVE_RETRY_MS));
        await getDeps().ipc.gitWorktreeRemove(mainRoot, path, force);
      }
    };

    const patch = (mainRoot: string, update: (repo: RepoState) => Partial<RepoState>) => {
      const key = repoKey(mainRoot);
      const current = get().repos[key];
      if (!current) {
        return;
      }
      set({ repos: { ...get().repos, [key]: { ...current, ...update(current) } } });
    };

    const setLoading = (mainRoot: string, part: RefreshPart, on: boolean) =>
      patch(mainRoot, (r) => ({ loading: { ...r.loading, [part]: on } }));

    /** Record a failed call and say so. */
    const fail = (mainRoot: string, err: unknown) => {
      const message = gitFailureText(err);
      patch(mainRoot, () => ({ error: { code: errorCode(err) ?? 'ERROR', message } }));
      getDeps().notice(message);
    };

    /**
     * Run a git mutation: failures are recorded and noticed, and whatever
     * happened the named parts are re-read. Resolves true on success.
     */
    const mutate = async (
      mainRoot: string,
      parts: readonly RefreshPart[],
      fn: () => Promise<void>,
    ): Promise<boolean> => {
      const state = it(mainRoot);
      state.inflight += 1;
      // A new action retires the previous failure's header line.
      patch(mainRoot, () => ({ error: null }));
      let ok = true;
      try {
        await fn();
      } catch (err) {
        ok = false;
        fail(mainRoot, err);
      } finally {
        state.inflight -= 1;
      }
      await get().refresh(mainRoot, { force: true, parts: [...parts] });
      return ok;
    };

    /** The branch a checkout is on, from live status when it is the shown one. */
    const checkoutBranch = (r: RepoState, path: string): string | null => {
      if (sameCheckout(path, r.selectedCheckout) && r.status) {
        return r.status.branch;
      }
      return r.checkouts.find((c) => sameCheckout(c.path, path))?.branch ?? null;
    };

    /* ------------------------------- loading ------------------------------ */

    const loadStatus = async (mainRoot: string, sel: string): Promise<void> => {
      const state = it(mainRoot);
      const seq = ++state.seq.status;
      setLoading(mainRoot, 'status', true);
      let status: GitStatus;
      try {
        status = await getDeps().ipc.gitStatus(sel);
      } catch (err) {
        if (seq !== state.seq.status) {
          return;
        }
        setLoading(mainRoot, 'status', false);
        fail(mainRoot, err);
        return;
      }
      const current = repo(mainRoot);
      if (seq !== state.seq.status || !current || !sameCheckout(current.selectedCheckout, sel)) {
        return;
      }
      const groups = groupStatus(status.entries);
      patch(mainRoot, (r) => ({ status, groups, loading: { ...r.loading, status: false } }));
      reconcileTracker(mainRoot, sel, status, groups);
    };

    const loadBranches = async (mainRoot: string, sel: string): Promise<void> => {
      const state = it(mainRoot);
      const seq = ++state.seq.branches;
      setLoading(mainRoot, 'branches', true);
      let branches: GitBranch[];
      try {
        branches = await getDeps().ipc.gitBranches(sel);
      } catch (err) {
        if (seq !== state.seq.branches) {
          return;
        }
        setLoading(mainRoot, 'branches', false);
        fail(mainRoot, err);
        return;
      }
      const current = repo(mainRoot);
      if (seq !== state.seq.branches || !current || !sameCheckout(current.selectedCheckout, sel)) {
        return;
      }
      patch(mainRoot, (r) => ({ branches, loading: { ...r.loading, branches: false } }));
    };

    const loadLog = async (mainRoot: string, sel: string, skip: number): Promise<void> => {
      const state = it(mainRoot);
      const seq = ++state.seq.log;
      setLoading(mainRoot, 'log', true);
      let rows: GitCommit[];
      try {
        rows = await getDeps().ipc.gitLog(sel, null, LOG_PAGE, skip, true);
      } catch (err) {
        if (seq !== state.seq.log) {
          return;
        }
        setLoading(mainRoot, 'log', false);
        fail(mainRoot, err);
        return;
      }
      const current = repo(mainRoot);
      if (seq !== state.seq.log || !current || !sameCheckout(current.selectedCheckout, sel)) {
        return;
      }
      patch(mainRoot, (r) => ({
        log: skip === 0 ? rows : [...r.log, ...rows],
        logExhausted: rows.length < LOG_PAGE,
        loading: { ...r.loading, log: false },
      }));
    };

    /** What a checkout switch clears: everything read from the previous one. */
    const clearedForCheckout = (): Partial<RepoState> => ({
      status: null,
      groups: emptyGroups(),
      branches: [],
      log: [],
      logExhausted: false,
      selected: null,
      diff: null,
      diffLoading: false,
      commitDraft: '',
      amend: false,
    });

    const refreshNow = async (mainRoot: string, parts: ReadonlySet<RefreshPart>): Promise<void> => {
      const state = it(mainRoot);
      const deps = getDeps();
      const base = deps.baseBranchSetting().trim();
      const baseArg = base === '' ? undefined : base;
      const before = repo(mainRoot);
      if (!before) {
        return;
      }

      if (parts.has('worktrees') || before.info === null) {
        const seq = ++state.seq.info;
        setLoading(mainRoot, 'worktrees', true);
        let info: GitRepoInfo;
        try {
          info = await deps.ipc.gitRepoInfo(mainRoot, baseArg);
        } catch (err) {
          if (seq !== state.seq.info || !repo(mainRoot)) {
            return;
          }
          if (isGitUnavailable(err)) {
            patch(mainRoot, (r) => ({
              unavailable: unavailableKind(errorCode(err)),
              loading: { ...r.loading, worktrees: false },
            }));
          } else {
            setLoading(mainRoot, 'worktrees', false);
            fail(mainRoot, err);
          }
          return;
        }
        if (seq !== state.seq.info || !repo(mainRoot)) {
          return;
        }
        let summaries: Awaited<ReturnType<GitIpc['gitWorktrees']>> | null = null;
        try {
          summaries = await deps.ipc.gitWorktrees(mainRoot, baseArg);
        } catch (err) {
          if (seq !== state.seq.info || !repo(mainRoot)) {
            return;
          }
          fail(mainRoot, err);
        }
        if (seq !== state.seq.info || !repo(mainRoot)) {
          return;
        }
        const checkouts = buildCheckouts(info, summaries);
        patch(mainRoot, (r) => {
          const selected = pickSelected(
            checkouts,
            state.explicitCheckout ? r.selectedCheckout : null,
            deps.activeWorkspaceDir(),
          );
          state.explicitCheckout = true;
          const moved = !sameCheckout(selected, r.selectedCheckout);
          return {
            info,
            checkouts,
            selectedCheckout: selected,
            unavailable: null,
            loading: { ...r.loading, worktrees: false },
            ...(moved ? clearedForCheckout() : {}),
          };
        });
      }

      const current = repo(mainRoot);
      if (!current || current.unavailable !== null) {
        return;
      }
      const sel = current.selectedCheckout;
      const jobs: Promise<void>[] = [];
      if (parts.has('status')) {
        jobs.push(loadStatus(mainRoot, sel));
      }
      if (parts.has('branches')) {
        jobs.push(loadBranches(mainRoot, sel));
      }
      if (parts.has('log')) {
        jobs.push(loadLog(mainRoot, sel, 0));
      }
      await Promise.all(jobs);
    };

    /* -------------------------------- diffs ------------------------------- */

    const readWorkingFile = async (root: string, rel: string): Promise<string | null> => {
      try {
        return (await getDeps().ipc.readTextFile(joinPath(root, rel))).text;
      } catch {
        return null;
      }
    };

    const showOrNull = async (root: string, rev: string, rel: string): Promise<string | null> => {
      try {
        return await getDeps().ipc.gitShowFile(root, rev, rel);
      } catch {
        return null;
      }
    };

    const entryFor = (
      groups: StatusGroups,
      group: DiffGroup,
      path: string,
    ): GitStatusEntry | null => {
      const lists =
        group === 'changed' ? [groups.staged, groups.unstaged, groups.untracked] : [groups[group]];
      for (const list of lists) {
        const hit = list.find((e) => e.path === path);
        if (hit) {
          return hit;
        }
      }
      return null;
    };

    const loadDiff = async (mainRoot: string, item: SelectedItem): Promise<void> => {
      const r = repo(mainRoot);
      if (!r) {
        return;
      }
      const state = it(mainRoot);
      const seq = ++state.seq.diff;
      const root = r.selectedCheckout;
      patch(mainRoot, () => ({ diff: null, diffLoading: true }));
      let path: string;
      let sides: Promise<[string | null, string | null]>;
      if (item.kind === 'file') {
        path = item.path;
        const origPath = entryFor(r.groups, item.group, item.path)?.origPath ?? item.path;
        switch (item.group) {
          case 'staged':
            sides = Promise.all([showOrNull(root, 'HEAD', origPath), showOrNull(root, ':0', path)]);
            break;
          case 'unstaged':
            sides = Promise.all([showOrNull(root, ':0', path), readWorkingFile(root, path)]);
            break;
          case 'untracked':
            sides = Promise.all([Promise.resolve(null), readWorkingFile(root, path)]);
            break;
          case 'conflicted':
            sides = Promise.all([showOrNull(root, 'HEAD', path), readWorkingFile(root, path)]);
            break;
          case 'changed':
            sides = Promise.all([showOrNull(root, 'HEAD', origPath), readWorkingFile(root, path)]);
            break;
        }
      } else if (item.kind === 'commit' && item.path !== undefined) {
        path = item.path;
        const origPath = r.commitFiles[item.sha]?.find((d) => d.path === path)?.origPath ?? path;
        sides = Promise.all([
          showOrNull(root, `${item.sha}^`, origPath),
          showOrNull(root, item.sha, path),
        ]);
      } else {
        patch(mainRoot, () => ({ diffLoading: false }));
        return;
      }
      const [left, right] = await sides;
      const current = repo(mainRoot);
      if (seq !== state.seq.diff || !current || current.selected !== item) {
        return;
      }
      const binary = isBinaryText(left) || isBinaryText(right);
      patch(mainRoot, () => ({
        diffLoading: false,
        diff: {
          path,
          leftText: left === null || binary ? left : normalizeEol(left),
          rightText: right === null || binary ? right : normalizeEol(right),
          leftLabel: '',
          rightLabel: '',
          binary,
          eolOnly: eolOnlyDifference(left, right),
        },
      }));
    };

    const loadCommitFiles = async (mainRoot: string, sha: string): Promise<void> => {
      const r = repo(mainRoot);
      if (!r || r.commitFiles[sha]) {
        return;
      }
      const root = r.selectedCheckout;
      let files: GitFileDelta[];
      try {
        files = await getDeps().ipc.gitCommitFiles(root, sha);
      } catch (err) {
        fail(mainRoot, err);
        return;
      }
      patch(mainRoot, (cur) => ({ commitFiles: { ...cur.commitFiles, [sha]: files } }));
    };

    const loadWorktreeDiff = async (mainRoot: string, path: string): Promise<void> => {
      const r = repo(mainRoot);
      if (!r || r.worktreeDiffs[path]) {
        return;
      }
      const base = r.info?.baseBranch ?? null;
      const branch = checkoutBranch(r, path);
      if (base === null || branch === null) {
        getDeps().notice(
          base === null
            ? 'No base branch to compare against'
            : 'That worktree is on a detached HEAD',
        );
        return;
      }
      let files: GitFileDelta[];
      try {
        files = await getDeps().ipc.gitDiffNames(path, base, branch);
      } catch (err) {
        fail(mainRoot, err);
        return;
      }
      patch(mainRoot, (cur) => ({ worktreeDiffs: { ...cur.worktreeDiffs, [path]: files } }));
    };

    /* ------------------------------ conflicts ----------------------------- */

    /** Start live-tracking a merge that stopped on conflicts; the panel shows its checkout. */
    const armTracker = (
      mainRoot: string,
      root: string,
      into: string,
      from: string,
      files: string[],
      head: string | null,
    ) => {
      const state = it(mainRoot);
      state.explicitCheckout = true;
      state.trackerHead = head;
      const tracker: ConflictTracker = {
        root,
        into,
        from,
        files,
        markerFree: {},
        markerCounts: {},
      };
      patch(mainRoot, (r) => ({
        conflictTracker: tracker,
        selectedCheckout: root,
        ...(sameCheckout(root, r.selectedCheckout) ? {} : clearedForCheckout()),
      }));
      void scanMarkers(mainRoot);
    };

    /** Re-read every tracked file and record whether markers remain. */
    const scanMarkers = async (mainRoot: string): Promise<void> => {
      const tracker = repo(mainRoot)?.conflictTracker;
      if (!tracker) {
        return;
      }
      const state = it(mainRoot);
      const seq = ++state.seq.scan;
      const counts = await Promise.all(
        tracker.files.map(async (f): Promise<[string, number]> => {
          const text = await readWorkingFile(tracker.root, f);
          // A file deleted as its resolution has no markers left.
          return [f, text === null ? 0 : countConflictBlocks(text)];
        }),
      );
      if (seq !== state.seq.scan) {
        return;
      }
      patch(mainRoot, (r) =>
        r.conflictTracker
          ? {
              conflictTracker: {
                ...r.conflictTracker,
                markerFree: Object.fromEntries(counts.map(([f, n]) => [f, n === 0])),
                markerCounts: Object.fromEntries(counts),
              },
            }
          : {},
      );
    };

    /**
     * Fresh status for the tracker's checkout: the merge is over when git no
     * longer reports it. HEAD moved = it was committed (the finish flow's
     * merge step is done); HEAD unchanged = it was aborted outside the app.
     */
    const reconcileTracker = (
      mainRoot: string,
      sel: string,
      status: GitStatus,
      groups: StatusGroups,
    ) => {
      const r = repo(mainRoot);
      const tracker = r?.conflictTracker;
      if (!r || !tracker || !sameCheckout(tracker.root, sel)) {
        return;
      }
      if (status.state === 'merging' || groups.conflicted.length > 0) {
        return;
      }
      const state = it(mainRoot);
      const committed = state.trackerHead === null || status.head !== state.trackerHead;
      state.trackerHead = null;
      patch(mainRoot, () => ({ conflictTracker: null }));
      const step = r.finish && !r.finish.finished ? currentStep(r.finish) : undefined;
      if (step?.status === 'conflicts') {
        dispatchFinish(
          mainRoot,
          committed
            ? { type: 'conflicts-cleared' }
            : { type: 'step-failed', error: 'The merge was aborted outside the app' },
        );
        if (committed) {
          void runFinish(mainRoot);
        }
      }
    };

    /* ----------------------------- network ops ---------------------------- */

    const startNet = async (
      mainRoot: string,
      kind: GitNetKind,
      options: { remote?: string | null; prune?: boolean; setUpstream?: boolean },
    ): Promise<void> => {
      const r = repo(mainRoot);
      if (!r) {
        return;
      }
      const deps = getDeps();
      const state = it(mainRoot);
      const token = ++state.opToken;
      const root = r.selectedCheckout;
      const mine = () => state.opToken === token && repo(mainRoot)?.op !== null;
      patch(mainRoot, () => ({
        op: { kind, lines: [], running: true, result: null, hint: null, error: null },
        error: null,
      }));
      state.inflight += 1;
      let op: GitNetOp;
      try {
        op = deps.net(kind, { root, ...options }, (line: GitOutputLine) => {
          if (!mine()) {
            return;
          }
          patch(mainRoot, (cur) => {
            if (!cur.op) {
              return {};
            }
            const lines = [...cur.op.lines, line];
            return {
              op: {
                ...cur.op,
                lines: lines.length > OP_LINE_CAP ? lines.slice(lines.length - OP_LINE_CAP) : lines,
              },
            };
          });
        });
      } catch (err) {
        state.inflight -= 1;
        patch(mainRoot, (cur) =>
          cur.op ? { op: { ...cur.op, running: false, error: gitFailureText(err) } } : {},
        );
        return;
      }
      state.opCancel = op.cancel;
      let result: GitNetResult | null = null;
      try {
        result = await op.done;
        if (mine()) {
          const done = result;
          patch(mainRoot, (cur) =>
            cur.op
              ? {
                  op: {
                    ...cur.op,
                    running: false,
                    result: done,
                    hint: done.ok ? null : networkHint(done.stderr),
                  },
                }
              : {},
          );
        }
      } catch (err) {
        if (mine()) {
          patch(mainRoot, (cur) =>
            cur.op ? { op: { ...cur.op, running: false, error: gitFailureText(err) } } : {},
          );
        }
      } finally {
        state.inflight -= 1;
        if (state.opCancel === op.cancel) {
          state.opCancel = null;
        }
      }
      if (result?.merge?.outcome === 'conflicts') {
        const cur = repo(mainRoot);
        armTracker(
          mainRoot,
          root,
          cur?.status?.branch ?? 'HEAD',
          cur?.status?.upstream ?? 'upstream',
          result.merge.conflicted,
          cur?.status?.head ?? null,
        );
      }
      await get().refresh(mainRoot, { force: true });
    };

    /* ------------------------------ finish flow --------------------------- */

    const dispatchFinish = (mainRoot: string, event: FinishEvent) =>
      patch(mainRoot, (r) => (r.finish ? { finish: reduceFinish(r.finish, event) } : {}));

    /** Do one step; the returned event is what happened. Throws = the step failed. */
    const runStep = async (mainRoot: string, step: FinishStepId): Promise<FinishEvent> => {
      const r = repo(mainRoot);
      const f = r?.finish;
      if (!r || !f) {
        return { type: 'abort' };
      }
      const deps = getDeps();
      switch (step) {
        case 'merge-base-in': {
          const outcome = await deps.ipc.gitMerge(f.worktree, f.base, false);
          if (outcome.outcome === 'conflicts') {
            const head = r.checkouts.find((c) => sameCheckout(c.path, f.worktree))?.head ?? null;
            armTracker(mainRoot, f.worktree, f.branch, f.base, outcome.conflicted, head);
            return { type: 'conflicts', files: outcome.conflicted };
          }
          return { type: 'step-done' };
        }
        case 'verify':
          return { type: 'paused' };
        case 'merge-into-base': {
          const outcome = await deps.ipc.gitMerge(f.mainRoot, f.branch, false);
          if (outcome.outcome === 'conflicts') {
            const head = r.checkouts.find((c) => c.isMain)?.head ?? null;
            armTracker(mainRoot, f.mainRoot, f.base, f.branch, outcome.conflicted, head);
            return { type: 'conflicts', files: outcome.conflicted };
          }
          return { type: 'step-done' };
        }
        case 'cleanup': {
          const terminals = terminalsInside(deps.terminalTabs(), f.worktree);
          const rel = relCheckout(f.mainRoot, f.worktree);
          const lines = [`${f.branch} is merged into ${f.base}. Remove the worktree ${rel}?`];
          if (terminals.length > 0) {
            lines.push(
              `${terminals.length} terminal ${terminals.length === 1 ? 'tab' : 'tabs'} inside it will be closed: ${terminals
                .map((t) => t.title)
                .join(', ')}`,
            );
          }
          lines.push('Its workspace entry will be removed from the explorer.');
          if (!(await deps.confirm(lines.join('\n\n'), 'Finish worktree'))) {
            return { type: 'paused' };
          }
          await deps.closeTabs(terminals.map((t) => t.id));
          deps.removeWorkspace(f.worktree);
          await deps.refreshWatchedDirs();
          return { type: 'step-done' };
        }
        case 'remove-worktree': {
          if (sameCheckout(r.selectedCheckout, f.worktree)) {
            it(mainRoot).explicitCheckout = true;
            patch(mainRoot, () => ({ selectedCheckout: f.mainRoot, ...clearedForCheckout() }));
          }
          await removeWorktreeDir(f.mainRoot, f.worktree, false);
          return { type: 'step-done' };
        }
        case 'delete-branch':
          await deps.ipc.gitDeleteBranch(f.mainRoot, f.branch, false);
          return { type: 'step-done' };
      }
    };

    /** Run steps until one waits, fails or the flow ends; re-entrant calls are no-ops. */
    const runFinish = async (mainRoot: string): Promise<void> => {
      const state = it(mainRoot);
      if (state.finishRunning) {
        return;
      }
      state.finishRunning = true;
      state.inflight += 1;
      try {
        for (;;) {
          const f = repo(mainRoot)?.finish;
          if (!f) {
            return;
          }
          const action = nextAction(f);
          if (action.kind !== 'run') {
            return;
          }
          dispatchFinish(mainRoot, { type: 'start' });
          try {
            dispatchFinish(mainRoot, await runStep(mainRoot, action.step));
          } catch (err) {
            const message = gitFailureText(err);
            dispatchFinish(mainRoot, { type: 'step-failed', error: message });
            getDeps().notice(message);
          }
        }
      } finally {
        state.finishRunning = false;
        state.inflight -= 1;
        await get().refresh(mainRoot, { force: true });
      }
    };

    /** After a merge commit landed (Continue merge, or a commit while merging). */
    const afterMergeCommitted = (mainRoot: string) => {
      const r = repo(mainRoot);
      it(mainRoot).trackerHead = null;
      patch(mainRoot, () => ({ conflictTracker: null }));
      const step = r?.finish && !r.finish.finished ? currentStep(r.finish) : undefined;
      if (step?.status === 'conflicts') {
        dispatchFinish(mainRoot, { type: 'conflicts-cleared' });
        void runFinish(mainRoot);
      }
    };

    /** A watcher / focus poke: re-read unless we are mid-action; keep the tracker honest. */
    const poke = async (mainRoot: string): Promise<void> => {
      const r = repo(mainRoot);
      const state = it(mainRoot);
      if (!r || state.inflight > 0) {
        return;
      }
      const tracking = r.conflictTracker !== null;
      await get().refresh(mainRoot, { force: tracking });
      if (repo(mainRoot)?.conflictTracker) {
        await scanMarkers(mainRoot);
      }
    };

    /* -------------------------------- actions ----------------------------- */

    return {
      repos: {},

      ensureRepo(mainRoot, checkout) {
        const key = repoKey(mainRoot);
        if (get().repos[key]) {
          return;
        }
        const state = it(mainRoot);
        state.explicitCheckout = checkout !== undefined && checkout !== null;
        set({ repos: { ...get().repos, [key]: emptyRepoState(mainRoot, checkout) } });
      },
      forget(mainRoot) {
        const key = repoKey(mainRoot);
        if (!get().repos[key]) {
          return;
        }
        internals.get(key)?.opCancel?.();
        internals.delete(key);
        const repos = { ...get().repos };
        delete repos[key];
        set({ repos });
      },
      async trustFolder(path) {
        const deps = getDeps();
        const ok = await deps.confirm(
          [
            'Git refuses to work in this repository because the folder is owned by another user account (common for folders created by an administrator, or on a FAT/exFAT or network drive).',
            path,
            'Trust it? This adds it to your global git config (safe.directory), so git in your terminal will trust it too. Only do this for repositories you know.',
          ].join('\n\n'),
          'Trust repository',
        );
        if (!ok) {
          return false;
        }
        try {
          await deps.ipc.gitTrustDirectory(path);
        } catch (err) {
          deps.notice(gitFailureText(err));
          return false;
        }
        // A tab already showing the "untrusted" panel for this repository
        // comes back to life.
        const r = repo(path);
        if (r?.unavailable === 'untrusted') {
          await get().refresh(r.mainRoot, { force: true });
        }
        return true;
      },
      async refresh(mainRoot, opts = {}) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const state = it(mainRoot);
        const t = now();
        if (!opts.force && t - state.lastRefresh < REFRESH_THROTTLE_MS) {
          return;
        }
        state.lastRefresh = t;
        await refreshNow(mainRoot, new Set(opts.parts ?? ALL_PARTS));
      },
      onRepoChanged(roots) {
        for (const r of Object.values(get().repos)) {
          const paths = [r.mainRoot, ...r.checkouts.map((c) => c.path)];
          const hit = roots.some((root) =>
            paths.some(
              (p) =>
                checkoutKey(p) === checkoutKey(root) ||
                checkoutKey(p).startsWith(`${checkoutKey(root)}/`) ||
                checkoutKey(root).startsWith(`${checkoutKey(p)}/`),
            ),
          );
          if (hit) {
            void poke(r.mainRoot);
          }
        }
      },
      onFocus() {
        for (const r of Object.values(get().repos)) {
          void poke(r.mainRoot);
        }
      },
      watchRoots() {
        return Object.values(get().repos).map((r) => ({
          mainRoot: r.mainRoot,
          checkoutPaths: r.checkouts.map((c) => c.path),
        }));
      },

      selectCheckout(mainRoot, path) {
        const r = repo(mainRoot);
        if (!r || sameCheckout(r.selectedCheckout, path)) {
          return;
        }
        it(mainRoot).explicitCheckout = true;
        patch(mainRoot, () => ({ selectedCheckout: path, ...clearedForCheckout() }));
        void get().refresh(mainRoot, { force: true, parts: ['status', 'branches', 'log'] });
      },
      select(mainRoot, item) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        it(mainRoot).seq.diff += 1;
        patch(mainRoot, () => ({ selected: item, diff: null, diffLoading: false }));
        if (item === null) {
          return;
        }
        switch (item.kind) {
          case 'file':
            void loadDiff(mainRoot, item);
            break;
          case 'commit':
            if (item.path === undefined) {
              void loadCommitFiles(mainRoot, item.sha);
            } else {
              void loadCommitFiles(mainRoot, item.sha).then(() => loadDiff(mainRoot, item));
            }
            break;
          case 'worktree-diff':
            void loadWorktreeDiff(mainRoot, item.path);
            break;
          case 'finish':
            break;
        }
      },
      async loadMoreLog(mainRoot) {
        const r = repo(mainRoot);
        if (!r || r.logExhausted || r.loading.log) {
          return;
        }
        await loadLog(mainRoot, r.selectedCheckout, r.log.length);
      },
      setBranchFilter(mainRoot, text) {
        patch(mainRoot, () => ({ branchFilter: text }));
      },

      async stage(mainRoot, paths) {
        const r = repo(mainRoot);
        if (!r || paths.length === 0) {
          return;
        }
        const root = r.selectedCheckout;
        await mutate(mainRoot, ['status'], () => getDeps().ipc.gitStage(root, paths));
      },
      async unstage(mainRoot, paths) {
        const r = repo(mainRoot);
        if (!r || paths.length === 0) {
          return;
        }
        const root = r.selectedCheckout;
        await mutate(mainRoot, ['status'], () => getDeps().ipc.gitUnstage(root, paths));
      },
      async discard(mainRoot, paths) {
        const r = repo(mainRoot);
        if (!r || paths.length === 0) {
          return;
        }
        const untrackedSet = new Set(r.groups.untracked.map((e) => e.path));
        const tracked = paths.filter((p) => !untrackedSet.has(p));
        const untracked = paths.filter((p) => untrackedSet.has(p));
        const lines = [
          paths.length === 1
            ? `Discard changes to ${paths[0]}?`
            : `Discard changes to ${paths.length} files?`,
        ];
        if (untracked.length > 0) {
          lines.push(
            `${untracked.length} untracked ${untracked.length === 1 ? 'file' : 'files'} will be deleted.`,
          );
        }
        lines.push('This cannot be undone.');
        if (!(await getDeps().confirm(lines.join('\n\n'), 'Discard changes'))) {
          return;
        }
        const root = r.selectedCheckout;
        await mutate(mainRoot, ['status'], () =>
          getDeps().ipc.gitDiscard(root, tracked, untracked),
        );
      },
      setCommitDraft(mainRoot, text) {
        patch(mainRoot, () => ({ commitDraft: text }));
      },
      toggleAmend(mainRoot) {
        patch(mainRoot, (r) => ({ amend: !r.amend }));
      },
      async commit(mainRoot) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const merging = r.status?.state === 'merging';
        if (merging && r.groups.conflicted.length > 0) {
          getDeps().notice('Resolve the conflicts first');
          return;
        }
        let message: string | null;
        if (r.commitDraft.trim() !== '') {
          message = r.commitDraft;
        } else if (merging || r.amend) {
          message = null;
        } else {
          getDeps().notice('Enter a commit message');
          return;
        }
        const root = r.selectedCheckout;
        const amend = r.amend;
        const ok = await mutate(mainRoot, ['status', 'log', 'worktrees'], async () => {
          await getDeps().ipc.gitCommit(root, message, amend);
          patch(mainRoot, () => ({ commitDraft: '', amend: false }));
          if (merging) {
            afterMergeCommitted(mainRoot);
          }
        });
        if (ok) {
          getDeps().notice(amend ? 'Commit amended' : 'Committed');
        }
      },

      async switchBranch(mainRoot, branch) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const root = r.selectedCheckout;
        await mutate(mainRoot, ALL_PARTS, async () => {
          if (branch.kind === 'remote') {
            const slash = branch.name.indexOf('/');
            const remote = branch.name.slice(0, slash);
            const local = branch.name.slice(slash + 1);
            await getDeps().ipc.gitSwitch(root, local, remote);
          } else {
            await getDeps().ipc.gitSwitch(root, branch.name, null);
          }
        });
      },
      async createBranch(mainRoot, name, startPoint, switchTo) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const invalid = validateBranchName(name);
        if (invalid) {
          getDeps().notice(invalid);
          return;
        }
        const root = r.selectedCheckout;
        await mutate(mainRoot, ['branches', 'status', 'log'], () =>
          getDeps().ipc.gitCreateBranch(root, name, startPoint, switchTo),
        );
      },
      async deleteBranch(mainRoot, name, opts = {}) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const held = branchForWorktree(r.checkouts, name);
        if (held) {
          getDeps().notice(
            held.isMain
              ? `${name} is checked out in the main checkout — switch it to another branch first`
              : `${name} is checked out in ${relCheckout(mainRoot, held.path)} — remove that worktree first`,
          );
          return;
        }
        const root = r.selectedCheckout;
        await mutate(mainRoot, ['branches'], () =>
          getDeps().ipc.gitDeleteBranch(root, name, opts.force ?? false),
        );
      },
      async merge(mainRoot, target, opts = {}) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const root = opts.root ?? r.selectedCheckout;
        if (opts.into !== undefined) {
          const actual = checkoutBranch(r, root);
          if (actual !== opts.into) {
            getDeps().notice(
              actual === null
                ? `Cannot merge into ${opts.into}: that checkout has a detached HEAD`
                : `Cannot merge into ${opts.into}: that checkout is on ${actual} — switch it first`,
            );
            return;
          }
        }
        await mutate(mainRoot, ALL_PARTS, async () => {
          const outcome = await getDeps().ipc.gitMerge(root, target, false);
          if (outcome.outcome === 'conflicts') {
            const head =
              sameCheckout(root, r.selectedCheckout) && r.status
                ? r.status.head
                : (r.checkouts.find((c) => sameCheckout(c.path, root))?.head ?? null);
            armTracker(
              mainRoot,
              root,
              checkoutBranch(r, root) ?? 'HEAD',
              target,
              outcome.conflicted,
              head,
            );
          }
          getDeps().notice(mergeNotice(outcome, target));
        });
      },

      async abortMerge(mainRoot) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const root = r.conflictTracker?.root ?? r.selectedCheckout;
        const ok = await mutate(mainRoot, ALL_PARTS, async () => {
          await getDeps().ipc.gitMergeAbort(root);
          it(mainRoot).trackerHead = null;
          patch(mainRoot, () => ({ conflictTracker: null }));
          const step = r.finish && !r.finish.finished ? currentStep(r.finish) : undefined;
          if (step?.status === 'conflicts') {
            dispatchFinish(mainRoot, { type: 'step-failed', error: 'Merge aborted' });
          }
        });
        if (ok) {
          getDeps().notice('Merge aborted');
        }
      },
      async continueMerge(mainRoot) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const root = r.conflictTracker?.root ?? r.selectedCheckout;
        // Decide on fresh facts, whatever checkout the panel happens to show.
        let unmerged: number;
        try {
          const status = await getDeps().ipc.gitStatus(root);
          unmerged = groupStatus(status.entries).conflicted.length;
        } catch (err) {
          fail(mainRoot, err);
          return;
        }
        await scanMarkers(mainRoot);
        const gate = continueGate(unmerged, repo(mainRoot)?.conflictTracker ?? null);
        if (!gate.enabled) {
          getDeps().notice(`Cannot continue the merge: ${gate.reason}`);
          return;
        }
        const ok = await mutate(mainRoot, ALL_PARTS, async () => {
          await getDeps().ipc.gitCommit(root, null, false);
          afterMergeCommitted(mainRoot);
        });
        if (ok) {
          getDeps().notice('Merge committed');
        }
      },
      async markResolved(mainRoot, path) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const root = r.conflictTracker?.root ?? r.selectedCheckout;
        await getDeps().saveTabAt(joinPath(root, path));
        await mutate(mainRoot, ['status'], () => getDeps().ipc.gitStage(root, [path]));
        await scanMarkers(mainRoot);
      },
      async copyConflictPrompt(mainRoot) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        const deps = getDeps();
        let tracker = r.conflictTracker;
        if (!tracker) {
          // A merge that began outside the app (or before a restart): adopt it.
          const names = mergingInto(r.status, r.branches);
          const files = r.groups.conflicted.map((e) => e.path);
          if (!names || files.length === 0) {
            deps.notice('No merge conflicts to resolve');
            return;
          }
          armTracker(
            mainRoot,
            r.selectedCheckout,
            names.into,
            names.from,
            files,
            r.status?.head ?? null,
          );
          tracker = repo(mainRoot)?.conflictTracker ?? null;
          if (!tracker) {
            return;
          }
        }
        const text = conflictPrompt({
          mainRoot,
          checkoutPath: tracker.root,
          into: tracker.into,
          from: tracker.from,
          files: tracker.files,
        });
        try {
          await deps.clipboard().write(text);
          deps.notice('Conflict prompt copied — paste it into your AI agent');
        } catch {
          deps.notice('Could not copy the conflict prompt');
        }
      },

      fetch: (mainRoot, opts = {}) =>
        startNet(mainRoot, 'fetch', { remote: opts.remote ?? null, prune: opts.prune ?? false }),
      pull: (mainRoot) => startNet(mainRoot, 'pull', {}),
      push: (mainRoot, opts = {}) =>
        startNet(mainRoot, 'push', {
          remote: opts.remote ?? null,
          setUpstream: opts.setUpstream ?? false,
        }),
      cancelOp(mainRoot) {
        it(mainRoot).opCancel?.();
      },
      dismissOp(mainRoot) {
        const r = repo(mainRoot);
        if (r?.op?.running) {
          return;
        }
        patch(mainRoot, () => ({ op: null }));
      },

      openNewWorktree(mainRoot) {
        patch(mainRoot, (r) => ({ newWorktree: { ...r.newWorktree, open: true, error: null } }));
      },
      closeNewWorktree(mainRoot) {
        patch(mainRoot, () => ({ newWorktree: EMPTY_NEW_WORKTREE }));
      },
      setNewWorktreeField(mainRoot, fields) {
        patch(mainRoot, (r) => ({ newWorktree: { ...r.newWorktree, ...fields, error: null } }));
      },
      async createWorktree(mainRoot) {
        const r = repo(mainRoot);
        if (!r || r.newWorktree.busy) {
          return;
        }
        const draft = r.newWorktree;
        const planned = planNewWorktree({
          mainRoot,
          slug: draft.slug,
          prefix: draft.prefix,
          base: draft.base !== '' ? draft.base : (r.info?.baseBranch ?? ''),
          openTerminal: draft.openTerminal,
        });
        if (!planned.ok) {
          patch(mainRoot, (cur) => ({ newWorktree: { ...cur.newWorktree, error: planned.error } }));
          return;
        }
        const { plan } = planned;
        const deps = getDeps();
        const state = it(mainRoot);
        patch(mainRoot, (cur) => ({
          newWorktree: { ...cur.newWorktree, busy: true, error: null },
        }));
        state.inflight += 1;
        try {
          const ignored = await deps.ipc.gitCheckIgnore(mainRoot, WORKTREES_IGNORE_LINE);
          if (!ignored) {
            const ignorePath = joinPath(mainRoot, '.gitignore');
            let existing = '';
            try {
              existing = (await deps.ipc.readTextFile(ignorePath)).text;
            } catch {
              existing = '';
            }
            const next = appendMissingLines(existing, [plan.gitignoreLine]);
            if (next !== null) {
              await deps.ipc.atomicWriteText(ignorePath, next);
            }
          }
          await deps.ipc.gitWorktreeAdd(mainRoot, plan.path, plan.branch, plan.startPoint, true);
          deps.addWorkspace(plan.path);
          if (plan.terminal !== 'none') {
            deps.openTerminalAt(plan.path, plan.terminal === 'harness');
          }
          state.explicitCheckout = true;
          patch(mainRoot, (cur) => ({
            newWorktree: EMPTY_NEW_WORKTREE,
            selectedCheckout: plan.path,
            ...(sameCheckout(plan.path, cur.selectedCheckout) ? {} : clearedForCheckout()),
          }));
          deps.notice(`Created ${plan.rel} on ${plan.branch}`);
        } catch (err) {
          const message = gitFailureText(err);
          patch(mainRoot, (cur) => ({
            newWorktree: { ...cur.newWorktree, busy: false, error: message },
            error: { code: errorCode(err) ?? 'ERROR', message },
          }));
        } finally {
          state.inflight -= 1;
        }
        await get().refresh(mainRoot, { force: true });
      },
      async removeWorktree(mainRoot, path, opts = {}) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        if (sameCheckout(path, mainRoot)) {
          getDeps().notice('The main checkout cannot be removed');
          return;
        }
        const deps = getDeps();
        const force = opts.force ?? false;
        const terminals = terminalsInside(deps.terminalTabs(), path);
        const rel = relCheckout(mainRoot, path);
        const lines = [`Remove the worktree ${rel}?`];
        if (terminals.length > 0) {
          lines.push(
            `${terminals.length} terminal ${terminals.length === 1 ? 'tab' : 'tabs'} inside it will be closed: ${terminals
              .map((t) => t.title)
              .join(', ')}`,
          );
        }
        if (force) {
          lines.push('Uncommitted changes in it will be lost.');
        }
        lines.push(
          'Its workspace entry will be removed from the explorer. A junctioned or symlinked node_modules inside it is followed by the removal — check first.',
        );
        if (!(await deps.confirm(lines.join('\n\n'), 'Remove worktree'))) {
          return;
        }
        const state = it(mainRoot);
        state.inflight += 1;
        try {
          await deps.closeTabs(terminals.map((t) => t.id));
          deps.removeWorkspace(path);
          await deps.refreshWatchedDirs();
          if (sameCheckout(repo(mainRoot)?.selectedCheckout ?? '', path)) {
            state.explicitCheckout = true;
            patch(mainRoot, () => ({ selectedCheckout: mainRoot, ...clearedForCheckout() }));
          }
          await removeWorktreeDir(mainRoot, path, force);
          deps.notice(`Removed ${rel}`);
        } catch (err) {
          fail(mainRoot, err);
        } finally {
          state.inflight -= 1;
        }
        await get().refresh(mainRoot, { force: true });
      },
      openWorktreeAsWorkspace(mainRoot, path) {
        if (repo(mainRoot)) {
          getDeps().addWorkspace(path);
        }
      },
      openTerminalIn(mainRoot, path, harness) {
        if (repo(mainRoot)) {
          getDeps().openTerminalAt(path, harness);
        }
      },

      async startFinish(mainRoot, worktreePath) {
        const r = repo(mainRoot);
        if (!r) {
          return;
        }
        if (r.finish && !r.finish.finished) {
          getDeps().notice('A finish flow is already running for this repository');
          return;
        }
        await get().refresh(mainRoot, { force: true, parts: ['worktrees'] });
        const cur = repo(mainRoot);
        if (!cur?.info) {
          return;
        }
        const checkout = cur.checkouts.find((c) => sameCheckout(c.path, worktreePath));
        if (!checkout) {
          getDeps().notice('That worktree is no longer listed');
          return;
        }
        const main = cur.checkouts.find((c) => c.isMain);
        const base = cur.info.baseBranch;
        const w = checkout.summary;
        const m = main?.summary;
        const facts: FinishPreflightFacts = {
          worktree: w ?? {
            isMain: checkout.isMain,
            branch: checkout.branch,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            state: 'clean',
          },
          main: {
            branch: m?.branch ?? main?.branch ?? null,
            clean: m ? m.staged + m.unstaged + m.untracked + m.conflicted === 0 : true,
            state: m?.state ?? 'clean',
          },
          base,
        };
        const blockers = finishPreflight(facts);
        const finish: FinishState = createFinishState({
          worktree: checkout.path,
          branch: checkout.branch ?? '',
          base: base ?? '',
          mainRoot,
          blockers,
        });
        patch(mainRoot, () => ({ finish, selected: { kind: 'finish' } }));
        if (blockers.length === 0) {
          await runFinish(mainRoot);
        }
      },
      async continueFinish(mainRoot) {
        const f = repo(mainRoot)?.finish;
        const step = f && !f.finished ? currentStep(f) : undefined;
        if (!step || step.status !== 'paused') {
          return;
        }
        dispatchFinish(mainRoot, step.id === 'verify' ? { type: 'step-done' } : { type: 'resume' });
        await runFinish(mainRoot);
      },
      async skipFinishStep(mainRoot) {
        const f = repo(mainRoot)?.finish;
        const step = f && !f.finished ? currentStep(f) : undefined;
        if (!step) {
          return;
        }
        if (step.status === 'conflicts') {
          getDeps().notice('Resolve the conflicts and continue the merge, or abort it');
          return;
        }
        dispatchFinish(mainRoot, { type: 'skip' });
        await runFinish(mainRoot);
      },
      async retryFinishStep(mainRoot) {
        const f = repo(mainRoot)?.finish;
        if (!f || f.finished) {
          return;
        }
        dispatchFinish(mainRoot, { type: 'retry' });
        await runFinish(mainRoot);
      },
      async abortFinish(mainRoot) {
        const r = repo(mainRoot);
        const f = r?.finish;
        if (!r || !f || f.finished) {
          return;
        }
        const step = currentStep(f);
        if (step?.status === 'conflicts' && r.conflictTracker) {
          const root = r.conflictTracker.root;
          await mutate(mainRoot, [], async () => {
            await getDeps().ipc.gitMergeAbort(root);
          });
          it(mainRoot).trackerHead = null;
          patch(mainRoot, () => ({ conflictTracker: null }));
        }
        dispatchFinish(mainRoot, { type: 'abort' });
        await get().refresh(mainRoot, { force: true });
      },
      dismissFinish(mainRoot) {
        const f = repo(mainRoot)?.finish;
        if (!f || !f.finished) {
          return;
        }
        patch(mainRoot, (r) => ({
          finish: null,
          selected: r.selected?.kind === 'finish' ? null : r.selected,
        }));
      },
    };
  });
}

/* -------------------------------- singleton ------------------------------- */

let installedDeps: GitStoreDeps | null = null;

/**
 * Wire the app's real dependencies. Called once at bootstrap by ui code
 * (`src/ui/git-deps.ts`); an action reached before that is a startup-order
 * bug and says so.
 */
export function installGitDeps(deps: GitStoreDeps): void {
  installedDeps = deps;
}

function requireDeps(): GitStoreDeps {
  if (!installedDeps) {
    throw new Error('git store used before installGitDeps()');
  }
  return installedDeps;
}

export const gitStore = createGitStore(requireDeps);

export const useGitStore = <T>(selector: (s: GitState) => T): T => useStore(gitStore, selector);
