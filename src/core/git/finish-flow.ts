/**
 * Finish worktree — the guided flow that lands a worktree's branch and
 * cleans up, as a pure state machine the store drives. Pure; no DOM, no
 * Tauri, no React.
 *
 * Steps, in order (`FINISH_STEPS`):
 *
 *   merge-base-in    merge the base branch INTO the worktree (the directive's
 *                    step 4: conflicts are met on the feature branch)
 *   verify           pause: the user builds / tests in the worktree, then Continue
 *   merge-into-base  merge the branch into the base, in the MAIN checkout
 *   cleanup          confirm, then close the terminals inside the worktree and
 *                    forget its workspace (Windows cannot delete a held dir)
 *   remove-worktree  `git worktree remove`
 *   delete-branch    `git branch -d`
 *
 * The store asks `nextAction(state)` what to do, does it, and feeds the
 * result back through `reduceFinish`. A merge that stops on conflicts parks
 * the step in `conflicts` until the tracker sees the merge committed
 * (`conflicts-cleared`). Nothing here talks to git.
 */

import type {
  FinishBlocker,
  FinishState,
  FinishStep,
  FinishStepId,
  GitRepoState,
  GitStatus,
  GitWorktreeSummary,
} from './types';

export const FINISH_STEPS: readonly FinishStepId[] = [
  'merge-base-in',
  'verify',
  'merge-into-base',
  'cleanup',
  'remove-worktree',
  'delete-branch',
];

/** Labels with the names filled in, for the stepper. */
export function finishStepLabel(id: FinishStepId, s: Pick<FinishState, 'branch' | 'base'>): string {
  switch (id) {
    case 'merge-base-in':
      return `Merge ${s.base} into ${s.branch}`;
    case 'verify':
      return 'Verify the merged branch';
    case 'merge-into-base':
      return `Merge ${s.branch} into ${s.base}`;
    case 'cleanup':
      return 'Close terminals and forget the workspace';
    case 'remove-worktree':
      return 'Remove the worktree';
    case 'delete-branch':
      return `Delete ${s.branch}`;
  }
}

/* ------------------------------- preflight ------------------------------- */

export interface FinishPreflightFacts {
  /** The worktree to finish, as the dashboard knows it. */
  worktree: Pick<
    GitWorktreeSummary,
    'isMain' | 'branch' | 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'state'
  >;
  /** The main checkout's branch and cleanliness. */
  main: { branch: string | null; clean: boolean; state: GitRepoState };
  /** The base branch, or null when none could be resolved. */
  base: string | null;
}

/** Why the flow cannot start, each with the fix in its message; empty = go. */
export function finishPreflight(facts: FinishPreflightFacts): FinishBlocker[] {
  const out: FinishBlocker[] = [];
  const { worktree, main, base } = facts;
  if (worktree.isMain) {
    out.push({ code: 'worktree-is-main', message: 'The main checkout cannot be finished' });
    return out;
  }
  if (base === null) {
    out.push({
      code: 'no-base',
      message: 'No base branch — set Review › base branch in Settings, or create main',
    });
  }
  if (worktree.branch === null) {
    out.push({
      code: 'worktree-detached',
      message: 'The worktree is on a detached HEAD — switch it to a branch first',
    });
  }
  const dirty =
    worktree.staged + worktree.unstaged + worktree.untracked + worktree.conflicted > 0 ||
    worktree.state !== 'clean';
  if (dirty) {
    out.push({
      code: 'worktree-dirty',
      message:
        worktree.state !== 'clean'
          ? `The worktree has a ${worktree.state} in progress — finish or abort it first`
          : 'The worktree has uncommitted changes — commit or discard them first',
    });
  }
  if (base !== null && main.branch !== base) {
    out.push({
      code: 'main-not-on-base',
      message: `The main checkout is on ${main.branch ?? 'a detached HEAD'}, not ${base} — switch it first`,
    });
  }
  if (!main.clean || main.state !== 'clean') {
    out.push({
      code: 'main-dirty',
      message:
        main.state !== 'clean'
          ? `The main checkout has a ${main.state} in progress — finish or abort it first`
          : 'The main checkout has uncommitted changes — commit or discard them first',
    });
  }
  return out;
}

