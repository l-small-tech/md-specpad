import { describe, expect, test } from 'vitest';
import {
  createFinishState,
  currentStep,
  FINISH_STEPS,
  finishPreflight,
  finishStepLabel,
  nextAction,
  recoverFinishState,
  reduceFinish,
  syncPreflight,
  type FinishPreflightFacts,
} from '../finish-flow';
import type { FinishState } from '../types';

const cleanWorktree: FinishPreflightFacts['worktree'] = {
  isMain: false,
  branch: 'feat/x',
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  state: 'clean',
};
const cleanMain: FinishPreflightFacts['main'] = {
  branch: 'development',
  clean: true,
  state: 'clean',
};

describe('finishPreflight', () => {
  test('nothing blocks a clean worktree on a branch with main on the base', () => {
    expect(
      finishPreflight({ worktree: cleanWorktree, main: cleanMain, base: 'development' }),
    ).toEqual([]);
  });

  test('every blocker, with its fix', () => {
    const blockers = finishPreflight({
      worktree: { ...cleanWorktree, branch: null, untracked: 1 },
      main: { branch: 'feat/other', clean: false, state: 'clean' },
      base: 'development',
    });
    expect(blockers.map((b) => b.code)).toEqual([
      'worktree-detached',
      'worktree-dirty',
      'main-not-on-base',
      'main-dirty',
    ]);
    expect(blockers[2]!.message).toBe(
      'The main checkout is on feat/other, not development — switch it first',
    );
    expect(
      finishPreflight({ worktree: cleanWorktree, main: cleanMain, base: null })[0],
    ).toMatchObject({ code: 'no-base' });
    expect(
      finishPreflight({
        worktree: { ...cleanWorktree, state: 'rebasing' },
        main: { ...cleanMain, state: 'merging' },
        base: 'development',
      }).map((b) => b.message),
    ).toEqual([
      'The worktree has a rebasing in progress — finish or abort it first',
      'The main checkout has a merging in progress — finish or abort it first',
    ]);
  });

  test('the main checkout alone is a blocker', () => {
    expect(
      finishPreflight({ worktree: { ...cleanWorktree, isMain: true }, main: cleanMain, base: 'x' }),
    ).toEqual([{ code: 'worktree-is-main', message: 'The main checkout cannot be finished' }]);
  });
});

const fresh = () =>
  createFinishState({
    worktree: 'C:/repo/worktrees/x',
    branch: 'feat/x',
    base: 'development',
    mainRoot: 'C:/repo',
  });

/** Drive the machine through the store's loop: run → event, until it waits. */
function drive(state: FinishState, events: Parameters<typeof reduceFinish>[1][]): FinishState {
  let s = state;
  for (const e of events) {
    s = reduceFinish(s, e);
  }
  return s;
}

describe('syncPreflight', () => {
  test('a branch off the base may sync, dirty or not', () => {
    expect(syncPreflight({ worktree: { branch: 'feat/x', state: 'clean' }, base: 'main' })).toEqual(
      [],
    );
  });

  test('no base, detached, on the base, or an operation in progress block it', () => {
    expect(
      syncPreflight({ worktree: { branch: 'feat/x', state: 'clean' }, base: null })[0],
    ).toMatchObject({ code: 'no-base' });
    expect(
      syncPreflight({ worktree: { branch: null, state: 'clean' }, base: 'main' }).map(
        (b) => b.code,
      ),
    ).toEqual(['worktree-detached']);
    expect(
      syncPreflight({ worktree: { branch: 'main', state: 'clean' }, base: 'main' })[0]?.message,
    ).toBe('The checkout is on main already — there is nothing to sync');
    expect(
      syncPreflight({ worktree: { branch: 'feat/x', state: 'rebasing' }, base: 'main' })[0]
        ?.message,
    ).toBe('The checkout has a rebasing in progress — finish or abort it first');
  });
});

