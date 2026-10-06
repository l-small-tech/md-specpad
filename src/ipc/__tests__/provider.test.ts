import { afterEach, describe, expect, test } from 'vitest';
import {
  LocalFsProvider,
  createRoutingProvider,
  createSafProvider,
  currentProvider,
  isSafPath,
  setProvider,
  type SafOps,
  type StorageProvider,
} from '../provider';

afterEach(() => {
  setProvider(LocalFsProvider);
});

/** In-memory SAF backend: relPath → base64 payload, plus a call log. */
function makeFakeSaf() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const ops: SafOps = {
    safRefresh: async (_tree, relPath) => {
      calls.push(`refresh:${relPath}`);
    },
    safList: async (_tree, relPath) => {
      calls.push(`list:${relPath}`);
      const prefix = relPath ? `${relPath}/` : '';
      const seen = new Set<string>();
      const entries: { name: string; isDir: boolean; size: number; mtimeMs: number }[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        entries.push({ name, isDir: slash !== -1, size: 3, mtimeMs: 0 });
      }
      return { entries };
    },
    safRead: async (_tree, relPath) => {
      calls.push(`read:${relPath}`);
      const base64 = files.get(relPath);
      if (base64 === undefined) {
        throw new Error(`NOT_FOUND: ${relPath}`);
      }
      return { base64 };
    },
    safWrite: async (_tree, relPath, base64) => {
      calls.push(`write:${relPath}`);
      files.set(relPath, base64);
    },
    safCreateDir: async (_tree, relPath) => {
      calls.push(`mkdir:${relPath}`);
    },
    safRename: async (_tree, relPath, newName) => {
      calls.push(`rename:${relPath}->${newName}`);
      const base64 = files.get(relPath)!;
      files.delete(relPath);
      const idx = relPath.lastIndexOf('/');
      const dir = idx === -1 ? '' : relPath.slice(0, idx + 1);
      files.set(dir + newName, base64);
    },
    safDelete: async (_tree, relPath) => {
      calls.push(`delete:${relPath}`);
      files.delete(relPath);
    },
    safStat: async (_tree, relPath) => {
      calls.push(`stat:${relPath}`);
      // A real (nonzero) mtime the provider must discard in favour of null.
      return { exists: files.has(relPath), isDir: false, size: 3, mtimeMs: 999 };
    },
  };
  return { files, calls, ops };
}

const TREE_URI = 'content://com.android.externalstorage.documents/tree/primary%3Anotes';
const ROOT = `saf://${encodeURIComponent(TREE_URI)}`;

/** Encode a string as UTF-8 base64 — mirrors the provider's own encoding. */
function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

describe('provider registry', () => {
  test('defaults to the local provider', () => {
    expect(currentProvider()).toBe(LocalFsProvider);
  });

  test('setProvider swaps the active provider', () => {
    const fake = { ...LocalFsProvider, id: 'fake' };
    setProvider(fake);
    expect(currentProvider()).toBe(fake);
    expect(currentProvider().id).toBe('fake');
  });
});

