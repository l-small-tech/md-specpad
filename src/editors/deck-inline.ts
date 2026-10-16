/**
 * deck-inline.ts — editing a slide's text in place (src/editors/deck-editor.ts).
 *
 * A heading, a paragraph, a list item or a code fence on the stage becomes
 * `contenteditable` where it stands; what the person types is read back out
 * of the DOM as markdown and written over the block's source lines. Two
 * halves, both pure enough to test without a slide:
 *
 * - `inlineSource` splits a block's source into the frame that is never
 *   edited (`# `, `> - `, the fence lines) and the body that is, and says no
 *   for any block whose source the DOM cannot speak for (an HTML comment such
 *   as `<!-- fit -->`, a fence inside a list).
 * - `inlineMarkdown` serialises the edited element's inline content
 *   (strong / em / del / code / links / line breaks), escaping what typing
 *   could turn into markup by accident.
 *
 * `canEditInline` gates the whole thing: any element the serialiser does not
 * know (an image, KaTeX, inline HTML, a nested list) leaves the block to the
 * source popover, so nothing is ever dropped on a round-trip.
 */

export type InlineKind = 'heading' | 'text' | 'code';

/** A block's source, cut into the fixed frame around its editable body. */
export interface InlineSource {
  kind: InlineKind;
  /** Before the body on its first line: `## `, `> - `, the opening fence. */
  prefix: string;
  /** Before every later body line: a blockquote's `> `, a list item's indent. */
  cont: string;
  /** After the body on its last line: an ATX heading's closing `#`s. */
  tail: string;
  /** Whole lines after the body: a setext underline, a closing fence. */
  after: string[];
}

