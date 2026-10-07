import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Controllable platform: the store seeds lastFileMode differently on mobile
 * (reads first). Default desktop; the mobile cases flip the flag and re-import.
 */
const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../platform', () => ({
  isMobile: () => platform.mobile,
  isAndroid: () => platform.mobile,
  isAndroidUA: (ua: string) => /Android/i.test(ua),
  detectRuntime: () => (platform.mobile ? 'android' : 'desktop'),
}));

/**
 * Workspace cues come from live app state (settings + the resolved notes dir).
 * The store only needs "which workspace is this tab in", so the tests stub the
 * resolver with a path-prefix rule and drive the setting directly.
 */
const settings = vi.hoisted(() => ({ groupTabsByWorkspace: false }));
vi.mock('../../workspace-cues', () => ({
  workspaceCueFor: (tab: {
    kind: string;
    filePath: string | null;
    notePath: string | null;
    terminalCwd?: string | null;
  }) => {
    const path = (tab.kind === 'terminal' ? tab.terminalCwd : (tab.filePath ?? tab.notePath)) ?? '';
    for (const root of ['/red', '/blue']) {
      if (path.startsWith(`${root}/`)) {
        return { key: root, color: null };
      }
    }
    return null;
  },
}));
vi.mock('../settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../settings')>();
  return {
    ...actual,
    settingsStore: {
      ...actual.settingsStore,
      getState: () => {
        const real = actual.settingsStore.getState();
        return {
          ...real,
          settings: {
            ...real.settings,
            groupTabsByWorkspace: settings.groupTabsByWorkspace,
            // A second profile, so the label tests can tell "resolved from the
            // recorded profile" apart from "fell back to the only one".
            terminalProfiles: [
              ...real.settings.terminalProfiles,
              { id: 'ssh', name: 'Remote (ssh)', program: 'ssh', args: [], env: {} },
            ],
          },
        };
      },
    },
  };
});

/**
 * The tabs store is a module singleton that self-creates its first tab at
 * import time. We reset the module registry before each test so every case
 * starts from a pristine one-tab store.
 */
type TabsModule = typeof import('../tabs');
let mod: TabsModule;

beforeEach(async () => {
  vi.resetModules();
  settings.groupTabsByWorkspace = false;
  mod = await import('../tabs');
});

function state() {
  return mod.tabsStore.getState();
}
/** Indexed access under noUncheckedIndexedAccess; tests know the tab exists. */
function tabAt(i: number) {
  const tab = state().tabs[i];
  if (!tab) {
    throw new Error(`no tab at index ${i}`);
  }
  return tab;
}

describe('initial state', () => {
  test('opens exactly one Untitled note tab, active', () => {
    const s = state();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(tabAt(0).id);
    expect(tabAt(0).title).toBe('Untitled');
    expect(tabAt(0).kind).toBe('note');
    expect(tabAt(0).wordCount).toBe(0);
    expect(s.renamingTabId).toBeNull();
  });
});

describe('newTab', () => {
  test('appends a tab and makes it active', () => {
    state().newTab();
    expect(state().tabs).toHaveLength(2);
    expect(state().activeTabId).toBe(tabAt(1).id);
  });
});

describe('live title + word count', () => {
  test('title follows the first line until a custom title is set', () => {
    tabAt(0).model.pushText('# Grocery list\nmilk', 'cm6');
    expect(tabAt(0).title).toBe('Grocery list');
    // Whitespace-delimited tokens, markdown syntax included: #, Grocery, list, milk
    expect(tabAt(0).wordCount).toBe(4);
  });

  test('deleting the content reverts the title to Untitled', () => {
    const model = tabAt(0).model;
    model.pushText('# Hello', 'cm6');
    expect(tabAt(0).title).toBe('Hello');
    model.pushText('', 'cm6');
    expect(tabAt(0).title).toBe('Untitled');
    expect(tabAt(0).wordCount).toBe(0);
  });
});

describe('rename override', () => {
  test('a custom title sticks and stops following the first line', () => {
    const id = tabAt(0).id;
    const model = tabAt(0).model;
    state().renameTab(id, 'My Ideas');
    expect(tabAt(0).customTitle).toBe('My Ideas');
    expect(tabAt(0).title).toBe('My Ideas');
    model.pushText('# A different heading', 'cm6');
    expect(tabAt(0).title).toBe('My Ideas');
  });

  test('renaming to blank reverts to the auto-derived title', () => {
    const id = tabAt(0).id;
    tabAt(0).model.pushText('# Derived name', 'cm6');
    state().renameTab(id, 'Custom');
    expect(tabAt(0).title).toBe('Custom');
    state().renameTab(id, '   ');
    expect(tabAt(0).customTitle).toBeNull();
    expect(tabAt(0).title).toBe('Derived name');
  });

  test('beginRename/cancelRename toggle the editing marker', () => {
    const id = tabAt(0).id;
    state().beginRename(id);
    expect(state().renamingTabId).toBe(id);
    state().cancelRename();
    expect(state().renamingTabId).toBeNull();
  });
});

