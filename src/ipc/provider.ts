/**
 * Storage-provider seam.
 *
 * All of the app's file I/O goes through a `StorageProvider`. On desktop that
 * is `LocalFsProvider` — literally the `ipc` fs wrappers plus a capabilities
 * descriptor. On Android a `RoutingProvider` is installed instead
 * (`initProviders`): it dispatches each op by identifier prefix, sending
 * `saf://…` ids to a `SafProvider` (an Android Storage-Access-Framework tree:
 * Google Drive, OneDrive, an SD card, …) and everything else to the local FS.
 * Local and synced workspaces therefore coexist — the identifier decides the
 * backend, so nothing is a global mode switch.
 *
 * The app's path helpers (`pathKey`, `splitPath`, `joinPath`, …) stay backend-
 * agnostic because identifiers are opaque strings each provider interprets
 * itself: a synced id is `saf://<encodeURIComponent(treeUri)>/<relPath>`, whose
 * only literal `/` characters are the scheme's `//` and the relPath separators
 * (encodeURIComponent turns the tree URI's own slashes into `%2F`), so
 * joinPath/baseName/dirName operate on it correctly.
 *
 * Synced-op caveats baked into `SafProvider`:
 * - SAF/Drive last-modified is unreliable (null/0/jittering server time), so
 *   every synced op reports `mtimeMs: null`; the session controller's null-guard
 *   then consistently skips mtime conflict detection (deterministic last-write-
 *   wins) rather than firing false "changed on disk" banners.
 * - `atomicWriteText` is NOT atomic over SAF (no temp+rename); Drive keeps
 *   version history, so a torn write is recoverable but not prevented.
 */

import {
  ipc,
  IpcError,
  type Ipc,
  type FileText,
  type NoteMeta,
  type DirEntryMeta,
  type PathStat,
} from './commands';
import { isAndroid } from '../ui/platform';
import { isAudioPath } from '../core/audio';
import { isImagePath } from '../core/images';
import { isImportablePath } from '../core/import/registry';
import { isEditableTextPath } from '../core/text-files';

export interface StorageCapabilities {
  /** Can the user pick an arbitrary folder as a root/workspace? (No on Android/cloud.) */
  canPickDir: boolean;
  /** Does the backend support cheap rename/move in place? */
  canRename: boolean;
  /** True only for the real local filesystem; gates desktop path assumptions if ever needed. */
  isLocalFs: boolean;
}

/**
 * The storage surface a provider must implement: exactly the fs methods the app
 * already calls on `ipc`. Local FS is `ipc`; a cloud provider implements the
 * same shape over its own identifiers.
 */
export type StorageOps = Pick<
  Ipc,
  | 'readTextFile'
  | 'atomicWriteText'
  | 'listNotes'
  | 'listDir'
  | 'listSessionManifests'
  | 'readFileBase64'
  | 'writeFileBase64'
  | 'copyPath'
  | 'createDir'
  | 'renamePath'
  | 'deletePath'
  | 'statPath'
>;

export interface StorageProvider extends StorageOps {
  readonly id: string;
  readonly capabilities: StorageCapabilities;
  /**
   * Ask the backend to re-fetch `dir` from its source before the next listing,
   * so a change made elsewhere (a note added to the same Drive folder on another
   * device) becomes visible. Optional: the local FS never serves stale listings,
   * so it omits this; only the synced (SAF) backend implements it. Best-effort —
   * resolves even if the provider can't refresh.
   */
  refresh?(dir: string): Promise<void>;
}

/** The local filesystem provider — the `ipc` fs wrappers, unchanged. */
export const LocalFsProvider: StorageProvider = {
  id: 'local',
  // No arbitrary folder picking on Android (SAF folder-picking is out of scope);
  // the single app-scoped Notes workspace is the whole surface there.
  capabilities: { canPickDir: !isAndroid(), canRename: true, isLocalFs: true },
  readTextFile: ipc.readTextFile,
  atomicWriteText: ipc.atomicWriteText,
  listNotes: ipc.listNotes,
  listDir: ipc.listDir,
  listSessionManifests: ipc.listSessionManifests,
  readFileBase64: ipc.readFileBase64,
  writeFileBase64: ipc.writeFileBase64,
  copyPath: ipc.copyPath,
  createDir: ipc.createDir,
  renamePath: ipc.renamePath,
  deletePath: ipc.deletePath,
  statPath: ipc.statPath,
};

