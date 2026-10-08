/**
 * Heading marks — a hand-set status on an ATX heading (pure; tested).
 *
 * Right-clicking a heading in Raw, Split or Edit mode offers a Mark heading
 * submenu: Running / Focus / Backburner / Complete / Clear mark. Focus is
 * held by at most one heading per file: setting it clears it everywhere else
 * (`UNIQUE_MARK`). The mark is stored IN the heading text as a trailing
 * glyph (`## Build the parser ⏳`, `… 🎯`, `… 💤`, `… ✅`), so it is saved
 * with the file, survives an Edit-mode round-trip, shows in the
 * preview and is visible to anyone (or any agent) reading the markdown. The
 * editors only add a tint on top (`.heading-mark-*` in app.css).
 *
 * Only ATX headings (`#` … `######`) carry marks; a closing `#` run stays
 * after the glyph (`## Title ✅ ##`). The editors decide whether a line is a
 * heading at all (CM6's syntax tree, ProseMirror's node type), so a `#` line
 * inside a fenced code block is never offered the menu.
 */

export const HEADING_MARKS = ['running', 'focus', 'backburner', 'complete'] as const;
export type HeadingMark = (typeof HEADING_MARKS)[number];

export const HEADING_MARK_GLYPHS: Record<HeadingMark, string> = {
  running: '⏳',
  focus: '🎯',
  backburner: '💤',
  complete: '✅',
};

export const HEADING_MARK_LABELS: Record<HeadingMark, string> = {
  running: 'Running',
  focus: 'Focus',
  backburner: 'Backburner',
  complete: 'Complete',
};

/** Only one heading in a file may hold this mark; setting it clears the others. */
export const UNIQUE_MARK: HeadingMark = 'focus';

/** indent, hashes, gap, content (lazy), closing run + trailing blanks. */
const ATX = /^( {0,3})(#{1,6})(?:([ \t]+)(.*?))?((?:[ \t]+#+)?[ \t]*)$/;
/** A mark at the end of heading content; tolerates the emoji presentation selector. */
const TRAILING_MARK = /(^|[ \t]+)(⏳|🎯|💤|✅)️?$/u;

/** The mark at the end of a heading's TEXT (no `#`s), or null. */
export function markOfText(text: string): HeadingMark | null {
  const m = TRAILING_MARK.exec(text.trimEnd());
  if (!m) {
    return null;
  }
  return HEADING_MARKS.find((mark) => HEADING_MARK_GLYPHS[mark] === m[2]) ?? null;
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
 * For each heading in document order, the index of the heading whose mark
 * its section shows: itself when it carries a mark, else the innermost
 * enclosing marked heading; -1 when none. A section runs from its heading to
 * the next heading of the same or a higher level, so everything under
 * `## Build ⏳` — text and `###` sub-headings alike — reads as running, until
 * a sub-heading carries a mark of its own.
 */
export function sectionMarkOwners(headings: readonly SectionHeading[]): number[] {
  const open: { level: number; owner: number }[] = [];
  return headings.map(({ level, mark }, i) => {
    while (open.length > 0 && open[open.length - 1]!.level >= level) {
      open.pop();
    }
    const owner = mark ? i : (open[open.length - 1]?.owner ?? -1);
    open.push({ level, owner });
    return owner;
  });
}

/** The mark each heading's section shows, in document order (see `sectionMarkOwners`). */
export function sectionMarks(headings: readonly SectionHeading[]): (HeadingMark | null)[] {
  return sectionMarkOwners(headings).map((owner) => headings[owner]?.mark ?? null);
}

/**
 * Does heading `i`'s band run on into heading `i + 1` without a break? True
 * when the next heading still sits inside the section of the heading that
 * owns `i`'s mark and shows that same mark (an unmarked or same-marked
 * sub-heading), so the blank lines or block gap in front of it stay tinted.
 * A sibling, a higher heading or a differently marked one starts afresh.
 */
export function bandContinues(
  headings: readonly SectionHeading[],
  owners: readonly number[],
  i: number,
): boolean {
  const owner = headings[owners[i] ?? -1];
  const next = headings[i + 1];
  if (!owner?.mark || !next) {
    return false;
  }
  return next.level > owner.level && headings[owners[i + 1] ?? -1]?.mark === owner.mark;
}
