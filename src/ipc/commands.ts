/**
 * Typed wrappers for every custom Tauri command — the ONLY place `invoke`
 * is called with a command string. UI/session code imports `ipc` and never
 * touches @tauri-apps/api/core directly, so the Rust↔TS contract can't
 * drift silently: adding a command means editing exactly two files, this
 * one and src-tauri/src/commands/ (checklist in src-tauri/README.md).
 *
 * Error contract: Rust's `FsError` serializes as `{ code, message }`
 * (src-tauri/src/commands/fs.rs). `call` converts that into a typed
 * `IpcError`. Frontend logic switches on `.code`; `.message` is for logs
 * and the status bar only.
 */

import { Channel, invoke } from '@tauri-apps/api/core';

export type IpcErrorCode =
  | 'NOT_FOUND'
  | 'EXISTS'
  | 'INVALID_PATH'
  | 'INVALID_DATA'
  | 'IO'
  /** A child process could not be started (bad program, bad cwd) — pty only. */
  | 'SPAWN'
  /* Whisper voice notes (src-tauri commands/whisper). */
  | 'WHISPER_UNKNOWN_MODEL'
  | 'WHISPER_NO_MODEL'
  | 'WHISPER_MODEL_CORRUPT'
  | 'WHISPER_LOAD_FAILED'
  | 'WHISPER_FAILED'
  | 'WHISPER_DOWNLOAD_FAILED'
  | 'WHISPER_DOWNLOAD_CORRUPT'
  | 'WHISPER_DOWNLOAD_CANCELLED'
  | 'WHISPER_DOWNLOAD_BUSY'
  /* Git (src-tauri commands/git/), desktop only. */
  | 'GIT_NOT_FOUND'
  | 'GIT_NOT_A_REPO'
  /** git's `safe.directory` check refused the repository (owned by another account). */
  | 'GIT_UNTRUSTED'
  | 'GIT_TIMEOUT'
  | 'GIT_FAILED'
  /** The user cancelled a fetch / pull / push (`gitOpCancel`). */
  | 'GIT_CANCELLED'
  /** One network operation per repository at a time. */
  | 'GIT_BUSY'
  /** A caller bug: a branch name, path or message Rust refused to pass to git. */
  | 'GIT_INVALID_ARG';

const IPC_ERROR_CODES: readonly IpcErrorCode[] = [
  'NOT_FOUND',
  'EXISTS',
  'INVALID_PATH',
  'INVALID_DATA',
  'IO',
  'SPAWN',
  'WHISPER_UNKNOWN_MODEL',
  'WHISPER_NO_MODEL',
  'WHISPER_MODEL_CORRUPT',
  'WHISPER_LOAD_FAILED',
  'WHISPER_FAILED',
  'WHISPER_DOWNLOAD_FAILED',
  'WHISPER_DOWNLOAD_CORRUPT',
  'WHISPER_DOWNLOAD_CANCELLED',
  'WHISPER_DOWNLOAD_BUSY',
  'GIT_NOT_FOUND',
  'GIT_NOT_A_REPO',
  'GIT_UNTRUSTED',
  'GIT_TIMEOUT',
  'GIT_FAILED',
  'GIT_CANCELLED',
  'GIT_BUSY',
  'GIT_INVALID_ARG',
];

/**
 * The subset of `IpcErrorCode` the git commands reject with (mirrors
 * `GitError` in src-tauri/src/commands/git/mod.rs).
 */
export type GitErrorCode =
  | 'GIT_NOT_FOUND'
  | 'GIT_NOT_A_REPO'
  | 'GIT_UNTRUSTED'
  | 'GIT_TIMEOUT'
  | 'GIT_FAILED'
  | 'GIT_CANCELLED'
  | 'GIT_BUSY'
  | 'GIT_INVALID_ARG';

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

function toIpcError(raw: unknown): IpcError {
  if (typeof raw === 'object' && raw !== null) {
    const candidate = raw as { code?: unknown; message?: unknown };
    if (
      typeof candidate.code === 'string' &&
      (IPC_ERROR_CODES as readonly string[]).includes(candidate.code) &&
      typeof candidate.message === 'string'
    ) {
      return new IpcError(candidate.code as IpcErrorCode, candidate.message);
    }
  }
  // Anything unshaped (plugin errors, panics) degrades to IO with its text.
  return new IpcError('IO', typeof raw === 'string' ? raw : JSON.stringify(raw));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw toIpcError(raw);
  }
}

/** How long a header value may get before it is cut (see `headerText`). */
const MAX_HEADER_CHARS = 1024;