export interface SyncPreflightFacts {
  /** The checkout to catch up, as the dashboard knows it. */
  worktree: Pick<GitWorktreeSummary, 'branch' | 'state'>;
  /** The base branch, or null when none could be resolved. */
  base: string | null;
}

/**
 * Why a one-click Sync (merge the base into the checkout) cannot run; empty =
 * go. Uncommitted work is NOT a blocker: git refuses a merge that would
 * clobber it and says so, and a merge that touches other files is fine.
 */
export function syncPreflight(facts: SyncPreflightFacts): FinishBlocker[] {
  const out: FinishBlocker[] = [];
  const { worktree, base } = facts;
  if (base === null) {
    out.push({
      code: 'no-base',
      message: 'No base branch — set Review › base branch in Settings, or create main',
    });
  }
  if (worktree.branch === null) {
    out.push({
      code: 'worktree-detached',
      message: 'The checkout is on a detached HEAD — switch it to a branch first',
    });
  } else if (base !== null && worktree.branch === base) {
    out.push({
      code: 'worktree-on-base',
      message: `The checkout is on ${base} already — there is nothing to sync`,
    });
  }
  if (worktree.state !== 'clean') {
    out.push({
      code: 'worktree-busy',
      message: `The checkout has a ${worktree.state} in progress — finish or abort it first`,
    });
  }
  return out;
}

/* -------------------------------- reducer -------------------------------- */

export function createFinishState(input: {
  worktree: string;
  branch: string;
  base: string;
  mainRoot: string;
  blockers?: FinishBlocker[];
}): FinishState {
  const blocked = (input.blockers?.length ?? 0) > 0;
  return {
    worktree: input.worktree,
    branch: input.branch,
    base: input.base,
    mainRoot: input.mainRoot,
    steps: FINISH_STEPS.map((id) => ({ id, status: 'pending', error: null })),
    current: 0,
    finished: blocked,
    aborted: false,
    conflicts: null,
    ...(blocked ? { blockers: input.blockers } : {}),
  };
}

export type FinishEvent =
  /** The store began the current step. */
  | { type: 'start' }
  | { type: 'step-done' }
  | { type: 'step-failed'; error: string }
  /** The current step waits for the user (verify, or a declined confirm). */
  | { type: 'paused' }
  /** The user pressed Continue on a paused step: run it again. */
  | { type: 'resume' }
  /** The merge stopped on conflicts. */
  | { type: 'conflicts'; files: string[] }
  /** The tracker saw the merge committed. */
  | { type: 'conflicts-cleared' }
  | { type: 'skip' }
  | { type: 'retry' }
  | { type: 'abort' };

function withStep(state: FinishState, patch: Partial<FinishStep>): FinishState {
  return {
    ...state,
    steps: state.steps.map((s, i) => (i === state.current ? { ...s, ...patch } : s)),
  };
}

function advance(state: FinishState): FinishState {
  const current = state.current + 1;
  return { ...state, current, conflicts: null, finished: current >= state.steps.length };
}

/** The current step, or undefined once the flow is past the last one. */
export function currentStep(state: FinishState): FinishStep | undefined {
  return state.steps[state.current];
}

