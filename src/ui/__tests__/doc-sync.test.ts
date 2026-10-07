import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DocSyncMessage } from '../../core/doc-sync';

type Tabs = typeof import('../stores/tabs');
type Sync = typeof import('../doc-sync');

let tabs: Tabs;
let sync: Sync;

beforeEach(async () => {
  vi.resetModules();
  tabs = await import('../stores/tabs');
  sync = await import('../doc-sync');
});

const open = (filePath: string, text: string): string =>
  tabs.tabsStore.getState().openFileTab({ filePath, text, savedMtimeMs: 1 });
const tab = (id: string) => tabs.tabsStore.getState().tabs.find((t) => t.id === id)!;

describe('doc sync wiring', () => {
  test('a duplicated tab starts from the unsaved text and mirrors edits both ways', () => {
    sync.startDocSync();
    const a = open('/docs/a.md', 'disk');
    tab(a).model.pushText('disk + edit', 'cm6');
    const b = tabs.tabsStore.getState().duplicateFileTab(a)!;
    expect(tab(b).model.getText()).toBe('disk + edit');
    expect(tab(b).dirty).toBe(true);
    expect(
      tabs.tabsStore
        .getState()
        .tabs.map((t) => t.id)
        .indexOf(b),
    ).toBe(
      tabs.tabsStore
        .getState()
        .tabs.map((t) => t.id)
        .indexOf(a) + 1,
    );

    tab(b).model.pushText('from the mirror', 'cm6');
    expect(tab(a).model.getText()).toBe('from the mirror');
    tab(a).model.pushText('and back', 'cm6');
    expect(tab(b).model.getText()).toBe('and back');
  });

  test('saving one mirror cleans the other and announces the save once', () => {
    const sent: DocSyncMessage[] = [];
    sync.startDocSync((m) => sent.push(m));
    const a = open('/docs/a.md', 'disk');
    const b = tabs.tabsStore.getState().duplicateFileTab(a)!;
    sync.docSync.receive({ type: 'here', key: '/docs/a.md' });
    tab(a).model.pushText('edited', 'cm6');
    expect(tab(b).dirty).toBe(true);

    tabs.tabsStore.getState().markSaved(a, 99, 'edited');
    expect(tab(b).dirty).toBe(false);
    expect(tab(b).savedMtimeMs).toBe(99);
    expect(sent.filter((m) => m.type === 'saved')).toEqual([
      { type: 'saved', key: '/docs/a.md', text: 'edited', mtimeMs: 99 },
    ]);
  });

  test("a remote save becomes this tab's baseline; later typing stays dirty", () => {
    sync.startDocSync(() => {});
    const a = open('/docs/a.md', 'disk');
    sync.docSync.receive({ type: 'text', key: '/docs/a.md', text: 'remote' });
    expect(tab(a).model.getText()).toBe('remote');
    expect(tab(a).dirty).toBe(true);
    tab(a).model.pushText('remote + more', 'cm6');
    sync.docSync.receive({ type: 'saved', key: '/docs/a.md', text: 'remote', mtimeMs: 7 });
    expect(tab(a).savedMtimeMs).toBe(7);
    expect(tab(a).dirty).toBe(true);
    expect(tab(a).model.getPersisted('file')).toBe('remote');
  });

  test('renaming a file retargets its mirrors and keeps them in sync', () => {
    sync.startDocSync();
    const a = open('/docs/a.md', 'x');
    const b = tabs.tabsStore.getState().duplicateFileTab(a)!;
    tabs.tabsStore.getState().retargetFilePath(a, { filePath: '/docs/b.md', mtimeMs: 2 });
    expect(tab(b).filePath).toBe('/docs/b.md');
    tab(a).model.pushText('y', 'cm6');
    expect(tab(b).model.getText()).toBe('y');
  });
});
