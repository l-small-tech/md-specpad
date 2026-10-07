/**
 * Every Tauri window call the frontend makes must be granted in
 * src-tauri/capabilities/default.json. A missing grant does not fail loudly:
 * the call rejects at runtime, the try/catch (or `.catch(() => {})`) around
 * it swallows the rejection, and the feature looks wired up but never runs —
 * which is how the resize strips (`startResizeDragging`) shipped dead.
 *
 * This scans the source for the calls instead of trusting a hand-kept list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO = join(__dirname, '../../..');
const SRC = join(REPO, 'src');

interface Capability {
  windows: string[];
  permissions: (string | { identifier: string })[];
}

const capability = JSON.parse(
  readFileSync(join(REPO, 'src-tauri/capabilities/default.json'), 'utf8'),
) as Capability;

const granted = new Set(
  capability.permissions.map((p) => (typeof p === 'string' ? p : p.identifier)),
);

/**
 * The `Window` methods (`@tauri-apps/api/window`, inherited by
 * `WebviewWindow`) that `core:default` does NOT cover — each needs its own
 * `core:window:allow-<kebab-name>`. The read-only getters (`isMaximized`,
 * `outerPosition`, `innerSize`, `title`, …) are in `core:window:default`.
 */
const WINDOW_METHODS_NEEDING_A_GRANT = [
  'center',
  'clearEffects',
  'close',
  'destroy',
  'hide',
  'maximize',
  'minimize',
  'requestUserAttention',
  'setAlwaysOnBottom',
  'setAlwaysOnTop',
  'setBackgroundColor',
  'setBadgeCount',
  'setBadgeLabel',
  'setClosable',
  'setContentProtected',
  'setCursorGrab',
  'setCursorIcon',
  'setCursorPosition',
  'setCursorVisible',
  'setDecorations',
  'setEffects',
  'setEnabled',
  'setFocus',
  'setFocusable',
  'setFullscreen',
  'setIcon',
  'setIgnoreCursorEvents',
  'setMaxSize',
  'setMaximizable',
  'setMinSize',
  'setMinimizable',
  'setOverlayIcon',
  'setPosition',
  'setProgressBar',
  'setResizable',
  'setShadow',
  'setSimpleFullscreen',
  'setSize',
  'setSizeConstraints',
  'setSkipTaskbar',
  'setTheme',
  'setTitle',
  'setTitleBarStyle',
  'setVisibleOnAllWorkspaces',
  'show',
  'startDragging',
  'startResizeDragging',
  'toggleMaximize',
  'unmaximize',
  'unminimize',
];

/** `clearEffects` is the one method whose command is named differently. */
function permissionFor(method: string): string {
  if (method === 'clearEffects') {
    return 'core:window:allow-set-effects';
  }
  return `core:window:allow-${method.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const TAURI_WINDOW_IMPORT = /from\s+['"]@tauri-apps\/api\/(window|webview|webviewWindow)['"]/;

/** Files that talk to a Tauri window, and the grant-needing methods each calls. */
function windowCalls(): Map<string, Set<string>> {
  const calls = new Map<string, Set<string>>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!TAURI_WINDOW_IMPORT.test(text)) {
      continue;
    }
    const used = new Set<string>();
    for (const method of WINDOW_METHODS_NEEDING_A_GRANT) {
      // `.method(` — also across a line break (`void win\n  .setFocus()`).
      if (new RegExp(`\\.\\s*${method}\\s*\\(`).test(text)) {
        used.add(method);
      }
    }
    if (/new\s+WebviewWindow\s*\(/.test(text)) {
      used.add('new WebviewWindow');
    }
    calls.set(relative(REPO, file).replace(/\\/g, '/'), used);
  }
  return calls;
}

function globMatch(pattern: string, label: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
  return re.test(label);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('capabilities/default.json grants every window call in src/', () => {
  const calls = windowCalls();

  test('the scan is not vacuous', () => {
    // If these stop being found, the scan broke — not the app.
    const all = new Set([...calls.values()].flatMap((s) => [...s]));
    expect(all).toContain('startResizeDragging');
    expect(all).toContain('setFocus');
    expect(all).toContain('new WebviewWindow');
    expect([...calls.keys()]).toContain('src/ui/components/ResizeBorders.tsx');
  });

  test('each called method has its core:window permission', () => {
    const missing: string[] = [];
    for (const [file, methods] of calls) {
      for (const method of methods) {
        const permission =
          method === 'new WebviewWindow'
            ? 'core:webview:allow-create-webview-window'
            : permissionFor(method);
        if (!granted.has(permission)) {
          missing.push(`${permission}  (${method} in ${file})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('the capability covers every window label the app creates', () => {
    // main (tauri.conf.json); w-<nanoid> tear-offs and w-<millis> second-
    // instance windows; the presenter view; tab-drag ghosts.
    for (const label of ['main', 'w-a1B2c3D4e5', 'w-1760000000000', 'w-presenter', 'ghost-main']) {
      expect(
        capability.windows.some((pattern) => globMatch(pattern, label)),
        label,
      ).toBe(true);
    }
  });
});
