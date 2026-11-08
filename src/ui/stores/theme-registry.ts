/**
 * Theme-registry store — the loaded pluggable themes (see ipc/theme-loader.ts).
 *
 * Holds the validated `ThemePlugin[]` plus the resolved themes folder. `load`
 * runs once at boot (before React mounts); `reload` re-reads the folder for the
 * Settings "Reload themes" button and after "New theme…". main.tsx subscribes to
 * this store and (re)injects the `<style>` element on every change, exactly the
 * way it subscribes to the settings store for `data-*` attributes — so the store
 * itself stays DOM-free.
 *
 * The built-in `default` scheme is NOT a plugin (it's base.css); the unified
 * Theme picker represents it via the System/Light/Dark modes (see
 * `APPEARANCE_MODES` / `themePluginOptions`). An unknown/deleted `colorScheme`
 * id simply matches no injected block and falls through to the default palette
 * — no guard needed.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { ThemeMode, ThemePlugin } from '../../core/theme-plugins';
import { loadThemePlugins } from '../../ipc/theme-loader';
import { DEFAULT_COLOR_SCHEME, DEFAULT_DARK_SCHEME, DEFAULT_LIGHT_SCHEME } from '../../core/types';
import { BUILT_IN_ORDER } from '../../core/theme-seeds';

export interface ThemeOption {
  value: string;
  label: string;
  /** The plugin's declared mode — partitions the picker into Light / Dark. */
  mode: ThemeMode;
}

export interface ThemeRegistryState {
  plugins: ThemePlugin[];
  themesDir: string | null;
  /** Boot load: remember the folder, read + validate every theme. */
  load: (themesDir: string) => Promise<void>;
  /** Re-read the folder (Settings "Reload themes"); no-op before `load`. */
  reload: () => Promise<void>;
}

export const themeRegistryStore = createStore<ThemeRegistryState>()((set, get) => ({
  plugins: [],
  themesDir: null,
  load: async (themesDir) => {
    set({ themesDir });
    set({ plugins: await loadThemePlugins(themesDir) });
  },
  reload: async () => {
    const { themesDir } = get();
    if (themesDir === null) {
      return;
    }
    set({ plugins: await loadThemePlugins(themesDir) });
  },
}));

export const useThemeRegistry = <T>(selector: (s: ThemeRegistryState) => T): T =>
  useStore(themeRegistryStore, selector);

/**
 * The unified Theme picker (SettingsDialog) is one dropdown. Selecting System
 * uses the adaptive pair (`colorScheme = 'default'`, resolved by
 * `resolveSystemScheme`); selecting a plugin uses that scheme, locked to its
 * declared mode (`theme` stays 'system'; `isDark` reads the plugin). See
 * `themePickerGroups` for the on-screen ordering.
 *
 * Only `system` is offered in the picker now — the forced plain Light/Dark
 * entries were dropped (the adaptive themes cover both looks, and the
 * mode-locked greens force a mood on purpose). `light`/`dark` stay in this
 * list so a previously saved forced mode keeps working (`isAppearanceMode`)
 * and so no theme file can claim those ids (`RESERVED_IDS`); they are simply
 * filtered out of the on-screen groups.
 */
export const APPEARANCE_MODES: ThemeOption[] = [
  { value: 'system', label: 'System', mode: 'light' },
  { value: 'light', label: 'Light', mode: 'light' },
  { value: 'dark', label: 'Dark', mode: 'dark' },
];

const APPEARANCE_MODE_IDS = new Set(APPEARANCE_MODES.map((m) => m.value));

/** Ids a user theme file may never claim: the picker's built-in modes plus
 *  `default`, the id main.tsx always sets for the built-in base.css palette. A
 *  file slugging to any of these is filtered out so it can neither override the
 *  built-in palette nor show up as a redundant, unreachable picker entry. */
const RESERVED_IDS = new Set<string>([...APPEARANCE_MODE_IDS, DEFAULT_COLOR_SCHEME]);

/** Plugin options for the Theme picker; skips ids that collide with the
 *  built-in system/light/dark modes (they'd be unreachable in the dropdown). */
export function themePluginOptions(plugins: readonly ThemePlugin[]): ThemeOption[] {
  return plugins
    .filter((p) => !RESERVED_IDS.has(p.id))
    .map((p) => ({ value: p.id, label: p.name, mode: p.mode }));
}