describe('tabDisplayTitle', () => {
  test('a fresh empty note reads "Untitled"', () => {
    expect(mod.tabDisplayTitle(tabAt(0))).toBe('Untitled');
  });

  test('a note shows the slug of its title (matches its note filename)', () => {
    tabAt(0).model.pushText('# My Report', 'cm6');
    expect(mod.tabDisplayTitle(tabAt(0))).toBe('my-report');
  });

  test('a renamed note shows the slug of the custom title', () => {
    tabAt(0).model.pushText('content', 'cm6');
    state().renameTab(tabAt(0).id, 'Budget Q3');
    expect(mod.tabDisplayTitle(tabAt(0))).toBe('budget-q3');
  });

  test('a file tab shows its filename minus extension, casing preserved', () => {
    const id = state().openFileTab({
      filePath: '/notes/Budget Q3.md',
      text: 'hi',
      savedMtimeMs: 1,
    });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(mod.tabDisplayTitle(tab)).toBe('Budget Q3');
  });
});

describe('retargetFilePath', () => {
  test('repoints a file tab and its mtime baseline, leaving content untouched', () => {
    const id = state().openFileTab({ filePath: '/notes/old.md', text: 'body', savedMtimeMs: 1 });
    state().retargetFilePath(id, { filePath: '/notes/new.md', mtimeMs: 42 });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.filePath).toBe('/notes/new.md');
    expect(tab.savedMtimeMs).toBe(42);
    expect(tab.model.getText()).toBe('body');
    expect(mod.tabDisplayTitle(tab)).toBe('new');
  });
});

describe('closeTab bookkeeping', () => {
  test('closing the active tab activates the right neighbor', () => {
    state().newTab();
    state().newTab(); // three tabs: [0,1,2], active = 2
    const middle = tabAt(1);
    state().activateTab(middle.id);
    state().closeTab(middle.id);
    expect(state().tabs).toHaveLength(2);
    // right neighbor (old index 2) becomes active
    expect(state().activeTabId).toBe(tabAt(1).id);
  });

  test('closing a non-active tab leaves the active tab unchanged', () => {
    state().newTab(); // [0,1], active = 1
    const first = tabAt(0).id;
    const active = state().activeTabId;
    state().closeTab(first);
    expect(state().activeTabId).toBe(active);
    expect(state().tabs).toHaveLength(1);
  });

  test('closing the last tab leaves one fresh Untitled tab', () => {
    const originalId = tabAt(0).id;
    tabAt(0).model.pushText('# had content', 'cm6');
    state().closeTab(originalId);
    expect(state().tabs).toHaveLength(1);
    expect(tabAt(0).id).not.toBe(originalId);
    expect(tabAt(0).title).toBe('Untitled');
    expect(state().activeTabId).toBe(tabAt(0).id);
  });
});

describe('activateAdjacent', () => {
  test('cycles forward and wraps around', () => {
    state().newTab();
    state().newTab(); // [0,1,2], active = 2
    state().activateAdjacent(1); // wraps to 0
    expect(state().activeTabId).toBe(tabAt(0).id);
    state().activateAdjacent(-1); // back to 2
    expect(state().activeTabId).toBe(tabAt(2).id);
  });
});

describe('reorderTab', () => {
  test('moves a tab to a new index, preserving identity', () => {
    state().newTab();
    state().newTab(); // [0,1,2]
    const ids = state().tabs.map((t) => t.id);
    state().reorderTab(ids[0]!, 2); // move first to the end
    expect(state().tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
  });
});

describe('setMode', () => {
  test('updates the tab mode without a registered modeSync', () => {
    const id = tabAt(0).id;
    expect(() => state().setMode(id, 'split')).not.toThrow();
    expect(tabAt(0).mode).toBe('split');
  });

  test('registerModeSync stores the sync and setMode drives it', () => {
    const id = tabAt(0).id;
    const calls: string[] = [];
    const fakeSync = {
      getMode: () => 'raw' as const,
      setMode: (m: string) => {
        calls.push(m);
        return Promise.resolve();
      },
      whenIdle: () => Promise.resolve(),
      focus: () => {},
      dispose: () => Promise.resolve(),
    };
    state().registerModeSync(id, fakeSync);
    state().setMode(id, 'wysiwyg');
    expect(calls).toEqual(['wysiwyg']);
  });
});

describe('openFileTab (M3)', () => {
  test('appends a clean file tab and makes it active', () => {
    const id = state().openFileTab({ filePath: '/docs/hi.md', text: '# Hi', savedMtimeMs: 5 });
    expect(state().tabs).toHaveLength(2);
    expect(state().activeTabId).toBe(id);
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.kind).toBe('file');
    expect(tab.filePath).toBe('/docs/hi.md');
    expect(tab.savedMtimeMs).toBe(5);
    expect(tab.title).toBe('Hi');
    expect(tab.dirty).toBe(false);
    expect(tab.model.isDirty('file')).toBe(false);
  });

  test('a newly opened file adopts the last mode the user switched to', () => {
    // Default is 'raw' — the first file opens in it.
    const first = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === first)!.mode).toBe('raw');

    // Switch this file to Review mode, then open another — it inherits Review mode.
    state().setMode(first, 'read');
    const second = state().openFileTab({ filePath: '/docs/b.md', text: 'b', savedMtimeMs: 2 });
    expect(state().tabs.find((t) => t.id === second)!.mode).toBe('read');
  });

  test('an .svg always opens in Draw, even when the last file mode was raw', () => {
    // 'raw' is legal for BOTH families, so inheriting lastFileMode would open
    // a fresh whiteboard as XML source — the phase-5 UAT bug. Draw is the
    // opening mode for a board; Raw is an explicit per-tab switch.
    const md = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === md)!.mode).toBe('raw');
    const svg = state().openFileTab({
      filePath: '/docs/board.svg',
      text: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      savedMtimeMs: 2,
    });
    expect(state().tabs.find((t) => t.id === svg)!.mode).toBe('draw');
  });
});

