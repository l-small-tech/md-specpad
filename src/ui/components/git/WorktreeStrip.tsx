/**
 * WorktreeStrip — the header of the git tab: one card per checkout (the main
 * folder first, then every linked worktree), laid side by side. A card IS
 * the checkout picker: clicking it makes the panel show that checkout's
 * changes, branch and history. Each card shows the branch, a stacked bar of
 * what is dirty there (staged · changed · untracked · conflicted), how far
 * the branch is ahead of / behind the base branch, a dot when one of this
 * window's terminals stands inside it, and state chips (merging, missing,
 * locked). The actions appear on the selected or hovered card: open as
 * workspace, a shell or the harness in it, its diff against the base, merge
 * either way, Finish…, Remove. The dashed card at the end is New worktree.
 *
 * The strip is also the git tab's only header, so it carries the
 * distraction-free button the ribbon gives a document (the git tab has no
 * ribbon). While chrome-less and windowed, the strip's empty room doubles as
 * the grab-to-move handle — the overlay strip App lays over a document would
 * sit exactly on the cards' top line and swallow their clicks.
 */

import { terminalsInside as terminalsIn } from '../../../core/git/checkouts';
import type { GitCheckout } from '../../../core/git/types';
import { setDistractionFree } from '../../fullscreen';
import { isAndroid } from '../../platform';
import { gitStore } from '../../stores/git';
import { tabDisplayTitle, tabsStore, useTabsStore, type TabEntry } from '../../stores/tabs';
import { useUiStore } from '../../stores/ui';
import { Icon } from './icons';
import { checkoutDir, checkoutLabel, checkoutName, IconButton, useRepoSlice } from './shared';

/** Titles of the terminal tabs whose shell is inside `path` (core's containment rule). */
function terminalsInside(tabs: readonly TabEntry[], path: string): string[] {
  const shells = tabs
    .filter((t) => t.kind === 'terminal')
    .map((t) => ({ id: t.id, title: tabDisplayTitle(t), cwd: t.terminalCwd }));
  return terminalsIn(shells, path).map((s) => s.title);
}

/** The dirty-files bar: four tones, widths proportional to the counts. */
function DirtyBar({
  staged,
  unstaged,
  untracked,
  conflicted,
}: {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}) {
  const total = staged + unstaged + untracked + conflicted;
  if (total === 0) {
    return (
      <span className="git-card-clean" title="Nothing to commit">
        <Icon name="check" />
        clean
      </span>
    );
  }
  const seg = (n: number, tone: string, label: string) =>
    n > 0 ? (
      <span
        key={tone}
        className={`git-dirty-seg is-${tone}`}
        style={{ flexGrow: n }}
        title={`${n} ${label}`}
      />
    ) : null;
  return (
    <span
      className="git-card-dirty"
      title={`${staged} staged · ${unstaged} changed · ${untracked} untracked${conflicted ? ` · ${conflicted} conflicted` : ''}`}
    >
      <span className="git-dirty-bar">
        {seg(conflicted, 'conflict', 'conflicted')}
        {seg(staged, 'staged', 'staged')}
        {seg(unstaged, 'unstaged', 'changed')}
        {seg(untracked, 'untracked', 'untracked')}
      </span>
      <span className="git-card-dirty-count">
        {total} {total === 1 ? 'file' : 'files'}
      </span>
    </span>
  );
}

/** Ahead / behind the base, as two little bars with their counts. */
function AheadBehind({ ahead, behind, base }: { ahead: number; behind: number; base: string }) {
  const max = Math.max(ahead, behind, 1);
  const w = (n: number) => `${Math.round((Math.min(n, max) / max) * 100)}%`;
  return (
    <span
      className="git-card-ab"
      title={`${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${base}, ${behind} behind`}
    >
      <span className={`git-ab-row${ahead === 0 ? ' is-zero' : ''}`}>
        <Icon name="arrow-up" />
        <span className="git-ab-track">
          <span className="git-ab-fill is-ahead" style={{ width: w(ahead) }} />
        </span>
        <span className="git-ab-n">{ahead}</span>
      </span>
      <span className={`git-ab-row${behind === 0 ? ' is-zero' : ''}`}>
        <Icon name="arrow-down" />
        <span className="git-ab-track">
          <span className="git-ab-fill is-behind" style={{ width: w(behind) }} />
        </span>
        <span className="git-ab-n">{behind}</span>
      </span>
    </span>
  );
}