const QUOTE_LIST = String.raw`(?:[ \t]*>[ ]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))?`;
const ATX = new RegExp(String.raw`^(${QUOTE_LIST}#{1,6}(?:[ \t]+|$))(.*?)((?:[ \t]+#+)?[ \t]*)$`);
const FIRST_TEXT = new RegExp(String.raw`^(${QUOTE_LIST})(.*)$`);
const CONT_TEXT = /^((?:[ \t]*>[ ]?)*[ \t]*)(.*)$/;
const SETEXT = /^[ \t]*(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;

/** The editable kind of a stamped block's tag, or null for one never edited in place. */
export function inlineKindOf(tag: string): InlineKind | null {
  if (/^H[1-6]$/.test(tag)) {
    return 'heading';
  }
  if (tag === 'P' || tag === 'LI') {
    return 'text';
  }
  return tag === 'CODE' ? 'code' : null;
}

/** Split `source` (the block's lines) for `kind`; null when it cannot be edited in place. */
export function inlineSource(source: string, kind: InlineKind): InlineSource | null {
  if (source.includes('<!--')) {
    return null; // a directive or a comment the slide does not show
  }
  const lines = source.split('\n');
  const first = lines[0] ?? '';
  if (kind === 'code') {
    const open = FENCE_OPEN.exec(first);
    if (!open) {
      return null; // indented code, or a fence inside a quote or list
    }
    const fence = open[1]!;
    const last = lines.length > 1 ? lines[lines.length - 1]! : '';
    const closes =
      lines.length > 1 &&
      new RegExp(String.raw`^[ \t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \t]*$`).test(
        last,
      );
    return { kind, prefix: `${first}\n`, cont: '', tail: '', after: closes ? [last] : [] };
  }
  if (kind === 'heading') {
    if (lines.length === 2 && SETEXT.test(lines[1]!)) {
      const m = CONT_TEXT.exec(first)!;
      return { kind, prefix: m[1]!, cont: '', tail: '', after: [lines[1]!] };
    }
    const m = ATX.exec(first);
    return lines.length === 1 && m
      ? { kind, prefix: m[1]!, cont: '', tail: m[3]!, after: [] }
      : null;
  }
  const m = FIRST_TEXT.exec(first)!;
  const prefix = m[1]!;
  // A later line keeps the source's own lead-in; a one-line list item's new
  // lines line up under its text, and a quote's keep their `>`.
  const cont =
    lines.length > 1
      ? CONT_TEXT.exec(lines[1]!)![1]!
      : /[-*+\d]/.test(prefix)
        ? prefix.replace(/[^>\s]/g, ' ')
        : prefix;
  return { kind, prefix, cont, tail: '', after: [] };
}

/** The block's new source lines for an edited `body` ('' removes the block). */
export function rebuildInline(parts: InlineSource, body: string): string {
  if (body === '' && parts.kind !== 'code') {
    return '';
  }
  if (parts.kind === 'code') {
    return [`${parts.prefix}${body}`, ...parts.after].join('\n');
  }
  const lines = body.split('\n');
  const out = lines.map((line, i) => (i === 0 ? parts.prefix : parts.cont) + line);
  out[out.length - 1] += parts.tail;
  return [...out, ...parts.after].join('\n');
}

/* ---- the DOM side ----------------------------------------------------------- */

const MARKS: Record<string, string> = {
  STRONG: '**',
  B: '**',
  EM: '*',
  I: '*',
  S: '~~',
  DEL: '~~',
  STRIKE: '~~',
};
/** What an in-place block may hold. Anything else goes to the source popover. */
const INLINE_TAGS = new Set([...Object.keys(MARKS), 'CODE', 'A', 'BR']);

/** True when `block` can be edited where it stands without losing anything. */
export function canEditInline(block: Element, kind: InlineKind): boolean {
  if (block.querySelector('[data-line]')) {
    return false; // a nested list or quote: its own blocks
  }
  if (kind === 'code') {
    return true; // read back as plain text; highlighting spans are throwaway
  }
  for (const child of block.querySelectorAll('*')) {
    if (!INLINE_TAGS.has(child.tagName)) {
      return false;
    }
  }
  return true;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** Escape what a markdown inline parser would read as markup. */
function escapeText(text: string): string {
  return (
    text
      .replace(/\u00a0/g, ' ')
      // A newline in the markup is only whitespace (`<br>\n` is how a break
      // renders); the line breaks are the <br>s.
      .replace(/[ \t]*[\r\n][ \t\r\n]*/g, ' ')
      .replace(/[\\`*[\]]/g, '\\$&')
      .replace(/~~/g, '\\~\\~')
      .replace(/_/g, (m, i: number, s: string) =>
        isWordChar(s[i - 1]) && isWordChar(s[i + 1]) ? m : '\\_',
      )
      .replace(/<(?=[A-Za-z/!?])/g, '\\<')
      .replace(/&(?=#?\w+;)/g, '\\&')
  );
}

/** Put the markers inside the run's whitespace: `** x**` is not emphasis. */
function wrap(inner: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function link(el: Element, inner: string): string {
  const href = el.getAttribute('href') ?? '';
  const text = el.textContent ?? '';
  // A bare URL the parser linkified: write it back bare.
  if (href !== '' && (text === href || href === `http://${text}` || href === `mailto:${text}`)) {
    return text;
  }
  const dest = /[\s()<>]/.test(href) ? `<${href}>` : href;
  const title = el.getAttribute('title');
  return `[${inner}](${dest}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
}

function walk(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += escapeText((child as Text).data);
      continue;
    }
    if (!(child instanceof Element)) {
      continue;
    }
    const tag = child.tagName;
    const mark = MARKS[tag];
    if (tag === 'BR') {
      out += '\n';
    } else if (mark) {
      out += wrap(walk(child), mark);
    } else if (tag === 'CODE') {
      out += codeSpan(child.textContent ?? '');
    } else if (tag === 'A') {
      const inner = walk(child);
      out += inner === '' ? '' : link(child, inner);
    } else if (tag === 'DIV' || tag === 'P') {
      // What a browser's own Enter leaves behind: a line of its own.
      if (out !== '' && !out.endsWith('\n')) {
        out += '\n';
      }
      out += walk(child);
    } else {
      out += walk(child);
    }
  }
  return out;
}

/** A line the parser would read as a block of its own gets its marker escaped. */
function escapeLineStart(line: string, kind: InlineKind): string {
  let text = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^(?:#{1,6}|[-+])(?:\s|$)/.test(text) || text.startsWith('>')) {
    text = `\\${text}`;
  } else if (/^\d{1,9}[.)](?:\s|$)/.test(text)) {
    text = text.replace(/^(\d+)([.)])/, '$1\\$2');
  } else if (/^(?:=+|-+)$/.test(text)) {
    text = `\\${text}`;
  }
  if (kind === 'heading') {
    text = text.replace(/(\s)(#+)$/, '$1\\$2'); // not a closing sequence
  }
  return text;
}

/** The markdown of an in-place block's content, as it stands in the DOM now. */
export function inlineMarkdown(block: Element, kind: InlineKind): string {
  if (kind === 'code') {
    return (block.textContent ?? '').replace(/\n$/, '');
  }
  const lines = walk(block)
    .split('\n')
    .map((line) => escapeLineStart(line, kind));
  // A heading is one line; a paragraph never starts or ends on an empty one.
  const body = kind === 'heading' ? lines.join(' ') : lines.join('\n');
  return body.replace(/^\n+|\n+$/g, '');
}