describe('dirty dot (M3)', () => {
  test('a file tab goes dirty on edit; note tabs never do', () => {
    const id = state().openFileTab({ filePath: '/docs/hi.md', text: 'hi', savedMtimeMs: 1 });
    const fileTab = () => state().tabs.find((t) => t.id === id)!;
    expect(fileTab().dirty).toBe(false);
    fileTab().model.pushText('hi there', 'cm6');
    expect(fileTab().dirty).toBe(true);

    // The original note tab is unaffected by the 'file' persistence kind.
    tabAt(0).model.pushText('note text', 'cm6');
    expect(tabAt(0).dirty).toBe(false);
  });
});

describe('markSaved (M3)', () => {
  test('clears the dirty dot, updates the mtime baseline, and queues buffer cleanup', () => {
    const id = state().openFileTab({ filePath: '/docs/hi.md', text: 'hi', savedMtimeMs: 1 });
    state()
      .tabs.find((t) => t.id === id)!
      .model.pushText('hi edited', 'cm6');
    expect(state().tabs.find((t) => t.id === id)!.dirty).toBe(true);

    state().markSaved(id, 42, 'hi edited');

    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.dirty).toBe(false);
    expect(tab.conflict).toBe(false);
    expect(tab.savedMtimeMs).toBe(42);
    expect(tab.model.isDirty('file')).toBe(false);
    expect(tab.model.isDirty('session')).toBe(false);
    expect(state().obsoleteBufferTabIds).toContain(id);
  });

  test('records the text WRITTEN: edits made during a slow write stay dirty', () => {
    const id = state().openFileTab({ filePath: '/docs/hi.md', text: 'hi', savedMtimeMs: 1 });
    const model = state().tabs.find((t) => t.id === id)!.model;
    model.pushText('hi edited', 'cm6'); // the text the save writes…
    model.pushText('hi edited more', 'cm6'); // …and a keystroke while it is in flight

    state().markSaved(id, 42, 'hi edited');

    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.model.getPersisted('file')).toBe('hi edited');
    expect(tab.model.isDirty('file')).toBe(true);
    expect(tab.model.isDirty('session')).toBe(true);
    expect(tab.dirty).toBe(true);
    expect(tab.savedMtimeMs).toBe(42);
  });
});

describe('saveToPath (M3)', () => {
  test('Save As on a note tab converts it to a file tab and queues the old note for deletion', () => {
    const id = tabAt(0).id;
    tabAt(0).model.pushText('# Grocery list', 'cm6');
    // Simulate a prior flush having assigned a note path.
    tabAt(0).model.markPersisted('session');
    state().applyFlushResult({
      assignedNotePaths: { [id]: '/notes/grocery-list.md' },
      renamedPaths: {},
      consumedClosedNotePaths: [],
      consumedObsoleteBufferTabIds: [],
    });
    expect(tabAt(0).notePath).toBe('/notes/grocery-list.md');

    state().saveToPath(id, {
      filePath: '/docs/grocery-list.md',
      mtimeMs: 9,
      savedText: '# Grocery list',
    });

    const tab = tabAt(0);
    expect(tab.kind).toBe('file');
    expect(tab.filePath).toBe('/docs/grocery-list.md');
    expect(tab.notePath).toBeNull();
    expect(tab.savedMtimeMs).toBe(9);
    expect(tab.dirty).toBe(false);
    expect(state().closedNotePaths).toContain('/notes/grocery-list.md');
  });

  test('Save As on an existing file tab just retargets the path', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    state().saveToPath(id, { filePath: '/docs/b.md', mtimeMs: 2, savedText: 'a' });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.filePath).toBe('/docs/b.md');
    expect(tab.savedMtimeMs).toBe(2);
    expect(state().closedNotePaths).toEqual([]);
  });

  test('is a no-op on a terminal tab — its kind must never become file', () => {
    const id = state().openTerminalTab({ profileId: 'shell' });
    state().saveToPath(id, { filePath: '/docs/oops.md', mtimeMs: 3, savedText: '' });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.kind).toBe('terminal');
    expect(tab.filePath).toBeNull();
  });
});

