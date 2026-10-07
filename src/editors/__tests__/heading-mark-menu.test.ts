import { describe, expect, test } from 'vitest';
import { headingMarkNativeItems, markAfterPick } from '../heading-mark-menu';

describe('headingMarkNativeItems', () => {
  test('an unmarked heading: nothing ticked, Clear mark disabled', () => {
    expect(headingMarkNativeItems(null)).toEqual([
      { id: 'running', label: 'Mark running', checked: false },
      { id: 'complete', label: 'Mark complete', checked: false },
      { separator: true },
      { id: 'clear', label: 'Clear mark', enabled: false },
    ]);
  });

  test('a marked heading ticks its mark and enables Clear mark', () => {
    const items = headingMarkNativeItems('complete');
    expect(items.find((i) => i.id === 'complete')?.checked).toBe(true);
    expect(items.find((i) => i.id === 'running')?.checked).toBe(false);
    expect(items.find((i) => i.id === 'clear')?.enabled).toBe(true);
  });
});

describe('markAfterPick', () => {
  test('picking the checked mark again clears it', () => {
    expect(markAfterPick('running', 'running')).toBeNull();
    expect(markAfterPick('complete', 'complete')).toBeNull();
  });

  test('picking another mark switches to it', () => {
    expect(markAfterPick(null, 'running')).toBe('running');
    expect(markAfterPick('running', 'complete')).toBe('complete');
  });
});