/**
 * A string made safe for an HTTP header value: printable ASCII on one line,
 * collapsed whitespace, capped. Anything else (a non-ASCII identifier, a
 * newline) would make Tauri reject the whole request, so it is dropped rather
 * than risking the call it rides on.
 */
function headerText(value: string): string {
  return value
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HEADER_CHARS);
}

/* Mirrors of the Rust structs (serde renames snake_case → camelCase). */

export interface FileText {
  text: string;
  mtimeMs: number;
}

export interface NoteMeta {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface PathStat {
  exists: boolean;
  mtimeMs: number | null;
}

export interface DirEntryMeta {
  path: string;
  isDir: boolean;
  mtimeMs: number;
  size: number;
}

/** Mirrors `SpawnOptions` in src-tauri/src/pty.rs. Desktop only. */
export interface PtySpawnArgs {
  cols: number;
  rows: number;
  /** Defaults to the user's login shell (`default_shell`). */
  program?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

/**
 * What arrives on the spawn channel. Child output is an `ArrayBuffer` — the
 * Rust side sends `InvokeResponseBody::Raw`, so bytes stay bytes across the
 * boundary. Control messages are tagged objects, ordered against the output
 * that preceded them because they share the one channel.
 */
export type PtyMessage =
  | ArrayBuffer
  | { type: 'exit'; code: number }
  | { type: 'closed' }
  // Once per attach, after the replayed output (see `ptyAttach`).
  | { type: 'replayEnd' };

/** One workspace-search hit (mirrors `SearchHit` in commands/search.rs). */
export interface SearchHit {
  path: string;
  line: number;
  col: number;
  lineText: string;
}

/** Progress on the whisper model download channel (mirrors `DownloadEvent` in Rust). */
export type WhisperDownloadEvent =
  { kind: 'progress'; received: number; total: number } | { kind: 'verifying' };

/**
 * One whisper model: manifest entry + on-disk state (mirrors `ModelStatus` in
 * commands/whisper/models.rs; the same shape as core's `WhisperModelStatus`,
 * declared here because ipc imports nothing app-local).
 */
export interface WhisperModelStatusWire {
  id: string;
  file: string;
  label: string;
  bytes: number;
  multilingual: boolean;
  installed: boolean;
  partialBytes: number;
}

/**
 * One checkout of a repository (mirrors `GitWorktree` in commands/git.rs).
 * `path` uses forward slashes; `branch` is null on a detached HEAD.
 */
export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string;
}

/** Where a file sits in git (mirrors `GitRepoInfo` in commands/git/mod.rs). */
export interface GitRepoInfo {
  /** Absolute root of the checkout the path is in, forward slashes. */
  root: string;
  /**
   * Absolute root of the repository's MAIN checkout (the first entry of
   * `git worktree list`), forward slashes. Equals `root` unless `root` is a
   * linked worktree. The git tab's identity: one tab per `mainRoot`.
   */
  mainRoot: string;
  /** The asked-about path relative to `root`, forward slashes. */
  rel: string;
  /** Short branch name, null on a detached HEAD. */
  branch: string | null;
  /** HEAD's commit sha; `''` in a repo with no commits yet. */
  head: string;
  /** True when `root` is a linked worktree, not the main checkout. */
  isWorktree: boolean;
  /** The baseline branch that exists locally, null when none does. */
  baseBranch: string | null;
  /**
   * `merge-base(HEAD, baseBranch)` — the revision "This branch" compares
   * against. Null when HEAD IS the base branch (compare against HEAD) or no
   * merge base is computable.
   */
  baseRef: string | null;
  /** Every checkout of this repository, the main one included. */
  worktrees: GitWorktree[];
}

/** Per branch: does its blob for the file differ from the baseline's? */
export interface GitFileChange {
  branch: string;
  differs: boolean;
}

/* The git TAB's wire shapes (src-tauri commands/git/). `src/core/git/types.ts`
   re-declares the ones core computes over, field for field. */

export type GitStatusEntryKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked';

/** One record of `git status --porcelain=v2 -z`. */
export interface GitStatusEntry {
  /** Relative to the checkout root, forward slashes. */
  path: string;
  /** A rename/copy's source path; null otherwise. */
  origPath: string | null;
  /** Index status letter (`.` = unchanged). */
  index: string;
  /** Working-tree status letter (`.` = unchanged). */
  worktree: string;
  kind: GitStatusEntryKind;
}

export type GitRepoState =
  'clean' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' | 'bisecting';

export interface GitStatus {
  /** HEAD's sha; `''` in a repo with no commits yet. */
  head: string;
  /** Short branch name; null on a detached HEAD. */
  branch: string | null;
  /** `origin/main`-style; null when nothing is tracked. */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  unborn: boolean;
  state: GitRepoState;
  /** `MERGE_HEAD` while merging. */
  mergeHead: string | null;
  entries: GitStatusEntry[];
}

export interface GitBranch {
  /** `feat/x` (local) or `origin/feat/x` (remote). */
  name: string;
  kind: 'local' | 'remote';
  head: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** Upstream configured but gone from the remote. */
  gone: boolean;
  /** Committer date, ISO 8601. */
  committedAt: string;
}

export interface GitCommit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  /** Author date, ISO 8601. */
  at: string;
  subject: string;
  body: string;
  /** `%D` decorations, one per item (`HEAD -> x`, `origin/x`, `tag: v1`, `HEAD`). */
  refs: string[];
}

