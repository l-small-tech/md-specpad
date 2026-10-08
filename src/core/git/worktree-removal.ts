/**
 * Worktree removal — the pure half of "Delete all clean worktrees" and of the
 * dialog a dirty worktree's removal opens. Pure; no DOM, no Tauri, no React.
 *
 * - `isCleanWorktree` / `planCleanRemoval` decide which linked worktrees the
 *   bulk delete may take: nothing uncommitted (staged, changed, untracked and
 *   conflicted all zero), no operation in progress, not locked, never the
 *   main checkout. A worktree whose folder is already gone (git calls it
 *   prunable) counts as clean — removing it only drops git's record, there is
 *   nothing left to lose. One a terminal of this window stands in is SKIPPED
 *   (an agent is probably working there), and so is one another flow is busy
 *   with; both are reported so the dialog can say why. Branches are never
 *   touched — the commits stay reachable.
 * - `describeUncommitted` turns a fresh `git status` into the file list the
 *   force-delete dialog shows: plain words (new / modified / deleted /
 *   renamed / conflicted), the first `limit` files, and how many more.
 * - `removalSkipText` / `removalProgressText` are the sentences both use.
 */

import { checkoutKey, terminalsInside, type TerminalCwd } from './checkouts';
import type { GitCheckout, GitStatusEntry } from './types';

/** May "Delete all clean worktrees" take this checkout (terminals aside)? */
export function isCleanWorktree(checkout: GitCheckout): boolean {
  const s = checkout.summary;
  if (checkout.isMain || s === null || s.locked) {
    return false;
  }
  if (s.missing) {
    return true;
  }
  return s.state === 'clean' && s.staged + s.unstaged + s.untracked + s.conflicted === 0;
}

/**
 * Why a worktree the bulk delete would otherwise take was left alone.
 * `terminal` and `busy` are known up front (`planCleanRemoval`); the rest
 * are found right before the removal: `changed` (a fresh status shows
 * changes the listing did not), `unreadable` (git could not check it), and
 * `failed` (git refused or the folder could not be deleted).
 */
export type RemovalSkipReason = 'terminal' | 'busy' | 'changed' | 'unreadable' | 'failed';

export interface RemovalSkip {
  path: string;
  reason: RemovalSkipReason;
  /** `terminal`: the titles of the tabs open inside it. */
  terminals?: string[];
  /** `failed`: git's (or the folder delete's) own words. */
  detail?: string;
}

export interface CleanRemovalPlan {
  /** Clean linked worktrees to remove, in strip order. */
  remove: GitCheckout[];
  /** Clean ones left alone, and why. */
  skipped: RemovalSkip[];
}

/**
 * The clean linked worktrees the bulk delete removes, and the clean ones it
 * leaves (a terminal is open inside — titles listed — or `busy` names it).
 * A terminal inside a worktree nested under another counts for the inner
 * one only (`terminalsInside`'s nested rule).
 */
export function planCleanRemoval<T extends TerminalCwd>(
  checkouts: readonly GitCheckout[],
  terminals: readonly T[],
  busy: readonly string[] = [],
): CleanRemovalPlan {
  const paths = checkouts.map((c) => c.path);
  const busyKeys = new Set(busy.map(checkoutKey));
  const remove: GitCheckout[] = [];
  const skipped: RemovalSkip[] = [];
  for (const c of checkouts) {
    if (!isCleanWorktree(c)) {
      continue;
    }
    if (busyKeys.has(checkoutKey(c.path))) {
      skipped.push({ path: c.path, reason: 'busy' });
      continue;
    }
    const inside = terminalsInside(terminals, c.path, paths);
    if (inside.length > 0) {
      skipped.push({ path: c.path, reason: 'terminal', terminals: inside.map((t) => t.title) });
      continue;
    }
    remove.push(c);
  }
  return { remove, skipped };
}

/** One skipped worktree's reason, as the end of "worktrees/x — …". */
export function removalSkipText(skip: RemovalSkip): string {
  switch (skip.reason) {
    case 'terminal': {
      const names = skip.terminals ?? [];
      const which = names.length > 0 ? ` (${names.join(', ')})` : '';
      return `a terminal is open in it${which} — something may still be working there`;
    }
    case 'busy':
      return 'it is already being finished or removed';
    case 'changed':
      return 'it has new changes that are not committed yet';
    case 'unreadable':
      return 'git could not check it for changes';
    case 'failed':
      return skip.detail ? `it could not be removed: ${skip.detail}` : 'it could not be removed';
  }
}

/** The bulk delete's progress line: `Removing 2 of 5…` (`done` already removed or skipped). */
export function removalProgressText(done: number, total: number): string {
  if (total <= 1) {
    return 'Removing…';
  }
  return `Removing ${Math.min(done + 1, total)} of ${total}…`;
}

/** How one uncommitted file differs, in plain words. */
export type UncommittedChange = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

export interface UncommittedFile {
  path: string;
  /** For `renamed`: the name it had. */
  from: string | null;
  change: UncommittedChange;
}

export interface UncommittedList {
  /** The first `limit` files, sorted by path. */
  files: UncommittedFile[];
  /** How many more there are beyond `files`. */
  more: number;
  /** Every file with a change. */
  total: number;
}

/** A porcelain status letter (A, M, D, R, C, T, …) in plain words. */
function changeForLetter(letter: string): UncommittedChange {
  switch (letter) {
    case 'A':
      return 'new';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

function changeOf(entry: GitStatusEntry): UncommittedChange {
  if (entry.kind === 'unmerged') {
    return 'conflicted';
  }
  if (entry.kind === 'untracked' || entry.index === '?') {
    return 'new';
  }
  if (entry.kind === 'renamed') {
    return 'renamed';
  }
  // A file deleted (or newly added) on either side reads as that, whatever
  // the other side says; anything else is a modification.
  const letters = [entry.index, entry.worktree];
  if (letters.includes('D')) {
    return 'deleted';
  }
  if (letters.includes('A')) {
    return 'new';
  }
  return changeForLetter(entry.worktree !== '.' ? entry.worktree : entry.index);
}

/** The force-delete dialog's file list: plain-word changes, `limit` shown, the rest counted. */
export function describeUncommitted(
  entries: readonly GitStatusEntry[],
  limit = 10,
): UncommittedList {
  const byPath = new Map<string, UncommittedFile>();
  for (const entry of entries) {
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, {
        path: entry.path,
        from: entry.kind === 'renamed' ? entry.origPath : null,
        change: changeOf(entry),
      });
    }
  }
  const all = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shown = all.slice(0, Math.max(0, limit));
  return { files: shown, more: all.length - shown.length, total: all.length };
}
