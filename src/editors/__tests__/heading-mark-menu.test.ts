import { describe, expect, test } from 'vitest';
import { headingMarkNativeItems } from '../heading-mark-menu';

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
