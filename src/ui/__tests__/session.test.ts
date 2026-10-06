/**
 * @vitest-environment jsdom
 *
 * Exercises the session controller's flush + restore orchestration against an
 * in-memory fake `ipc` injected through the factory. The pure planning/exec
 * logic is covered in core/__tests__/plan-flush.test.ts; here we test the
 * glue: view assembly from the live stores, applying results back, dirty
 * clearing, tombstone sweeping, and restore/self-heal.
 *
 * The tabs store is a module singleton that self-creates its first tab at
 * import time, so we reset the module registry before each test and re-import
 * session + stores together (shared registry → shared singleton).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const NOTES = '/notes';
const SESSION = '/session';

interface FakeFs {
  files: Map<string, string>;
  /** path → mtime; bumped on every write, independent of the `files` content. */
  mtimes: Map<string, number>;
  ops: string[];
  ipc: {
    atomicWriteText: (path: string, text: string) => Promise<void>;
    readTextFile: (path: string) => Promise<{ text: string; mtimeMs: number }>;
    renamePath: (from: string, to: string) => Promise<void>;
    deletePath: (path: string) => Promise<void>;
    listNotes: (dir: string) => Promise<{ path: string; mtimeMs: number; size: number }[]>;
    listDir: (
      dir: string,
    ) => Promise<{ path: string; isDir: boolean; mtimeMs: number; size: number }[]>;
    readFileBase64: (path: string) => Promise<string>;
    writeFileBase64: (path: string, data: string) => Promise<void>;
    copyPath: (from: string, to: string) => Promise<void>;
    createDir: (path: string) => Promise<void>;
    statPath: (path: string) => Promise<{ exists: boolean; mtimeMs: number | null }>;
  };
  dirs: Set<string>;
}

let IpcError: typeof import('../../ipc/commands').IpcError;

function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  const mtimes = new Map<string, number>([...files.keys()].map((p) => [p, 1]));
  const ops: string[] = [];
  const dirs = new Set<string>();
  let clock = 1;
  const dirname = (p: string) => p.slice(0, p.lastIndexOf('/'));
  return {
    files,
    mtimes,
    ops,
    dirs,
    ipc: {
      async atomicWriteText(path, text) {
        ops.push(`write:${path}`);
        files.set(path, text);
        mtimes.set(path, ++clock);
      },
      async readTextFile(path) {
        if (!files.has(path)) {
          throw new IpcError('NOT_FOUND', path);
        }
        return { text: files.get(path)!, mtimeMs: mtimes.get(path) ?? 1 };
      },
      async renamePath(from, to) {
        ops.push(`rename:${from}->${to}`);
        if (dirs.has(from)) {
          // Directory rename: move the dir entry and every file under it.
          if (dirs.has(to) || files.has(to)) {
            throw new IpcError('EXISTS', to);
          }
          dirs.delete(from);
          dirs.add(to);
          for (const p of [...files.keys()]) {
            if (p.startsWith(`${from}/`)) {
              const moved = to + p.slice(from.length);
              files.set(moved, files.get(p)!);
              mtimes.set(moved, mtimes.get(p) ?? 1);
              files.delete(p);
              mtimes.delete(p);
            }
          }
          return;
        }
        if (!files.has(from)) {
          throw new IpcError('NOT_FOUND', from);
        }
        if (files.has(to)) {
          throw new IpcError('EXISTS', to);
        }
        files.set(to, files.get(from)!);
        mtimes.set(to, mtimes.get(from) ?? 1);
        files.delete(from);
        mtimes.delete(from);
      },
      async deletePath(path) {
        ops.push(`delete:${path}`);
        if (dirs.has(path)) {
          // Folder delete: drop the dir plus every file/subdir under it,
          // mirroring the backend's recursive remove_dir_all.
          dirs.delete(path);
          for (const p of [...files.keys()]) {
            if (p.startsWith(`${path}/`)) {
              files.delete(p);
              mtimes.delete(p);
            }
          }
          for (const d of [...dirs]) {
            if (d.startsWith(`${path}/`)) {
              dirs.delete(d);
            }
          }
          return;
        }
        files.delete(path);
        mtimes.delete(path);
      },
      async listNotes(dir) {
        return [...files.keys()]
          .filter((p) => dirname(p) === dir && p.endsWith('.md'))
          .map((p) => ({ path: p, mtimeMs: mtimes.get(p) ?? 1, size: files.get(p)!.length }));
      },
      async listDir(dir) {
        // The fake fs has no real directories; explorer entries are files only.
        return [...files.keys()]
          .filter((p) => dirname(p) === dir)
          .map((p) => ({
            path: p,
            isDir: false,
            mtimeMs: mtimes.get(p) ?? 1,
            size: files.get(p)!.length,
          }));
      },
      async readFileBase64(path) {
        if (!files.has(path)) {
          throw new IpcError('NOT_FOUND', path);
        }
        return btoa(files.get(path)!);
      },
      async writeFileBase64(path, data) {
        ops.push(`writeb64:${path}`);
        files.set(path, atob(data));
        mtimes.set(path, ++clock);
      },
      async copyPath(from, to) {
        ops.push(`copy:${from}->${to}`);
        if (!files.has(from)) {
          throw new IpcError('NOT_FOUND', from);
        }
        if (files.has(to)) {
          throw new IpcError('EXISTS', to);
        }
        files.set(to, files.get(from)!);
        mtimes.set(to, ++clock);
      },
      async createDir(path) {
        ops.push(`mkdir:${path}`);
        if (dirs.has(path) || files.has(path)) {
          throw new IpcError('EXISTS', path);
        }
        dirs.add(path);
      },
      async statPath(path) {
        return files.has(path) || dirs.has(path)
          ? { exists: true, mtimeMs: mtimes.get(path) ?? 1 }
          : { exists: false, mtimeMs: null };
      },
    },
  };
}

type SessionModule = typeof import('../session');
type TabsModule = typeof import('../stores/tabs');

let session: SessionModule;
let tabs: TabsModule;

beforeEach(async () => {
  // Fake timers so the debounced flusher's trailing/maxWait timers never fire
  // on their own — every test drives persistence explicitly via flushNow().
  vi.useFakeTimers();
  vi.resetModules();
  IpcError = (await import('../../ipc/commands')).IpcError;
  session = await import('../session');
  tabs = await import('../stores/tabs');
});

afterEach(() => {
  vi.useRealTimers();
});

function makeController(
  fs: FakeFs,
  now = () => 111,
  extra: Partial<Parameters<typeof session.createSessionController>[0]> = {},
) {
  return session.createSessionController({
    paths: { notesDir: NOTES, sessionDir: SESSION },
    ipc: fs.ipc,
    now,
    ...extra,
  });
}

describe('flushSession — writing', () => {
  test('a new note becomes a slugged file and the manifest is written LAST', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Buy milk', 'cm6');

    await controller.flushNow();

    expect(fs.files.get(`${NOTES}/buy-milk.md`)).toBe('# Buy milk');
    // Manifest last (invariant I4): the note file is written before session.json.
    const noteIdx = fs.ops.indexOf(`write:${NOTES}/buy-milk.md`);
    const manifestIdx = fs.ops.indexOf(`write:${SESSION}/session.json`);
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(manifestIdx).toBeGreaterThan(noteIdx);
  });

  test('the assigned note path lands back on the tab and the model goes clean', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('shopping', 'cm6');

    await controller.flushNow();

    const after = tabs.tabsStore.getState().tabs[0]!;
    expect(after.notePath).toBe(`${NOTES}/shopping.md`);
    expect(after.model.isDirty('session')).toBe(false);
  });

  test('an empty new note creates no file', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    tabs.tabsStore.getState().newTab(); // second empty tab
    await controller.flushNow();
    expect([...fs.files.keys()].filter((p) => p.startsWith(NOTES))).toEqual([]);
  });

  test('a title change renames the note on the next flush; the old file is gone', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Buy milk', 'cm6');
    await controller.flushNow();
    expect(fs.files.has(`${NOTES}/buy-milk.md`)).toBe(true);

    t.model.pushText('# Weekend plan', 'cm6');
    await controller.flushNow();

    expect(fs.files.has(`${NOTES}/buy-milk.md`)).toBe(false);
    expect(fs.files.get(`${NOTES}/weekend-plan.md`)).toBe('# Weekend plan');
    expect(tabs.tabsStore.getState().tabs[0]!.notePath).toBe(`${NOTES}/weekend-plan.md`);
  });

  test('two notes with the same title get collision suffixes', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const first = tabs.tabsStore.getState().tabs[0]!;
    first.model.pushText('Idea', 'cm6');
    tabs.tabsStore.getState().newTab();
    const second = tabs.tabsStore.getState().tabs[1]!;
    second.model.pushText('Idea', 'cm6');

    await controller.flushNow();

    expect(fs.files.has(`${NOTES}/idea.md`)).toBe(true);
    expect(fs.files.has(`${NOTES}/idea-2.md`)).toBe(true);
  });
});

describe('flushSession — discarding a note tab', () => {
  test('closing a note tab deletes its file on the next flush', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('to delete', 'cm6');
    await controller.flushNow();
    const notePath = tabs.tabsStore.getState().tabs[0]!.notePath!;
    expect(fs.files.has(notePath)).toBe(true);

    tabs.tabsStore.getState().closeTab(t.id);
    await controller.flushNow();

    expect(fs.files.has(notePath)).toBe(false);
    // Tombstone consumed.
    expect(tabs.tabsStore.getState().closedNotePaths).toEqual([]);
  });
});

describe('flushSession — live save', () => {
  async function openDirtyFileTab(text: string) {
    const id = tabs.tabsStore
      .getState()
      .openFileTab({ filePath: '/docs/report.md', text: 'saved', savedMtimeMs: 1 });
    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    tab.model.pushText(text, 'cm6');
    return id;
  }

  test('off (default): the flush buffers the edits, the file itself is untouched', async () => {
    const fs = makeFakeFs({ '/docs/report.md': 'saved' });
    const controller = makeController(fs);
    const id = await openDirtyFileTab('edited');

    await controller.flushNow();

    expect(fs.files.get('/docs/report.md')).toBe('saved');
    expect(fs.files.get(`${SESSION}/buffers/${id}.md`)).toBe('edited');
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.dirty).toBe(true);
  });

  test('on: a dirty file tab is written to its own path and comes out clean, no buffer', async () => {
    const fs = makeFakeFs({ '/docs/report.md': 'saved' });
    const controller = makeController(fs);
    const settings = await import('../stores/settings');
    settings.settingsStore.getState().update({ liveSave: true });
    const id = await openDirtyFileTab('edited');

    await controller.flushNow();

    expect(fs.files.get('/docs/report.md')).toBe('edited');
    expect(fs.files.has(`${SESSION}/buffers/${id}.md`)).toBe(false);
    const after = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(after.dirty).toBe(false);
    // The mtime baseline advanced to the new write, so no false conflict later.
    expect(after.savedMtimeMs).toBe(fs.mtimes.get('/docs/report.md'));
  });

  test('on: a file changed on disk is NOT clobbered — conflict flagged, edits buffered', async () => {
    const fs = makeFakeFs({ '/docs/report.md': 'theirs' });
    fs.mtimes.set('/docs/report.md', 5); // external change vs the tab's baseline of 1
    const controller = makeController(fs);
    const settings = await import('../stores/settings');
    settings.settingsStore.getState().update({ liveSave: true });
    const id = await openDirtyFileTab('mine');

    await controller.flushNow();

    expect(fs.files.get('/docs/report.md')).toBe('theirs');
    const after = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(after.conflict).toBe(true);
    expect(after.dirty).toBe(true);
    // The edits stayed crash-safe in the session buffer.
    expect(fs.files.get(`${SESSION}/buffers/${id}.md`)).toBe('mine');

    // A later flush skips the conflicted tab instead of retrying (and spamming).
    const writesBefore = fs.ops.filter((op) => op === 'write:/docs/report.md').length;
    await controller.flushNow();
    expect(fs.files.get('/docs/report.md')).toBe('theirs');
    expect(fs.ops.filter((op) => op === 'write:/docs/report.md').length).toBe(writesBefore);
  });
});