describe('adoptMovedNoteAsFile (explorer drag out of the notes dir)', () => {
  /** A note tab that a prior flush has already given a note file. */
  function noteTabWithFile(): string {
    const id = tabAt(0).id;
    tabAt(0).model.pushText('# Grocery list', 'cm6');
    tabAt(0).model.markPersisted('session');
    state().applyFlushResult({
      assignedNotePaths: { [id]: '/notes/grocery-list.md' },
      renamedPaths: {},
      consumedClosedNotePaths: [],
      consumedObsoleteBufferTabIds: [],
    });
    return id;
  }

  test('converts the note tab to a clean file tab at the new path', () => {
    const id = noteTabWithFile();

    state().adoptMovedNoteAsFile(id, { filePath: '/ws/grocery-list.md', mtimeMs: 7 });

    const tab = tabAt(0);
    expect(tab.kind).toBe('file');
    expect(tab.filePath).toBe('/ws/grocery-list.md');
    expect(tab.notePath).toBeNull();
    expect(tab.savedMtimeMs).toBe(7);
    expect(tab.dirty).toBe(false);
    expect(tab.model.isDirty('file')).toBe(false);
  });

  test('queues NO note-file deletion — the file moved, it was not superseded', () => {
    // The difference from Save As: a tombstone here could delete a NEW note
    // that later takes the freed name in the notes dir.
    const id = noteTabWithFile();
    state().adoptMovedNoteAsFile(id, { filePath: '/ws/grocery-list.md', mtimeMs: 7 });
    expect(state().closedNotePaths).toEqual([]);
  });

  test('is a no-op on anything that is not a note tab', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    state().adoptMovedNoteAsFile(id, { filePath: '/ws/a.md', mtimeMs: 2 });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.filePath).toBe('/docs/a.md');
  });
});

describe('preview tabs', () => {
  test('opens an italic preview tab, active', () => {
    const id = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.preview).toBe(true);
    expect(state().activeTabId).toBe(id);
  });

  test('previewing another file REPLACES the preview tab in place', () => {
    const first = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    const before = state().tabs.length;
    const second = state().openFileTab({
      filePath: '/docs/b.md',
      text: 'b',
      savedMtimeMs: 1,
      preview: true,
    });
    // Same tab count (reused slot); the first preview tab is gone.
    expect(state().tabs).toHaveLength(before);
    expect(state().tabs.some((t) => t.id === first)).toBe(false);
    const tab = state().tabs.find((t) => t.id === second)!;
    expect(tab.filePath).toBe('/docs/b.md');
    expect(tab.preview).toBe(true);
    // The displaced clean file tab's (nonexistent) buffer is queued for cleanup.
    expect(state().obsoleteBufferTabIds).toContain(first);
  });

  test('a permanent (non-preview) open leaves an existing preview tab untouched', () => {
    const preview = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    state().openFileTab({ filePath: '/docs/b.md', text: 'b', savedMtimeMs: 1 });
    // Both exist; the preview tab is still there and still preview.
    expect(state().tabs.some((t) => t.id === preview && t.preview)).toBe(true);
  });

  test('a user edit promotes a preview tab to permanent', () => {
    const id = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    state()
      .tabs.find((t) => t.id === id)!
      .model.pushText('a edited', 'cm6');
    expect(state().tabs.find((t) => t.id === id)!.preview).toBe(false);
  });

  test('a programmatic push (file reload) does NOT promote a preview tab', () => {
    const id = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    state()
      .tabs.find((t) => t.id === id)!
      .model.pushText('reloaded', 'file-load');
    expect(state().tabs.find((t) => t.id === id)!.preview).toBe(true);
  });

  test('promoteTab pins a preview tab and is a no-op afterwards', () => {
    const id = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    state().promoteTab(id);
    expect(state().tabs.find((t) => t.id === id)!.preview).toBe(false);
    // Idempotent.
    expect(() => state().promoteTab(id)).not.toThrow();
    expect(state().tabs.find((t) => t.id === id)!.preview).toBe(false);
  });
});

