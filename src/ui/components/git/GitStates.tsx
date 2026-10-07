/**
 * The git tab's whole-panel states: git missing, a folder that is not (or no
 * longer) a repository — with the button that makes it one — git refusing an
 * untrusted (other-owner) repository, and the first-load skeleton.
 */

import { useState } from 'react';
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
      ) : root ? (
        <StartTracking root={root} />
      ) : (
        <p className="git-state-title">This folder is not a git repository.</p>
      )}
      <button type="button" className="git-btn" onClick={() => closeTab(tabId)}>
        Close tab
      </button>
    </div>
  );
}

/**
 * The `not-a-repo` panel: what git is for, in plain words, and one button
 * that runs `git init` here. Written for someone who has never used git as
 * much as for someone who has — the command it runs is named, not hidden.
 */
function StartTracking({ root }: { root: string }) {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await gitStore.getState().initRepo(root);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="git-state-title">This folder isn&apos;t using Git yet.</p>
      <p className="git-state-hint">
        Git saves snapshots of your work as you go, so you can see exactly what changed, undo a
        mistake, and try an idea on a branch without breaking what already works.
      </p>
      <button
        type="button"
        className="git-btn git-btn-accent git-state-cta"
        disabled={busy}
        onClick={() => void start()}
      >
        {busy ? 'Setting up…' : 'Start tracking with Git'}
      </button>
      <p className="git-state-hint git-state-fine">
        Runs <code>git init</code> in <code>{root}</code>. Your files stay exactly as they are, and
        nothing is saved to history until you make your first commit.
      </p>
    </>
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
