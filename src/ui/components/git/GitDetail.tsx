/**
 * GitDetail — the two places `repo.selected` is shown.
 *
 * `GitInspector` is the side column: what the selected graph node holds.
 * Nothing selected (or one of the working tree's files) → the working tree:
 * conflicts, the commit box and the change list (ChangesSection). A commit
 * → its subject, body and files. A worktree card's "vs base" → that file
 * list. The finish-worktree stepper. A thin bar names what is shown and
 * closes it (Esc too) — back to the working tree.
 *
 * `GitDiffDetail` is the pane under the graph, open only while a file is
 * picked — a working-tree file, or one of a commit's files — and shows its
 * DiffView over `repo.diff` (the EOL / new / deleted note rides in the
 * DiffView's header, as does the close button; a binary file gets a hint).
 * Closing it steps back one level: to the commit, or to the working tree.
 */

import { relativeTime } from '../../../core/notes-overview';
import { gitStore } from '../../stores/git';
import { DiffView } from '../DiffView';
import { ChangesSection } from './ChangesSection';
import { ConflictsSection } from './ConflictsSection';
import { FinishFlow } from './FinishFlow';
import { GitSkeleton } from './GitStates';
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

/** The thin bar above a view: what is shown, and the close (Esc) button. */
function DetailBar({
  label,
  closeTitle,
  onClose,
}: {
  label: string;
  closeTitle: string;
  onClose: () => void;
}) {
  return (
    <div className="git-detail-bar">
      <span className="git-detail-label">{label}</span>
      <IconButton icon="close" title={closeTitle} onClick={onClose} />
    </div>
  );
}

/** The picked file's diff. The DiffView's own header names the file and
 *  carries the close button; the DetailBar stands in only while there is no
 *  diff to draw (loading, nothing, binary). */
function DiffPane({ root, label, onClose }: { root: string; label: string; onClose: () => void }) {
  const diff = useRepoSlice(root, (r) => r.diff) ?? null;
  const loading = useRepoSlice(root, (r) => r.diffLoading) ?? false;
  const closeTitle = 'Close the diff (Esc)';
  if (diff === null || diff.binary) {
    return (
      <>
        <DetailBar label={label} closeTitle={closeTitle} onClose={onClose} />
        {diff === null ? (
          <div className="git-detail-hint">{loading ? 'Loading diff…' : 'No diff to show.'}</div>
        ) : (
          <div className="git-detail-hint">
            <code>{diff.path}</code> is a binary file — nothing to compare line by line.
          </div>
        )}
      </>
    );
  }
  const left = diff.leftText ?? '';
  const right = diff.rightText ?? '';
  const notice = diff.eolOnly
    ? 'Only line endings differ (CRLF ⇄ LF) — the text is the same.'
    : diff.leftText === null
      ? 'New file — nothing on the left side.'
      : diff.rightText === null
        ? 'Deleted — nothing on the right side.'
        : null;
  return (
    <DiffView
      oldText={left}
      newText={right}
      oldLabel={diff.leftLabel}
      newLabel={diff.rightLabel}
      path={diff.path}
      notice={notice}
      onClose={onClose}
      closeTitle={closeTitle}
    />
  );
}

function CommitPane({ root, sha, path }: { root: string; sha: string; path?: string }) {
  const log = useRepoSlice(root, (r) => r.log) ?? [];
  const files = useRepoSlice(root, (r) => r.commitFiles[sha]);
  const actions = gitStore.getState();
  const now = useNow();
  const commit = log.find((c) => c.sha === sha) ?? null;
  return (
    <>
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
    </>
  );
}

function WorktreeDiffPane({ root, path }: { root: string; path: string }) {
  const files = useRepoSlice(root, (r) => r.worktreeDiffs[path]);
  const base = useRepoSlice(root, (r) => r.info?.baseBranch ?? null) ?? null;
  const checkouts = useRepoSlice(root, (r) => r.checkouts) ?? [];
  const branch = checkouts.find((c) => c.path === path)?.branch ?? null;
  return (
    <>
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
    </>
  );
}

/** The side column: the working tree, or whatever graph node is selected. */
export function GitInspector({ root }: { root: string }) {
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  const hasStatus = useRepoSlice(root, (r) => r.status !== null) ?? false;
  const loadingStatus = useRepoSlice(root, (r) => r.loading.status) ?? false;
  const back = () => gitStore.getState().select(root, null);
  const backTitle = 'Back to the changes (Esc)';
  if (selected === null || selected.kind === 'file') {
    if (!hasStatus && loadingStatus) {
      return <GitSkeleton />;
    }
    return (
      <>
        <ConflictsSection root={root} />
        <ChangesSection root={root} />
      </>
    );
  }
  switch (selected.kind) {
    case 'commit':
      return (
        <>
          <DetailBar
            label={`Commit ${shortSha(selected.sha)}`}
            closeTitle={backTitle}
            onClose={back}
          />
          <CommitPane root={root} sha={selected.sha} path={selected.path} />
        </>
      );
    case 'worktree-diff':
      return (
        <>
          <DetailBar
            label={`${checkoutLabel(selected.path, root)} vs base`}
            closeTitle={backTitle}
            onClose={back}
          />
          <WorktreeDiffPane root={root} path={selected.path} />
        </>
      );
    case 'finish':
      return (
        <>
          <DetailBar label="Finish worktree" closeTitle={backTitle} onClose={back} />
          <FinishFlow root={root} />
        </>
      );
  }
}

/** True while `selected` names a file whose diff the pane under the graph shows. */
export function hasDiffDetail(selected: { kind: string; path?: string } | null): boolean {
  return selected !== null && (selected.kind === 'file' || selected.path !== undefined);
}

/** The pane under the graph: the picked file's diff. */
export function GitDiffDetail({ root }: { root: string }) {
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  if (selected === null) {
    return null;
  }
  const actions = gitStore.getState();
  if (selected.kind === 'file') {
    return (
      <DiffPane
        root={root}
        label={`Diff · ${selected.path}`}
        onClose={() => actions.select(root, null)}
      />
    );
  }
  if (selected.kind === 'commit' && selected.path !== undefined) {
    return (
      <DiffPane
        root={root}
        label={`${shortSha(selected.sha)} · ${selected.path}`}
        onClose={() => actions.select(root, { kind: 'commit', sha: selected.sha })}
      />
    );
  }
  return null;
}
