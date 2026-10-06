/**
 * Commit-graph layout — the lanes and edges the History pane draws beside
 * each commit row. Pure: commits in (newest first, as `git log --date-order`
 * lists them), one `GraphRow` per commit out.
 *
 * The algorithm is the classic "active lanes" sweep. Each lane awaits one
 * sha — the parent a line of history is heading for. A commit lands in the
 * first lane awaiting it (or a free one); the lane then awaits the commit's
 * first parent, every other parent either joins a lane already awaiting it
 * (a merge line curving into it) or opens a new lane, and a lane whose
 * awaited commit arrives in another lane closes into that node. Lanes never
 * shift sideways once allocated — a freed lane is simply reused later — so
 * a line of history keeps one x position for as long as it lasts, which is
 * what makes the picture readable.
 *
 * Colours: every lane carries a colour index assigned when its line of
 * history starts (`palette` of them, cycling), so a branch keeps its colour
 * from its tip down to where it joins the trunk. The trunk — the lane the
 * first commit lands in — is colour 0.
 */

import type { GitCommit } from './types';

/** How many lane colours the stylesheet defines (`--git-lane-0` … `--git-lane-7`). */
export const LANE_COLORS = 8;

export type GraphEdge =
  /** From the top of the row at `lane` into the commit's node. */
  | { kind: 'in'; lane: number; color: number }
  /** From the commit's node to the bottom of the row at `lane`. */
  | { kind: 'out'; lane: number; color: number }
  /** Straight through the row at `lane`, untouched by this commit. */
  | { kind: 'through'; lane: number; color: number };

export interface GraphRow {
  sha: string;
  /** The lane (column) the commit's node sits in. */
  lane: number;
  /** The node's colour index, `0 ≤ color < LANE_COLORS`. */
  color: number;
  /** True for a merge commit (two or more parents). */
  merge: boolean;
  edges: GraphEdge[];
  /** Lanes in use at the row's top or bottom — the row's drawn width. */
  width: number;
}

interface Lane {
  /** The sha this lane is heading for; null when the lane is free. */
  awaiting: string | null;
  color: number;
}

/**
 * Lay the commits out. Commits whose parents are not in the list (the
 * window's bottom edge) leave their lanes open — the line runs off the
 * bottom, as it should: history continues below the page.
 */
export function layoutGraph(commits: readonly GitCommit[]): GraphRow[] {
  const lanes: Lane[] = [];
  let nextColor = 0;
  const takeColor = (): number => {
    const c = nextColor % LANE_COLORS;
    nextColor += 1;
    return c;
  };
  const freeLane = (): number => {
    const idx = lanes.findIndex((l) => l.awaiting === null);
    if (idx !== -1) {
      return idx;
    }
    lanes.push({ awaiting: null, color: 0 });
    return lanes.length - 1;
  };
  const lastUsed = (): number => {
    let n = 0;
    lanes.forEach((l, i) => {
      if (l.awaiting !== null) {
        n = i + 1;
      }
    });
    return n;
  };

  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const edges: GraphEdge[] = [];
    const topWidth = lastUsed();

    // Where the node goes: the first lane awaiting this commit, else a free one.
    let nodeLane = lanes.findIndex((l) => l.awaiting === commit.sha);
    if (nodeLane === -1) {
      nodeLane = freeLane();
      lanes[nodeLane] = { awaiting: commit.sha, color: takeColor() };
    }
    const node = lanes[nodeLane] as Lane;
    const color = node.color;

    // Every lane heading for this commit closes into the node; the rest pass through.
    lanes.forEach((l, i) => {
      if (l.awaiting === null) {
        return;
      }
      if (l.awaiting === commit.sha) {
        edges.push({ kind: 'in', lane: i, color: l.color });
        if (i !== nodeLane) {
          lanes[i] = { awaiting: null, color: 0 };
        }
      } else {
        edges.push({ kind: 'through', lane: i, color: l.color });
      }
    });

    // Parents: the first continues the node's lane; the others curve into a
    // lane already awaiting them or open a new one.
    const [first, ...others] = commit.parents;
    if (first === undefined) {
      lanes[nodeLane] = { awaiting: null, color: 0 };
    } else {
      lanes[nodeLane] = { awaiting: first, color };
      edges.push({ kind: 'out', lane: nodeLane, color });
    }
    for (const parent of others) {
      let target = lanes.findIndex((l) => l.awaiting === parent);
      if (target === -1) {
        target = freeLane();
        lanes[target] = { awaiting: parent, color: takeColor() };
      }
      const laneColor = (lanes[target] as Lane).color;
      edges.push({ kind: 'out', lane: target, color: laneColor });
    }

    rows.push({
      sha: commit.sha,
      lane: nodeLane,
      color,
      merge: commit.parents.length > 1,
      edges,
      width: Math.max(topWidth, lastUsed(), nodeLane + 1),
    });
  }
  return rows;
}

/** The widest row — the column width every row shares so nodes line up. */
export function graphWidth(rows: readonly GraphRow[]): number {
  return rows.reduce((w, r) => Math.max(w, r.width), 1);
}