describe('restore', () => {
  test('rebuilds tabs, active tab, and caret from a valid manifest', async () => {
    const manifest = {
      schema: 1,
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          kind: 'note',
          notePath: `${NOTES}/hi.md`,
          filePath: null,
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: null,
          hasBuffer: false,
          cursor: { anchor: 3, head: 5 },
        },
      ],
    };
    const fs = makeFakeFs({
      [`${SESSION}/session.json`]: JSON.stringify(manifest),
      [`${NOTES}/hi.md`]: '# Hi there',
    });
    const controller = makeController(fs);

    await controller.restore();

    const state = tabs.tabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    const tab = state.tabs[0]!;
    expect(tab.id).toBe('t1');
    expect(tab.notePath).toBe(`${NOTES}/hi.md`);
    expect(tab.title).toBe('Hi there');
    expect(tab.model.getText()).toBe('# Hi there');
    expect(state.activeTabId).toBe('t1');
    expect(session.getCursor('t1')).toEqual({ anchor: 3, head: 5 });
    // Restored from disk → not session-dirty (no needless rewrite next flush).
    expect(tab.model.isDirty('session')).toBe(false);
  });

  test('a missing note file is skipped, not fatal', async () => {
    const manifest = {
      schema: 1,
      activeTabId: 't2',
      tabs: [
        {
          id: 't1',
          kind: 'note',
          notePath: `${NOTES}/present.md`,
          filePath: null,
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: null,
          hasBuffer: false,
          cursor: null,
        },
        {
          id: 't2',
          kind: 'note',
          notePath: `${NOTES}/gone.md`,
          filePath: null,
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: null,
          hasBuffer: false,
          cursor: null,
        },
      ],
    };
    const fs = makeFakeFs({
      [`${SESSION}/session.json`]: JSON.stringify(manifest),
      [`${NOTES}/present.md`]: 'here',
    });
    const controller = makeController(fs);

    await controller.restore();

    const state = tabs.tabsStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['t1']);
    // Active fell back to a surviving tab.
    expect(state.activeTabId).toBe('t1');
  });

  test('tab files are read concurrently, in order, with progress reported', async () => {
    const note = (id: string, name: string) => ({
      id,
      kind: 'note',
      notePath: `${NOTES}/${name}`,
      filePath: null,
      customTitle: null,
      mode: 'raw',
      savedMtimeMs: null,
      hasBuffer: false,
      cursor: null,
    });
    const manifest = {
      schema: 1,
      activeTabId: 't1',
      tabs: [note('t1', 'slow.md'), note('t2', 'fast.md')],
    };
    const fs = makeFakeFs({
      [`${SESSION}/session.json`]: JSON.stringify(manifest),
      [`${NOTES}/slow.md`]: 'slow',
      [`${NOTES}/fast.md`]: 'fast',
    });
    // slow.md (think: a WSL share booting its VM) holds until released.
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
    const started: string[] = [];
    const read = fs.ipc.readTextFile;
    fs.ipc.readTextFile = async (path) => {
      started.push(path);
      if (path.endsWith('slow.md')) {
        await slowGate;
      }
      return read(path);
    };
    const progress: string[][] = [];
    const controller = makeController(fs, undefined, {
      onRestoreProgress: (waitingOn) => progress.push(waitingOn),
    });

    const restoring = controller.restore();
    await vi.waitFor(() => expect(started).toContain(`${NOTES}/fast.md`));
    // fast.md was read while slow.md was still outstanding — not after it.
    expect(started).toContain(`${NOTES}/slow.md`);
    expect(progress.at(-1)).toEqual(['slow.md']);

    releaseSlow();
    await restoring;

    expect(progress.at(-1)).toEqual([]);
    const state = tabs.tabsStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(state.tabs.map((t) => t.model.getText())).toEqual(['slow', 'fast']);
  });

  test('a corrupt manifest is quarantined and recent notes reopen (self-heal)', async () => {
    const fs = makeFakeFs({
      [`${SESSION}/session.json`]: 'garbage{{{ not json',
      [`${NOTES}/a.md`]: 'alpha',
      [`${NOTES}/b.md`]: 'beta',
    });
    const controller = makeController(fs, () => 999);

    await controller.restore();

    // The bad manifest was moved aside, not deleted.
    expect(fs.files.has(`${SESSION}/session.json`)).toBe(false);
    expect(fs.files.has(`${SESSION}/session.json.bad-999`)).toBe(true);
    // Both notes reopened as tabs.
    const texts = tabs.tabsStore
      .getState()
      .tabs.map((t) => t.model.getText())
      .sort();
    expect(texts).toEqual(['alpha', 'beta']);
  });

  test('first launch (no manifest, no notes) opens a single empty tab, no crash', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);

    await controller.restore();

    const state = tabs.tabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.model.getText()).toBe('');
    // No note file conjured for an empty tab.
    expect(fs.files.has(`${NOTES}/untitled.md`)).toBe(false);
  });

  test('a restored file tab with a buffer shows dirty; the manifest wording covers files generically', async () => {
    const manifest = {
      schema: 1,
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          kind: 'file',
          notePath: null,
          filePath: '/docs/report.md',
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: 5,
          hasBuffer: true,
          cursor: null,
        },
      ],
    };
    const fs = makeFakeFs({
      [`${SESSION}/session.json`]: JSON.stringify(manifest),
      [`${SESSION}/buffers/t1.md`]: 'unsaved edits',
      [`/docs/report.md`]: 'saved content',
    });
    // The on-disk file's mtime is exactly the manifest baseline: no conflict.
    fs.mtimes.set('/docs/report.md', 5);
    const controller = makeController(fs);

    await controller.restore();

    const tab = tabs.tabsStore.getState().tabs[0]!;
    expect(tab.model.getText()).toBe('unsaved edits');
    expect(tab.dirty).toBe(true);
    expect(tab.conflict).toBe(false);
  });

  test('a restored buffer-less file tab adopts a moved mtime silently (it already shows disk)', async () => {
    const manifest = {
      schema: 1,
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          kind: 'file',
          notePath: null,
          filePath: '/docs/report.md',
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: 5,
          hasBuffer: false,
          cursor: null,
        },
      ],
    };
    const fs = makeFakeFs({
      [`${SESSION}/session.json`]: JSON.stringify(manifest),
      [`/docs/report.md`]: 'changed while we were closed',
    });
    fs.mtimes.set('/docs/report.md', 999); // differs from the manifest's savedMtimeMs (5)
    const controller = makeController(fs);

    await controller.restore();

    // Without a buffer, restore loaded the CURRENT disk content into the
    // model — there is nothing to resolve, so no banner; the stale manifest
    // baseline is replaced by the on-disk mtime.
    const tab = tabs.tabsStore.getState().tabs[0]!;
    expect(tab.conflict).toBe(false);
    expect(tab.savedMtimeMs).toBe(999);
  });

  test('a restored file tab with unsaved buffer edits IS flagged when disk changed while closed', async () => {
    const manifest = {
      schema: 1,
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          kind: 'file',
          notePath: null,
          filePath: '/docs/report.md',
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: 5,
          hasBuffer: true,
          cursor: null,
        },
      ],
    };
    const fs = makeFakeFs({
      [`${SESSION}/session.json`]: JSON.stringify(manifest),
      [`${SESSION}/buffers/t1.md`]: 'my unsaved edits',
      [`/docs/report.md`]: 'changed while we were closed',
    });
    fs.mtimes.set('/docs/report.md', 999);
    const controller = makeController(fs);

    await controller.restore();

    expect(tabs.tabsStore.getState().tabs[0]!.conflict).toBe(true);
  });
});

describe('openPaths (M3)', () => {
  test('opens a new file tab with the read content, mtime, and activates it', async () => {
    const fs = makeFakeFs({ '/docs/report.md': 'hello' });
    fs.mtimes.set('/docs/report.md', 7);
    const controller = makeController(fs);

    await controller.openPaths(['/docs/report.md']);

    const state = tabs.tabsStore.getState();
    const opened = state.tabs.find((t) => t.filePath === '/docs/report.md')!;
    expect(opened.kind).toBe('file');
    expect(opened.model.getText()).toBe('hello');
    expect(opened.savedMtimeMs).toBe(7);
    expect(opened.dirty).toBe(false);
    expect(state.activeTabId).toBe(opened.id);
  });

  test('opening an already-open path focuses the existing tab instead of duplicating', async () => {
    const fs = makeFakeFs({ '/docs/report.md': 'hello' });
    const controller = makeController(fs);
    await controller.openPaths(['/docs/report.md']);
    const firstOpenCount = tabs.tabsStore.getState().tabs.length;
    tabs.tabsStore.getState().newTab(); // move focus elsewhere

    await controller.openPaths(['/docs/report.md']);

    expect(tabs.tabsStore.getState().tabs).toHaveLength(firstOpenCount + 1);
    const opened = tabs.tabsStore.getState().tabs.find((t) => t.filePath === '/docs/report.md')!;
    expect(tabs.tabsStore.getState().activeTabId).toBe(opened.id);
  });

  test('dedupe is separator- and case-insensitive (Windows: `\\` vs `/` paths)', async () => {
    const fs = makeFakeFs({ 'C:\\docs\\Report.md': 'hello' });
    const controller = makeController(fs);
    await controller.openPaths(['C:\\docs\\Report.md']);
    const firstOpenCount = tabs.tabsStore.getState().tabs.length;

    // Same file, as the explorer/core layers would spell it (joinPath uses `/`).
    await controller.openPaths(['C:/docs/report.md']);

    expect(tabs.tabsStore.getState().tabs).toHaveLength(firstOpenCount);
    const opened = tabs.tabsStore
      .getState()
      .tabs.find((t) => t.filePath === 'C:\\docs\\Report.md')!;
    expect(tabs.tabsStore.getState().activeTabId).toBe(opened.id);
  });

  test('a missing file surfaces a notice and opens no tab', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const before = tabs.tabsStore.getState().tabs.length;

    await controller.openPaths(['/docs/gone.md']);

    expect(tabs.tabsStore.getState().tabs).toHaveLength(before);
  });

  test('two concurrent opens of one path create a single tab (double-click dedupe)', async () => {
    const fs = makeFakeFs({ '/docs/report.md': 'hello' });
    const controller = makeController(fs);
    const before = tabs.tabsStore.getState().tabs.length;

    // Fire both WITHOUT awaiting the first — the second lands before the first
    // has created its tab, exactly like a rapid double-click in the explorer.
    await Promise.all([
      controller.openPaths(['/docs/report.md']),
      controller.openPaths(['/docs/report.md']),
    ]);

    const opened = tabs.tabsStore.getState().tabs.filter((t) => t.filePath === '/docs/report.md');
    expect(opened).toHaveLength(1);
    expect(tabs.tabsStore.getState().tabs).toHaveLength(before + 1);
  });
});

