import { describe, expect, test } from 'vitest';
import type { GitCheckout, GitStatusEntry, GitWorktreeSummary } from '../types';
import {
  describeUncommitted,
  isCleanWorktree,
  planCleanRemoval,
  removalProgressText,
  removalSkipText,
} from '../worktree-removal';

const MAIN = 'C:/repo';

const checkout = (
  path: string,
  over: Partial<GitWorktreeSummary> | null = {},
  isMain = false,
): GitCheckout => ({
  path,
  branch: isMain ? 'main' : `feat/${path.split('/').at(-1)}`,
  head: 'abc',
  isMain,
  summary:
    over === null
      ? null
      : {
          path,
          branch: null,
          head: 'abc',
          isMain,
          locked: false,
          missing: false,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
          state: 'clean',
          ahead: 2,
          behind: 0,
          ...over,
        },
});

const wt = (slug: string) => `${MAIN}/worktrees/${slug}`;

const entry = (
  path: string,
  index: string,
  worktree: string,
  kind: GitStatusEntry['kind'] = 'ordinary',
  origPath: string | null = null,
): GitStatusEntry => ({ path, origPath, index, worktree, kind });

describe('isCleanWorktree', () => {
  test('a linked worktree with nothing uncommitted is clean, however far ahead it is', () => {
    expect(isCleanWorktree(checkout(wt('a')))).toBe(true);
  });

  test('never the main checkout, never an unsummarised or locked one', () => {
    expect(isCleanWorktree(checkout(MAIN, {}, true))).toBe(false);
    expect(isCleanWorktree(checkout(wt('a'), null))).toBe(false);
    expect(isCleanWorktree(checkout(wt('a'), { locked: true }))).toBe(false);
    expect(isCleanWorktree(checkout(wt('a'), { locked: true, missing: true }))).toBe(false);
  });

  test('any staged, changed, untracked or conflicted file makes it dirty', () => {
    for (const over of [{ staged: 1 }, { unstaged: 1 }, { untracked: 1 }, { conflicted: 1 }]) {
      expect(isCleanWorktree(checkout(wt('a'), over))).toBe(false);
    }
  });

  test('an operation in progress makes it busy, not clean', () => {
    expect(isCleanWorktree(checkout(wt('a'), { state: 'merging' }))).toBe(false);
    expect(isCleanWorktree(checkout(wt('a'), { state: 'rebasing' }))).toBe(false);
  });

  test('a folder that is already gone is clean — removing it is only a prune', () => {
    expect(isCleanWorktree(checkout(wt('a'), { missing: true }))).toBe(true);
  });
});

describe('planCleanRemoval', () => {
  const checkouts = [
    checkout(MAIN, {}, true),
    checkout(wt('clean')),
    checkout(wt('dirty'), { unstaged: 2 }),
    checkout(wt('agent')),
    checkout(wt('gone'), { missing: true }),
    checkout(wt('locked'), { locked: true }),
    checkout(wt('finishing')),
  ];

  test('takes the clean ones, skips one with a terminal inside and a busy one, ignores the rest', () => {
    const plan = planCleanRemoval(
      checkouts,
      [
        { id: 't1', title: 'claude', cwd: `${wt('agent')}/src` },
        { id: 't2', title: 'pwsh', cwd: MAIN },
      ],
      [wt('finishing')],
    );
    expect(plan.remove.map((c) => c.path)).toEqual([wt('clean'), wt('gone')]);
    expect(plan.skipped).toEqual([
      { path: wt('agent'), reason: 'terminal', terminals: ['claude'] },
      { path: wt('finishing'), reason: 'busy' },
    ]);
  });

  test('a shell in the main checkout does not hold back the worktrees under it', () => {
    const plan = planCleanRemoval(
      [checkout(MAIN, {}, true), checkout(wt('a'))],
      [{ id: 't', title: 'pwsh', cwd: MAIN }],
    );
    expect(plan.remove.map((c) => c.path)).toEqual([wt('a')]);
    expect(plan.skipped).toEqual([]);
  });

  test('paths compare by key (case, slashes)', () => {
    const plan = planCleanRemoval(
      [checkout(wt('a'))],
      [{ id: 't', title: 'sh', cwd: 'c:\\repo\\WORKTREES\\a' }],
      [],
    );
    expect(plan.skipped.map((s) => s.reason)).toEqual(['terminal']);
    const busy = planCleanRemoval([checkout(wt('a'))], [], ['c:\\repo\\worktrees\\A\\']);
    expect(busy.skipped.map((s) => s.reason)).toEqual(['busy']);
  });

  test('nothing clean, nothing to do', () => {
    expect(planCleanRemoval([checkout(MAIN, {}, true)], [])).toEqual({ remove: [], skipped: [] });
  });
});

