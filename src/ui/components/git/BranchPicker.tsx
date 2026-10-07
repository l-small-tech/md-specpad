/**
 * Branches, two ways in — both the same store actions:
 *
 * - `BranchMenu`: the actions of ONE branch, opened from its pill in the
 *   graph — Switch (a remote branch becomes a tracking local one), Merge
 *   into the current branch, Delete. A branch checked out in a worktree says
 *   so; git refuses to switch to or delete it elsewhere.
 * - `BranchPicker`: the status bar's popover — fuzzy filter, locals then
 *   remotes with the same actions on hover, and an inline New-branch input.
 */

import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { rankCandidates } from '../../../core/fuzzy';
import { validateBranchName } from '../../../core/git/refs';
import type { GitBranch } from '../../../core/git/types';
import { gitStore } from '../../stores/git';
import { GitMenu, MenuItem, type MenuAnchor } from './GitMenu';
import { Icon } from './icons';
import { aheadBehind, checkoutLabel, Empty, IconButton, useRepoSlice } from './shared';

/** The live check under the New-branch input — the same rules the store applies. */
const branchNameError = (name: string): string | null => validateBranchName(name.trim());

/** The checkout holding `name`, as a label, or null. */
function useCheckedOutIn(root: string): (name: string) => string | null {
  const checkouts = useRepoSlice(root, (r) => r.checkouts) ?? [];
  return (name) => {
    const c = checkouts.find((x) => x.branch === name);
    return c ? checkoutLabel(c.path, root) : null;
  };
}

export function BranchMenu({
  root,
  branch,
  anchor,
  onClose,
}: {
  root: string;
  branch: GitBranch;
  anchor: MenuAnchor;
  onClose: () => void;
}) {
  const actions = gitStore.getState();
  const checkedOutIn = useCheckedOutIn(root)(branch.name);
  const elsewhere = checkedOutIn !== null && !branch.current;
  const local = branch.kind === 'local';
  const run = (fn: () => unknown) => {
    onClose();
    void fn();
  };
  return (
    <GitMenu anchor={anchor} onClose={onClose}>
      <div className="git-menu-head">
        <Icon name={local ? 'branch' : 'cloud'} />
        <span className="git-menu-title">{branch.name}</span>
        {branch.current && <span className="git-chip git-chip-state">current</span>}
        {elsewhere && <span className="git-note">in {checkedOutIn}</span>}
      </div>
      {!branch.current && (
        <MenuItem
          disabled={elsewhere}
          title={
            elsewhere
              ? `Checked out in ${checkedOutIn} — switch there instead`
              : local
                ? 'git switch'
                : 'git switch --track'
          }
          onClick={() => run(() => actions.switchBranch(root, branch))}
        >
          <Icon name="check" />
          {local ? 'Switch to this branch' : 'Check out as a local branch'}
        </MenuItem>
      )}
      {!branch.current && (
        <MenuItem title="git merge" onClick={() => run(() => actions.merge(root, branch.name))}>
          <Icon name="merge-in" />
          Merge into the current branch
        </MenuItem>
      )}
      {local && !branch.current && (
        <MenuItem
          danger
          disabled={elsewhere}
          title={elsewhere ? `Checked out in ${checkedOutIn}` : 'git branch -d'}
          onClick={() => run(() => actions.deleteBranch(root, branch.name))}
        >
          <Icon name="trash" />
          Delete branch
        </MenuItem>
      )}
      {branch.current && <div className="git-menu-note">This is the checked-out branch.</div>}
    </GitMenu>
  );
}