/** One `--name-status` row: `status` is git's letter (A M D R C T U). */
export interface GitFileDelta {
  path: string;
  origPath: string | null;
  status: string;
}

export interface GitAheadBehind {
  ahead: number;
  behind: number;
}

export interface GitWorktreeSummary {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  /** The directory no longer exists; counts are zero. */
  missing: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  state: GitRepoState;
  /** Against the base branch; null with no base / no merge base. */
  ahead: number | null;
  behind: number | null;
}

export type GitMergeResult = 'merged' | 'fast-forward' | 'up-to-date' | 'conflicts';

export interface GitMergeOutcome {
  outcome: GitMergeResult;
  head: string;
  conflicted: string[];
}

export interface GitNetResult {
  ok: boolean;
  exitCode: number | null;
  stderr: string;
  /** `gitPull` only. */
  merge: GitMergeOutcome | null;
}

/**
 * What a fetch / pull / push streams over its channel. Rust: an enum tagged
 * `kind` with camelCase variants — `{kind:'line', stream, text}` per output
 * line (stderr carries git's progress) and one `{kind:'done'}` last.
 */
export type GitOutputEvent =
  { kind: 'line'; stream: 'out' | 'err'; text: string } | { kind: 'done' };

/**
 * Is this rejection git's absence rather than a real failure? True for
 * `GIT_NOT_FOUND` (no git binary), `GIT_NOT_A_REPO` (the file lives
 * outside a repository) and `GIT_UNTRUSTED` (git's `safe.directory` check
 * refused it) — all mean "hide the baseline picker with a hint", while
 * `GIT_TIMEOUT` / `GIT_FAILED` are worth reporting.
 */
export function isGitUnavailable(err: unknown): boolean {
  return (
    err instanceof IpcError &&
    (err.code === 'GIT_NOT_FOUND' || err.code === 'GIT_NOT_A_REPO' || err.code === 'GIT_UNTRUSTED')
  );
}

