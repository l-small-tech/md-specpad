/**
 * GitStatusBar — what the status bar holds while a git tab is active, in
 * the room the mode segments leave empty: the branch button (its upstream,
 * ahead/behind, and the state chip), which opens the BranchPicker above
 * it; Fetch / Pull / Push ("Publish" when the branch has no upstream yet,
 * a count badge when there is something to push or pull); Refresh; and the
 * last error. Every click is a store action; fetch / pull / push stream into
 * the tab's OutputDrawer.
 */

import { useState } from 'react';
import type { GitRepoState } from '../../../core/git/types';
import { gitStore, repoKey, useGitStore } from '../../stores/git';
import { BranchPicker } from './BranchPicker';
import { anchorFor, type MenuAnchor } from './GitMenu';
import { Icon, Spinner } from './icons';
import { shortSha, useRepoSlice } from './shared';

function stateChip(state: GitRepoState): { text: string; hint: string } | null {
  switch (state) {
    case 'merging':
      return { text: 'Merging', hint: 'A merge is in progress — see Merge conflicts in the tab' };
    case 'rebasing':
      return { text: 'Rebasing', hint: 'A rebase is in progress — finish it in a terminal' };
    case 'cherry-picking':
      return { text: 'Cherry-picking', hint: 'Finish it in a terminal' };
    case 'reverting':
      return { text: 'Reverting', hint: 'Finish it in a terminal' };
    case 'bisecting':
      return { text: 'Bisecting', hint: 'Finish it in a terminal' };
    default:
      return null;
  }
}

export function GitStatusBar({ root }: { root: string }) {
  const unavailable = useGitStore((s) => s.repos[repoKey(root)]?.unavailable ?? null);
  const status = useRepoSlice(root, (r) => r.status) ?? null;
  const loading = useRepoSlice(root, (r) => r.loading);
  const op = useRepoSlice(root, (r) => r.op) ?? null;
  const error = useRepoSlice(root, (r) => r.error) ?? null;
  const [picker, setPicker] = useState<MenuAnchor | null>(null);
  const actions = gitStore.getState();

  if (unavailable !== null) {
    return null;
  }
  const busy =
    op?.running === true ||
    (loading !== undefined && (loading.status || loading.branches || loading.worktrees));
  const noUpstream = status !== null && status.upstream === null && !status.unborn;
  const chip = status ? stateChip(status.state) : null;
  const detached = status !== null && status.branch === null && !status.unborn;
  const branchText =
    status === null
      ? '…'
      : status.unborn
        ? 'no commits yet'
        : (status.branch ?? `${shortSha(status.head)} detached`);
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const netDisabled = status === null || op?.running === true || status.unborn;

  return (
    <div className="git-sb" role="group" aria-label="Git">
      <button
        type="button"
        className={`git-sb-branch${detached ? ' is-detached' : ''}`}
        title={
          status?.upstream
            ? `${branchText} → ${status.upstream}\nClick to switch or create a branch`
            : 'The checked-out branch — click to switch or create one'
        }
        disabled={status === null}
        onClick={(e) => setPicker(anchorFor(e.currentTarget, 'up'))}
      >
        <Icon name="branch" />
        <span className="git-sb-branch-name">{branchText}</span>
        {status?.upstream && (
          <span className="git-sb-upstream">
            <Icon name="cloud" />
            {status.upstream}
          </span>
        )}
        <Icon name="chevron-up" className="git-sb-caret" />
      </button>
      {chip && (
        <span className="git-chip git-chip-state" title={chip.hint}>
          {chip.text}
        </span>
      )}
      <span className="git-sb-sep" />
      <button
        type="button"
        className="git-sb-btn"
        title="Fetch — git fetch --all --prune"
        disabled={status === null || op?.running === true}
        onClick={() => void actions.fetch(root, { prune: true })}
      >
        <Icon name="cloud-down" />
        Fetch
      </button>
      <button
        type="button"
        className={`git-sb-btn${behind > 0 ? ' has-work' : ''}`}
        title={
          noUpstream
            ? 'No upstream to pull from'
            : `Pull — git pull (merge, never rebase)${behind > 0 ? ` · ${behind} behind` : ''}`
        }
        disabled={netDisabled || noUpstream}
        onClick={() => void actions.pull(root)}
      >
        <Icon name="download" />
        Pull
        {behind > 0 && <span className="git-sb-badge">{behind}</span>}
      </button>
      <button
        type="button"
        className={`git-sb-btn${noUpstream ? ' is-accent' : ahead > 0 ? ' has-work' : ''}`}
        title={
          noUpstream
            ? 'Publish — git push -u origin HEAD: publish this branch and track it'
            : `Push — git push${ahead > 0 ? ` · ${ahead} ahead` : ''}`
        }
        disabled={netDisabled}
        onClick={() => void actions.push(root, noUpstream ? { setUpstream: true } : undefined)}
      >
        <Icon name="upload" />
        {noUpstream ? 'Publish' : 'Push'}
        {!noUpstream && ahead > 0 && <span className="git-sb-badge">{ahead}</span>}
      </button>
      <button
        type="button"
        className="git-sb-btn is-icon"
        title="Refresh"
        aria-label="Refresh"
        disabled={busy}
        onClick={() => void actions.refresh(root, { force: true })}
      >
        {busy ? <Spinner title="Git is working" /> : <Icon name="refresh" />}
      </button>
      {error && (
        <span className="git-sb-error" title={`${error.code}: ${error.message}`}>
          {error.message}
        </span>
      )}
      {picker && <BranchPicker root={root} anchor={picker} onClose={() => setPicker(null)} />}
    </div>
  );
}
