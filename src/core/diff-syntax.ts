/**
 * Syntax colouring for the DiffView — pure (Lezer only, no DOM), so it is
 * Vitest-covered here and the component just maps spans to <span>s.
 *
 *   - `diffLanguageFor(path)` — which grammar a path gets: TypeScript /
 *     JavaScript (dialect from the extension, as `core/code/parse` and the
 *     Review pane do), Rust, or Markdown (GFM). Null for anything else: the
 *     diff then draws plain text.
 *   - `tokenizeLines(text, path)` — ONE parse of a side's whole text (a line
 *     highlighted on its own would lose the comment / template string / code
 *     fence it sits in), cut into per-line token spans. Null when there is no
 *     grammar or the text is over `MAX_HIGHLIGHT_CHARS` (big diffs stay fast).
 *   - `mergeSpans(text, tokens, hi)` — one line's token spans composed with
 *     its intra-line changed range, as the flat segment list a row renders.
 *
 * The tag → class table mirrors `editors/code-highlight.ts` (colours) and
 * `preview/code-review.ts` (`cr-tok-*` classes), plus the markdown tags of
 * `editors/markdown-highlight.ts`; `styles/diff.css` maps `.diff-tok-*` onto
 * the same `--md-*` variables, so every theme colours diffs like its editor.
 */

import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { parser as jsParser } from '@lezer/javascript';
import { GFM, parser as mdParser } from '@lezer/markdown';
import { parser as rustParser } from '@lezer/rust';

/** Above this many characters a side is drawn without syntax colour. */
export const MAX_HIGHLIGHT_CHARS = 300_000;

export type DiffLanguage = 'ts' | 'js' | 'tsx' | 'jsx' | 'rust' | 'markdown';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdx']);

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function diffLanguageFor(path: string | null | undefined): DiffLanguage | null {
  if (!path) {
    return null;
  }
  const ext = extensionOf(path);
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'jsx':
      return 'jsx';
    case 'rs':
      return 'rust';
    default:
      return MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : null;
  }
}

/** The one parser method used here (`@lezer/common`'s Parser is only a
 *  transitive dependency, so its type is not imported). */
interface TreeParser {
  parse(input: string): Parameters<typeof highlightTree>[0];
}

const parsers = new Map<DiffLanguage, TreeParser>();

function parserFor(lang: DiffLanguage): TreeParser {
  let p = parsers.get(lang);
  if (!p) {
    p =
      lang === 'rust'
        ? rustParser
        : lang === 'markdown'
          ? mdParser.configure(GFM)
          : jsParser.configure({
              dialect: { ts: 'ts', tsx: 'ts jsx', js: '', jsx: 'jsx' }[lang],
            });
    parsers.set(lang, p);
  }
  return p;
}

const HEADINGS = [
  tags.heading,
  tags.heading1,
  tags.heading2,
  tags.heading3,
  tags.heading4,
  tags.heading5,
  tags.heading6,
];

/** Code tags as in `editors/code-highlight.ts`; markdown tags as in
 *  `editors/markdown-highlight.ts` (never `content` / `list`: those cover
 *  whole paragraphs and lists). */
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'diff-tok-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'diff-tok-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'diff-tok-literal' },
  { tag: tags.comment, class: 'diff-tok-comment' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'diff-tok-type' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.definition(tags.variableName)),
      tags.function(tags.propertyName),
      tags.definition(tags.variableName),
      tags.definition(tags.propertyName),
    ],
    class: 'diff-tok-def',
  },
  { tag: [tags.meta, tags.annotation, tags.operator, tags.macroName], class: 'diff-tok-meta' },
  { tag: HEADINGS, class: 'diff-tok-heading' },
  { tag: tags.strong, class: 'diff-tok-strong' },
  { tag: tags.emphasis, class: 'diff-tok-em' },
  { tag: tags.strikethrough, class: 'diff-tok-strike' },
  { tag: tags.monospace, class: 'diff-tok-string' },
  { tag: [tags.link, tags.url], class: 'diff-tok-link' },
  { tag: tags.quote, class: 'diff-tok-comment' },
  { tag: tags.processingInstruction, class: 'diff-tok-meta' },
]);

/** A coloured span of one line: `[from, to)` in that line's characters. */
export interface TokenSpan {
  from: number;
  to: number;
  cls: string;
}

/**
 * Per-line token spans of `text` (split on `\n`, so line `i` is 1-based line
 * `i + 1`; a trailing `\r` stays part of its line and simply never gets a
 * span the caller draws). Null when `path` has no grammar or the text is too
 * big to colour.
 */
export function tokenizeLines(
  text: string,
  path: string | null | undefined,
  maxChars = MAX_HIGHLIGHT_CHARS,
): TokenSpan[][] | null {
  const lang = diffLanguageFor(path);
  if (lang === null || text.length > maxChars) {
    return null;
  }
  const lines: TokenSpan[][] = [[]];
  // Start offset of each line in `text`.
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
      lines.push([]);
    }
  }
  let line = 0;
  const tree = parserFor(lang).parse(text);
  highlightTree(tree, highlighter, (from, to, cls) => {
    while (line + 1 < starts.length && starts[line + 1]! <= from) {
      line += 1;
    }
    // A token may span lines (block comments, template strings, fences):
    // close it at each newline and reopen it on the next line.
    let l = line;
    let pos = from;
    while (pos < to) {
      const lineStart = starts[l]!;
      const lineEnd = l + 1 < starts.length ? starts[l + 1]! - 1 : text.length;
      const end = Math.min(to, lineEnd);
      if (end > pos) {
        lines[l]!.push({ from: pos - lineStart, to: end - lineStart, cls });
      }
      if (to <= lineEnd || l + 1 >= starts.length) {
        break;
      }
      l += 1;
      pos = starts[l]!;
    }
  });
  return lines;
}

/** One drawn piece of a line. */
export interface LineSegment {
  text: string;
  /** Syntax class, or null for plain text. */
  cls: string | null;
  /** Inside the intra-line changed range. */
  hi: boolean;
}

/**
 * Compose a line's (sorted, non-overlapping) token spans with its changed
 * range into segments covering `text` exactly. Spans past the end of `text`
 * (the stripped `\r`) are clipped.
 */
export function mergeSpans(
  text: string,
  tokens: readonly TokenSpan[] | null | undefined,
  hi: readonly [number, number] | null,
): LineSegment[] {
  const len = text.length;
  // Every boundary where the class or the highlight may change.
  const cuts = new Set<number>([0, len]);
  if (hi) {
    cuts.add(Math.max(0, Math.min(len, hi[0])));
    cuts.add(Math.max(0, Math.min(len, hi[1])));
  }
  for (const t of tokens ?? []) {
    if (t.from < len) {
      cuts.add(Math.max(0, t.from));
      cuts.add(Math.min(len, t.to));
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: LineSegment[] = [];
  let ti = 0;
  const list = tokens ?? [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if (to <= from) {
      continue;
    }
    while (ti < list.length && list[ti]!.to <= from) {
      ti += 1;
    }
    const tok = list[ti];
    const cls = tok && tok.from <= from && tok.to >= to ? tok.cls : null;
    const inHi = hi !== null && from >= hi[0] && to <= hi[1];
    const last = out[out.length - 1];
    if (last && last.cls === cls && last.hi === inHi) {
      last.text += text.slice(from, to);
    } else {
      out.push({ text: text.slice(from, to), cls, hi: inHi });
    }
  }
  return out;
}
