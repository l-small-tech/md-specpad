/**
 * The boot splash — static markup in index.html shown while `boot()` restores
 * the session before React mounts. These helpers only update or remove it;
 * once removed every call is a no-op.
 */

/** Set the splash's detail line (what boot is waiting on). */
export function setBootStatus(text: string): void {
  const detail = document.getElementById('boot-splash-detail');
  if (detail) {
    detail.textContent = text;
  }
}

/** The detail line for the files a restore is still reading. */
export function restoreStatusText(waitingOn: string[]): string {
  const [first] = waitingOn;
  if (first === undefined) {
    return 'Restoring your tabs…';
  }
  const more = waitingOn.length - 1;
  return more > 0 ? `Waiting for ${first} and ${more} more…` : `Waiting for ${first}…`;
}

/** Take the splash down (just before React mounts, or for a non-app page). */
export function removeBootSplash(): void {
  document.getElementById('boot-splash')?.remove();
}