describe('SafProvider', () => {
  test('identifies synced identifiers', () => {
    expect(isSafPath(ROOT)).toBe(true);
    expect(isSafPath(`${ROOT}/note.md`)).toBe(true);
    expect(isSafPath('C:/Users/x/note.md')).toBe(false);
    expect(isSafPath('/storage/emulated/0/note.md')).toBe(false);
  });

  test('parses saf ids and routes each op to the matching saf* call', async () => {
    const { files, calls, ops } = makeFakeSaf();
    files.set('a.md', 'AAAA');
    files.set('sub/b.md', 'BBBB');
    const saf = createSafProvider(ops);

    const listing = await saf.listDir(ROOT);
    expect(calls).toContain('list:');
    // Full saf:// ids flow back out, ready to round-trip through the app.
    expect(listing.map((e) => e.path).sort()).toEqual([`${ROOT}/a.md`, `${ROOT}/sub`]);
    expect(listing.find((e) => e.path === `${ROOT}/sub`)?.isDir).toBe(true);

    await saf.createDir(`${ROOT}/images`);
    expect(calls).toContain('mkdir:images');
    await saf.deletePath(`${ROOT}/a.md`);
    expect(calls).toContain('delete:a.md');
  });

  test('filters listings to text notes/images/importable docs and drops dot-files', async () => {
    const { files, ops } = makeFakeSaf();
    files.set('keep.md', 'x');
    files.set('keep.txt', 'x');
    files.set('pic.png', 'x');
    files.set('report.pdf', 'x');
    files.set('memo.docx', 'x');
    files.set('ignore.exe', 'x');
    files.set('.hidden.md', 'x');
    const saf = createSafProvider(ops);
    const names = (await saf.listDir(ROOT)).map((e) => e.path.slice(ROOT.length + 1)).sort();
    expect(names).toEqual(['keep.md', 'keep.txt', 'memo.docx', 'pic.png', 'report.pdf']);
  });

  test('showHidden lists dot-files (still filtered by type unless allFiles)', async () => {
    const { files, ops } = makeFakeSaf();
    files.set('keep.md', 'x');
    files.set('.hidden.md', 'x');
    files.set('.env', 'x');
    const saf = createSafProvider(ops);
    const names = async (allFiles: boolean) =>
      (await saf.listDir(ROOT, allFiles, true)).map((e) => e.path.slice(ROOT.length + 1)).sort();
    expect(await names(false)).toEqual(['.hidden.md', 'keep.md']);
    expect(await names(true)).toEqual(['.env', '.hidden.md', 'keep.md']);
  });

  test('round-trips UTF-8 text through base64 without corruption', async () => {
    const { files, ops } = makeFakeSaf();
    const saf = createSafProvider(ops);
    const text = 'héllo — 世界 🌍\nsecond line';
    await saf.atomicWriteText(`${ROOT}/n.md`, text);
    // Stored payload is genuine UTF-8 base64 (not Latin-1) …
    expect(files.get('n.md')).toBe(utf8Base64(text));
    // … and decodes back to the exact original.
    const { text: got, mtimeMs } = await saf.readTextFile(`${ROOT}/n.md`);
    expect(got).toBe(text);
    expect(mtimeMs).toBe(0);
  });

  test('reports mtimeMs null for stat (SAF/Drive mtime is untrusted)', async () => {
    const { files, ops } = makeFakeSaf();
    files.set('n.md', 'x');
    const saf = createSafProvider(ops);
    const present = await saf.statPath(`${ROOT}/n.md`);
    expect(present.exists).toBe(true);
    expect(present.mtimeMs).toBeNull();
    const absent = await saf.statPath(`${ROOT}/gone.md`);
    expect(absent.exists).toBe(false);
    expect(absent.mtimeMs).toBeNull();
  });

  test('same-dir rename uses safRename; cross-dir move is copy+delete', async () => {
    const { files, calls, ops } = makeFakeSaf();
    files.set('a.md', 'AAAA');
    files.set('sub/c.md', 'CCCC');
    const saf = createSafProvider(ops);

    await saf.renamePath(`${ROOT}/a.md`, `${ROOT}/b.md`);
    expect(calls).toContain('rename:a.md->b.md');
    expect(files.has('b.md')).toBe(true);
    expect(files.has('a.md')).toBe(false);

    calls.length = 0;
    await saf.renamePath(`${ROOT}/sub/c.md`, `${ROOT}/c.md`);
    // No same-parent rename possible → stat dest (no-clobber guard), then read
    // source, write dest, delete source.
    expect(calls).toEqual(['stat:c.md', 'read:sub/c.md', 'write:c.md', 'delete:sub/c.md']);
    expect(files.get('c.md')).toBe('CCCC');
  });

  test('rename/copy refuse to clobber an existing destination (EXISTS)', async () => {
    const { files, ops } = makeFakeSaf();
    files.set('a.md', 'AAAA');
    files.set('b.md', 'BBBB');
    const saf = createSafProvider(ops);

    await expect(saf.renamePath(`${ROOT}/a.md`, `${ROOT}/b.md`)).rejects.toMatchObject({
      code: 'EXISTS',
    });
    await expect(saf.copyPath(`${ROOT}/a.md`, `${ROOT}/b.md`)).rejects.toMatchObject({
      code: 'EXISTS',
    });
    // Both files survive untouched.
    expect(files.get('a.md')).toBe('AAAA');
    expect(files.get('b.md')).toBe('BBBB');
  });

  test('refresh forwards the parsed tree + rel path to safRefresh', async () => {
    const { calls, ops } = makeFakeSaf();
    const saf = createSafProvider(ops);
    await saf.refresh!(`${ROOT}/sub`);
    expect(calls).toContain('refresh:sub');
    calls.length = 0;
    await saf.refresh!(ROOT);
    // Root has an empty rel path.
    expect(calls).toContain('refresh:');
  });
});

