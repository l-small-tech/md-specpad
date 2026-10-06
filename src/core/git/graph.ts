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
 * Trunks: the caller may name tips (the checked-out branch, the base branch)
 * whose first-parent chains deserve the left-hand lanes. Lane `i` is reserved
 * for trunk `i` — no other line is ever laid in it, and every parent edge
 * heading for a trunk commit aims straight at its lane — so the branches a
 * reader navigates by stay at the left edge of the graph instead of landing
 * wherever a lane happened to be free when their tip came up. A trunk whose
 * tip is not in the window reserves nothing; a trunk whose chain runs into an
 * earlier trunk's chain hands over at the shared commit.
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

const FREE: Lane = { awaiting: null, color: 0 };

/**
 * Which reserved lane each commit on a trunk's first-parent chain belongs
 * to. Trunks are taken in order; a tip outside the window is skipped, and a
 * chain stops where it meets a commit an earlier trunk already claimed.
 * Returns the map and how many lanes it reserves.
 */
function claimTrunks(
  commits: readonly GitCommit[],
  trunks: readonly string[],
): { laneOf: Map<string, number>; reserved: number } {
  const byIndex = new Map<string, GitCommit>();
  for (const c of commits) {
    byIndex.set(c.sha, c);
  }
  const laneOf = new Map<string, number>();
  let reserved = 0;
  for (const tip of trunks) {
    if (!byIndex.has(tip) || laneOf.has(tip)) {
      continue;
    }
    const lane = reserved;
    reserved += 1;
    let sha: string | undefined = tip;
    while (sha !== undefined && !laneOf.has(sha)) {
      const commit = byIndex.get(sha);
      if (commit === undefined) {
        break;
      }
      laneOf.set(sha, lane);
      sha = commit.parents[0];
    }
  }
  return { laneOf, reserved };
}

/**
 * Lay the commits out. Commits whose parents are not in the list (the
 * window's bottom edge) leave their lanes open — the line runs off the
 * bottom, as it should: history continues below the page. `trunks` are
 * tip shas, most important first, whose first-parent chains take the
 * leftmost lanes (see the module comment).
 */
export function layoutGraph(
  commits: readonly GitCommit[],
  trunks: readonly string[] = [],
): GraphRow[] {
  const { laneOf: trunkLane, reserved } = claimTrunks(commits, trunks);
  const lanes: Lane[] = Array.from({ length: reserved }, () => FREE);
  let nextColor = 0;
  const takeColor = (): number => {
    const c = nextColor % LANE_COLORS;
    nextColor += 1;
    return c;
  };
  const freeLane = (): number => {
    for (let i = reserved; i < lanes.length; i += 1) {
      if ((lanes[i] as Lane).awaiting === null) {
        return i;
      }
    }
    lanes.push(FREE);
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
  /**
   * The lane a line heading for `sha` should take: the lane already awaiting
   * it; else, for a trunk commit, its reserved lane while that is free; else
   * a free lane. Opens the lane (with a fresh colour) when nothing awaits it.
   */
  const laneFor = (sha: string): number => {
    const awaiting = lanes.findIndex((l) => l.awaiting === sha);
    if (awaiting !== -1) {
      return awaiting;
    }
    const trunk = trunkLane.get(sha);
    const lane =
      trunk !== undefined && (lanes[trunk] as Lane).awaiting === null ? trunk : freeLane();
    lanes[lane] = { awaiting: sha, color: takeColor() };
    return lane;
  };

  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const edges: GraphEdge[] = [];
    const topWidth = lastUsed();

    // Where the node goes: a trunk commit sits in its reserved lane; any
    // other in the first lane awaiting it, else a free one.
    const trunk = trunkLane.get(commit.sha);
    let nodeLane: number;
    if (trunk !== undefined) {
      nodeLane = trunk;
      if ((lanes[trunk] as Lane).awaiting !== commit.sha) {
        // The line reaching this commit (if any) was laid elsewhere — a
        // merge's edge opened before the trunk lane was free. The node keeps
        // that line's colour so the curve into the lane reads as one line.
        const feeder = lanes.find((l) => l.awaiting === commit.sha);
        lanes[trunk] = { awaiting: commit.sha, color: feeder?.color ?? takeColor() };
      }
    } else {
      nodeLane = laneFor(commit.sha);
    }
    const color = (lanes[nodeLane] as Lane).color;

    // Every lane heading for this commit closes into the node; the rest pass through.
    lanes.forEach((l, i) => {
      if (l.awaiting === null) {
        return;
      }
      if (l.awaiting === commit.sha) {
        edges.push({ kind: 'in', lane: i, color: l.color });
        if (i !== nodeLane) {
          lanes[i] = FREE;
        }
      } else {
        edges.push({ kind: 'through', lane: i, color: l.color });
      }
    });

    // Parents: the first continues the node's lane; the others curve into a
    // lane already awaiting them, the trunk lane they belong to, or a new one.
    const [first, ...others] = commit.parents;
    if (first === undefined) {
      lanes[nodeLane] = FREE;
    } else {
      lanes[nodeLane] = { awaiting: first, color };
      edges.push({ kind: 'out', lane: nodeLane, color });
    }
    for (const parent of others) {
      const target = laneFor(parent);
      edges.push({ kind: 'out', lane: target, color: (lanes[target] as Lane).color });
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
