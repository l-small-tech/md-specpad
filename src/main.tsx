import { createRoot } from 'react-dom/client';
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getAllWebviewWindows, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { confirm, message, open, save } from '@tauri-apps/plugin-dialog';
import { nanoid } from 'nanoid';
import { keepWindowLocalSettings, normalizeSettings } from './core/settings';
import { isLiveEditTab, LIVE_EDIT_POLL_MS } from './core/live-edit';
import { pickDropWindow, type DropWindowCandidate } from './core/window-drop';
import type { DocSyncMessage } from './core/doc-sync';
import { parseManifest, type PersistedTab, type SessionManifest } from './core/session/plan-flush';
import { editorFontStack, uiFontStack } from './core/fonts';
import { loadPersistedSettings, savePersistedSettings } from './ipc/settings-store';
// Bundled typefaces (all SIL OFL 1.1). Importing a family only registers its
// @font-face rules — the WebView fetches woff2 data lazily, the first time
// rendered text actually uses that family — so the unchosen fonts cost
// nothing at runtime. Stacks/labels live in core/fonts.ts.
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import '@fontsource/fira-code/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/cascadia-code/400.css';
import '@fontsource/cascadia-code/500.css';
import '@fontsource/cascadia-code/700.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';
import '@fontsource/source-code-pro/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/700.css';
import '@fontsource/inconsolata/400.css';
import '@fontsource/inconsolata/500.css';
import '@fontsource/inconsolata/700.css';
import '@fontsource/victor-mono/400.css';
import '@fontsource/victor-mono/500.css';
import '@fontsource/victor-mono/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import './styles/base.css';
import './styles/themes.css';
import './styles/app.css';
import './styles/preview.css';
import './styles/code-review.css';
import './styles/deck.css';
import './styles/deck-edit.css';
import './styles/voice-comments.css';
import { App } from './ui/App';
import { installLinkGuard } from './ui/link-guard';
import { installContextMenuGuard } from './ui/context-menu-guard';
import { externalLinkStore } from './ui/stores/external-link';
import { DEFAULT_COLOR_SCHEME, type Settings } from './core/types';
import { settingsStore } from './ui/stores/settings';
import { mergeIncomingSettings, sharedSettings, windowThemeStore } from './ui/stores/window-theme';
import { docSync, startDocSync } from './ui/doc-sync';
import { listenPresenter, PRESENTER_LABEL } from './ui/presenter';
import { PresenterView } from './ui/components/PresenterView';
import { tabsStore, tabDisplayTitle } from './ui/stores/tabs';
import { harnessAvailabilityStore } from './ui/stores/harness-availability';
import {
  appendImagesToMd,
  createSessionController,
  importFilesInto,
  type ConfirmDialog,
  type ConfirmRememberDialog,
  type OpenFilesDialog,
  type PickDirectoryDialog,
  type PickFileDialog,
  type SaveDiscardCancelDialog,
  type SaveFileDialog,
  type TabWindowInfo,
} from './ui/session';
import { uiStore } from './ui/stores/ui';
import { listenActiveWorkspace } from './ui/active-workspace';
import { exportPreviewStore } from './ui/stores/export-preview';
import { diagramViewerStore } from './ui/stores/diagram-viewer';
import { imageMimeType, isImagePath } from './core/images';
import { ipc } from './ipc/commands';
import { initProviders } from './ipc/provider';
import { resolveDocsDir, resolvePaths, resolveThemesDir } from './ipc/paths';
import { themeRegistryStore } from './ui/stores/theme-registry';
import { importFilters } from './core/import/registry';
import { themePluginsToCss } from './core/theme-plugins';
import { detectPlatform, keyEventToAction } from './ui/keymap';
import { runShortcutAction } from './ui/commands';
import { installAppGitDeps } from './ui/git-deps';
import { watchGitTabClosures } from './ui/git-open';
import { gitStore } from './ui/stores/git';
import { startWatchingDirs } from './ui/watch-dirs';
import { searchStore } from './ui/stores/search';
import { closeOverview, notesOverviewStore } from './ui/notes-overview';
import { closeWorkspaceInit, workspaceInitStore } from './ui/workspace-init';
import { isAndroid } from './ui/platform';
import { globalCoordsTrusted } from './ui/global-coords';
import { removeBootSplash, restoreStatusText, setBootStatus } from './ui/boot-splash';
import { renderOsGhostPage } from './ui/tab-drag-ghost';
import { escapeFullscreen, leaveOsFullscreenForClose } from './ui/fullscreen';
import { isDark, subscribeDark } from './ui/theme';
import { setBeforeRestart, startAutoUpdateChecks } from './ui/update';
import { whisperSetupStore } from './ui/stores/whisper-setup';
import { watchScrollActivity } from './ui/scroll-activity';

const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
  ...importFilters,
];
const IMAGE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
];

// NOTE: deliberately no <StrictMode>. StrictMode double-invokes effects in dev,
// which fights the "editors are mounted exactly once" architecture (see
// src/ui/README.md). Core logic is covered by Vitest instead.

/* ---- Settings → DOM (theme, ligatures, fonts, editor font size) --------- */

function applyDomSettings(): void {
  const { ligatures, fontSize, editorFont, uiFont, readerMargins, cursorStyle, colorScheme } =
    settingsStore.getState().settings;
  const root = document.documentElement;
  root.dataset.theme = isDark() ? 'dark' : 'light';
  // Palette family — each value (paired with data-theme) maps to the ten color
  // variables via the injected theme-plugin CSS. The built-in System/Light/Dark
  // modes (`colorScheme === 'default'`) render the green built-ins — Light
  // Green in light mode, Dark Green in dark — instead of the plain base.css
  // palette; if those theme files were deleted the id matches no injected
  // block and falls through to base.css anyway.
  root.dataset.colorScheme =
    colorScheme === DEFAULT_COLOR_SCHEME ? (isDark() ? 'dark-green' : 'light-green') : colorScheme;
  root.classList.toggle('no-ligatures', !ligatures);
  root.style.setProperty('--editor-font-size', `${fontSize}px`);
  // Editor/content typeface; the UI chrome either follows it ('match', the
  // base.css default of --font-ui) or gets its own sans stack.
  root.style.setProperty('--font-mono', editorFontStack(editorFont));
  const ui = uiFontStack(uiFont);
  if (ui === null) {
    root.style.removeProperty('--font-ui');
  } else {
    root.style.setProperty('--font-ui', ui);
  }
  // Review-mode margins — preview.css maps each value to a responsive gutter.
  root.dataset.readerMargins = readerMargins;
  // Editor caret style — base.css maps each value to --caret-width (+ underscore geometry).
  root.dataset.cursor = cursorStyle;
}

