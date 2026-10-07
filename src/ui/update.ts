/**
 * Update checker (M7) — a thin controller around @tauri-apps/plugin-updater.
 *
 * Policy: check on demand from Settings, plus an automatic check at most once
 * a week on/after Sunday (`autoUpdateCheck`, default on — the schedule itself
 * is pure and lives in `core/update-schedule.ts`). Nothing installs on its
 * own: an available update shows an unobtrusive status-bar chip and an
 * **Update now** button in Settings; clicking either downloads and installs,
 * then relaunches via plugin-process. Errors are SILENT (console
 * only) — the updater must never block or delay startup, and a notepad must
 * never nag. The plugins are imported dynamically so the startup path stays
 * lean and the module keeps working (as a no-op) outside a Tauri webview.
 *
 * The relaunch is preceded by an injected `beforeRestart` hook — main.tsx
 * wires it to the session controller's flushNow(), so restarting for an
 * update can never cost typed text (I3/I4 still hold: it's the same flush).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { isUpdateCheckDue, UPDATE_CHECK_POLL_MS } from '../core/update-schedule';
import { settingsStore } from './stores/settings';
import { uiStore } from './stores/ui';

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** Version string of the available update (e.g. "0.2.0"), when known. */
  version: string | null;
}

export const updateStore = createStore<UpdateState>()(() => ({
  phase: 'idle',
  version: null,
}));

export const useUpdateStore = <T>(selector: (s: UpdateState) => T): T =>
  useStore(updateStore, selector);

let beforeRestart: () => Promise<void> = () => Promise.resolve();

/** main.tsx injects the pre-restart flush so an update never loses typing. */
export function setBeforeRestart(hook: () => Promise<void>): void {
  beforeRestart = hook;
}

// The Update object from check() is kept module-local (it holds a native
// resource handle); the store only carries renderable state.
type PendingUpdate = import('@tauri-apps/plugin-updater').Update;
let pending: PendingUpdate | null = null;

/**
 * Check for an update. `manual` checks (Settings button) surface their
 * outcome as a status-bar notice; the automatic weekly check is silent
 * unless an update is actually available. Either way, a check that reached
 * the endpoint stamps `lastUpdateCheck`, which is what paces the weekly one.
 */
export async function checkForUpdate(opts: { manual: boolean }): Promise<void> {
  const { phase } = updateStore.getState();
  if (phase === 'downloading' || phase === 'checking') {
    return;
  }
  updateStore.setState({ phase: 'checking' });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    // Only a check that actually REACHED the endpoint restarts the weekly
    // clock; a failed one leaves the stamp so the next launch retries.
    settingsStore.getState().update({ lastUpdateCheck: Date.now() });
    if (update) {
      pending = update;
      updateStore.setState({ phase: 'available', version: update.version });
      return;
    }
    pending = null;
    updateStore.setState({ phase: 'idle', version: null });
    if (opts.manual) {
      uiStore.getState().showNotice('MD Specpad is up to date.');
    }
  } catch (err) {
    // Silent by design: no network, no release yet, or not a Tauri webview.
    console.warn('update check failed', err);
    updateStore.setState({ phase: opts.manual ? 'error' : 'idle', version: null });
    if (opts.manual) {
      uiStore.getState().showNotice('Could not check for updates.');
    }
  }
}

/**
 * Run the automatic check IF the weekly schedule says one is due
 * (`core/update-schedule.ts` owns that decision). Silent either way — it
 * never nags and never installs; an available update simply lights the
 * status-bar chip and the Settings dialog's Update button.
 */
export async function checkForUpdateIfDue(now = Date.now()): Promise<void> {
  const { autoUpdateCheck, lastUpdateCheck } = settingsStore.getState().settings;
  if (!isUpdateCheckDue({ enabled: autoUpdateCheck, lastCheck: lastUpdateCheck, now })) {
    return;
  }
  await checkForUpdate({ manual: false });
}

/**
 * Arm the automatic checks for this window: one on launch, then a slow poll so
 * a window left open across the Sunday boundary (or one whose setting is
 * switched back on) becomes due without a restart. Main window only — see the
 * call site in main.tsx. Returns a disposer.
 */
export function startAutoUpdateChecks(): () => void {
  void checkForUpdateIfDue();
  const timer = setInterval(() => void checkForUpdateIfDue(), UPDATE_CHECK_POLL_MS);
  return () => clearInterval(timer);
}

/** Chip click: download + install, flush the session, relaunch. */
export async function downloadAndInstall(): Promise<void> {
  const update = pending;
  if (!update || updateStore.getState().phase === 'downloading') {
    return;
  }
  updateStore.setState({ phase: 'downloading' });
  try {
    await update.downloadAndInstall();
    await beforeRestart().catch(() => {});
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    console.warn('update install failed', err);
    updateStore.setState({ phase: 'available' });
    uiStore.getState().showNotice('Update failed to install — will retry next launch.');
  }
}