/** One raw entry from a synced-folder listing (name only, not a full id). */
export interface SafEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export const ipc = {
  readTextFile: (path: string) => call<FileText>('read_text_file', { path }),
  atomicWriteText: (path: string, text: string) => call<void>('atomic_write_text', { path, text }),
  listNotes: (dir: string) => call<NoteMeta[]>('list_notes', { dir }),
  /** One explorer level: subdirs + text/image/document files (dirs A→Z, files
   *  newest first). `allFiles` lists every file (unsupported files shown). */
  listDir: (dir: string, allFiles?: boolean) =>
    call<DirEntryMeta[]>('list_dir', { dir, allFiles: allFiles ?? false }),
  /** Recursive: does `dir`'s subtree hold anything the explorer would list (or
   *  an extension-less file)? `allFiles` counts any file. Local paths only —
   *  never call with `saf://`. */
  dirHasRelevantFiles: (dir: string, allFiles?: boolean) =>
    call<boolean>('dir_has_relevant_files', { dir, allFiles: allFiles ?? false }),
  /** The Marp slide decks (`marp: true` frontmatter) directly inside `dir` —
   *  the explorer badges them. Reads only each markdown file's head. Local
   *  paths only — never call with `saf://`. */
  listDeckFiles: (dir: string) => call<string[]>('list_deck_files', { dir }),
  /** Secondary-window manifests (`session-<label>.json`) in the session dir. */
  listSessionManifests: (dir: string) => call<string[]>('list_session_manifests', { dir }),
  /** Theme-plugin files (`*.json`) in the themes folder; full paths, sorted. */
  listThemeFiles: (dir: string) => call<string[]>('list_theme_files', { dir }),
  /** Binary file → base64 (image tabs build a data: URL from it). */
  readFileBase64: (path: string) => call<string>('read_file_base64', { path }),
  /** base64 → atomic binary write (pasted clipboard images). */
  writeFileBase64: (path: string, data: string) => call<void>('write_file_base64', { path, data }),
  /** Copy a file; refuses to clobber (EXISTS) like renamePath. */
  copyPath: (from: string, to: string) => call<void>('copy_path', { from, to }),
  /** Create a directory; refuses to clobber (EXISTS). */
  createDir: (path: string) => call<void>('create_dir', { path }),
  /** Recursive case-insensitive substring search under a LOCAL root (capped).
   *  `saf://` roots never come here — the frontend walks those itself. */
  searchNotes: (dir: string, query: string, maxResults: number) =>
    call<SearchHit[]>('search_notes', { dir, query, maxResults }),
  /** Desktop only: replace the set of recursively-watched workspace roots.
   *  Rust emits a debounced `fs-changed` event (payload: affected roots) when
   *  anything under them changes. Not registered on Android — only call
   *  behind a platform check. */
  watchDirs: (dirs: string[]) => call<void>('watch_dirs', { dirs }),
  /** Desktop only: flip the engine's own smooth wheel scrolling for THIS
   *  window (WebKitGTK's enable-smooth-scrolling; a no-op on Windows/macOS,
   *  whose engines have their own behavior). Not registered on Android —
   *  only call behind a platform check. */
  setSmoothScrolling: (enabled: boolean) => call<void>('set_smooth_scrolling', { enabled }),
  renamePath: (from: string, to: string) => call<void>('rename_path', { from, to }),
  deletePath: (path: string) => call<void>('delete_path', { path }),
  statPath: (path: string) => call<PathStat>('stat_path', { path }),
  /** Files from first-launch argv; call once at boot (see src-tauri/src/lib.rs). */
  drainStartupFiles: () => call<string[]>('drain_startup_files'),
  /**
   * Android only: the app-specific EXTERNAL files dir
   * (`/storage/emulated/0/Android/data/<pkg>/files`), or null if unavailable.
   * The command is not registered on desktop — only call it behind an Android
   * platform check (see src/ipc/paths.ts).
   */
  externalFilesDir: () => call<string | null>('external_files_dir'),
  /**
   * Android only: extract the bundled docs assets to a real filesystem path and
   * return it (null if unavailable). The APK ships docs as compressed assets the
   * std::fs-based read/list commands can't touch, so Settings "Open docs" needs
   * a POSIX copy. Not registered on desktop — only call behind an Android check
   * (see src/ipc/paths.ts).
   */
  extractDocsDir: () => call<string | null>('extract_docs_dir'),
  /**
   * Android only: read a `content://` URI's bytes (base64) + display name, for
   * copy-into-app open of an external file (picker or "Open with" intent). Not
   * registered on desktop — only call it behind an Android platform check.
   */
  readContentUri: (uri: string) =>
    call<{ base64: string; displayName?: string }>('read_content_uri', { uri }),
  /**
   * Android only: drain content:// URIs from incoming "Open with"/"Share"
   * intents since the last call. Called at boot and on window focus.
   */
  takeIncomingUris: () => call<string[]>('take_incoming_uris'),
  /**
   * Android only — Storage Access Framework (synced-folder workspaces). Each
   * addresses a document by (treeUri, relPath) under a persisted-permission
   * tree; the SafProvider (src/ipc/provider.ts) wraps these behind the same
   * `saf://` identifiers the storage router dispatches on. Not registered on
   * desktop — only call behind an Android platform check.
   */
  pickSyncedTree: () => call<{ treeUri: string; displayName?: string }>('pick_synced_tree'),
  safList: (treeUri: string, relPath: string) =>
    call<{ entries: SafEntry[] }>('saf_list', { treeUri, relPath }),
  /** Force a synced dir to re-fetch from its backend (picks up remote changes). */
  safRefresh: (treeUri: string, relPath: string) => call<void>('saf_refresh', { treeUri, relPath }),
  safRead: (treeUri: string, relPath: string) =>
    call<{ base64: string }>('saf_read', { treeUri, relPath }),
  safWrite: (treeUri: string, relPath: string, base64: string) =>
    call<void>('saf_write', { treeUri, relPath, base64 }),
  safCreateDir: (treeUri: string, relPath: string) =>
    call<void>('saf_create_dir', { treeUri, relPath }),
  safRename: (treeUri: string, relPath: string, newName: string) =>
    call<void>('saf_rename', { treeUri, relPath, newName }),
  safDelete: (treeUri: string, relPath: string) => call<void>('saf_delete', { treeUri, relPath }),
  safStat: (treeUri: string, relPath: string) =>
    call<{ exists: boolean; isDir?: boolean; size?: number; mtimeMs?: number }>('saf_stat', {
      treeUri,
      relPath,
    }),
  releaseSyncedTree: (treeUri: string) => call<void>('release_synced_tree', { treeUri }),
  /**
   * Speech-to-text for voice notes — Android only (SpeechRecognizer,
   * on-device; src-tauri commands/android.rs). Windows uses voice typing
   * instead (`voiceTypingToggle` below). Native bridges,
   * not storage ops, so they're called directly behind the
   * `dictationEngine()` check in ui/voice-comments.ts, never through a
   * StorageProvider. Not registered on desktop.
   *   - sttAvailable: can the platform's recognizer run on this device?
   *   - sttPermission: current microphone grant, no prompt.
   *   - sttRequestPermission: prompt if needed; resolves the resulting grant.
   *   - sttStart: begin listening; resolves the final transcript text.
   *   - sttStop: stop listening (the final transcript still resolves sttStart).
   */
  sttAvailable: () => call<boolean>('stt_available'),
  sttPermission: () => call<boolean>('stt_permission'),
  sttRequestPermission: () => call<boolean>('stt_request_permission'),
  sttStart: () => call<string>('stt_start'),
  sttStop: () => call<void>('stt_stop'),
  /**
   * Windows only — press Win+H, which opens or closes Windows voice typing in
   * the focused text field (the voice-note sheet's draft box). Called behind
   * the `dictationEngine()` check in ui/voice-comments.ts; not registered on
   * other platforms. Rejects `VOICE_TYPING_FAILED:<reason>`.
   */
  voiceTypingToggle: () => call<void>('voice_typing_toggle'),
  /**
   * Android only — take a photo with the system camera (whiteboard scan, S0).
   * Same native-bridge shape as the `stt_*` commands: called directly behind an
   * `isAndroid()` check, never through a StorageProvider, and not registered on
   * desktop (which uses the file picker / clipboard instead).
   *
   * Resolves a JPEG as base64, already EXIF-upright and downscaled on the
   * Kotlin side. Rejects (as an `IpcError` with code `IO`) carrying the native
   * reason: `PERMISSION_DENIED`, `cancelled`, or `NO_CAMERA`.
   */
  capturePhoto: () => call<{ base64: string; width: number; height: number }>('capture_photo'),
  /**
   * Android only — on-device handwriting recognition for the whiteboard scan
   * (S6). Same native-bridge shape as `stt_*`/`capturePhoto`: called behind an
   * `isAndroid()` check, not registered on desktop.
   *
   * `inkRecognize` takes a JSON payload (built by `src/ui/scan-ocr.ts`) of
   * text lines, each a list of strokes in a shared pixel space — ML Kit
   * Digital Ink is a stroke model, and the traced centerlines ARE strokes.
   * Kotlin downloads the language model on first use (may take a while on the
   * first scan; recognition is async by design so nothing blocks on it).
   * Rejects with `INK_UNAVAILABLE` when no model exists for the device
   * language — the caller falls back to `textRecognize`.
   *
   * `textRecognize` runs ML Kit Text Recognition (the printed-text raster
   * model) over a PNG; the fallback when the ink model is missing or fails.
   */
  inkRecognize: (payload: string) =>
    call<{ lines: { text: string; confidence: number | null }[] }>('ink_recognize', { payload }),
  textRecognize: (base64: string) =>
    call<{
      lines: {
        text: string;
        confidence: number | null;
        x: number;
        y: number;
        width: number;
        height: number;
      }[];
    }>('text_recognize', { base64 }),
  /**
   * Windows only — on-device OCR over the cleaned scan raster via
   * `Windows.Media.Ocr` (ships with Windows 10/11, offline). Called behind an
   * `isWindows()` check; not registered on macOS/Linux, which report the scan
   * OCR as unavailable. Line boxes come back in the PNG's own pixel space;
   * confidence is always null (the engine reports none).
   */
  ocrImageAvailable: () => call<boolean>('ocr_image_available'),
  ocrImageRecognize: (pngBase64: string) =>
    call<{
      engine: string;
      lines: {
        text: string;
        confidence: number | null;
        x: number;
        y: number;
        width: number;
        height: number;
      }[];
    }>('ocr_image_recognize', { pngBase64 }),

