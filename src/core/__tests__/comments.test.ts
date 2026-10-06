import { describe, expect, test } from 'vitest';
import {
  commentsPathFor,
  isCommentsPath,
  lineQuote,
  newCommentId,
  noteRefFor,
  parseCommentsFile,
  serializeCommentsFile,
  VOICE_NOTES_DISCLAIMER,
  type VoiceComment,
} from '../comments';

describe('commentsPathFor', () => {
  test('replaces .md with .comments.md in the same directory', () => {
    expect(commentsPathFor('/home/me/notes/foo.md')).toBe('/home/me/notes/foo.comments.md');
  });

  test('collapses .markdown to .comments.md', () => {
    expect(commentsPathFor('/n/report.markdown')).toBe('/n/report.comments.md');
  });

  test('works over saf:// identifiers (suffix replace, no path parsing)', () => {
    expect(commentsPathFor('saf://TOKEN%2Fabc/sub/foo.md')).toBe(
      'saf://TOKEN%2Fabc/sub/foo.comments.md',
    );
  });

  test('handles Windows separators', () => {
    expect(commentsPathFor('C:\\notes\\foo.md')).toBe('C:\\notes/foo.comments.md');
  });

  test("'nextToFile' is the same as no options", () => {
    expect(
      commentsPathFor('/ws/docs/foo.md', {
        location: 'nextToFile',
        folderName: 'Voice Notes',
        workspaceRoot: '/ws',
      }),
    ).toBe('/ws/docs/foo.comments.md');
  });

  describe("'workspaceFolder'", () => {
    const opts = {
      location: 'workspaceFolder',
      folderName: 'Voice Notes',
      workspaceRoot: '/ws',
    } as const;

    test('a note at the workspace root lands directly in the folder', () => {
      expect(commentsPathFor('/ws/foo.md', opts)).toBe('/ws/Voice Notes/foo.comments.md');
    });

    test("mirrors the note's sub-path so same-named notes never collide", () => {
      expect(commentsPathFor('/ws/docs/a/foo.md', opts)).toBe(
        '/ws/Voice Notes/docs/a/foo.comments.md',
      );
      expect(commentsPathFor('/ws/docs/b/foo.md', opts)).toBe(
        '/ws/Voice Notes/docs/b/foo.comments.md',
      );
    });

    test('a note outside the root, or on another drive, lands directly in the folder', () => {
      expect(commentsPathFor('/elsewhere/foo.md', opts)).toBe('/ws/Voice Notes/foo.comments.md');
      expect(commentsPathFor('D:/x/foo.md', { ...opts, workspaceRoot: 'C:/ws' })).toBe(
        'C:/ws/Voice Notes/foo.comments.md',
      );
    });

    test('works over saf:// identifiers', () => {
      expect(
        commentsPathFor('saf://TOKEN%2Fabc/sub/foo.md', {
          ...opts,
          workspaceRoot: 'saf://TOKEN%2Fabc',
        }),
      ).toBe('saf://TOKEN%2Fabc/Voice Notes/sub/foo.comments.md');
    });
  });
});

describe('noteRefFor', () => {
  test('a sibling sidecar refers to the bare file name', () => {
    expect(noteRefFor('/ws/docs/foo.comments.md', '/ws/docs/foo.md')).toBe('foo.md');
  });

  test('a shared-folder sidecar refers up and across to the note', () => {
    expect(noteRefFor('/ws/Voice Notes/docs/a/foo.comments.md', '/ws/docs/a/foo.md')).toBe(
      '../../../docs/a/foo.md',
    );
    expect(noteRefFor('/ws/Voice Notes/foo.comments.md', '/ws/foo.md')).toBe('../foo.md');
  });

  test('falls back to the file name across roots', () => {
    expect(noteRefFor('C:/ws/Voice Notes/foo.comments.md', 'D:/x/foo.md')).toBe('foo.md');
  });
});

describe('isCommentsPath', () => {
  test('matches only *.comments.md', () => {
    expect(isCommentsPath('/n/foo.comments.md')).toBe(true);
    expect(isCommentsPath('/n/foo.md')).toBe(false);
    expect(isCommentsPath('/n/comments.md')).toBe(false);
    expect(isCommentsPath('/n/foo.COMMENTS.MD')).toBe(true);
  });
});

