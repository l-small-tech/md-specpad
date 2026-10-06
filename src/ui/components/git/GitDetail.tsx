/**
 * GitDetail — the right column. What it shows follows `repo.selected`:
 * a changed file (DiffView over `repo.diff`, with an EOL / binary hint bar),
 * a commit (subject, body, its files — a file click narrows the diff to it),
 * a worktree's files against the base branch, the finish-worktree stepper,
 * or nothing while nothing is selected (GitTab then gives the graph the
 * whole column). A thin bar names what is shown and closes it (Esc too).
 */

import { relativeTime } from '../../../core/notes-overview';
import { gitStore } from '../../stores/git';
import { DiffView } from '../DiffView';
import { FinishFlow } from './FinishFlow';
import { Icon } from './icons';
import {
  checkoutLabel,
  IconButton,
  PathLabel,
  shortSha,
  StatusGlyph,
  useNow,
  useRepoSlice,
} from './shared';

/** The thin bar above the detail: what is shown, and the close (Esc) button. */
function DetailBar({ root, label }: { root: string; label: string }) {
  return (
    <div className="git-detail-bar">
      <span className="git-detail-label">{label}</span>
      <IconButton
        icon="close"
        title="Close (Esc)"
        onClick={() => gitStore.getState().select(root, null)}
      />
    </div>
  );
}

function DiffPane({ root }: { root: string }) {
  const diff = useRepoSlice(root, (r) => r.diff) ?? null;
  const loading = useRepoSlice(root, (r) => r.diffLoading) ?? false;
  if (diff === null) {
    return <div className="git-detail-hint">{loading ? 'Loading diff…' : 'No diff to show.'}</div>;
  }
  if (diff.binary) {
    return (
      <div className="git-detail-hint">
        <code>{diff.path}</code> is a binary file — nothing to compare line by line.
      </div>
    );
  }
  const left = diff.leftText ?? '';
  const right = diff.rightText ?? '';
  return (
    <>
      {(diff.eolOnly || diff.leftText === null || diff.rightText === null) && (
        <div className="git-hint-bar">
          {diff.eolOnly
            ? 'Only line endings differ (CRLF ⇄ LF) — the text is the same.'
            : diff.leftText === null
              ? 'New file — nothing on the left side.'
              : 'Deleted — nothing on the right side.'}
        </div>
      )}
      <DiffView
        oldText={left}
        newText={right}
        oldLabel={`${diff.leftLabel} — ${diff.path}`}
        newLabel={`${diff.rightLabel} — ${diff.path}`}
      />
    </>
  );
}

function CommitPane({ root, sha, path }: { root: string; sha: string; path?: string }) {
  const log = useRepoSlice(root, (r) => r.log) ?? [];
  const files = useRepoSlice(root, (r) => r.commitFiles[sha]);
  const actions = gitStore.getState();
  const now = useNow();
  const commit = log.find((c) => c.sha === sha) ?? null;
  return (
    <div className="git-detail-scroll">
      <div className="git-commit-head">
        <div className="git-commit-title">
          <span className="git-sha">{shortSha(sha)}</span>
          <span className="git-commit-subject">{commit?.subject ?? sha}</span>
        </div>
        {commit && (
          <div className="git-commit-byline">
            {commit.author} · {relativeTime(commit.at, now)}
            {commit.parents.length > 1 && (
              <span className="git-chip" title={commit.parents.join(' ')}>
                merge
              </span>
            )}
          </div>
        )}
        {commit && commit.body.trim() !== '' && (
          <pre className="git-commit-body">{commit.body}</pre>
        )}
      </div>
      <div className="git-subhead">Files{files ? ` · ${files.length}` : ''}</div>
      {files === undefined ? (
        <div className="git-detail-hint">Loading files…</div>
      ) : files.length === 0 ? (
        <div className="git-detail-hint">No file changes.</div>
      ) : (
        files.map((f) => (
          <div
            key={f.path}
            className={`git-row git-change-row${path === f.path ? ' is-selected' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => actions.select(root, { kind: 'commit', sha, path: f.path })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                actions.select(root, { kind: 'commit', sha, path: f.path });
              }
            }}
          >
            <StatusGlyph letter={f.status} />
            <PathLabel path={f.path} origPath={f.origPath} />
          </div>
        ))
      )}
      {path !== undefined && (
        <div className="git-commit-diff">
          <DiffPane root={root} />
        </div>
      )}
    </div>
  );
}

function WorktreeDiffPane({ root, path }: { root: string; path: string }) {
  const files = useRepoSlice(root, (r) => r.worktreeDiffs[path]);
  const base = useRepoSlice(root, (r) => r.info?.baseBranch ?? null) ?? null;
  const checkouts = useRepoSlice(root, (r) => r.checkouts) ?? [];
  const branch = checkouts.find((c) => c.path === path)?.branch ?? null;
  return (
    <div className="git-detail-scroll">
      <div className="git-commit-head">
        <div className="git-commit-title">
          <Icon name="diff" />
          <span className="git-commit-subject">
            {checkoutLabel(path, root)}
            {branch && ` · ${branch}`} vs {base ?? 'base'}
          </span>
        </div>
        <div className="git-commit-byline">
          Files this branch changes since it left {base ?? 'the base branch'}
        </div>
      </div>
      {files === undefined ? (
        <div className="git-detail-hint">Comparing…</div>
      ) : files.length === 0 ? (
        <div className="git-detail-hint">No differences against {base ?? 'the base branch'}.</div>
      ) : (
        files.map((f) => (
          <div key={f.path} className="git-row git-change-row is-static">
            <StatusGlyph letter={f.status} />
            <PathLabel path={f.path} origPath={f.origPath} />
          </div>
        ))
      )}
    </div>
  );
}

export function GitDetail({ root }: { root: string }) {
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  if (selected === null) {
    return null;
  }
  switch (selected.kind) {
    case 'file':
      return (
        <>
          <DetailBar root={root} label={`Diff · ${selected.path}`} />
          <DiffPane root={root} />
        </>
      );
    case 'commit':
      return (
        <>
          <DetailBar root={root} label={`Commit ${shortSha(selected.sha)}`} />
          <CommitPane root={root} sha={selected.sha} path={selected.path} />
        </>
      );
    case 'worktree-diff':
      return (
        <>
          <DetailBar root={root} label={`${checkoutLabel(selected.path, root)} vs base`} />
          <WorktreeDiffPane root={root} path={selected.path} />
        </>
      );
    case 'finish':
      return (
        <>
          <DetailBar root={root} label="Finish worktree" />
          <FinishFlow root={root} />
        </>
      );
  }
}