  /* --------------------------- whisper models --------------------------- */
  /* Every platform (src-tauri commands/whisper): offline voice-note
     transcription. */

  /** The model manifest joined with what is on disk. */
  whisperModelsList: () => call<WhisperModelStatusWire[]>('whisper_models_list'),
  /** Bytes of model files an earlier version downloaded that are no longer offered. */
  whisperModelsStray: () => call<number>('whisper_models_stray'),
  /** Delete those files. */
  whisperModelsPrune: () => call<void>('whisper_models_prune'),
  /** "vulkan" / "metal" / "none": what this build on this machine can hand the model to. */
  whisperAccelerator: () => call<'vulkan' | 'metal' | 'none'>('whisper_accelerator'),
  /** Where model files live (`<appData>/whisper`), created if missing. */
  whisperModelDir: () => call<string>('whisper_model_dir'),
  /**
   * Download (or resume) one model, verified against its pinned SHA-256.
   * Resolves once the file is in place; rejects `WHISPER_DOWNLOAD_*` (a
   * cancel rejects `WHISPER_DOWNLOAD_CANCELLED` and keeps the part to resume).
   */
  whisperModelDownload: (id: string, onProgress: Channel<WhisperDownloadEvent>) =>
    call<void>('whisper_model_download', { id, onProgress }),
  whisperModelCancel: () => call<void>('whisper_model_cancel'),
  whisperModelDelete: (id: string) => call<void>('whisper_model_delete', { id }),
  /**
   * Load the model into memory now, so the load overlaps the talking. Rejects
   * `WHISPER_NO_MODEL` / `WHISPER_LOAD_FAILED` — the capture fails early.
   */
  whisperPrepare: (modelId: string, useGpu: boolean) =>
    call<void>('whisper_prepare', { modelId, useGpu }),
  /**
   * Transcribe a capture. The PCM goes as the raw request body (f32 LE mono —
   * no JSON, no base64; ten minutes is ≈ 38 MB) with the rate and model in
   * headers. Resolves the transcript, "" for silence.
   *
   * `hint` is whisper.cpp's initial prompt: words the decoder should expect
   * (Review mode passes the file's identifiers — `core/code/vocab.ts`
   * `identifierHint`). It rides in the `hint` header, so it is flattened to
   * printable ASCII on one line and capped; without it nothing changes.
   */
  whisperTranscribe: async (
    pcm: Float32Array,
    sampleRate: number,
    modelId: string,
    useGpu: boolean,
    hint?: string,
  ) => {
    const prompt = hint ? headerText(hint) : '';
    try {
      return await invoke<string>(
        'whisper_transcribe',
        new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        {
          headers: {
            'sample-rate': String(sampleRate),
            'model-id': modelId,
            'use-gpu': useGpu ? 'true' : 'false',
            ...(prompt ? { hint: prompt } : {}),
          },
        },
      );
    } catch (raw) {
      throw toIpcError(raw);
    }
  },

