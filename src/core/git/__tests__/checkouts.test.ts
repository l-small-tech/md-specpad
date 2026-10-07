import { describe, expect, test } from 'vitest';
import {
  buildCheckouts,
  extraGitWatchDirs,
  isActiveCheckout,
  isInsideCheckout,
  pickSelected,
  terminalsInside,
} from '../checkouts';
import type { GitCheckout, GitWorktreeSummary } from '../types';

const summary = (path: string, branch: string | null, isMain = false): GitWorktreeSummary => ({
  path,
  branch,
  head: 'abc',
  isMain,
  locked: false,
  missing: false,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  state: 'clean',
  ahead: null,
  behind: null,
});

const info = {
  mainRoot: 'C:/repo',
  worktrees: [
    { path: 'C:/repo/worktrees/b', branch: 'feat/b', head: '2' },
    { path: 'C:/repo', branch: 'development', head: '1' },
    { path: 'C:/repo/worktrees/a', branch: 'feat/a', head: '3' },
  ],
};

describe('buildCheckouts', () => {
  test('main first, then worktree-list order, summaries attached by path key', () => {
    const summaries = [
      summary('c:/repo/worktrees/A', 'feat/a'),
      summary('C:/repo', 'development', true),
    ];
    const out = buildCheckouts(info, summaries);
    expect(out.map((c) => [c.path, c.isMain, c.summary !== null])).toEqual([
      ['C:/repo', true, true],
      ['C:/repo/worktrees/b', false, false],
      ['C:/repo/worktrees/a', false, true],
    ]);
  });

  test('a checkout only the summaries know (added since) is listed; main is always present', () => {
    const out = buildCheckouts({ mainRoot: 'C:/repo', worktrees: [] }, [
      summary('C:/repo/worktrees/new', 'feat/new'),
    ]);
    expect(out.map((c) => c.path)).toEqual(['C:/repo', 'C:/repo/worktrees/new']);
    expect(out[0]!.isMain).toBe(true);
    expect(buildCheckouts(info, null).map((c) => c.path)).toEqual([
      'C:/repo',
      'C:/repo/worktrees/b',
      'C:/repo/worktrees/a',
    ]);
  });
});

describe('pickSelected', () => {
  const checkouts = buildCheckouts(info, null);

  test('remembered → active workspace checkout → main', () => {
    expect(pickSelected(checkouts, 'c:\\repo\\worktrees\\a', null)).toBe('C:/repo/worktrees/a');
    expect(pickSelected(checkouts, 'C:/repo/worktrees/gone', 'C:/repo/worktrees/b')).toBe(
      'C:/repo/worktrees/b',
    );
    expect(pickSelected(checkouts, null, 'C:/repo/worktrees/b/src')).toBe('C:/repo/worktrees/b');
    expect(pickSelected(checkouts, null, 'C:/repo/docs')).toBe('C:/repo');
    expect(pickSelected(checkouts, null, 'D:/elsewhere')).toBe('C:/repo');
    expect(pickSelected(checkouts, null, null)).toBe('C:/repo');
    expect(pickSelected([], null, null)).toBe('');
  });
});

describe('terminalsInside', () => {
  const tabs = [
    { id: 't1', title: 'pwsh', cwd: 'C:\\repo\\worktrees\\a\\src' },
    { id: 't2', title: 'bash', cwd: 'c:/repo/worktrees/a' },
    { id: 't3', title: 'other', cwd: 'C:/repo/worktrees/ab' },
    { id: 't4', title: 'main', cwd: 'C:/repo' },
    { id: 't5', title: 'fresh', cwd: null },
  ];

  test('the root itself or below it, by path key; a sibling with the same prefix is not inside', () => {
    expect(terminalsInside(tabs, 'C:/repo/worktrees/a').map((t) => t.id)).toEqual(['t1', 't2']);
    expect(isInsideCheckout('C:/repo/worktrees/ab', 'C:/repo/worktrees/a')).toBe(false);
  });

  test('nested checkouts are excluded from the enclosing one when asked', () => {
    expect(terminalsInside(tabs, 'C:/repo').map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(
      terminalsInside(tabs, 'C:/repo', [
        'C:/repo/worktrees/a',
        'C:/repo/worktrees/ab',
        'C:/repo',
      ]).map((t) => t.id),
    ).toEqual(['t4']);
  });
});

describe('extraGitWatchDirs', () => {
  test('checkout roots no watched root covers, deduped', () => {
    const repos = [
      { mainRoot: 'C:/repo', checkoutPaths: ['C:/repo', 'C:/repo/worktrees/a', 'D:/wt/x'] },
      { mainRoot: 'E:/other', checkoutPaths: ['e:/OTHER/'] },
    ];
    expect(extraGitWatchDirs(repos, ['C:/repo'])).toEqual(['D:/wt/x', 'E:/other']);
    expect(extraGitWatchDirs(repos, ['C:/', 'D:/wt', 'E:/other'])).toEqual([]);
  });
});

describe('isActiveCheckout', () => {
  const checkout = (over: Partial<GitWorktreeSummary> | null, isMain = false): GitCheckout => ({
    path: 'C:/repo/worktrees/a',
    branch: 'feat/a',
    head: 'abc',
    isMain,
    summary:
      over === null ? null : { ...summary('C:/repo/worktrees/a', 'feat/a', isMain), ...over },
  });

  test('a clean linked worktree with no terminal is not active', () => {
    expect(isActiveCheckout(checkout({}), false)).toBe(false);
    // Ahead of the base is finished work, not activity.
    expect(isActiveCheckout(checkout({ ahead: 3, behind: 1 }), false)).toBe(false);
  });

  test('the main checkout, an unsummarised one, and one with a terminal always are', () => {
    expect(isActiveCheckout(checkout({}, true), false)).toBe(true);
    expect(isActiveCheckout(checkout(null), false)).toBe(true);
    expect(isActiveCheckout(checkout({}), true)).toBe(true);
  });

  test('anything dirty, mid-operation, or missing is active', () => {
    expect(isActiveCheckout(checkout({ untracked: 1 }), false)).toBe(true);
    expect(isActiveCheckout(checkout({ staged: 2 }), false)).toBe(true);
    expect(isActiveCheckout(checkout({ unstaged: 1 }), false)).toBe(true);
    expect(isActiveCheckout(checkout({ conflicted: 1 }), false)).toBe(true);
    expect(isActiveCheckout(checkout({ state: 'merging' }), false)).toBe(true);
    expect(isActiveCheckout(checkout({ missing: true }), false)).toBe(true);
  });
});