describe('lineQuote', () => {
  test('returns the trimmed 1-based line, tolerating CRLF', () => {
    expect(lineQuote('a\n  ## Setup  \r\nc', 2)).toBe('## Setup');
  });

  test('is empty out of range', () => {
    expect(lineQuote('a\nb', 0)).toBe('');
    expect(lineQuote('a\nb', 3)).toBe('');
  });
});

describe('newCommentId', () => {
  test('never returns an id already in use', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newCommentId(taken);
      expect(taken.has(id)).toBe(false);
      expect(id).toMatch(/^c[0-9a-z]+$/);
      taken.add(id);
    }
  });
});

const NOTE = 'meeting-notes.md';

describe('serialize (v2 format)', () => {
  test('writes the version header, a title linking the parent, and every field', () => {
    const text = serializeCommentsFile(
      [
        {
          id: 'c3f9a',
          file: '../meeting-notes.md',
          line: 42,
          quote: 'Pricing goes live Friday',
          time: '2026-09-10T21:32:07.000Z',
          transcript: 'Ship the pricing change before the demo.',
        },
      ],
      '../meeting-notes.md',
    );
    expect(text).toBe(
      [
        '<!-- md-specpad voice comments v2 -->',
        VOICE_NOTES_DISCLAIMER,
        '# Voice notes for [meeting-notes.md](../meeting-notes.md)',
        '',
        '## ^c3f9a',
        '- file: ../meeting-notes.md',
        '- line: 42',
        '- time: 2026-09-10T21:32:07.000Z',
        '',
        '> Pricing goes live Friday',
        '',
        'Ship the pricing change before the demo.',
        '',
      ].join('\n'),
    );
  });

  test('carries a disclaimer, as an HTML comment, telling agents it is a voice transcript', () => {
    const text = serializeCommentsFile([], 'foo.md');
    const lines = text.split('\n');
    // Directly under the version stamp, before the title and any entry.
    expect(lines[1]).toBe('<!--');
    expect(text.indexOf(VOICE_NOTES_DISCLAIMER)).toBeLessThan(text.indexOf('# Voice notes for'));
    expect(VOICE_NOTES_DISCLAIMER.startsWith('<!--')).toBe(true);
    expect(VOICE_NOTES_DISCLAIMER.endsWith('-->')).toBe(true);
    // Exactly one comment: no early `-->` that would expose the rest as text.
    expect(VOICE_NOTES_DISCLAIMER.indexOf('-->')).toBe(VOICE_NOTES_DISCLAIMER.length - 3);
    expect(VOICE_NOTES_DISCLAIMER).toMatch(/speech recognition/);
    expect(VOICE_NOTES_DISCLAIMER).toMatch(/AI agents/);
    expect(VOICE_NOTES_DISCLAIMER).toMatch(/subtle\s+errors/);
  });

  test('the disclaimer never leaks into parsed notes, and is written once per save', () => {
    const comments: VoiceComment[] = [
      { id: 'cd1a', file: 'foo.md', line: 3, quote: 'q', time: 't', transcript: 'fix this' },
    ];
    const once = serializeCommentsFile(comments, 'foo.md');
    const parsed = parseCommentsFile(once);
    expect(parsed).toEqual(comments);
    const twice = serializeCommentsFile(parsed, 'foo.md');
    expect(twice).toBe(once);
    expect(twice.split(VOICE_NOTES_DISCLAIMER).length).toBe(2);
  });

  test('fills a legacy entry with no file from the note name and omits line/quote', () => {
    const text = serializeCommentsFile(
      [{ id: 'cold1', file: '', line: null, quote: '', time: 't', transcript: 'x' }],
      NOTE,
    );
    expect(text).toContain('- file: meeting-notes.md');
    expect(text).not.toContain('- line:');
    expect(text).not.toContain('\n> ');
  });

  test('percent-encodes spaces in the title link but not the label', () => {
    const text = serializeCommentsFile([], '../my notes.md');
    expect(text).toContain('# Voice notes for [my notes.md](../my%20notes.md)');
  });
});