describe('image tabs', () => {
  test('opening an image path creates a read-only image tab without reading text', async () => {
    const fs = makeFakeFs({ '/pics/cat.png': 'PNGBYTES' });
    fs.mtimes.set('/pics/cat.png', 9);
    const controller = makeController(fs);

    await controller.openPaths(['/pics/cat.png']);

    const state = tabs.tabsStore.getState();
    const opened = state.tabs.find((t) => t.filePath === '/pics/cat.png')!;
    expect(opened.kind).toBe('image');
    expect(opened.savedMtimeMs).toBe(9);
    expect(opened.model.getText()).toBe('');
    expect(state.activeTabId).toBe(opened.id);
  });

  test('a missing image opens no tab', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const before = tabs.tabsStore.getState().tabs.length;

    await controller.openPaths(['/pics/gone.png']);

    expect(tabs.tabsStore.getState().tabs).toHaveLength(before);
  });

  test('flush persists an image tab to the manifest without writing any content', async () => {
    const fs = makeFakeFs({ '/pics/cat.png': 'PNGBYTES' });
    const controller = makeController(fs);
    await controller.openPaths(['/pics/cat.png']);
    fs.ops.length = 0;

    await controller.flushNow();

    // The only write is the manifest itself — never the image, never a buffer.
    expect(fs.ops.filter((op) => op.startsWith('write:'))).toEqual([
      `write:${SESSION}/session.json`,
    ]);
    const manifest = JSON.parse(fs.files.get(`${SESSION}/session.json`)!) as {
      tabs: { kind: string; filePath: string | null }[];
    };
    const persisted = manifest.tabs.find((t) => t.filePath === '/pics/cat.png')!;
    expect(persisted.kind).toBe('image');
  });

  test('restore rebuilds an image tab, and drops one whose file is gone', async () => {
    const fs = makeFakeFs({ '/pics/cat.png': 'PNGBYTES', '/pics/dog.png': 'PNGBYTES' });
    const controller = makeController(fs);
    await controller.openPaths(['/pics/cat.png', '/pics/dog.png']);
    await controller.flushNow();
    fs.files.delete('/pics/dog.png');

    const fresh = makeController(fs);
    await fresh.restore();

    const restored = tabs.tabsStore.getState().tabs;
    expect(restored.some((t) => t.kind === 'image' && t.filePath === '/pics/cat.png')).toBe(true);
    expect(restored.some((t) => t.filePath === '/pics/dog.png')).toBe(false);
  });

  test('Save and Save As are no-ops on an image tab', async () => {
    const fs = makeFakeFs({ '/pics/cat.png': 'PNGBYTES' });
    const controller = makeController(fs, undefined, {
      saveDialog: async () => '/docs/out.md',
    });
    await controller.openPaths(['/pics/cat.png']);
    fs.ops.length = 0;

    await controller.saveActive();
    await controller.saveAsActive();

    expect(fs.ops.filter((op) => op.startsWith('write:'))).toEqual([]);
  });
});

describe('importFilesInto / savePastedFileInto', () => {
  test('copies md and image files, skips other types, and suffixes collisions', async () => {
    const fs = makeFakeFs({
      '/src/todo.md': 'todo',
      '/src/pic.png': 'PNG',
      '/src/data.csv': 'nope',
      '/ws/todo.md': 'already there',
    });
    makeController(fs);

    await session.importFilesInto('/ws', ['/src/todo.md', '/src/pic.png', '/src/data.csv']);

    expect(fs.files.get('/ws/todo-2.md')).toBe('todo'); // collision → -2
    expect(fs.files.get('/ws/pic.png')).toBe('PNG');
    expect(fs.files.has('/ws/data.csv')).toBe(false); // unsupported type skipped
    expect(fs.files.get('/src/todo.md')).toBe('todo'); // copy, not move
  });

  test('a file dropped onto the folder it already lives in is left alone', async () => {
    const fs = makeFakeFs({ '/ws/todo.md': 'todo' });
    makeController(fs);

    await session.importFilesInto('/ws', ['/ws/todo.md']);

    expect(fs.files.has('/ws/todo-2.md')).toBe(false);
  });

  test('a pasted screenshot gets a timestamped name; a named file keeps its name', async () => {
    const fs = makeFakeFs();
    makeController(fs); // now() = 111 → epoch-ish stamp, exact value not asserted
    await session.savePastedFileInto('/ws', { base64: btoa('PNG'), ext: '.png', name: null });
    await session.savePastedFileInto('/ws', { base64: btoa('PNG'), ext: '.png', name: 'shot' });

    const names = [...fs.files.keys()];
    expect(names.some((n) => /^\/ws\/pasted-\d{8}-\d{6}\.png$/.test(n))).toBe(true);
    expect(fs.files.get('/ws/shot.png')).toBe('PNG');
  });

  test('pasting the same named image twice suffixes the second', async () => {
    const fs = makeFakeFs();
    makeController(fs);
    await session.savePastedFileInto('/ws', { base64: btoa('A'), ext: '.png', name: 'shot' });
    await session.savePastedFileInto('/ws', { base64: btoa('B'), ext: '.png', name: 'shot' });

    expect(fs.files.get('/ws/shot.png')).toBe('A');
    expect(fs.files.get('/ws/shot-2.png')).toBe('B');
  });
});

describe('appendImagesToMd (drop an image onto an md file)', () => {
  async function useSameFolder() {
    const settings = await import('../stores/settings');
    settings.settingsStore.getState().update({ imagePasteLocation: 'sameFolder' });
  }

  test('copies the image into the images subfolder and appends a reference (default)', async () => {
    const fs = makeFakeFs({ '/ws/note.md': '# Title', '/src/pic.png': 'PNG' });
    makeController(fs);

    await session.appendImagesToMd('/ws/note.md', ['/src/pic.png']);

    expect(fs.files.get('/ws/images/pic.png')).toBe('PNG'); // default = images subfolder
    expect(fs.files.get('/ws/note.md')).toBe('# Title\n\n![pic](/ws/images/pic.png)\n');
  });

  test("'sameFolder' setting places the image beside the note", async () => {
    const fs = makeFakeFs({ '/ws/note.md': '# Title', '/src/pic.png': 'PNG' });
    makeController(fs);
    await useSameFolder();

    await session.appendImagesToMd('/ws/note.md', ['/src/pic.png']);

    expect(fs.files.get('/ws/pic.png')).toBe('PNG');
    expect(fs.files.get('/ws/note.md')).toBe('# Title\n\n![pic](/ws/pic.png)\n');
  });

  test('an image from elsewhere in the same workspace is referenced in place, not copied', async () => {
    const fs = makeFakeFs({ '/ws/note.md': 'body', '/ws/pics/a.png': 'PNG' });
    makeController(fs);
    const settings = await import('../stores/settings');
    settings.settingsStore.getState().update({
      workspaces: [{ name: 'W', path: '/ws', color: null }],
    });

    // Default subfolder mode would otherwise copy into /ws/images.
    await session.appendImagesToMd('/ws/note.md', ['/ws/pics/a.png']);

    expect(fs.ops.some((o) => o.startsWith('copy:'))).toBe(false);
    expect(fs.files.has('/ws/images/a.png')).toBe(false);
    expect(fs.files.get('/ws/note.md')).toBe('body\n\n![a](/ws/pics/a.png)\n');
  });

  test('an image from outside the workspace is copied into the images folder', async () => {
    const fs = makeFakeFs({ '/ws/note.md': 'body', '/outside/a.png': 'PNG' });
    makeController(fs);
    const settings = await import('../stores/settings');
    settings.settingsStore.getState().update({
      workspaces: [{ name: 'W', path: '/ws', color: null }],
    });

    await session.appendImagesToMd('/ws/note.md', ['/outside/a.png']);

    expect(fs.files.get('/ws/images/a.png')).toBe('PNG'); // copied in
    expect(fs.files.get('/ws/note.md')).toBe('body\n\n![a](/ws/images/a.png)\n');
  });

  test('a declined confirmation inserts nothing', async () => {
    const fs = makeFakeFs({ '/ws/note.md': 'body', '/src/pic.png': 'PNG' });
    makeController(fs, undefined, { confirm: async () => false });

    await session.appendImagesToMd('/ws/note.md', ['/src/pic.png']);

    expect(fs.files.get('/ws/note.md')).toBe('body'); // untouched
    expect(fs.ops.some((o) => o.startsWith('copy:'))).toBe(false);
  });

  test('ignores non-image paths', async () => {
    const fs = makeFakeFs({ '/ws/note.md': 'body', '/src/data.csv': 'nope' });
    makeController(fs);

    await session.appendImagesToMd('/ws/note.md', ['/src/data.csv']);

    expect(fs.files.get('/ws/note.md')).toBe('body'); // untouched
    expect(fs.files.has('/ws/data.csv')).toBe(false);
  });

  test('an image already in the target dir is referenced in place, not re-copied', async () => {
    const fs = makeFakeFs({ '/ws/note.md': 'body', '/ws/pic.png': 'PNG' });
    makeController(fs);
    await useSameFolder();

    await session.appendImagesToMd('/ws/note.md', ['/ws/pic.png']);

    expect(fs.ops.some((o) => o.startsWith('copy:'))).toBe(false);
    expect(fs.files.get('/ws/note.md')).toBe('body\n\n![pic](/ws/pic.png)\n');
  });

  test('an image name with spaces wraps the destination in angle brackets', async () => {
    const fs = makeFakeFs({ '/ws/note.md': 'body', '/src/my shot.png': 'PNG' });
    makeController(fs);
    await useSameFolder();

    await session.appendImagesToMd('/ws/note.md', ['/src/my shot.png']);

    expect(fs.files.get('/ws/note.md')).toBe('body\n\n![my shot](</ws/my shot.png>)\n');
  });

  test('appends to the live model (not disk) when a tab already owns the file', async () => {
    const fs = makeFakeFs({ '/ws/note.md': 'on disk', '/src/pic.png': 'PNG' });
    const controller = makeController(fs);
    await useSameFolder();
    await controller.openPaths(['/ws/note.md']);
    const tab = tabs.tabsStore.getState().tabs.find((t) => t.filePath === '/ws/note.md')!;

    await session.appendImagesToMd('/ws/note.md', ['/src/pic.png']);

    expect(tab.model.getText()).toBe('on disk\n\n![pic](/ws/pic.png)\n');
    expect(fs.files.get('/ws/note.md')).toBe('on disk'); // disk not clobbered under the open tab
    expect(fs.files.get('/ws/pic.png')).toBe('PNG'); // image still copied in
  });
});

describe('savePastedImageForTab (editor paste)', () => {
  test('writes the image into the images subfolder and returns an absolute ref', async () => {
    const fs = makeFakeFs();
    makeController(fs);
    const tabId = tabs.tabsStore.getState().tabs[0]!.id;
    // Make it a file tab with a known directory so paths are deterministic.
    tabs.tabsStore.getState().saveToPath(tabId, { filePath: '/ws/note.md', mtimeMs: 1 });

    const ref = await session.savePastedImageForTab(tabId, {
      base64: btoa('PNG'),
      ext: '.png',
      name: null,
    });

    expect(ref).not.toBeNull();
    expect(ref!.src).toMatch(/^\/ws\/images\/pasted-\d{8}-\d{6}\.png$/);
    expect(fs.files.get(`/ws/images/${ref!.alt}.png`)).toBe('PNG');
  });

  test('a named paste keeps its name', async () => {
    const fs = makeFakeFs();
    makeController(fs);
    const tabId = tabs.tabsStore.getState().tabs[0]!.id;
    tabs.tabsStore.getState().saveToPath(tabId, { filePath: '/ws/note.md', mtimeMs: 1 });

    const ref = await session.savePastedImageForTab(tabId, {
      base64: btoa('PNG'),
      ext: '.png',
      name: 'diagram',
    });

    expect(ref!.src).toBe('/ws/images/diagram.png');
    expect(fs.files.get('/ws/images/diagram.png')).toBe('PNG');
  });
});

describe('createNewFileIn (explorer context menu)', () => {
  test('creates an empty untitled.md, opens it, and returns its path for the inline rename', async () => {
    const fs = makeFakeFs();
    makeController(fs);

    const created = await session.createNewFileIn('/ws');

    expect(created).toBe('/ws/untitled.md');
    expect(fs.files.get('/ws/untitled.md')).toBe('');
    const state = tabs.tabsStore.getState();
    const opened = state.tabs.find((t) => t.filePath === '/ws/untitled.md')!;
    expect(opened.kind).toBe('file');
    expect(state.activeTabId).toBe(opened.id);
    // The rename now happens on the explorer row (FileExplorer starts it with
    // the returned path), not on the tab — so no tab enters rename mode.
    expect(state.renamingTabId).toBeNull();
  });

  test('a second new file in the same folder gets a collision suffix', async () => {
    const fs = makeFakeFs({ '/ws/untitled.md': 'existing' });
    makeController(fs);

    await session.createNewFileIn('/ws');

    expect(fs.files.get('/ws/untitled.md')).toBe('existing');
    expect(fs.files.get('/ws/untitled-2.md')).toBe('');
  });
});

