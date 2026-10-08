import { describe, expect, test } from 'vitest';
import {
  bandContinues,
  markOfText,
  parseHeadingLine,
  sectionMarkOwners,
  sectionMarks,
  setHeadingLineMark,
  stripMark,
  withMarkText,
  type HeadingMark,
} from '../heading-mark';

describe('parseHeadingLine', () => {
  test('any ATX level, with or without a mark', () => {
    expect(parseHeadingLine('# Title')).toEqual({ level: 1, mark: null });
    expect(parseHeadingLine('###### Deep ⏳')).toEqual({ level: 6, mark: 'running' });
    expect(parseHeadingLine('   ## Indented ✅')).toEqual({ level: 2, mark: 'complete' });
    expect(parseHeadingLine('## Closed ✅ ##')).toEqual({ level: 2, mark: 'complete' });
    expect(parseHeadingLine('## Done ✅\r')).toEqual({ level: 2, mark: 'complete' });
    expect(parseHeadingLine('##')).toEqual({ level: 2, mark: null });
  });

  test('not headings', () => {
    expect(parseHeadingLine('#hashtag')).toBeNull();
    expect(parseHeadingLine('####### seven')).toBeNull();
    expect(parseHeadingLine('    # code-indented')).toBeNull();
    expect(parseHeadingLine('plain ✅')).toBeNull();
  });

  test('a glyph in the middle of the text is not a mark', () => {
    expect(parseHeadingLine('## ✅ checklist')).toEqual({ level: 2, mark: null });
    expect(parseHeadingLine('## done✅')).toEqual({ level: 2, mark: null });
  });
});

describe('setHeadingLineMark', () => {
  test('adds, swaps and clears', () => {
    const running = setHeadingLineMark('## Build it', 'running');
    expect(running).toBe('## Build it ⏳');
    const complete = setHeadingLineMark(running!, 'complete');
    expect(complete).toBe('## Build it ✅');
    expect(setHeadingLineMark(complete!, null)).toBe('## Build it');
  });

  test('setting the same mark twice does not stack glyphs', () => {
    expect(setHeadingLineMark('# A ✅', 'complete')).toBe('# A ✅');
  });

  test('keeps indent, a closing run and CRLF', () => {
    expect(setHeadingLineMark('  ### Title ##', 'running')).toBe('  ### Title ⏳ ##');
    expect(setHeadingLineMark('# Title ✅\r', null)).toBe('# Title\r');
    expect(setHeadingLineMark('## Title  ', 'complete')).toBe('## Title ✅  ');
  });

  test('an empty heading gets just the glyph; clearing leaves it empty', () => {
    expect(setHeadingLineMark('##', 'running')).toBe('## ⏳');
    expect(setHeadingLineMark('## ⏳', null)).toBe('## ');
  });

  test('reads the emoji-presentation form', () => {
    expect(setHeadingLineMark('# A ✅️', null)).toBe('# A');
  });

  test('null for a line that is not a heading', () => {
    expect(setHeadingLineMark('text', 'running')).toBeNull();
  });
});

describe('heading text helpers (Edit mode works on node text)', () => {
  test('markOfText / stripMark / withMarkText', () => {
    expect(markOfText('Plan ⏳')).toBe('running');
    expect(markOfText('Plan')).toBeNull();
    expect(stripMark('Plan ✅ ')).toBe('Plan');
    expect(withMarkText('Plan ⏳', 'complete')).toBe('Plan ✅');
    expect(withMarkText('', 'running')).toBe('⏳');
  });

  test('focus and backburner glyphs round-trip', () => {
    expect(markOfText('Plan 🎯')).toBe('focus');
    expect(markOfText('Plan 💤')).toBe('backburner');
    expect(withMarkText('Plan 💤', 'focus')).toBe('Plan 🎯');
    expect(setHeadingLineMark('## Later', 'backburner')).toBe('## Later 💤');
    expect(stripMark('Plan 🎯')).toBe('Plan');
  });
});

describe('sectionMarks', () => {
  const h = (level: number, mark: HeadingMark | null = null) => ({ level, mark });

  test('sub-headings inherit the enclosing mark', () => {
    expect(sectionMarks([h(2, 'running'), h(3), h(4), h(2)])).toEqual([
      'running',
      'running',
      'running',
      null,
    ]);
  });

  test('a sub-heading’s own mark wins, and the parent’s resumes after it', () => {
    expect(sectionMarks([h(1, 'running'), h(2, 'complete'), h(3), h(2)])).toEqual([
      'running',
      'complete',
      'complete',
      'running',
    ]);
  });

  test('a higher-level heading closes the section', () => {
    expect(sectionMarks([h(3, 'complete'), h(2), h(3)])).toEqual(['complete', null, null]);
  });
});

describe('sectionMarkOwners / bandContinues', () => {
  const h = (level: number, mark: HeadingMark | null = null) => ({ level, mark });

  test('each heading points at the heading whose mark it shows', () => {
    expect(sectionMarkOwners([h(1), h(2, 'focus'), h(3), h(3, 'complete'), h(2)])).toEqual([
      -1, 1, 1, 3, -1,
    ]);
  });

  test('the band runs on into sub-headings of the marked section', () => {
    const hs = [h(2, 'running'), h(3), h(3), h(2)];
    const owners = sectionMarkOwners(hs);
    expect(bandContinues(hs, owners, 0)).toBe(true); // ## → ###
    expect(bandContinues(hs, owners, 1)).toBe(true); // ### → sibling ### still under ##
    expect(bandContinues(hs, owners, 2)).toBe(false); // ### → ## ends it
    expect(bandContinues(hs, owners, 3)).toBe(false); // nothing after
  });

  test('a sibling or a differently marked sub-heading breaks the band', () => {
    const hs = [h(2, 'complete'), h(2, 'complete'), h(3, 'running'), h(3, 'complete')];
    const owners = sectionMarkOwners(hs);
    expect(bandContinues(hs, owners, 0)).toBe(false);
    expect(bandContinues(hs, owners, 1)).toBe(false);
    expect(bandContinues(hs, owners, 2)).toBe(false);
  });
});
