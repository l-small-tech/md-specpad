/**
 * comments.ts — the pure data layer for voice notes (invariant: no I/O here).
 *
 * A voice note is a short dictated note about one line of a markdown file. The
 * note never touches the file it comments on: the parent `.md` stays byte-for-
 * byte unchanged (no markers, no checksum churn, nothing for a sync client to
 * merge). Everything lives in a sibling human-readable file, `<name>.comments.md`,
 * whose entries each carry an obvious reference back to the parent — its file
 * name, the 1-based line the note is about, a quote of that line's text as it
 * read at capture time, and a UTC timestamp. The quote is what keeps a note
 * findable after the parent is edited and the line number drifts.
 *
 * The intended reader of that file is as often an AI agent as a person — the
 * author reviews a document on a phone, dictates notes, then hands the sidecar
 * to an agent to act on — so the format is plain, regular markdown with every
 * field spelled out.
 *
 * This module owns the pure concerns the rest of the feature composes: locating
 * the comments file, parsing/serializing it, and minting collision-free ids.
 * Everything here is synchronous and side-effect-free so it is exhaustively
 * unit-testable; the storage-provider round-trip and the UI live elsewhere.
 *
 * File format (v2):
 *
 *     <!-- md-specpad voice comments v2 -->
 *     <!-- …disclaimer: how the file was made (VOICE_NOTES_DISCLAIMER)… -->
 *     # Voice notes for [meeting-notes.md](../meeting-notes.md)
 *     - branch: feat/explorer-filters (worktree: worktrees/explorer-filters)
 *     - compared against: development (merge-base 3c77f30)
 *
 *     ## ^c3f9a
 *     - file: ../meeting-notes.md
 *     - line: 42
 *     - time: 2026-09-10T21:32:07.000Z
 *     - unit: showAllFilesState (function)
 *
 *     > The original line's text, quoted at capture time
 *
 *     Ship the pricing change before the demo.
 *
 * `file:` (and the title link) is the parent's path RELATIVE TO THE SIDECAR, so
 * it is both an obvious reference and a link that resolves — `meeting-notes.md`
 * when the sidecar sits beside the document, `../meeting-notes.md` (or deeper)
 * from a shared workspace "Voice Notes" folder. Where the sidecar lives is a
 * setting; `commentsPathFor` resolves it.
 *
 * The two preamble `- …` lines are OPTIONAL review context (which branch the
 * review happened on, and what it was compared against — see `ReviewContext`);
 * the parser ignores everything before the first `## ^id`, so they cost a
 * reader of an older build nothing. `- unit:` is likewise optional: it names
 * the declaration a note on a CODE file is about, and survives line drift.
 *
 * v1 files (which had no file/line/quote fields — the parent carried an
 * invisible `<!-- ^cXXXX -->` anchor instead) still parse; the missing fields
 * come back empty. Nothing writes v1 any more.
 */

import { baseName, dirName, extName, joinPath, relativePath } from './session/plan-flush';
import type { VoiceNotesLocation } from './types';

/** A single voice note as stored in `<name>.comments.md`. */
export interface VoiceComment {
  /** Entry id (without the `^`), e.g. `c3f9a`. Unique within the file. */
  id: string;
  /** Name of the file the note is about (no directory), e.g. `meeting-notes.md`. */
  file: string;
  /** 1-based line the note is about; null for a legacy (v1) entry. */
  line: number | null;
  /** The text of that line at capture time (single line, trimmed); '' if unknown. */
  quote: string;
  /** ISO-8601 UTC capture time (`new Date().toISOString()`). */
  time: string;
  /** The dictated (or hand-edited) text. */
  transcript: string;
  /**
   * The declaration the note is about, for a code file reviewed in Review mode
   * — `showAllFilesState (function)`. Absent for a markdown note (and for
   * every note written before Review mode existed). It outlives line drift, so
   * an agent finds the target even after the file is edited.
   */
  unit?: string;
}

/**
 * Where a review happened, recorded in the sidecar's preamble so a file handed
 * to an agent says which branch and baseline the notes were taken against.
 * Every field is optional; nothing is written when the context is empty.
 */
export interface ReviewContext {
  /** The checked-out branch, e.g. `feat/explorer-filters`. */
  branch?: string;
  /** The worktree the branch is checked out in, e.g. `worktrees/explorer-filters`. */
  worktree?: string;
  /** The branch the review compared against, e.g. `development`. */
  baseBranch?: string;
  /** The exact baseline commit (short sha), e.g. `3c77f30`. */
  baseRef?: string;
}

