/**
 * @vitest-environment jsdom
 *
 * Live Edit mode end to end through the session controller: a file tab in a
 * workspace flagged `liveEdit` MERGES an on-disk change instead of raising the
 * conflict banner, keeps both sides of an overlapping edit, saves itself at
 * the flush cadence whatever the global Auto save setting says, and records
 * its activity for the status chip. Same in-memory fake ipc as session.test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const NOTES = '/notes';
const SESSION = '/session';
const SHARED = '/drive/team';

type SessionModule = typeof import('../session');
type TabsModule = typeof import('../stores/tabs');
type SettingsModule = typeof import('../stores/settings');
type LiveModule = typeof import('../stores/live-edit');
type UiModule = typeof import('../stores/ui');

let session: SessionModule;
let tabs: TabsModule;
let settings: SettingsModule;
let live: LiveModule;
let ui: UiModule;
let IpcError: typeof import('../../ipc/commands').IpcError;

function makeFakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const mtimes = new Map<string, number>([...files.keys()].map((p) => [p, 1]));
  const ops: string[] = [];
  let clock = 1;
  return {
    files,
    mtimes,
    ops,
    /** Simulate the other person's save: new content, newer mtime. */
    external(path: string, text: string) {
      files.set(path, text);
      mtimes.set(path, ++clock);
    },
    ipc: {
      async atomicWriteText(path: string, text: string) {
        ops.push(`write:${path}`);
        files.set(path, text);
        mtimes.set(path, ++clock);
      },
      async readTextFile(path: string) {
        if (!files.has(path)) {
          throw new IpcError('NOT_FOUND', path);
        }
        return { text: files.get(path)!, mtimeMs: mtimes.get(path) ?? 1 };
      },
      async renamePath(from: string, to: string) {
        files.set(to, files.get(from)!);
        mtimes.set(to, mtimes.get(from) ?? 1);
        files.delete(from);
        mtimes.delete(from);
      },
      async deletePath(path: string) {
        files.delete(path);
        mtimes.delete(path);
      },
      async listNotes() {
        return [];
      },
      async listDir() {
        return [];
      },
      async readFileBase64() {
        return '';
      },
      async writeFileBase64() {},
      async copyPath() {},
      async createDir() {},
      async statPath(path: string) {
        return files.has(path)
          ? { exists: true, mtimeMs: mtimes.get(path) ?? 1 }
          : { exists: false, mtimeMs: null };
      },
    },
  };
}

// Pay the cold load of the session graph once, under its own budget — see the
// matching hook in session.test.ts for why the per-test hook can't absorb it.
beforeAll(async () => {
  await import('../session');
}, 60_000);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  IpcError = (await import('../../ipc/commands')).IpcError;
  session = await import('../session');
  tabs = await import('../stores/tabs');
  settings = await import('../stores/settings');
  live = await import('../stores/live-edit');
  ui = await import('../stores/ui');
  settings.settingsStore
    .getState()
    .update({ workspaces: [{ name: 'Team', path: SHARED, color: null, liveEdit: true }] });
});

afterEach(() => {
  vi.useRealTimers();
});

function makeController(fs: ReturnType<typeof makeFakeFs>) {
  return session.createSessionController({
    paths: { notesDir: NOTES, sessionDir: SESSION },
    ipc: fs.ipc,
    now: () => 111,
  });
}

async function openShared(controller: ReturnType<typeof makeController>) {
  await controller.openPaths([`${SHARED}/plan.md`]);
  const id = tabs.tabsStore.getState().activeTabId!;
  return { id, tab: () => tabs.tabsStore.getState().tabs.find((t) => t.id === id)! };
}