describe('detachTab / adoptTabs (M8 multi-window)', () => {
  test('detachTab removes the tab WITHOUT close-tab tombstones', () => {
    const id = tabAt(0).id;
    tabAt(0).model.pushText('# Torn off', 'cm6');
    state().applyFlushResult({
      assignedNotePaths: { [id]: '/notes/torn-off.md' },
      renamedPaths: {},
      consumedClosedNotePaths: [],
      consumedObsoleteBufferTabIds: [],
    });
    state().newTab();

    state().detachTab(id);

    expect(state().tabs.some((t) => t.id === id)).toBe(false);
    // Nothing queued for deletion — another window is adopting the files.
    expect(state().closedNotePaths).toEqual([]);
    expect(state().obsoleteBufferTabIds).toEqual([]);
  });

  test('detaching a file tab leaves its session buffer unqueued (closeTab queues it)', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    state().detachTab(id);
    expect(state().obsoleteBufferTabIds).toEqual([]);
  });

  test('detaching the last tab leaves one fresh Untitled', () => {
    state().detachTab(tabAt(0).id);
    expect(state().tabs).toHaveLength(1);
    expect(tabAt(0).title).toBe('Untitled');
    expect(state().activeTabId).toBe(tabAt(0).id);
  });

  test('detaching the active tab activates a neighbor', () => {
    const first = tabAt(0).id;
    state().newTab();
    state().activateTab(first);
    state().detachTab(first);
    expect(state().tabs).toHaveLength(1);
    expect(state().activeTabId).toBe(tabAt(0).id);
  });

  test('adoptTabs appends with ids preserved and activates the last adopted tab', () => {
    tabAt(0).model.pushText('existing content', 'cm6');
    state().adoptTabs([
      {
        id: 'adopted-1',
        kind: 'note',
        notePath: '/notes/one.md',
        filePath: null,
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: null,
        text: '# One',
      },
      {
        id: 'adopted-2',
        kind: 'file',
        notePath: null,
        filePath: '/docs/two.md',
        customTitle: null,
        mode: 'split',
        savedMtimeMs: 3,
        text: 'two',
      },
    ]);
    expect(state().tabs.map((t) => t.id)).toContain('adopted-1');
    expect(state().tabs).toHaveLength(3);
    expect(state().activeTabId).toBe('adopted-2');
    const file = state().tabs.find((t) => t.id === 'adopted-2')!;
    expect(file.kind).toBe('file');
    expect(file.mode).toBe('split');
  });

  test('adopting into a pristine window replaces the placeholder Untitled', () => {
    state().adoptTabs([
      {
        id: 'adopted-1',
        kind: 'note',
        notePath: '/notes/one.md',
        filePath: null,
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: null,
        text: '# One',
      },
    ]);
    expect(state().tabs).toHaveLength(1);
    expect(tabAt(0).id).toBe('adopted-1');
  });

  test('a non-pristine Untitled survives adoption', () => {
    tabAt(0).model.pushText('draft', 'cm6');
    state().adoptTabs([
      {
        id: 'adopted-1',
        kind: 'note',
        notePath: '/notes/one.md',
        filePath: null,
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: null,
        text: '# One',
      },
    ]);
    expect(state().tabs).toHaveLength(2);
  });
});

describe('workspace arranging (settings.groupTabsByWorkspace)', () => {
  /** One file tab per given workspace path prefix; returns their ids. */
  function openIn(...dirs: string[]): string[] {
    return dirs.map((dir, i) =>
      state().openFileTab({ filePath: `${dir}/f${i}.md`, text: '', savedMtimeMs: 1 }),
    );
  }

  /** Positions of `ids` in the strip (the store's own initial tab leads it). */
  function positions(ids: (string | undefined)[]): number[] {
    const strip = state().tabs.map((t) => t.id);
    return ids.map((id) => strip.indexOf(id!));
  }

  test('off (the default): a tab lands exactly where it was dropped', () => {
    const [a, b, c] = openIn('/red', '/blue', '/red');
    state().reorderTab(c!, 0);
    const [pa, pb, pc] = positions([a, b, c]);
    expect(pc).toBe(0);
    // …and the /red tabs stay split by the /blue one, untouched.
    expect(pa).toBeLessThan(pb!);
    expect(pc!).toBeLessThan(pa!);
  });

  test('on: a drop that splits a workspace run snaps back into it', () => {
    settings.groupTabsByWorkspace = true;
    const [a, b, c] = openIn('/red', '/blue', '/red');
    state().reorderTab(c!, 0);
    const [pa, pb, pc] = positions([a, b, c]);
    // The two /red tabs end up adjacent (in whichever order the drop implied),
    // and the /blue one is not between them.
    expect(Math.abs(pa! - pc!)).toBe(1);
    expect(pb).toBeGreaterThan(Math.max(pa!, pc!));
  });

  test('on: restore arranges a manifest written with it off', () => {
    settings.groupTabsByWorkspace = true;
    const restored = (id: string, filePath: string) => ({
      id,
      kind: 'file' as const,
      notePath: null,
      filePath,
      customTitle: null,
      mode: 'raw' as const,
      savedMtimeMs: null,
      text: '',
    });
    state().restoreSession({
      tabs: [
        restored('r1', '/red/a.md'),
        restored('r2', '/blue/b.md'),
        restored('r3', '/red/c.md'),
      ],
      activeTabId: 'r2',
    });
    expect(state().tabs.map((t) => t.id)).toEqual(['r1', 'r3', 'r2']);
  });

  test('on: a tab in no workspace is never merged into a run', () => {
    settings.groupTabsByWorkspace = true;
    const [a, loose] = openIn('/red', '/elsewhere');
    const c = openIn('/red')[0];
    state().reorderTab(c!, 0);
    const [pa, ploose, pc] = positions([a, loose, c]);
    expect(Math.abs(pa! - pc!)).toBe(1);
    // The loose tab keeps its own place rather than joining either side.
    expect(ploose).toBeGreaterThan(Math.max(pa!, pc!));
  });
});

