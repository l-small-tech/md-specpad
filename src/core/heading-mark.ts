/**
 * Heading marks — a hand-set status on an ATX heading (pure; tested).
 *
 * Right-clicking a heading in Raw, Split or Edit mode offers Mark running /
 * Mark complete / Clear mark. The mark is stored IN the heading text as a
 * trailing glyph (`## Build the parser ⏳`, `## Build the parser ✅`), so it
 * is saved with the file, survives an Edit-mode round-trip, shows in the
 * preview and is visible to anyone (or any agent) reading the markdown. The
 * editors only add a tint on top (`.heading-mark-*` in app.css).
 *
 * Only ATX headings (`#` … `######`) carry marks; a closing `#` run stays
 * after the glyph (`## Title ✅ ##`). The editors decide whether a line is a
 * heading at all (CM6's syntax tree, ProseMirror's node type), so a `#` line
 * inside a fenced code block is never offered the menu.
 */

export const HEADING_MARKS = ['running', 'complete'] as const;
export type HeadingMark = (typeof HEADING_MARKS)[number];

export const HEADING_MARK_GLYPHS: Record<HeadingMark, string> = {
  running: '⏳',
  complete: '✅',
};

export const HEADING_MARK_LABELS: Record<HeadingMark, string> = {
  running: 'Running',
  complete: 'Complete',
};

/** indent, hashes, gap, content (lazy), closing run + trailing blanks. */
const ATX = /^( {0,3})(#{1,6})(?:([ \t]+)(.*?))?((?:[ \t]+#+)?[ \t]*)$/;
/** A mark at the end of heading content; tolerates the emoji presentation selector. */
const TRAILING_MARK = /(^|[ \t]+)(⏳|✅)️?$/u;

/** The mark at the end of a heading's TEXT (no `#`s), or null. */
export function markOfText(text: string): HeadingMark | null {
  const m = TRAILING_MARK.exec(text.trimEnd());
  if (!m) {
    return null;
  }
  return m[2] === HEADING_MARK_GLYPHS.complete ? 'complete' : 'running';
}

/** Heading text with its trailing mark (and the blank before it) removed. */
export function stripMark(text: string): string {
  return text.trimEnd().replace(TRAILING_MARK, '');
}

/** Heading text carrying exactly `mark` (null = none) at its end. */
export function withMarkText(text: string, mark: HeadingMark | null): string {
  const bare = stripMark(text);
  if (mark === null) {
    return bare;
  }
  const glyph = HEADING_MARK_GLYPHS[mark];
  return bare === '' ? glyph : `${bare} ${glyph}`;
}

/** An ATX heading line's level and current mark, or null when it is not one. */
export function parseHeadingLine(line: string): { level: number; mark: HeadingMark | null } | null {
  const m = ATX.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
  if (!m) {
    return null;
  }
  return { level: m[2]!.length, mark: markOfText(m[4] ?? '') };
}

/** The line with its mark set to `mark` (null clears it); null when not an ATX heading. */
export function setHeadingLineMark(line: string, mark: HeadingMark | null): string | null {
  const cr = line.endsWith('\r') ? '\r' : '';
  const m = ATX.exec(cr ? line.slice(0, -1) : line);
  if (!m) {
    return null;
  }
  const [, indent, hashes, gap, content = '', tail] = m;
  const next = withMarkText(content, mark);
  const space = next === '' ? (gap ?? '') : (gap ?? ' ');
  return `${indent}${hashes}${space}${next}${tail}${cr}`;
}

/** A heading in document order: its level (1–6) and its own mark. */
export interface SectionHeading {
  level: number;
  mark: HeadingMark | null;
}

/**
 * The mark each heading's section shows, in document order: its own mark,
 * else the innermost enclosing marked heading's. A section runs from its
 * heading to the next heading of the same or a higher level, so everything
 * under `## Build ⏳` — text and `###` sub-headings alike — reads as running,
 * until a sub-heading carries a mark of its own.
 */
export function sectionMarks(headings: readonly SectionHeading[]): (HeadingMark | null)[] {
  const open: SectionHeading[] = [];
  return headings.map(({ level, mark }) => {
    while (open.length > 0 && open[open.length - 1]!.level >= level) {
      open.pop();
    }
    const shown = mark ?? open[open.length - 1]?.mark ?? null;
    open.push({ level, mark: shown });
    return shown;
  });
}