describe('reduceFinish / nextAction', () => {
  test('the step order and the labels', () => {
    expect(FINISH_STEPS).toEqual([
      'merge-base-in',
      'verify',
      'merge-into-base',
      'cleanup',
      'remove-worktree',
      'delete-branch',
    ]);
    const s = fresh();
    expect(FINISH_STEPS.map((id) => finishStepLabel(id, s))).toEqual([
      'Merge development into feat/x',
      'Verify the merged branch',
      'Merge feat/x into development',
      'Close terminals and forget the workspace',
      'Remove the worktree',
      'Delete feat/x',
    ]);
  });

  test('happy path: run, done, pause at verify, resume, run the rest, done', () => {
    let s = fresh();
    expect(nextAction(s)).toEqual({ kind: 'run', step: 'merge-base-in' });
    s = drive(s, [{ type: 'start' }, { type: 'step-done' }]);
    expect(nextAction(s)).toEqual({ kind: 'run', step: 'verify' });
    s = drive(s, [{ type: 'start' }, { type: 'paused' }]);
    expect(nextAction(s)).toEqual({ kind: 'wait', step: 'verify', status: 'paused' });
    // Continue on verify = the step is done.
    s = drive(s, [{ type: 'step-done' }]);
    expect(nextAction(s)).toEqual({ kind: 'run', step: 'merge-into-base' });
    for (let i = 0; i < 4; i++) {
      s = drive(s, [{ type: 'start' }, { type: 'step-done' }]);
    }
    expect(s.finished).toBe(true);
    expect(s.aborted).toBe(false);
    expect(s.current).toBe(6);
    expect(s.steps.every((st) => st.status === 'done')).toBe(true);
    expect(nextAction(s)).toEqual({ kind: 'done', aborted: false });
  });

  test('conflicts park the step until cleared; skip is refused there', () => {
    let s = drive(fresh(), [{ type: 'start' }, { type: 'conflicts', files: ['a.ts'] }]);
    expect(currentStep(s)).toMatchObject({ id: 'merge-base-in', status: 'conflicts' });
    expect(s.conflicts).toEqual(['a.ts']);
    expect(nextAction(s)).toEqual({ kind: 'wait', step: 'merge-base-in', status: 'conflicts' });
    expect(reduceFinish(s, { type: 'skip' })).toBe(s);
    s = reduceFinish(s, { type: 'conflicts-cleared' });
    expect(s.conflicts).toBeNull();
    expect(s.steps[0]!.status).toBe('done');
    expect(nextAction(s)).toEqual({ kind: 'run', step: 'verify' });
    // conflicts-cleared on a step that is not in conflicts is a no-op.
    expect(reduceFinish(s, { type: 'conflicts-cleared' })).toBe(s);
  });

  test('a failure stops the flow; retry re-runs, skip moves on', () => {
    let s = drive(fresh(), [{ type: 'start' }, { type: 'step-failed', error: 'fatal: no' }]);
    expect(nextAction(s)).toEqual({ kind: 'stopped', step: 'merge-base-in', error: 'fatal: no' });
    const retried = reduceFinish(s, { type: 'retry' });
    expect(nextAction(retried)).toEqual({ kind: 'run', step: 'merge-base-in' });
    expect(retried.steps[0]!.error).toBeNull();
    s = reduceFinish(s, { type: 'skip' });
    expect(s.steps[0]!.status).toBe('skipped');
    expect(nextAction(s)).toEqual({ kind: 'run', step: 'verify' });
  });

  test('a declined confirm pauses; resume makes the step pending again', () => {
    let s = fresh();
    s = { ...s, current: 3 };
    s = drive(s, [{ type: 'start' }, { type: 'paused' }]);
    expect(nextAction(s)).toEqual({ kind: 'wait', step: 'cleanup', status: 'paused' });
    s = reduceFinish(s, { type: 'resume' });
    expect(nextAction(s)).toEqual({ kind: 'run', step: 'cleanup' });
  });

  test('abort ends the flow and marks the step in progress failed; events after are ignored', () => {
    const s = reduceFinish(drive(fresh(), [{ type: 'start' }]), { type: 'abort' });
    expect(s).toMatchObject({ finished: true, aborted: true, conflicts: null });
    expect(s.steps[0]).toEqual({ id: 'merge-base-in', status: 'failed', error: null });
    expect(nextAction(s)).toEqual({ kind: 'done', aborted: true });
    expect(reduceFinish(s, { type: 'step-done' })).toBe(s);
    expect(reduceFinish(s, { type: 'abort' })).toBe(s);
  });

  test('start only moves a pending step; paused / resume only apply where they make sense', () => {
    const s = drive(fresh(), [{ type: 'start' }]);
    expect(reduceFinish(s, { type: 'start' })).toBe(s);
    const pending = fresh();
    expect(reduceFinish(pending, { type: 'paused' })).toBe(pending);
    expect(reduceFinish(s, { type: 'resume' })).toBe(s);
    expect(reduceFinish(s, { type: 'retry' })).toBe(s);
  });

  test('blockers make a finished flow that never ran', () => {
    const s = createFinishState({
      worktree: 'w',
      branch: 'b',
      base: 'd',
      mainRoot: 'm',
      blockers: [{ code: 'main-dirty', message: 'x' }],
    });
    expect(s.finished).toBe(true);
    expect(s.blockers).toEqual([{ code: 'main-dirty', message: 'x' }]);
    expect(nextAction(s)).toEqual({ kind: 'done', aborted: false });
    expect(fresh().blockers).toBeUndefined();
  });
});

describe('recoverFinishState', () => {
  const facts = {
    branch: 'feat/x',
    base: 'development',
    worktreePresent: true,
    branchExists: true,
    main: { state: 'clean' as const, branch: 'development' },
    merged: false as boolean | null,
  };

  test('reads the repository back into a step', () => {
    expect(recoverFinishState(facts)).toEqual({
      step: 'merge-base-in',
      message: 'feat/x is not merged into development yet',
    });
    expect(recoverFinishState({ ...facts, merged: true }).step).toBe('cleanup');
    expect(
      recoverFinishState({ ...facts, main: { state: 'merging', branch: 'development' } }),
    ).toEqual({
      step: 'merge-into-base',
      message:
        'A merge into development is in progress in the main checkout — resolve its conflicts and continue, or abort it',
    });
    expect(recoverFinishState({ ...facts, worktreePresent: false }).step).toBe('delete-branch');
    expect(recoverFinishState({ ...facts, worktreePresent: false, branchExists: false })).toEqual({
      step: null,
      message: 'Finished: the worktree and feat/x are gone',
    });
  });
});