describe('removalSkipText', () => {
  test('says why in plain words', () => {
    expect(removalSkipText({ path: 'x', reason: 'terminal', terminals: ['claude', 'pwsh'] })).toBe(
      'a terminal is open in it (claude, pwsh) — something may still be working there',
    );
    expect(removalSkipText({ path: 'x', reason: 'terminal' })).toBe(
      'a terminal is open in it — something may still be working there',
    );
    expect(removalSkipText({ path: 'x', reason: 'busy' })).toBe(
      'it is already being finished or removed',
    );
    expect(removalSkipText({ path: 'x', reason: 'changed' })).toBe(
      'it has new changes that are not committed yet',
    );
    expect(removalSkipText({ path: 'x', reason: 'unreadable' })).toBe(
      'git could not check it for changes',
    );
    expect(removalSkipText({ path: 'x', reason: 'failed', detail: 'Git: denied' })).toBe(
      'it could not be removed: Git: denied',
    );
    expect(removalSkipText({ path: 'x', reason: 'failed' })).toBe('it could not be removed');
  });
});

describe('removalProgressText', () => {
  test('counts the one in flight, one-based, never past the total', () => {
    expect(removalProgressText(0, 5)).toBe('Removing 1 of 5…');
    expect(removalProgressText(4, 5)).toBe('Removing 5 of 5…');
    expect(removalProgressText(5, 5)).toBe('Removing 5 of 5…');
    expect(removalProgressText(0, 1)).toBe('Removing…');
  });
});

describe('describeUncommitted', () => {
  test('plain words per file, sorted by path', () => {
    const out = describeUncommitted([
      entry('src/b.ts', '.', 'M'),
      entry('notes.md', '?', '?', 'untracked'),
      entry('old.ts', '.', 'D'),
      entry('staged-new.ts', 'A', '.'),
      entry('both.ts', 'M', 'M'),
      entry('gone-staged.ts', 'D', '.'),
      entry('new-name.ts', 'R', '.', 'renamed', 'old-name.ts'),
      entry('clash.ts', 'U', 'U', 'unmerged'),
      entry('added-then-edited.ts', 'A', 'M'),
    ]);
    expect(out.total).toBe(9);
    expect(out.more).toBe(0);
    expect(out.files).toEqual([
      { path: 'added-then-edited.ts', from: null, change: 'new' },
      { path: 'both.ts', from: null, change: 'modified' },
      { path: 'clash.ts', from: null, change: 'conflicted' },
      { path: 'gone-staged.ts', from: null, change: 'deleted' },
      { path: 'new-name.ts', from: 'old-name.ts', change: 'renamed' },
      { path: 'notes.md', from: null, change: 'new' },
      { path: 'old.ts', from: null, change: 'deleted' },
      { path: 'src/b.ts', from: null, change: 'modified' },
      { path: 'staged-new.ts', from: null, change: 'new' },
    ]);
  });

  test('shows the first `limit` and counts the rest; a path is listed once', () => {
    const entries = Array.from({ length: 13 }, (_, i) =>
      entry(`f${String(i).padStart(2, '0')}.md`, '.', 'M'),
    );
    entries.push(entry('f00.md', 'M', '.'));
    const out = describeUncommitted(entries);
    expect(out.files.map((f) => f.path)).toEqual(
      Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(2, '0')}.md`),
    );
    expect(out.more).toBe(3);
    expect(out.total).toBe(13);
    expect(describeUncommitted(entries, 0)).toMatchObject({ files: [], more: 13 });
  });

  test('nothing changed, nothing listed', () => {
    expect(describeUncommitted([])).toEqual({ files: [], more: 0, total: 0 });
  });
});
