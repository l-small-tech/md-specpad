import { describe, expect, test } from 'vitest';
import { headingMarkNativeItems, markAfterPick } from '../heading-mark-menu';

describe('headingMarkNativeItems', () => {
  test('an unmarked heading: one Mark heading submenu, nothing ticked, Clear mark disabled', () => {
    expect(headingMarkNativeItems(null)).toEqual([
      {
        label: 'Mark heading',
        children: [
          { id: 'running', label: 'Running', checked: false },
          { id: 'focus', label: 'Focus', checked: false },
          { id: 'backburner', label: 'Backburner', checked: false },
          { id: 'complete', label: 'Complete', checked: false },
          { separator: true },
          { id: 'clear', label: 'Clear mark', enabled: false },
        ],
      },
    ]);
  });

  test('a marked heading ticks its mark and enables Clear mark', () => {
    const items = headingMarkNativeItems('backburner')[0]!.children!;
    expect(items.find((i) => i.id === 'backburner')?.checked).toBe(true);
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
