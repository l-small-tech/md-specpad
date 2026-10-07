/**
 * The git tab's model — the types the store holds and the pure `core/git`
 * modules compute over. Pure declarations: no DOM, no Tauri, no React.
 *
 * Wire shapes (what the Rust commands return) are declared in
 * `src/ipc/commands.ts` and, where core needs them, re-declared here
 * structurally (rule: `core` imports nothing app-local, `ipc` imports nothing
 * app-local, so the two must match by shape, never by import). The ipc file
 * is the source of truth for field names; keep the two in step.
 */

/* ------------------------------ wire mirrors ------------------------------ */

/** `GitStatusEntry.kind` — which porcelain v2 record the entry came from. */
export type GitStatusEntryKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked';

/** One line of `git status --porcelain=v2` (mirrors ipc `GitStatusEntry`). */
export interface GitStatusEntry {
  /** Path relative to the checkout root, forward slashes. */
  path: string;
  /** For a rename or copy: the path it came from; null otherwise. */
  origPath: string | null;
  /** Index (staged) status letter; `.` means unchanged there. */
  index: string;
  /** Working-tree status letter; `.` means unchanged there. */
  worktree: string;
  kind: GitStatusEntryKind;
}

/** What operation, if any, the checkout is in the middle of. */
export type GitRepoState =
  'clean' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' | 'bisecting';

/** The whole `git status` answer for one checkout (mirrors ipc `GitStatus`). */
export interface GitStatus {
  /** HEAD's sha; `''` when the repository has no commits yet. */
  head: string;
  /** Short branch name; null on a detached HEAD. */
  branch: string | null;
  /** `origin/main`-style upstream, or null when the branch tracks nothing. */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  unborn: boolean;
  state: GitRepoState;
  /** `MERGE_HEAD`'s sha while `state === 'merging'`. */
  mergeHead: string | null;
  entries: GitStatusEntry[];
}

export interface GitBranch {
  /** Short name: `feat/x` for a local branch, `origin/feat/x` for a remote one. */
  name: string;
  kind: 'local' | 'remote';
  head: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** The upstream is configured but no longer exists on the remote. */
  gone: boolean;
  /** Committer date, ISO 8601. */
  committedAt: string;
}

export interface GitCommit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  /** Author date, ISO 8601. */
  at: string;
  subject: string;
  body: string;
  /**
   * `git log --format=%D` decorations, one per item: `HEAD -> development`,
   * `origin/development`, `tag: v0.10.1`, or `HEAD` (detached). Parsed by
   * `core/git/decorations.ts`.
   */
  refs: string[];
}

/** One file of a commit or a range diff (`--name-status`). */
export interface GitFileDelta {
  path: string;
  origPath: string | null;
  /** A M D R C T U — git's status letter. */
  status: string;
}

export interface GitWorktreeSummary {
  /** Absolute path, forward slashes. */
  path: string;
  /** Short branch name; null on a detached HEAD. */
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  /** The directory is gone (git would call it prunable). Counts are zero then. */
  missing: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  state: GitRepoState;
  /** Against the base branch; null when there is no base or no merge base. */
  ahead: number | null;
  behind: number | null;
}

export type GitMergeResult = 'merged' | 'fast-forward' | 'up-to-date' | 'conflicts';

export interface GitMergeOutcome {
  outcome: GitMergeResult;
  /** HEAD after the merge (unchanged on `conflicts`). */
  head: string;
  /** Paths still unmerged; empty unless `outcome === 'conflicts'`. */
  conflicted: string[];
}

export interface GitNetResult {
  ok: boolean;
  exitCode: number | null;
  stderr: string;
  /** `pull` only: how the merge half ended. */
  merge: GitMergeOutcome | null;
}

/* --------------------------------- model --------------------------------- */

/** One checkout of the repository as the panel's checkout picker lists it. */
export interface GitCheckout {
  /** Absolute path, forward slashes. */
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  /** The dashboard row's facts; null until `git_worktrees` has answered. */
  summary: GitWorktreeSummary | null;
}

/** Which of the four change groups a status row is shown in. */
export type StatusGroup = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

export interface StatusGroups {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  conflicted: GitStatusEntry[];
}

/**
 * Which two sides a file's diff compares. The four status groups each name
 * a pair (see `diffLabels`); `changed` is the flat change list's view —
 * HEAD against the working tree, everything since the last commit, however
 * much of it is staged.
 */
export type DiffGroup = StatusGroup | 'changed';

/** What the detail pane shows. */
export type SelectedItem =
  /** One changed file of the selected checkout, diffed as `group` says. */
  | { kind: 'file'; group: DiffGroup; path: string }
  /** A commit from the history list, optionally one of its files. */
  | { kind: 'commit'; sha: string; path?: string }
  /** A worktree's branch against the base branch: the file list. */
  | { kind: 'worktree-diff'; path: string }
  /** The finish-worktree stepper. */
  | { kind: 'finish' };

/** One streamed line of a fetch / pull / push. */
export interface GitOutputLine {
  stream: 'out' | 'err';
  text: string;
}

export type GitNetKind = 'fetch' | 'pull' | 'push';

/** Where a merge left conflicts and how far the agent has got with them. */
export interface ConflictTracker {
  /** The checkout the merge runs in. */
  root: string;
  /** Branch names as the prompt states them. */
  into: string;
  from: string;
  /** Paths git reported unmerged when the tracker was armed. */
  files: string[];
  /** Per tracked path: the last marker scan found no conflict markers. */
  markerFree: Record<string, boolean>;
  /** Per tracked path: conflict blocks the last scan counted (for the row badge). */
  markerCounts?: Record<string, number>;
}

/* ------------------------------ finish flow ------------------------------ */

export type FinishStepId =
  'merge-base-in' | 'verify' | 'merge-into-base' | 'remove-worktree' | 'delete-branch' | 'cleanup';

export type FinishStepStatus =
  | 'pending'
  | 'running'
  /** Waiting for the user (the verify step, or a confirm). */
  | 'paused'
  /** Waiting for the agent to clear a merge's conflicts. */
  | 'conflicts'
  | 'done'
  | 'failed'
  | 'skipped';

export interface FinishStep {
  id: FinishStepId;
  status: FinishStepStatus;
  /** git's message when `status === 'failed'`. */
  error: string | null;
}

/** Why the flow cannot start yet — shown as a list, each with a fix hint. */
export interface FinishBlocker {
  code:
    | 'main-not-on-base'
    | 'main-dirty'
    | 'worktree-dirty'
    | 'worktree-detached'
    | 'no-base'
    | 'worktree-is-main';
  message: string;
}

export interface FinishState {
  /** Absolute path of the worktree being finished. */
  worktree: string;
  /** Its branch, and the base it merges into. */
  branch: string;
  base: string;
  mainRoot: string;
  steps: FinishStep[];
  /** Index into `steps` of the step in progress, or `steps.length` when done. */
  current: number;
  /** True once the flow has ended (all done, aborted, or failed). */
  finished: boolean;
  aborted: boolean;
  /** Paths left unmerged by the current merge step, while it waits. */
  conflicts: string[] | null;
  /**
   * Preflight failures. Present (and non-empty) only on a flow that could
   * not start: `finished` is true, no step ran, and the stepper shows the
   * list with its fix hints instead.
   */
  blockers?: FinishBlocker[];
}
