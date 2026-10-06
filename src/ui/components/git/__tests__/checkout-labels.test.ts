import { describe, expect, it } from 'vitest';
import { checkoutDir, checkoutLabel, checkoutName } from '../shared';

const root = 'C:\\Users\\me\\Workspace\\repo';

describe('checkoutName', () => {
  it('names the main checkout after its folder', () => {
    expect(checkoutName(root, root)).toBe('repo');
    expect(checkoutName('c:/users/me/workspace/repo', root)).toBe('repo');
  });

  it('names a linked worktree after its own folder, not its path', () => {
    expect(checkoutName(`${root}\\.claude\\worktrees\\feat-x`, root)).toBe('feat-x');
    expect(checkoutName('D:/elsewhere/feat-y', root)).toBe('feat-y');
  });
});

describe('checkoutDir', () => {
  it('is empty for the main checkout and for worktrees outside the repo', () => {
    expect(checkoutDir(root, root)).toBe('');
    expect(checkoutDir('D:/elsewhere/feat-y', root)).toBe('');
  });

  it('is the parent folder relative to the main root, with forward slashes', () => {
    expect(checkoutDir(`${root}\\.claude\\worktrees\\feat-x`, root)).toBe('.claude/worktrees');
    expect(checkoutDir(`${root}/worktrees/feat-z`, root)).toBe('worktrees');
  });

  it('rebuilds the relative label when joined with the name', () => {
    const path = `${root}\\.claude\\worktrees\\feat-x`;
    expect(`${checkoutDir(path, root)}/${checkoutName(path, root)}`).toBe(
      checkoutLabel(path, root),
    );
  });
});
