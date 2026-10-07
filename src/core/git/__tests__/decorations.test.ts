import { describe, expect, it } from 'vitest';
import { checkoutsAt, foldRemotes, parseDecorations, remoteNames } from '../decorations';
import type { GitBranch, GitCheckout } from '../types';

const branch = (name: string, kind: GitBranch['kind']): GitBranch => ({
  name,
  kind,
  head: 'h',
  current: false,
  upstream: null,
  ahead: null,
  behind: null,
  gone: false,
  committedAt: '2026-10-01T00:00:00Z',
});

describe('parseDecorations', () => {
  it('reads HEAD ->, tags, remotes and locals, current first', () => {
    const refs = parseDecorations(
      ['tag: v1.0', 'origin/development', 'HEAD -> development', 'feat/x'],
      ['origin'],
    );
    expect(refs).toEqual([
      { kind: 'local', name: 'development', current: true },
      { kind: 'local', name: 'feat/x', current: false },
      { kind: 'remote', name: 'origin/development', current: false },
      { kind: 'tag', name: 'v1.0', current: false },
    ]);
  });

  it('a bare HEAD is a detached head and <remote>/HEAD is dropped', () => {
    expect(parseDecorations(['HEAD', 'origin/HEAD', 'origin/main'])).toEqual([
      { kind: 'head', name: 'HEAD', current: true },
      { kind: 'remote', name: 'origin/main', current: false },
    ]);
  });

  it('a slash in a local branch name is not a remote unless the list says so', () => {
    expect(parseDecorations(['feat/x'], ['origin'])[0]?.kind).toBe('local');
    expect(parseDecorations(['upstream/x'], ['origin', 'upstream'])[0]?.kind).toBe('remote');
  });

  it('ignores empty items', () => {
    expect(parseDecorations(['', '  '])).toEqual([]);
  });
});

describe('remoteNames', () => {
  it('collects the prefixes of remote branches once', () => {
    expect(
      remoteNames([
        branch('origin/a', 'remote'),
        branch('origin/b', 'remote'),
        branch('c', 'local'),
      ]),
    ).toEqual(['origin']);
  });
});

describe('foldRemotes', () => {
  it('folds a mirroring remote into the local pill as synced', () => {
    const pills = foldRemotes(
      parseDecorations(['HEAD -> development', 'origin/development', 'origin/other']),
      ['origin'],
    );
    expect(pills).toEqual([
      { kind: 'local', name: 'development', current: true, synced: true },
      { kind: 'remote', name: 'origin/other', current: false, synced: false },
    ]);
  });

  it('a local branch with no remote twin is not synced', () => {
    const pills = foldRemotes(parseDecorations(['feat/x']), ['origin']);
    expect(pills[0]?.synced).toBe(false);
  });
});

describe('checkoutsAt', () => {
  it('groups checkouts by head and skips unborn ones', () => {
    const co = (path: string, head: string): GitCheckout => ({
      path,
      branch: null,
      head,
      isMain: false,
      summary: null,
    });
    const map = checkoutsAt([co('/a', 'h1'), co('/b', 'h1'), co('/c', 'h2'), co('/d', '')]);
    expect(map.get('h1')?.map((c) => c.path)).toEqual(['/a', '/b']);
    expect(map.get('h2')?.length).toBe(1);
    expect(map.has('')).toBe(false);
  });
});