/** First line of every comments file — a version stamp and a human hint. */
const HEADER_V2 = '<!-- md-specpad voice comments v2 -->';

/**
 * Written right under the version stamp of every comments file: how the notes
 * were made, and a caution for the AI agent that is often the file's reader.
 * An HTML comment, so it is invisible when the file is rendered. It sits in
 * the preamble before the first `## ^id` entry, which the parser ignores, so
 * it is rewritten fresh on every save (older files gain it on their next save).
 */
export const VOICE_NOTES_DISCLAIMER = [
  '<!--',
  '  How this file was made: each note below was spoken aloud while reviewing',
  '  the linked document and turned into text by automatic speech recognition',
  '  (on-device recognition on Android; Windows voice typing or an offline',
  '  Whisper model on desktop). The reviewer may have corrected some',
  '  transcripts by hand afterwards.',
  '',
  '  For AI agents acting on these notes: a voice transcript can contain subtle',
  '  errors, such as misheard or substituted words, homophones, dropped words',
  "  and missing punctuation. Read each note for the reviewer's intent rather",
  '  than its exact wording, use the quoted line to find what it refers to,',
  '  and ask before acting on a note whose meaning is unclear.',
  '-->',
].join('\n');
// md-notepad: the stamp written before the app was renamed to MD Specpad.
const HEADER_VERSION_RE = /^<!--\s*md-(?:specpad|notepad) voice comments v(\d+)\s*-->\s*$/;

/** Where a document's sidecar goes — the user's setting plus the workspace it's in. */
export interface CommentsPathOptions {
  location: VoiceNotesLocation;
  /** The shared folder's name (already sanitized), for 'workspaceFolder'. */
  folderName: string;
  /** Root of the workspace the document belongs to (its own directory if none). */
  workspaceRoot: string;
}

/**
 * The comments-file path for a note: `foo.md` → `foo.comments.md` (a
 * `.markdown` note also collapses to `.comments.md`), always in the same
 * provider namespace (a `saf://…` note yields a `saf://…` path).
 *
 * With no options, or 'nextToFile', the sidecar sits beside the note. With
 * 'workspaceFolder' it goes under `<workspaceRoot>/<folderName>/`, mirroring
 * the note's sub-path within the workspace (`ws/docs/a/foo.md` →
 * `ws/Voice Notes/docs/a/foo.comments.md`) so same-named notes in different
 * folders never share a sidecar. A note that isn't under the given root (or on
 * another drive) lands directly in the folder.
 */
export function commentsPathFor(notePath: string, opts?: CommentsPathOptions): string {
  const ext = extName(notePath); // '.md' | '.markdown' | ''
  const base = baseName(notePath);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const file = `${stem}.comments.md`;
  const noteDir = dirName(notePath);
  if (!opts || opts.location === 'nextToFile') {
    return noteDir ? joinPath(noteDir, file) : file;
  }
  const folder = joinPath(opts.workspaceRoot, opts.folderName);
  const rel = noteDir ? relativePath(opts.workspaceRoot, noteDir) : null;
  // '.' = the root itself; './sub/dir' = inside it; '../…' or null = outside.
  const inside = rel !== null && rel.startsWith('./') ? rel.slice(2) : '';
  return inside ? joinPath(joinPath(folder, inside), file) : joinPath(folder, file);
}

/**
 * How a sidecar refers to its parent: the parent's path relative to the
 * sidecar's directory, forward-slashed, without a leading `./` — `foo.md` for a
 * sibling, `../docs/foo.md` from a shared folder. Falls back to the bare file
 * name when no relative path exists (different roots).
 */
export function noteRefFor(commentsPath: string, notePath: string): string {
  const rel = relativePath(dirName(commentsPath), notePath);
  if (rel === null || rel === '.') {
    return baseName(notePath);
  }
  return rel.startsWith('./') ? rel.slice(2) : rel;
}

/** True for a comments-file name/path (`*.comments.md`), used to hide them. */
export function isCommentsPath(path: string): boolean {
  return baseName(path).toLowerCase().endsWith('.comments.md');
}

