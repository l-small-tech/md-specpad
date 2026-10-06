import { describe, expect, test } from 'vitest';
import { restoreStatusText } from '../boot-splash';

describe('restoreStatusText', () => {
  test('nothing outstanding is the generic restore line', () => {
    expect(restoreStatusText([])).toBe('Restoring your tabs…');
  });

  test('one file is named', () => {
    expect(restoreStatusText(['notes.md'])).toBe('Waiting for notes.md…');
  });

  test('several files name the first and count the rest', () => {
    expect(restoreStatusText(['a.md', 'b.md', 'c.md'])).toBe('Waiting for a.md and 2 more…');
  });
});
