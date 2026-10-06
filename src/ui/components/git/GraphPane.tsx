/**
 * GraphPane — the history of the whole repository as a commit graph: one
 * row per commit with its lanes drawn in SVG (core/git/graph.ts lays them
 * out, this file only paints), the refs pinned on it as pills (branch,
 * remote, tag, and the worktrees standing on it), the subject, an author
 * mark, and the age. Click a row for the commit's files; click a branch pill
 * for its actions (BranchMenu); click a worktree pill to show that checkout.
 * "Load more" pages further back until git says there is no more.
 */

import { useMemo, useState } from 'react';
import {
  checkoutsAt,
  foldRemotes,
  parseDecorations,
  remoteNames,
  type RefPill,
} from '../../../core/git/decorations';
import { graphWidth, layoutGraph, type GraphRow } from '../../../core/git/graph';
import type { GitBranch, GitCheckout, GitCommit } from '../../../core/git/types';
import { relativeTime } from '../../../core/notes-overview';
import { gitStore } from '../../stores/git';
import { tabsStore } from '../../stores/tabs';
import { BranchMenu } from './BranchPicker';
import { anchorFor, type MenuAnchor } from './GitMenu';
import { Icon } from './icons';
import { checkoutLabel, Empty, useNow, useRepoSlice } from './shared';

const ROW_H = 30;
/** One shared empty list, so a missing repo slice is a stable memo input. */
const NONE: never[] = [];
const LANE_W = 16;
const PAD_X = 10;
const R = 4.5;

const laneX = (lane: number) => PAD_X + lane * LANE_W;

/** One row's lanes: through lines, curves into and out of the node, the node. */
function RowGraph({ row, width, isHead }: { row: GraphRow; width: number; isHead: boolean }) {
  const w = PAD_X * 2 + (width - 1) * LANE_W;
  const cx = laneX(row.lane);
  const cy = ROW_H / 2;
  const color = (i: number) => `var(--git-lane-${i})`;
  const paths = row.edges.map((e, i) => {
    const x = laneX(e.lane);
    let d: string;
    if (e.kind === 'through') {
      d = `M${x} 0 V${ROW_H}`;
    } else if (e.kind === 'in') {
      d = x === cx ? `M${x} 0 V${cy}` : `M${x} 0 C${x} ${cy * 0.9} ${cx} ${cy * 0.3} ${cx} ${cy}`;
    } else {
      d =
        x === cx
          ? `M${cx} ${cy} V${ROW_H}`
          : `M${cx} ${cy} C${cx} ${cy * 1.7} ${x} ${cy * 1.1} ${x} ${ROW_H}`;
    }
    return <path key={i} d={d} stroke={color(e.color)} />;
  });
  return (
    <svg
      className="git-graph-svg"
      width={w}
      height={ROW_H}
      viewBox={`0 0 ${w} ${ROW_H}`}
      aria-hidden="true"
    >
      {paths}
      {isHead && (
        <circle className="git-graph-halo" cx={cx} cy={cy} r={R + 4} fill={color(row.color)} />
      )}
      <circle
        className={`git-graph-node${row.merge ? ' is-merge' : ''}`}
        cx={cx}
        cy={cy}
        r={row.merge ? R - 0.5 : R}
        fill={row.merge ? 'var(--editor-bg)' : color(row.color)}
        stroke={color(row.color)}
      />
    </svg>
  );
}

/** A deterministic 0–359 hue from a name, for the author mark. */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) % 360;
  }
  return h;
}

function initials(name: string): string {
  // "Ada Lovelace" → AL; "l-small-tech" → LT; "ada" → AD.
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : (parts[0]?.[1] ?? '');
  return (a + b).toUpperCase();
}

function Pill({
  pill,
  branch,
  onOpen,
}: {
  pill: RefPill;
  branch: GitBranch | null;
  onOpen: (anchor: MenuAnchor, branch: GitBranch) => void;
}) {
  const icon = pill.kind === 'tag' ? 'tag' : pill.kind === 'remote' ? 'cloud' : 'branch';
  const classes = `git-pill is-${pill.kind}${pill.current ? ' is-current' : ''}`;
  const title =
    pill.kind === 'tag'
      ? `Tag ${pill.name}`
      : pill.kind === 'head'
        ? 'HEAD — detached at this commit'
        : pill.kind === 'remote'
          ? `${pill.name} — the remote's branch`
          : `${pill.name}${pill.current ? ' — the checked-out branch' : ''}${pill.synced ? ' · in sync with the remote' : ''}`;
  if (branch === null) {
    return (
      <span className={classes} title={title}>
        <Icon name={icon} />
        {pill.name}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={classes}
      title={`${title}\nClick for actions`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(anchorFor(e.currentTarget, 'down'), branch);
      }}
    >
      <Icon name={icon} />
      {pill.name}
      {pill.synced && <Icon name="cloud" className="git-pill-synced" />}
    </button>
  );
}

function WorktreePill({
  root,
  tabId,
  checkout,
  selected,
}: {
  root: string;
  tabId: string;
  checkout: GitCheckout;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      className={`git-pill is-worktree${selected ? ' is-current' : ''}`}
      title={`${checkout.path}\nThis checkout stands on this commit — click to show it`}
      onClick={(e) => {
        e.stopPropagation();
        tabsStore.getState().setGitCheckout(tabId, checkout.path);
        gitStore.getState().selectCheckout(root, checkout.path);
      }}
    >
      <Icon name={checkout.isMain ? 'home' : 'folder'} />
      {checkoutLabel(checkout.path, root)}
    </button>
  );
}

