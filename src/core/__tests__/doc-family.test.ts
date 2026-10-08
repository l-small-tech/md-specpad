import { describe, expect, it } from 'vitest';
import {
  allowedModesFor,
  defaultModeFor,
  docFamilyFor,
  docFamilyForTab,
  isModeAllowed,
  modeLabel,
} from '../doc-family';

describe('docFamilyFor', () => {
  it('recognizes .svg regardless of case or directory', () => {
    expect(docFamilyFor('/notes/board.svg')).toBe('svg');
    expect(docFamilyFor('C:\\Users\\me\\Board.SVG')).toBe('svg');
  });

  it('treats notes, text, images, documents — and no path at all — as markdown', () => {
    expect(docFamilyFor('/notes/todo.md')).toBe('markdown');
    expect(docFamilyFor('/notes/board.svg.md')).toBe('markdown');
    expect(docFamilyFor('/notes/todo.TXT')).toBe('markdown');
    expect(docFamilyFor('/notes/photo.png')).toBe('markdown');
    expect(docFamilyFor('/notes/report.docx')).toBe('markdown');
    expect(docFamilyFor(null)).toBe('markdown');
    expect(docFamilyFor(undefined)).toBe('markdown');
  });

  it('treats any other file — extension-less included — as code', () => {
    expect(docFamilyFor('/src/app.ts')).toBe('code');
    expect(docFamilyFor('C:\\proj\\app.rc')).toBe('code');
    expect(docFamilyFor('/notes/svg')).toBe('code');
    expect(docFamilyFor('/proj/Makefile')).toBe('code');
  });
});

describe('the pdf family', () => {
  it('is any .pdf path, whatever its case', () => {
    expect(docFamilyFor('/notes/report.pdf')).toBe('pdf');
    expect(docFamilyFor('C:\\Docs\\Spec.PDF')).toBe('pdf');
    expect(docFamilyForTab({ kind: 'import', filePath: '/d/spec.pdf' })).toBe('pdf');
  });

  it('offers Review only, and heals every other mode to it', () => {
    expect(allowedModesFor('pdf')).toEqual(['read']);
    expect(defaultModeFor('pdf', 'raw')).toBe('read');
    expect(defaultModeFor('pdf', 'wysiwyg')).toBe('read');
    expect(isModeAllowed('pdf', 'split')).toBe(false);
    expect(modeLabel('read', 'pdf')).toBe('Review');
  });
});

describe('the code family', () => {
  it('offers the source editor and Review (the Review mode), and self-heals the rest to Raw', () => {
    expect(allowedModesFor('code')).toEqual(['raw', 'read']);
    expect(defaultModeFor('code', 'wysiwyg')).toBe('raw');
    expect(defaultModeFor('code', 'read')).toBe('read');
    expect(defaultModeFor('code', 'draw')).toBe('raw');
    expect(isModeAllowed('code', 'split')).toBe(false);
    expect(isModeAllowed('code', 'read')).toBe(true);
  });
});

describe('the deck family', () => {
  it('is a markdown tab whose text says marp: true, and nothing else', () => {
    expect(docFamilyForTab({ kind: 'file', filePath: '/d/talk.md', deck: true })).toBe('deck');
    expect(docFamilyForTab({ kind: 'note', notePath: null, deck: true })).toBe('deck');
    expect(docFamilyForTab({ kind: 'file', filePath: '/d/talk.md', deck: false })).toBe('markdown');
    expect(docFamilyForTab({ kind: 'file', filePath: '/d/talk.md' })).toBe('markdown');
    // A code file or a board with that frontmatter is still what its path says.
    expect(docFamilyForTab({ kind: 'file', filePath: '/d/app.ts', deck: true })).toBe('code');
    expect(docFamilyForTab({ kind: 'file', filePath: '/d/b.svg', deck: true })).toBe('svg');
    expect(docFamilyForTab({ kind: 'terminal', deck: true })).toBe('terminal');
  });

  it('offers Raw, Split, Edit (the deck editor) and Present (the read mode)', () => {
    expect(allowedModesFor('deck')).toEqual(['raw', 'split', 'wysiwyg', 'read']);
    expect(isModeAllowed('deck', 'wysiwyg')).toBe(true);
    expect(isModeAllowed('deck', 'read')).toBe(true);
    expect(isModeAllowed('deck', 'draw')).toBe(false);
    expect(defaultModeFor('deck', 'wysiwyg')).toBe('wysiwyg');
    expect(defaultModeFor('deck', 'draw')).toBe('split');
    expect(defaultModeFor('deck', 'read')).toBe('read');
  });
});

