import { describe, expect, test, vi } from 'vitest';
import {
  executeFlushPlan,
  parseManifest,
  planFlush,
  relativePath,
  toAbsolutePath,
  type AppSessionView,
  type FlushIo,
  type SessionTabView,
} from '../session/plan-flush';

function tab(partial: Partial<SessionTabView> & { id: string }): SessionTabView {
  return {
    kind: 'note',
    notePath: null,
    filePath: null,
    customTitle: null,
    title: 'Untitled',
    text: '',
    mode: 'raw',
    sessionDirty: false,
    fileDirty: false,
    savedMtimeMs: null,
    liveEdit: null,
    cursor: null,
    ...partial,
  };
}

function view(partial?: Partial<AppSessionView>): AppSessionView {
  return {
    notesDir: '/notes',
    sessionDir: '/session',
    activeTabId: null,
    tabs: [],
    existingNoteFiles: [],
    closedNotePaths: [],
    obsoleteBufferPaths: [],
    ...partial,
  };
}

describe('planFlush — note tabs', () => {
  test('a new note with content gets a slugged path and a write', () => {
    const plan = planFlush(
      view({
        tabs: [tab({ id: 't1', title: 'Buy Milk!', text: '# Buy Milk!', sessionDirty: true })],
      }),
    );
    expect(plan.writes).toEqual([{ path: '/notes/buy-milk.md', text: '# Buy Milk!' }]);
    expect(plan.assignedNotePaths).toEqual({ t1: '/notes/buy-milk.md' });
    expect(plan.manifest.tabs[0]?.notePath).toBe('/notes/buy-milk.md');
  });

  test('a new EMPTY note creates no file (empty tabs cost nothing)', () => {
    const plan = planFlush(view({ tabs: [tab({ id: 't1', sessionDirty: true })] }));
    expect(plan.writes).toEqual([]);
    expect(plan.assignedNotePaths).toEqual({});
    expect(plan.manifest.tabs[0]?.notePath).toBeNull();
  });

  test('two new notes with the same title get collision suffixes', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({ id: 't1', title: 'Idea', text: 'a', sessionDirty: true }),
          tab({ id: 't2', title: 'Idea', text: 'b', sessionDirty: true }),
        ],
      }),
    );
    expect(plan.writes.map((w) => w.path)).toEqual(['/notes/idea.md', '/notes/idea-2.md']);
  });

  test('a new note never clobbers an on-disk file no tab owns', () => {
    const plan = planFlush(
      view({
        existingNoteFiles: ['idea.md'],
        tabs: [tab({ id: 't1', title: 'Idea', text: 'x', sessionDirty: true })],
      }),
    );
    expect(plan.writes[0]?.path).toBe('/notes/idea-2.md');
  });

  test('collision checks are case-insensitive (Windows/macOS filesystems)', () => {
    const plan = planFlush(
      view({
        existingNoteFiles: ['Idea.md'],
        tabs: [tab({ id: 't1', title: 'idea', text: 'x', sessionDirty: true })],
      }),
    );
    expect(plan.writes[0]?.path).toBe('/notes/idea-2.md');
  });

  test('a dirty existing note writes to its current path — no rename when slug is unchanged', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/idea.md',
            title: 'Idea',
            text: 'updated',
            sessionDirty: true,
          }),
        ],
      }),
    );
    expect(plan.noteRenames).toEqual([]);
    expect(plan.writes).toEqual([{ path: '/notes/idea.md', text: 'updated' }]);
  });

  test('a clean existing note produces no operations at all', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 't1', notePath: '/notes/idea.md', title: 'Idea', text: 'x' })] }),
    );
    expect(plan.noteRenames).toEqual([]);
    expect(plan.writes).toEqual([]);
  });

  test('a title change plans a lazy rename; manifest points at the NEW path', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/idea.md',
            title: 'Grand Plan',
            text: 'body',
            sessionDirty: true,
          }),
        ],
      }),
    );
    expect(plan.noteRenames).toEqual([{ from: '/notes/idea.md', to: '/notes/grand-plan.md' }]);
    expect(plan.writes).toEqual([{ path: '/notes/grand-plan.md', text: 'body' }]);
    expect(plan.manifest.tabs[0]?.notePath).toBe('/notes/grand-plan.md');
  });

  test('rename-only flush when the title changed but content did not', () => {
    const plan = planFlush(
      view({
        tabs: [tab({ id: 't1', notePath: '/notes/idea.md', title: 'Renamed', text: 'x' })],
      }),
    );
    expect(plan.noteRenames).toEqual([{ from: '/notes/idea.md', to: '/notes/renamed.md' }]);
    expect(plan.writes).toEqual([]);
  });

  test('a rename target avoids other tabs and disk files', () => {
    const plan = planFlush(
      view({
        existingNoteFiles: ['taken.md'],
        tabs: [tab({ id: 't1', notePath: '/notes/other.md', title: 'Taken', text: 'x' })],
      }),
    );
    expect(plan.noteRenames).toEqual([{ from: '/notes/other.md', to: '/notes/taken-2.md' }]);
  });

  test('a tab whose name already matches its slug is not renamed to itself', () => {
    const plan = planFlush(
      view({
        existingNoteFiles: ['idea.md'], // the tab's own file also shows up in the listing
        tabs: [tab({ id: 't1', notePath: '/notes/idea.md', title: 'Idea', text: 'x' })],
      }),
    );
    expect(plan.noteRenames).toEqual([]);
  });

  test('a suppressed rename is skipped; the file keeps its current name', () => {
    const plan = planFlush(
      view({
        suppressedRenamePaths: new Set(['/notes/idea.md']),
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/idea.md',
            title: 'Grand Plan',
            text: 'body',
            sessionDirty: true,
          }),
        ],
      }),
    );
    // No rename planned, and the content write goes to the OLD path…
    expect(plan.noteRenames).toEqual([]);
    expect(plan.writes).toEqual([{ path: '/notes/idea.md', text: 'body' }]);
    // …and the manifest keeps pointing at the current name.
    expect(plan.manifest.tabs[0]?.notePath).toBe('/notes/idea.md');
  });

  test('suppressing one rename leaves its slug free for another tab', () => {
    const plan = planFlush(
      view({
        suppressedRenamePaths: new Set(['/notes/idea.md']),
        tabs: [
          // t1 wants to become grand-plan.md but is suppressed → stays idea.md.
          tab({ id: 't1', notePath: '/notes/idea.md', title: 'Grand Plan', text: 'a' }),
          // t2 is a fresh note that also slugs to grand-plan; the freed name is
          // available to it (no -2 suffix).
          tab({ id: 't2', title: 'Grand Plan', text: 'b', sessionDirty: true }),
        ],
      }),
    );
    expect(plan.noteRenames).toEqual([]);
    expect(plan.assignedNotePaths).toEqual({ t2: '/notes/grand-plan.md' });
  });

  test('a name being renamed away from stays taken — the rename may fail and leave the file there', () => {
    // t1 retitled "Idea" → "Grand Plan"; t2 is a new note titled "Idea". If
    // t1's rename fails (tolerated: its writes go back to idea.md), giving t2
    // idea.md would make both tabs write the same file.
    const plan = planFlush(
      view({
        existingNoteFiles: ['idea.md'],
        tabs: [
          tab({ id: 't1', notePath: '/notes/idea.md', title: 'Grand Plan', text: 'old note' }),
          tab({ id: 't2', title: 'Idea', text: 'new note', sessionDirty: true }),
        ],
      }),
    );
    expect(plan.noteRenames).toEqual([{ from: '/notes/idea.md', to: '/notes/grand-plan.md' }]);
    expect(plan.assignedNotePaths).toEqual({ t2: '/notes/idea-2.md' });
  });

  test('a failed rename followed by a new note with the old title never overwrites the old file', async () => {
    // End to end through the executor, rename failing as a sync-tool lock would.
    const files = new Map<string, string>([['/notes/idea.md', 'old note']]);
    const io: FlushIo = {
      atomicWriteText: async (path, text) => {
        files.set(path, text);
      },
      renamePath: async () => {
        throw new Error('EBUSY: locked by the sync client');
      },
      deletePath: async (path) => {
        files.delete(path);
      },
    };
    const plan = planFlush(
      view({
        existingNoteFiles: ['idea.md'],
        tabs: [
          tab({ id: 't1', notePath: '/notes/idea.md', title: 'Grand Plan', text: 'old note' }),
          tab({ id: 't2', title: 'Idea', text: 'new note', sessionDirty: true }),
        ],
      }),
    );
    await executeFlushPlan(plan, io);
    expect(files.get('/notes/idea.md')).toBe('old note');
  });
});

