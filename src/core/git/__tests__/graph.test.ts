import { describe, expect, it } from 'vitest';
import {
  ghostLane,
  graphWidth,
  LANE_COLORS,
  layoutGraph,
  withWorkingTree,
  WORKING_TREE_SHA,
  type GraphEdge,
} from '../graph';
import type { GitCommit } from '../types';

const c = (sha: string, parents: string[] = []): GitCommit => ({
  sha,
  short: sha.slice(0, 7),
  parents,
  author: 'me',
  at: '2026-10-01T00:00:00Z',
  subject: sha,
  body: '',
  refs: [],
});

const kinds = (edges: GraphEdge[], kind: GraphEdge['kind']) =>
  edges.filter((e) => e.kind === kind).map((e) => e.lane);

describe('layoutGraph', () => {
  it('keeps a linear history in one lane with colour 0', () => {
    const rows = layoutGraph([c('a', ['b']), c('b', ['c']), c('c')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.color)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1]);
    // The tip starts its line at the node — nothing drawn above it.
    expect(kinds(rows[0]!.edges, 'in')).toEqual([]);
    // a → b continues; b → c continues; the root ends its lane.
    expect(kinds(rows[0]!.edges, 'out')).toEqual([0]);
    expect(kinds(rows[2]!.edges, 'out')).toEqual([]);
    expect(kinds(rows[2]!.edges, 'in')).toEqual([0]);
  });

  it('a merge opens a second lane that closes back into the trunk', () => {
    // m merges f into trunk: m → (t1, f); f → t2; t1 → t2; t2 root.
    const rows = layoutGraph([c('m', ['t1', 'f']), c('f', ['t2']), c('t1', ['t2']), c('t2')]);
    expect(rows[0]).toMatchObject({ lane: 0, color: 0, merge: true, width: 2 });
    expect(kinds(rows[0]!.edges, 'out')).toEqual([0, 1]);
    // f sits in lane 1 with the branch colour, trunk passes through lane 0.
    expect(rows[1]).toMatchObject({ lane: 1, color: 1, merge: false });
    expect(kinds(rows[1]!.edges, 'through')).toEqual([0]);
    // t1 in lane 0; lane 1 still heading for t2 passes through.
    expect(rows[2]).toMatchObject({ lane: 0, color: 0 });
    expect(kinds(rows[2]!.edges, 'through')).toEqual([1]);
    // t2: both lanes close into the node; the lane is freed after.
    expect(kinds(rows[3]!.edges, 'in').sort()).toEqual([0, 1]);
    expect(rows[3]!.edges.filter((e) => e.kind === 'out')).toEqual([]);
    expect(graphWidth(rows)).toBe(2);
  });

  it('an unrelated branch tip opens its own lane and keeps its colour down to the join', () => {
    // Tip x of a side branch listed first (newer), then trunk a, then the common root r.
    const rows = layoutGraph([c('x', ['r']), c('a', ['r']), c('r')]);
    expect(rows[0]).toMatchObject({ lane: 0, color: 0 });
    expect(rows[1]).toMatchObject({ lane: 1, color: 1 });
    // r arrives in lane 0 (awaited there first); lane 1 closes into it.
    expect(rows[2]!.lane).toBe(0);
    expect(kinds(rows[2]!.edges, 'in').sort()).toEqual([0, 1]);
  });

  it('a parent outside the window leaves the lane running off the bottom', () => {
    const rows = layoutGraph([c('a', ['zzz'])]);
    expect(kinds(rows[0]!.edges, 'out')).toEqual([0]);
  });

  it('reuses freed lanes and cycles colours', () => {
    // Many independent roots in a row: each opens and closes lane 0 again.
    const roots = Array.from({ length: LANE_COLORS + 2 }, (_, i) => c(`r${i}`));
    const rows = layoutGraph(roots);
    expect(rows.every((r) => r.lane === 0)).toBe(true);
    expect(rows[LANE_COLORS]!.color).toBe(0);
    expect(rows[LANE_COLORS + 1]!.color).toBe(1);
  });

  it('octopus merges fan out to every parent', () => {
    const rows = layoutGraph([c('o', ['p', 'q', 'r'])]);
    expect(kinds(rows[0]!.edges, 'out')).toEqual([0, 1, 2]);
    expect(rows[0]!.width).toBe(3);
  });
});