describe('createNewFolderIn (explorer context menu)', () => {
  test('creates a uniquely-named folder', async () => {
    const fs = makeFakeFs();
    makeController(fs);

    const first = await session.createNewFolderIn('/ws');
    const second = await session.createNewFolderIn('/ws');

    expect(fs.dirs.has('/ws/new-folder')).toBe(true);
    expect(fs.dirs.has('/ws/new-folder-2')).toBe(true);
    // Returns the created path so the explorer can start an inline rename on it.
    expect(first).toBe('/ws/new-folder');
    expect(second).toBe('/ws/new-folder-2');
  });
});

describe('renameExplorerEntry (explorer context menu)', () => {
  test('renames an unopened file on disk, preserving the extension', async () => {
    const fs = makeFakeFs({ '/ws/old.md': 'body' });
    makeController(fs);

    await session.renameExplorerEntry('/ws/old.md', 'new name', false);

    expect(fs.files.has('/ws/old.md')).toBe(false);
    expect(fs.files.get('/ws/new name.md')).toBe('body');
  });

  test('refuses to clobber an existing sibling', async () => {
    const fs = makeFakeFs({ '/ws/a.md': 'A', '/ws/b.md': 'B' });
    makeController(fs);

    await session.renameExplorerEntry('/ws/a.md', 'b', false);

    expect(fs.files.get('/ws/a.md')).toBe('A');
    expect(fs.files.get('/ws/b.md')).toBe('B');
  });

  test('does not double the extension when the user types it (no .md.md)', async () => {
    const fs = makeFakeFs({ '/ws/old.md': 'body' });
    makeController(fs);

    await session.renameExplorerEntry('/ws/old.md', 'new.md', false);

    expect(fs.files.has('/ws/new.md.md')).toBe(false);
    expect(fs.files.get('/ws/new.md')).toBe('body');
  });

  test('typing the exact current name-with-extension is a no-op, not a double', async () => {
    const fs = makeFakeFs({ '/ws/doc.md': 'body' });
    makeController(fs);

    await session.renameExplorerEntry('/ws/doc.md', 'doc.md', false);

    expect(fs.files.get('/ws/doc.md')).toBe('body');
    expect(fs.files.has('/ws/doc.md.md')).toBe(false);
    expect(fs.ops.some((op) => op.startsWith('rename:'))).toBe(false);
  });

  test('a file some tab has open goes through the tab-rename flow (tab retargeted)', async () => {
    const fs = makeFakeFs({ '/ws/doc.md': 'text' });
    const controller = makeController(fs);
    await controller.openPaths(['/ws/doc.md']);
    const tabId = tabs.tabsStore.getState().activeTabId;

    await session.renameExplorerEntry('/ws/doc.md', 'renamed', false);

    expect(fs.files.get('/ws/renamed.md')).toBe('text');
    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === tabId)!;
    expect(tab.filePath).toBe('/ws/renamed.md');
  });

  test('a note-owned file is renamed via the tab title, not a raw disk rename', async () => {
    const fs = makeFakeFs({ '/notes/buy-milk.md': '# Buy milk' });
    const controller = makeController(fs);
    await controller.restore();
    await controller.flushNow();
    const tab = tabs.tabsStore.getState().tabs.find((t) => t.notePath === '/notes/buy-milk.md')!;

    await session.renameExplorerEntry('/notes/buy-milk.md', 'Groceries', false);

    // No immediate disk rename — the title changed and the next flush slugs it.
    expect(fs.files.has('/notes/buy-milk.md')).toBe(true);
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === tab.id)!.customTitle).toBe(
      'Groceries',
    );
    await controller.flushNow();
    expect(fs.files.has('/notes/groceries.md')).toBe(true);
    expect(fs.files.has('/notes/buy-milk.md')).toBe(false);
  });

  test('renaming a folder retargets open file tabs beneath it', async () => {
    const fs = makeFakeFs({ '/ws/sub/doc.md': 'text' });
    fs.dirs.add('/ws/sub');
    const controller = makeController(fs);
    await controller.openPaths(['/ws/sub/doc.md']);
    const tabId = tabs.tabsStore.getState().activeTabId;

    await session.renameExplorerEntry('/ws/sub', 'archive', true);

    expect(fs.dirs.has('/ws/archive')).toBe(true);
    expect(fs.files.get('/ws/archive/doc.md')).toBe('text');
    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === tabId)!;
    expect(tab.filePath).toBe('/ws/archive/doc.md');
  });

  test('a case-only rename is a real rename, not a no-op', async () => {
    const fs = makeFakeFs({ '/ws/notes.md': 'body' });
    makeController(fs);

    await session.renameExplorerEntry('/ws/notes.md', 'Notes', false);

    // pathKey() lowercases, so the old "nothing changed" guard swallowed this
    // one; and on a case-insensitive FS the stat of the target reports EXISTS
    // because it IS this file, so that guard has to be skipped too.
    expect(fs.ops).toContain('rename:/ws/notes.md->/ws/Notes.md');
    expect(fs.files.get('/ws/Notes.md')).toBe('body');
  });

  test('a case-only FOLDER rename goes through and retargets tabs beneath it', async () => {
    const fs = makeFakeFs({ '/ws/sub/doc.md': 'text' });
    fs.dirs.add('/ws/sub');
    const controller = makeController(fs);
    await controller.openPaths(['/ws/sub/doc.md']);
    const tabId = tabs.tabsStore.getState().activeTabId;

    await session.renameExplorerEntry('/ws/sub', 'Sub', true);

    expect(fs.dirs.has('/ws/Sub')).toBe(true);
    expect(fs.files.get('/ws/Sub/doc.md')).toBe('text');
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === tabId)!.filePath).toBe(
      '/ws/Sub/doc.md',
    );
  });

  test('a case-only rename of an OPEN file tab renames the file and retargets the tab', async () => {
    const fs = makeFakeFs({ '/ws/doc.md': 'text' });
    const controller = makeController(fs);
    await controller.openPaths(['/ws/doc.md']);
    const tabId = tabs.tabsStore.getState().activeTabId;

    await session.renameExplorerEntry('/ws/doc.md', 'Doc', false);

    expect(fs.files.get('/ws/Doc.md')).toBe('text');
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === tabId)!.filePath).toBe('/ws/Doc.md');
  });

  test('an open file renamed with a typed extension keeps a single .md', async () => {
    const fs = makeFakeFs({ '/ws/doc.md': 'text' });
    const controller = makeController(fs);
    await controller.openPaths(['/ws/doc.md']);
    const tabId = tabs.tabsStore.getState().activeTabId;

    await session.renameExplorerEntry('/ws/doc.md', 'renamed.md', false);

    expect(fs.files.get('/ws/renamed.md')).toBe('text');
    expect(fs.files.has('/ws/renamed.md.md')).toBe(false);
    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === tabId)!;
    expect(tab.filePath).toBe('/ws/renamed.md');
  });
});

describe('deleteExplorerEntry (explorer context menu)', () => {
  test('deletes a file after confirming', async () => {
    const fs = makeFakeFs({ '/ws/junk.md': 'x' });
    makeController(fs); // default confirm resolves true

    await session.deleteExplorerEntry('/ws/junk.md');

    expect(fs.files.has('/ws/junk.md')).toBe(false);
    expect(fs.ops).toContain('delete:/ws/junk.md');
  });

  test('does nothing when the user cancels the confirm', async () => {
    const fs = makeFakeFs({ '/ws/keep.md': 'x' });
    makeController(fs, () => 111, { confirm: async () => false });

    await session.deleteExplorerEntry('/ws/keep.md');

    expect(fs.files.get('/ws/keep.md')).toBe('x');
    expect(fs.ops.some((op) => op.startsWith('delete:'))).toBe(false);
  });

  test('closes the tab that owns the file so it cannot be recreated', async () => {
    const fs = makeFakeFs({ '/ws/open.md': 'text' });
    const controller = makeController(fs);
    await controller.openPaths(['/ws/open.md']);
    const tabId = tabs.tabsStore.getState().activeTabId;

    await session.deleteExplorerEntry('/ws/open.md');

    expect(fs.files.has('/ws/open.md')).toBe(false);
    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === tabId)).toBe(false);
  });
});

describe('deleteExplorerFolder (explorer context menu)', () => {
  test('deletes a folder and everything inside it after confirming', async () => {
    const fs = makeFakeFs({ '/ws/sub/a.md': 'A', '/ws/sub/nested/b.md': 'B' });
    fs.dirs.add('/ws/sub');
    fs.dirs.add('/ws/sub/nested');
    makeController(fs); // default confirm resolves true

    await session.deleteExplorerFolder('/ws/sub');

    expect(fs.dirs.has('/ws/sub')).toBe(false);
    expect(fs.files.has('/ws/sub/a.md')).toBe(false);
    expect(fs.files.has('/ws/sub/nested/b.md')).toBe(false);
    expect(fs.ops).toContain('delete:/ws/sub');
  });

  test('does nothing when the user cancels the confirm', async () => {
    const fs = makeFakeFs({ '/ws/sub/keep.md': 'x' });
    fs.dirs.add('/ws/sub');
    makeController(fs, () => 111, { confirm: async () => false });

    await session.deleteExplorerFolder('/ws/sub');

    expect(fs.dirs.has('/ws/sub')).toBe(true);
    expect(fs.files.get('/ws/sub/keep.md')).toBe('x');
    expect(fs.ops.some((op) => op.startsWith('delete:'))).toBe(false);
  });

  test('closes tabs whose files live under the folder so they cannot be recreated', async () => {
    const fs = makeFakeFs({ '/ws/sub/open.md': 'text', '/ws/other.md': 'keep' });
    fs.dirs.add('/ws/sub');
    const controller = makeController(fs);
    await controller.openPaths(['/ws/sub/open.md', '/ws/other.md']);
    const underFolder = tabs.tabsStore
      .getState()
      .tabs.find((t) => t.filePath === '/ws/sub/open.md');
    const outside = tabs.tabsStore.getState().tabs.find((t) => t.filePath === '/ws/other.md');

    await session.deleteExplorerFolder('/ws/sub');

    expect(fs.files.has('/ws/sub/open.md')).toBe(false);
    // The tab under the deleted folder is gone; the one outside it survives.
    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === underFolder!.id)).toBe(false);
    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === outside!.id)).toBe(true);
  });
});

