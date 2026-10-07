import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { spawnedWindowChrome, type WindowChrome } from '../window-chrome';

/** The main window as one Tauri config file declares it. */
function mainWindow(file: string): Record<string, unknown> {
  const config = JSON.parse(readFileSync(join(__dirname, '../../../src-tauri', file), 'utf8')) as {
    app: { windows: Record<string, unknown>[] };
  };
  const main = config.app.windows.find((w) => w.label === 'main');
  if (!main) {
    throw new Error(`no "main" window in ${file}`);
  }
  return main;
}

/** Every window-config key that changes what the frame looks like or does. */
const CHROME_KEYS = [
  'decorations',
  'titleBarStyle',
  'hiddenTitle',
  'trafficLightPosition',
  'transparent',
  'shadow',
] as const;

/**
 * The chrome keys a config sets, normalized the way Tauri reads them:
 * `titleBarStyle` is matched case-insensitively ("Overlay" in the JSON is
 * `'overlay'` in the JS API), and `decorations` defaults to true.
 */
function chromeOf(window: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { decorations: true };
  for (const k of CHROME_KEYS) {
    const v = window[k];
    if (v !== undefined) {
      out[k] = k === 'titleBarStyle' && typeof v === 'string' ? v.toLowerCase() : v;
    }
  }
  return out;
}

function normalize(chrome: WindowChrome): Record<string, unknown> {
  return chromeOf(chrome as unknown as Record<string, unknown>);
}

describe('spawnedWindowChrome — new windows look like the main one', () => {
  test('Windows/Linux: the tauri.conf.json main window (undecorated, the TabBar is the titlebar)', () => {
    expect(normalize(spawnedWindowChrome('other'))).toEqual(
      chromeOf(mainWindow('tauri.conf.json')),
    );
    expect(spawnedWindowChrome('other').decorations).toBe(false);
  });

  test('macOS: the tauri.macos.conf.json main window (native frame, overlay title bar)', () => {
    expect(normalize(spawnedWindowChrome('mac'))).toEqual(
      chromeOf(mainWindow('tauri.macos.conf.json')),
    );
    // Without a native frame a mac window has no traffic lights and no
    // resizable edge: ResizeBorders and WindowControls are not rendered there.
    expect(spawnedWindowChrome('mac').decorations).toBe(true);
  });
});
