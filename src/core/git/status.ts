/**
 * Status arithmetic — `git status --porcelain=v2` entries into the four
 * change sections the panel renders, plus the one-line readings of a
 * checkout's state. Pure; no DOM, no Tauri, no React.
 *
 * The grouping rule (pinned by the tests): an ordinary or renamed entry sits
 * in `staged` when its INDEX letter is not `.` and in `unstaged` when its
 * WORKTREE letter is not `.` — so an `MM` file appears in both, which is what
 * git means by it. An unmerged (`u`) entry is `conflicted` and nothing else,
 * however its letters read; a `?` entry is `untracked`.
 */

import type { GitBranch, GitStatus, GitStatusEntry, StatusGroups } from './types';

export function emptyGroups(): StatusGroups {
  return { staged: [], unstaged: [], untracked: [], conflicted: [] };
}

/** Split status entries into the four sections; an `MM` entry lands in two. */
export function groupStatus(entries: readonly GitStatusEntry[]): StatusGroups {
  const groups = emptyGroups();
  for (const entry of entries) {
    if (entry.kind === 'unmerged') {
      groups.conflicted.push(entry);
      continue;
    }
    if (entry.kind === 'untracked' || entry.index === '?') {
      groups.untracked.push(entry);
      continue;
    }
    if (entry.index !== '.') {
      groups.staged.push(entry);
    }
    if (entry.worktree !== '.') {
      groups.unstaged.push(entry);
    }
  }
  return groups;
}

/** How much of one changed file is in the index. */
export type ChangeState = 'staged' | 'partial' | 'unstaged' | 'untracked';

/** One row of the flat change list: a path and how far it is staged. */
export interface FlatChange {
  entry: GitStatusEntry;
  state: ChangeState;
  /** The one letter the row shows: the working-tree change, else the staged one, `?` when untracked. */
  letter: string;
}

/**
 * Status entries as ONE list — every path that differs from HEAD, once,
 * with its staging state — for a panel that shows "what changed since the
 * last commit" instead of three lists. Conflicted entries are left out (the
 * conflicts section owns them). Sorted by path, so a refresh never reorders.
 */
export function flattenStatus(entries: readonly GitStatusEntry[]): FlatChange[] {
  const rows: FlatChange[] = [];
  for (const entry of entries) {
    if (entry.kind === 'unmerged') {
      continue;
    }
    if (entry.kind === 'untracked' || entry.index === '?') {
      rows.push({ entry, state: 'untracked', letter: '?' });
      continue;
    }
    const staged = entry.index !== '.';
    const unstaged = entry.worktree !== '.';
    if (!staged && !unstaged) {
      continue;
    }
    rows.push({
      entry,
      state: staged && unstaged ? 'partial' : staged ? 'staged' : 'unstaged',
      letter: unstaged ? entry.worktree : entry.index,
    });
  }
  rows.sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  return rows;
}

/** Number of distinct paths that differ from HEAD in any way. */
export function dirtyCount(entries: readonly GitStatusEntry[]): number {
  return new Set(entries.map((e) => e.path)).size;
}

/** No entry at all — nothing staged, changed, untracked or unmerged. */
export function isTreeClean(status: Pick<GitStatus, 'entries'> | null): boolean {
  return status !== null && status.entries.length === 0;
}

/** The counts a dashboard row or a status chip is built from. */
export interface StatusCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export function statusCounts(groups: StatusGroups): StatusCounts {
  return {
    staged: groups.staged.length,
    unstaged: groups.unstaged.length,
    untracked: groups.untracked.length,
    conflicted: groups.conflicted.length,
  };
}

/**
 * One line for the counts: `2 staged · 1 changed · 3 untracked · 1 conflicted`,
 * zero counts left out; `clean` when every count is zero.
 */
export function statusLabel(counts: StatusCounts): string {
  const parts: string[] = [];
  if (counts.conflicted > 0) {
    parts.push(`${counts.conflicted} conflicted`);
  }
  if (counts.staged > 0) {
    parts.push(`${counts.staged} staged`);
  }
  if (counts.unstaged > 0) {
    parts.push(`${counts.unstaged} changed`);
  }
  if (counts.untracked > 0) {
    parts.push(`${counts.untracked} untracked`);
  }
  return parts.length === 0 ? 'clean' : parts.join(' · ');
}

/** The two names of an in-progress merge, as the conflict prompt states them. */
export interface MergeNames {
  /** The checked-out branch receiving the merge (`HEAD` when detached). */
  into: string;
  /** The branch whose tip is `MERGE_HEAD`, or its short sha when no branch points there. */
  from: string;
}

/**
 * While `status.state === 'merging'`: what is being merged into what. The
 * branch is found by its head matching `MERGE_HEAD` (local branches first,
 * then remote ones); with no such branch the short sha names it. Null when
 * no merge is in progress.
 */
export function mergingInto(
  status: Pick<GitStatus, 'state' | 'branch' | 'mergeHead'> | null,
  branches: readonly GitBranch[],
): MergeNames | null {
  if (status === null || status.state !== 'merging' || status.mergeHead === null) {
    return null;
  }
  const head = status.mergeHead;
  const match =
    branches.find((b) => b.kind === 'local' && b.head === head) ??
    branches.find((b) => b.head === head);
  return { into: status.branch ?? 'HEAD', from: match ? match.name : head.slice(0, 7) };
}
