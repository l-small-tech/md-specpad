/**
 * Ref decorations — the labels the graph pins on a commit, parsed from
 * `git log --format=%D` items (`HEAD -> development`, `origin/development`,
 * `tag: v0.10.1`, `HEAD`). Pure.
 */

import type { GitBranch, GitCheckout } from './types';

export type RefKind = 'local' | 'remote' | 'tag' | 'head';

export interface CommitRef {
  kind: RefKind;
  /** `development`, `origin/development`, `v0.10.1`; `HEAD` for a detached head. */
  name: string;
  /** The ref HEAD points at (`HEAD -> name`, or a bare detached `HEAD`). */
  current: boolean;
}

/** The remote names the branch list knows (`origin/x` → `origin`). */
export function remoteNames(branches: readonly GitBranch[]): string[] {
  const out = new Set<string>();
  for (const b of branches) {
    if (b.kind === 'remote') {
      const slash = b.name.indexOf('/');
      if (slash > 0) {
        out.add(b.name.slice(0, slash));
      }
    }
  }
  return [...out];
}

/**
 * Parse one commit's decorations. `remotes` decides whether `a/b` is a
 * remote branch or a local one with a slash in its name (`feat/x`); without
 * the list, `origin/…` is the one remote assumed. `<remote>/HEAD` is dropped
 * — it only says which branch the remote defaults to.
 */
export function parseDecorations(
  refs: readonly string[],
  remotes: readonly string[] = ['origin'],
): CommitRef[] {
  const out: CommitRef[] = [];
  for (const raw of refs) {
    const item = raw.trim();
    if (item === '') {
      continue;
    }
    if (item === 'HEAD') {
      out.push({ kind: 'head', name: 'HEAD', current: true });
      continue;
    }
    if (item.startsWith('HEAD -> ')) {
      out.push({ kind: 'local', name: item.slice('HEAD -> '.length), current: true });
      continue;
    }
    if (item.startsWith('tag: ')) {
      out.push({ kind: 'tag', name: item.slice('tag: '.length), current: false });
      continue;
    }
    const slash = item.indexOf('/');
    const remote = slash > 0 && remotes.includes(item.slice(0, slash));
    if (remote) {
      if (item.slice(slash + 1) === 'HEAD') {
        continue;
      }
      out.push({ kind: 'remote', name: item, current: false });
      continue;
    }
    out.push({ kind: 'local', name: item, current: false });
  }
  // Current first, then local, remote, tag — the order the pills read best in.
  const rank: Record<RefKind, number> = { head: 0, local: 1, remote: 2, tag: 3 };
  return out.sort((a, b) =>
    a.current !== b.current ? (a.current ? -1 : 1) : rank[a.kind] - rank[b.kind],
  );
}

/**
 * A remote ref that merely mirrors a local one on the same commit
 * (`development` + `origin/development`) says nothing new: fold it into the
 * local pill as `synced`. Returns the pills to draw.
 */
export interface RefPill extends CommitRef {
  /** For a local branch: its `<remote>/<name>` sits on the same commit. */
  synced: boolean;
}

export function foldRemotes(refs: readonly CommitRef[], remotes: readonly string[]): RefPill[] {
  const locals = new Set(refs.filter((r) => r.kind === 'local').map((r) => r.name));
  const mirrored = new Set<string>();
  for (const r of refs) {
    if (r.kind === 'remote') {
      for (const remote of remotes) {
        const prefix = `${remote}/`;
        if (r.name.startsWith(prefix) && locals.has(r.name.slice(prefix.length))) {
          mirrored.add(r.name);
        }
      }
    }
  }
  return refs
    .filter((r) => !mirrored.has(r.name))
    .map((r) => ({
      ...r,
      synced:
        r.kind === 'local' &&
        remotes.some((remote) =>
          refs.some((x) => x.kind === 'remote' && x.name === `${remote}/${r.name}`),
        ),
    }));
}

/** Worktrees standing on a commit, by head sha — the folder pills. */
export function checkoutsAt(checkouts: readonly GitCheckout[]): Map<string, GitCheckout[]> {
  const map = new Map<string, GitCheckout[]>();
  for (const c of checkouts) {
    if (c.head === '') {
      continue;
    }
    const list = map.get(c.head);
    if (list) {
      list.push(c);
    } else {
      map.set(c.head, [c]);
    }
  }
  return map;
}