function CommitRow({
  root,
  tabId,
  commit,
  row,
  width,
  pills,
  worktrees,
  branches,
  selectedCheckout,
  isHead,
  selected,
  now,
  onOpen,
}: {
  root: string;
  tabId: string;
  commit: GitCommit;
  row: GraphRow;
  width: number;
  pills: RefPill[];
  worktrees: GitCheckout[];
  branches: GitBranch[];
  selectedCheckout: string;
  isHead: boolean;
  selected: boolean;
  now: number;
  onOpen: (anchor: MenuAnchor, branch: GitBranch) => void;
}) {
  const select = () => gitStore.getState().select(root, { kind: 'commit', sha: commit.sha });
  const hue = hueOf(commit.author);
  return (
    <div
      className={`git-graph-row${selected ? ' is-selected' : ''}${isHead ? ' is-head' : ''}`}
      style={{ height: ROW_H }}
      role="button"
      tabIndex={0}
      title={`${commit.sha}\n${commit.author} · ${commit.at}`}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          select();
        }
      }}
    >
      <RowGraph row={row} width={width} isHead={isHead} />
      <div className="git-graph-text">
        {worktrees.map((c) => (
          <WorktreePill
            key={c.path}
            root={root}
            tabId={tabId}
            checkout={c}
            selected={c.path.replaceAll('\\', '/').toLowerCase() === selectedCheckout}
          />
        ))}
        {pills.map((p) => (
          <Pill
            key={`${p.kind}:${p.name}`}
            pill={p}
            branch={
              p.kind === 'local' || p.kind === 'remote'
                ? (branches.find((b) => b.name === p.name) ?? null)
                : null
            }
            onOpen={onOpen}
          />
        ))}
        <span className="git-graph-subject">{commit.subject}</span>
      </div>
      <span
        className="git-author"
        style={{ '--git-author-hue': hue } as React.CSSProperties}
        title={commit.author}
      >
        {initials(commit.author)}
      </span>
      <span className="git-graph-age">{relativeTime(commit.at, now)}</span>
      <span className="git-sha">{commit.short}</span>
    </div>
  );
}

export function GraphPane({ root, tabId }: { root: string; tabId: string }) {
  const log = useRepoSlice(root, (r) => r.log) ?? NONE;
  const exhausted = useRepoSlice(root, (r) => r.logExhausted) ?? false;
  const loading = useRepoSlice(root, (r) => r.loading.log) ?? false;
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  const branches = useRepoSlice(root, (r) => r.branches) ?? NONE;
  const checkouts = useRepoSlice(root, (r) => r.checkouts) ?? NONE;
  const selectedCheckout = useRepoSlice(root, (r) => r.selectedCheckout) ?? root;
  const head = useRepoSlice(root, (r) => r.status?.head ?? '') ?? '';
  const actions = gitStore.getState();
  const now = useNow();
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; branch: GitBranch } | null>(null);

  const rows = useMemo(() => layoutGraph(log), [log]);
  const width = useMemo(() => graphWidth(rows), [rows]);
  const remotes = useMemo(() => remoteNames(branches), [branches]);
  const pillsBySha = useMemo(() => {
    const map = new Map<string, RefPill[]>();
    for (const c of log) {
      if (c.refs.length > 0) {
        map.set(c.sha, foldRemotes(parseDecorations(c.refs, remotes), remotes));
      }
    }
    return map;
  }, [log, remotes]);
  const worktreesBySha = useMemo(() => checkoutsAt(checkouts), [checkouts]);
  const selKey = selectedCheckout.replaceAll('\\', '/').toLowerCase();

  return (
    <section className="git-graph" aria-label="History">
      <div className="git-graph-head">
        <Icon name="history" />
        <span className="git-section-title">History</span>
        <span className="git-count">{log.length}</span>
        <span className="git-graph-legend">
          <span className="git-pill is-local">
            <Icon name="branch" />
            branch
          </span>
          <span className="git-pill is-remote">
            <Icon name="cloud" />
            remote
          </span>
          <span className="git-pill is-tag">
            <Icon name="tag" />
            tag
          </span>
          <span className="git-pill is-worktree">
            <Icon name="folder" />
            worktree
          </span>
        </span>
      </div>
      <div className="git-graph-scroll">
        {log.length === 0 ? (
          <Empty>{loading ? 'Reading the log…' : 'No commits yet'}</Empty>
        ) : (
          log.map((c, i) => (
            <CommitRow
              key={c.sha}
              root={root}
              tabId={tabId}
              commit={c}
              row={rows[i] as GraphRow}
              width={width}
              pills={pillsBySha.get(c.sha) ?? []}
              worktrees={worktreesBySha.get(c.sha) ?? []}
              branches={branches}
              selectedCheckout={selKey}
              isHead={c.sha === head}
              selected={selected?.kind === 'commit' && selected.sha === c.sha}
              now={now}
              onOpen={(anchor, branch) => setMenu({ anchor, branch })}
            />
          ))
        )}
        {log.length > 0 && !exhausted && (
          <button
            type="button"
            className="git-link-btn git-load-more"
            disabled={loading}
            onClick={() => void actions.loadMoreLog(root)}
          >
            {loading ? 'Loading…' : 'Load more history'}
          </button>
        )}
      </div>
      {menu && (
        <BranchMenu
          root={root}
          branch={menu.branch}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
