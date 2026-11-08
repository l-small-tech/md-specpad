/**
 * Pure helpers of the theme-registry store (the store itself is a thin loader
 * around ipc/theme-loader, covered there).
 */
import { describe, expect, test } from 'vitest';
import {
  currentThemeValue,
  exportThemeGroups,
  pairOptions,
  resolveSystemScheme,
  themeSelectionPatch,
} from '../theme-registry';
import type { ThemeMode, ThemePlugin } from '../../../core/theme-plugins';

const plugin = (id: string, mode: ThemeMode, name = id): ThemePlugin => ({
  id,
  name,
  mode,
  branding: { bg: mode === 'light' ? '#fff' : '#000' },
});

const PLUGINS = [
  plugin('vantablack', 'dark', 'Vantablack'),
  plugin('my-theme', 'light', 'My Theme'),
  plugin('light-green', 'light', 'Light Green'),
  plugin('dark-green', 'dark', 'Dark Green'),
  plugin('skylark', 'light', 'Skylark'),
  plugin('my-night', 'dark', 'My Night'),
];

describe('exportThemeGroups', () => {
  test('partitions by declared mode: built-ins in seed order, then user themes — no System entry', () => {
    const groups = exportThemeGroups(PLUGINS);
    expect(groups.map((g) => g.label)).toEqual(['Light', 'Dark']);
    // Built-ins first (seed order), user themes after (alphabetical).
    expect(groups[0]!.options.map((o) => o.value)).toEqual(['light-green', 'skylark', 'my-theme']);
    expect(groups[1]!.options.map((o) => o.value)).toEqual([
      'dark-green',
      'vantablack',
      'my-night',
    ]);
    expect(groups.some((g) => g.options.some((o) => o.value === 'system'))).toBe(false);
  });

  test('a user theme lands in the group its mode declares (no Custom group)', () => {
    const groups = exportThemeGroups([plugin('my-night', 'dark', 'My Night')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Dark');
    expect(groups[0]!.options.map((o) => o.value)).toEqual(['my-night']);
  });

  test('reserved ids are filtered; empty groups are dropped', () => {
    const groups = exportThemeGroups([plugin('monokai', 'dark'), plugin('dark', 'dark')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Dark');
    expect(groups[0]!.options.map((o) => o.value)).toEqual(['monokai']);
    expect(exportThemeGroups([])).toEqual([]);
  });
});

describe('currentThemeValue / themeSelectionPatch', () => {
  test('the default palette shows its appearance mode; a plugin shows its id', () => {
    expect(currentThemeValue({ theme: 'system', colorScheme: 'default' })).toBe('system');
    expect(currentThemeValue({ theme: 'dark', colorScheme: 'default' })).toBe('dark');
    // A selected plugin pins its own mode, so its id wins over the saved mode.
    expect(currentThemeValue({ theme: 'system', colorScheme: 'nord' })).toBe('nord');
  });

  test('the System pair offers one mode per select and resolves to a loaded theme or the green', () => {
    expect(pairOptions(PLUGINS, 'light').map((o) => o.value)).toEqual([
      'light-green',
      'skylark',
      'my-theme',
    ]);
    expect(pairOptions(PLUGINS, 'dark').map((o) => o.value)).toEqual([
      'dark-green',
      'vantablack',
      'my-night',
    ]);
    const pair = { lightScheme: 'skylark', darkScheme: 'my-night' };
    expect(resolveSystemScheme(pair, PLUGINS, 'light')).toBe('skylark');
    expect(resolveSystemScheme(pair, PLUGINS, 'dark')).toBe('my-night');
    // A deleted theme file, or a dark theme named for the light slot: the green.
    expect(resolveSystemScheme({ ...pair, darkScheme: 'gone' }, PLUGINS, 'dark')).toBe(
      'dark-green',
    );
    expect(resolveSystemScheme({ ...pair, lightScheme: 'vantablack' }, PLUGINS, 'light')).toBe(
      'light-green',
    );
  });

  test('picking a mode returns to the default palette; picking a plugin keeps theme=system', () => {
    expect(themeSelectionPatch('system')).toEqual({ theme: 'system', colorScheme: 'default' });
    expect(themeSelectionPatch('dark')).toEqual({ theme: 'dark', colorScheme: 'default' });
    expect(themeSelectionPatch('nord')).toEqual({ theme: 'system', colorScheme: 'nord' });
  });
});