  /* ------------------------------ git facts ----------------------------- */
  /* Desktop only (src-tauri commands/git.rs): Review mode's "What changed".
     Not registered on Android, and a machine without the `git` binary rejects
     `GIT_NOT_FOUND` — call behind `isGitUnavailable` and hide the baseline
     picker when it says so. Every call has a 3 s timeout in Rust. */

  /**
   * Where `path` sits in git: root, `rel`, branch, HEAD, the baseline branch
   * and its merge-base, and every worktree of the repository. `baseBranch` is
   * the `reviewBaseBranch` setting — pass it only when non-empty; a branch this
   * checkout does not have falls back to auto-detection (development / main /
   * master).
   */
  gitRepoInfo: (path: string, baseBranch?: string) =>
    call<GitRepoInfo>('git_repo_info', { path, baseBranch: baseBranch ?? null }),
  /**
   * One file's text at a revision (`git show <rev>:<rel>`), or null when it did
   * not exist there — which is how a NEW file reads, not a failure.
   */
  gitShowFile: (root: string, rev: string, rel: string) =>
    call<string | null>('git_show_file', { root, rev, rel }),
  /**
   * The worktree radar: for each branch, does its blob for `rel` differ from
   * `baseRef`'s? Missing on exactly one side counts as a difference. One
   * `rev-parse` per branch — no checkouts.
   */
  gitFileChanges: (root: string, rel: string, baseRef: string, branches: string[]) =>
    call<GitFileChange[]>('git_file_changes', { root, rel, baseRef, branches }),
  /**
   * Answer a `GIT_UNTRUSTED` refusal: add the repository holding `path` to the
   * user's global `safe.directory` list (the path git itself names). Call only
   * after the user confirmed; a repository git already trusts is a no-op.
   */
  gitTrustDirectory: (path: string) => call<void>('git_trust_directory', { path }),

  /* ------------------------------ git tab ------------------------------- */
  /* Desktop only (src-tauri commands/git/). `root` is always the CHECKOUT to
     act in (the main root or a linked worktree's path). Reads are killed at
     3 s, mutations at 30 s; fetch/pull/push stream for up to 120 s and can be
     cancelled. Every user-supplied string (branch, path, message) is passed
     as one argv element and validated in Rust (`GIT_INVALID_ARG` is a caller
     bug — validate first with core/git/refs.ts). Nothing here ever prompts:
     `GIT_TERMINAL_PROMPT=0`, stdin closed. */

