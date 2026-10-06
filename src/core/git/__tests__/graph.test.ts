import { describe, expect, it } from 'vitest';
import { graphWidth, LANE_COLORS, layoutGraph, type GraphEdge } from '../graph';
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