let active: StorageProvider = LocalFsProvider;

/** The active storage provider. The session controller routes all fs I/O here. */
export function currentProvider(): StorageProvider {
  return active;
}

/** Swap the active provider (future cloud-drive entry point). */
export function setProvider(provider: StorageProvider): void {
  active = provider;
}

/* ---- Storage Access Framework (synced-folder) provider ----------------- */

/** Scheme prefix for synced-folder identifiers (`saf://<token>/<relPath>`). */
export const SAF_PREFIX = 'saf://';

/** True for a synced-folder identifier (root or any path within it). */
export function isSafPath(id: string): boolean {
  return id.startsWith(SAF_PREFIX);
}

/** Split a synced id into its decoded tree URI and (possibly empty) rel path. */
function parseSaf(id: string): { treeUri: string; relPath: string } {
  const rest = id.slice(SAF_PREFIX.length);
  const slash = rest.indexOf('/');
  const token = slash === -1 ? rest : rest.slice(0, slash);
  const relPath = slash === -1 ? '' : rest.slice(slash + 1);
  return { treeUri: decodeURIComponent(token), relPath };
}

/** Parent directory portion of a rel path ('' at the root level). */
function relDir(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/** Base name of a rel path. */
function relName(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** base64 → bytes (Latin-1 decode of the base64 payload). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** bytes → base64 (chunked so a large image can't overflow the call stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

/** The SAF ops a SafProvider needs — injectable so unit tests can pass fakes. */
export type SafOps = Pick<
  Ipc,
  | 'safList'
  | 'safRefresh'
  | 'safRead'
  | 'safWrite'
  | 'safCreateDir'
  | 'safRename'
  | 'safDelete'
  | 'safStat'
>;

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/**
 * Explorer-visible entry: a subfolder, a text note (.md/.txt), an image, audio, or an
 * importable document (PDF/DOCX — see the import registry); no dot-files. The
 * desktop (local FS) listing applies the equivalent filter in Rust `list_dir`.
 * `allFiles` (unsupported files shown) lists every non-hidden file;
 * `showHidden` lists dot-files too (Android is Linux: the dot is its only
 * hidden convention).
 */
function isListed(name: string, isDir: boolean, allFiles: boolean, showHidden: boolean): boolean {
  if (!showHidden && name.startsWith('.')) {
    return false;
  }
  return (
    isDir ||
    allFiles ||
    isEditableTextPath(name) ||
    isImagePath(name) ||
    isAudioPath(name) ||
    isImportablePath(name)
  );
}

/**
 * Storage over an Android SAF tree. Implements the same 12 `StorageOps` as the
 * local FS, but over `saf://` identifiers: it parses the tree URI + rel path
 * out of each id and calls the matching `ipc.saf*` bridge. Text is decoded from
 * base64 as UTF-8 (not `atob` alone — that yields Latin-1 and corrupts
 * multibyte characters); writes encode text → UTF-8 → base64. Every op reports
 * `mtimeMs: null` (see the module header). `ops` defaults to the real `ipc`;
 * tests inject fakes.
 */
export function createSafProvider(ops: SafOps = ipc): StorageProvider {
  const listAt = async (dir: string): Promise<{ name: string; isDir: boolean; size: number }[]> => {
    const { treeUri, relPath } = parseSaf(dir);
    const { entries } = await ops.safList(treeUri, relPath);
    return entries;
  };

  async function listDir(
    dir: string,
    allFiles = false,
    showHidden = false,
  ): Promise<DirEntryMeta[]> {
    const entries = await listAt(dir);
    return entries
      .filter((e) => isListed(e.name, e.isDir, allFiles, showHidden))
      .map((e) => ({
        path: `${dir}/${e.name}`,
        isDir: e.isDir,
        // SAF mtime is unreliable; the explorer only uses this for a secondary
        // sort, and the id carries no time semantics, so 0 is a safe filler.
        mtimeMs: 0,
        size: e.size ?? 0,
      }));
  }

  async function refresh(dir: string): Promise<void> {
    const { treeUri, relPath } = parseSaf(dir);
    await ops.safRefresh(treeUri, relPath);
  }

  async function listNotes(dir: string): Promise<NoteMeta[]> {
    const entries = await listAt(dir);
    return entries
      .filter((e) => !e.isDir && !e.name.startsWith('.') && isMarkdown(e.name))
      .map((e) => ({ path: `${dir}/${e.name}`, mtimeMs: 0, size: e.size ?? 0 }));
  }

  async function readTextFile(path: string): Promise<FileText> {
    const { treeUri, relPath } = parseSaf(path);
    const { base64 } = await ops.safRead(treeUri, relPath);
    return { text: textDecoder.decode(base64ToBytes(base64)), mtimeMs: 0 };
  }

  async function atomicWriteText(path: string, text: string): Promise<void> {
    const { treeUri, relPath } = parseSaf(path);
    await ops.safWrite(treeUri, relPath, bytesToBase64(textEncoder.encode(text)));
  }

  async function readFileBase64(path: string): Promise<string> {
    const { treeUri, relPath } = parseSaf(path);
    return (await ops.safRead(treeUri, relPath)).base64;
  }

  async function writeFileBase64(path: string, data: string): Promise<void> {
    const { treeUri, relPath } = parseSaf(path);
    await ops.safWrite(treeUri, relPath, data);
  }

  async function createDir(path: string): Promise<void> {
    const { treeUri, relPath } = parseSaf(path);
    await ops.safCreateDir(treeUri, relPath);
  }

  async function copyPath(from: string, to: string): Promise<void> {
    // SAF has no server-side copy; read the bytes and write them back. Both
    // ends are synced here (cross-backend copy is handled by the router).
    // safWrite truncates, so guard the clobber ourselves to mirror the local
    // FS EXISTS contract the frontend's collision-suffixing depends on.
    const dst = parseSaf(to);
    if ((await ops.safStat(dst.treeUri, dst.relPath)).exists) {
      throw new IpcError('EXISTS', `destination already exists: ${to}`);
    }
    const src = parseSaf(from);
    const { base64 } = await ops.safRead(src.treeUri, src.relPath);
    await ops.safWrite(dst.treeUri, dst.relPath, base64);
  }

  async function renamePath(from: string, to: string): Promise<void> {
    const a = parseSaf(from);
    const b = parseSaf(to);
    // Never clobber: SAF rename/write overwrite silently, so stat the
    // destination first and mirror the local FS EXISTS contract the frontend's
    // collision-suffixing depends on.
    if ((await ops.safStat(b.treeUri, b.relPath)).exists) {
      throw new IpcError('EXISTS', `destination already exists: ${to}`);
    }
    // A pure display-name change (same tree, same parent dir) is a real SAF
    // rename; a move across directories/trees has no SAF primitive, so fall
    // back to copy+delete (also the fallback if renameDocument fails).
    if (a.treeUri === b.treeUri && relDir(a.relPath) === relDir(b.relPath)) {
      try {
        await ops.safRename(a.treeUri, a.relPath, relName(b.relPath));
        return;
      } catch {
        // Some providers (incl. Drive) reject renameDocument; copy+delete below.
      }
    }
    // `to` was already confirmed free above, so copy the bytes over directly
    // (skipping copyPath's redundant re-stat) and drop the source.
    const { base64 } = await ops.safRead(a.treeUri, a.relPath);
    await ops.safWrite(b.treeUri, b.relPath, base64);
    await deletePath(from);
  }

  async function deletePath(path: string): Promise<void> {
    const { treeUri, relPath } = parseSaf(path);
    await ops.safDelete(treeUri, relPath);
  }

  async function statPath(path: string): Promise<PathStat> {
    const { treeUri, relPath } = parseSaf(path);
    const s = await ops.safStat(treeUri, relPath);
    // Always null mtime: SAF/Drive last-modified can't be trusted as a conflict
    // baseline, and the session null-guard consistently skips detection for it.
    return { exists: s.exists, mtimeMs: null };
  }

  // The session dir is always internal local storage — a synced tree never
  // holds window manifests — so this is never reached with a saf:// id.
  async function listSessionManifests(): Promise<string[]> {
    return [];
  }

  return {
    id: 'saf',
    capabilities: { canPickDir: false, canRename: true, isLocalFs: false },
    refresh,
    readTextFile,
    atomicWriteText,
    listNotes,
    listDir,
    listSessionManifests,
    readFileBase64,
    writeFileBase64,
    copyPath,
    createDir,
    renamePath,
    deletePath,
    statPath,
  };
}

/**
 * The Android provider: routes each op to the local FS or the SafProvider by
 * inspecting the identifier prefix, so local and synced workspaces coexist
 * without a global mode switch. `copyPath`/`renamePath` are the only ops whose
 * two args can straddle backends (image paste / drag-move into a synced note),
 * so they read from the source backend and write to the destination backend.
 */
export function createRoutingProvider(
  local: StorageProvider = LocalFsProvider,
  saf: StorageProvider = createSafProvider(),
): StorageProvider {
  const backend = (id: string): StorageProvider => (isSafPath(id) ? saf : local);

  return {
    id: 'routing',
    // Local folder-picking stays available (the "+" button); synced folders are
    // added through the separate native "Add synced folder" affordance.
    capabilities: {
      canPickDir: local.capabilities.canPickDir,
      canRename: true,
      isLocalFs: false,
    },
    // Only the synced backend refreshes; a local dir resolves as a no-op.
    refresh: (dir) => backend(dir).refresh?.(dir) ?? Promise.resolve(),
    readTextFile: (path) => backend(path).readTextFile(path),
    atomicWriteText: (path, text) => backend(path).atomicWriteText(path, text),
    listNotes: (dir) => backend(dir).listNotes(dir),
    listDir: (dir, allFiles, showHidden) => backend(dir).listDir(dir, allFiles, showHidden),
    listSessionManifests: (dir) => backend(dir).listSessionManifests(dir),
    readFileBase64: (path) => backend(path).readFileBase64(path),
    writeFileBase64: (path, data) => backend(path).writeFileBase64(path, data),
    createDir: (path) => backend(path).createDir(path),
    deletePath: (path) => backend(path).deletePath(path),
    statPath: (path) => backend(path).statPath(path),
    copyPath: async (from, to) => {
      if (isSafPath(from) === isSafPath(to)) {
        return backend(from).copyPath(from, to);
      }
      // writeFileBase64 truncates on both backends, so guard the clobber to
      // mirror the local FS EXISTS contract the frontend depends on.
      if ((await backend(to).statPath(to)).exists) {
        throw new IpcError('EXISTS', `destination already exists: ${to}`);
      }
      const base64 = await backend(from).readFileBase64(from);
      await backend(to).writeFileBase64(to, base64);
    },
    renamePath: async (from, to) => {
      if (isSafPath(from) === isSafPath(to)) {
        return backend(from).renamePath(from, to);
      }
      // Cross-backend "rename" (a move between a local and a synced workspace)
      // has no in-place primitive: copy the bytes over, then drop the source.
      // writeFileBase64 truncates, so never clobber an existing destination.
      if ((await backend(to).statPath(to)).exists) {
        throw new IpcError('EXISTS', `destination already exists: ${to}`);
      }
      const base64 = await backend(from).readFileBase64(from);
      await backend(to).writeFileBase64(to, base64);
      await backend(from).deletePath(from);
    },
  };
}

/**
 * Install the platform's storage provider. Android gets the routing provider
 * (local FS + SAF); desktop stays on the plain local FS (the default), where
 * the Drive-for-Desktop folder is added with the ordinary "+" workspace button.
 * Call once at boot, before the session controller captures `currentProvider()`.
 */
export function initProviders(): void {
  if (isAndroid()) {
    setProvider(createRoutingProvider());
  }
}