/**
 * The inverse of `noteRefFor`: the absolute path of the document a sidecar is
 * about, from the sidecar's own path and an entry's `file:` reference (which
 * is relative to the sidecar's directory). `..` segments climb; the
 * separator style of the sidecar's path is kept, so a `saf://` sidecar yields
 * a `saf://` document. With an empty reference the document is assumed to be
 * the sidecar's namesake beside it (`foo.comments.md` → `foo.md`).
 */
export function notePathFromSidecar(sidecarPath: string, ref: string): string {
  const dir = dirName(sidecarPath);
  if (!ref) {
    const stem = baseName(sidecarPath).replace(/\.comments\.md$/i, '');
    return dir ? joinPath(dir, `${stem}.md`) : `${stem}.md`;
  }
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const parts = dir.split(/[\\/]/);
  for (const seg of ref.split(/[\\/]/)) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (parts.length > 1) {
        parts.pop();
      }
      continue;
    }
    parts.push(seg);
  }
  return parts.join(sep);
}

const CONTEXT_BRANCH_RE = /^-\s+branch:\s*(.+?)(?:\s+\(worktree:\s*(.+?)\))?\s*$/;
const CONTEXT_BASE_RE = /^-\s+compared against:\s*(.+?)(?:\s+\(merge-base\s+(\S+?)\))?\s*$/;

/**
 * The review context a sidecar's preamble carries (the lines `contextLines`
 * writes), so an edit made away from the review — from the notes overview,
 * or a marker's callout — keeps the branch and baseline on the file. Only the
 * preamble (before the first `## ^id`) is read; undefined when it has none.
 */
export function parseReviewContext(text: string): ReviewContext | undefined {
  const context: ReviewContext = {};
  let found = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (ENTRY_RE.test(line)) {
      break;
    }
    const branch = CONTEXT_BRANCH_RE.exec(line);
    if (branch) {
      context.branch = branch[1];
      if (branch[2]) {
        context.worktree = branch[2];
      }
      found = true;
      continue;
    }
    const base = CONTEXT_BASE_RE.exec(line);
    if (base) {
      context.baseBranch = base[1];
      if (base[2]) {
        context.baseRef = base[2];
      }
      found = true;
    }
  }
  return found ? context : undefined;
}

/**
 * Mint an id that collides with none of `existingIds`. `c` + 4 base36 chars
 * gives ~1.7M values; the retry loop makes uniqueness deterministic regardless.
 */
export function newCommentId(existingIds: Set<string>): string {
  for (;;) {
    const id = 'c' + Math.random().toString(36).slice(2, 6).padStart(4, '0');
    if (!existingIds.has(id)) {
      return id;
    }
  }
}

/**
 * The 1-based line's text from a document, trimmed to one line — the quote
 * stored beside a note. '' when the line is out of range.
 */
export function lineQuote(docText: string, line: number): string {
  const lines = docText.split('\n');
  const raw = lines[line - 1];
  return raw === undefined ? '' : raw.replace(/\r$/, '').trim();
}

const ENTRY_RE = /^##\s+\^(c[0-9a-z]+)\s*$/;
// Any `- key: value` line inside the leading meta run is metadata: the four
// keys below are read, and ANYTHING ELSE is dropped. That is what lets a newer
// build add a field (as `unit` was added) without an older build reading it as
// the note's text — and it is why the legacy `- audio:` line of the retired
// desktop recorder disappears rather than being surfaced or rewritten.
const META_RE = /^-\s+([A-Za-z][\w-]*):\s*(.*)$/;

/**
 * Parse a `<name>.comments.md` file into notes, in file order. Tolerant of a
 * missing header and of hand-edits: each `## ^id` heading starts an entry; the
 * leading run of `- key:` lines is metadata. In a v2 file a blockquote run right
 * after the metadata is the line quote. Everything after that (trimmed) is the
 * transcript verbatim — so dashes or lists inside a transcript are preserved.
 * Unknown/garbage lines before the first entry (including the title) are ignored.
 */
