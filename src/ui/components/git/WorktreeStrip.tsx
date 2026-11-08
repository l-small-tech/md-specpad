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
 * The funnel at the strip's right edge is the "active only" filter
 * (`gitActiveWorktreesOnly`, persisted): on, the strip lists just the
 * checkouts with something going on — `isActiveCheckout` in core — plus the
 * selected one, and a faint "+N clean" tally stands where the hidden cards
 * were; clicking it brings them back. Under it, the broom is "Delete all
 * clean worktrees" (shown only while there is one; the store opens the
 * dialog listing exactly what goes) — and its spinner + "2/5" while a run
 * goes. Beside it, the crossed folder is "Clear missing worktrees" (shown
 * only while a worktree's folder is gone): one confirm, then git's stale
 * records go and nothing on disk is touched. A card being removed (`repo.removing`) is dimmed and inert with a
 * "Removing…" chip in place of any "missing" one, until it is gone.
 *
 * The row scrolls sideways under a plain vertical wheel (ui/horizontal-wheel)
 * and wears the app's shared fading scrollbar, shown as well while the pointer
 * rests on the row. Cards clipped off either edge are announced by a fade on
 * that edge and a chevron that pages the row one card (`data-clip` on the
 * row, from core/strip-clip); the selected card is scrolled into view when it
 * changes, so the shown checkout is never off-screen.
 *
 * Each card's hover row holds the quick actions; two labelled pills, Sync
 * (merge the base in) and Land (merge the branch into the base), stay in
 * view since they are the point of a worktree. The same actions, plus Reveal
 * and Copy path, are a right-click (or Shift+F10) menu on the card.
 *
 * The strip is also the git tab's only header, so it carries the
 * distraction-free button the ribbon gives a document (the git tab has no
 * ribbon). While chrome-less and windowed, the empty room after the last card
 * (`.git-strip-drag`) doubles as the grab-to-move handle — the overlay strip
 * App lays over a document would sit exactly on the cards' top line and
 * swallow their clicks. The handle is that spacer alone, never the scroller:
 * a press on the scrollbar or the row's padding must scroll, not move the
 * window.
 */

import { useEffect, useRef, useState } from 'react';
import {
  checkoutKey,
  isActiveCheckout,
  terminalsInside as terminalsIn,
} from '../../../core/git/checkouts';
import type { GitCheckout } from '../../../core/git/types';
import { planCleanRemoval, removalProgressText } from '../../../core/git/worktree-removal';
import { stripClipState, type StripClip } from '../../../core/strip-clip';
import { ipc } from '../../../ipc/commands';
import { setDistractionFree } from '../../fullscreen';
import { installHorizontalWheel } from '../../horizontal-wheel';
import { isAndroid } from '../../platform';
import { gitStore, type RemovalProgress } from '../../stores/git';
import { settingsStore, useSettingsStore } from '../../stores/settings';
import { tabDisplayTitle, tabsStore, useTabsStore, type TabEntry } from '../../stores/tabs';
import { uiStore, useUiStore } from '../../stores/ui';
import { anchorFor, GitMenu, MenuItem, type MenuAnchor } from './GitMenu';
import { Icon, Spinner } from './icons';
import { checkoutDir, checkoutLabel, checkoutName, IconButton, useRepoSlice } from './shared';

/** Titles of the terminal tabs whose shell is inside `path` (core's containment rule). */
function terminalsInside(tabs: readonly TabEntry[], path: string): string[] {
  const shells = tabs
    .filter((t) => t.kind === 'terminal')
    .map((t) => ({ id: t.id, title: tabDisplayTitle(t), cwd: t.terminalCwd }));
  return terminalsIn(shells, path).map((s) => s.title);
}

const NONE: readonly string[] = [];

/** One card plus the row's gap: what a chevron click scrolls by. */
const CARD_STEP_PX = 228;

/**
 * A card's removal state: going now (with the progress text — "Removing 2 of
 * 5…" during the bulk delete), queued behind the bulk delete's current one,
 * or not being removed.
 */
function cardRemoval(
  path: string,
  removingKeys: ReadonlySet<string>,
  removal: RemovalProgress | null,
): { now: true; text: string } | { now: false } | null {
  if (!removingKeys.has(checkoutKey(path))) {
    return null;
  }
  if (removal === null) {
    return { now: true, text: 'Removing…' };
  }
  return removal.current !== null && checkoutKey(removal.current) === checkoutKey(path)
    ? { now: true, text: removalProgressText(removal.done, removal.total) }
    : { now: false };
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
  removing,
}: {
  root: string;
  tabId: string;
  checkout: GitCheckout;
  base: string | null;
  selected: boolean;
  viewingDiff: boolean;
  terminals: string[];
  /**
   * Its removal is in flight: `now` (this one is going — the progress text),
   * `queued` (the bulk delete gets to it next), or null.
   */
  removing: { now: true; text: string } | { now: false } | null;
}) {
  const actions = gitStore.getState();
  const s = checkout.summary;
  const isMain = checkout.isMain;
  const dir = checkoutDir(checkout.path, root);
  const onBase = base !== null && checkout.branch === base;
  // A card being removed never says "missing": its folder IS going away, on
  // purpose, and the card leaves once it has.
  const busy = removing !== null;
  const missing = s?.missing === true && !busy;
  // The card the bulk delete is on now slides into view, so its progress
  // is where the eye is.
  const cardRef = useRef<HTMLDivElement>(null);
  const goingNow = removing?.now === true;
  useEffect(() => {
    if (goingNow) {
      cardRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }, [goingNow]);
  // The shown checkout is never left clipped off an edge of the row.
  useEffect(() => {
    if (selected) {
      cardRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }, [selected]);
  const pick = () => {
    if (missing || busy) {
      return;
    }
    tabsStore.getState().setGitCheckout(tabId, checkout.path);
    actions.selectCheckout(root, checkout.path);
  };
  // The right-click menu: null while closed.
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const closeMenu = () => setMenu(null);
  const openMenuAt = (anchor: MenuAnchor) => {
    if (!busy) {
      setMenu(anchor);
    }
  };
  const canMerge = !onBase && base !== null && checkout.branch !== null;
  const upToDate = s?.behind === 0;
  const nothingToLand = s?.ahead === 0;
  const syncTitle =
    canMerge && upToDate
      ? `Up to date with ${base}`
      : `Fetch, then merge ${base} into ${checkout.branch} (here) — catch up with the base`;
  const landTitle = `Merge ${checkout.branch} into ${base} in the main checkout`;
  const copyPath = () => {
    void navigator.clipboard
      .writeText(checkout.path)
      .then(() => uiStore.getState().showNotice('Path copied.'))
      .catch(() => uiStore.getState().showNotice('Could not access the clipboard.'));
  };
  const reveal = () => {
    void ipc
      .openDir(checkout.path)
      .catch(() => uiStore.getState().showNotice('Could not open the folder.'));
  };
  /** Close the menu, then run the item. */
  const item = (run: () => void) => () => {
    closeMenu();
    run();
  };
  const classes = [
    'git-card',
    selected ? 'is-selected' : '',
    missing ? 'is-missing' : '',
    busy ? 'is-removing' : '',
    isMain ? 'is-main' : '',
    s && s.conflicted > 0 ? 'has-conflicts' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      ref={cardRef}
      className={classes}
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-pressed={selected}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      title={
        busy
          ? `${checkout.path}\n${removing.now ? 'Removing this worktree…' : 'Waiting to be removed'}`
          : `${checkout.path}${selected ? '' : '\nClick to show this checkout'}`
      }
      onClick={pick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenuAt({ x: e.clientX, y: e.clientY, dir: 'down' });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          if (cardRef.current) {
            openMenuAt(anchorFor(cardRef.current, 'down'));
          }
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
        {removing?.now === true && (
          <span className="git-chip git-chip-removing">
            <Spinner title="Removing" />
            {removing.text}
          </span>
        )}
        {removing?.now === false && <span className="git-chip">waiting…</span>}
        {!busy && s && s.state !== 'clean' && (
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
        {!busy && s?.locked && (
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
      {/* Hidden (not unmounted, so the card keeps its height) while it goes. */}
      <div
        className="git-card-actions"
        onClick={(e) => e.stopPropagation()}
        inert={busy || undefined}
      >
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
      {canMerge && s && (
        <div
          className="git-card-pills"
          onClick={(e) => e.stopPropagation()}
          inert={busy || undefined}
        >
          <button
            type="button"
            className="git-card-pill"
            title={syncTitle}
            disabled={missing || upToDate}
            onClick={() => void actions.syncWorktree(root, checkout.path)}
          >
            <Icon name="merge-in" />
            Sync
          </button>
          {!nothingToLand && (
            <button
              type="button"
              className="git-card-pill"
              title={landTitle}
              disabled={missing}
              onClick={() => void actions.landWorktree(root, checkout.path)}
            >
              <Icon name="merge-out" />
              Land
            </button>
          )}
        </div>
      )}
      {menu && (
        <GitMenu anchor={menu} onClose={closeMenu}>
          <div className="git-menu-head">
            <Icon name={isMain ? 'home' : 'folder'} />
            <span className="git-menu-title">{checkoutName(checkout.path, root)}</span>
          </div>
          <MenuItem
            disabled={missing}
            onClick={item(() => actions.openTerminalIn(root, checkout.path, false))}
          >
            <Icon name="terminal" />
            Terminal here
          </MenuItem>
          <MenuItem
            disabled={missing}
            onClick={item(() => actions.openTerminalIn(root, checkout.path, true))}
          >
            <Icon name="sparkle" />
            Harness here
          </MenuItem>
          <MenuItem
            disabled={missing}
            onClick={item(() => actions.openWorktreeAsWorkspace(root, checkout.path))}
          >
            <Icon name="folder" />
            Open as workspace
          </MenuItem>
          <MenuItem disabled={missing} onClick={item(reveal)}>
            <Icon name="folder" />
            Reveal in file manager
          </MenuItem>
          <MenuItem onClick={item(copyPath)}>
            <Icon name="copy" />
            Copy path
          </MenuItem>
          {(canMerge || !isMain) && <div className="git-menu-sep" role="separator" />}
          {!onBase && base !== null && (
            <MenuItem
              onClick={item(() =>
                actions.select(root, { kind: 'worktree-diff', path: checkout.path }),
              )}
            >
              <Icon name="diff" />
              Diff vs {base}
            </MenuItem>
          )}
          {canMerge && (
            <>
              <MenuItem
                disabled={missing || upToDate}
                title={syncTitle}
                onClick={item(() => void actions.syncWorktree(root, checkout.path))}
              >
                <Icon name="merge-in" />
                Sync — merge {base} in
              </MenuItem>
              <MenuItem
                disabled={missing || nothingToLand}
                title={
                  nothingToLand
                    ? `${base} already has every commit of ${checkout.branch}`
                    : landTitle
                }
                onClick={item(() => void actions.landWorktree(root, checkout.path))}
              >
                <Icon name="merge-out" />
                Land — merge into {base}
              </MenuItem>
            </>
          )}
          {!isMain && (
            <MenuItem onClick={item(() => void actions.startFinish(root, checkout.path))}>
              <Icon name="flag" />
              Finish…
            </MenuItem>
          )}
          {!isMain && (
            <>
              <div className="git-menu-sep" role="separator" />
              <MenuItem
                danger
                onClick={item(() => void actions.removeWorktree(root, checkout.path))}
              >
                <Icon name="trash" />
                Remove worktree
              </MenuItem>
            </>
          )}
        </GitMenu>
      )}
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
  const activeOnly = useSettingsStore((s) => s.settings.gitActiveWorktreesOnly);
  const setActiveOnly = (on: boolean) =>
    settingsStore.getState().update({ gitActiveWorktreesOnly: on });
  const removing = useRepoSlice(root, (r) => r.removing) ?? NONE;
  const removal = useRepoSlice(root, (r) => r.removal) ?? null;
  const finishing =
    useRepoSlice(root, (r) => (r.finish && !r.finish.finished ? r.finish.worktree : null)) ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    return el
      ? installHorizontalWheel(el, () => settingsStore.getState().settings.smoothScrolling)
      : undefined;
  }, []);
  // Which edges hide cards: drives the fades and the chevrons.
  const [clip, setClip] = useState<StripClip>('none');
  const measureClip = () => {
    const el = scrollRef.current;
    if (el) {
      setClip(stripClipState(el.scrollLeft, el.clientWidth, el.scrollWidth));
    }
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return undefined;
    }
    el.addEventListener('scroll', measureClip, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureClip);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measureClip);
      ro?.disconnect();
    };
  }, []);
  // The row's content width changes with the cards (filter, add, remove):
  // re-measure after every render; one layout read.
  useEffect(measureClip);
  const page = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (el) {
      el.scrollBy({ left: dir * CARD_STEP_PX, behavior: 'smooth' });
    }
  };
  const terminalsAt = new Map(checkouts.map((c) => [c.path, terminalsInside(tabs, c.path)]));
  const removingKeys = new Set(removing.map(checkoutKey));
  const removingState = (c: GitCheckout) => cardRemoval(c.path, removingKeys, removal);
  // What "Delete all clean worktrees" / "Clear missing worktrees" would take
  // right now (core decides).
  const terminalCwds = tabs
    .filter((t) => t.kind === 'terminal')
    .map((t) => ({ id: t.id, title: tabDisplayTitle(t), cwd: t.terminalCwd }));
  const busyPaths = finishing === null ? removing : [...removing, finishing];
  const cleanCount = planCleanRemoval(checkouts, terminalCwds, busyPaths).remove.length;
  const missingCount = planCleanRemoval(checkouts, terminalCwds, busyPaths, 'missing').remove
    .length;
  const isShown = (c: GitCheckout) =>
    !activeOnly ||
    c.path.replaceAll('\\', '/').toLowerCase() === selKey ||
    removingKeys.has(checkoutKey(c.path)) ||
    isActiveCheckout(c, (terminalsAt.get(c.path)?.length ?? 0) > 0);
  const shown = checkouts.filter(isShown);
  const hidden = checkouts.length - shown.length;
  // Same rule as App's drag strip: a fullscreen window has nowhere to go and
  // Android has no draggable window at all.
  const dragRegion = distractionFree && !osFullscreen && !isAndroid() ? '' : undefined;

  return (
    <header className="git-strip" aria-label="Checkouts">
      <div className="git-strip-row" data-clip={clip}>
        <div className="git-strip-scroll" ref={scrollRef}>
          {checkouts.length === 0 ? (
            <div className="git-card is-placeholder">
              {loading ? 'Listing worktrees…' : checkoutLabel(root, root)}
            </div>
          ) : (
            shown.map((c) => (
              <WorktreeCard
                key={c.path}
                root={root}
                tabId={tabId}
                checkout={c}
                base={base}
                selected={c.path.replaceAll('\\', '/').toLowerCase() === selKey}
                viewingDiff={selected?.kind === 'worktree-diff' && selected.path === c.path}
                terminals={terminalsAt.get(c.path) ?? []}
                removing={removingState(c)}
              />
            ))
          )}
          {hidden > 0 && (
            <button
              type="button"
              className="git-card git-card-hidden"
              title={`${hidden} clean ${hidden === 1 ? 'worktree is' : 'worktrees are'} hidden — click to show every worktree`}
              onClick={() => setActiveOnly(false)}
            >
              <span className="git-card-hidden-n">+{hidden}</span>
              <span>clean</span>
            </button>
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
          <div className="git-strip-drag" data-tauri-drag-region={dragRegion} />
        </div>
        {(clip === 'start' || clip === 'both') && (
          <button
            type="button"
            className="git-strip-nav is-start"
            aria-label="Scroll to earlier worktrees"
            title="Earlier worktrees"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => page(-1)}
          >
            <Icon name="chevron-left" />
          </button>
        )}
        {(clip === 'end' || clip === 'both') && (
          <button
            type="button"
            className="git-strip-nav is-end"
            aria-label="Scroll to more worktrees"
            title="More worktrees"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => page(1)}
          >
            <Icon name="chevron-right" />
          </button>
        )}
      </div>
      <div className="git-strip-tools">
        <button
          type="button"
          className={`git-strip-tool git-strip-filter${activeOnly ? ' is-on' : ''}`}
          aria-label="Active worktrees only"
          aria-pressed={activeOnly}
          title={
            activeOnly
              ? `Showing active worktrees only${hidden > 0 ? ` (${hidden} clean hidden)` : ''} — click to show all`
              : 'Show active worktrees only — hide the clean ones with no terminal open'
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setActiveOnly(!activeOnly)}
        >
          <Icon name="filter" />
          {activeOnly && hidden > 0 && <span className="git-strip-filter-n">{hidden}</span>}
        </button>
        {/* "Delete all clean worktrees" — only while there is one to delete,
            or while a run is going (then it is the progress). */}
        {removal !== null ? (
          <button
            type="button"
            className="git-strip-tool git-strip-clean is-running"
            aria-label={removalProgressText(removal.done, removal.total)}
            title={removalProgressText(removal.done, removal.total)}
            disabled
          >
            <Spinner title={removalProgressText(removal.done, removal.total)} />
            <span className="git-strip-filter-n">
              {Math.min(removal.done + 1, removal.total)}/{removal.total}
            </span>
          </button>
        ) : (
          cleanCount > 0 && (
            <button
              type="button"
              className="git-strip-tool git-strip-clean"
              aria-label="Delete all clean worktrees"
              title={`Delete all clean worktrees (${cleanCount}) — the ones with nothing uncommitted. Their branches and commits are kept; you will see the list first.`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => actions.removeCleanWorktrees(root)}
            >
              <Icon name="broom" />
              <span className="git-strip-filter-n">{cleanCount}</span>
            </button>
          )
        )}
        {removal === null && missingCount > 0 && (
          <button
            type="button"
            className="git-strip-tool git-strip-clean git-strip-missing"
            aria-label="Clear missing worktrees"
            title={`Clear missing worktrees (${missingCount}) — the ones whose folder is gone. Only git's record of them goes; branches and commits are kept.`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void actions.clearMissingWorktrees(root)}
          >
            <Icon name="folder-x" />
            <span className="git-strip-filter-n">{missingCount}</span>
          </button>
        )}
        {/* Hidden with the rest of the chrome's buttons once chrome-less: the
            floating cluster (App) and Esc are the way back, as on a document. */}
        {!distractionFree && (
          <button
            type="button"
            className="git-strip-tool git-strip-fullscreen"
            aria-label="Distraction-free"
            title="Distraction-free — hide the app chrome"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setDistractionFree(true)}
          >
            ⤢
          </button>
        )}
      </div>
    </header>
  );
}