describe('parse/serialize round-trip', () => {
  test('round-trips a multi-note file', () => {
    const comments: VoiceComment[] = [
      {
        id: 'c3f9a',
        file: NOTE,
        line: 3,
        quote: '- item one',
        time: '2026-07-13T10:22:04.511Z',
        transcript: 'Buy milk before Friday.',
      },
      {
        id: 'c7b21',
        file: NOTE,
        line: 10,
        quote: '',
        time: '2026-07-13T10:24:31.002Z',
        transcript: 'Follow up with design.',
      },
    ];
    const text = serializeCommentsFile(comments, NOTE);
    expect(parseCommentsFile(text)).toEqual(comments);
  });

  test('a legacy `- audio:` line is dropped, not read as transcript, and never rewritten', () => {
    const legacy = [
      '<!-- md-specpad voice comments v2 -->',
      '## ^cold1',
      '- file: foo.md',
      '- line: 4',
      '- time: t',
      '- audio: foo.cold1.webm',
      '',
      'typed later',
      '',
    ].join('\n');
    const parsed = parseCommentsFile(legacy);
    expect(parsed).toEqual([
      { id: 'cold1', file: 'foo.md', line: 4, quote: '', time: 't', transcript: 'typed later' },
    ]);
    expect(serializeCommentsFile(parsed, 'foo.md')).not.toContain('audio');
  });

  test('preserves a multi-line transcript with dashes, list markers and blockquotes', () => {
    const comments: VoiceComment[] = [
      {
        id: 'cabcd',
        file: NOTE,
        line: 1,
        quote: 'Title',
        time: '2026-07-13T10:00:00.000Z',
        transcript: 'first line\n- a dashed line\n> quoted in the body\nsecond paragraph',
      },
    ];
    const parsed = parseCommentsFile(serializeCommentsFile(comments, NOTE));
    expect(parsed).toEqual(comments);
  });

  test('handles an empty transcript', () => {
    const comments: VoiceComment[] = [
      { id: 'cnull', file: NOTE, line: 2, quote: 'q', time: 't', transcript: '' },
    ];
    expect(parseCommentsFile(serializeCommentsFile(comments, NOTE))).toEqual(comments);
  });

  test('an empty note list serializes to just the header/title and parses back empty', () => {
    expect(parseCommentsFile(serializeCommentsFile([], NOTE))).toEqual([]);
  });

  test('preserves a transcript whose first body line looks like metadata', () => {
    const comments: VoiceComment[] = [
      {
        id: 'cmeta',
        file: NOTE,
        line: 5,
        quote: '',
        time: '2026-07-13T10:00:00.000Z',
        transcript: '- audio: something\nand more text',
      },
    ];
    expect(parseCommentsFile(serializeCommentsFile(comments, NOTE))).toEqual(comments);
  });

  test('tolerates CRLF line endings', () => {
    const text = serializeCommentsFile(
      [{ id: 'ccrlf', file: NOTE, line: 7, quote: 'the line', time: 't', transcript: 'hi\nthere' }],
      NOTE,
    ).replace(/\n/g, '\r\n');
    expect(parseCommentsFile(text)).toEqual([
      {
        id: 'ccrlf',
        file: NOTE,
        line: 7,
        quote: 'the line',
        time: 't',
        transcript: 'hi\nthere',
      },
    ]);
  });
});