  /** `git status --porcelain=v2` plus the in-progress-operation state. */
  gitStatus: (root: string) => call<GitStatus>('git_status', { root }),
  /** Local and remote branches with tracking info. */
  gitBranches: (root: string) => call<GitBranch[]>('git_branches', { root }),
  /** `max` commits reachable from `rev` (HEAD when null), skipping `skip`. `[]` on an unborn HEAD. */
  /**
   * `all`: every branch, remote and tag (plus HEAD) in `--date-order` — the
   * graph's view; otherwise `rev` (HEAD when null) in git's default order.
   */
  gitLog: (root: string, rev: string | null, max: number, skip: number, all = false) =>
    call<GitCommit[]>('git_log', { root, rev, max, skip, all }),
  /** The files one commit touched (renames detected). */
  gitCommitFiles: (root: string, sha: string) =>
    call<GitFileDelta[]>('git_commit_files', { root, sha }),
  /** The files differing between `from`'s merge base with `to` and `to` (`from...to`). */
  gitDiffNames: (root: string, from: string, to: string) =>
    call<GitFileDelta[]>('git_diff_names', { root, from, to }),
  /** `rev-list --left-right --count a...b`. */
  gitAheadBehind: (root: string, a: string, b: string) =>
    call<GitAheadBehind>('git_ahead_behind', { root, a, b }),
  /**
   * Every checkout with its dashboard facts (dirty counts, ahead/behind the
   * base branch). `baseBranch` as for `gitRepoInfo`; pass only when non-empty.
   */
  gitWorktrees: (root: string, baseBranch?: string) =>
    call<GitWorktreeSummary[]>('git_worktrees', { root, baseBranch: baseBranch ?? null }),
  /** Is `rel` ignored (`check-ignore`)? */
  gitCheckIgnore: (root: string, rel: string) => call<boolean>('git_check_ignore', { root, rel }),

  /** `add -A -- <rels>`: stages modifications, additions and deletions alike. */
  gitStage: (root: string, rels: string[]) => call<void>('git_stage', { root, rels }),
  gitUnstage: (root: string, rels: string[]) => call<void>('git_unstage', { root, rels }),
  /**
   * Throw away working-tree changes: `tracked` paths are restored from HEAD,
   * `untracked` paths (files, or `dir/` entries as status lists them) are
   * deleted. Irreversible — the caller confirms first.
   */
  gitDiscard: (root: string, tracked: string[], untracked: string[]) =>
    call<void>('git_discard', { root, tracked, untracked }),
  /**
   * Commit the index; resolves with the new sha. `message` null means
   * `--no-edit`: finishing a merge with git's prepared message, or an amend
   * that keeps the old one. An empty string is `GIT_INVALID_ARG`.
   */
  gitCommit: (root: string, message: string | null, amend: boolean) =>
    call<string>('git_commit', { root, message, amend }),
  /**
   * `switch <name>`, or with `trackRemote` (`origin`) create a local branch
   * tracking `<trackRemote>/<name>` and switch to it. A dirty tree that would
   * be overwritten rejects `GIT_FAILED` with git's own message.
   */
  gitSwitch: (root: string, name: string, trackRemote: string | null) =>
    call<void>('git_switch', { root, name, trackRemote }),
  gitCreateBranch: (root: string, name: string, startPoint: string | null, switchTo: boolean) =>
    call<void>('git_create_branch', { root, name, startPoint, switchTo }),
  /** `branch -d` (or `-D` with `force`). Refuses a branch checked out in a worktree. */
  gitDeleteBranch: (root: string, name: string, force: boolean) =>
    call<void>('git_delete_branch', { root, name, force }),
  /**
   * `merge --no-edit <target>` into the checkout's current branch. A conflict
   * is an OUTCOME (`conflicts` with the paths), not an error; a refusal (dirty
   * tree, unrelated histories) is `GIT_FAILED`.
   */
  gitMerge: (root: string, target: string, noFf: boolean) =>
    call<GitMergeOutcome>('git_merge', { root, target, noFf }),
  gitMergeAbort: (root: string) => call<void>('git_merge_abort', { root }),
  /**
   * `worktree add`: with `createBranch`, `-b <branch> <path> [<startPoint>]`;
   * otherwise checks out the existing `branch` at `path`. `path` is absolute.
   */
  gitWorktreeAdd: (
    root: string,
    path: string,
    branch: string,
    startPoint: string | null,
    createBranch: boolean,
  ) => call<void>('git_worktree_add', { root, path, branch, startPoint, createBranch }),
  /** `worktree remove [--force] <path>` then `worktree prune`. Refuses a dirty worktree unless forced. */
  gitWorktreeRemove: (root: string, path: string, force: boolean) =>
    call<void>('git_worktree_remove', { root, path, force }),

