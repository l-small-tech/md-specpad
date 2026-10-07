/**
 * The app only OPENS a harness: the Themes menu's "Open harness here" and the
 * Help menu's "Open harness in docs" pass a profile and a cwd to
 * `openTerminal` and nothing else — no prompt, no `initialInput`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const openTerminal = vi.fn<(profileId?: string, cwd?: string, options?: unknown) => string | null>(
  () => 'tab-1',
);
vi.mock('../terminal-open', () => ({
  openTerminal: (...args: unknown[]) =>
    openTerminal(...(args as [string | undefined, string | undefined, unknown])),
}));
let docsDir: string | null = '/app/docs';
vi.mock('../session', () => ({
  getDocsDir: () => docsDir,
}));
let installed = true;
vi.mock('../stores/harness-availability', () => ({
  harnessAvailabilityStore: { getState: () => ({}) },
  harnessInstalled: () => installed,
}));
const openSettings = vi.fn();
const showNotice = vi.fn();
vi.mock('../stores/ui', () => ({
  uiStore: { getState: () => ({ openSettings, showNotice }) },
}));

import { HARNESS_PROFILE_ID } from '../../core/types';
import { openHarnessIn, openHarnessInDocs } from '../harness-open';

const here = dirname(fileURLToPath(import.meta.url));

describe('harness-open', () => {
  beforeEach(() => {
    openTerminal.mockClear();
    openSettings.mockClear();
    showNotice.mockClear();
    installed = true;
    docsDir = '/app/docs';
  });

  test('the harness in a folder: the harness profile, the cwd, nothing else', () => {
    openHarnessIn('/themes');
    const call = openTerminal.mock.calls[0]!;
    expect(call).toHaveLength(2);
    expect(call).toEqual([HARNESS_PROFILE_ID, '/themes']);
  });

  test('docs: opens in the bundled docs folder', () => {
    openHarnessInDocs();
    expect(openTerminal.mock.calls[0]).toEqual([HARNESS_PROFILE_ID, '/app/docs']);
  });

  test('docs: a build without docs says so and opens nothing', () => {
    docsDir = null;
    openHarnessInDocs();
    expect(openTerminal).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalled();
  });

  test('no harness installed: Settings opens instead of a terminal', () => {
    installed = false;
    openHarnessIn('/themes');
    expect(openTerminal).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledWith('harness');
  });

  test('neither launcher mentions initialInput or a terminal-send action', () => {
    for (const file of ['harness-open.ts', 'theme-actions.ts']) {
      const source = readFileSync(join(here, '..', file), 'utf8');
      expect(source, file).not.toMatch(/initialInput/);
      expect(source, file).not.toMatch(/terminal-send/);
    }
  });
});