describe('moveExplorerEntryInto (explorer row drag)', () => {
  test('moves a file into another folder', async () => {
    const fs = makeFakeFs({ '/ws/doc.md': 'text' });
    fs.dirs.add('/ws/sub');
    makeController(fs);

    await session.moveExplorerEntryInto('/ws/doc.md', '/ws/sub');

    expect(fs.files.has('/ws/doc.md')).toBe(false);
    expect(fs.files.get('/ws/sub/doc.md')).toBe('text');
  });

  test('same-dir drop is a no-op and a name collision is refused', async () => {
    const fs = makeFakeFs({ '/ws/doc.md': 'A', '/ws/sub/doc.md': 'B' });
    fs.dirs.add('/ws/sub');
    makeController(fs);

    await session.moveExplorerEntryInto('/ws/doc.md', '/ws');
    await session.moveExplorerEntryInto('/ws/doc.md', '/ws/sub');

    expect(fs.files.get('/ws/doc.md')).toBe('A');
    expect(fs.files.get('/ws/sub/doc.md')).toBe('B');
    expect(fs.ops.filter((op) => op.startsWith('rename:'))).toEqual([]);
  });

  test('a declined confirm leaves the file where it is', async () => {
    const fs = makeFakeFs({ '/ws/doc.md': 'text' });
    fs.dirs.add('/ws/sub');
    makeController(fs, undefined, { confirm: async () => false });

    await session.moveExplorerEntryInto('/ws/doc.md', '/ws/sub');

    expect(fs.files.get('/ws/doc.md')).toBe('text');
    expect(fs.files.has('/ws/sub/doc.md')).toBe(false);
  });

  test('an open file tab is retargeted to the moved path', async () => {
    const fs = makeFakeFs({ '/ws/doc.md': 'text' });
    fs.dirs.add('/ws/sub');
    const controller = makeController(fs);
    await controller.openPaths(['/ws/doc.md']);
    const tabId = tabs.tabsStore.getState().activeTabId;

    await session.moveExplorerEntryInto('/ws/doc.md', '/ws/sub');

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === tabId)!;
    expect(tab.filePath).toBe('/ws/sub/doc.md');
    expect(fs.files.get('/ws/sub/doc.md')).toBe('text');
  });

  test('a file moves into ANOTHER workspace (destination outside its own root)', async () => {
    const fs = makeFakeFs({ '/ws-a/doc.md': 'text' });
    fs.dirs.add('/ws-b');
    fs.dirs.add('/ws-b/inbox');
    const controller = makeController(fs);
    await controller.openPaths(['/ws-a/doc.md']);
    const tabId = tabs.tabsStore.getState().activeTabId;

    await session.moveExplorerEntryInto('/ws-a/doc.md', '/ws-b/inbox');

    expect(fs.files.has('/ws-a/doc.md')).toBe(false);
    expect(fs.files.get('/ws-b/inbox/doc.md')).toBe('text');
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === tabId)!.filePath).toBe(
      '/ws-b/inbox/doc.md',
    );
  });

  /**
   * A NOTE tab's identity is "a file directly in the notes dir whose name
   * follows the tab title". Drag that file into another workspace and it stops
   * being a note — otherwise the flusher owns a file it no longer knows where
   * to keep.
   */
  describe('a note tab whose file leaves the notes dir', () => {
    async function openNoteAndMoveTo(dest: string) {
      const fs = makeFakeFs({ '/notes/buy-milk.md': '# Buy milk' });
      fs.dirs.add(dest);
      const controller = makeController(fs);
      await controller.restore();
      await controller.flushNow();
      const note = tabs.tabsStore.getState().tabs.find((t) => t.notePath === '/notes/buy-milk.md')!;

      await session.moveExplorerEntryInto('/notes/buy-milk.md', dest);

      return { fs, controller, id: note.id };
    }

    test('becomes a plain file tab pointing at the new location', async () => {
      const { fs, id } = await openNoteAndMoveTo('/ws');

      expect(fs.files.has('/notes/buy-milk.md')).toBe(false);
      expect(fs.files.get('/ws/buy-milk.md')).toBe('# Buy milk');
      const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
      expect(tab.kind).toBe('file');
      expect(tab.notePath).toBe(null);
      expect(tab.filePath).toBe('/ws/buy-milk.md');
      expect(tab.dirty).toBe(false);
    });

    test('a subfolder of the notes dir counts as leaving it', async () => {
      // planFlush only ever puts note files at the notes dir ROOT, so a note
      // in `/notes/sub` would be dragged back out on the next title change.
      const { id } = await openNoteAndMoveTo('/notes/sub');
      const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
      expect(tab.kind).toBe('file');
      expect(tab.filePath).toBe('/notes/sub/buy-milk.md');
    });

    test('the next flush neither recreates the note nor deletes the moved file', async () => {
      const { fs, controller } = await openNoteAndMoveTo('/ws');
      fs.ops.length = 0;

      await controller.flushNow();

      expect(fs.files.get('/ws/buy-milk.md')).toBe('# Buy milk');
      expect([...fs.files.keys()].filter((p) => p.startsWith('/notes/'))).toEqual([]);
      expect(fs.ops.some((op) => op.startsWith('delete:/ws/'))).toBe(false);
    });

    test('renaming the tab afterwards no longer drags the file back to the notes dir', async () => {
      const { fs, controller, id } = await openNoteAndMoveTo('/ws');

      tabs.tabsStore.getState().renameTab(id, 'Groceries');
      await controller.flushNow();

      expect(fs.files.has('/ws/buy-milk.md')).toBe(true);
      expect(fs.files.has('/notes/groceries.md')).toBe(false);
    });

    test('closing the tab afterwards does not delete the moved file', async () => {
      const { fs, controller, id } = await openNoteAndMoveTo('/ws');

      tabs.tabsStore.getState().closeTab(id);
      await controller.flushNow();

      expect(fs.files.get('/ws/buy-milk.md')).toBe('# Buy milk');
    });
  });
});

describe('saveActive / saveAsActive (M3)', () => {
  test('Save on a file tab writes the model text and clears the dirty dot', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'original' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    tabs.tabsStore.getState().activeTab()!.model.pushText('edited', 'cm6');
    expect(tabs.tabsStore.getState().activeTab()!.dirty).toBe(true);

    await controller.saveActive();

    expect(fs.files.get('/docs/a.md')).toBe('edited');
    const tab = tabs.tabsStore.getState().activeTab()!;
    expect(tab.dirty).toBe(false);
    expect(tab.savedMtimeMs).toBe(fs.mtimes.get('/docs/a.md'));
  });

  test('Save refuses to overwrite when the file changed on disk, and flags the conflict instead', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'original' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId;
    tabs.tabsStore.getState().activeTab()!.model.pushText('my edit', 'cm6');
    // Someone else changes the file on disk.
    fs.files.set('/docs/a.md', 'external edit');
    fs.mtimes.set('/docs/a.md', 999);

    await controller.saveActive();

    expect(fs.files.get('/docs/a.md')).toBe('external edit'); // NOT overwritten
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.conflict).toBe(true);
  });

  test('Save on a note tab behaves as Save As: converts it to a file tab and deletes the old note', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs, () => 111, { saveDialog: async () => '/docs/idea.md' });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Idea', 'cm6');
    await controller.flushNow(); // gives the note tab a notePath
    const notePath = tabs.tabsStore.getState().tabs[0]!.notePath!;
    expect(fs.files.has(notePath)).toBe(true);

    await controller.saveActive();

    const tab = tabs.tabsStore.getState().tabs[0]!;
    expect(tab.kind).toBe('file');
    expect(tab.filePath).toBe('/docs/idea.md');
    expect(fs.files.get('/docs/idea.md')).toBe('# Idea');

    await controller.flushNow(); // sweeps the closedNotePaths tombstone
    expect(fs.files.has(notePath)).toBe(false);
  });

  test('Save As cancelled at the dialog changes nothing', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    const controller = makeController(fs, () => 111, { saveDialog: async () => null });
    await controller.openPaths(['/docs/a.md']);

    await controller.saveAsActive();

    expect(tabs.tabsStore.getState().activeTab()!.filePath).toBe('/docs/a.md');
  });
});

describe('conflict detection, reload, and keep-mine (M3)', () => {
  test('checkConflict flags a file tab whose on-disk content changed', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    fs.files.set('/docs/a.md', 'external edit');
    fs.mtimes.set('/docs/a.md', 2);

    await controller.checkConflict(id);

    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.conflict).toBe(true);
  });

  test('checkConflict silently adopts an mtime-only change (touch / identical rewrite)', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    fs.mtimes.set('/docs/a.md', 2); // content still 'x'

    await controller.checkConflict(id);

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.conflict).toBe(false);
    expect(tab.savedMtimeMs).toBe(2); // baseline adopted, no banner
  });

  test('checkConflict stays quiet when disk already matches the unsaved editor text', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().activeTab()!.model.pushText('same everywhere', 'cm6');
    fs.files.set('/docs/a.md', 'same everywhere');
    fs.mtimes.set('/docs/a.md', 2);

    await controller.checkConflict(id);

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.conflict).toBe(false); // nothing to resolve — reload would be a no-op
  });

  test('viewDiff snapshots the on-disk text; reload and keep-mine close it', async () => {
    const { diffViewStore } = await import('../stores/diff-view');
    const fs = makeFakeFs({ '/docs/a.md': 'original' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    fs.files.set('/docs/a.md', 'external content');
    fs.mtimes.set('/docs/a.md', 2);
    await controller.checkConflict(id);

    await controller.viewDiff(id);
    expect(diffViewStore.getState().byTab[id]).toEqual({ diskText: 'external content' });

    await controller.keepMine(id);
    expect(diffViewStore.getState().byTab[id]).toBeUndefined();

    fs.files.set('/docs/a.md', 'newer still');
    fs.mtimes.set('/docs/a.md', 3);
    await controller.checkConflict(id);
    await controller.viewDiff(id);
    expect(diffViewStore.getState().byTab[id]).toEqual({ diskText: 'newer still' });
    await controller.reloadFromDisk(id);
    expect(diffViewStore.getState().byTab[id]).toBeUndefined();
  });

  test('checkAllFileConflicts leaves an untouched file clean', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);

    await controller.checkAllFileConflicts();

    expect(tabs.tabsStore.getState().activeTab()!.conflict).toBe(false);
  });

  test('reloadFromDisk replaces the model text and clears dirty + conflict', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'original' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().activeTab()!.model.pushText('my local edit', 'cm6');
    fs.files.set('/docs/a.md', 'external content');
    fs.mtimes.set('/docs/a.md', 2);
    await controller.checkConflict(id);
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.conflict).toBe(true);

    await controller.reloadFromDisk(id);

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.model.getText()).toBe('external content');
    expect(tab.dirty).toBe(false);
    expect(tab.conflict).toBe(false);
    expect(tab.savedMtimeMs).toBe(2);
  });

  test('keepMine dismisses the banner without touching local edits, and unblocks the next save', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'original' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().activeTab()!.model.pushText('my local edit', 'cm6');
    fs.files.set('/docs/a.md', 'external content');
    fs.mtimes.set('/docs/a.md', 2);
    await controller.checkConflict(id);

    await controller.keepMine(id);

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.conflict).toBe(false);
    expect(tab.dirty).toBe(true); // still unsaved on purpose
    expect(tab.model.getText()).toBe('my local edit');

    // The updated baseline (mtime 2) means the next save is no longer blocked.
    await controller.saveActive();
    expect(fs.files.get('/docs/a.md')).toBe('my local edit');
  });
});

