/**
 * ChangesSection — the commit box on top, then ONE list of every file that
 * differs from the last commit (core/git/status.ts `flattenStatus`). Each
 * row carries its staging state as a checkbox — checked = staged, half =
 * partly staged, empty = not staged — which is also how you stage it; the
 * untracked ones say so in the glyph (`?`) and a dimmed name. Clicking a row
 * diffs HEAD against the working tree. Every action is a store call.
 *
 * mod+Enter in the message box commits. Handled on the textarea itself (and
 * stopped there) so the global shortcut listener never sees it.
 */

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { flattenStatus, type ChangeState, type FlatChange } from '../../../core/git/status';
import { gitStore } from '../../stores/git';
import { Empty, IconButton, PathLabel, Section, StatusGlyph, useRepoSlice } from './shared';

const STATE_TITLE: Record<ChangeState, string> = {
  staged: 'Staged — in the next commit. Untick to unstage.',
  partial: 'Partly staged — some of its changes are in the next commit. Tick to stage the rest.',
  unstaged: 'Changed, not staged. Tick to stage.',
  untracked: 'Untracked — new to git. Tick to stage.',
};

function StageBox({ state, onToggle }: { state: ChangeState; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = state === 'partial';
    }
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="git-stage-box"
      checked={state === 'staged'}
      aria-label={state === 'staged' ? 'Unstage' : 'Stage'}
      title={STATE_TITLE[state]}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

function ChangeRow({ root, row, selected }: { root: string; row: FlatChange; selected: boolean }) {
  const actions = gitStore.getState();
  const { entry, state, letter } = row;
  const select = () => actions.select(root, { kind: 'file', group: 'changed', path: entry.path });
  const toggle = () =>
    void (state === 'staged'
      ? actions.unstage(root, [entry.path])
      : actions.stage(root, [entry.path]));
  return (
    <div
      className={`git-row git-change-row is-${state}${selected ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          select();
        } else if (e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <StageBox state={state} onToggle={toggle} />
      <StatusGlyph letter={letter} title={`git status: ${letter}`} />
      <PathLabel path={entry.path} origPath={entry.origPath} />
      <span className="git-row-actions">
        {state !== 'staged' && (
          <IconButton
            icon={state === 'untracked' ? 'trash' : 'undo'}
            title={state === 'untracked' ? 'Delete this untracked file' : 'Discard changes'}
            danger
            onClick={() => void actions.discard(root, [entry.path])}
          />
        )}
      </span>
    </div>
  );
}

export function ChangesSection({ root }: { root: string }) {
  const entries = useRepoSlice(root, (r) => r.status?.entries);
  const groups = useRepoSlice(root, (r) => r.groups);
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  const draft = useRepoSlice(root, (r) => r.commitDraft) ?? '';
  const amend = useRepoSlice(root, (r) => r.amend) ?? false;
  const status = useRepoSlice(root, (r) => r.status) ?? null;
  const op = useRepoSlice(root, (r) => r.op) ?? null;
  const actions = gitStore.getState();

  const rows = flattenStatus(entries ?? []);
  const staged = groups?.staged ?? [];
  const selectedPath = selected?.kind === 'file' ? selected.path : null;
  const toStage = rows.filter((r) => r.state !== 'staged').map((r) => r.entry.path);
  const toUnstage = rows.filter((r) => r.state !== 'unstaged' && r.state !== 'untracked');

  const merging = status?.state === 'merging';
  const reason =
    status === null
      ? 'Waiting for git'
      : op?.running
        ? 'Wait for the running operation'
        : staged.length === 0 && !amend && !merging
          ? 'Tick the files to commit'
          : draft.trim() === '' && !amend && !merging
            ? 'Write a commit message'
            : null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (reason === null) {
        void actions.commit(root);
      }
    }
  };

  return (
    <div className="git-changes">
      <div className="git-commit">
        <textarea
          className="git-commit-message"
          rows={3}
          placeholder={
            merging
              ? 'Merge message (git prepared one; leave empty to keep it)'
              : amend
                ? 'New message (leave empty to keep the last one)'
                : 'Commit message  (Ctrl/Cmd+Enter to commit)'
          }
          value={draft}
          spellCheck={false}
          onChange={(e) => actions.setCommitDraft(root, e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="git-commit-row">
          <label className="git-check" title="git commit --amend — fold into the last commit">
            <input
              type="checkbox"
              checked={amend}
              disabled={status === null || status.unborn}
              onChange={() => actions.toggleAmend(root)}
            />
            Amend
          </label>
          <span className="git-header-spacer" />
          <button
            type="button"
            className="git-btn git-btn-accent"
            disabled={reason !== null}
            title={reason ?? (amend ? 'git commit --amend' : 'git commit')}
            onClick={() => void actions.commit(root)}
          >
            {merging ? 'Commit merge' : amend ? 'Amend' : 'Commit'}
          </button>
        </div>
      </div>
      <Section
        title="Changes"
        count={rows.length}
        actions={
          rows.length > 0 ? (
            <>
              {toStage.length > 0 && (
                <button
                  type="button"
                  className="git-link-btn"
                  title="git add — stage every file in the list"
                  onClick={() => void actions.stage(root, toStage)}
                >
                  Stage all
                </button>
              )}
              {toUnstage.length > 0 && (
                <button
                  type="button"
                  className="git-link-btn"
                  title="git restore --staged — take every file out of the next commit"
                  onClick={() =>
                    void actions.unstage(
                      root,
                      toUnstage.map((r) => r.entry.path),
                    )
                  }
                >
                  Unstage all
                </button>
              )}
            </>
          ) : undefined
        }
      >
        {rows.length === 0 ? (
          <Empty>Nothing changed since the last commit</Empty>
        ) : (
          rows.map((row) => (
            <ChangeRow
              key={row.entry.path}
              root={root}
              row={row}
              selected={selectedPath === row.entry.path}
            />
          ))
        )}
      </Section>
    </div>
  );
}
