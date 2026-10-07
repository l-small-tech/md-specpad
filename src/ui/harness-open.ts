/**
 * Opening the configured harness in a particular folder — the Themes menu's
 * "Open harness here" and the Help menu's "Open harness in docs".
 *
 * THE APP ONLY OPENS THE HARNESS; IT NEVER FEEDS IT INPUT. Each launch is the
 * equivalent of `cd <folder>` and then the harness's own command line, as the
 * user configured it in Settings: no opening prompt, no model or effort
 * flags, nothing typed into the pty afterwards. `openTerminal` is called with
 * exactly two arguments — the profile and the cwd — and
 * `__tests__/harness-open.test.ts` pins that.
 */

import { HARNESS_PROFILE_ID } from '../core/types';
import { getDocsDir } from './session';
import { harnessAvailabilityStore, harnessInstalled } from './stores/harness-availability';
import { uiStore } from './stores/ui';
import { openTerminal } from './terminal-open';

/**
 * Open the harness as a terminal tab whose working directory is `dir`. With no
 * harness installed there is nothing to launch, so the Harness settings open
 * instead (where every harness has an Install button) — the same fallback the
 * new-tab menu's Harness row uses.
 */
export function openHarnessIn(dir: string): void {
  if (!harnessInstalled(harnessAvailabilityStore.getState())) {
    uiStore.getState().openSettings('harness');
    return;
  }
  openTerminal(HARNESS_PROFILE_ID, dir);
}

/** "Open harness in docs": the harness, standing in the bundled documentation. */
export function openHarnessInDocs(): void {
  const docsDir = getDocsDir();
  if (!docsDir) {
    uiStore.getState().showNotice('Documentation is not available in this build.');
    return;
  }
  openHarnessIn(docsDir);
}