describe('Live Edit — merging changes from disk', () => {
  test('an untouched tab simply adopts the other person’s text, clean', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'one\ntwo\n' });
    const controller = makeController(fs);
    const { id, tab } = await openShared(controller);

    fs.external(`${SHARED}/plan.md`, 'one\ntwo\nthree\n');
    await controller.checkConflict(id);

    expect(tab().model.getText()).toBe('one\ntwo\nthree\n');
    expect(tab().conflict).toBe(false);
    expect(tab().dirty).toBe(false);
    expect(tab().savedMtimeMs).toBe(fs.mtimes.get(`${SHARED}/plan.md`));
    expect(live.liveEditStore.getState().byTab[id]).toMatchObject({ merges: 1 });
  });

  test('my unsaved edit and their edit to different lines both survive, and mine is saved back', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'one\ntwo\nthree\n' });
    const controller = makeController(fs);
    const { id, tab } = await openShared(controller);
    tab().model.pushText('ONE\ntwo\nthree\n', 'cm6');

    fs.external(`${SHARED}/plan.md`, 'one\ntwo\nTHREE\n');
    await controller.checkConflict(id);

    expect(tab().model.getText()).toBe('ONE\ntwo\nTHREE\n');
    expect(tab().conflict).toBe(false);
    expect(tab().dirty).toBe(true); // disk still lacks my line

    // Global Auto save is OFF, yet a live tab saves at the flush cadence.
    expect(settings.settingsStore.getState().settings.liveSave).toBe(false);
    await controller.flushNow();
    expect(fs.files.get(`${SHARED}/plan.md`)).toBe('ONE\ntwo\nTHREE\n');
    expect(tab().dirty).toBe(false);
  });

  test('an overlapping edit takes the version on disk and offers my lines back', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'title\nbody\n' });
    const controller = makeController(fs);
    const { id, tab } = await openShared(controller);
    tab().model.pushText('title\nbody (mine)\n', 'cm6');

    fs.external(`${SHARED}/plan.md`, 'title\nbody (theirs)\n');
    await controller.checkConflict(id);

    expect(tab().model.getText()).toBe('title\nbody (theirs)\n');
    expect(tab().conflict).toBe(false);
    expect(tab().dirty).toBe(false); // nothing of mine left to write
    expect(live.liveEditStore.getState().lost[id]).toEqual([
      { lines: ['body (mine)'], afterOffset: 'title\nbody (theirs)\n'.length },
    ]);
    expect(ui.uiStore.getState().notice).toMatch(/replaced 1 line you wrote/);

    // Restore mine: my line comes back right after theirs, and gets saved.
    session.restoreLostLines(id);
    expect(tab().model.getText()).toBe('title\nbody (theirs)\nbody (mine)\n');
    expect(live.liveEditStore.getState().lost[id]).toBeUndefined();
    await controller.flushNow();
    expect(fs.files.get(`${SHARED}/plan.md`)).toBe('title\nbody (theirs)\nbody (mine)\n');
  });

  test('Dismiss forgets the lost lines without touching the text', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'title\nbody\n' });
    const controller = makeController(fs);
    const { id, tab } = await openShared(controller);
    tab().model.pushText('title\nbody (mine)\n', 'cm6');
    fs.external(`${SHARED}/plan.md`, 'title\nbody (theirs)\n');
    await controller.checkConflict(id);

    session.dismissLostLines(id);

    expect(live.liveEditStore.getState().lost[id]).toBeUndefined();
    expect(tab().model.getText()).toBe('title\nbody (theirs)\n');
  });

  test('with a source editor attached, removed lines flash red first and the merge lands later', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'a\nb\nc\n' });
    const controller = makeController(fs);
    const { id, tab } = await openShared(controller);
    const registry = await import('../editor-registry');
    const flashes: Array<{ kind: string; text: string[] }> = [];
    const cleared: string[] = [];
    registry.registerSourceAdapter(id, {
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
      setCollapsibleHeadings() {},
      setFontSize() {},
      format() {},
      insertLinkTo() {},
      insertText() {},
      flashRanges(ranges, kind) {
        const text = tab().model.getText();
        flashes.push({ kind, text: ranges.map((r) => text.slice(r.from, r.to)) });
      },
      clearFlash(kind) {
        cleared.push(kind);
      },
      setLinkedRanges() {},
      revealRange() {},
      subscribeSelection: () => () => {},
    });
    tab().model.pushText('a\nb (mine)\nc\n', 'cm6');
    fs.external(`${SHARED}/plan.md`, 'a\nb (theirs)\nc\n');

    await controller.checkConflict(id);

    // Red on my line, text untouched, and a live save is held meanwhile.
    expect(flashes).toEqual([{ kind: 'removed', text: ['b (mine)'] }]);
    expect(tab().model.getText()).toBe('a\nb (mine)\nc\n');
    await controller.flushNow();
    expect(fs.files.get(`${SHARED}/plan.md`)).toBe('a\nb (theirs)\nc\n'); // not clobbered

    vi.advanceTimersByTime(session.REMOVE_FLASH_MS);

    expect(tab().model.getText()).toBe('a\nb (theirs)\nc\n');
    expect(cleared).toEqual(['removed']);
    expect(flashes[1]).toEqual({ kind: 'added', text: ['b (theirs)'] });
    expect(live.liveEditStore.getState().lost[id]?.[0]?.lines).toEqual(['b (mine)']);
    registry.unregisterSourceAdapter(id);
  });

  test('a save that races an external write merges first, then writes the union', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'a\nb\n' });
    const controller = makeController(fs);
    const { tab } = await openShared(controller);
    tab().model.pushText('a\nb\nmine\n', 'cm6');
    fs.external(`${SHARED}/plan.md`, 'theirs\na\nb\n');

    await controller.saveActive();

    expect(fs.files.get(`${SHARED}/plan.md`)).toBe('theirs\na\nb\nmine\n');
    expect(tab().conflict).toBe(false);
    expect(tab().dirty).toBe(false);
  });

  test('disk catching up to exactly my text makes the tab clean without a write', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'a\n' });
    const controller = makeController(fs);
    const { id, tab } = await openShared(controller);
    tab().model.pushText('a\nb\n', 'cm6');
    fs.external(`${SHARED}/plan.md`, 'a\nb\n');

    await controller.checkConflict(id);

    expect(tab().dirty).toBe(false);
    expect(tab().conflict).toBe(false);
    expect(fs.ops.filter((o) => o.startsWith('write:'))).toEqual([]);
  });

  test('the same file outside a live workspace still gets the banner', async () => {
    const fs = makeFakeFs({ '/elsewhere/plan.md': 'x' });
    const controller = makeController(fs);
    await controller.openPaths(['/elsewhere/plan.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    fs.external('/elsewhere/plan.md', 'y');

    await controller.checkConflict(id);

    expect(tabs.tabsStore.getState().tabs.find((t) => t.id === id)!.conflict).toBe(true);
  });

  test('the per-tab override turns a plain file live (and a live one plain)', async () => {
    const fs = makeFakeFs({ '/elsewhere/plan.md': 'x\n', [`${SHARED}/plan.md`]: 'x\n' });
    const controller = makeController(fs);
    await controller.openPaths(['/elsewhere/plan.md']);
    const plainId = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().setLiveEdit(plainId, true);
    const { id: sharedId } = await openShared(controller);
    tabs.tabsStore.getState().setLiveEdit(sharedId, false);

    fs.external('/elsewhere/plan.md', 'x\ny\n');
    fs.external(`${SHARED}/plan.md`, 'x\ny\n');
    await controller.checkAllFileConflicts();

    const byId = (id: string) => tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(byId(plainId).conflict).toBe(false);
    expect(byId(plainId).model.getText()).toBe('x\ny\n');
    expect(byId(sharedId).conflict).toBe(true);
  });

  test('the override round-trips through the session manifest', async () => {
    const fs = makeFakeFs({ '/elsewhere/plan.md': 'x\n' });
    const controller = makeController(fs);
    await controller.openPaths(['/elsewhere/plan.md']);
    const id = tabs.tabsStore.getState().activeTabId!;
    tabs.tabsStore.getState().setLiveEdit(id, true);
    await controller.flushNow();

    const manifest = JSON.parse(fs.files.get(`${SESSION}/session.json`)!) as {
      tabs: Array<{ id: string; liveEdit?: boolean }>;
    };
    expect(manifest.tabs.find((t) => t.id === id)?.liveEdit).toBe(true);

    // A fresh window restoring that manifest gets the override back.
    vi.resetModules();
    const session2 = await import('../session');
    const tabs2 = await import('../stores/tabs');
    const controller2 = session2.createSessionController({
      paths: { notesDir: NOTES, sessionDir: SESSION },
      ipc: fs.ipc,
      now: () => 111,
    });
    await controller2.restore();
    expect(tabs2.tabsStore.getState().tabs.find((t) => t.id === id)?.liveEdit).toBe(true);
  });
});

