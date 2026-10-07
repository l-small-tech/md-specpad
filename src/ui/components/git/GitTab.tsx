/**
 * GitTab — the source-control panel behind a `kind: 'git'` tab. One per open
 * git tab, all mounted at once and hidden with `display: none` when inactive
 * (ImageView's pattern; rule I7 — nothing here is an editor, but the panel's
 * scroll positions and collapsed sections are worth keeping).
 *
 * Layout: the WorktreeStrip (one card per checkout — the checkout picker)
 * on top; below it two columns. The side column is the inspector
 * (GitInspector): it follows the graph's selection — the working tree
 * (conflicts, commit box, change list) while nothing or one of its files is
 * selected, else the selected commit's files, a worktree's files against
 * the base, or the finish flow. The main column is the commit graph — with
 * the working tree's ghost row on top while there is something to commit —
 * and under it, only while a file is picked, its diff (GitDiffDetail), with
 * the output drawer at the foot. Both dividers drag like EditorHost's Split
 * one: the ratios are module-level, shared by every git tab for the
 * session, and applied straight to the style so dragging never re-renders.
 * The network buttons and the branch picker live in the status bar
 * (GitStatusBar), where the mode segments would otherwise sit.
 *
 * Everything shown is `useGitStore` state; every click is a store action.
 * Mount → `ensureRepo`; becoming active → `refresh`. One keydown handler on
 * the host root takes Escape: close the dialog, else step the selection
 * back one level (diff → its commit → the working tree).
 */

import { memo, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { gitStore, repoKey, useGitStore } from '../../stores/git';
import { useTabsStore } from '../../stores/tabs';
import '../../../styles/git.css';
import { GitDiffDetail, GitInspector, hasDiffDetail } from './GitDetail';
import { GitUnavailable } from './GitStates';
import { GraphPane } from './GraphPane';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { OutputDrawer } from './OutputDrawer';
import { WorktreeStrip } from './WorktreeStrip';

/** Side-column share of the body width, shared by every git tab (session only). */
let sideRatio = 0.32;
const MIN_SIDE_PX = 240;
/** Detail share of the main column's height while something is selected. */
let detailRatio = 0.58;

function clampRatio(ratio: number, totalPx: number, minPx: number): number {
  const min = totalPx > 0 ? minPx / totalPx : 0.2;
  return Math.min(0.85, Math.max(min, ratio));
}

/** Drag a divider: `apply(ratio)` on every move, ratio from the pointer along `axis`. */
function dragDivider(
  e: React.PointerEvent<HTMLDivElement>,
  area: HTMLElement,
  axis: 'x' | 'y',
  minPx: number,
  apply: (ratio: number) => void,
) {
  e.preventDefault();
  const divider = e.currentTarget;
  divider.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent) => {
    const rect = area.getBoundingClientRect();
    const ratio =
      axis === 'x' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
    apply(clampRatio(ratio, axis === 'x' ? rect.width : rect.height, minPx));
  };
  const onUp = () => {
    divider.removeEventListener('pointermove', onMove);
    divider.removeEventListener('pointerup', onUp);
    divider.removeEventListener('pointercancel', onUp);
  };
  divider.addEventListener('pointermove', onMove);
  divider.addEventListener('pointerup', onUp);
  divider.addEventListener('pointercancel', onUp);
}

function GitTabImpl({ tabId, active }: { tabId: string; active: boolean }) {
  const root = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.gitRoot ?? null);
  const checkout = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.gitCheckout ?? null);
  const key = root === null ? '' : repoKey(root);
  const unavailable = useGitStore((s) => s.repos[key]?.unavailable ?? null);
  const dialogOpen = useGitStore((s) => s.repos[key]?.newWorktree.open ?? false);
  const hasSelection = useGitStore((s) => hasDiffDetail(s.repos[key]?.selected ?? null));
  const bodyRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);

  // Track the repository for as long as a tab shows it (forgetting is the
  // tabs-store subscription's job in git-open.ts, once the last tab closes).
  useEffect(() => {
    if (root !== null) {
      gitStore.getState().ensureRepo(root, checkout);
    }
    // Mount only: the worktree cards drive later changes through the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Coming to the front re-asks git (throttled in the store).
  useEffect(() => {
    if (active && root !== null) {
      void gitStore.getState().refresh(root);
    }
  }, [active, root]);

  // Apply the shared ratios whenever the columns (re)mount.
  useEffect(() => {
    const side = sideRef.current;
    if (side) {
      side.style.flex = `0 0 ${sideRatio * 100}%`;
    }
    const graph = graphRef.current;
    if (graph) {
      graph.style.flex = hasSelection ? `0 0 ${(1 - detailRatio) * 100}%` : '1 1 auto';
    }
  });

  const startSideDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    const side = sideRef.current;
    if (body && side) {
      dragDivider(e, body, 'x', MIN_SIDE_PX, (ratio) => {
        sideRatio = ratio;
        side.style.flex = `0 0 ${ratio * 100}%`;
      });
    }
  };
  const startDetailDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const main = mainRef.current;
    const graph = graphRef.current;
    if (main && graph) {
      dragDivider(e, main, 'y', 120, (ratio) => {
        detailRatio = 1 - ratio;
        graph.style.flex = `0 0 ${ratio * 100}%`;
      });
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || root === null) {
      return;
    }
    const state = gitStore.getState();
    if (dialogOpen) {
      e.preventDefault();
      e.stopPropagation();
      state.closeNewWorktree(root);
      return;
    }
    const selected = state.repos[key]?.selected ?? null;
    if (selected !== null) {
      e.preventDefault();
      e.stopPropagation();
      // One level back: a commit's file diff → the commit; anything else →
      // the working tree.
      state.select(
        root,
        selected.kind === 'commit' && selected.path !== undefined
          ? { kind: 'commit', sha: selected.sha }
          : null,
      );
    }
  };

  return (
    <div
      className="editor-host git-host"
      style={{ display: active ? 'flex' : 'none' }}
      onKeyDown={onKeyDown}
    >
      {root === null ? (
        <GitUnavailable kind="not-a-repo" root={null} tabId={tabId} />
      ) : unavailable !== null ? (
        <GitUnavailable kind={unavailable} root={root} tabId={tabId} />
      ) : (
        <>
          <WorktreeStrip root={root} tabId={tabId} />
          <div className="git-body" ref={bodyRef}>
            <div className="git-side" ref={sideRef}>
              <GitInspector root={root} />
            </div>
            <div
              className="git-divider"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startSideDrag}
            />
            <div className="git-main" ref={mainRef}>
              <div className="git-graph-area" ref={graphRef}>
                <GraphPane root={root} tabId={tabId} />
              </div>
              {hasSelection && (
                <>
                  <div
                    className="git-divider-h"
                    role="separator"
                    aria-orientation="horizontal"
                    onPointerDown={startDetailDrag}
                  />
                  <div className="git-detail">
                    <div className="git-detail-main">
                      <GitDiffDetail root={root} />
                    </div>
                  </div>
                </>
              )}
              <OutputDrawer root={root} />
            </div>
          </div>
          <NewWorktreeDialog root={root} />
        </>
      )}
    </div>
  );
}

export const GitTab = memo(GitTabImpl);