describe('note-tab external-change protection', () => {
  /** New note with text, flushed once so it has a path and an armed baseline. */
  async function flushedNote(controller: ReturnType<typeof makeController>) {
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Idea', 'cm6');
    await controller.flushNow();
    const tab = tabs.tabsStore.getState().tabs[0]!;
    return { id: tab.id, notePath: tab.notePath! };
  }

  test('a flush records the written note file mtime as the conflict baseline', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const { notePath } = await flushedNote(controller);

    expect(tabs.tabsStore.getState().tabs[0]!.savedMtimeMs).toBe(fs.mtimes.get(notePath));
  });

  test('an externally changed note raises the banner and the flush leaves the file alone', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const { id, notePath } = await flushedNote(controller);

    fs.files.set(notePath, 'change made in vim');
    fs.mtimes.set(notePath, 999);
    tabs.tabsStore.getState().tabs[0]!.model.pushText('# Idea\ntyped more', 'cm6');
    await controller.flushNow();

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.conflict).toBe(true);
    expect(fs.files.get(notePath)).toBe('change made in vim'); // NOT clobbered
    expect(tab.model.getText()).toBe('# Idea\ntyped more'); // edits kept in memory

    // Still not clobbered by later flushes while the banner stands.
    await controller.flushNow();
    expect(fs.files.get(notePath)).toBe('change made in vim');
  });

  test('checkAllFileConflicts flags an externally changed note without any typing', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const { id, notePath } = await flushedNote(controller);

    fs.files.set(notePath, 'change made in vim');
    fs.mtimes.set(notePath, 999);
    await controller.checkAllFileConflicts();

    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.conflict).toBe(true);
  });

  test('an mtime-only touch of a note is adopted silently and the flush proceeds', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const { id, notePath } = await flushedNote(controller);

    fs.mtimes.set(notePath, 999); // content unchanged
    tabs.tabsStore
      .getState()
      .tabs.find((t) => t.id === id)!
      .model.pushText('# Idea\nv2', 'cm6');
    await controller.flushNow();

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.conflict).toBe(false);
    expect(fs.files.get(notePath)).toBe('# Idea\nv2'); // write went through
  });

  test('reload on a conflicted note pulls the external content in', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const { id, notePath } = await flushedNote(controller);
    fs.files.set(notePath, 'change made in vim');
    fs.mtimes.set(notePath, 999);
    await controller.checkAllFileConflicts();

    await controller.reloadFromDisk(id);

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.model.getText()).toBe('change made in vim');
    expect(tab.conflict).toBe(false);
    expect(tab.savedMtimeMs).toBe(999);
  });

  test('keep-mine on a conflicted note lets the next flush overwrite deliberately', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs);
    const { id, notePath } = await flushedNote(controller);
    fs.files.set(notePath, 'change made in vim');
    fs.mtimes.set(notePath, 999);
    tabs.tabsStore
      .getState()
      .tabs.find((t) => t.id === id)!
      .model.pushText('# Idea\nv2', 'cm6');
    await controller.flushNow();
    expect(fs.files.get(notePath)).toBe('change made in vim'); // blocked while conflicted

    await controller.keepMine(id);
    await controller.flushNow();

    const tab = tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.conflict).toBe(false);
    expect(fs.files.get(notePath)).toBe('# Idea\nv2'); // user chose their version
  });

  test('restore arms the note baseline from the read, so later changes are caught', async () => {
    const manifest = {
      schema: 1,
      activeTabId: 'n1',
      tabs: [
        {
          id: 'n1',
          kind: 'note',
          notePath: '/notes/idea.md',
          filePath: null,
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: 5, // stale manifest value; the restore read re-arms it
          hasBuffer: false,
          cursor: null,
        },
      ],
    };
    const fs = makeFakeFs({
      [`${SESSION}/session.json`]: JSON.stringify(manifest),
      '/notes/idea.md': 'on disk',
    });
    fs.mtimes.set('/notes/idea.md', 777);
    const controller = makeController(fs);
    await controller.restore();
    expect(tabs.tabsStore.getState().tabs[0]!.savedMtimeMs).toBe(777);
    expect(tabs.tabsStore.getState().tabs[0]!.conflict).toBe(false);

    fs.files.set('/notes/idea.md', 'change made in vim');
    fs.mtimes.set('/notes/idea.md', 888);
    await controller.checkAllFileConflicts();

    expect(tabs.tabsStore.getState().tabs[0]!.conflict).toBe(true);
  });
});

describe('closeTabInteractive — dirty file tabs (M3)', () => {
  test('Cancel leaves the tab open', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    const controller = makeController(fs, () => 111, { saveDiscardCancel: async () => 'cancel' });
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().activeTab()!.model.pushText('edit', 'cm6');

    await controller.closeTabInteractive(id);

    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === id)).toBe(true);
  });

  test('Discard closes the tab without writing the file', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    const controller = makeController(fs, () => 111, { saveDiscardCancel: async () => 'discard' });
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().activeTab()!.model.pushText('edit', 'cm6');

    await controller.closeTabInteractive(id);

    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === id)).toBe(false);
    expect(fs.files.get('/docs/a.md')).toBe('x');
  });

  test('Save writes the file, then closes the tab', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    const controller = makeController(fs, () => 111, { saveDiscardCancel: async () => 'save' });
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().activeTab()!.model.pushText('edit', 'cm6');

    await controller.closeTabInteractive(id);

    expect(fs.files.get('/docs/a.md')).toBe('edit');
    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === id)).toBe(false);
  });

  test('a save blocked by a conflict keeps the tab open', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'x' });
    fs.mtimes.set('/docs/a.md', 1);
    const controller = makeController(fs, () => 111, { saveDiscardCancel: async () => 'save' });
    await controller.openPaths(['/docs/a.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().activeTab()!.model.pushText('edit', 'cm6');
    fs.files.set('/docs/a.md', 'external edit');
    fs.mtimes.set('/docs/a.md', 999);

    await controller.closeTabInteractive(id);

    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === id)).toBe(true);
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.conflict).toBe(true);
  });
});

describe('changeNotesDir (M6)', () => {
  test('moves existing notes, updates the setting, retargets tabs, and writes to the new dir', async () => {
    const fs = makeFakeFs();
    const settings = await import('../stores/settings');
    const controller = makeController(fs, () => 111, {
      pickDirectory: async () => '/new-notes',
      confirm: async () => true,
    });
    // Create a note and flush so it exists on disk and the listing is seeded.
    tabs.tabsStore.getState().tabs[0]!.model.pushText('Note one', 'cm6');
    await controller.flushNow();
    expect(fs.files.has(`${NOTES}/note-one.md`)).toBe(true);

    await controller.changeNotesDir();

    // File physically moved; the setting and the tab's notePath both followed.
    expect(fs.files.has(`${NOTES}/note-one.md`)).toBe(false);
    expect(fs.files.get('/new-notes/note-one.md')).toBe('Note one');
    expect(settings.settingsStore.getState().settings.notesDir).toBe('/new-notes');
    expect(tabs.tabsStore.getState().tabs[0]!.notePath).toBe('/new-notes/note-one.md');

    // The next flush writes into the new directory (edit a later line so the
    // title-derived slug — and thus the filename — stays 'note-one').
    tabs.tabsStore.getState().tabs[0]!.model.pushText('Note one\nmore text', 'cm6');
    await controller.flushNow();
    expect(fs.files.get('/new-notes/note-one.md')).toBe('Note one\nmore text');
  });

  test('a file that cannot be moved is left behind; the switch still happens', async () => {
    const fs = makeFakeFs();
    const settings = await import('../stores/settings');
    const controller = makeController(fs, () => 111, {
      pickDirectory: async () => '/new-notes',
      confirm: async () => true,
    });
    tabs.tabsStore.getState().tabs[0]!.model.pushText('Note one', 'cm6');
    await controller.flushNow();
    // A name collision at the destination makes renamePath throw EXISTS.
    fs.files.set('/new-notes/note-one.md', 'pre-existing');

    await controller.changeNotesDir();

    // Left behind in the old dir; destination untouched; setting still switched.
    expect(fs.files.get(`${NOTES}/note-one.md`)).toBe('Note one');
    expect(fs.files.get('/new-notes/note-one.md')).toBe('pre-existing');
    expect(settings.settingsStore.getState().settings.notesDir).toBe('/new-notes');
    // The tab keeps its old notePath since the move failed.
    expect(tabs.tabsStore.getState().tabs[0]!.notePath).toBe(`${NOTES}/note-one.md`);
  });

  test('declining the move switches the dir without touching files', async () => {
    const fs = makeFakeFs();
    const settings = await import('../stores/settings');
    const controller = makeController(fs, () => 111, {
      pickDirectory: async () => '/new-notes',
      confirm: async () => false,
    });
    tabs.tabsStore.getState().tabs[0]!.model.pushText('Note one', 'cm6');
    await controller.flushNow();

    await controller.changeNotesDir();

    expect(fs.files.has(`${NOTES}/note-one.md`)).toBe(true);
    expect(fs.ops.some((o) => o.startsWith('rename:'))).toBe(false);
    expect(settings.settingsStore.getState().settings.notesDir).toBe('/new-notes');
  });

  test('cancelling the folder picker is a no-op', async () => {
    const fs = makeFakeFs();
    const settings = await import('../stores/settings');
    const before = settings.settingsStore.getState().settings.notesDir;
    const controller = makeController(fs, () => 111, { pickDirectory: async () => null });

    await controller.changeNotesDir();

    expect(settings.settingsStore.getState().settings.notesDir).toBe(before);
  });
});

describe('insertFileLink (file/image links)', () => {
  /** Register a stub source adapter for `tabId` that records insertLinkTo calls. */
  async function stubAdapter(tabId: string) {
    const registry = await import('../editor-registry');
    const calls: Array<{ label: string; url: string; image: boolean }> = [];
    registry.registerSourceAdapter(tabId, {
      attach() {},
      detach() {},
      focus() {},
      revealLine() {},
      getTopLine: () => null,
      getCaretLine: () => null,
      scrollToLine() {},
      getSelection: () => ({ anchor: 0, head: 0 }),
      setSelection() {},
      setWordWrap() {},
      setLineNumbers() {},
      setFontSize() {},
      format() {},
      insertLinkTo: (label, url, image) => calls.push({ label, url, image }),
      insertText: () => {},
      flashRanges() {},
      clearFlash() {},
      setLinkedRanges() {},
      revealRange() {},
      subscribeSelection: () => () => {},
    });
    return calls;
  }

  test('inserts a path relative to the current document by default', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs, () => 111, {
      pickFile: async () => `${NOTES}/pics/a.png`,
    });
    // Flush so the note tab gets a notePath under NOTES to be relative to.
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Trip', 'cm6');
    await controller.flushNow();
    const calls = await stubAdapter(t.id);

    session.insertFileLink({ image: true, absolute: false });
    await Promise.resolve(); // let the async dispatch settle

    expect(calls).toEqual([{ label: 'a', url: './pics/a.png', image: true }]);
  });

  test('Alt-click (absolute) inserts the forward-slashed absolute path', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs, () => 111, {
      pickFile: async () => 'C:\\media\\a.png',
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Trip', 'cm6');
    await controller.flushNow();
    const calls = await stubAdapter(t.id);

    session.insertFileLink({ image: false, absolute: true });
    await Promise.resolve();

    expect(calls).toEqual([{ label: 'a', url: 'C:/media/a.png', image: false }]);
  });

  test('an unsaved note with no directory falls back to an absolute path', async () => {
    const fs = makeFakeFs();
    // Created only for its dispatch registration side effect.
    makeController(fs, () => 111, { pickFile: async () => '/media/a.png' });
    const t = tabs.tabsStore.getState().tabs[0]!; // never flushed → notePath null
    const calls = await stubAdapter(t.id);

    session.insertFileLink({ image: false, absolute: false });
    await Promise.resolve();

    expect(calls).toEqual([{ label: 'a', url: '/media/a.png', image: false }]);
  });

  test('does nothing in WYSIWYG mode (no source editor to target)', async () => {
    const fs = makeFakeFs();
    makeController(fs, () => 111, { pickFile: async () => '/media/a.png' });
    const t = tabs.tabsStore.getState().tabs[0]!;
    tabs.tabsStore.setState({
      tabs: tabs.tabsStore
        .getState()
        .tabs.map((x) => (x.id === t.id ? { ...x, mode: 'wysiwyg' } : x)),
    });
    const calls = await stubAdapter(t.id);

    session.insertFileLink({ image: false, absolute: false });
    await Promise.resolve();

    expect(calls).toEqual([]);
  });

  test('cancelling the picker inserts nothing', async () => {
    const fs = makeFakeFs();
    makeController(fs, () => 111, { pickFile: async () => null });
    const t = tabs.tabsStore.getState().tabs[0]!;
    const calls = await stubAdapter(t.id);

    session.insertFileLink({ image: false, absolute: false });
    await Promise.resolve();

    expect(calls).toEqual([]);
  });
});

