/**
 * The automatic update check's wiring: that the weekly gate is actually
 * consulted before the network call, that a reached endpoint restarts the
 * weekly clock (and a failed one does NOT), and that nothing ever installs
 * without a click.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const check = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }));
const relaunch = vi.fn();
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));

import { DEFAULT_SETTINGS } from '../../core/settings';
import { settingsStore } from '../stores/settings';
import { uiStore } from '../stores/ui';
import {
  checkForUpdate,
  checkForUpdateIfDue,
  downloadAndInstall,
  setBeforeRestart,
  updateStore,
} from '../update';

// 2026-09-02 is a Wednesday; 2026-08-30 the Sunday that opened its week.
const WEDNESDAY = new Date(2026, 8, 2, 15, 0).getTime();
const LAST_MONDAY = new Date(2026, 7, 31, 8, 0).getTime();

beforeEach(() => {
  check.mockReset().mockResolvedValue(null);
  settingsStore.getState().replace({ ...DEFAULT_SETTINGS });
  updateStore.setState({ phase: 'idle', version: null });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const settings = () => settingsStore.getState().settings;

describe('checkForUpdateIfDue', () => {
  test('checks (and stamps) when the setting is on and none has run', async () => {
    await checkForUpdateIfDue(WEDNESDAY);
    expect(check).toHaveBeenCalledTimes(1);
    expect(settings().lastUpdateCheck).not.toBeNull();
  });

  test('does nothing at all when automatic checks are off', async () => {
    settingsStore.getState().update({ autoUpdateCheck: false });
    await checkForUpdateIfDue(WEDNESDAY);
    expect(check).not.toHaveBeenCalled();
    expect(settings().lastUpdateCheck).toBeNull();
  });

  test('does nothing when one already ran this week', async () => {
    settingsStore.getState().update({ lastUpdateCheck: LAST_MONDAY });
    await checkForUpdateIfDue(WEDNESDAY);
    expect(check).not.toHaveBeenCalled();
    expect(settings().lastUpdateCheck).toBe(LAST_MONDAY);
  });

  test('an available update only INFORMS — the chip lights, nothing installs', async () => {
    const downloadAndInstall = vi.fn();
    check.mockResolvedValue({ version: '9.9.9', downloadAndInstall });
    await checkForUpdateIfDue(WEDNESDAY);
    expect(updateStore.getState()).toEqual({ phase: 'available', version: '9.9.9' });
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });

  test('a failed check leaves the stamp alone so the next launch retries', async () => {
    check.mockRejectedValue(new Error('offline'));
    await checkForUpdateIfDue(WEDNESDAY);
    expect(check).toHaveBeenCalledTimes(1);
    expect(settings().lastUpdateCheck).toBeNull();
    // Automatic failures are silent: no notice, no error phase.
    expect(updateStore.getState().phase).toBe('idle');
    expect(uiStore.getState().notice).toBeNull();
  });
});

describe('checkForUpdate (manual)', () => {
  test('runs regardless of the schedule, and stamps it too', async () => {
    settingsStore.getState().update({ autoUpdateCheck: false, lastUpdateCheck: LAST_MONDAY });
    await checkForUpdate({ manual: true });
    expect(check).toHaveBeenCalledTimes(1);
    expect(settings().lastUpdateCheck).not.toBe(LAST_MONDAY);
  });
});

describe('downloadAndInstall', () => {
  async function installable() {
    const install = vi.fn().mockResolvedValue(undefined);
    check.mockResolvedValue({ version: '9.9.9', downloadAndInstall: install });
    await checkForUpdate({ manual: false });
    relaunch.mockReset().mockResolvedValue(undefined);
    return install;
  }

  test('relaunches once the pre-restart flush saved the session', async () => {
    await installable();
    setBeforeRestart(async () => true);
    await downloadAndInstall();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  test('a session that could not be saved holds the relaunch — nothing in memory is thrown away', async () => {
    const install = await installable();
    setBeforeRestart(async () => false);
    await downloadAndInstall();
    expect(install).toHaveBeenCalledOnce();
    expect(relaunch).not.toHaveBeenCalled();
    expect(updateStore.getState().phase).toBe('available');
    expect(uiStore.getState().notice).toMatch(/did not restart/);
  });
});
