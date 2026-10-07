/**
 * The git tab's whole-panel states: git missing, the folder no longer a
 * repository, git refusing an untrusted (other-owner) repository, and the
 * first-load skeleton.
 */

import { closeTab } from '../../session';
import { gitStore, type RepoUnavailable } from '../../stores/git';

export function GitUnavailable({
  kind,
  root,
  tabId,
}: {
  kind: RepoUnavailable;
  root: string | null;
  tabId: string;
}) {
  return (
    <div className="git-state">
      {kind === 'no-git' ? (
        <>
          <p className="git-state-title">Git was not found on this machine.</p>
          <p className="git-state-hint">
            Install git and make sure it is on your <code>PATH</code>, then reopen this tab.
          </p>
        </>
      ) : kind === 'untrusted' ? (
        <>
          <p className="git-state-title">Git does not trust this repository.</p>
          <p className="git-state-hint">
            The folder is owned by another user account, so git&apos;s <code>safe.directory</code>{' '}
            check refuses it.
          </p>
          {root && (
            <>
              <p className="git-state-hint">
                <code>{root}</code>
              </p>
              <button
                type="button"
                className="git-btn"
                onClick={() => void gitStore.getState().trustFolder(root)}
              >
                Trust repository…
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <p className="git-state-title">This folder is no longer a git repository.</p>
          {root && (
            <p className="git-state-hint">
              <code>{root}</code>
            </p>
          )}
        </>
      )}
      <button type="button" className="git-btn" onClick={() => closeTab(tabId)}>
        Close tab
      </button>
    </div>
  );
}

/** Three quiet bars while the first status is on its way. */
export function GitSkeleton() {
  return (
    <div className="git-skeleton" aria-busy="true" aria-label="Loading">
      <span className="git-skeleton-bar" style={{ width: '62%' }} />
      <span className="git-skeleton-bar" style={{ width: '44%' }} />
      <span className="git-skeleton-bar" style={{ width: '71%' }} />
    </div>
  );
}