describe('conflict flags (M3)', () => {
  test('setConflict toggles the per-tab ConflictBanner flag', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === id)!.conflict).toBe(false);
    state().setConflict(id, true);
    expect(state().tabs.find((t) => t.id === id)!.conflict).toBe(true);
    state().setConflict(id, false);
    expect(state().tabs.find((t) => t.id === id)!.conflict).toBe(false);
  });

  test('acknowledgeConflict ("keep mine") clears the banner without touching dirty/model', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    const tab = state().tabs.find((t) => t.id === id)!;
    tab.model.pushText('a edited', 'cm6');
    state().setConflict(id, true);

    state().acknowledgeConflict(id, 77);

    const after = state().tabs.find((t) => t.id === id)!;
    expect(after.conflict).toBe(false);
    expect(after.savedMtimeMs).toBe(77);
    // Local edits remain unsaved — "keep mine" defers to the next explicit save.
    expect(after.dirty).toBe(true);
    expect(after.model.isDirty('file')).toBe(true);
  });
});

describe('lastFileMode (mobile reads first)', () => {
  afterEach(() => {
    platform.mobile = false;
  });

  const fileInit = (id: string, mode: 'raw' | 'split' | 'wysiwyg' | 'read') => ({
    id,
    kind: 'file' as const,
    notePath: null,
    filePath: `/docs/${id}.md`,
    customTitle: null,
    mode,
    savedMtimeMs: 1,
    text: '',
  });

  test('desktop: restoreSession adopts the active tab mode for later opens', () => {
    state().restoreSession({ tabs: [fileInit('t1', 'wysiwyg')], activeTabId: 't1' });
    expect(state().lastFileMode).toBe('wysiwyg');
    const id = state().openFileTab({ filePath: '/docs/b.md', text: '', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === id)!.mode).toBe('wysiwyg');
  });

  test('mobile: seeds read at boot and newly opened files adopt it', async () => {
    platform.mobile = true;
    vi.resetModules();
    mod = await import('../tabs');
    expect(state().lastFileMode).toBe('read');
    const id = state().openFileTab({ filePath: '/docs/b.md', text: '', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === id)!.mode).toBe('read');
  });

  test('mobile: restoreSession re-seeds read even when the active tab was left in an edit mode', async () => {
    platform.mobile = true;
    vi.resetModules();
    mod = await import('../tabs');
    state().restoreSession({ tabs: [fileInit('t1', 'raw')], activeTabId: 't1' });
    // The restored tab keeps its own mode; only the seed for FUTURE opens resets.
    expect(state().tabs.find((t) => t.id === 't1')!.mode).toBe('raw');
    expect(state().lastFileMode).toBe('read');
    const id = state().openFileTab({ filePath: '/docs/b.md', text: '', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === id)!.mode).toBe('read');
  });

  test('mobile: an explicit mode switch still wins for subsequent opens', async () => {
    platform.mobile = true;
    vi.resetModules();
    mod = await import('../tabs');
    const first = state().openFileTab({ filePath: '/docs/a.md', text: '', savedMtimeMs: 1 });
    state().setMode(first, 'raw');
    const second = state().openFileTab({ filePath: '/docs/b.md', text: '', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === second)!.mode).toBe('raw');
  });
});

describe('git tabs', () => {
  test('opens one per repository, named after the main root, in the tool mode', () => {
    const id = state().openGitTab({ root: 'C:/code/proj' });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.kind).toBe('git');
    expect(tab.mode).toBe('tool');
    expect(tab.gitRoot).toBe('C:/code/proj');
    // No checkout named: the main root is shown.
    expect(tab.gitCheckout).toBe('C:/code/proj');
    expect(mod.tabDisplayTitle(tab)).toBe('Git: proj');
    expect(state().activeTabId).toBe(id);
  });

  test('a second open for the same root (any case / separator) activates the existing tab', () => {
    const id = state().openGitTab({ root: 'C:/code/proj' });
    state().newTab();
    expect(state().activeTabId).not.toBe(id);
    const again = state().openGitTab({ root: 'c:\\Code\\Proj' });
    expect(again).toBe(id);
    expect(state().activeTabId).toBe(id);
    expect(state().tabs.filter((t) => t.kind === 'git')).toHaveLength(1);
  });

  test('a checkout named on open preselects it, and on re-open switches to it', () => {
    const id = state().openGitTab({ root: '/r', checkout: '/r/worktrees/a' });
    expect(state().tabs.find((t) => t.id === id)!.gitCheckout).toBe('/r/worktrees/a');
    state().openGitTab({ root: '/r', checkout: '/r/worktrees/b' });
    expect(state().tabs.find((t) => t.id === id)!.gitCheckout).toBe('/r/worktrees/b');
  });

  test('setGitCheckout only touches git tabs and is a no-op on the same value', () => {
    const id = state().openGitTab({ root: '/r' });
    const before = state().tabs;
    state().setGitCheckout(id, '/r');
    expect(state().tabs).toBe(before);
    state().setGitCheckout(id, '/r/worktrees/x');
    expect(state().tabs.find((t) => t.id === id)!.gitCheckout).toBe('/r/worktrees/x');
    const note = tabAt(0).id;
    state().setGitCheckout(note, '/elsewhere');
    expect(tabAt(0).gitCheckout).toBeNull();
  });

  test('a user rename wins over the derived label', () => {
    const id = state().openGitTab({ root: '/r/proj' });
    state().renameTab(id, 'SCM');
    expect(mod.tabDisplayTitle(state().tabs.find((t) => t.id === id)!)).toBe('SCM');
  });

  test('restores from the manifest with its checkout', () => {
    state().restoreSession({
      tabs: [
        {
          id: 'g1',
          kind: 'git',
          notePath: null,
          filePath: null,
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: null,
          text: '',
          git: { root: '/r', checkout: '/r/worktrees/z' },
        },
      ],
      activeTabId: 'g1',
    });
    const tab = state().tabs.find((t) => t.id === 'g1')!;
    expect(tab.gitRoot).toBe('/r');
    expect(tab.gitCheckout).toBe('/r/worktrees/z');
    // A stale mode self-heals to the family's only one.
    expect(tab.mode).toBe('tool');
  });
});