  /* Network: one op per repository at a time (`GIT_BUSY`); `opId` is the
     caller's handle for `gitOpCancel`, allocated by src/ipc/git-ops.ts. A
     failed push/fetch is a RESULT (`ok:false` + stderr), not a rejection. */
  gitFetch: (
    root: string,
    remote: string | null,
    prune: boolean,
    opId: number,
    onOutput: Channel<GitOutputEvent>,
  ) => call<GitNetResult>('git_fetch', { root, remote, prune, opId, onOutput }),
  /** `pull --no-rebase --no-edit`; `merge` on the result says how the merge half ended. */
  gitPull: (root: string, opId: number, onOutput: Channel<GitOutputEvent>) =>
    call<GitNetResult>('git_pull', { root, opId, onOutput }),
  /** `push`, or `push -u <remote> HEAD` with `setUpstream` (publishing a branch). */
  gitPush: (
    root: string,
    remote: string | null,
    setUpstream: boolean,
    opId: number,
    onOutput: Channel<GitOutputEvent>,
  ) => call<GitNetResult>('git_push', { root, remote, setUpstream, opId, onOutput }),
  gitOpCancel: (opId: number) => call<void>('git_op_cancel', { opId }),

  /* ---------------------------- terminal pty ---------------------------- */
  /* Desktop only: these commands are not registered on Android (no pty).
     Everything above the IPC layer goes through src/ipc/pty.ts, never here. */

  /** The shell a profile spawns when it names no program. */
  defaultShell: () => call<string>('default_shell'),
  /** Desktop only: where each program name resolves on `PATH` (honoring
   *  `PATHEXT` on Windows, so an npm `.cmd` shim counts), or null when it is
   *  not installed. Every requested name is a key in the answer. Not
   *  registered on Android — only call behind a platform check. */
  findPrograms: (names: string[]) =>
    call<Record<string, string | null>>('find_programs', { names }),

  ptySpawn: (options: PtySpawnArgs, onEvent: Channel<PtyMessage>) =>
    call<number>('pty_spawn', { options, onEvent }),

  // `invoke` args are JSON, and a Uint8Array would stringify to `{"0":…}`,
  // which serde rejects. Keystrokes and chunked pastes are small (paste is
  // already split into 4 KB writes by renderer/paste.ts).
  ptyWrite: (id: number, data: Uint8Array) =>
    call<void>('pty_write', { id, data: Array.from(data) }),

  ptyResize: (id: number, cols: number, rows: number) =>
    call<void>('pty_resize', { id, cols, rows }),

  ptyKill: (id: number) => call<void>('pty_kill', { id }),

  /**
   * Re-point a live pty at this window, replaying the output it buffered
   * while detached. This is how a terminal tab dragged into another window
   * keeps the SAME shell: the pty registry is app-wide, only the listener is
   * per-webview. `NOT_FOUND` = the session is gone; spawn a fresh one.
   *
   * `cols`/`rows` are the grid the pty is moving INTO; the backend resizes to
   * them before it replays, so the shell's redraw-on-resize is part of the
   * replay rather than something painted over it. Resolves with this
   * listener's epoch, which `ptyDetach` quotes back.
   */
  ptyAttach: (id: number, cols: number, rows: number, onEvent: Channel<PtyMessage>) =>
    call<number>('pty_attach', { id, cols, rows, onEvent }),

  /**
   * Stop listening to a pty without killing it — the releasing half of a
   * handover. `epoch` is this listener's (0 for the window that spawned the
   * pty): a detach from a listener another window has already replaced is
   * ignored, so the two halves of a handover cannot race into silence.
   */
  ptyDetach: (id: number, epoch: number) => call<void>('pty_detach', { id, epoch }),
};

export type Ipc = typeof ipc;

/** Injectable so tests can drive a pty provider without a Tauri runtime. */
export type ChannelFactory = () => Channel<PtyMessage>;

export const createIpcChannel: ChannelFactory = () => new Channel<PtyMessage>();

/** The progress channel `whisperModelDownload` takes (mockable in store tests). */
export const createWhisperChannel = (): Channel<WhisperDownloadEvent> =>
  new Channel<WhisperDownloadEvent>();

/** The output channel `gitFetch` / `gitPull` / `gitPush` take (src/ipc/git-ops.ts injects a fake). */
export const createGitOutputChannel = (): Channel<GitOutputEvent> => new Channel<GitOutputEvent>();
