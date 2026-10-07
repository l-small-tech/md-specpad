/**
 * Theme actions — the side-effecting half of the theme picker, shared by the
 * ☰ menu's Themes submenu (the primary surface) and the Settings dropdown.
 *
 * Kept out of both components so the two can't drift: selecting a theme,
 * opening the harness in the themes folder, reloading the folder, and opening the themes
 * guide all live here. The pure "which entry is
 * current / what does this choice mean" logic stays in stores/theme-registry.
 */

import { ensureThemesAgentGuide } from '../ipc/theme-loader';
import { openHarnessIn } from './harness-open';
import { openDocs } from './session';
import { settingsStore } from './stores/settings';
import { themeRegistryStore, themeSelectionPatch } from './stores/theme-registry';
import { themeSelectionOf, windowThemeStore } from './stores/window-theme';

/**
 * Apply a picker choice (appearance mode or plugin id) to the settings.
 *
 * `windowOnly` pins the choice to this window instead of changing it
 * everywhere — the settings store still carries it (every consumer reads the
 * theme from there), but main.tsx neither persists nor broadcasts it, and a
 * sibling window's theme no longer reaches us. See stores/window-theme.
 */
export function selectTheme(value: string, windowOnly = false): void {
  const settings = settingsStore.getState();
  const { override } = windowThemeStore.getState();
  const local = themeSelectionPatch(value);
  if (windowOnly) {
    // While a pin is already active the settings store holds the LOCAL theme,
    // so the shared one to preserve is the override's, not the store's.
    const shared = override?.shared ?? themeSelectionOf(settings.settings);
    windowThemeStore.getState().set({ local, shared });
  } else {
    windowThemeStore.getState().set(null);
  }
  settings.update(local);
}

/** Pin the theme this window currently shows, without changing it. */
export function pinThemeToWindow(): void {
  const current = themeSelectionOf(settingsStore.getState().settings);
  windowThemeStore.getState().set({ local: current, shared: current });
}

/** Drop the pin: follow the shared, all-windows theme again. */
export function unpinThemeFromWindow(): void {
  const { override, set } = windowThemeStore.getState();
  if (!override) {
    return;
  }
  set(null);
  settingsStore.getState().update(override.shared);
}

/**
 * "Open harness here" — the configured harness, started in the themes folder
 * and handed nothing (see ui/harness-open.ts). The folder's AGENTS.md guide is
 * (re)written first, so a harness that reads AGENTS.md on its own finds the
 * file format and the reload step there.
 */
export async function openHarnessInThemes(): Promise<void> {
  const { themesDir } = themeRegistryStore.getState();
  if (!themesDir) {
    return;
  }
  await ensureThemesAgentGuide(themesDir);
  openHarnessIn(themesDir);
}

/** Re-read the themes folder after the user edited or added files. */
export async function reloadThemes(): Promise<void> {
  await themeRegistryStore.getState().reload();
}

/** "Help" — open the bundled themes guide (how to author a theme file). */
export function openThemesHelp(): void {
  openDocs('themes.md');
}