applyDomSettings();
settingsStore.subscribe(applyDomSettings);

// Scrollbars fade in while their pane scrolls and out when idle (base.css).
watchScrollActivity(document);

/* ---- Smooth scrolling (the engine's; the terminal eases its own) -------- */

// DOM surfaces scroll natively: the webview engine animates wheel scrolls on
// its compositor thread, off the main thread a big CM6 document keeps busy —
// which is why there is deliberately NO JS scroll animation here (one was
// built and removed; it re-implemented the engine's path with main-thread
// jank). The setting flips WebKitGTK's engine switch (a no-op elsewhere —
// WebView2 always smooth-scrolls, macOS has OS momentum) and the terminal's
// own canvas easing (TerminalPane).
let appliedSmoothScrolling: boolean | null = null;

function applySmoothScrolling(): void {
  const enabled = settingsStore.getState().settings.smoothScrolling;
  if (isAndroid() || enabled === appliedSmoothScrolling) {
    return;
  }
  appliedSmoothScrolling = enabled;
  ipc.setSmoothScrolling(enabled).catch(() => {
    // Cosmetic; a failure must never block boot.
  });
}

applySmoothScrolling();
settingsStore.subscribe(applySmoothScrolling);
// Follow the OS live while the setting is "system", and the selected plugin's
// declared mode once the theme registry loads (or reloads).
subscribeDark(applyDomSettings);

// Android: base.css pins the body (position: fixed) under this flag so the
// root scroller can never pan the app shell off screen. Set once — the
// runtime never changes.
if (isAndroid()) {
  document.documentElement.dataset.android = 'true';
}

/* ---- Pluggable themes → injected <style> -------------------------------- */

// The loaded theme plugins are rendered to one <style id="theme-plugins"> whose
// `:root[data-color-scheme='<id>']` blocks work exactly like the old built-in
// styles/themes.css. Re-run on every registry change (e.g. "Reload themes"),
// mirroring how applyDomSettings tracks the settings store. CSP allows this
// inline <style> (style-src 'unsafe-inline'); a linked file would be blocked.
function injectThemeStyles(): void {
  const css = themePluginsToCss(themeRegistryStore.getState().plugins);
  let style = document.getElementById('theme-plugins');
  if (!(style instanceof HTMLStyleElement)) {
    style = document.createElement('style');
    style.id = 'theme-plugins';
    document.head.appendChild(style);
  }
  style.textContent = css;
}

/* ---- Settings persistence (tauri-plugin-store, debounced) ---------------- */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * True while the settings-changed listener is folding a sibling window's
 * broadcast into the store. That replace() fires the persist subscription like
 * any other change, but re-arming the saver here would re-broadcast a snapshot
 * the sender already persisted — and by the time this window's debounce fires,
 * that snapshot is stale: a folder expanded (or any setting changed) in the
 * sending window during the round-trip would be visibly reverted by the
 * boomerang. Zustand notifies synchronously, so a plain flag suffices.
 */
let applyingRemoteSettings = false;

/** Debounced write-through so rapid field edits collapse into one save. */
function persistSettingsDebounced(): void {
  if (applyingRemoteSettings) {
    return;
  }
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // A window-only theme (☰ Menu → Themes, right-click) lives in the settings
    // store like any other theme, but must not leave this window — swap the
    // shared value back in before saving or broadcasting.
    const settings = sharedSettings(
      settingsStore.getState().settings,
      windowThemeStore.getState().override,
    );
    void savePersistedSettings(settings).catch(() => {
      // A failed settings write is non-fatal — the in-memory value still holds
      // for the session; the next change retries.
    });
    // Multi-window: mirror the change into the other windows live (theme, fonts
    // …). `from` lets the receiver drop this window's own echo — the payload is
    // a snapshot from emit time, and folding it back in would clobber any edit
    // made during the event round-trip (a click landing just after the debounce
    // fired would visibly revert). No-op outside a Tauri webview.
    void emit('settings-changed', { from: WINDOW_LABEL, settings }).catch(() => {});
  }, 400);
}

/* ---- Window identity (M8 multi-window) ----------------------------------- */

const appWindow = getCurrentWindow();
/** 'main' for the primary window; 'w-<nanoid>' for torn-off tab windows. */
const WINDOW_LABEL = appWindow.label;
const IS_MAIN_WINDOW = WINDOW_LABEL === 'main';

/**
 * Windows that are not the app proper and hold no tabs: tab-drag ghosts and
 * the presenter view. They are never a drop / "move to window" target and
 * never count as "another window is still open" when one closes.
 */
function isHelperWindow(label: string): boolean {
  return label.startsWith('ghost-') || label === PRESENTER_LABEL;
}

/** Shared construction options so every window looks like the main one. */
const WINDOW_OPTIONS = {
  title: 'MD Specpad',
  width: 900,
  height: 650,
  minWidth: 400,
  minHeight: 300,
  decorations: false,
} as const;

/** Create a window and resolve/reject on Tauri's created/error events. */
function spawnWindow(
  label: string,
  extra: { url?: string; x?: number; y?: number; focus?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = new WebviewWindow(label, { ...WINDOW_OPTIONS, ...extra });
    void w.once('tauri://created', () => resolve());
    void w.once('tauri://error', (e) => reject(new Error(JSON.stringify(e.payload))));
  });
}

/**
 * Tear-off spawner injected into the session controller: the new window gets
 * its one-tab manifest via the URL (small — the tab's content was already
 * flushed to disk, only paths/ids travel) and adopts it during its own boot.
 * Resolves with the window's label — a LIVE tear-off (M8.6) keeps driving the
 * window by label (follow / drop / focus). `focus: false` spawns it unfocused
 * so a live tear-off doesn't yank focus off the still-dragging source window.
 */