describe('terminal tabs', () => {
  test('opening one creates its pane session and labels it from the profile', async () => {
    const terminals = await import('../terminals');
    const id = state().openTerminalTab({ profileId: 'shell', cwd: '/work' });

    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.kind).toBe('terminal');
    // 'term' is the only mode its family allows, so a stale mode self-heals.
    expect(tab.mode).toBe('term');
    expect(mod.tabDisplayTitle(tab)).toBe('Shell');
    expect(terminals.terminalsStore.getState().sessions[id]).toBeDefined();
    expect(terminals.activePaneOf(id)).toMatchObject({ profileId: 'shell', cwd: '/work' });
  });

  test("the tab mirrors the focused pane's cwd: seeded from the spawn dir, following cd", async () => {
    const terminals = await import('../terminals');
    const id = state().openTerminalTab({ profileId: 'shell', cwd: '/work' });
    const tab = () => state().tabs.find((t) => t.id === id)!;
    expect(tab().terminalCwd).toBe('/work');

    const pane = terminals.activePaneOf(id)!;
    terminals.terminalsStore.getState().setPaneCwd(pane.id, '/work/src');
    expect(tab().terminalCwd).toBe('/work/src');
  });

  test('the mirror follows focus between panes, and a split inherits its source', async () => {
    const terminals = await import('../terminals');
    const id = state().openTerminalTab({ profileId: 'shell', cwd: '/a' });
    const tab = () => state().tabs.find((t) => t.id === id)!;
    const first = terminals.activePaneOf(id)!.id;

    terminals.terminalsStore.getState().splitActivePane(id, 'row');
    const second = terminals.activePaneOf(id)!.id;
    expect(second).not.toBe(first);
    expect(tab().terminalCwd).toBe('/a');

    terminals.terminalsStore.getState().setPaneCwd(second, '/b');
    expect(tab().terminalCwd).toBe('/b');
    terminals.terminalsStore.getState().focusPane(id, first);
    expect(tab().terminalCwd).toBe('/a');
    // Closing the focused pane hands the tab to the survivor.
    terminals.terminalsStore.getState().closePane(first);
    expect(tab().terminalCwd).toBe('/b');
  });

  test('a shell title change does not touch the tab array (the stores stay decoupled)', async () => {
    const terminals = await import('../terminals');
    const id = state().openTerminalTab({ profileId: 'shell', cwd: '/a' });
    const before = state().tabs;
    terminals.terminalsStore.getState().setPaneTitle(terminals.activePaneOf(id)!.id, 'vim');
    expect(state().tabs).toBe(before);
  });

  test("a restored tab starts from its focused pane's recorded cwd", async () => {
    state().restoreSession({
      tabs: [
        {
          id: 't1',
          kind: 'terminal',
          notePath: null,
          filePath: null,
          customTitle: null,
          mode: 'term',
          savedMtimeMs: null,
          text: '',
          terminal: {
            tree: {
              kind: 'split',
              id: 's1',
              direction: 'row',
              ratio: 0.5,
              first: { kind: 'leaf', id: 'p1' },
              second: { kind: 'leaf', id: 'p2' },
            },
            activePaneId: 'p2',
            panes: [
              { id: 'p1', profileId: 'shell', cwd: '/a' },
              { id: 'p2', profileId: 'shell', cwd: '/b' },
            ],
          },
        },
      ],
      activeTabId: 't1',
    });
    expect(tabAt(0).terminalCwd).toBe('/b');
  });

  test('with grouping on, a terminal that cds into a workspace is re-slotted into its run', async () => {
    settings.groupTabsByWorkspace = true;
    const terminals = await import('../terminals');
    // Opening appends (only reorder/restore/cd arrange): [note] [red] [red] [blue] [terminal in /tmp]
    const red1 = state().openFileTab({ filePath: '/red/a.md', text: '', savedMtimeMs: 1 });
    const red2 = state().openFileTab({ filePath: '/red/b.md', text: '', savedMtimeMs: 1 });
    const blue = state().openFileTab({ filePath: '/blue/c.md', text: '', savedMtimeMs: 1 });
    const term = state().openTerminalTab({ profileId: 'shell', cwd: '/tmp' });
    const order = () =>
      state()
        .tabs.map((t) => t.id)
        .slice(1);
    expect(order()).toEqual([red1, red2, blue, term]);

    // cd into the red workspace: the terminal joins the red run.
    const pane = terminals.activePaneOf(term)!.id;
    terminals.terminalsStore.getState().setPaneCwd(pane, '/red/sub');
    expect(order()).toEqual([red1, red2, term, blue]);

    // Leaving every workspace: no key, so the tab keeps its place.
    terminals.terminalsStore.getState().setPaneCwd(pane, '/tmp');
    expect(order()).toEqual([red1, red2, term, blue]);
    expect(state().tabs.find((t) => t.id === term)?.terminalCwd).toBe('/tmp');
  });

  test("the shell's own title takes over the label; a rename beats even that", async () => {
    const id = state().openTerminalTab({ profileId: 'shell' });
    state().setTerminalTitle(id, 'vim README.md');
    expect(mod.tabDisplayTitle(state().tabs.find((t) => t.id === id)!)).toBe('vim README.md');

    state().renameTab(id, 'build');
    expect(mod.tabDisplayTitle(state().tabs.find((t) => t.id === id)!)).toBe('build');
  });

  test('closing the tab releases the session, so no pty outlives it', async () => {
    const terminals = await import('../terminals');
    const id = state().openTerminalTab({ profileId: 'shell' });
    state().closeTab(id);
    expect(terminals.terminalsStore.getState().sessions[id]).toBeUndefined();
    expect(
      Object.values(terminals.terminalsStore.getState().panes).some((p) => p.tabId === id),
    ).toBe(false);
  });

  test('tearing one off releases it here — the receiving window respawns it', async () => {
    const terminals = await import('../terminals');
    state().newTab();
    const id = state().openTerminalTab({ profileId: 'shell' });
    state().detachTab(id);
    expect(terminals.terminalsStore.getState().sessions[id]).toBeUndefined();
  });

  test('a restored tab rebuilds its recorded layout', async () => {
    const terminals = await import('../terminals');
    state().restoreSession({
      tabs: [
        {
          id: 't1',
          kind: 'terminal',
          notePath: null,
          filePath: null,
          customTitle: null,
          mode: 'term',
          savedMtimeMs: null,
          text: '',
          terminal: {
            tree: {
              kind: 'split',
              id: 's1',
              direction: 'row',
              ratio: 0.5,
              first: { kind: 'leaf', id: 'p1' },
              second: { kind: 'leaf', id: 'p2' },
            },
            activePaneId: 'p2',
            panes: [
              { id: 'p1', profileId: 'ssh', cwd: '/a' },
              { id: 'p2', profileId: 'ssh', cwd: '/b' },
            ],
          },
        },
      ],
      activeTabId: 't1',
    });

    const session = terminals.terminalsStore.getState().sessions.t1!;
    expect(session.tree.kind).toBe('split');
    const cwds = Object.values(terminals.terminalsStore.getState().panes)
      .filter((p) => p.tabId === 't1')
      .map((p) => p.cwd)
      .sort();
    expect(cwds).toEqual(['/a', '/b']);
    // The label comes from the recorded profile, not the default one.
    expect(mod.tabDisplayTitle(tabAt(0))).toBe('Remote (ssh)');
  });
});