describe('planFlush — deletes never hit a live path', () => {
  test('a tombstoned note path a file tab now points to is NOT deleted (Save As onto its own name)', () => {
    const plan = planFlush(
      view({
        closedNotePaths: ['/notes/idea.md'],
        tabs: [tab({ id: 't1', kind: 'file', filePath: '/notes/idea.md', text: 'x' })],
      }),
    );
    expect(plan.deletes).toEqual([]);
  });

  test('the comparison ignores separator style and case (Windows dialog paths)', () => {
    const plan = planFlush(
      view({
        notesDir: 'C:\\Users\\me\\notes',
        closedNotePaths: ['C:\\Users\\me\\notes/idea.md'],
        tabs: [tab({ id: 't1', kind: 'file', filePath: 'c:\\users\\me\\notes\\Idea.md' })],
      }),
    );
    expect(plan.deletes).toEqual([]);
  });

  test('a path this plan writes is not deleted by it (buffer re-dirtied after a save)', () => {
    const plan = planFlush(
      view({
        obsoleteBufferPaths: ['/session/buffers/f1.md'],
        tabs: [
          tab({
            id: 'f1',
            kind: 'file',
            filePath: '/docs/a.md',
            text: 'typed during the save',
            sessionDirty: true,
            fileDirty: true,
          }),
        ],
      }),
    );
    expect(plan.writes.map((w) => w.path)).toEqual(['/session/buffers/f1.md']);
    expect(plan.deletes).toEqual([]);
  });

  test('a tombstone no tab points to is still deleted', () => {
    const plan = planFlush(
      view({
        closedNotePaths: ['/notes/idea.md'],
        tabs: [tab({ id: 't1', kind: 'file', filePath: '/docs/idea.md', text: 'x' })],
      }),
    );
    expect(plan.deletes).toEqual(['/notes/idea.md']);
  });
});

