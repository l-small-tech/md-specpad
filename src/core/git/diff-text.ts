/**
 * Diff text helpers — what the detail pane does to two sides of a file
 * before handing them to `core/diff.ts`. Pure; no DOM, no Tauri, no React.
 *
 * A CRLF checkout against a LF index (or the other way round, after an
 * `autocrlf` change) would show every line changed; the pane normalizes both
 * sides and says so with `eolOnlyDifference` instead of drawing a wall of
 * red. Binary detection is git's own heuristic: a NUL byte in the first
 * 8 000 characters.
 */

import { shortSha } from './refs';
import type { SelectedItem } from './types';

/** `\r\n` and lone `\r` → `\n`. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

const BINARY_PROBE = 8000;

/** git's rule: a NUL in the first 8 000 bytes means binary. */
export function isBinaryText(text: string | null): boolean {
  return text !== null && text.slice(0, BINARY_PROBE).includes('\0');
}

/** Both sides present and different, yet identical once line endings are normalized. */
export function eolOnlyDifference(left: string | null, right: string | null): boolean {
  return (
    left !== null && right !== null && left !== right && normalizeEol(left) === normalizeEol(right)
  );
}

export interface DiffLabels {
  left: string;
  right: string;
}

/**
 * The two column headers for a selection: what each side of the diff IS.
 * Pass `base` / `branch` for a worktree-diff row; a selection without a
 * text diff (a commit's file list, the finish stepper) gets empty labels.
 */
export function diffLabels(
  item: SelectedItem,
  ctx: { base?: string | null; branch?: string | null } = {},
): DiffLabels {
  switch (item.kind) {
    case 'file':
      switch (item.group) {
        case 'staged':
          return { left: 'HEAD', right: 'Index' };
        case 'unstaged':
          return { left: 'Index', right: 'Working tree' };
        case 'untracked':
          return { left: '(none)', right: 'Working tree' };
        case 'conflicted':
          return { left: 'HEAD', right: 'Working tree (with markers)' };
        case 'changed':
          return { left: 'HEAD', right: 'Working tree' };
      }
      break;
    case 'commit':
      return item.path === undefined
        ? { left: '', right: '' }
        : { left: `${shortSha(item.sha)}^`, right: shortSha(item.sha) };
    case 'worktree-diff':
      return { left: ctx.base ?? 'base', right: ctx.branch ?? 'branch' };
    case 'finish':
      return { left: '', right: '' };
  }
  return { left: '', right: '' };
}
