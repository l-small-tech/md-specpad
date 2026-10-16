// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';

import {
  canEditInline,
  inlineKindOf,
  inlineMarkdown,
  inlineSource,
  rebuildInline,
  type InlineKind,
} from '../deck-inline';

function block(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild!;
}

/** Source → frame → (the DOM's body) → source again. */
function roundTrip(source: string, kind: InlineKind, body: string): string {
  const parts = inlineSource(source, kind);
  expect(parts).not.toBeNull();
  return rebuildInline(parts!, body);
}

describe('inlineKindOf', () => {
  test('headings, paragraphs, list items and fences only', () => {
    expect(inlineKindOf('H2')).toBe('heading');
    expect(inlineKindOf('P')).toBe('text');
    expect(inlineKindOf('LI')).toBe('text');
    expect(inlineKindOf('CODE')).toBe('code');
    expect(inlineKindOf('TABLE')).toBeNull();
    expect(inlineKindOf('UL')).toBeNull();
  });
});

describe('inlineSource / rebuildInline', () => {
  test('an ATX heading keeps its marker and closing hashes', () => {
    expect(roundTrip('## Old title', 'heading', 'New title')).toBe('## New title');
    expect(roundTrip('# Old #', 'heading', 'New')).toBe('# New #');
  });

  test('a setext heading keeps its underline', () => {
    expect(roundTrip('Title\n=====', 'heading', 'Other')).toBe('Other\n=====');
  });

  test('a list item keeps its marker; new lines line up under the text', () => {
    expect(roundTrip('- one', 'text', 'uno')).toBe('- uno');
    expect(roundTrip('12. one', 'text', 'a\nb')).toBe('12. a\n    b');
  });

  test('a quote keeps its marker on every line', () => {
    expect(roundTrip('> first\n> second', 'text', 'a\nb\nc')).toBe('> a\n> b\n> c');
    expect(roundTrip('> only', 'text', 'a\nb')).toBe('> a\n> b');
  });

  test('a plain paragraph', () => {
    expect(roundTrip('line one\nline two', 'text', 'just one')).toBe('just one');
  });

  test('a fence keeps both fence lines', () => {
    expect(roundTrip('```js\nold()\n```', 'code', 'a()\nb()')).toBe('```js\na()\nb()\n```');
    expect(roundTrip('~~~~\nx\n~~~~', 'code', 'y')).toBe('~~~~\ny\n~~~~');
  });

  test('an emptied block is removed', () => {
    expect(roundTrip('## Gone', 'heading', '')).toBe('');
  });

  test('a block carrying a comment or an indented fence is left to the popover', () => {
    expect(inlineSource('# <!-- fit --> Big', 'heading')).toBeNull();
    expect(inlineSource('  ```\n  x\n  ```', 'code')).toBeNull();
    expect(inlineSource('    indented code', 'code')).toBeNull();
  });
});

describe('canEditInline', () => {
  test('inline markup is fine', () => {
    expect(canEditInline(block('<p>a <strong>b</strong> <a href="x">c</a><br>d</p>'), 'text')).toBe(
      true,
    );
  });

  test('an image, math or a nested list is not', () => {
    expect(canEditInline(block('<p>see <img src="a.png"></p>'), 'text')).toBe(false);
    expect(canEditInline(block('<p><span class="katex">x</span></p>'), 'text')).toBe(false);
    expect(
      canEditInline(block('<li data-line="1">a<ul><li data-line="2">b</li></ul></li>'), 'text'),
    ).toBe(false);
  });

  test('a fence is read as text, highlighting and all', () => {
    expect(
      canEditInline(block('<code><span class="hljs-keyword">let</span> x</code>'), 'code'),
    ).toBe(true);
  });
});

describe('inlineMarkdown', () => {
  test('marks, code and links', () => {
    expect(
      inlineMarkdown(
        block('<p>a <strong>bold</strong>, <em>it</em>, <del>no</del>, <code>x`y</code></p>'),
        'text',
      ),
    ).toBe('a **bold**, *it*, ~~no~~, ``x`y``');
    expect(inlineMarkdown(block('<p><a href="https://a.b/c" title="T">site</a></p>'), 'text')).toBe(
      '[site](https://a.b/c "T")',
    );
  });

  test('a linkified URL is written back bare', () => {
    expect(
      inlineMarkdown(block('<p>go <a href="https://a.b/c_d">https://a.b/c_d</a></p>'), 'text'),
    ).toBe('go https://a.b/c_d');
  });

  test('markers move inside the whitespace', () => {
    expect(inlineMarkdown(block('<p>a<b> bold </b>b</p>'), 'text')).toBe('a **bold** b');
  });

  test('line breaks are source lines; a browser <div> is a line too', () => {
    expect(inlineMarkdown(block('<p>one<br>two</p>'), 'text')).toBe('one\ntwo');
    // How markdown-it renders a break: the newline after <br> is not a line.
    expect(inlineMarkdown(block('<p>one<br>\ntwo<br>\nthree</p>'), 'text')).toBe('one\ntwo\nthree');
    expect(inlineMarkdown(block('<li>one<div>two</div></li>'), 'text')).toBe('one\ntwo');
  });

  test('typed markup characters are escaped', () => {
    expect(inlineMarkdown(block('<p>2 * 3 [x] snake_case _x_ a\\b</p>'), 'text')).toBe(
      '2 \\* 3 \\[x\\] snake_case \\_x\\_ a\\\\b',
    );
    expect(inlineMarkdown(block('<p>a &lt;b&gt; c</p>'), 'text')).toBe('a \\<b> c');
  });

  test('a line that would start a block of its own is escaped', () => {
    expect(
      inlineMarkdown(block('<p>x<br># no<br>- no<br>1. no<br>&gt; no<br>---</p>'), 'text'),
    ).toBe('x\n\\# no\n\\- no\n1\\. no\n\\> no\n\\---');
  });

  test('a heading is one line and cannot grow a closing sequence', () => {
    expect(inlineMarkdown(block('<h2>a<br>b #</h2>'), 'heading')).toBe('a b \\#');
  });

  test('non-breaking spaces from typing become spaces', () => {
    expect(inlineMarkdown(block('<p>a\u00a0\u00a0b\u00a0</p>'), 'text')).toBe('a  b');
  });

  test('a fence is its text', () => {
    expect(inlineMarkdown(block('<code><span>let</span> x = 1;\n</code>'), 'code')).toBe(
      'let x = 1;',
    );
  });

  test('an untouched block reads back as its source body', () => {
    const p = block('<p>Plain <strong>words</strong> and <code>code</code></p>');
    expect(inlineMarkdown(p, 'text')).toBe('Plain **words** and `code`');
  });
});