describe('Live Edit — cloud-drive realities', () => {
  test('a sync client that let the other save win is caught: their text lands, mine is offered back', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'title\n\n' });
    const controller = makeController(fs);
    const { id, tab } = await openShared(controller);
    // I write line 3 and it saves.
    tab().model.pushText('title\n\nmy line\n', 'cm6');
    await controller.flushNow();
    expect(fs.files.get(`${SHARED}/plan.md`)).toBe('title\n\nmy line\n');
    // The other machine wrote ITS line 3 from the old text; Drive picked
    // its version (last writer wins) and delivered it here.
    fs.external(`${SHARED}/plan.md`, 'title\n\ntheir line\n');
    await controller.checkConflict(id);

    // Disk wins — but the collision was SEEN (older base), so my line is
    // kept aside instead of silently vanishing.
    expect(tab().model.getText()).toBe('title\n\ntheir line\n');
    expect(tab().conflict).toBe(false);
    expect(live.liveEditStore.getState().lost[id]?.[0]?.lines).toEqual(['my line']);
    expect(ui.uiStore.getState().notice).toMatch(/replaced 1 line you wrote/);
    // Nothing goes back out: both machines already hold the same text.
    await controller.flushNow();
    expect(fs.files.get(`${SHARED}/plan.md`)).toBe('title\n\ntheir line\n');
  });

  test('a content change with an unchanged mtime (coarse FAT timestamps) is still merged', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'a\n' });
    const controller = makeController(fs);
    const { id, tab } = await openShared(controller);
    fs.files.set(`${SHARED}/plan.md`, 'a\nb\n'); // mtime NOT bumped

    await controller.checkConflict(id);

    expect(tab().model.getText()).toBe('a\nb\n');
    expect(tab().dirty).toBe(false);
  });

  test('a live save re-reads the file even when its mtime looks untouched', async () => {
    const fs = makeFakeFs({ [`${SHARED}/plan.md`]: 'a\n' });
    const controller = makeController(fs);
    const { tab } = await openShared(controller);
    tab().model.pushText('a\nmine\n', 'cm6');
    fs.files.set(`${SHARED}/plan.md`, 'theirs\na\n'); // mtime NOT bumped

    await controller.flushNow();

    expect(fs.files.get(`${SHARED}/plan.md`)).toBe('theirs\na\nmine\n');
  });
});