/** Pure transition; an event that makes no sense for the current step is a no-op. */
export function reduceFinish(state: FinishState, event: FinishEvent): FinishState {
  if (event.type === 'abort') {
    if (state.finished) {
      return state;
    }
    const step = currentStep(state);
    const stopped =
      step && step.status !== 'done' ? withStep(state, { status: 'failed', error: null }) : state;
    return { ...stopped, finished: true, aborted: true, conflicts: null };
  }
  const step = currentStep(state);
  if (state.finished || !step) {
    return state;
  }
  switch (event.type) {
    case 'start':
      return step.status === 'pending'
        ? withStep(state, { status: 'running', error: null })
        : state;
    case 'step-done':
      return advance(withStep(state, { status: 'done', error: null }));
    case 'step-failed':
      return withStep({ ...state, conflicts: null }, { status: 'failed', error: event.error });
    case 'paused':
      return step.status === 'running' ? withStep(state, { status: 'paused' }) : state;
    case 'resume':
      return step.status === 'paused' ? withStep(state, { status: 'pending' }) : state;
    case 'conflicts':
      return withStep({ ...state, conflicts: event.files }, { status: 'conflicts', error: null });
    case 'conflicts-cleared':
      return step.status === 'conflicts'
        ? advance(withStep(state, { status: 'done', error: null }))
        : state;
    case 'skip':
      return step.status === 'paused' || step.status === 'failed'
        ? advance(withStep(state, { status: 'skipped', error: null }))
        : state;
    case 'retry':
      return step.status === 'failed'
        ? withStep({ ...state, conflicts: null }, { status: 'pending', error: null })
        : state;
  }
}

export type FinishAction =
  /** Run this step now. */
  | { kind: 'run'; step: FinishStepId }
  /** Nothing to do until the user or the tracker moves the step on. */
  | { kind: 'wait'; step: FinishStepId; status: 'running' | 'paused' | 'conflicts' }
  /** A failed step awaits Retry / Skip / Abort. */
  | { kind: 'stopped'; step: FinishStepId; error: string | null }
  /** The flow is over. */
  | { kind: 'done'; aborted: boolean };

/** What the store should do next. */
export function nextAction(state: FinishState): FinishAction {
  const step = currentStep(state);
  if (state.finished || !step) {
    return { kind: 'done', aborted: state.aborted };
  }
  switch (step.status) {
    case 'pending':
      return { kind: 'run', step: step.id };
    case 'running':
    case 'paused':
    case 'conflicts':
      return { kind: 'wait', step: step.id, status: step.status };
    case 'failed':
      return { kind: 'stopped', step: step.id, error: step.error };
    case 'done':
    case 'skipped':
      // Cannot happen after `advance`, but a hand-built state may say so.
      return { kind: 'done', aborted: state.aborted };
  }
}

/* -------------------------------- recovery ------------------------------- */

export interface FinishFacts {
  branch: string;
  base: string;
  /** The worktree directory still exists as a checkout. */
  worktreePresent: boolean;
  /** The branch still exists locally. */
  branchExists: boolean;
  /** The main checkout's status. */
  main: Pick<GitStatus, 'state' | 'branch'>;
  /** The branch's tip is contained in the base (merged); null when unknown. */
  merged: boolean | null;
}

export interface FinishRecovery {
  /** The step the repository's facts say comes next; null when nothing is left. */
  step: FinishStepId | null;
  message: string;
}

/**
 * Where a finish flow stands from the repository's facts alone — for a tab
 * restored after a restart or torn off mid-flow, which has no in-memory
 * state to resume. Describes; the user decides what to do.
 */
export function recoverFinishState(facts: FinishFacts): FinishRecovery {
  if (facts.main.state === 'merging') {
    return {
      step: 'merge-into-base',
      message: `A merge into ${facts.base} is in progress in the main checkout — resolve its conflicts and continue, or abort it`,
    };
  }
  if (!facts.worktreePresent) {
    return facts.branchExists
      ? {
          step: 'delete-branch',
          message: `The worktree is gone; ${facts.branch} still exists and can be deleted`,
        }
      : { step: null, message: `Finished: the worktree and ${facts.branch} are gone` };
  }
  if (facts.merged === true) {
    return {
      step: 'cleanup',
      message: `${facts.branch} is merged into ${facts.base}; the worktree can be removed`,
    };
  }
  return {
    step: 'merge-base-in',
    message: `${facts.branch} is not merged into ${facts.base} yet`,
  };
}
