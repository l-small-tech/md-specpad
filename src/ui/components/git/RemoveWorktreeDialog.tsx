/**
 * RemoveWorktreeDialog — the modal a worktree removal opens instead of a
 * notice, written for people who are new to git (`repo.worktreeDialog`):
 *
 * - dirty — the folder holds work that was never committed. Says plainly
 *   that deleting it erases that work for good, lists the files (new /
 *   modified / deleted …, `core/git/worktree-removal.ts`), and suggests
 *   committing first. **Cancel is the default** — focused, so Enter and
 *   Escape both cancel; the red "Delete anyway" (`--force`) must be chosen.
 * - locked — git's "do not remove" flag is set; explains it and how to lift
 *   it. Nothing to confirm.
 * - bulk — "Delete all clean worktrees": exactly which folders go, which stay
 *   and why; Cancel is the default here too.
 *
 * Settings-dialog chrome like NewWorktreeDialog; Escape closes (GitTab), as
 * does a click on the backdrop. Every decision is the store's.
 */

import type { ReactNode } from 'react';
import {
  removalSkipText,
  type UncommittedChange,
  type UncommittedFile,
} from '../../../core/git/worktree-removal';
import { gitStore, type WorktreeDialog } from '../../stores/git';
import { useRepoSlice } from './shared';

const CHANGE_WORDS: Record<UncommittedChange, string> = {
  new: 'new',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  conflicted: 'conflict',
};

function FileRow({ file }: { file: UncommittedFile }) {
  return (
    <li className="git-rm-file">
      <span className={`git-rm-change is-${file.change}`}>{CHANGE_WORDS[file.change]}</span>
      <span className="git-rm-path" title={file.from ? `${file.from} → ${file.path}` : file.path}>
        {file.path}
      </span>
    </li>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** title, body and the go-ahead button's label for one dialog. */
function content(d: WorktreeDialog): {
  title: string;
  body: ReactNode;
  confirm: string | null;
} {
  switch (d.kind) {
    case 'dirty': {
      const { files, more, total } = d.changes;
      return {
        title: 'Delete changes that were never committed?',
        confirm: 'Delete anyway',
        body: (
          <>
            <p className="git-remote-lead">
              <code>{d.rel}</code>
              {d.branch ? (
                <>
                  {' '}
                  (branch <code>{d.branch}</code>)
                </>
              ) : null}{' '}
              has {plural(total, 'change', 'changes')} that {total === 1 ? 'was' : 'were'} never
              committed — saved into git&apos;s history. Deleting the worktree deletes its folder,
              and {total === 1 ? 'that change goes' : 'these changes go'} with it.
            </p>
            <p className="git-rm-warning">This permanently erases them. It cannot be undone.</p>
            <div className="git-rm-list-head">
              Not committed yet ({plural(total, 'file', 'files')})
            </div>
            <ul className="git-rm-list">
              {files.map((f) => (
                <FileRow key={f.path} file={f} />
              ))}
              {more > 0 && <li className="git-rm-more">and {more} more</li>}
            </ul>
            {d.terminals.length > 0 && (
              <p className="git-remote-lead git-rm-note">
                {d.terminals.length === 1
                  ? 'The terminal open in it'
                  : `The ${d.terminals.length} terminals open in it`}{' '}
                ({d.terminals.join(', ')}) will be closed too.
              </p>
            )}
            <p className="git-remote-lead git-rm-note">
              Not sure? Choose <strong>Cancel</strong> and commit the changes first (or ask your
              agent to). The branch itself stays either way — only the uncommitted changes are lost.
            </p>
          </>
        ),
      };
    }
    case 'locked':
      return {
        title: 'This worktree is locked',
        confirm: null,
        body: (
          <>
            <p className="git-remote-lead">
              <code>{d.rel}</code> is locked. A lock is git&apos;s &ldquo;do not remove&rdquo; flag:
              someone — or a tool — set it so this folder is not deleted or cleaned up by accident
              (for example while it lives on a drive that is not always plugged in).
            </p>
            <p className="git-remote-lead">
              MD Specpad leaves locked worktrees alone. If you are sure it is no longer needed,
              unlock it by running this in a terminal, then remove it again:
            </p>
            <pre className="git-rm-command">git worktree unlock &quot;{d.path}&quot;</pre>
          </>
        ),
      };
    case 'bulk':
      return {
        title: 'Delete clean worktrees',
        confirm: `Delete ${plural(d.remove.length, 'worktree', 'worktrees')}`,
        body: (
          <>
            <p className="git-remote-lead">
              {d.remove.length === 1 ? 'This worktree has' : 'These worktrees have'} nothing
              uncommitted, so no work is lost: the{' '}
              {d.remove.length === 1 ? 'folder is' : 'folders are'} deleted, and{' '}
              {d.remove.length === 1 ? 'its branch' : 'their branches'} — with every commit on{' '}
              {d.remove.length === 1 ? 'it' : 'them'} — stay in the repository.
            </p>
            <div className="git-rm-list-head">Will be deleted ({d.remove.length})</div>
            <ul className="git-rm-list">
              {d.remove.map((t) => (
                <li key={t.path} className="git-rm-file">
                  <span className="git-rm-path" title={t.path}>
                    {t.rel}
                  </span>
                  <span className="git-rm-aside">
                    {t.missing ? 'folder already gone — only tidies the list' : (t.branch ?? '')}
                  </span>
                </li>
              ))}
            </ul>
            {d.skipped.length > 0 && (
              <>
                <div className="git-rm-list-head">Left alone ({d.skipped.length})</div>
                <ul className="git-rm-list">
                  {d.skipped.map((s) => (
                    <li key={s.path} className="git-rm-file is-skipped">
                      <span className="git-rm-path" title={s.path}>
                        {s.rel}
                      </span>
                      <span className="git-rm-aside">{removalSkipText(s)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="git-remote-lead git-rm-note">
              Each one is checked again right before it goes; one that picked up changes in the
              meantime is skipped.
            </p>
          </>
        ),
      };
  }
}

export function RemoveWorktreeDialog({ root }: { root: string }) {
  const dialog = useRepoSlice(root, (r) => r.worktreeDialog) ?? null;
  if (dialog === null) {
    return null;
  }
  const actions = gitStore.getState();
  const close = () => actions.closeWorktreeDialog(root);
  const { title, body, confirm } = content(dialog);
  return (
    <div
      className="settings-backdrop git-dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div
        className="settings-dialog git-dialog git-rm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="git-rm-title"
      >
        <header className="settings-header">
          <h2 className="settings-title" id="git-rm-title">
            {title}
          </h2>
          <button className="settings-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </header>
        <div className="git-dialog-body">{body}</div>
        <footer className="git-dialog-footer">
          {confirm === null ? (
            <button type="button" className="git-btn git-btn-accent" autoFocus onClick={close}>
              OK
            </button>
          ) : (
            <>
              {/* Cancel is the default: focused on open, so Enter cancels. */}
              <button type="button" className="git-btn git-btn-accent" autoFocus onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="git-btn git-btn-destructive"
                onClick={() => void actions.confirmWorktreeDialog(root)}
              >
                {confirm}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