function PickerRow({
  root,
  branch,
  checkedOutIn,
  onDone,
}: {
  root: string;
  branch: GitBranch;
  checkedOutIn: string | null;
  onDone: () => void;
}) {
  const actions = gitStore.getState();
  const local = branch.kind === 'local';
  const elsewhere = checkedOutIn !== null && !branch.current;
  const switchTitle = elsewhere
    ? `Checked out in ${checkedOutIn} — switch there instead`
    : local
      ? `Switch to ${branch.name}`
      : `Check out ${branch.name} as a local tracking branch`;
  const activate = () => {
    if (branch.current || elsewhere) {
      return;
    }
    onDone();
    void actions.switchBranch(root, branch);
  };
  return (
    <div
      className={`git-row git-picker-row${branch.current ? ' is-current' : ''}`}
      role="button"
      tabIndex={0}
      title={branch.current ? 'The checked-out branch' : switchTitle}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          activate();
        }
      }}
    >
      <Icon name={branch.current ? 'check' : local ? 'branch' : 'cloud'} />
      <span className="git-branch-label">{branch.name}</span>
      {branch.gone && (
        <span className="git-chip git-chip-warn" title="Its upstream no longer exists">
          gone
        </span>
      )}
      {aheadBehind(branch.ahead, branch.behind) !== '' && (
        <span className="git-ahead-behind" title={`Against ${branch.upstream ?? 'upstream'}`}>
          {aheadBehind(branch.ahead, branch.behind)}
        </span>
      )}
      {elsewhere && (
        <span className="git-note" title={`Checked out in ${checkedOutIn}`}>
          in {checkedOutIn}
        </span>
      )}
      <span className="git-row-actions">
        {!branch.current && (
          <IconButton
            icon="merge-in"
            title={`Merge ${branch.name} into the current branch`}
            onClick={() => {
              onDone();
              void actions.merge(root, branch.name);
            }}
          />
        )}
        {local && !branch.current && (
          <IconButton
            icon="trash"
            title={elsewhere ? `Checked out in ${checkedOutIn}` : `Delete ${branch.name}`}
            danger
            disabled={elsewhere}
            onClick={() => {
              onDone();
              void actions.deleteBranch(root, branch.name);
            }}
          />
        )}
      </span>
    </div>
  );
}

export function BranchPicker({
  root,
  anchor,
  onClose,
}: {
  root: string;
  anchor: MenuAnchor;
  onClose: () => void;
}) {
  const branches = useRepoSlice(root, (r) => r.branches) ?? [];
  const filter = useRepoSlice(root, (r) => r.branchFilter) ?? '';
  const loading = useRepoSlice(root, (r) => r.loading.branches) ?? false;
  const checkedOutIn = useCheckedOutIn(root);
  const [newName, setNewName] = useState('');
  const actions = gitStore.getState();

  const shown = filter.trim() === '' ? branches : rankCandidates(filter, branches, (b) => b.name);
  const locals = shown.filter((b) => b.kind === 'local');
  const remotes = shown.filter((b) => b.kind === 'remote');
  const nameError = branchNameError(newName);

  const submitNew = () => {
    if (newName.trim() === '' || nameError !== null) {
      return;
    }
    onClose();
    void actions.createBranch(root, newName.trim(), null, true);
  };
  const onNewKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNew();
    }
  };

  return (
    <GitMenu anchor={anchor} onClose={onClose} className="git-picker" width={340}>
      <div className="git-picker-search">
        <input
          className="git-input git-filter"
          type="search"
          placeholder="Filter branches"
          value={filter}
          autoFocus
          spellCheck={false}
          onChange={(e) => actions.setBranchFilter(root, e.target.value)}
        />
      </div>
      <div className="git-picker-list">
        {branches.length === 0 ? (
          <Empty>{loading ? 'Listing branches…' : 'No branches'}</Empty>
        ) : (
          <>
            {locals.length > 0 && <div className="git-subhead">Local</div>}
            {locals.map((b) => (
              <PickerRow
                key={b.name}
                root={root}
                branch={b}
                checkedOutIn={checkedOutIn(b.name)}
                onDone={onClose}
              />
            ))}
            {remotes.length > 0 && <div className="git-subhead">Remote</div>}
            {remotes.map((b) => (
              <PickerRow key={b.name} root={root} branch={b} checkedOutIn={null} onDone={onClose} />
            ))}
            {shown.length === 0 && <Empty>No branch matches</Empty>}
          </>
        )}
      </div>
      <div className="git-picker-new">
        <Icon name="plus" />
        <input
          className="git-input"
          type="text"
          placeholder="New branch from here… (feat/my-branch)"
          value={newName}
          spellCheck={false}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={onNewKey}
        />
        <button
          type="button"
          className="git-btn git-btn-accent"
          disabled={newName.trim() === '' || nameError !== null}
          title={nameError ?? 'git switch -c — create the branch here and switch to it'}
          onClick={submitNew}
        >
          Create
        </button>
        {nameError !== null && newName !== '' && (
          <span className="git-field-error">{nameError}</span>
        )}
      </div>
    </GitMenu>
  );
}