describe('planFlush — file tabs, deletes, manifest', () => {
  test('a dirty file tab writes a session buffer and is flagged hasBuffer', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 'f1',
            kind: 'file',
            filePath: 'C:/docs/readme.md',
            text: 'unsaved edits',
            sessionDirty: true,
            fileDirty: true,
            savedMtimeMs: 111,
          }),
        ],
      }),
    );
    expect(plan.writes).toEqual([{ path: '/session/buffers/f1.md', text: 'unsaved edits' }]);
    expect(plan.manifest.tabs[0]).toMatchObject({
      kind: 'file',
      filePath: 'C:/docs/readme.md',
      hasBuffer: true,
      savedMtimeMs: 111,
    });
  });

  test('a clean file tab gets no buffer and hasBuffer=false', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 'f1', kind: 'file', filePath: 'C:/docs/readme.md', text: 'x' })] }),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.manifest.tabs[0]?.hasBuffer).toBe(false);
  });

  test('closed notes and obsolete buffers become deletes', () => {
    const plan = planFlush(
      view({
        closedNotePaths: ['/notes/discarded.md'],
        obsoleteBufferPaths: ['/session/buffers/gone.md'],
      }),
    );
    expect(plan.deletes).toEqual(['/notes/discarded.md', '/session/buffers/gone.md']);
  });

  test('manifest carries tab order, active tab, modes and cursors', () => {
    const plan = planFlush(
      view({
        activeTabId: 't2',
        tabs: [
          tab({ id: 't1', notePath: '/notes/a.md', title: 'A', text: 'a', mode: 'split' }),
          tab({
            id: 't2',
            notePath: '/notes/b.md',
            title: 'B',
            text: 'b',
            mode: 'wysiwyg',
            customTitle: 'B',
            cursor: { anchor: 3, head: 7 },
          }),
        ],
      }),
    );
    expect(plan.manifest).toMatchObject({
      schema: 1,
      activeTabId: 't2',
      tabs: [
        { id: 't1', mode: 'split' },
        { id: 't2', mode: 'wysiwyg', customTitle: 'B', cursor: { anchor: 3, head: 7 } },
      ],
    });
    expect(plan.manifestPath).toBe('/session/session.json');
  });
});