describe('code-review fields', () => {
  const CODE: VoiceComment = {
    id: 'cunit',
    file: 'text-files.ts',
    line: 96,
    quote: 'export function showAllFilesState(',
    time: '2026-09-10T21:32:07.000Z',
    transcript: 'This should take the hidden dirs too.',
    unit: 'showAllFilesState (function)',
  };

  test('`unit` is written after the other meta lines and round-trips', () => {
    const text = serializeCommentsFile([CODE], 'text-files.ts');
    expect(text).toContain(
      [
        '- line: 96',
        '- time: 2026-09-10T21:32:07.000Z',
        '- unit: showAllFilesState (function)',
      ].join('\n'),
    );
    expect(parseCommentsFile(text)).toEqual([CODE]);
  });

  test('a note without a unit writes no line and parses back without the field', () => {
    const plain: VoiceComment = { ...CODE, unit: undefined };
    const text = serializeCommentsFile([plain], 'text-files.ts');
    expect(text).not.toContain('- unit:');
    const parsed = parseCommentsFile(text);
    expect(parsed).toEqual([{ ...plain, unit: undefined }]);
    expect('unit' in parsed[0]!).toBe(false);
  });

  test('an older file (no unit line) still parses', () => {
    const older = [
      '<!-- md-specpad voice comments v2 -->',
      '## ^cold2',
      '- file: text-files.ts',
      '- line: 4',
      '- time: t',
      '',
      '> a line',
      '',
      'a note',
      '',
    ].join('\n');
    expect(parseCommentsFile(older)).toEqual([
      {
        id: 'cold2',
        file: 'text-files.ts',
        line: 4,
        quote: 'a line',
        time: 't',
        transcript: 'a note',
      },
    ]);
  });

  test('an unknown meta line from a newer build is dropped, not read as transcript', () => {
    const newer = [
      '<!-- md-specpad voice comments v2 -->',
      '## ^cnew1',
      '- file: text-files.ts',
      '- line: 4',
      '- time: t',
      '- unit: dirKey (function)',
      '- mood: cheerful',
      '',
      'the note itself',
      '',
    ].join('\n');
    const parsed = parseCommentsFile(newer);
    expect(parsed).toEqual([
      {
        id: 'cnew1',
        file: 'text-files.ts',
        line: 4,
        quote: '',
        time: 't',
        transcript: 'the note itself',
        unit: 'dirKey (function)',
      },
    ]);
    // The unknown line ends the meta run; it must not survive a rewrite either.
    expect(serializeCommentsFile(parsed, 'text-files.ts')).not.toContain('mood');
  });

  test('review context goes under the title, and the parser ignores it', () => {
    const text = serializeCommentsFile([CODE], 'text-files.ts', {
      branch: 'feat/explorer-filters',
      worktree: 'worktrees/explorer-filters',
      baseBranch: 'development',
      baseRef: '3c77f30',
    });
    const lines = text.split('\n');
    const at = lines.indexOf('# Voice notes for [text-files.ts](text-files.ts)');
    expect(lines[at + 1]).toBe(
      '- branch: feat/explorer-filters (worktree: worktrees/explorer-filters)',
    );
    expect(lines[at + 2]).toBe('- compared against: development (merge-base 3c77f30)');
    expect(lines[at + 3]).toBe('');
    expect(parseCommentsFile(text)).toEqual([CODE]);
  });

  test('each context field is optional; an empty context writes nothing', () => {
    expect(serializeCommentsFile([], 'a.ts', { branch: 'feat/x' })).toContain('- branch: feat/x\n');
    expect(serializeCommentsFile([], 'a.ts', { baseBranch: 'main' })).toContain(
      '- compared against: main\n',
    );
    expect(serializeCommentsFile([], 'a.ts', { worktree: 'worktrees/x', baseRef: 'abc1234' })).toBe(
      serializeCommentsFile([], 'a.ts'),
    );
    expect(serializeCommentsFile([], 'a.ts', {})).toBe(serializeCommentsFile([], 'a.ts'));
  });
});

describe('legacy v1 files', () => {
  test('parse with empty file/line/quote and the body kept verbatim', () => {
    const v1 = [
      '<!-- md-notepad voice comments v1 -->',
      '',
      '## ^cxyz',
      '- time: 2026-01-01T00:00:00.000Z',
      '',
      '> a v1 body that happens to start with a blockquote',
      'and continues',
      '',
    ].join('\n');
    expect(parseCommentsFile(v1)).toEqual([
      {
        id: 'cxyz',
        file: '',
        line: null,
        quote: '',
        time: '2026-01-01T00:00:00.000Z',
        transcript: '> a v1 body that happens to start with a blockquote\nand continues',
      },
    ]);
  });

  test('a v2 file stamped md-notepad (before the rename) still parses as v2', () => {
    const text = [
      '<!-- md-notepad voice comments v2 -->',
      '',
      '## ^cabc',
      '- file: a.md',
      '- line: 3',
      '- time: t',
      '',
      '> the quoted line',
      '',
      'the transcript',
      '',
    ].join('\n');
    expect(parseCommentsFile(text)).toEqual([
      {
        id: 'cabc',
        file: 'a.md',
        line: 3,
        quote: 'the quoted line',
        time: 't',
        transcript: 'the transcript',
      },
    ]);
  });

  test('a headerless file is treated as v1', () => {
    const text = '## ^cxyz\n- time: t\n\nhello world\n';
    expect(parseCommentsFile(text)).toEqual([
      {
        id: 'cxyz',
        file: '',
        line: null,
        quote: '',
        time: 't',
        transcript: 'hello world',
      },
    ]);
  });
});