describe('layoutGraph with trunks', () => {
  // The shape that put main on the far right: two feature tips (x, y) whose
  // parent is the trunk commit t, listed above main's tip m (a merge of
  // t into the older main commit m0). Without trunks, x and y hold lanes 0
  // and 1 until t, so m lands in lane 2 — right of every feature line.
  const history = [
    c('x', ['t']),
    c('y', ['t']),
    c('m', ['m0', 't']),
    c('t', ['t0']),
    c('m0', ['t0']),
    c('t0'),
  ];

  it('without trunks, a late tip takes whatever lane is free', () => {
    const rows = layoutGraph(history);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 2, 0, 2, 0]);
  });

  it("reserves lane 1 for the base branch's first-parent chain", () => {
    const rows = layoutGraph(history, ['x', 'm']);
    // x (HEAD) in lane 0; y is pushed past the reserved lane; m and m0 in lane 1.
    expect(rows.map((r) => r.lane)).toEqual([0, 2, 1, 0, 1, 0]);
    expect(rows[2]!.color).toBe(rows[4]!.color);
    // m's second parent is the trunk commit t: its edge aims straight at lane 0.
    expect(kinds(rows[2]!.edges, 'out').sort()).toEqual([0, 1]);
    // m0's parent is on the HEAD trunk: lane 1 closes into t0's node in lane 0.
    expect(kinds(rows[5]!.edges, 'in').sort()).toEqual([0, 1]);
    expect(graphWidth(rows)).toBe(3);
  });

  it('keeps the trunk lane for the trunk even when other lanes are free', () => {
    const rows = layoutGraph([c('a', ['b']), c('b')], ['zzz', 'a']);
    // zzz is not in the window — it reserves nothing; a's chain takes lane 0.
    expect(rows.map((r) => r.lane)).toEqual([0, 0]);
  });

  it('a merge that reaches a trunk tip from above curves into its lane', () => {
    // d (HEAD) merged main's tip m back: d → (d0, m); m → m0; d0 → m0.
    const rows = layoutGraph(
      [c('d', ['d0', 'm']), c('d0', ['m0']), c('m', ['m0']), c('m0')],
      ['d', 'm'],
    );
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
    expect(kinds(rows[0]!.edges, 'out')).toEqual([0, 1]);
    // m keeps the colour the merge edge opened with — one continuous line.
    expect(rows[2]!.color).toBe(rows[0]!.edges.find((e) => e.lane === 1)!.color);
  });

  it('a trunk tip nothing points at has no line above it; one a merge reaches does', () => {
    const rows = layoutGraph([c('x', ['t']), c('m', ['m0', 't']), c('t'), c('m0')], ['x', 'm']);
    expect(rows[1]).toMatchObject({ lane: 1 });
    expect(kinds(rows[1]!.edges, 'in')).toEqual([]);
    // m0 is awaited by lane 1 (m's first parent): the line comes in from the top.
    expect(kinds(rows[3]!.edges, 'in')).toEqual([1]);
  });

  it('a trunk whose tip is already on another trunk reserves nothing', () => {
    // HEAD is on main: both tips are the same commit.
    const rows = layoutGraph([c('a', ['b']), c('b')], ['a', 'a']);
    expect(rows.map((r) => r.width)).toEqual([1, 1]);
  });
});

describe('the working-tree ghost row', () => {
  it('sits in lane 0 above HEAD and its line runs down to HEAD', () => {
    // f (another branch, newer) sits between the ghost and HEAD h.
    const log = [c('f', ['h']), c('h', ['h0']), c('h0')];
    const rows = layoutGraph(withWorkingTree(log, 'h'), [WORKING_TREE_SHA, 'h']);
    expect(rows[0]).toMatchObject({ sha: WORKING_TREE_SHA, lane: 0, color: 0 });
    expect(kinds(rows[0]!.edges, 'in')).toEqual([]);
    expect(kinds(rows[0]!.edges, 'out')).toEqual([0]);
    // f takes lane 1; the ghost's line passes through lane 0 beside it.
    expect(rows[1]).toMatchObject({ sha: 'f', lane: 1 });
    expect(kinds(rows[1]!.edges, 'through')).toEqual([0]);
    // Both lines close into HEAD; HEAD keeps the ghost's lane and colour.
    expect(rows[2]).toMatchObject({ sha: 'h', lane: 0, color: 0 });
    expect(kinds(rows[2]!.edges, 'in').sort()).toEqual([0, 1]);
    expect(ghostLane(rows, 'h')).toEqual({ lane: 0, until: 2 });
  });

  it('on an unborn branch the ghost is a lone node', () => {
    const rows = layoutGraph(withWorkingTree([], ''), [WORKING_TREE_SHA]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.edges).toEqual([]);
    expect(ghostLane(rows, '')).toEqual({ lane: 0, until: 0 });
  });

  it('runs the dashed line off the bottom when HEAD is below the window', () => {
    const rows = layoutGraph(withWorkingTree([c('x', ['y'])], 'h'), [WORKING_TREE_SHA, 'h']);
    expect(ghostLane(rows, 'h')).toEqual({ lane: 0, until: 1 });
  });

  it('reports no ghost lane for a plain log', () => {
    expect(ghostLane(layoutGraph([c('a')]), 'a')).toBeNull();
  });
});
