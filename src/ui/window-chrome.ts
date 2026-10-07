/**
 * The frame every app window the frontend spawns (torn-off tabs, mod+N) must
 * share with the main window, per platform. The main window's frame comes
 * from config — `tauri.conf.json` (no native decorations: the TabBar is the
 * titlebar, WindowControls and ResizeBorders stand in for the OS ones) and,
 * on macOS, `tauri.macos.conf.json` (the native frame with an overlay title
 * bar: traffic lights over the TabBar, which `.tabbar-mac` insets past) —
 * but a window built at runtime gets none of that, so it is restated here.
 *
 * Keep it in step with those two files; `__tests__/window-chrome.test.ts`
 * reads them and fails when they drift. The Rust side builds its windows
 * from the main window's config directly (lib.rs `handle_second_instance`).
 *
 * The presenter view and the tab-drag ghost are deliberately different
 * (a native frame everywhere / no frame at all) and do not use this.
 */

import type { Platform } from './keymap';

export interface WindowChrome {
  decorations: boolean;
  titleBarStyle?: 'visible' | 'transparent' | 'overlay';
  hiddenTitle?: boolean;
}

export function spawnedWindowChrome(platform: Platform): WindowChrome {
  // On macOS WindowControls and ResizeBorders are not rendered, so without
  // the native frame a window has no traffic lights (close / minimize /
  // zoom) and no resizable edge — only the TabBar's drag region.
  return platform === 'mac'
    ? { decorations: true, titleBarStyle: 'overlay', hiddenTitle: true }
    : { decorations: false };
}