describe('modeLabel', () => {
  it('calls the Review mode Review for code and Read for everything else', () => {
    expect(modeLabel('read', 'code')).toBe('Review');
    expect(modeLabel('read', 'markdown')).toBe('Review');
    expect(modeLabel('read', 'svg')).toBe('Review');
  });

  it('calls the read mode Present on a deck', () => {
    expect(modeLabel('read', 'deck')).toBe('Present');
    expect(modeLabel('split', 'deck')).toBe('Split');
  });

  it('leaves the other modes named as before, whatever the family', () => {
    expect(modeLabel('raw', 'code')).toBe('Raw');
    expect(modeLabel('raw', 'markdown')).toBe('Raw');
    expect(modeLabel('split', 'markdown')).toBe('Split');
    expect(modeLabel('wysiwyg', 'markdown')).toBe('Edit');
    expect(modeLabel('draw', 'svg')).toBe('Draw');
    expect(modeLabel('term', 'terminal')).toBe('Terminal');
  });
});

describe('allowedModesFor', () => {
  it('offers Raw, Split then Draw for a whiteboard, and never Edit/Read', () => {
    // Split is the source beside the board; Edit would mangle the XML and
    // Read has nothing to render a drawing as.
    expect(allowedModesFor('svg')).toEqual(['raw', 'split', 'draw']);
    expect(isModeAllowed('svg', 'split')).toBe(true);
    expect(isModeAllowed('svg', 'wysiwyg')).toBe(false);
    expect(isModeAllowed('svg', 'read')).toBe(false);
  });

  it('leaves the markdown modes exactly as they were, with no Draw', () => {
    expect(allowedModesFor('markdown')).toEqual(['raw', 'split', 'wysiwyg', 'read']);
  });
});

describe('defaultModeFor', () => {
  it('keeps a preference the family supports', () => {
    expect(defaultModeFor('svg', 'raw')).toBe('raw');
    expect(defaultModeFor('markdown', 'read')).toBe('read');
  });

  it('self-heals a mode from the other family', () => {
    // The manifest never validates `mode`, so both directions must degrade.
    expect(defaultModeFor('svg', 'read')).toBe('draw');
    expect(defaultModeFor('svg', 'wysiwyg')).toBe('draw');
    expect(defaultModeFor('markdown', 'draw')).toBe('raw');
  });

  it('opens a drawing in Draw even though Raw and Split come first in the strip', () => {
    // Segment ORDER and the default are separate tables on purpose.
    expect(defaultModeFor('svg', 'split')).toBe('split');
    expect(allowedModesFor('svg')[0]).toBe('raw');
  });
});

describe('the terminal family', () => {
  it('is keyed on the TAB, since a terminal has no path to key on', () => {
    expect(docFamilyForTab({ kind: 'terminal', filePath: null, notePath: null })).toBe('terminal');
    expect(docFamilyForTab({ kind: 'file', filePath: '/notes/board.svg' })).toBe('svg');
    expect(docFamilyForTab({ kind: 'note', notePath: '/notes/todo.md' })).toBe('markdown');
  });

  it('offers exactly one mode, so the picker and mod+1..4 filter it out', () => {
    expect(allowedModesFor('terminal')).toEqual(['term']);
    expect(isModeAllowed('terminal', 'term')).toBe(true);
    expect(isModeAllowed('terminal', 'raw')).toBe(false);
    expect(isModeAllowed('markdown', 'term')).toBe(false);
    expect(isModeAllowed('svg', 'term')).toBe(false);
  });

  it('self-heals a stale mode from a manifest', () => {
    expect(defaultModeFor('terminal', 'raw')).toBe('term');
    expect(defaultModeFor('markdown', 'term')).toBe('raw');
    expect(defaultModeFor('svg', 'term')).toBe('draw');
  });
});

describe('the tool family (the git tab)', () => {
  it('is what a git tab is, whatever else the tab carries', () => {
    expect(docFamilyForTab({ kind: 'git' })).toBe('tool');
    expect(docFamilyForTab({ kind: 'git', filePath: '/repo/a.md', deck: true })).toBe('tool');
    // A terminal is still its own family — the two differ in chrome.
    expect(docFamilyForTab({ kind: 'terminal' })).toBe('terminal');
  });

  it('offers exactly one mode, labelled Git, and self-heals every other mode to it', () => {
    expect(allowedModesFor('tool')).toEqual(['tool']);
    expect(defaultModeFor('tool', 'raw')).toBe('tool');
    expect(defaultModeFor('tool', 'term')).toBe('tool');
    expect(isModeAllowed('tool', 'read')).toBe(false);
    expect(isModeAllowed('tool', 'tool')).toBe(true);
    expect(modeLabel('tool', 'tool')).toBe('Git');
    // And no other family ever offers it.
    expect(isModeAllowed('markdown', 'tool')).toBe(false);
    expect(isModeAllowed('terminal', 'tool')).toBe(false);
  });
});
