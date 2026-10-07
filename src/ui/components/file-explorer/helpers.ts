/**
 * Pure helpers shared by the FileExplorer container and its extracted pieces:
 * row indentation, the file-type badge, drawer-width clamping, paste MIME
 * vocabulary, and the timeout-guarded directory listing.
 */

import { isAudioPath } from '../../../core/audio';
import { isImagePath } from '../../../core/images';
import { isImportablePath } from '../../../core/import/registry';
import { listNoteFiles, type ExplorerEntry } from '../../session';

/** Indentation per tree depth; file rows add the caret column's width. */
export function dirIndent(depth: number): number {
  return 8 + depth * 12;
}

/**
 * The right-pinned type badge for a recognized file, or null for anything
 * else (which then keeps its full name, extension included). Recognized files
 * show their name WITHOUT the extension plus this badge: 'md' for markdown
 * (rendered in the accent color), 'marp' for a markdown file that is a Marp
 * slide deck (`deck` — content-keyed, so the caller has to know; its own
 * color), the uppercased extension for images and importable documents
 * (PDF/DOCX). Unsupported files (listed where the user shows them) are not
 * recognized: they keep their full name, no badge.
 */
export function fileBadge(
  name: string,
  deck = false,
): { label: string; kind: 'md' | 'deck' | 'image' | 'audio' | 'doc' } | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const ext = name.slice(dot).toLowerCase();
  if (ext === '.md' || ext === '.markdown') {
    return deck ? { label: 'marp', kind: 'deck' } : { label: 'md', kind: 'md' };
  }
  if (ext === '.txt') {
    return { label: 'txt', kind: 'md' };
  }
  if (isImportablePath(name)) {
    return { label: name.slice(dot + 1), kind: 'doc' };
  }
  if (isImagePath(name)) {
    return { label: name.slice(dot + 1), kind: 'image' };
  }
  if (isAudioPath(name)) {
    return { label: name.slice(dot + 1), kind: 'audio' };
  }
  return null;
}

/**
 * The tree is "open" when anything at all is showing: a workspace that isn't
 * collapsed, or an expanded subfolder. Drives the header's one collapse/expand
 * button — open means the next press collapses, shut means it expands.
 */
export function isTreeOpen(
  workspacePaths: readonly string[],
  collapsedWorkspaces: ReadonlySet<string>,
  expandedDirs: ReadonlySet<string>,
): boolean {
  return expandedDirs.size > 0 || workspacePaths.some((p) => !collapsedWorkspaces.has(p));
}

/**
 * Next (collapsedWorkspaces, expandedDirs) for the collapse/expand-all button.
 * Collapsing shuts every workspace AND forgets every expanded subfolder, so a
 * re-expand starts at the roots rather than restoring the old tree — which also
 * stops the listing effect from re-fetching subfolders nobody can see.
 * Expanding only opens the workspace roots: subfolders are listed lazily (one
 * `list_dir` per level), so "expand everything" would fan out an unbounded
 * number of calls over a deep tree.
 */
export function toggleTreeAll(
  workspacePaths: readonly string[],
  open: boolean,
): { collapsedWorkspaces: ReadonlySet<string>; expandedDirs: ReadonlySet<string> } {
  return {
    collapsedWorkspaces: open ? new Set(workspacePaths) : new Set(),
    expandedDirs: new Set(),
  };
}

/** Pointer travel (px, Manhattan) before a press on a file row becomes a drag. */
export const DRAG_THRESHOLD_PX = 5;

/**
 * Resolve the element under the pointer to the directory a drop there lands in:
 * the nearest ancestor carrying `data-drop-dir`. Folder rows advertise
 * themselves, file rows advertise their CONTAINING dir, and the whole
 * `.workspace-section` advertises the workspace root — so every point in the
 * drawer that can take a file resolves to something, and a read-only workspace
 * (which renders no attribute anywhere) resolves to null and refuses drops.
 *
 * Deliberately blind to which workspace the DRAGGED file came from: moving a
 * file into another workspace is the same operation as moving it into a
 * sibling folder, and `moveExplorerEntryInto` handles both.
 *
 * Used by the internal pointer drag (`useFileDrag`); `main.tsx` hit-tests the
 * same attributes for OS drags — keep the two in step.
 */
export function dropDirAt(el: Element | null | undefined): string | null {
  return el?.closest('[data-drop-dir]')?.getAttribute('data-drop-dir') ?? null;
}

/**
 * The same lookup for `data-drop-file`: the md rows that take an IMAGE drop and
 * embed it at the end of that file instead of moving anything.
 */
export function dropFileAt(el: Element | null | undefined): string | null {
  return el?.closest('[data-drop-file]')?.getAttribute('data-drop-file') ?? null;
}

export const MIN_EXPLORER_WIDTH = 160;
export const MAX_EXPLORER_WIDTH = 480;

export function clampExplorerWidth(px: number): number {
  return Math.min(MAX_EXPLORER_WIDTH, Math.max(MIN_EXPLORER_WIDTH, px));
}

export const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

/**
 * A directory listing that outruns this is treated as failed, so a cloud folder
 * (Google Drive / OneDrive) whose backend never responds surfaces a Retry
 * affordance instead of sitting on "Loading…" forever. Generous, because a cold
 * synced-folder fetch is legitimately slow.
 */
const LISTING_TIMEOUT_MS = 20_000;

/** `listNoteFiles`, but rejects if the backend hasn't answered in time. */
export function listWithTimeout(dir: string): Promise<ExplorerEntry[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listing timed out')), LISTING_TIMEOUT_MS);
    listNoteFiles(dir).then(
      (list) => {
        clearTimeout(timer);
        resolve(list);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