describe('executeFlushPlan', () => {
  function fakeIo() {
    const ops: string[] = [];
    const io: FlushIo = {
      atomicWriteText: vi.fn(async (path: string) => {
        ops.push(`write:${path}`);
      }),
      renamePath: vi.fn(async (from: string, to: string) => {
        ops.push(`rename:${from}->${to}`);
      }),
      deletePath: vi.fn(async (path: string) => {
        ops.push(`delete:${path}`);
      }),
    };
    return { ops, io };
  }

  test('executes renames → writes → deletes → manifest LAST (invariant I4)', async () => {
    const { ops, io } = fakeIo();
    const plan = planFlush(
      view({
        closedNotePaths: ['/notes/old.md'],
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/a.md',
            title: 'Renamed',
            text: 'body',
            sessionDirty: true,
          }),
        ],
      }),
    );
    await executeFlushPlan(plan, io);
    expect(ops).toEqual([
      'rename:/notes/a.md->/notes/renamed.md',
      'write:/notes/renamed.md',
      'delete:/notes/old.md',
      'write:/session/session.json',
    ]);
  });

  test('a failed rename is tolerated: write redirected, manifest patched, failure reported', async () => {
    const { io } = fakeIo();
    vi.mocked(io.renamePath).mockRejectedValueOnce(new Error('EXISTS: sync tool lock'));
    const written = new Map<string, string>();
    vi.mocked(io.atomicWriteText).mockImplementation(async (path, text) => {
      written.set(path, text);
    });

    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/a.md',
            title: 'Renamed',
            text: 'body',
            sessionDirty: true,
          }),
        ],
      }),
    );
    const result = await executeFlushPlan(plan, io);

    expect(result.renameFailures).toEqual([{ from: '/notes/a.md', to: '/notes/renamed.md' }]);
    // The note write went back to the OLD path…
    expect(written.get('/notes/a.md')).toBe('body');
    expect(written.has('/notes/renamed.md')).toBe(false);
    // …and the manifest references the old path too, never a phantom file.
    const manifest = JSON.parse(written.get('/session/session.json') ?? '{}');
    expect(manifest.tabs[0].notePath).toBe('/notes/a.md');
  });

  test('a failed write aborts the flush BEFORE the manifest is touched', async () => {
    const { ops, io } = fakeIo();
    vi.mocked(io.atomicWriteText).mockRejectedValueOnce(new Error('disk full'));
    const plan = planFlush(
      view({ tabs: [tab({ id: 't1', title: 'A', text: 'a', sessionDirty: true })] }),
    );
    await expect(executeFlushPlan(plan, io)).rejects.toThrow('disk full');
    expect(ops.filter((op) => op.includes('session.json'))).toEqual([]);
  });
});

describe('planFlush — terminal tabs', () => {
  const snapshot = {
    tree: { kind: 'leaf' as const, id: 'p1' },
    activePaneId: 'p1',
    panes: [{ id: 'p1', profileId: 'shell', cwd: '/work' }],
  };

  test('a terminal tab produces no writes and no buffer, ever', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 't1',
            kind: 'terminal',
            mode: 'term',
            title: 'System shell',
            // Even claiming to be dirty: a terminal holds no document, so
            // there is nothing a flush could write for it.
            sessionDirty: true,
            fileDirty: true,
            terminal: snapshot,
          }),
        ],
      }),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.noteRenames).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.assignedNotePaths).toEqual({});
    expect(plan.manifest.tabs[0]).toMatchObject({ hasBuffer: false, notePath: null });
  });

  test('the pane layout round-trips through the manifest', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 't1', kind: 'terminal', mode: 'term', terminal: snapshot })] }),
    );
    const parsed = parseManifest(JSON.stringify(plan.manifest));
    expect(parsed!.tabs[0]?.terminal).toEqual(snapshot);
  });

  test('a Live Edit override round-trips; null leaves no key behind', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({ id: 'on', kind: 'file', filePath: '/d/a.md', liveEdit: true }),
          tab({ id: 'off', kind: 'file', filePath: '/d/b.md', liveEdit: false }),
          tab({ id: 'follow', kind: 'file', filePath: '/d/c.md', liveEdit: null }),
        ],
      }),
    );
    const parsed = parseManifest(JSON.stringify(plan.manifest))!;
    expect(parsed.tabs.map((t) => t.liveEdit)).toEqual([true, false, undefined]);
    expect(plan.manifest.tabs[2] && 'liveEdit' in plan.manifest.tabs[2]).toBe(false);
  });

  test('no layout recorded = no `terminal` key (nothing to respawn)', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 't1', kind: 'terminal', mode: 'term', terminal: null })] }),
    );
    expect(plan.manifest.tabs[0] && 'terminal' in plan.manifest.tabs[0]).toBe(false);
  });
});

