/**
 * The git tab's glyphs: 16×16, stroke 1.3, `currentColor` — the tab strip's
 * icon language, inline so there is no icon library to ship.
 */

import type { ReactNode } from 'react';

export type IconName =
  | 'chevron-down'
  | 'chevron-right'
  | 'refresh'
  | 'plus'
  | 'minus'
  | 'undo'
  | 'trash'
  | 'file'
  | 'folder'
  | 'terminal'
  | 'sparkle'
  | 'diff'
  | 'merge-in'
  | 'merge-out'
  | 'flag'
  | 'close'
  | 'check'
  | 'copy'
  | 'branch'
  | 'cloud-down'
  | 'cloud-up'
  | 'download'
  | 'upload'
  | 'dot'
  | 'tag'
  | 'home'
  | 'history'
  | 'chevron-up'
  | 'cloud'
  | 'arrow-up'
  | 'arrow-down'
  | 'more';

const PATHS: Record<IconName, ReactNode> = {
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  'chevron-right': <path d="M6 4l4 4-4 4" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5V5h-2.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  undo: (
    <>
      <path d="M4 6.5h6a3 3 0 0 1 0 6H6" />
      <path d="M6.5 4L4 6.5 6.5 9" />
    </>
  ),
  trash: (
    <>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
    </>
  ),
  file: (
    <>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </>
  ),
  folder: (
    <>
      <path d="M2.5 12.5V3.5h4l1.5 1.8h5.5v7.2z" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M4.5 6l2.5 2-2.5 2M9 10.5h2.5" />
    </>
  ),
  sparkle: (
    <>
      <path d="M8 2.5l1.3 3.7L13 7.5l-3.7 1.3L8 12.5 6.7 8.8 3 7.5l3.7-1.3z" />
    </>
  ),
  diff: (
    <>
      <path d="M2.5 3.5h5v9h-5zM8.5 3.5h5v9h-5z" />
      <path d="M4 6.5h2M5 5.5v2M10 9.5h2" />
    </>
  ),
  'merge-in': (
    <>
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="12" cy="4" r="1.5" />
      <path d="M12 5.5c0 3.5-3 5-6.5 5" />
      <path d="M7.5 8.5l-2 2 2 2" />
    </>
  ),
  'merge-out': (
    <>
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M4 5.5c0 3.5 3 5 6.5 5" />
      <path d="M8.5 8.5l2 2-2 2" />
    </>
  ),
  flag: (
    <>
      <path d="M4 13.5V2.5" />
      <path d="M4 3h8l-2 3 2 3H4" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M3 10.5V3.5a1 1 0 0 1 1-1h7" />
    </>
  ),
  branch: (
    <>
      <circle cx="5" cy="3.5" r="1.6" />
      <circle cx="5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="5.5" r="1.6" />
      <path d="M5 5.1v5.8M11.5 7.1c0 2.4-2.5 3-4.6 3.4" />
    </>
  ),
  'cloud-down': (
    <>
      <path d="M4.5 11.5A3 3 0 0 1 4.8 5.6 4 4 0 0 1 12.4 6.9 2.3 2.3 0 0 1 12 11.5" />
      <path d="M8 7.5v6m0 0l-2-2m2 2l2-2" />
    </>
  ),
  'cloud-up': (
    <>
      <path d="M4.5 11.5A3 3 0 0 1 4.8 5.6 4 4 0 0 1 12.4 6.9 2.3 2.3 0 0 1 12 11.5" />
      <path d="M8 13.5v-6m0 0L6 9.5m2-2l2 2" />
    </>
  ),
  download: <path d="M8 2.5v8m0 0L5 7.5m3 3l3-3M3 13.5h10" />,
  upload: <path d="M8 10.5v-8m0 0L5 5.5m3-3l3 3M3 13.5h10" />,
  dot: <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />,
  tag: (
    <>
      <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
      <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  home: (
    <>
      <path d="M2.5 8l5.5-5 5.5 5" />
      <path d="M4 7v6.5h8V7" />
    </>
  ),
  history: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  'chevron-up': <path d="M4 10l4-4 4 4" />,
  cloud: <path d="M5 12.5h6.5a2.5 2.5 0 0 0 .3-5 3.5 3.5 0 0 0-6.8-.8A3 3 0 0 0 5 12.5z" />,
  'arrow-up': <path d="M8 13V3m0 0L4.5 6.5M8 3l3.5 3.5" />,
  'arrow-down': <path d="M8 3v10m0 0l-3.5-3.5M8 13l3.5-3.5" />,
  more: (
    <>
      <circle cx="4" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `git-icon ${className}` : 'git-icon'}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}

/** A spinning ring, for "git is thinking". */
export function Spinner({ title }: { title?: string }) {
  return (
    <span className="git-spinner" role="status" aria-label={title ?? 'Working'} title={title} />
  );
}