/** The themes of one mode, for the System pair's Light theme / Dark theme selects. */
export function pairOptions(plugins: readonly ThemePlugin[], mode: ThemeMode): ThemeOption[] {
  const label = mode === 'dark' ? 'Dark' : 'Light';
  return partitionByMode(themePluginOptions(plugins)).find((g) => g.label === label)?.options ?? [];
}

/**
 * The theme id System shows in `mode`: the pair member from Settings when a
 * loaded theme has that id, else the green of that mode (today's look, and
 * what a deleted theme file falls back to).
 */
export function resolveSystemScheme(
  pair: { lightScheme: string; darkScheme: string },
  plugins: readonly ThemePlugin[],
  mode: ThemeMode,
): string {
  const wanted = mode === 'dark' ? pair.darkScheme : pair.lightScheme;
  const fallback = mode === 'dark' ? DEFAULT_DARK_SCHEME : DEFAULT_LIGHT_SCHEME;
  return plugins.some((p) => p.id === wanted && p.mode === mode) ? wanted : fallback;
}

/** A labeled section of the Theme picker; `label: null` renders as a plain,
 *  heading-less group (used for the lone System entry). */
export interface ThemeGroup {
  label: string | null;
  options: ThemeOption[];
}

/** Split picker options into the labeled Light / Dark sections by each
 *  theme's declared `mode`: built-ins first in their seeded order, then
 *  user-authored themes alphabetically. Empty groups are dropped. */
function partitionByMode(pluginOptions: ThemeOption[]): ThemeGroup[] {
  const order = (o: ThemeOption) => {
    const i = BUILT_IN_ORDER.indexOf(o.value);
    return i === -1 ? BUILT_IN_ORDER.length : i;
  };
  const sorted = [...pluginOptions].sort(
    (a, b) => order(a) - order(b) || a.label.localeCompare(b.label),
  );
  return [
    { label: 'Light', options: sorted.filter((o) => o.mode === 'light') },
    { label: 'Dark', options: sorted.filter((o) => o.mode === 'dark') },
  ].filter((group) => group.options.length > 0);
}

/**
 * Labeled option groups for the Theme picker, top → bottom:
 *   1. `System` (the built-in default palette, following the OS mode)
 *   2. `Light` — every theme declaring `mode: 'light'` (built-ins first)
 *   3. `Dark` — every theme declaring `mode: 'dark'` (built-ins first)
 * Empty groups are dropped. The forced plain Light/Dark modes are deliberately
 * absent (see APPEARANCE_MODES).
 */
export function themePickerGroups(plugins: readonly ThemePlugin[]): ThemeGroup[] {
  const system = APPEARANCE_MODES.filter((m) => m.value === 'system');
  return [{ label: null, options: system }, ...partitionByMode(themePluginOptions(plugins))];
}

/**
 * Theme groups for the export-preview dialog: same Light / Dark mode
 * partitioning as `themePickerGroups` but WITHOUT the System entry (an export
 * must name a concrete plugin, whose `mode` decides the export's darkness).
 */
export function exportThemeGroups(plugins: readonly ThemePlugin[]): ThemeGroup[] {
  return partitionByMode(themePluginOptions(plugins));
}

/** True when `value` selects a built-in light/dark mode (vs a plugin id). */
export function isAppearanceMode(value: string): value is 'system' | 'light' | 'dark' {
  return APPEARANCE_MODE_IDS.has(value);
}

/**
 * The picker's current value for a settings pair: the appearance mode while on
 * the built-in default palette, else the plugin id. Both theme surfaces (the
 * ☰ menu's Themes submenu and the Settings dropdown) read through this so they
 * always agree on which entry is checked/selected.
 */
export function currentThemeValue(settings: { theme: string; colorScheme: string }): string {
  return settings.colorScheme === DEFAULT_COLOR_SCHEME ? settings.theme : settings.colorScheme;
}

/**
 * The settings patch a picker choice implies. An appearance mode returns to the
 * built-in palette; a plugin id selects that scheme (`theme` stays 'system' —
 * while a plugin is selected its declared `mode` drives `data-theme`, so the
 * saved appearance mode is irrelevant until the user returns to the default).
 */
export function themeSelectionPatch(value: string): {
  theme: 'system' | 'light' | 'dark';
  colorScheme: string;
} {
  return isAppearanceMode(value)
    ? { theme: value, colorScheme: DEFAULT_COLOR_SCHEME }
    : { theme: 'system', colorScheme: value };
}
