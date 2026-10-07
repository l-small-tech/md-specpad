/**
 * Small pieces every git section shares: the repo-slice selector hook, the
 * collapsible section frame, the path label with its directory dimmed, the
 * status-letter glyph and a few label helpers. Rendering only — every
 * decision is the store's or (once slice B lands) `core/git`'s.
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { baseName, dirName } from '../../../core/session/plan-flush';
import { pathKey } from '../../../core/tab-workspaces';
import { repoKey, useGitStore, type RepoState } from '../../stores/git';
import { Icon } from './icons';

/**
 * One field of a repository's state. `pick` must return something the store
 * already holds (an array, an object, a primitive) — never a fresh object —
 * so the selector's `Object.is` check stays meaningful.
 */
export function useRepoSlice<T>(root: string, pick: (repo: RepoState) => T): T | undefined {
  return useGitStore((s) => {
    const repo = s.repos[repoKey(root)];
    return repo ? pick(repo) : undefined;
  });
}

/* A minute clock for relative times, kept OUTSIDE render (React's purity
   rule): the module holds the instant, an interval advances it while any
   component listens, and components read it through useSyncExternalStore. */
let nowMs = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockTimer = setInterval(() => {
      nowMs = Date.now();
      for (const l of clockListeners) {
        l();
      }
    }, 60_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/** The current time, to the minute — for "4 min ago" labels. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => nowMs,
    () => nowMs,
  );
}

/** A checkout's label relative to the main root: `worktrees/x`, or the main folder's name. */
export function checkoutLabel(path: string, mainRoot: string): string {
  const key = pathKey(path);
  const mainKey = pathKey(mainRoot);
  if (key === mainKey) {
    return baseName(mainRoot) || mainRoot;
  }
  if (key.startsWith(`${mainKey}/`)) {
    return path.replaceAll('\\', '/').slice(mainRoot.length + 1);
  }
  return baseName(path) || path;
}

/** A checkout's own name: the worktree folder's name, or the main folder's name. */
export function checkoutName(path: string, mainRoot: string): string {
  const target = pathKey(path) === pathKey(mainRoot) ? mainRoot : path;
  return baseName(target) || target;
}

/**
 * Where a linked worktree lives, relative to the main root (`.claude/worktrees`),
 * or '' for the main checkout and for worktrees outside the repository folder.
 */
export function checkoutDir(path: string, mainRoot: string): string {
  const label = checkoutLabel(path, mainRoot);
  const name = checkoutName(path, mainRoot);
  return label.endsWith(`/${name}`) ? label.slice(0, -(name.length + 1)) : '';
}

/** `abc1234` and `↑2 ↓1` — the core formatters, under the names the components use. */
export { formatAheadBehind as aheadBehind, shortSha } from '../../../core/git/refs';

/** A collapsible group with a count and optional header actions. */
export function Section({
  title,
  count,
  actions,
  children,
  defaultOpen = true,
  className,
  tone,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  /** `danger` colours the title — the conflicts section. */
  tone?: 'danger';
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`git-section${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}>
      <div className="git-section-head">
        <button
          type="button"
          className={`git-section-toggle${tone === 'danger' ? ' is-danger' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="git-section-title">{title}</span>
          {count !== undefined && <span className="git-count">{count}</span>}
        </button>
        {actions && <div className="git-section-actions">{actions}</div>}
      </div>
      {open && <div className="git-section-body">{children}</div>}
    </section>
  );
}

/** A file path with its directory dimmed after the name — VS Code's order. */
export function PathLabel({ path, origPath }: { path: string; origPath?: string | null }) {
  const dir = dirName(path);
  return (
    <span className="git-path" title={origPath ? `${origPath} → ${path}` : path}>
      <span className="git-path-name">{baseName(path)}</span>
      {dir !== '' && <span className="git-path-dir">{dir}</span>}
      {origPath && <span className="git-path-dir">← {origPath}</span>}
    </span>
  );
}

/** The class a status letter is coloured with. */
export function statusTone(letter: string): string {
  switch (letter) {
    case 'A':
    case '?':
      return 'added';
    case 'D':
      return 'deleted';
    case 'U':
      return 'conflict';
    default:
      return 'modified';
  }
}

/** The one-letter status glyph of a row. */
export function StatusGlyph({ letter, title }: { letter: string; title?: string }) {
  return (
    <span className={`git-glyph git-tone-${statusTone(letter)}`} title={title} aria-hidden="true">
      {letter}
    </span>
  );
}

/** An icon button with a native tooltip — the row and header action shape. */
export function IconButton({
  icon,
  title,
  onClick,
  disabled,
  danger,
  className,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`git-icon-btn${danger ? ' is-danger' : ''}${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} />
    </button>
  );
}

/** The empty-list line inside a section. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="git-empty">{children}</div>;
}