function WorktreeCard({
  root,
  tabId,
  checkout,
  base,
  selected,
  viewingDiff,
  terminals,
}: {
  root: string;
  tabId: string;
  checkout: GitCheckout;
  base: string | null;
  selected: boolean;
  viewingDiff: boolean;
  terminals: string[];
}) {
  const actions = gitStore.getState();
  const s = checkout.summary;
  const isMain = checkout.isMain;
  const dir = checkoutDir(checkout.path, root);
  const onBase = base !== null && checkout.branch === base;
  const missing = s?.missing === true;
  const pick = () => {
    if (missing) {
      return;
    }
    tabsStore.getState().setGitCheckout(tabId, checkout.path);
    actions.selectCheckout(root, checkout.path);
  };
  const classes = [
    'git-card',
    selected ? 'is-selected' : '',
    missing ? 'is-missing' : '',
    isMain ? 'is-main' : '',
    s && s.conflicted > 0 ? 'has-conflicts' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={`${checkout.path}${selected ? '' : '\nClick to show this checkout'}`}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      }}
    >
      <div className="git-card-head">
        <Icon name={isMain ? 'home' : 'folder'} />
        <span className="git-card-name">{checkoutName(checkout.path, root)}</span>
        {terminals.length > 0 && (
          <span
            className="git-terminal-dot"
            title={`Terminal open here: ${terminals.join(', ')}`}
            aria-label={`${terminals.length} terminal(s) open here`}
          />
        )}
        {s && s.state !== 'clean' && (
          <span className="git-chip git-chip-state" title="An operation is in progress here">
            {s.state}
          </span>
        )}
        {missing && (
          <span
            className="git-chip git-chip-warn"
            title="The folder is gone (git calls it prunable)"
          >
            missing
          </span>
        )}
        {s?.locked && (
          <span className="git-chip" title="Locked — git will not prune it">
            locked
          </span>
        )}
      </div>
      <div className="git-card-branch" title={checkout.branch ?? 'detached HEAD'}>
        <Icon name="branch" />
        <span className="git-card-branch-name">{checkout.branch ?? 'detached'}</span>
        {onBase && <span className="git-chip git-chip-base">base</span>}
      </div>
      {dir !== '' && (
        <div className="git-card-path" title={checkout.path}>
          <span>{dir}/</span>
        </div>
      )}
      <div className="git-card-stats">
        {s ? (
          <DirtyBar
            staged={s.staged}
            unstaged={s.unstaged}
            untracked={s.untracked}
            conflicted={s.conflicted}
          />
        ) : (
          <span className="git-card-clean">…</span>
        )}
        {s && !onBase && base !== null && s.ahead !== null && s.behind !== null && (
          <AheadBehind ahead={s.ahead} behind={s.behind} base={base} />
        )}
      </div>
      <div className="git-card-actions" onClick={(e) => e.stopPropagation()}>
        <IconButton
          icon="folder"
          title="Open as workspace"
          disabled={missing}
          onClick={() => actions.openWorktreeAsWorkspace(root, checkout.path)}
        />
        <IconButton
          icon="terminal"
          title="Terminal here"
          disabled={missing}
          onClick={() => actions.openTerminalIn(root, checkout.path, false)}
        />
        <IconButton
          icon="sparkle"
          title="Harness here"
          disabled={missing}
          onClick={() => actions.openTerminalIn(root, checkout.path, true)}
        />
        {!onBase && base !== null && (
          <IconButton
            icon="diff"
            title={`Files changed against ${base}`}
            className={viewingDiff ? 'is-active' : undefined}
            onClick={() => actions.select(root, { kind: 'worktree-diff', path: checkout.path })}
          />
        )}
        {!onBase && base !== null && checkout.branch !== null && (
          <>
            <IconButton
              icon="merge-in"
              title={`Merge ${base} into ${checkout.branch} (here) — catch up with the base`}
              disabled={missing}
              onClick={() =>
                void actions.merge(root, base, { root: checkout.path, into: checkout.branch ?? '' })
              }
            />
            <IconButton
              icon="merge-out"
              title={`Merge ${checkout.branch} into ${base} (in the main checkout)`}
              onClick={() => void actions.merge(root, checkout.branch ?? '', { root, into: base })}
            />
          </>
        )}
        {!isMain && (
          <>
            <IconButton
              icon="flag"
              title="Finish… — merge into the base branch, remove the worktree, delete the branch"
              onClick={() => void actions.startFinish(root, checkout.path)}
            />
            <IconButton
              icon="trash"
              title="Remove this worktree"
              danger
              onClick={() => void actions.removeWorktree(root, checkout.path)}
            />
          </>
        )}
      </div>
    </div>
  );
}

export function WorktreeStrip({ root, tabId }: { root: string; tabId: string }) {
  const checkouts = useRepoSlice(root, (r) => r.checkouts) ?? [];
  const selectedCheckout = useRepoSlice(root, (r) => r.selectedCheckout) ?? root;
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  const base = useRepoSlice(root, (r) => r.info?.baseBranch ?? null) ?? null;
  const loading = useRepoSlice(root, (r) => r.loading.worktrees) ?? false;
  const tabs = useTabsStore((s) => s.tabs);
  const actions = gitStore.getState();
  const selKey = selectedCheckout.replaceAll('\\', '/').toLowerCase();
  const distractionFree = useUiStore((s) => s.distractionFree);
  const osFullscreen = useUiStore((s) => s.osFullscreen);
  // Same rule as App's drag strip: a fullscreen window has nowhere to go and
  // Android has no draggable window at all.
  const dragRegion = distractionFree && !osFullscreen && !isAndroid() ? '' : undefined;

  return (
    <header className="git-strip" aria-label="Checkouts">
      <div className="git-strip-scroll" data-tauri-drag-region={dragRegion}>
        {checkouts.length === 0 ? (
          <div className="git-card is-placeholder">
            {loading ? 'Listing worktrees…' : checkoutLabel(root, root)}
          </div>
        ) : (
          checkouts.map((c) => (
            <WorktreeCard
              key={c.path}
              root={root}
              tabId={tabId}
              checkout={c}
              base={base}
              selected={c.path.replaceAll('\\', '/').toLowerCase() === selKey}
              viewingDiff={selected?.kind === 'worktree-diff' && selected.path === c.path}
              terminals={terminalsInside(tabs, c.path)}
            />
          ))
        )}
        <button
          type="button"
          className="git-card git-card-new"
          title="Create a linked worktree on a new branch — a second folder checked out from this repository, for an agent to work in"
          onClick={() => actions.openNewWorktree(root)}
        >
          <Icon name="plus" />
          <span>New worktree</span>
        </button>
      </div>
      {/* Hidden with the rest of the chrome's buttons once chrome-less: the
          floating cluster (App) and Esc are the way back, as on a document. */}
      {!distractionFree && (
        <button
          type="button"
          className="git-strip-fullscreen"
          aria-label="Distraction-free"
          title="Distraction-free — hide the app chrome"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setDistractionFree(true)}
        >
          ⤢
        </button>
      )}
    </header>
  );
}