async function spawnTabWindow(
  manifest: SessionManifest,
  pos: { x: number; y: number } | null,
  opts?: { focus?: boolean },
): Promise<string> {
  const label = `w-${nanoid(10)}`;
  // The torn-off window inherits this window's active workspace (it would
  // otherwise start on the default Notes workspace). `selectedExplorerDir` is
  // per-window in-memory state, so it travels in the URL like the manifest.
  const ws = uiStore.getState().selectedExplorerDir;
  const wsParam = ws === null ? '' : `&ws=${encodeURIComponent(ws)}`;
  await spawnWindow(label, {
    url: `index.html?adopt=${encodeURIComponent(JSON.stringify(manifest))}${wsParam}`,
    ...(pos ? { x: pos.x, y: pos.y } : {}),
    ...(opts?.focus === false ? { focus: false } : {}),
  });
  return label;
}

/* ---- Cross-window tab drop (M8): who is under the cursor? ---------------- */

/**
 * label → monotonic focus counter, fed by the `window-focused` broadcast every
 * window emits when it gains focus. The drop hit-test uses it to pick the
 * TOPMOST of overlapping candidate windows — the OS won't tell an app its
 * z-order, but among app windows focus recency is z-order for any pair the
 * cursor can reach. Never pruned: a closed window simply stops matching.
 */
const windowFocusOrder = new Map<string, number>();
let windowFocusCounter = 0;

/**
 * The label of the app window under the cursor right now (never this one), or
 * null → the release was over empty desktop (or geometry is untrustworthy /
 * unavailable) and the caller tears off a new window instead. All physical
 * pixels — cursor and bounds come from the same Tauri coordinate space, so no
 * per-window scale factors are mixed in. Gated on ui/global-coords.ts:
 * Wayland's junk coordinates must never pick a window. `excludeLabel` skips
 * one more window — a live tear-off passes the window glued to the cursor,
 * which would otherwise always win the hit-test.
 */
async function findDropWindow(excludeLabel?: string): Promise<string | null> {
  if (!globalCoordsTrusted()) {
    return null;
  }
  let cursor: { x: number; y: number };
  try {
    cursor = await cursorPosition();
  } catch {
    return null;
  }
  const others = (await getAllWebviewWindows()).filter(
    (w) => w.label !== WINDOW_LABEL && w.label !== excludeLabel && !isHelperWindow(w.label),
  );
  const candidates = await Promise.all(
    others.map(async (w): Promise<DropWindowCandidate | null> => {
      try {
        if (await w.isMinimized()) {
          return null;
        }
        const [pos, size] = await Promise.all([w.outerPosition(), w.outerSize()]);
        return {
          label: w.label,
          x: pos.x,
          y: pos.y,
          width: size.width,
          height: size.height,
          focusOrder: windowFocusOrder.get(w.label) ?? 0,
        };
      } catch {
        return null; // closed mid-query — not a candidate
      }
    }),
  );
  return pickDropWindow(
    cursor,
    candidates.filter((c): c is DropWindowCandidate => c !== null),
  );
}

/**
 * Deliver tab descriptors to window `label` over the adopt-tabs / adopt-ack
 * event pair. Resolves true once the receiver acknowledged — it has adopted
 * AND flushed, so its manifest claims the tabs. False on timeout (receiver
 * gone or hung): the caller still owns the tabs. Used by both the drag-drop
 * handover and the closing-window handoff below.
 */