describe('preview tabs (openPaths)', () => {
  test('a preview open replaces the current preview tab in place', async () => {
    const fs = makeFakeFs({ '/ws/a.md': 'A', '/ws/b.md': 'B' });
    const controller = makeController(fs);

    await controller.openPaths(['/ws/a.md'], { preview: true });
    const previewA = tabs.tabsStore.getState().activeTab()!;
    expect(previewA.preview).toBe(true);
    const count = tabs.tabsStore.getState().tabs.length;

    await controller.openPaths(['/ws/b.md'], { preview: true });

    // Same count (slot reused); the first preview tab is gone; b is preview.
    expect(tabs.tabsStore.getState().tabs).toHaveLength(count);
    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === previewA.id)).toBe(false);
    const active = tabs.tabsStore.getState().activeTab()!;
    expect(active.filePath).toBe('/ws/b.md');
    expect(active.preview).toBe(true);
  });

  test('an edited preview tab is promoted, so the next preview opens a new tab', async () => {
    const fs = makeFakeFs({ '/ws/a.md': 'A', '/ws/b.md': 'B' });
    const controller = makeController(fs);

    await controller.openPaths(['/ws/a.md'], { preview: true });
    const previewA = tabs.tabsStore.getState().activeTab()!;
    previewA.model.pushText('A edited', 'cm6'); // promotes it to permanent
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === previewA.id)!.preview).toBe(false);
    const count = tabs.tabsStore.getState().tabs.length;

    await controller.openPaths(['/ws/b.md'], { preview: true });

    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === previewA.id)).toBe(true);
    expect(tabs.tabsStore.getState().tabs).toHaveLength(count + 1);
  });

  test('a non-preview re-open of the preview tab promotes it (explorer double-click)', async () => {
    const fs = makeFakeFs({ '/ws/a.md': 'A' });
    const controller = makeController(fs);

    await controller.openPaths(['/ws/a.md'], { preview: true });
    const id = tabs.tabsStore.getState().activeTabId;
    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.preview).toBe(true);

    await controller.openPaths(['/ws/a.md']); // pinned re-open

    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.preview).toBe(false);
  });
});

describe('multi-window tear-off (M8)', () => {
  test('moveTabToNewWindow flushes, detaches, and hands the descriptor to the spawner', async () => {
    const fs = makeFakeFs();
    const spawned: Array<{ manifest: unknown; pos: { x: number; y: number } | null }> = [];
    const controller = makeController(fs, () => 111, {
      spawnTabWindow: async (manifest, pos) => {
        spawned.push({ manifest, pos });
        return 'w-spawned';
      },
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Torn off', 'cm6');

    await controller.moveTabToNewWindow(t.id, { x: 10, y: 20 });

    // The note was flushed to disk BEFORE the handoff and was NOT deleted.
    expect(fs.files.get(`${NOTES}/torn-off.md`)).toBe('# Torn off');
    // The descriptor references it, and the drop position travelled along.
    expect(spawned).toHaveLength(1);
    const manifest = spawned[0]!.manifest as {
      schema: number;
      activeTabId: string;
      tabs: Array<{ id: string; notePath: string | null }>;
    };
    expect(manifest.schema).toBe(1);
    expect(manifest.activeTabId).toBe(t.id);
    expect(manifest.tabs[0]!.notePath).toBe(`${NOTES}/torn-off.md`);
    expect(spawned[0]!.pos).toEqual({ x: 10, y: 20 });
    // Detached here (a fresh Untitled took its place) …
    expect(tabs.tabsStore.getState().tabs.some((x) => x.id === t.id)).toBe(false);
    // … and this window's manifest no longer claims it (written before spawn).
    const written = JSON.parse(fs.files.get(`${SESSION}/session.json`)!) as {
      tabs: Array<{ id: string }>;
    };
    expect(written.tabs.some((x) => x.id === t.id)).toBe(false);
  });

  test('a dirty file tab travels with hasBuffer, its buffer intact on disk', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'original' });
    const spawned: Array<{ tabs: Array<{ id: string; hasBuffer: boolean }> }> = [];
    const controller = makeController(fs, () => 111, {
      spawnTabWindow: async (manifest) => {
        spawned.push(manifest as never);
        return 'w-spawned';
      },
    });
    await controller.openPaths(['/docs/a.md']);
    const t = tabs.tabsStore.getState().activeTab()!;
    t.model.pushText('unsaved edit', 'cm6');

    await controller.moveTabToNewWindow(t.id, null);

    expect(spawned[0]!.tabs[0]!.hasBuffer).toBe(true);
    // The session buffer survives the detach for the new window to read.
    expect(fs.files.get(`${SESSION}/buffers/${t.id}.md`)).toBe('unsaved edit');
    expect(fs.files.get('/docs/a.md')).toBe('original'); // never force-saved
  });

  test('a failed window spawn adopts the tab right back', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs, () => 111, {
      spawnTabWindow: async () => {
        throw new Error('boom');
      },
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Keep me', 'cm6');

    await controller.moveTabToNewWindow(t.id, null);

    const back = tabs.tabsStore.getState().tabs.find((x) => x.id === t.id);
    expect(back).toBeDefined();
    expect(back!.model.getText()).toBe('# Keep me');
    expect(back!.notePath).toBe(`${NOTES}/keep-me.md`);
  });

  test('dropTabOut hands the tab to the window under the cursor instead of spawning', async () => {
    const fs = makeFakeFs();
    const spawned: unknown[] = [];
    const sent: Array<{ label: string; tabs: Array<{ id: string; notePath: string | null }> }> = [];
    const controller = makeController(fs, () => 111, {
      spawnTabWindow: async (manifest) => {
        spawned.push(manifest);
        return 'w-spawned';
      },
      findDropWindow: async () => 'w-target',
      sendTabsToWindow: async (label, tabs) => {
        sent.push({ label, tabs: tabs as never });
        return true;
      },
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Dropped on', 'cm6');

    await controller.dropTabOut(t.id, { x: 10, y: 20 });

    // Flushed to disk before the handover, descriptor delivered to the target.
    expect(fs.files.get(`${NOTES}/dropped-on.md`)).toBe('# Dropped on');
    expect(sent).toEqual([{ label: 'w-target', tabs: [expect.objectContaining({ id: t.id })] }]);
    expect(spawned).toHaveLength(0);
    // Detached here, and this window's manifest no longer claims it.
    expect(tabs.tabsStore.getState().tabs.some((x) => x.id === t.id)).toBe(false);
    const written = JSON.parse(fs.files.get(`${SESSION}/session.json`)!) as {
      tabs: Array<{ id: string }>;
    };
    expect(written.tabs.some((x) => x.id === t.id)).toBe(false);
  });

  test('dropTabOut over no window tears off a new one at pos', async () => {
    const fs = makeFakeFs();
    const spawned: Array<{ pos: { x: number; y: number } | null }> = [];
    const controller = makeController(fs, () => 111, {
      spawnTabWindow: async (_manifest, pos) => {
        spawned.push({ pos });
        return 'w-spawned';
      },
      findDropWindow: async () => null,
      sendTabsToWindow: async () => {
        throw new Error('must not be called');
      },
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Torn off instead', 'cm6');

    await controller.dropTabOut(t.id, { x: 10, y: 20 });

    expect(spawned).toEqual([{ pos: { x: 10, y: 20 } }]);
    expect(tabs.tabsStore.getState().tabs.some((x) => x.id === t.id)).toBe(false);
  });

  test('a failed drop hit-test degrades to the tear-off', async () => {
    const fs = makeFakeFs();
    const spawned: unknown[] = [];
    const controller = makeController(fs, () => 111, {
      spawnTabWindow: async (manifest) => {
        spawned.push(manifest);
        return 'w-spawned';
      },
      findDropWindow: async () => {
        throw new Error('no global coords');
      },
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Still moves', 'cm6');

    await controller.dropTabOut(t.id, null);

    expect(spawned).toHaveLength(1);
  });

  test('an unacknowledged handover adopts the tab right back', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs, () => 111, {
      spawnTabWindow: async () => 'w-spawned',
      findDropWindow: async () => 'w-gone',
      sendTabsToWindow: async () => false,
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Keep me here', 'cm6');

    await controller.dropTabOut(t.id, null);

    const back = tabs.tabsStore.getState().tabs.find((x) => x.id === t.id);
    expect(back).toBeDefined();
    expect(back!.model.getText()).toBe('# Keep me here');
    expect(back!.notePath).toBe(`${NOTES}/keep-me-here.md`);
  });

  test('moveTabToWindow (the context-menu route) hands the tab straight to a named window', async () => {
    const fs = makeFakeFs();
    const sent: Array<{ label: string; ids: string[] }> = [];
    const controller = makeController(fs, () => 111, {
      spawnTabWindow: async () => {
        throw new Error('must not spawn');
      },
      sendTabsToWindow: async (label, descriptors) => {
        sent.push({ label, ids: descriptors.map((d) => d.id) });
        return true;
      },
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Sent by menu', 'cm6');

    await controller.moveTabToWindow(t.id, 'w-picked');

    expect(sent).toEqual([{ label: 'w-picked', ids: [t.id] }]);
    expect(tabs.tabsStore.getState().tabs.some((x) => x.id === t.id)).toBe(false);
    expect(fs.files.get(`${NOTES}/sent-by-menu.md`)).toBe('# Sent by menu');
  });

  test('a live tear-off resolves with the spawned label and spawns unfocused on request', async () => {
    const fs = makeFakeFs();
    const focusSeen: Array<boolean | undefined> = [];
    makeController(fs, () => 111, {
      spawnTabWindow: async (_manifest, _pos, opts) => {
        focusSeen.push(opts?.focus);
        return 'w-live';
      },
    });
    const t = tabs.tabsStore.getState().tabs[0]!;
    t.model.pushText('# Rides the cursor', 'cm6');

    const label = await session.tearOffTab(t.id, { x: 5, y: 6 }, { focus: false });

    expect(label).toBe('w-live');
    expect(focusSeen).toEqual([false]);
    expect(tabs.tabsStore.getState().tabs.some((x) => x.id === t.id)).toBe(false);
  });

  test('dropTornWindow over another window commands the torn-off window to merge there', async () => {
    const commands: Array<{ label: string; target: string }> = [];
    const focused: string[] = [];
    const excludes: Array<string | undefined> = [];
    const controller = makeController(makeFakeFs(), () => 111, {
      spawnTabWindow: async () => 'w-live',
      findDropWindow: async (excludeLabel) => {
        excludes.push(excludeLabel);
        return 'w-target';
      },
      commandTornWindowDrop: (label, target) => commands.push({ label, target }),
      focusWindow: (label) => focused.push(label),
    });

    await controller.dropTornWindow('w-live');

    // The window riding the cursor must not win its own hit-test.
    expect(excludes).toEqual(['w-live']);
    expect(commands).toEqual([{ label: 'w-live', target: 'w-target' }]);
    expect(focused).toEqual([]);
  });

  test('dropTornWindow over empty desktop just focuses the torn-off window', async () => {
    const commands: unknown[] = [];
    const focused: string[] = [];
    const controller = makeController(makeFakeFs(), () => 111, {
      spawnTabWindow: async () => 'w-live',
      findDropWindow: async () => null,
      commandTornWindowDrop: (label, target) => commands.push({ label, target }),
      focusWindow: (label) => focused.push(label),
    });

    await controller.dropTornWindow('w-live');

    expect(commands).toEqual([]);
    expect(focused).toEqual(['w-live']);
  });

  test('a torn-off window restores from its handed-over manifest and writes its own file', async () => {
    const fs = makeFakeFs({ [`${NOTES}/torn.md`]: '# Torn' });
    const controller = makeController(fs, () => 111, {
      isMain: false,
      manifestName: 'session-w-abc.json',
      initialManifest: {
        schema: 1,
        activeTabId: 'tab1',
        tabs: [
          {
            id: 'tab1',
            kind: 'note',
            notePath: `${NOTES}/torn.md`,
            filePath: null,
            customTitle: null,
            mode: 'raw',
            savedMtimeMs: null,
            hasBuffer: false,
            cursor: { anchor: 3, head: 3 },
          },
        ],
      },
    });

    await controller.restore();

    const t = tabs.tabsStore.getState().tabs[0]!;
    expect(t.id).toBe('tab1');
    expect(t.model.getText()).toBe('# Torn');
    expect(session.getCursor('tab1')).toEqual({ anchor: 3, head: 3 });

    await controller.flushNow();
    expect(fs.files.has(`${SESSION}/session-w-abc.json`)).toBe(true);
    expect(fs.files.has(`${SESSION}/session.json`)).toBe(false);
  });

  test('a secondary window with no manifest starts fresh — never reopens recent notes', async () => {
    const fs = makeFakeFs({ [`${NOTES}/mains-note.md`]: 'owned by the main window' });
    const controller = makeController(fs, () => 111, {
      isMain: false,
      manifestName: 'session-w-abc.json',
    });

    await controller.restore();

    const s = tabs.tabsStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.notePath).toBeNull();
    expect(s.tabs[0]!.model.getText()).toBe('');
  });

  test('adoptTabs takes a file tab as a mirror but skips a note some tab here owns', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'A', [`${NOTES}/other.md`]: 'other' });
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const count = tabs.tabsStore.getState().tabs.length;

    await controller.adoptTabs([
      {
        id: 'dup',
        kind: 'file',
        notePath: null,
        filePath: '/docs/a.md',
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: 1,
        hasBuffer: false,
        cursor: null,
      },
      {
        id: 'fresh',
        kind: 'note',
        notePath: `${NOTES}/other.md`,
        filePath: null,
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: null,
        hasBuffer: false,
        cursor: null,
      },
    ]);

    const s = tabs.tabsStore.getState();
    // Tab sync: a second tab on an open FILE is a mirror, not a duplicate owner.
    expect(s.tabs.some((t) => t.id === 'dup')).toBe(true);
    expect(s.tabs.some((t) => t.id === 'fresh')).toBe(true);
    expect(s.tabs).toHaveLength(count + 2);

    // A note's file follows exactly one tab — a second claim is still dropped.
    await controller.adoptTabs([
      {
        id: 'dup-note',
        kind: 'note',
        notePath: `${NOTES}/other.md`,
        filePath: null,
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: null,
        hasBuffer: false,
        cursor: null,
      },
    ]);
    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === 'dup-note')).toBe(false);
  });

  test('exportTabsForHandoff flushes, drops the pristine Untitled, and reports buffers', async () => {
    const fs = makeFakeFs({ '/docs/a.md': 'original' });
    const controller = makeController(fs);
    await controller.openPaths(['/docs/a.md']);
    const fileTab = tabs.tabsStore.getState().activeTab()!;
    fileTab.model.pushText('unsaved edit', 'cm6');

    const out = await controller.exportTabsForHandoff();

    // The initial empty Untitled was dropped; only the file tab travels.
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(fileTab.id);
    expect(out[0]!.hasBuffer).toBe(true);
    expect(fs.files.get(`${SESSION}/buffers/${fileTab.id}.md`)).toBe('unsaved edit');
  });

  test('discardManifest deletes this window’s manifest file', async () => {
    const fs = makeFakeFs();
    const controller = makeController(fs, () => 111, {
      isMain: false,
      manifestName: 'session-w-abc.json',
    });
    await controller.restore();
    await controller.flushNow();
    expect(fs.files.has(`${SESSION}/session-w-abc.json`)).toBe(true);

    await controller.discardManifest();

    expect(fs.files.has(`${SESSION}/session-w-abc.json`)).toBe(false);
  });

  const tornManifest = {
    schema: 1 as const,
    activeTabId: 'tab1',
    tabs: [
      {
        id: 'tab1',
        kind: 'note' as const,
        notePath: `${NOTES}/torn.md`,
        filePath: null,
        customTitle: null,
        mode: 'raw' as const,
        savedMtimeMs: null,
        hasBuffer: false,
        cursor: null,
      },
    ],
  };

  const mainsManifest = (notePath: string) => ({
    schema: 1 as const,
    activeTabId: 'm1',
    tabs: [
      {
        id: 'm1',
        kind: 'note' as const,
        notePath,
        filePath: null,
        customTitle: null,
        mode: 'raw' as const,
        savedMtimeMs: null,
        hasBuffer: false,
        cursor: null,
      },
    ],
  });

  test('bequeathTabsToMain folds a last-standing window’s tabs into session.json', async () => {
    const fs = makeFakeFs({
      [`${NOTES}/torn.md`]: '# Torn',
      [`${NOTES}/mains.md`]: 'main note',
      [`${SESSION}/session.json`]: JSON.stringify(mainsManifest(`${NOTES}/mains.md`)),
    });
    const controller = makeController(fs, () => 111, {
      isMain: false,
      manifestName: 'session-w-abc.json',
      initialManifest: tornManifest,
    });
    await controller.restore();
    await controller.flushNow();

    const out = await controller.exportTabsForHandoff();
    await controller.bequeathTabsToMain(out);

    // Our manifest is gone — this window will NOT resurrect next launch …
    expect(fs.files.has(`${SESSION}/session-w-abc.json`)).toBe(false);
    // … and session.json now holds main's tabs plus ours, focused on ours.
    const merged = JSON.parse(fs.files.get(`${SESSION}/session.json`)!) as {
      activeTabId: string;
      tabs: Array<{ id: string }>;
    };
    expect(merged.tabs.map((t) => t.id)).toEqual(['m1', 'tab1']);
    expect(merged.activeTabId).toBe('tab1');
  });

  test('bequeathTabsToMain with no session.json makes these tabs the whole session', async () => {
    const fs = makeFakeFs({ [`${NOTES}/torn.md`]: '# Torn' });
    const controller = makeController(fs, () => 111, {
      isMain: false,
      manifestName: 'session-w-abc.json',
      initialManifest: tornManifest,
    });
    await controller.restore();
    await controller.flushNow();

    await controller.bequeathTabsToMain(await controller.exportTabsForHandoff());

    expect(fs.files.has(`${SESSION}/session-w-abc.json`)).toBe(false);
    const merged = JSON.parse(fs.files.get(`${SESSION}/session.json`)!) as {
      activeTabId: string;
      tabs: Array<{ id: string }>;
    };
    expect(merged.tabs.map((t) => t.id)).toEqual(['tab1']);
    expect(merged.activeTabId).toBe('tab1');
  });

  test('bequeathTabsToMain skips a file session.json already owns', async () => {
    const fs = makeFakeFs({
      [`${NOTES}/torn.md`]: '# Torn',
      // Main's manifest already claims the very note this window holds.
      [`${SESSION}/session.json`]: JSON.stringify(mainsManifest(`${NOTES}/torn.md`)),
    });
    const controller = makeController(fs, () => 111, {
      isMain: false,
      manifestName: 'session-w-abc.json',
      initialManifest: tornManifest,
    });
    await controller.restore();
    await controller.flushNow();

    await controller.bequeathTabsToMain(await controller.exportTabsForHandoff());

    expect(fs.files.has(`${SESSION}/session-w-abc.json`)).toBe(false);
    const merged = JSON.parse(fs.files.get(`${SESSION}/session.json`)!) as {
      activeTabId: string;
      tabs: Array<{ id: string }>;
    };
    // One owner per file: the duplicate was dropped, main's focus preserved.
    expect(merged.tabs.map((t) => t.id)).toEqual(['m1']);
    expect(merged.activeTabId).toBe('m1');
  });
});

describe('closeAllTabsInteractive', () => {
  test('closes every tab, leaving one fresh Untitled', async () => {
    const fs = makeFakeFs({ '/ws/a.md': 'A', '/ws/b.md': 'B' });
    const controller = makeController(fs);
    await controller.openPaths(['/ws/a.md']);
    await controller.openPaths(['/ws/b.md']);
    expect(tabs.tabsStore.getState().tabs.length).toBeGreaterThan(1);

    await controller.closeAllTabsInteractive();

    const remaining = tabs.tabsStore.getState().tabs;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.kind).toBe('note');
    expect(remaining[0]!.model.getText()).toBe('');
  });

  test('a cancel on a dirty file tab stops the sweep', async () => {
    const fs = makeFakeFs({ '/ws/a.md': 'A' });
    // The default saveDiscardCancel stub returns 'cancel'.
    const controller = makeController(fs);
    await controller.openPaths(['/ws/a.md']);
    const fileTab = tabs.tabsStore.getState().activeTab()!;
    fileTab.model.pushText('A edited', 'cm6'); // now dirty

    await controller.closeAllTabsInteractive();

    expect(tabs.tabsStore.getState().tabs.some((t) => t.id === fileTab.id)).toBe(true);
  });
});

