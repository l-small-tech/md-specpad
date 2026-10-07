/**
 * Remotes — the rules behind "connect this workspace to GitHub / Gitea":
 * reading a pasted address (`parseRemoteUrl`), naming the remote
 * (`validateRemoteName`, `suggestRemoteName`), which remote Publish uses
 * (`publishRemote`), and what to do once the remote is fetched
 * (`connectPlan`). Pure; no DOM, no Tauri, no React.
 *
 * The audience is someone who just clicked "New repository" on a website and
 * copied whatever address it showed them — possibly the page's own URL
 * (`…/tree/main`, `…/src/branch/main`) rather than the clone address. The
 * parser forgives that and says plainly when it cannot.
 */

import type { GitRefRelation, GitRemote } from './types';

export interface ParsedRemoteUrl {
  /** What git is given. */
  url: string;
  /** `GitHub`, `GitLab`, `Codeberg`, `Bitbucket`, or the host name; null for a local path. */
  provider: string | null;
  /** `owner/name` when the address has that shape. */
  repo: string | null;
}

const PROVIDERS: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'codeberg.org': 'Codeberg',
  'bitbucket.org': 'Bitbucket',
  'gitea.com': 'Gitea',
};

/** Web-page path segments that mark where the repository path ends. */
const PAGE_MARKERS = new Set(['tree', 'blob', 'src', 'commits', 'issues', 'pulls', 'wiki', '-']);

function providerOf(host: string): string {
  return PROVIDERS[host.toLowerCase()] ?? host;
}

function repoOf(segments: readonly string[]): string | null {
  if (segments.length < 2) {
    return null;
  }
  const name = segments[segments.length - 1]!.replace(/\.git$/i, '');
  return `${segments[segments.length - 2]}/${name}`;
}

/**
 * Read a pasted repository address. Accepts `https://` (the page URL too —
 * `/tree/…`, `/src/branch/…`, a trailing slash, `?tab=…` are dropped),
 * `git@host:owner/name.git`, `ssh://`, `git://`, `file://` and a local path.
 * Returns the URL git should get, or `{ error }` in plain words.
 */
export function parseRemoteUrl(input: string): ParsedRemoteUrl | { error: string } {
  const text = input.trim();
  if (text === '') {
    return { error: 'Paste the address of your repository.' };
  }
  if (/\s/.test(text) || text.startsWith('-')) {
    return { error: 'That does not look like a repository address.' };
  }

  // scp-like SSH: git@github.com:owner/name.git
  const scp = /^([\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(text);
  if (scp && !/^[A-Za-z]$/.test(scp[2]!)) {
    const segments = scp[3]!.split('/').filter((s) => s !== '');
    return { url: text, provider: providerOf(scp[2]!), repo: repoOf(segments) };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      return { error: 'That address is not quite right — copy it again from the website.' };
    }
    const scheme = u.protocol.replace(/:$/, '').toLowerCase();
    if (scheme === 'file') {
      return { url: text, provider: null, repo: null };
    }
    if (!['http', 'https', 'ssh', 'git'].includes(scheme)) {
      return { error: `Git cannot use ${scheme}:// addresses — use the https:// one.` };
    }
    const raw = u.pathname.split('/').filter((s) => s !== '');
    if (scheme === 'http' || scheme === 'https') {
      const cut = raw.findIndex((s, i) => i >= 2 && PAGE_MARKERS.has(s));
      const segments = cut === -1 ? raw : raw.slice(0, cut);
      if (segments.length < 2) {
        return {
          error:
            segments.length === 0
              ? 'That is the website, not a repository — open your repository and copy its address.'
              : 'That looks like a profile, not a repository — open the repository and copy its address.',
        };
      }
      const known = PROVIDERS[u.host.toLowerCase()] !== undefined;
      // On the big hosts a repository is exactly owner/name; elsewhere (a
      // Gitea or GitLab with groups) keep every segment we were given.
      const keep = known && u.host.toLowerCase() !== 'gitlab.com' ? segments.slice(0, 2) : segments;
      const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : '';
      const url = `${u.protocol}//${auth}${u.host}/${keep.join('/')}`;
      return { url, provider: providerOf(u.hostname), repo: repoOf(keep) };
    }
    return { url: text, provider: providerOf(u.hostname), repo: repoOf(raw) };
  }

  // A local folder (a bare repository on a drive or a share) — fine for git.
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|~\/|\.\.?[\\/])/.test(text)) {
    return { url: text, provider: null, repo: null };
  }
  return {
    error:
      'That does not look like a repository address — it usually starts with https:// or git@.',
  };
}

/** Why `name` cannot name a new remote, or null when it can. */
export function validateRemoteName(name: string, existing: readonly GitRemote[]): string | null {
  if (name === '') {
    return 'Give the connection a short name, like origin.';
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..') || name.endsWith('.lock')) {
    return 'Use letters, numbers, dots and dashes only.';
  }
  if (existing.some((r) => r.name === name)) {
    return `There is already a connection called ${name}.`;
  }
  return null;
}

/**
 * A name for a new remote: `origin` (what every tutorial and tool expects)
 * when free, else the provider's name in lower case, else `remote-2`, `-3`, ….
 */
export function suggestRemoteName(
  existing: readonly GitRemote[],
  provider: string | null = null,
): string {
  const taken = new Set(existing.map((r) => r.name));
  if (!taken.has('origin')) {
    return 'origin';
  }
  const slug = (provider ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug !== '' && !taken.has(slug)) {
    return slug;
  }
  for (let i = 2; ; i += 1) {
    if (!taken.has(`remote-${i}`)) {
      return `remote-${i}`;
    }
  }
}

/** The remote Publish pushes to: `origin` when there is one, else the first; null with none. */
export function publishRemote(remotes: readonly GitRemote[]): string | null {
  return remotes.find((r) => r.name === 'origin')?.name ?? remotes[0]?.name ?? null;
}

/** The remote-tracking branch names (`origin/x` → `x`) of `remote`, `HEAD` excluded. */
export function remoteBranchNames(
  branches: readonly { name: string; kind: 'local' | 'remote' }[],
  remote: string,
): string[] {
  const prefix = `${remote}/`;
  return branches
    .filter((b) => b.kind === 'remote' && b.name.startsWith(prefix))
    .map((b) => b.name.slice(prefix.length))
    .filter((n) => n !== 'HEAD');
}

/**
 * What the connect flow does after fetching the new remote:
 * - `publish` — upload the branch (`push -u`): the server is empty, has no
 *   branch of this name, or holds nothing we lack.
 * - `bring-in` — the server already has commits on this branch (usually a
 *   README or licence made with the repository): merge them in first
 *   (`allowUnrelated` when the histories share no commit), then publish.
 * - `first-commit` — nothing to upload yet and nothing to bring in.
 */
export type ConnectPlan =
  { kind: 'publish' } | { kind: 'bring-in'; allowUnrelated: boolean } | { kind: 'first-commit' };

export function connectPlan(relation: GitRefRelation, unborn: boolean): ConnectPlan {
  if (unborn && relation === 'missing') {
    return { kind: 'first-commit' };
  }
  switch (relation) {
    case 'behind':
    case 'diverged':
    case 'unborn':
      return { kind: 'bring-in', allowUnrelated: false };
    case 'unrelated':
      return { kind: 'bring-in', allowUnrelated: true };
    case 'missing':
    case 'same':
    case 'ahead':
      return { kind: 'publish' };
  }
}
