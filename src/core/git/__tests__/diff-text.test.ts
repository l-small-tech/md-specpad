import { describe, expect, test } from 'vitest';
import { diffLabels, eolOnlyDifference, isBinaryText, normalizeEol } from '../diff-text';

describe('diff-text', () => {
  test('normalizeEol folds CRLF and lone CR', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(normalizeEol('plain\n')).toBe('plain\n');
  });

  test('isBinaryText: a NUL in the first 8000 characters', () => {
    expect(isBinaryText('text\0more')).toBe(true);
    expect(isBinaryText('x'.repeat(8000) + '\0')).toBe(false);
    expect(isBinaryText('just text')).toBe(false);
    expect(isBinaryText(null)).toBe(false);
  });

  test('eolOnlyDifference needs both sides, different bytes, same lines', () => {
    expect(eolOnlyDifference('a\r\nb\r\n', 'a\nb\n')).toBe(true);
    expect(eolOnlyDifference('a\nb\n', 'a\nb\n')).toBe(false);
    expect(eolOnlyDifference('a\r\nb\r\n', 'a\nc\n')).toBe(false);
    expect(eolOnlyDifference(null, 'a\n')).toBe(false);
  });

  test('diffLabels per selection', () => {
    expect(diffLabels({ kind: 'file', group: 'staged', path: 'x' })).toEqual({
      left: 'HEAD',
      right: 'Index',
    });
    expect(diffLabels({ kind: 'file', group: 'unstaged', path: 'x' })).toEqual({
      left: 'Index',
      right: 'Working tree',
    });
    expect(diffLabels({ kind: 'file', group: 'untracked', path: 'x' })).toEqual({
      left: '(none)',
      right: 'Working tree',
    });
    expect(diffLabels({ kind: 'file', group: 'changed', path: 'x' })).toEqual({
      left: 'HEAD',
      right: 'Working tree',
    });
    expect(diffLabels({ kind: 'file', group: 'conflicted', path: 'x' })).toEqual({
      left: 'HEAD',
      right: 'Working tree (with markers)',
    });
    expect(diffLabels({ kind: 'commit', sha: '0123456789', path: 'x' })).toEqual({
      left: '0123456^',
      right: '0123456',
    });
    expect(diffLabels({ kind: 'commit', sha: '0123456789' })).toEqual({ left: '', right: '' });
    expect(
      diffLabels({ kind: 'worktree-diff', path: 'p' }, { base: 'development', branch: 'feat/x' }),
    ).toEqual({ left: 'development', right: 'feat/x' });
    expect(diffLabels({ kind: 'worktree-diff', path: 'p' })).toEqual({
      left: 'base',
      right: 'branch',
    });
    expect(diffLabels({ kind: 'finish' })).toEqual({ left: '', right: '' });
  });
});
