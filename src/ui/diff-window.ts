/**
 * Diff window — a DiffView in a window of its own (the diff header's "Open
 * in a new window" button), for reading a diff bigger than the pane it came
 * from. Same shape as the presenter view (ui/presenter.ts):
 *
 *   - `diff-content` — the two texts and their labels, sent to the diff
 *     window by the window that opened it, and again whenever the diff it
 *     came from changes (the git tab picking another file: the window
 *     follows), and whenever the diff window says `diff-ready`.
 *   - `diff-claim` — another app window took the diff window over: stop
 *     feeding it from here.
 *
 * The window renders `DiffWindowView` (main.tsx's `?diff=1` boot branch): no
 * session controller, no tabs. ONE fixed label, so there is one per app;
 * `w-*` already covers it in the capability files.
 */

import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { uiStore } from './stores/ui';

export const DIFF_WINDOW_LABEL = 'w-diff';
export const DIFF_CONTENT_EVENT = 'diff-content';
export const DIFF_READY_EVENT = 'diff-ready';
const CLAIM_EVENT = 'diff-claim';

/** Everything a DiffView needs, as plain data. */
export interface DiffWindowContent {
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
  path: string | null;
  notice: string | null;
}

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return 'main'; // outside a Tauri webview (tests)
  }
}

/** True inside the diff window itself (no "open in a new window" there). */
export function isDiffWindow(): boolean {
  return windowLabel() === DIFF_WINDOW_LABEL;
}

/* ---- Feeding the diff window ------------------------------------------- */

/** The DiffView (by its follow key) the diff window shows, and what it sent. */
let source: { key: string; content: DiffWindowContent } | null = null;

function send(): void {
  if (source) {
    void emitTo(DIFF_WINDOW_LABEL, DIFF_CONTENT_EVENT, source.content).catch(() => {});
  }
}

/** True while the diff window shows the DiffView with follow key `key`. */
export function isDiffWindowSource(key: string): boolean {
  return source?.key === key;
}

/** The followed DiffView's texts changed: show the new ones over there too. */
export function updateDiffWindow(key: string, content: DiffWindowContent): void {
  if (source?.key !== key) {
    return;
  }
  source = { key, content };
  send();
}

/**
 * Show `content` in the diff window — opening it, or re-pointing and
 * focusing the one already open. `key` names the DiffView it came from, so
 * later changes there follow (see {@link updateDiffWindow}).
 */
export async function openDiffWindow(key: string, content: DiffWindowContent): Promise<void> {
  source = { key, content };
  void emit(CLAIM_EVENT, { from: windowLabel() }).catch(() => {});
  try {
    const existing = await WebviewWindow.getByLabel(DIFF_WINDOW_LABEL);
    if (existing) {
      send();
      await existing.setFocus();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const w = new WebviewWindow(DIFF_WINDOW_LABEL, {
        url: 'index.html?diff=1',
        title: 'Diff — MD Specpad',
        width: 1280,
        height: 820,
        minWidth: 560,
        minHeight: 320,
      });
      void w.once('tauri://created', () => resolve());
      void w.once('tauri://error', (e) => reject(new Error(JSON.stringify(e.payload))));
      void w.once('tauri://destroyed', () => {
        source = null;
      });
    });
  } catch (error) {
    source = null;
    uiStore.getState().showNotice('Could not open the diff window.');
    console.error('[diff-window] open failed', error);
  }
}

/**
 * App windows, once at boot (main.tsx): answer a diff window that just
 * mounted, and stop feeding it when another window claims it.
 */
export function listenDiffWindow(): void {
  const self = windowLabel();
  void listen(DIFF_READY_EVENT, () => send()).catch(() => {});
  void listen<{ from: string }>(CLAIM_EVENT, (event) => {
    if (event.payload.from !== self) {
      source = null;
    }
  }).catch(() => {});
}