export function parseCommentsFile(text: string): VoiceComment[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const first = lines[0] ?? '';
  const versionMatch = HEADER_VERSION_RE.exec(first);
  const version = versionMatch ? Number(versionMatch[1]) : 1;

  const out: VoiceComment[] = [];
  interface Cur {
    id: string;
    file: string;
    line: number | null;
    time: string;
    unit: string;
    body: string[];
  }
  let cur: Cur | null = null;
  // 'meta' → the leading `- key:` run; 'quote' → an optional `>` run (v2 only);
  // 'body' → everything else.
  let section: 'meta' | 'quote' | 'body' = 'body';
  let quoteLines: string[] = [];

  const flush = () => {
    if (cur) {
      const comment: VoiceComment = {
        id: cur.id,
        file: cur.file,
        line: cur.line,
        quote: quoteLines.join(' ').trim(),
        time: cur.time,
        transcript: cur.body.join('\n').trim(),
      };
      // Only present when the file carried one, so a markdown note round-trips
      // to exactly the object it came from.
      if (cur.unit) {
        comment.unit = cur.unit;
      }
      out.push(comment);
    }
    quoteLines = [];
  };

  for (const line of lines) {
    const head = ENTRY_RE.exec(line);
    if (head) {
      flush();
      cur = { id: head[1]!, file: '', line: null, time: '', unit: '', body: [] };
      section = 'meta';
      continue;
    }
    if (!cur) {
      continue; // preamble before the first entry
    }
    if (section === 'meta') {
      const meta = META_RE.exec(line);
      if (meta) {
        const v = meta[2]!.trim();
        switch (meta[1]) {
          case 'file':
            cur.file = v;
            break;
          case 'line': {
            const n = Number.parseInt(v, 10);
            cur.line = Number.isFinite(n) && n > 0 ? n : null;
            break;
          }
          case 'time':
            cur.time = v;
            break;
          case 'unit':
            cur.unit = v;
            break;
          // Anything else (legacy 'audio', a field from a newer build) is
          // consumed so it is never read as the transcript, and dropped.
        }
        continue;
      }
      // The blank separator (or the first non-meta line) ends the meta run.
      section = version >= 2 ? 'quote' : 'body';
      if (line.trim() === '') {
        continue;
      }
    }
    if (section === 'quote') {
      if (/^>/.test(line)) {
        quoteLines.push(line.replace(/^>\s?/, ''));
        continue;
      }
      section = 'body';
      if (line.trim() === '' && quoteLines.length > 0) {
        continue; // the blank line between the quote and the transcript
      }
      if (line.trim() === '' && cur.body.length === 0) {
        continue; // stray blank before the body
      }
    }
    cur.body.push(line);
  }
  flush();
  return out;
}

/**
 * Serialize notes to the canonical v2 `<name>.comments.md` text. `noteRef` is
 * the parent's path relative to the sidecar (see `noteRefFor`) — it titles the
 * file and fills in the `file:` field of any legacy entry that has none.
 */
export function serializeCommentsFile(
  comments: VoiceComment[],
  noteRef: string,
  context?: ReviewContext,
): string {
  const blocks = comments.map((c) => {
    const file = c.file || noteRef;
    const meta = [`- file: ${file}`];
    if (c.line !== null) {
      meta.push(`- line: ${c.line}`);
    }
    meta.push(`- time: ${c.time}`);
    if (c.unit) {
      meta.push(`- unit: ${c.unit}`);
    }
    const quote = c.quote.trim();
    const quoteBlock = quote ? `> ${quote}\n\n` : '';
    const body = c.transcript.trim();
    return `## ^${c.id}\n${meta.join('\n')}\n\n${quoteBlock}${body}\n`;
  });
  const title = `# Voice notes for [${baseName(noteRef)}](${encodeURI(noteRef)})`;
  const head = [title, ...contextLines(context)].join('\n');
  return `${HEADER_V2}\n${VOICE_NOTES_DISCLAIMER}\n${head}\n\n${blocks.join('\n')}`;
}

/**
 * The review-context lines that follow the title:
 *
 *     - branch: feat/explorer-filters (worktree: worktrees/explorer-filters)
 *     - compared against: development (merge-base 3c77f30)
 *
 * They sit in the preamble, which `parseCommentsFile` ignores, so they are
 * rewritten fresh on every save and an older build reading them sees only
 * markdown. A worktree without a branch (or a baseRef without a base branch)
 * writes nothing — the line only exists to be read by a person or an agent.
 */
function contextLines(context?: ReviewContext): string[] {
  if (!context) {
    return [];
  }
  const lines: string[] = [];
  if (context.branch) {
    const where = context.worktree ? ` (worktree: ${context.worktree})` : '';
    lines.push(`- branch: ${context.branch}${where}`);
  }
  if (context.baseBranch) {
    const at = context.baseRef ? ` (merge-base ${context.baseRef})` : '';
    lines.push(`- compared against: ${context.baseBranch}${at}`);
  }
  return lines;
}