describe('RoutingProvider', () => {
  /** A local-FS stand-in that records the base64 ops the router drives. */
  function fakeLocal(): { provider: StorageProvider; log: string[] } {
    const log: string[] = [];
    const provider: StorageProvider = {
      ...LocalFsProvider,
      readFileBase64: async (p) => {
        log.push(`local-read:${p}`);
        return 'TE9DQUw='; // "LOCAL"
      },
      writeFileBase64: async (p, d) => {
        log.push(`local-write:${p}:${d}`);
      },
      deletePath: async (p) => {
        log.push(`local-delete:${p}`);
      },
      statPath: async (p) => {
        log.push(`local-stat:${p}`);
        return { exists: false, mtimeMs: null };
      },
    };
    return { provider, log };
  }

  test('dispatches by identifier prefix', async () => {
    const { files, calls, ops } = makeFakeSaf();
    files.set('n.md', utf8Base64('hi'));
    const saf = createSafProvider(ops);
    const { provider: local, log } = fakeLocal();
    const router = createRoutingProvider(local, saf);

    // saf id → SafProvider
    expect((await router.readTextFile(`${ROOT}/n.md`)).text).toBe('hi');
    expect(calls).toContain('read:n.md');
    // local id → LocalFsProvider
    await router.readFileBase64('C:/x/a.png');
    expect(log).toContain('local-read:C:/x/a.png');
  });

  test('copyPath crosses backends: read source, write destination', async () => {
    const { files, calls, ops } = makeFakeSaf();
    const saf = createSafProvider(ops);
    const { provider: local, log } = fakeLocal();
    const router = createRoutingProvider(local, saf);

    // local → saf (image paste into a synced note)
    await router.copyPath('C:/x/a.png', `${ROOT}/a.png`);
    expect(log).toContain('local-read:C:/x/a.png');
    expect(calls).toContain('write:a.png');
    expect(files.get('a.png')).toBe('TE9DQUw=');
  });

  test('cross-backend rename is copy + source delete', async () => {
    const { files, calls, ops } = makeFakeSaf();
    files.set('a.md', 'AAAA');
    const saf = createSafProvider(ops);
    const { provider: local, log } = fakeLocal();
    const router = createRoutingProvider(local, saf);

    // saf → local: read saf, write local, delete saf.
    await router.renamePath(`${ROOT}/a.md`, 'C:/x/a.md');
    expect(calls).toContain('read:a.md');
    expect(log.some((l) => l.startsWith('local-write:C:/x/a.md'))).toBe(true);
    expect(calls).toContain('delete:a.md');
  });

  test('stays non-local-fs so desktop path assumptions never apply', () => {
    const router = createRoutingProvider(LocalFsProvider, createSafProvider(makeFakeSaf().ops));
    expect(router.capabilities.isLocalFs).toBe(false);
  });

  test('refresh routes to the SAF backend and no-ops for local dirs', async () => {
    const { calls, ops } = makeFakeSaf();
    const saf = createSafProvider(ops);
    const { provider: local } = fakeLocal();
    const router = createRoutingProvider(local, saf);

    await router.refresh!(`${ROOT}/sub`);
    expect(calls).toContain('refresh:sub');

    // A local dir has no refresh op; the router must resolve without throwing.
    await expect(router.refresh!('C:/notes')).resolves.toBeUndefined();
  });
});