describe('Live Edit: setLiveEdit + adoptMergedText', () => {
  test('setLiveEdit stores the override on file tabs only, and null clears it', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === id)!.liveEdit).toBeNull();
    state().setLiveEdit(id, true);
    expect(state().tabs.find((t) => t.id === id)!.liveEdit).toBe(true);
    state().setLiveEdit(id, null);
    expect(state().tabs.find((t) => t.id === id)!.liveEdit).toBeNull();
    // A note has no file to share: the override is refused.
    state().newTab();
    const noteId = state().activeTabId!;
    state().setLiveEdit(noteId, true);
    expect(state().tabs.find((t) => t.id === noteId)!.liveEdit).toBeNull();
  });

  test('adoptMergedText makes disk the baseline: dirty iff the merge added something', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a\n', savedMtimeMs: 1 });
    const tab = () => state().tabs.find((t) => t.id === id)!;
    state().setConflict(id, true);
    // The editor holds the merged text; disk holds only their side.
    tab().model.pushText('mine\na\ntheirs\n', 'programmatic');
    state().adoptMergedText(id, { diskText: 'a\ntheirs\n', mtimeMs: 7 });
    expect(tab().savedMtimeMs).toBe(7);
    expect(tab().conflict).toBe(false);
    expect(tab().dirty).toBe(true);
    expect(tab().model.getPersisted('file')).toBe('a\ntheirs\n');
    // Nothing of mine to add: clean.
    tab().model.pushText('a\ntheirs\n', 'programmatic');
    state().adoptMergedText(id, { diskText: 'a\ntheirs\n', mtimeMs: 8 });
    expect(tab().dirty).toBe(false);
  });

  test('a restored file tab carries its override', () => {
    state().restoreSession({
      tabs: [
        {
          id: 'r1',
          kind: 'file',
          notePath: null,
          filePath: '/docs/a.md',
          customTitle: null,
          mode: 'raw',
          savedMtimeMs: 1,
          liveEdit: false,
          text: 'a',
        },
      ],
      activeTabId: 'r1',
    });
    expect(state().tabs.find((t) => t.id === 'r1')!.liveEdit).toBe(false);
  });
});
