import { describe, expect, test } from 'vitest';
import {
  dirtyCount,
  flattenStatus,
  groupStatus,
  isTreeClean,
  mergingInto,
  statusCounts,
  statusLabel,
} from '../status';
import type { GitBranch, GitStatus, GitStatusEntry } from '../types';

const entry = (
  path: string,
  index: string,
  worktree: string,
  kind: GitStatusEntry['kind'] = 'ordinary',
  origPath: string | null = null,
): GitStatusEntry => ({ path, origPath, index, worktree, kind });

describe('groupStatus', () => {
  test('an MM entry appears in staged AND unstaged; single-letter ones in one group', () => {
    const groups = groupStatus([
      entry('both.ts', 'M', 'M'),
      entry('staged.ts', 'A', '.'),
      entry('changed.ts', '.', 'M'),
      entry('deleted.ts', '.', 'D'),
    ]);
    expect(groups.staged.map((e) => e.path)).toEqual(['both.ts', 'staged.ts']);
    expect(groups.unstaged.map((e) => e.path)).toEqual(['both.ts', 'changed.ts', 'deleted.ts']);
    expect(groups.untracked).toEqual([]);
    expect(groups.conflicted).toEqual([]);
  });

  test('a rename is staged (and unstaged too when edited after)', () => {
    const groups = groupStatus([
      entry('new.ts', 'R', '.', 'renamed', 'old.ts'),
      entry('moved.ts', 'R', 'M', 'renamed', 'was.ts'),
    ]);
    expect(groups.staged.map((e) => e.path)).toEqual(['new.ts', 'moved.ts']);
    expect(groups.unstaged.map((e) => e.path)).toEqual(['moved.ts']);
  });

  test('unmerged entries are conflicted only, whatever their letters', () => {
    const groups = groupStatus([
      entry('a.ts', 'U', 'U', 'unmerged'),
      entry('b.ts', 'A', 'A', 'unmerged'),
      entry('c.ts', 'D', 'U', 'unmerged'),
    ]);
    expect(groups.conflicted.map((e) => e.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(groups.staged).toEqual([]);
    expect(groups.unstaged).toEqual([]);
  });

  test('? entries are untracked', () => {
    const groups = groupStatus([entry('x.md', '?', '?', 'untracked'), entry('y.md', '?', '?')]);
    expect(groups.untracked.map((e) => e.path)).toEqual(['x.md', 'y.md']);
    expect(groups.staged).toEqual([]);
  });
});

describe('flattenStatus', () => {
  test('one row per path, sorted, with its staging state and the working-tree letter first', () => {
    const rows = flattenStatus([
      entry('z-both.ts', 'M', 'M'),
      entry('staged.ts', 'A', '.'),
      entry('changed.ts', '.', 'M'),
      entry('gone.ts', 'M', 'D'),
      entry('new.md', '?', '?', 'untracked'),
    ]);
    expect(rows.map((r) => [r.entry.path, r.state, r.letter])).toEqual([
      ['changed.ts', 'unstaged', 'M'],
      ['gone.ts', 'partial', 'D'],
      ['new.md', 'untracked', '?'],
      ['staged.ts', 'staged', 'A'],
      ['z-both.ts', 'partial', 'M'],
    ]);
  });

  test('conflicted entries are left to the conflicts section; clean ones are dropped', () => {
    const rows = flattenStatus([
      entry('a.ts', 'U', 'U', 'unmerged'),
      entry('b.ts', '.', '.'),
      entry('c.ts', 'R', '.', 'renamed', 'old.ts'),
    ]);
    expect(rows.map((r) => r.entry.path)).toEqual(['c.ts']);
    expect(rows[0]!.entry.origPath).toBe('old.ts');
  });
});

describe('counts and labels', () => {
  test('dirtyCount counts distinct paths', () => {
    expect(dirtyCount([entry('a', 'M', 'M'), entry('b', '.', 'M'), entry('c', '?', '?')])).toBe(3);
    expect(dirtyCount([])).toBe(0);
  });

  test('statusLabel lists non-zero counts, conflicts first; clean otherwise', () => {
    const groups = groupStatus([
      entry('a', 'M', 'M'),
      entry('b', '?', '?', 'untracked'),
      entry('c', 'U', 'U', 'unmerged'),
    ]);
    expect(statusCounts(groups)).toEqual({ staged: 1, unstaged: 1, untracked: 1, conflicted: 1 });
    expect(statusLabel(statusCounts(groups))).toBe(
      '1 conflicted · 1 staged · 1 changed · 1 untracked',
    );
    expect(statusLabel({ staged: 0, unstaged: 2, untracked: 0, conflicted: 0 })).toBe('2 changed');
    expect(statusLabel({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })).toBe('clean');
  });

  test('isTreeClean: no entries at all; null status is not clean', () => {
    expect(isTreeClean({ entries: [] })).toBe(true);
    expect(isTreeClean({ entries: [entry('a', '?', '?', 'untracked')] })).toBe(false);
    expect(isTreeClean(null)).toBe(false);
  });
});

describe('mergingInto', () => {
  const branch = (name: string, head: string, kind: GitBranch['kind'] = 'local'): GitBranch => ({
    name,
    kind,
    head,
    current: false,
    upstream: null,
    ahead: null,
    behind: null,
    gone: false,
    committedAt: '2026-09-24T00:00:00Z',
  });
  const status = (over: Partial<GitStatus>): GitStatus => ({
    head: 'aaa',
    branch: 'development',
    upstream: null,
    ahead: null,
    behind: null,
    unborn: false,
    state: 'merging',
    mergeHead: 'bbb1234567',
    entries: [],
    ...over,
  });

  test('names the branch whose head is MERGE_HEAD, local before remote', () => {
    const branches = [
      branch('origin/feat/x', 'bbb1234567', 'remote'),
      branch('feat/x', 'bbb1234567'),
    ];
    expect(mergingInto(status({}), branches)).toEqual({ into: 'development', from: 'feat/x' });
    expect(mergingInto(status({}), [branches[0]!])).toEqual({
      into: 'development',
      from: 'origin/feat/x',
    });
  });

  test('falls back to the short sha, HEAD when detached, null when not merging', () => {
    expect(mergingInto(status({ branch: null }), [])).toEqual({ into: 'HEAD', from: 'bbb1234' });
    expect(mergingInto(status({ state: 'clean', mergeHead: null }), [])).toBeNull();
    expect(mergingInto(null, [])).toBeNull();
  });
});