describe('openPaths — importable documents', () => {
  test('a recognized document opens a read-only import card, no dialog', async () => {
    const fs = makeFakeFs({ '/notes/report.pdf': 'fake-pdf' });
    const confirm = vi.fn(async () => true);
    const controller = makeController(fs, () => 111, { confirm });

    await controller.openPaths(['/notes/report.pdf']);

    // No confirm dialog; an import tab now owns the document and nothing was
    // converted just by opening it.
    expect(confirm).not.toHaveBeenCalled();
    const tab = tabs.tabsStore.getState().tabs.find((t) => t.filePath === '/notes/report.pdf');
    expect(tab?.kind).toBe('import');
    expect([...fs.files.keys()].some((p) => p.endsWith('.md'))).toBe(false);
  });

  test('clicking the same document twice focuses the one import tab', async () => {
    const fs = makeFakeFs({ '/notes/memo.docx': 'fake-docx' });
    const controller = makeController(fs);

    await controller.openPaths(['/notes/memo.docx'], { preview: true });
    await controller.openPaths(['/notes/memo.docx']); // pinned re-open

    const importTabs = tabs.tabsStore.getState().tabs.filter((t) => t.kind === 'import');
    expect(importTabs).toHaveLength(1);
    // The non-preview re-open promoted the preview card to a permanent tab.
    expect(importTabs[0]!.preview).toBe(false);
  });

  test('checkImportStatus reports the target note and whether it exists', async () => {
    const fs = makeFakeFs({ '/notes/report.pdf': 'fake-pdf' });
    makeController(fs); // wires the module-level dispatch

    expect(await session.checkImportStatus('/notes/report.pdf')).toEqual({
      mdPath: '/notes/report.md',
      imported: false,
    });

    fs.files.set('/notes/report.md', 'the note');
    expect(await session.checkImportStatus('/notes/report.pdf')).toEqual({
      mdPath: '/notes/report.md',
      imported: true,
    });
  });

  test('checkImportStatus does not derive a name-based status from a content:// id', async () => {
    // A content:// URI's tail is an opaque document id, not a filename, so the
    // "already exists" check would be meaningless — report not-imported/no name.
    const fs = makeFakeFs({});
    makeController(fs);

    expect(await session.checkImportStatus('content://com.android.providers/doc/1234')).toEqual({
      mdPath: '',
      imported: false,
    });
  });

  test('importing is skipped when a note with the same basename already exists', async () => {
    // report.md is already present; importing report.pdf must not create a
    // suffixed duplicate (report-2.md) — the real converter is never even
    // reached (it would choke on the fake bytes).
    const fs = makeFakeFs({ '/notes/report.md': 'the real note', '/notes/report.pdf': 'fake-pdf' });
    makeController(fs); // wires importDocumentInto's dispatch

    await session.importDocumentInto('/notes', '/notes/report.pdf');

    const mdFiles = [...fs.files.keys()].filter((p) => p.endsWith('.md'));
    expect(mdFiles).toEqual(['/notes/report.md']);
    expect(fs.files.get('/notes/report.md')).toBe('the real note'); // untouched
  });

  test('an import tab persists and restore rebuilds it (dropping a gone file)', async () => {
    const fs = makeFakeFs({ '/notes/a.pdf': 'fake-pdf', '/notes/b.pdf': 'fake-pdf' });
    const controller = makeController(fs);
    await controller.openPaths(['/notes/a.pdf', '/notes/b.pdf']);
    await controller.flushNow();

    const manifest = JSON.parse(fs.files.get(`${SESSION}/session.json`)!) as {
      tabs: { kind: string; filePath: string | null }[];
    };
    expect(manifest.tabs.find((t) => t.filePath === '/notes/a.pdf')?.kind).toBe('import');

    fs.files.delete('/notes/b.pdf');
    const fresh = makeController(fs);
    await fresh.restore();

    const restored = tabs.tabsStore.getState().tabs;
    expect(restored.some((t) => t.kind === 'import' && t.filePath === '/notes/a.pdf')).toBe(true);
    expect(restored.some((t) => t.filePath === '/notes/b.pdf')).toBe(false);
  });
});