function sendTabsToWindow(
  label: string,
  tabs: PersistedTab[],
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let unlisten: (() => void) | null = null;
    const timer = setTimeout(() => {
      unlisten?.();
      resolve(false);
    }, timeoutMs);
    listen(`adopt-ack-${WINDOW_LABEL}`, () => {
      clearTimeout(timer);
      unlisten?.();
      resolve(true);
    })
      .then((un) => {
        unlisten = un;
        void emitTo(label, 'adopt-tabs', { tabs, from: WINDOW_LABEL }).catch(() => {});
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
}

/**
 * A live tear-off (M8.6) released over another app window: tell the torn-off
 * window `label` — the one that rode the cursor here — to hand its tab to
 * window `target` and close. The torn-off window may still be BOOTING (its
 * listener registers after restore), so the command repeats until the window
 * acks it or the budget runs out; an unserved command just leaves the window
 * standing where it was dropped, still holding the tab — a harmless degrade.
 */
function commandTornWindowDrop(label: string, target: string): void {
  let attempts = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unlisten: (() => void) | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    unlisten?.();
    unlisten = null;
  };
  listen(`torn-drop-ack-${label}`, stop)
    .then((un) => {
      unlisten = un;
      const send = (): void => {
        if (++attempts > 20) {
          stop();
          return;
        }
        void emitTo(label, 'torn-window-drop', { target }).catch(() => {});
      };
      send();
      timer = setInterval(send, 300);
    })
    .catch(() => {});
}

/** Focus the app window labelled `label` (best-effort — it may just have closed). */
function focusWindow(label: string): void {
  void WebviewWindow.getByLabel(label)
    .then((w) => w?.setFocus())
    .catch(() => {});
}

/**
 * The other app windows, labelled for a human: window title minus the app-name
 * suffix (i.e. the window's active tab), most recently focused first. Feeds
 * the tab context menu's "Move to window …" rows — the coordinate-free route
 * into an existing window, which is all Wayland allows (no drop hit-test
 * there) and a keyboard/menu alternative everywhere else.
 */
async function listOtherWindows(): Promise<TabWindowInfo[]> {
  const others = (await getAllWebviewWindows()).filter(
    (w) => w.label !== WINDOW_LABEL && !isHelperWindow(w.label),
  );
  const rows = await Promise.all(
    others.map(async (w): Promise<TabWindowInfo | null> => {
      try {
        const title = await w.title();
        const suffix = ` — ${APP_NAME}`;
        return {
          label: w.label,
          title: title.endsWith(suffix) ? title.slice(0, -suffix.length) : title,
        };
      } catch {
        return null; // closed mid-query
      }
    }),
  );
  return rows
    .filter((r): r is TabWindowInfo => r !== null)
    .sort((a, b) => (windowFocusOrder.get(b.label) ?? 0) - (windowFocusOrder.get(a.label) ?? 0));
}

/* ---- Window title mirrors the active tab -------------------------------- */

let lastWindowTitle = '';

// A dev run (`pnpm run tauri:dev`) serves the frontend from Vite, so import.meta
// .env.DEV is true here but false in the built release. Tag the window/taskbar
// title so a dev instance is obvious next to an installed release (the amber
// icon from tauri.dev.conf.json is the other half of that distinction).
const APP_NAME = import.meta.env.DEV ? 'MD Specpad Dev' : 'MD Specpad';

function applyWindowTitle(): void {
  const active = tabsStore.getState().activeTab();
  const title = active ? `${tabDisplayTitle(active)} — ${APP_NAME}` : APP_NAME;
  if (title === lastWindowTitle) {
    return;
  }
  lastWindowTitle = title;
  // No-op outside a Tauri webview (e.g. `vite` alone); never throw at boot.
  void appWindow.setTitle(title).catch(() => {});
}

/* ---- Session controller (created during boot) --------------------------- */

const confirmDialog: ConfirmDialog = async (msg, title) => {
  try {
    return await confirm(msg, { title, kind: 'warning' });
  } catch {
    // Outside a Tauri webview there is no native dialog; don't block the close.
    return true;
  }
};

const confirmRememberDialog: ConfirmRememberDialog = async (msg, title, labels) => {
  try {
    const result = await message(msg, {
      title,
      kind: 'warning',
      buttons: { yes: labels.confirm, no: labels.never, cancel: 'Cancel' },
    });
    // With custom button labels the plugin resolves with the LABEL string
    // itself, not the 'Yes'/'No'/'Cancel' it returns for default buttons.
    if (result === labels.confirm) {
      return 'confirm';
    }
    if (result === labels.never) {
      return 'never';
    }
    return 'cancel';
  } catch {
    // Outside a Tauri webview there is no native dialog; don't block the close.
    return 'confirm';
  }
};

const openFilesDialog: OpenFilesDialog = async () => {
  try {
    const selected = await open({ multiple: true, filters: MARKDOWN_FILTERS });
    if (!selected) {
      return null;
    }
    return Array.isArray(selected) ? selected : [selected];
  } catch {
    return null;
  }
};

const saveFileDialog: SaveFileDialog = async (suggestedName, filters) => {
  try {
    return await save({ defaultPath: suggestedName, filters: filters ?? MARKDOWN_FILTERS });
  } catch {
    return null;
  }
};

const pickDirectoryDialog: PickDirectoryDialog = async () => {
  try {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === 'string' ? selected : null;
  } catch {
    return null;
  }
};

const pickFileDialog: PickFileDialog = async (kind) => {
  try {
    const selected = await open({
      multiple: false,
      filters: kind === 'image' ? IMAGE_FILTERS : kind === 'import' ? importFilters : undefined,
    });
    return typeof selected === 'string' ? selected : null;
  } catch {
    return null;
  }
};

const saveDiscardCancelDialog: SaveDiscardCancelDialog = async (msg, title) => {
  try {
    const result = await message(msg, {
      title,
      kind: 'warning',
      buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
    });
    if (result === 'Yes') {
      return 'save';
    }
    if (result === 'No') {
      return 'discard';
    }
    return 'cancel';
  } catch {
    // Outside a Tauri webview there is no native dialog; don't block the close.
    return 'discard';
  }
};

/* ---- Global keyboard shortcuts (single listener) ------------------------ */

const platform = detectPlatform(navigator.platform);

window.addEventListener('keydown', (event) => {
  // The presenter window has no tabs and no commands — only its own slide keys.
  if (WINDOW_LABEL === PRESENTER_LABEL) {
    return;
  }
  // Something nearer the event already claimed this key — a focused terminal
  // pane resolving its own shortcut, most of all. Re-running the global
  // dispatcher would fire the action twice.
  if (event.defaultPrevented) {
    return;
  }
  // Escape dismisses the external-link prompt first: it's the most recently
  // summoned surface and the cheapest to get rid of (it decides nothing).
  if (event.key === 'Escape' && externalLinkStore.getState().pending !== null) {
    event.preventDefault();
    externalLinkStore.getState().dismiss();
    return;
  }
  // Escape closes the fullscreen diagram viewer first — it sits on top of
  // everything else (same custom-DOM-modal contract as the dialogs below).
  if (event.key === 'Escape' && diagramViewerStore.getState().open) {
    event.preventDefault();
    diagramViewerStore.getState().close();
    return;
  }
  // Escape closes the export-preview modal (same custom-DOM-modal contract as
  // the settings dialog below).
  if (event.key === 'Escape' && exportPreviewStore.getState().open) {
    event.preventDefault();
    exportPreviewStore.getState().close();
    return;
  }
  // Escape closes the Initialize Workspace dialog, then the status panel.
  if (event.key === 'Escape' && workspaceInitStore.getState().open) {
    event.preventDefault();
    closeWorkspaceInit();
    return;
  }
  // Escape closes the all-review-notes overview (a panel over everything but
  // the dialogs above).
  if (event.key === 'Escape' && notesOverviewStore.getState().open) {
    event.preventDefault();
    closeOverview();
    return;
  }
  // Escape closes the settings modal when it's open (standard modal behavior;
  // the dialog itself is custom DOM, so the one global listener owns this).
  if (event.key === 'Escape' && uiStore.getState().settingsOpen) {
    event.preventDefault();
    uiStore.getState().closeSettings();
    return;
  }
  // Escape closes the distraction-free tap-and-hold menu before it leaves the
  // view — the menu is the innermost thing open.
  if (event.key === 'Escape' && uiStore.getState().fullscreenMenu !== null) {
    event.preventDefault();
    uiStore.getState().closeFullscreenMenu();
    return;
  }
  // Escape leaves the innermost view: distraction-free first (the chrome
  // comes back), then OS full screen. Checked after the settings modal so a
  // dialog opened while chrome-less closes first.
  if (event.key === 'Escape' && escapeFullscreen()) {
    event.preventDefault();
    return;
  }
  const action = keyEventToAction(event, platform);
  if (!action) {
    // Not ours — let CM6 (mod+F search) and the browser handle it.
    return;
  }
  // While the command palette or the search panel is open it owns the
  // keyboard: its input stops propagation for the keys it handles, and
  // anything that still bubbles here must not trigger a global shortcut
  // underneath the overlay.
  if (uiStore.getState().paletteOpen || searchStore.getState().open) {
    return;
  }
  event.preventDefault();
  runShortcutAction(action);
});

/* ---- Boot: settings → paths → restore session → mount → wire lifecycle --- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boot(): Promise<void> {
  // Load persisted settings BEFORE resolving paths so a saved notesDir wins,
  // and before React mounts so the first paint uses the saved theme/font. A
  // corrupt/missing store degrades to defaults via normalizeSettings.
  settingsStore.getState().replace(normalizeSettings(await loadPersistedSettings()));

  // An OS drag-ghost window (`?ghost=1`) is not the app: paint the pill in
  // the saved theme and stop — no settings saver, no session controller, no
  // manifest, no listeners. This branch sits BEFORE the saver is armed so a
  // ghost can never write anything. (Theme plugins still load below-normally
  // for real windows; the ghost keeps the base palette variables, which
  // applyDomSettings has already set from the persisted scheme.)
  const bootParams = new URLSearchParams(window.location.search);
  if (bootParams.get('ghost') === '1') {
    removeBootSplash();
    renderOsGhostPage(bootParams);
    return;
  }

  // Only now arm the debounced saver, so the initial load doesn't echo back a
  // write; every subsequent field edit persists.
  settingsStore.subscribe(persistSettingsDebounced);

  // Install the platform storage provider BEFORE the controller captures
  // currentProvider(): on Android this routes local + synced (SAF) workspaces;
  // desktop stays on the plain local FS.
  initProviders();

  // Load pluggable themes and inject their CSS before mount so the first paint
  // uses the saved color scheme. Seeds the built-in examples on first run.
  await themeRegistryStore.getState().load(await resolveThemesDir());
  injectThemeStyles();
  themeRegistryStore.subscribe(injectThemeStyles);

  // The presenter view (`?presenter=1`, ui/presenter.ts) is not the app
  // either: themed like it, but no session controller, no manifest, no tabs —
  // just the component, fed over events by the window that opened it. It
  // follows theme changes made while a talk is running.
  if (bootParams.get('presenter') === '1') {
    void listen<{ from: string; settings: Settings }>('settings-changed', (event) => {
      applyingRemoteSettings = true;
      try {
        settingsStore.getState().replace(normalizeSettings(event.payload.settings));
      } finally {
        applyingRemoteSettings = false;
      }
    }).catch(() => {});
    installLinkGuard();
    installContextMenuGuard();
    removeBootSplash();
    createRoot(document.getElementById('root')!).render(<PresenterView />);
    return;
  }

  const paths = await resolvePaths(settingsStore.getState().settings);

  // M8: a freshly torn-off window carries its one-tab manifest in the URL
  // (the spawning window flushed the tab's content to disk first).
  const adoptParam = new URLSearchParams(window.location.search).get('adopt');

  // A torn-off window also inherits the source window's active workspace
  // (spawnTabWindow put it in the URL). First-spawn only, like ?adopt=: a
  // restart restores the window via a bare index.html and starts on the
  // default workspace again.
  const wsParam = new URLSearchParams(window.location.search).get('ws');
  if (wsParam !== null) {
    uiStore.getState().setSelectedExplorerDir(wsParam);
  }

  // Creating the controller registers the flush requester and the interactive
  // close handler (used by the keyboard dispatcher and TabBar via ./ui/session).
  const controller = createSessionController({
    paths,
    docsDir: await resolveDocsDir(),
    isMain: IS_MAIN_WINDOW,
    manifestName: IS_MAIN_WINDOW ? 'session.json' : `session-${WINDOW_LABEL}.json`,
    initialManifest: adoptParam ? parseManifest(adoptParam) : null,
    spawnTabWindow,
    findDropWindow,
    commandTornWindowDrop,
    focusWindow,
    // A generous ack budget: the user is watching the drop, and a first-adopt
    // in the target may read note files before it can flush and ack.
    sendTabsToWindow: (label, tabs) => sendTabsToWindow(label, tabs, 4000),
    listOtherWindows,
    confirm: confirmDialog,
    confirmRemember: confirmRememberDialog,
    openDialog: openFilesDialog,
    saveDialog: saveFileDialog,
    saveDiscardCancel: saveDiscardCancelDialog,
    pickDirectory: pickDirectoryDialog,
    pickFile: pickFileDialog,
    onRestoreProgress: (waitingOn) => setBootStatus(restoreStatusText(waitingOn)),
  });

  // The git store's real dependencies (the session facade, the tabs store,
  // the terminal opener), wired before anything can reach a git action; and
  // the repository forget-on-last-tab-close subscription.
  installAppGitDeps({ confirm: confirmDialog });
  watchGitTabClosures();

  // Rebuild the tabs from disk BEFORE React mounts, so the first paint is the
  // restored session, never a flash of an empty Untitled tab.
  setBootStatus(restoreStatusText([]));
  await controller.restore();

  // Bring back the windows that were open last run: every torn-off window left
  // a session-<label>.json behind; the window-state plugin restores each
  // label's last geometry when the window is created.
  if (IS_MAIN_WINDOW) {
    void (async () => {
      let manifestPaths: string[];
      try {
        manifestPaths = await ipc.listSessionManifests(paths.sessionDir);
      } catch {
        return;
      }
      for (const manifestPath of manifestPaths) {
        const name = manifestPath.replaceAll('\\', '/').split('/').pop() ?? '';
        const match = /^session-(w-[A-Za-z0-9_-]+)\.json$/.exec(name);
        if (!match) {
          continue;
        }
        let manifest: SessionManifest | null;
        try {
          manifest = parseManifest((await ipc.readTextFile(manifestPath)).text);
        } catch {
          manifest = null;
        }
        // Corrupt, or nothing but never-flushed empty placeholders → sweep the
        // file instead of resurrecting an empty window forever.
        const meaningful = manifest?.tabs.some(
          (t) => !(t.kind === 'note' && t.notePath === null && t.customTitle === null),
        );
        if (!meaningful) {
          void ipc.deletePath(manifestPath).catch(() => {});
          continue;
        }
        await spawnWindow(match[1]!, { url: 'index.html' }).catch(() => {});
      }
    })();
  }

  applyWindowTitle();
  tabsStore.subscribe(applyWindowTitle);

  // The webview must never navigate: intercept every link click in the app
  // before the browser acts on it (src/ui/link-guard.ts). Installed for the
  // lifetime of the window — nothing ever uninstalls it.
  installLinkGuard();
  // Same shape, same lifetime: the webview's Back / Reload / Inspect menu
  // never appears over app chrome (src/ui/context-menu-guard.ts).
  installContextMenuGuard();
  removeBootSplash();
  createRoot(document.getElementById('root')!).render(<App />);

  // Which harnesses are on PATH — for the Settings dialog's rows, and for the
  // automatic harness choice a fresh install has not made yet.
  // Fire-and-forget AFTER the mount: one async IPC call whose answer nobody
  // is waiting for, so it costs the first paint nothing. A no-op on Android.
  void harnessAvailabilityStore.getState().refresh();

  // First-launch CLI args sit in managed state until the frontend drains
  // them; only the main window exists at that point (see src-tauri/src/lib.rs).
  if (IS_MAIN_WINDOW) {
    void ipc
      .drainStartupFiles()
      .then((files) => (files.length > 0 ? controller.openPaths(files) : undefined))
      .catch(() => {});
  }

  // A second launch of the app from a virtual desktop with no window on it
  // (Windows 11) builds a fresh window instead of yanking the user to the old
  // one — src-tauri/src/lib.rs. Any files that launch carried ride the URL like
  // ?adopt= does: at build time this window had no `open-files` listener yet.
  const openParam = bootParams.get('open');
  if (openParam !== null) {
    const handoffFiles = ((): string[] => {
      try {
        const parsed: unknown = JSON.parse(openParam);
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
      } catch {
        return []; // malformed param — open the window empty, never throw
      }
    })();
    if (handoffFiles.length > 0) {
      void controller.openPaths(handoffFiles).catch(() => {});
    }
  }

  // Android: files from an "Open with"/"Share" intent arrive as content:// URIs
  // held in the androidfs plugin. Drain them at boot (cold-start intent) and on
  // window focus (warm start — a new intent resumes the app). copyInExternal
  // copies each into the notes dir and opens the local copy.
  const drainIncomingUris = (): void => {
    if (!isAndroid()) {
      return;
    }
    void ipc
      .takeIncomingUris()
      .then((uris) => (uris.length > 0 ? controller.openIncoming(uris) : undefined))
      .catch(() => {});
  };
  drainIncomingUris();

  // Watch local workspace roots with OS file events (debounced in Rust) so the
  // explorer refreshes when other apps or sync tools touch a workspace — no
  // polling, no manual refresh needed. Synced (SAF) workspaces can't be
  // watched and keep the manual button; Android skips all of this (the watch
  // command isn't registered there). Re-armed whenever the workspace set, the
  // notes dir, the Live Edit tabs or the open repositories change
  // (`ui/watch-dirs.ts`, which the git store also calls directly).
  if (!isAndroid()) {
    startWatchingDirs();

    // Trailing debounce on top of Rust's: a long burst (sync tool writing many
    // files) still collapses into few re-lists. refreshExplorer is idempotent
    // and cheap when the drawer is closed (the list effect early-returns).
    let fsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let fsChangedRoots: string[] = [];
    void listen<string[]>('fs-changed', (event) => {
      fsChangedRoots = [...fsChangedRoots, ...(event.payload ?? [])];
      if (fsRefreshTimer !== null) {
        clearTimeout(fsRefreshTimer);
      }
      fsRefreshTimer = setTimeout(() => {
        fsRefreshTimer = null;
        const roots = fsChangedRoots;
        fsChangedRoots = [];
        uiStore.getState().refreshExplorer();
        // A change under a watched root may be a working-tree change of an
        // open repository (the git tab's status); the store decides.
        gitStore.getState().onRepoChanged(roots);
        // Live conflict detection: an external write inside a watched
        // workspace (vim in the built-in terminal, a sync client) must raise
        // the banner NOW, not at the next window refocus — before then, a
        // flush or live save could clobber it. Cheap: one stat per open
        // file/note tab; content is read only when an mtime moved, and the
        // probe waits out any in-flight flush so our own writes never flag.
        void controller.checkAllFileConflicts();
      }, 300);
    }).catch(() => {});

    // The watcher's git-specific event: something under a root's `.git`
    // moved (index, HEAD, refs, MERGE_HEAD…). A trailing 500 ms debounce on
    // top of Rust's, since one `git commit` touches several of those.
    let gitChangedTimer: ReturnType<typeof setTimeout> | null = null;
    let gitChangedRoots: string[] = [];
    void listen<string[]>('git-changed', (event) => {
      gitChangedRoots = [...gitChangedRoots, ...(event.payload ?? [])];
      if (gitChangedTimer !== null) {
        clearTimeout(gitChangedTimer);
      }
      gitChangedTimer = setTimeout(() => {
        gitChangedTimer = null;
        const roots = gitChangedRoots;
        gitChangedRoots = [];
        gitStore.getState().onRepoChanged(roots);
      }, 500);
    }).catch(() => {});

    // Live Edit fallback: a cloud drive's virtual volume (Google Drive's G:)
    // does not reliably deliver ReadDirectoryChangesW events, so while any
    // live tab is open, probe on a timer too. One stat + one small read per
    // live tab every few seconds; nothing at all when no tab is live.
    setInterval(() => {
      const { workspaces } = settingsStore.getState().settings;
      if (tabsStore.getState().tabs.some((t) => isLiveEditTab(t, workspaces))) {
        void controller.checkAllFileConflicts();
      }
    }, LIVE_EDIT_POLL_MS);
  }

  // Second-instance argv (user opens a .md while the app runs). Windows close
  // independently, so main may be gone by then — the Rust single-instance
  // callback targets exactly one surviving window (main preferred); every
  // window listens, scoped to its own label.
  void appWindow
    .listen<string[]>('open-files', (event) => {
      void controller.openPaths(event.payload);
    })
    .catch(() => {});

  // A tab dragged (or context-menu-moved) onto this window arrives here.
  // The sender picked this label and emits to it only. Flush before acking so
  // the adopted tabs are on disk before the sender drops its claim; without
  // the ack the sender adopts the tab right back rather than losing it.
  void appWindow
    .listen<{ tabs: PersistedTab[]; from: string }>('adopt-tabs', (event) => {
      void controller
        .adoptTabs(event.payload.tabs)
        .then(() => controller.flushNow())
        .then(() => {
          void emit(`adopt-ack-${event.payload.from}`).catch(() => {});
        })
        .catch(() => {}); // no ack — the sender keeps the tab
      void appWindow.setFocus().catch(() => {});
    })
    .catch(() => {});

  // A LIVE tear-off (M8.6) whose drag released over another app window: the
  // source window (which kept the pointer) commands THIS window — the one
  // that rode the cursor — to hand its tab over and close. Only tear-off
  // windows (spawned with ?adopt=) can ever be targeted, and the sender
  // retries until acked, so ack first, serve once. moveTabToWindow adopts the
  // tab back if the target never acks, in which case the window stays open
  // holding it — the close only happens once nothing but the detach's fresh
  // Untitled placeholder is left.
  if (adoptParam !== null) {
    let tornDropServed = false;
    void appWindow
      .listen<{ target: string }>('torn-window-drop', (event) => {
        void emit(`torn-drop-ack-${WINDOW_LABEL}`).catch(() => {});
        if (tornDropServed) {
          return;
        }
        tornDropServed = true;
        void (async () => {
          for (const id of tabsStore.getState().tabs.map((t) => t.id)) {
            await controller.moveTabToWindow(id, event.payload.target);
          }
          const left = tabsStore.getState().tabs;
          const placeholderOnly = left.every(
            (t) =>
              t.kind === 'note' &&
              t.notePath === null &&
              t.customTitle === null &&
              t.charCount === 0,
          );
          if (placeholderOnly) {
            void appWindow.close().catch(() => {});
          }
        })();
      })
      .catch(() => {});
  }

  // Any window may ask everyone to flush (update-restart does).
  void listen('flush-all', () => {
    void controller.flushNow();
  }).catch(() => {});

  // Focus recency, for the cross-window drop's topmost pick (findDropWindow).
  // Every window broadcasts its own focus; every window records everyone's.
  void listen<{ label: string }>('window-focused', (event) => {
    windowFocusOrder.set(event.payload.label, ++windowFocusCounter);
  }).catch(() => {});

  // "Set active" on a workspace fans out to every window by default (its
  // right-click variant stays local — see ui/active-workspace.ts).
  listenActiveWorkspace();

  // Live settings sync between windows (see persistSettingsDebounced). Our own
  // broadcast comes back too — drop it by label: the payload is a stale
  // snapshot, and this window already has the live value (folding the echo in
  // would revert any setting changed during the round-trip). A window-only
  // theme survives folding a sibling's broadcast via mergeIncomingSettings.
  void listen<{ from: string; settings: Settings }>('settings-changed', (event) => {
    if (event.payload.from === WINDOW_LABEL) {
      return;
    }
    const incoming = normalizeSettings(event.payload.settings);
    const merged = mergeIncomingSettings(incoming, windowThemeStore.getState().override);
    if (merged.override !== windowThemeStore.getState().override) {
      windowThemeStore.getState().set(merged.override);
    }
    // The explorer tree shape (collapsed workspaces / expanded folders) is
    // per-window: keep ours, take everything else the sibling sent.
    merged.settings = keepWindowLocalSettings(merged.settings, settingsStore.getState().settings);
    if (JSON.stringify(merged.settings) !== JSON.stringify(settingsStore.getState().settings)) {
      // Adopt without re-arming our own saver: the sender already persisted
      // this value, and echoing it back 400ms later would boomerang a stale
      // snapshot into any change the sender made in the meantime (the
      // "folder reopens/recollapses itself" race). See applyingRemoteSettings.
      applyingRemoteSettings = true;
      try {
        settingsStore.getState().replace(merged.settings);
      } finally {
        applyingRemoteSettings = false;
      }
    }
  }).catch(() => {});

  // Presenter view: follow slide changes made in the presenter window (or a
  // mirror's show) and feed the presenter its deck — ui/presenter.ts.
  listenPresenter();

  // Tab sync: mirrors of one file (another tab here, or a tab in another
  // window) type into each other live — src/ui/doc-sync.ts. Same echo rule as
  // settings-changed: our own broadcast comes back, drop it by label. The
  // listener is registered BEFORE the hub starts, because starting says
  // `hello` for every restored file tab and the answers must not be missed;
  // a failed listen (no Tauri) still syncs the tabs inside this window.
  void listen<{ from: string; message: DocSyncMessage }>('doc-sync', (event) => {
    if (event.payload.from !== WINDOW_LABEL) {
      docSync.receive(event.payload.message);
    }
  })
    .catch(() => {})
    .then(() => {
      startDocSync((message) => {
        void emit('doc-sync', { from: WINDOW_LABEL, message }).catch(() => {});
      });
    });

  // OS drag-drop into the explorer. Tauri intercepts file drags (HTML5 drop
  // never fires), so hit-test its physical cursor position against the
  // explorer's data-drop-dir attributes: hovering highlights the target
  // workspace/folder, dropping copies the md/image files into it.
  const elementAt = (position: { x: number; y: number }): Element | null => {
    const scale = window.devicePixelRatio || 1;
    return document.elementFromPoint(position.x / scale, position.y / scale);
  };
  const dropDirAt = (position: { x: number; y: number }): string | null =>
    elementAt(position)?.closest('[data-drop-dir]')?.getAttribute('data-drop-dir') ?? null;
  // An md file row also advertises itself as a drop target (data-drop-file):
  // dropping images onto it embeds them at the end of that file instead of
  // copying them into the folder.
  const dropFileAt = (position: { x: number; y: number }): string | null =>
    elementAt(position)?.closest('[data-drop-file]')?.getAttribute('data-drop-file') ?? null;
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'over') {
        // Highlight the md file under the cursor when there is one, else the
        // workspace/folder — same single dropTargetDir drives both highlights.
        uiStore
          .getState()
          .setDropTarget(dropFileAt(payload.position) ?? dropDirAt(payload.position));
      } else if (payload.type === 'drop') {
        const file = dropFileAt(payload.position);
        const dir = dropDirAt(payload.position);
        uiStore.getState().setDropTarget(null);
        // A photo dropped onto an open whiteboard goes to its scan screen
        // rather than into the workspace. The board advertises itself with
        // `data-drop-scan`, the same hit-testing trick the explorer uses, and
        // takes delivery through a custom event so main.tsx needs no handle on
        // the (lazily loaded) draw adapter.
        const board = elementAt(payload.position)?.closest('[data-drop-scan]');
        const photo = payload.paths.find(isImagePath);
        if (board && photo) {
          void ipc
            .readFileBase64(photo)
            .then((base64) => {
              board.dispatchEvent(
                new CustomEvent('wb-drop-photo', {
                  detail: { dataUrl: `data:${imageMimeType(photo)};base64,${base64}` },
                }),
              );
            })
            .catch(() => uiStore.getState().showNotice('That image could not be read.'));
        } else if (file && payload.paths.some(isImagePath)) {
          void appendImagesToMd(file, payload.paths);
        } else if (dir) {
          void importFilesInto(dir, payload.paths);
        } else {
          // Not over the explorer (e.g. the editor area): open as tabs.
          void controller.openPaths(payload.paths);
        }
      } else {
        uiStore.getState().setDropTarget(null);
      }
    })
    .catch(() => {});

  // Flush on blur so a crash after tabbing away still keeps the latest text;
  // re-check open file tabs for external changes when the window regains
  // focus ("on window focus and before every save").
  void appWindow
    .onFocusChanged(({ payload: focused }) => {
      if (focused) {
        // Broadcast for the drop hit-test's focus-recency ranking; our own
        // listener above records it too, like everyone else's.
        void emit('window-focused', { label: WINDOW_LABEL }).catch(() => {});
        void controller.checkAllFileConflicts();
        // The git tab re-asks git too — a commit made in an outside shell,
        // an agent's `git add` clearing a conflict.
        gitStore.getState().onFocus();
        // A warm-start "Open with"/"Share" intent refocuses the window.
        drainIncomingUris();
      } else {
        void controller.flushNow();
      }
    })
    .catch(() => {});

  // Update check (M7): deferred so it can never delay first paint or restore;
  // gated by the weekly schedule (`autoUpdateCheck`, see core/update-schedule);
  // failures are silent inside checkForUpdate. The pre-restart hook flushes
  // every window's session so installing an update costs zero typed text.
  setBeforeRestart(async () => {
    void emit('flush-all').catch(() => {});
    await controller.flushNow();
    await delay(600); // give the other windows a beat to finish their flush
  });
  // The updater/process plugins are desktop-only (mobile updates via the store),
  // so skip the check on Android — otherwise it logs "updater.check not allowed".
  // Also skip in a dev run: it points at the release's endpoint (different
  // identifier) and a "restart to update" prompt makes no sense for `cargo run`.
  if (IS_MAIN_WINDOW && !isAndroid() && !import.meta.env.DEV) {
    setTimeout(() => startAutoUpdateChecks(), 3000);
  }

  // First launch: offer to download the recommended Whisper model, so
  // offline dictation is ready before it is first needed. Once per install
  // (stores/whisper-setup.ts decides), main window only, and deferred like
  // the update check so it never delays first paint.
  if (IS_MAIN_WINDOW) {
    setTimeout(() => void whisperSetupStore.getState().consider(), 2000);
  }

  /**
   * Closing a TORN-OFF window CLOSES its tabs — they are not handed to a
   * surviving window (the adopt-tabs pair stays in use for drag-drop moves
   * only). Note files keep their latest text (a note is a real file in the
   * notes workspace and outlives its tab); unsaved file-buffer edits go away
   * with the window, exactly like a tab close. Ordering is the fix for the
   * resurrection race: the flusher is DISPOSED before the manifest is
   * deleted, so no armed debounce timer or blur-triggered flush (the focus
   * shifting to another window fires one) can rewrite session-<label>.json
   * afterwards and respawn this window at next launch.
   *
   * The one exception is the LAST window standing (ghosts don't count):
   * closing it is quitting the app, and quitting preserves the session —
   * fold the tabs into main's manifest so relaunch opens one window holding
   * everything.
   */
  async function releaseTabsOnClose(): Promise<void> {
    const others = (await getAllWebviewWindows()).filter(
      (w) => w.label !== WINDOW_LABEL && !isHelperWindow(w.label),
    );
    if (others.length === 0) {
      const tabs = await controller.exportTabsForHandoff(); // flushes first
      await controller.dispose();
      if (tabs.length === 0) {
        await controller.discardManifest().catch(() => {});
      } else {
        await controller.bequeathTabsToMain(tabs).catch(() => {});
      }
      return;
    }
    // Latest note text lands on disk before anything is torn down.
    await controller.flushNow();
    // Closing a terminal tab through the store is what kills its shells (the
    // pane's unmount cleanup sends the pty kill) — destroying the webview
    // outright would leave the child processes running until app exit.
    const terminalIds = tabsStore
      .getState()
      .tabs.filter((t) => t.kind === 'terminal')
      .map((t) => t.id);
    for (const id of terminalIds) {
      tabsStore.getState().closeTab(id);
    }
    if (terminalIds.length > 0) {
      await delay(150); // one beat for React to unmount the panes
    }
    await controller.dispose();
    await controller.discardManifest().catch(() => {});
  }

  // Close path: never prompt. Windows close independently — the app exits
  // when the last one is destroyed. Flush what's pending, then destroy.
  void appWindow
    .onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        // Leave OS fullscreen first so the persisted window geometry is the
        // real placement, not the monitor rect (see ui/fullscreen). Bounded:
        // a stuck transition must not hold the close hostage.
        await Promise.race([leaveOsFullscreenForClose(), delay(1500)]);
        if (IS_MAIN_WINDOW) {
          // Main keeps its manifest (session.json), so its tabs — and any
          // still-open secondaries, via theirs — return at next launch.
          // Bounded so a pathological write (disk full) can't hang close.
          await Promise.race([controller.flushNow(), delay(4000)]);
        } else {
          await Promise.race([releaseTabsOnClose(), delay(4000)]);
        }
      } finally {
        await controller.dispose().catch(() => {});
        // The presenter view has nothing to present once the last app window
        // goes — and left open it would keep the app alive with no way in.
        await (async () => {
          const windows = await getAllWebviewWindows();
          if (!windows.some((w) => w.label !== WINDOW_LABEL && !isHelperWindow(w.label))) {
            await windows.find((w) => w.label === PRESENTER_LABEL)?.destroy();
          }
        })().catch(() => {});
        void appWindow.destroy();
      }
    })
    .catch(() => {});
}

boot().catch((error: unknown) => {
  // Before mount this leaves the reason on the splash instead of a blank
  // window; after mount the splash is gone and this is just the log line.
  console.error('[boot] failed', error);
  setBootStatus(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
});