describe('planFlush — git tabs', () => {
  const git = { root: 'C:/code/proj', checkout: 'C:/code/proj/worktrees/feat-x' };

  test('a git tab writes nothing — only its repository rides the manifest', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 'g1',
            kind: 'git',
            mode: 'tool',
            title: 'Git: proj',
            sessionDirty: true,
            fileDirty: true,
            git,
          }),
        ],
      }),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.noteRenames).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.assignedNotePaths).toEqual({});
    expect(plan.manifest.tabs[0]).toMatchObject({
      kind: 'git',
      hasBuffer: false,
      notePath: null,
      filePath: null,
      git,
    });
    const parsed = parseManifest(JSON.stringify(plan.manifest));
    expect(parsed!.tabs[0]?.git).toEqual(git);
  });

  test('a git tab with no repository recorded leaves no `git` key', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 'g1', kind: 'git', mode: 'tool', git: null })] }),
    );
    expect(plan.manifest.tabs[0] && 'git' in plan.manifest.tabs[0]).toBe(false);
  });
});

describe('parseManifest', () => {
  test('round-trips a planned manifest', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 't1', title: 'A', text: 'a', sessionDirty: true })] }),
    );
    const parsed = parseManifest(JSON.stringify(plan.manifest));
    expect(parsed).toEqual(plan.manifest);
  });

  test('rejects garbage and the wrong schema', () => {
    expect(parseManifest('not json at all {{{')).toBeNull();
    expect(parseManifest('null')).toBeNull();
    expect(parseManifest(JSON.stringify({ schema: 2, tabs: [] }))).toBeNull();
    expect(parseManifest(JSON.stringify({ schema: 1, tabs: 'nope' }))).toBeNull();
  });

  test('drops malformed and unknown-kind tabs instead of condemning the manifest', () => {
    const parsed = parseManifest(
      JSON.stringify({
        schema: 1,
        activeTabId: 'a',
        tabs: [
          { id: 'a', kind: 'note' },
          { id: 42, kind: 'note' },
          { id: 'b', kind: 'nope' },
          'not even an object',
          null,
          { id: 'c', kind: 'file' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.tabs.map((t) => t.id)).toEqual(['a', 'c']);
  });

  test('a manifest carrying a retired `groups` key still parses', () => {
    const parsed = parseManifest(
      JSON.stringify({
        schema: 1,
        activeTabId: null,
        tabs: [{ id: 'a', kind: 'note' }],
        groups: [{ id: 'g1', name: 'gone', color: 'blue', collapsed: false }],
      }),
    );
    // Tab groups were removed in favor of workspace grouping; an old manifest
    // is not condemned by the leftover key, its tabs just come back ungrouped.
    expect(parsed).not.toBeNull();
    expect(parsed!.tabs.map((t) => t.id)).toEqual(['a']);
  });

  test("a handover manifest keeps each terminal pane's live pty id", () => {
    // A tab dragged into a new window travels as a manifest in the `?adopt=`
    // URL, and the receiving window parses it with this function. Losing
    // `ptyId` on the way would silently respawn the shell instead of
    // attaching to it — the bug this field exists to fix.
    const parsed = parseManifest(
      JSON.stringify({
        schema: 1,
        activeTabId: 't1',
        tabs: [
          {
            id: 't1',
            kind: 'terminal',
            terminal: {
              tree: { type: 'leaf', id: 'p1' },
              activePaneId: 'p1',
              panes: [{ id: 'p1', profileId: 'shell', cwd: '/work', ptyId: 12 }],
            },
          },
        ],
      }),
    );
    expect(parsed!.tabs[0]?.terminal?.panes[0]?.ptyId).toBe(12);
  });
});

describe('relativePath', () => {
  test('descends into a subdirectory (explicit ./ prefix)', () => {
    expect(relativePath('/notes', '/notes/images/pic.png')).toBe('./images/pic.png');
  });

  test('same directory yields ./name', () => {
    expect(relativePath('/notes', '/notes/other.md')).toBe('./other.md');
  });

  test('ascends with ../ for a sibling directory', () => {
    expect(relativePath('/notes/sub', '/notes/other.md')).toBe('../other.md');
    expect(relativePath('/a/b/c', '/a/x/y.md')).toBe('../../x/y.md');
  });

  test('normalizes Windows backslashes and drive letters to forward slashes', () => {
    expect(relativePath('C:\\Users\\me\\notes', 'C:\\Users\\me\\pics\\a.png')).toBe(
      '../pics/a.png',
    );
    expect(relativePath('C:\\Users\\me\\notes', 'C:\\Users\\me\\notes\\a.png')).toBe('./a.png');
  });

  test('treats drive letters case-insensitively (same root)', () => {
    expect(relativePath('c:/users/me', 'C:/users/me/x.png')).toBe('./x.png');
  });

  test('returns null across different drives (no relative path exists)', () => {
    expect(relativePath('C:\\Users\\me', 'D:\\media\\a.png')).toBeNull();
  });

  test('returns . when the target IS the directory', () => {
    expect(relativePath('/notes', '/notes')).toBe('.');
  });
});

describe('toAbsolutePath', () => {
  test('joins a relative target onto a POSIX base dir', () => {
    expect(toAbsolutePath('/notes', 'pics/a.png')).toBe('/notes/pics/a.png');
    expect(toAbsolutePath('/notes', './pics/a.png')).toBe('/notes/pics/a.png');
  });

  test('collapses ../ segments', () => {
    expect(toAbsolutePath('/notes/sub', '../a.png')).toBe('/notes/a.png');
    expect(toAbsolutePath('/a/b/c', '../../x/y.png')).toBe('/a/x/y.png');
  });

  test('resolves against a Windows drive base, forward-slashed', () => {
    expect(toAbsolutePath('C:\\Users\\me\\notes', 'pics\\a.png')).toBe(
      'C:/Users/me/notes/pics/a.png',
    );
    expect(toAbsolutePath('C:\\Users\\me\\notes', '..\\shared\\a.png')).toBe(
      'C:/Users/me/shared/a.png',
    );
  });

  test('an already-absolute target is returned normalized, ignoring the base', () => {
    expect(toAbsolutePath('/notes', '/other/a.png')).toBe('/other/a.png');
    expect(toAbsolutePath('/notes', 'D:\\media\\a.png')).toBe('D:/media/a.png');
  });

  test('no absolute base (unsaved doc) yields a normalized relative path', () => {
    expect(toAbsolutePath('', './pics/a.png')).toBe('pics/a.png');
  });

  test('a synced-folder saf:// id is an opaque root that round-trips', () => {
    const saf = 'saf://content%3A%2F%2Ftree%2Fabc';
    // Absolute saf src (what the importer/paste write): returned untouched.
    expect(toAbsolutePath(`${saf}/notes`, `${saf}/notes/images/a.png`)).toBe(
      `${saf}/notes/images/a.png`,
    );
    // Relative src inside a saf note resolves onto the same tree.
    expect(toAbsolutePath(`${saf}/notes`, 'images/a.png')).toBe(`${saf}/notes/images/a.png`);
    // ../ traversal stays within the saf root.
    expect(toAbsolutePath(`${saf}/notes/sub`, '../images/a.png')).toBe(`${saf}/notes/images/a.png`);
  });
});
