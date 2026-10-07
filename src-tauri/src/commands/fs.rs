//! Filesystem commands — the entire custom IPC surface of the app.
//!
//! Design rules (see ../../README.md):
//! - Rust stays thin: no business logic, no knowledge of tabs or sessions.
//!   Which file to write, when, and what to do on conflict is TS logic.
//! - Every write of user content is atomic: tempfile in the target's own
//!   directory → write → fsync → rename over the target.
//! - Errors cross IPC as `{ code, message }`. The TS mirror of the `code`
//!   union lives in `src/ipc/commands.ts` — keep both sides in sync.
//! - Every command is `async`: Tauri runs sync commands on the native
//!   event-loop thread, so a slow disk (network drive, spun-down HDD) would
//!   freeze window dragging/resizing. `async` moves them to the thread pool.

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Error contract. `code` is a closed union the frontend switches on;
/// `message` is for logging/status-bar display only, never for logic.
#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("path not found: {0}")]
    NotFound(PathBuf),
    #[error("destination already exists: {0}")]
    Exists(PathBuf),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("invalid data: {0}")]
    InvalidData(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl FsError {
    pub fn code(&self) -> &'static str {
        match self {
            FsError::NotFound(_) => "NOT_FOUND",
            FsError::Exists(_) => "EXISTS",
            FsError::InvalidPath(_) => "INVALID_PATH",
            FsError::InvalidData(_) => "INVALID_DATA",
            FsError::Io(_) => "IO",
        }
    }
}

impl Serialize for FsError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("FsError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type FsResult<T> = Result<T, FsError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStat {
    pub exists: bool,
    pub mtime_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryMeta {
    pub path: String,
    pub is_dir: bool,
    pub mtime_ms: u64,
    pub size: u64,
}

/// Extensions the explorer shows besides `.md`. Kept in sync with the TS
/// mirror in `src/core/images.ts` (both sides filter; Rust is the gatekeeper).
const IMAGE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

/// Audio the explorer lists and the audio tab plays. Mirrors `AUDIO_MIME` in
/// `src/core/audio.ts`.
const AUDIO_EXTENSIONS: [&str; 9] = [
    "mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba",
];

// Foreign documents the app can offer to import as markdown. Mirrors the TS
// import registry (src/core/import/registry.ts) — the SAF (Android) listing
// filters with that registry; this desktop `list_dir` path keeps its own copy.
const IMPORT_EXTENSIONS: [&str; 2] = ["pdf", "docx"];

/// Editable text notes the explorer lists and the editor opens directly.
/// Mirrors the TS definition in `src/core/text-files.ts`.
const TEXT_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

fn has_extension(path: &Path, wanted: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(wanted))
}

fn is_image_path(path: &Path) -> bool {
    IMAGE_EXTENSIONS.iter().any(|ext| has_extension(path, ext))
}

fn is_audio_path(path: &Path) -> bool {
    AUDIO_EXTENSIONS.iter().any(|ext| has_extension(path, ext))
}

fn is_importable_path(path: &Path) -> bool {
    IMPORT_EXTENSIONS.iter().any(|ext| has_extension(path, ext))
}

/// Shared with `search.rs` (the workspace-search walker filters on it too).
pub(crate) fn is_text_path(path: &Path) -> bool {
    TEXT_EXTENSIONS.iter().any(|ext| has_extension(path, ext))
}

/// A file the explorer lists by default: text note, image, audio, or
/// importable doc.
fn is_listed_file(path: &Path) -> bool {
    is_text_path(path) || is_image_path(path) || is_audio_path(path) || is_importable_path(path)
}

/// Hidden by the host platform's convention — what the explorer skips unless
/// the user turned on "Show hidden files":
/// - a dot-prefixed name, everywhere (the Unix rule; Windows tools such as
///   git and npm create `.git` / `.vscode` there too);
/// - Windows: the `FILE_ATTRIBUTE_HIDDEN` attribute (what Explorer's "Hidden
///   items" toggles). `DirEntry::metadata` comes from the enumeration on
///   Windows, so this costs no extra stat — and never hydrates a cloud
///   placeholder;
/// - macOS: the `UF_HIDDEN` flag (`chflags hidden`, e.g. `~/Library`) —
///   what Finder's Cmd+Shift+. reveals. An lstat, taken only for names that
///   are not already dot-hidden.
pub(crate) fn is_hidden_entry(entry: &fs::DirEntry) -> bool {
    if entry.file_name().to_string_lossy().starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Ok(meta) = entry.metadata() {
            return meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const UF_HIDDEN: u32 = 0x8000;
        if let Ok(meta) = entry.metadata() {
            return meta.st_flags() & UF_HIDDEN != 0;
        }
    }
    false
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn not_found_or_io(e: std::io::Error, path: &Path) -> FsError {
    if e.kind() == std::io::ErrorKind::NotFound {
        FsError::NotFound(path.to_path_buf())
    } else {
        FsError::Io(e)
    }
}

/// Read a UTF-8 text file plus its mtime in one IPC round trip.
/// The mtime is the baseline for external-change conflict detection (M3).
/// A file that isn't text — invalid UTF-8, or a NUL byte (which valid UTF-8
/// binaries still carry) — is `INVALID_DATA`, so the frontend can say "not a
/// text file" instead of opening a tab of garbage. The explorer lists every
/// file in folders where unsupported files are shown; this is the gate.
#[tauri::command]
pub async fn read_text_file(path: PathBuf) -> FsResult<FileText> {
    let meta = fs::metadata(&path).map_err(|e| not_found_or_io(e, &path))?;
    let bytes = fs::read(&path).map_err(|e| not_found_or_io(e, &path))?;
    let text = match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => text,
        _ => {
            return Err(FsError::InvalidData(format!(
                "not a text file: {}",
                path.display()
            )))
        }
    };
    Ok(FileText {
        text,
        mtime_ms: mtime_ms(&meta),
    })
}

/// Atomically replace `path` with `text` (creating parent dirs if needed).
///
/// The temp file MUST live in the same directory as the target: rename is
/// only atomic within one filesystem. `NamedTempFile::persist` uses
/// rename(2) on Unix and MoveFileExW(MOVEFILE_REPLACE_EXISTING) on Windows —
/// plain `std::fs::rename` would fail on Windows when the target exists,
/// which is the classic cross-platform trap this function exists to bury.
/// `sync_all` before the rename ensures a crash can't leave a renamed-but-
/// empty file.
#[tauri::command]
pub async fn atomic_write_text(path: PathBuf, text: String) -> FsResult<()> {
    atomic_write_bytes(&path, text.as_bytes())
}

/// Shared atomic-write core for text and binary payloads.
fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> FsResult<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            FsError::InvalidPath(format!("{} has no parent directory", path.display()))
        })?;
    fs::create_dir_all(dir)?;
    let mut tmp = temp_beside(path, dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| FsError::Io(e.error))?;
    Ok(())
}

/// Filename prefix for the scratch file of a write to `path`: `.<name>.`
/// (`tempfile` appends its own random middle and our `.tmp` suffix, giving
/// `.note.md.a1b2c3.tmp`).
///
/// The temp file is forced to live beside its target (rename is only atomic
/// within one filesystem), which on a cloud-synced workspace — a Google Drive
/// streaming folder, OneDrive, Dropbox — means the sync client sees it. A
/// random bare name like `.tmpA1b2C3` reads to those clients as a real new
/// document: it gets uploaded, then renamed, leaving churn and trashed
/// revisions behind. Dot-prefixed with a `.tmp` extension matches the temp-file
/// shape their ignore rules look for, and it is hidden from our own explorer
/// (`list_dir` skips dot-prefixed entries) either way. Best-effort — no sync
/// client guarantees an ignore list — but strictly better than a random name,
/// and it makes an orphan obvious: the file says which write left it.
fn temp_prefix(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("file");
    format!(".{name}.")
}

/// A scratch file in `dir` named after `path` (see `temp_prefix`). The random
/// middle `tempfile` inserts is what keeps two concurrent writes to the same
/// target from colliding, so it stays.
fn temp_beside(path: &Path, dir: &Path) -> std::io::Result<tempfile::NamedTempFile> {
    tempfile::Builder::new()
        .prefix(&temp_prefix(path))
        .suffix(".tmp")
        .tempfile_in(dir)
}

/// Atomically write base64-decoded bytes (pasted clipboard images). Same
/// guarantees as `atomic_write_text`; bad base64 is INVALID_DATA.
#[tauri::command]
pub async fn write_file_base64(path: PathBuf, data: String) -> FsResult<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| FsError::InvalidData(format!("bad base64: {e}")))?;
    atomic_write_bytes(&path, &bytes)
}

/// Create a directory (explorer "New folder"). Refuses to clobber (EXISTS) —
/// collision suffixes are frontend logic, mirroring `rename_path`'s contract.
#[tauri::command]
pub async fn create_dir(path: PathBuf) -> FsResult<()> {
    if path.exists() {
        return Err(FsError::Exists(path));
    }
    fs::create_dir_all(&path)?;
    Ok(())
}

/// Copy a file, or a directory and everything inside it (the explorer's
/// copy/paste of a folder). Refuses to clobber (EXISTS) — collision suffixes
/// are frontend logic, mirroring `rename_path`'s contract.
#[tauri::command]
pub async fn copy_path(from: PathBuf, to: PathBuf) -> FsResult<()> {
    if !from.exists() {
        return Err(FsError::NotFound(from));
    }
    if to.exists() {
        return Err(FsError::Exists(to));
    }
    if from.is_dir() {
        // Copying a folder INTO itself would recurse until the disk fills; the
        // frontend refuses it too (core/explorer-clipboard checkPaste), but the
        // guard belongs on this side of the wire as well.
        if to.starts_with(&from) {
            return Err(FsError::InvalidPath(format!(
                "{} is inside {}",
                to.display(),
                from.display()
            )));
        }
        return copy_dir_recursive(&from, &to);
    }
    copy_file_atomic(&from, &to)
}

/// Copy the directory tree at `from` to `to` (which must not exist). Files go
/// through `copy_file_atomic`, so a crash leaves whole files or none — the tree
/// itself is not atomic, which is the same deal `delete_path` offers.
/// Symlinks are followed by `is_dir`/`copy`, matching `fs::copy`'s behaviour;
/// the app never creates any.
fn copy_dir_recursive(from: &Path, to: &Path) -> FsResult<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            copy_file_atomic(&src, &dst)?;
        }
    }
    Ok(())
}

/// Copy the file at `from` onto `to` through a temp file in the DESTINATION's
/// own directory, then atomically rename into place — same invariant as
/// `atomic_write_bytes`, so a crash mid-copy can't leave a half-written file at
/// `to`. Shared by `copy_path` and `rename_path`'s cross-filesystem fallback;
/// neither existence check lives here (each caller owns its own contract).
fn copy_file_atomic(from: &Path, to: &Path) -> FsResult<()> {
    let dir = to
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| FsError::InvalidPath(format!("{} has no parent directory", to.display())))?;
    fs::create_dir_all(dir)?;
    let mut tmp = temp_beside(to, dir)?;
    {
        let mut src = fs::File::open(from).map_err(|e| not_found_or_io(e, from))?;
        std::io::copy(&mut src, tmp.as_file_mut())?;
    }
    tmp.as_file().sync_all()?;
    tmp.persist(to).map_err(|e| FsError::Io(e.error))?;
    Ok(())
}

/// List `.md` files directly inside `dir` (no recursion), newest first.
/// A missing dir is an empty list, not an error — first launch has no notes.
#[tauri::command]
pub async fn list_notes(dir: PathBuf) -> FsResult<Vec<NoteMeta>> {
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut notes = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let is_md = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
        if !is_md {
            continue;
        }
        // Classify without stat'ing (see `list_dir`): `file_type()` is free from
        // the enumeration, while `metadata()` can block on a cloud placeholder.
        // A `.md` whose stat fails is still listed with zeroed mtime/size.
        match entry.file_type() {
            Ok(t) if t.is_file() => {}
            Ok(_) => continue,
            Err(_) => continue,
        }
        let (mtime_ms, size) = match entry.metadata() {
            Ok(m) => (mtime_ms(&m), m.len()),
            Err(_) => (0, 0),
        };
        notes.push(NoteMeta {
            path: path.to_string_lossy().into_owned(),
            mtime_ms,
            size,
        });
    }
    notes.sort_by_key(|note| std::cmp::Reverse(note.mtime_ms));
    Ok(notes)
}

/// List one directory level for the file explorer: subdirectories plus text
/// notes (`.md`/`.txt`) and image files (no recursion — the frontend expands
/// folders lazily).
/// `all_files` lists every file instead — a folder where the user turned on
/// "Show unsupported files" (the frontend decides which folders; see
/// `src/core/text-files.ts`).
/// Hidden entries (`is_hidden_entry`: dot-prefixed, plus the Windows hidden
/// attribute / macOS hidden flag) are skipped unless `show_hidden` — the
/// global "Show hidden files" setting. Order: directories A→Z, then
/// files A→Z (case-insensitive). The explorer re-sorts what it gets with
/// `src/core/explorer-sort.ts` — the SAF backend returns its own order, so the
/// displayed order (which also compares digit runs numerically) is decided
/// there; this order just keeps the raw listing stable. Missing dir = empty
/// list.
#[tauri::command]
pub async fn list_dir(
    dir: PathBuf,
    all_files: Option<bool>,
    show_hidden: Option<bool>,
) -> FsResult<Vec<DirEntryMeta>> {
    let all_files = all_files.unwrap_or(false);
    let show_hidden = show_hidden.unwrap_or(false);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !show_hidden && is_hidden_entry(&entry) {
            continue;
        }
        // Classify via `file_type()`, which comes straight from the directory
        // enumeration and does NOT stat the entry. On a cloud-synced folder
        // (Google Drive / OneDrive "Files On-Demand") a per-entry `metadata()`
        // can block while the provider hydrates a placeholder — doing that for
        // every entry is what left the explorer stuck on "Loading…". `metadata`
        // is now fetched best-effort, only for the mtime/size fields, and a file
        // whose stat fails is still listed (mtime/size default to 0) rather than
        // silently dropped.
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let is_dir = file_type.is_dir();
        let is_file = file_type.is_file();
        let (mtime_ms, size) = match entry.metadata() {
            Ok(m) => (mtime_ms(&m), m.len()),
            Err(_) => (0, 0),
        };
        let item = DirEntryMeta {
            path: path.to_string_lossy().into_owned(),
            is_dir,
            mtime_ms,
            size,
        };
        if is_dir {
            dirs.push(item);
        } else if is_file && (all_files || is_listed_file(&path)) {
            files.push(item);
        }
    }
    dirs.sort_by_key(|d| d.path.to_lowercase());
    files.sort_by_key(|f| f.path.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

/// Depth cap for the relevance walk below — the same cheap symlink-loop guard
/// as the search walker's `MAX_DEPTH` (a genuine tree this deep is beyond what
/// the lazily-expanded explorer can display anyway).
const RELEVANCE_MAX_DEPTH: usize = 16;

/// Does `dir`'s subtree hold at least one file the explorer would list — a
/// text note, image, or importable document — or an extension-less file?
/// Files are checked before descending, so the common case (a folder with
/// notes right in it) answers on one `read_dir`. Unreadable dirs count as
/// empty (best-effort, like the search walk). `all_files` (unsupported files
/// shown) makes any non-hidden file count; `show_hidden` counts (and walks
/// into) hidden entries too.
fn subtree_has_relevant_file(dir: &Path, depth: usize, all_files: bool, show_hidden: bool) -> bool {
    if depth > RELEVANCE_MAX_DEPTH {
        return false;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        if !show_hidden && is_hidden_entry(&entry) {
            continue;
        }
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            subdirs.push(path);
        } else if file_type.is_file()
            && (all_files || is_listed_file(&path) || path.extension().is_none())
        {
            return true;
        }
    }
    subdirs
        .iter()
        .any(|sub| subtree_has_relevant_file(sub, depth + 1, all_files, show_hidden))
}

/// Whether the explorer should render `dir` normally (true) or washed out
/// (false = nothing worth finding anywhere in its subtree). Missing dir =
/// false, matching `list_dir`'s missing-dir-is-empty policy.
#[tauri::command]
pub async fn dir_has_relevant_files(
    dir: PathBuf,
    all_files: Option<bool>,
    show_hidden: Option<bool>,
) -> bool {
    subtree_has_relevant_file(
        &dir,
        0,
        all_files.unwrap_or(false),
        show_hidden.unwrap_or(false),
    )
}

/// How much of a markdown file `is_marp_head` looks at. YAML frontmatter sits
/// at the very top, so a fixed-size head is enough and bounds the cost of
/// scanning a folder: the explorer badge must never turn a listing into a
/// full read of every note.
const FRONTMATTER_HEAD_BYTES: usize = 4096;

/// Mirror of `isMarpDocument` (`src/core/deck.ts`) over the HEAD of a file:
/// the frontmatter opens with `---` on line 1 and declares `marp: true`
/// before its closing `---` / `...`. The TS version is the source of truth —
/// this copy exists only so the explorer can classify a whole folder without
/// shipping every note's text across IPC. CRLF-safe, like its mirror.
fn is_marp_head(head: &str) -> bool {
    let mut lines = head.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l));
    if lines.next() != Some("---") {
        return false;
    }
    for line in lines {
        if is_frontmatter_close(line) {
            return false; // closed without `marp: true`
        }
        if is_marp_true(line) {
            return true;
        }
    }
    // Unclosed within the head: an unterminated opener is just text, and a
    // `marp: true` further down would have matched above.
    false
}

/// `-{3,}` or `...`, trailing spaces/tabs allowed (TS `FRONTMATTER_CLOSE`).
fn is_frontmatter_close(line: &str) -> bool {
    let body = line.trim_end_matches([' ', '\t']);
    body == "..." || (body.len() >= 3 && body.chars().all(|c| c == '-'))
}

/// `marp:` `true`, spaces/tabs around the colon and trailing (TS `MARP_TRUE`).
fn is_marp_true(line: &str) -> bool {
    let rest = match line.strip_prefix("marp") {
        Some(rest) => rest.trim_start_matches([' ', '\t']),
        None => return false,
    };
    match rest.strip_prefix(':') {
        Some(rest) => {
            rest.trim_start_matches([' ', '\t'])
                .trim_end_matches([' ', '\t'])
                == "true"
        }
        None => false,
    }
}

/// Which markdown files directly inside `dir` are Marp slide decks — the
/// explorer badges those rows *marp* instead of *md*. Best-effort and
/// separate from `list_dir` on purpose: the listing must stay a pure
/// directory enumeration (see its cloud-placeholder note), so this runs after
/// it, reads only each candidate's first few KiB, and an unreadable file is
/// simply not a deck. Missing dir = empty list, like the other listings.
#[tauri::command]
pub async fn list_deck_files(dir: PathBuf) -> FsResult<Vec<String>> {
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    // No hidden-entry filter: this only badges rows `list_dir` already chose
    // to show, so a hidden deck is badged exactly when it is listed.
    let mut decks = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !has_extension(&path, "md") && !has_extension(&path, "markdown") {
            continue;
        }
        if !matches!(entry.file_type(), Ok(t) if t.is_file()) {
            continue;
        }
        let mut head = Vec::with_capacity(FRONTMATTER_HEAD_BYTES);
        let read = fs::File::open(&path)
            .and_then(|f| f.take(FRONTMATTER_HEAD_BYTES as u64).read_to_end(&mut head));
        if read.is_err() {
            continue;
        }
        if is_marp_head(&String::from_utf8_lossy(&head)) {
            decks.push(path.to_string_lossy().into_owned());
        }
    }
    Ok(decks)
}

/// List secondary-window session manifests (`session-<label>.json`) inside
/// `dir`. `list_dir` deliberately filters to md/images for the explorer, so
/// the multi-window boot path (respawning torn-off windows) needs its own
/// listing. Missing dir = empty list, like the other listings.
#[tauri::command]
pub async fn list_session_manifests(dir: PathBuf) -> FsResult<Vec<String>> {
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut manifests = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_file = matches!(entry.metadata(), Ok(m) if m.is_file());
        if name.starts_with("session-") && name.ends_with(".json") && is_file {
            manifests.push(entry.path().to_string_lossy().into_owned());
        }
    }
    manifests.sort();
    Ok(manifests)
}

/// List theme-plugin files (`*.json`) inside the themes folder. `list_dir`
/// filters to md/images for the explorer and would hide these (or leak them if
/// widened), so the pluggable-themes loader gets its own listing. Returns full
/// paths, sorted; a missing dir is an empty list, like the other listings.
#[tauri::command]
pub async fn list_theme_files(dir: PathBuf) -> FsResult<Vec<String>> {
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let is_file = matches!(entry.metadata(), Ok(m) if m.is_file());
        if !name.starts_with('.') && name.ends_with(".json") && is_file {
            files.push(entry.path().to_string_lossy().into_owned());
        }
    }
    files.sort();
    Ok(files)
}

/// Read a binary file as base64 (image tabs). The frontend builds a data URL;
/// this avoids widening the asset-protocol scope to arbitrary workspace dirs.
#[tauri::command]
pub async fn read_file_base64(path: PathBuf) -> FsResult<String> {
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| not_found_or_io(e, &path))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Rename/move a file or folder. Fails with EXISTS if the destination is taken
/// by a DIFFERENT entry — slug collision resolution is frontend logic
/// (src/core/session), so this command must never clobber. (There is an
/// inherent check-then-rename race; acceptable for a notes dir owned by this
/// app.)
///
/// Two cases the plain `exists → EXISTS` + `fs::rename` pair gets wrong:
///
/// - **Case-only rename** (`notes` → `Notes`). On Windows and macOS the
///   destination "exists" because it IS the source, so the guard above would
///   refuse a perfectly legal rename. `is_same_entry` tells the two apart, and
///   a same-entry rename is performed (with a two-step fallback through a
///   temporary sibling for filesystems that refuse the direct one).
/// - **Move across filesystems** (dragging a file into a workspace on another
///   drive, or onto a mounted/synced volume). `fs::rename` has no cross-device
///   primitive and fails with `EXDEV` / `ERROR_NOT_SAME_DEVICE`; for a file we
///   fall back to copy-then-remove. A DIRECTORY across devices would need a
///   recursive copy and is left to fail — nothing in the app moves folders
///   between workspaces.
#[tauri::command]
pub async fn rename_path(from: PathBuf, to: PathBuf) -> FsResult<()> {
    if !from.exists() {
        return Err(FsError::NotFound(from));
    }
    if to.exists() {
        if !is_same_entry(&from, &to) {
            return Err(FsError::Exists(to));
        }
        return rename_same_entry(&from, &to);
    }
    match fs::rename(&from, &to) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) && from.is_file() => {
            copy_file_atomic(&from, &to)?;
            // Only now is the move real. If the source can't be dropped, undo
            // the copy: a half-done move that silently duplicates the file
            // would be worse than the failure the caller already reports.
            if let Err(e) = fs::remove_file(&from) {
                let _ = fs::remove_file(&to);
                return Err(e.into());
            }
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

/// Do `from` and `to` name the same file/folder on disk? True for a case-only
/// difference on a case-insensitive filesystem — and for the `a/./b` style
/// spellings the frontend's mixed `/`+`\` joins can produce. Identity, not
/// string comparison: device+inode on Unix (macOS `realpath` does NOT correct
/// the case, so canonicalizing would miss exactly the case we care about),
/// canonical path on Windows — whose canonicalize resolves to the on-disk
/// spelling on NTFS, but NOT on every volume: Google Drive's virtual drive
/// (and other cloud/FUSE mounts presenting as FAT) echoes back whatever
/// spelling was asked for, so `notes.md` and `Notes.md` canonicalize to two
/// different strings for the one file. When the canonical paths disagree the
/// directory listing decides (`is_same_entry_by_listing`): it carries the true
/// on-disk names on every volume. Both follow symlinks, so a symlink AT `to`
/// pointing at `from` counts as the same entry — an acceptable edge for a
/// rename the user just asked for. When identity can't be established the
/// answer is `false`, and the caller keeps its no-clobber refusal.
fn is_same_entry(from: &Path, to: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(from), fs::metadata(to)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        if let (Ok(a), Ok(b)) = (fs::canonicalize(from), fs::canonicalize(to)) {
            if a == b {
                return true;
            }
        }
        is_same_entry_by_listing(from, to)
    }
}

/// The volume-agnostic same-entry test: `from` and `to` are siblings whose
/// names differ only in letter case, and their directory holds exactly ONE
/// entry under that name (compared case-folded). One entry means the two
/// spellings are aliases of it (a case-insensitive directory); two means the
/// filesystem keeps them apart (a case-sensitive directory), and the rename
/// really would clobber. Case folding is Unicode lowercase — the same fold
/// the frontend's `pathKey` applies when it decides a rename is case-only.
#[cfg(not(unix))]
fn is_same_entry_by_listing(from: &Path, to: &Path) -> bool {
    let fold = |s: &std::ffi::OsStr| s.to_string_lossy().to_lowercase();
    let (Some(from_name), Some(to_name)) = (from.file_name(), to.file_name()) else {
        return false;
    };
    let (Some(from_dir), Some(to_dir)) = (from.parent(), to.parent()) else {
        return false;
    };
    if fold(from_name) != fold(to_name) {
        return false;
    }
    let same_dir = match (fs::canonicalize(from_dir), fs::canonicalize(to_dir)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !same_dir {
        return false;
    }
    let Ok(entries) = fs::read_dir(from_dir) else {
        return false;
    };
    let wanted = fold(to_name);
    entries
        .flatten()
        .filter(|e| fold(&e.file_name()) == wanted)
        .count()
        == 1
}

/// Rename `from` onto a `to` that IS `from` — a case-only change on a
/// case-insensitive filesystem, or a no-op respelling. A direct `fs::rename`
/// handles this on Windows and macOS; when a filesystem refuses it, go through
/// a unique temporary sibling and restore the original name if the second leg
/// fails, so a failure never loses the file.
fn rename_same_entry(from: &Path, to: &Path) -> FsResult<()> {
    if from == to {
        return Ok(()); // literally the same spelling: nothing to do
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let via = temp_sibling_name(to)?;
    fs::rename(from, &via)?;
    match fs::rename(&via, to) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::rename(&via, from); // put it back under its old name
            Err(e.into())
        }
    }
}

/// A free scratch path beside `path` for the two-step case-only rename. Same
/// dot-prefixed `.tmp` shape as `temp_beside` (see its doc for why), but a bare
/// path — the entry being moved may be a directory, which `tempfile` can't
/// stand in for.
fn temp_sibling_name(path: &Path) -> FsResult<PathBuf> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            FsError::InvalidPath(format!("{} has no parent directory", path.display()))
        })?;
    let prefix = temp_prefix(path);
    for n in 0..1000 {
        let candidate = dir.join(format!("{prefix}rename{n}.tmp"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(FsError::InvalidPath(format!(
        "no free temporary name beside {}",
        path.display()
    )))
}

/// Did this rename fail because source and destination live on different
/// filesystems? `ErrorKind::CrossesDevices` is still unstable, so match the raw
/// OS codes: `EXDEV` (18) on Unix, `ERROR_NOT_SAME_DEVICE` (17) on Windows.
fn is_cross_device(e: &std::io::Error) -> bool {
    #[cfg(windows)]
    const CODE: i32 = 17;
    #[cfg(not(windows))]
    const CODE: i32 = 18;
    e.raw_os_error() == Some(CODE)
}

/// Delete a file, or a folder and everything inside it (explorer "Delete
/// folder"). Idempotent: deleting a missing target succeeds, because the
/// session flusher may retry a plan whose delete already happened.
#[tauri::command]
pub async fn delete_path(path: PathBuf) -> FsResult<()> {
    // A directory needs a recursive remove; a plain file uses remove_file. The
    // is_dir check races with concurrent deletion, but both arms treat NotFound
    // as success, so a lost race still resolves Ok.
    let result = if path.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Existence + mtime without reading content (conflict checks on focus).
#[tauri::command]
pub async fn stat_path(path: PathBuf) -> FsResult<PathStat> {
    match fs::metadata(&path) {
        Ok(meta) => Ok(PathStat {
            exists: true,
            mtime_ms: Some(mtime_ms(&meta)),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PathStat {
            exists: false,
            mtime_ms: None,
        }),
        Err(e) => Err(e.into()),
    }
}

// Android-only commands (external_files_dir, SAF workspaces, STT, …) live in
// `android.rs`; that module is cfg-gated at the `mod.rs` declaration.

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    /// The commands are `async` only to get off Tauri's event-loop thread;
    /// their bodies are plain blocking IO, so tests just block on them.
    fn block_on<T>(fut: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(fut)
    }

    #[test]
    fn atomic_write_creates_new_file() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        block_on(atomic_write_text(target.clone(), "hello".into())).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        // The Windows trap: rename over an existing file must succeed.
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        block_on(atomic_write_text(target.clone(), "first".into())).unwrap();
        block_on(atomic_write_text(target.clone(), "second".into())).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        block_on(atomic_write_text(target.clone(), "a".into())).unwrap();
        block_on(atomic_write_text(target.clone(), "b".into())).unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("note.md")]);
    }

    #[test]
    fn temp_file_is_dot_prefixed_and_named_after_its_target() {
        // Cloud sync clients (Drive streaming, OneDrive, Dropbox) see this name
        // before the rename; it must read as scratch, not as a new document.
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        let tmp = temp_beside(&target, dir.path()).unwrap();
        let name = tmp
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(
            name.starts_with(".note.md."),
            "unexpected temp name: {name}"
        );
        assert!(name.ends_with(".tmp"), "unexpected temp name: {name}");
    }

    #[test]
    fn temp_prefix_falls_back_for_a_nameless_path() {
        assert_eq!(temp_prefix(Path::new("/")), ".file.");
    }

    #[test]
    fn atomic_write_creates_parent_dirs() {
        let dir = tmpdir();
        let target = dir.path().join("nested").join("deep").join("note.md");
        block_on(atomic_write_text(target.clone(), "x".into())).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "x");
    }

    #[test]
    fn dir_has_relevant_files_true_for_direct_note() {
        let dir = tmpdir();
        fs::write(dir.path().join("note.md"), "x").unwrap();
        assert!(block_on(dir_has_relevant_files(
            dir.path().to_path_buf(),
            None,
            None
        )));
    }

    #[test]
    fn dir_has_relevant_files_finds_nested_files() {
        let dir = tmpdir();
        let deep = dir.path().join("a").join("b");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("report.pdf"), "x").unwrap();
        assert!(block_on(dir_has_relevant_files(
            dir.path().to_path_buf(),
            None,
            None
        )));
    }

    #[test]
    fn dir_has_relevant_files_counts_extensionless_files() {
        let dir = tmpdir();
        fs::write(dir.path().join("README"), "x").unwrap();
        assert!(block_on(dir_has_relevant_files(
            dir.path().to_path_buf(),
            None,
            None
        )));
    }

    #[test]
    fn dir_has_relevant_files_false_for_unsupported_only() {
        let dir = tmpdir();
        let sub = dir.path().join("bin");
        fs::create_dir_all(&sub).unwrap();
        fs::write(dir.path().join("data.zip"), "x").unwrap();
        fs::write(sub.join("app.exe"), "x").unwrap();
        assert!(!block_on(dir_has_relevant_files(
            dir.path().to_path_buf(),
            None,
            None
        )));
    }

    #[test]
    fn dir_has_relevant_files_all_files_counts_anything() {
        let dir = tmpdir();
        let sub = dir.path().join("src");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("main.ts"), "x").unwrap();
        fs::write(dir.path().join(".hidden.ts"), "x").unwrap();
        assert!(!block_on(dir_has_relevant_files(
            dir.path().to_path_buf(),
            None,
            None
        )));
        assert!(block_on(dir_has_relevant_files(
            dir.path().to_path_buf(),
            Some(true),
            None
        )));
    }

    #[test]
    fn list_dir_all_files_lists_every_non_hidden_file() {
        let dir = tmpdir();
        fs::write(dir.path().join("note.md"), "1").unwrap();
        fs::write(dir.path().join("app.ts"), "2").unwrap();
        fs::write(dir.path().join("Makefile"), "3").unwrap();
        fs::write(dir.path().join(".env"), "4").unwrap();
        let names = |all: Option<bool>| {
            let mut names: Vec<_> = block_on(list_dir(dir.path().to_path_buf(), all, None))
                .unwrap()
                .iter()
                .map(|e| {
                    Path::new(&e.path)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            names.sort();
            names
        };
        assert_eq!(names(None), vec!["note.md"]);
        assert_eq!(names(Some(true)), vec!["Makefile", "app.ts", "note.md"]);
    }

    #[test]
    fn read_text_file_rejects_binary_as_invalid_data() {
        let dir = tmpdir();
        let nul = dir.path().join("blob.bin");
        fs::write(&nul, b"MZ\0\0text").unwrap();
        let bad_utf8 = dir.path().join("latin1.txt");
        fs::write(&bad_utf8, [0x63, 0x61, 0x66, 0xE9]).unwrap();
        for path in [nul, bad_utf8] {
            let err = block_on(read_text_file(path)).unwrap_err();
            assert_eq!(err.code(), "INVALID_DATA");
        }
        let code = dir.path().join("app.ts");
        fs::write(&code, "const x = 1;\n").unwrap();
        assert_eq!(
            block_on(read_text_file(code)).unwrap().text,
            "const x = 1;\n"
        );
    }

    #[test]
    fn show_hidden_lists_and_counts_dot_entries() {
        let dir = tmpdir();
        fs::create_dir(dir.path().join(".config")).unwrap();
        fs::write(dir.path().join(".config").join("notes.md"), "x").unwrap();
        fs::write(dir.path().join(".draft.md"), "x").unwrap();
        fs::write(dir.path().join("note.md"), "x").unwrap();
        let names = |show: Option<bool>| {
            let mut names: Vec<_> = block_on(list_dir(dir.path().to_path_buf(), None, show))
                .unwrap()
                .iter()
                .map(|e| {
                    Path::new(&e.path)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            names.sort();
            names
        };
        assert_eq!(names(None), vec!["note.md"]);
        assert_eq!(names(Some(true)), vec![".config", ".draft.md", "note.md"]);
        let config = dir.path().join(".config");
        assert!(block_on(dir_has_relevant_files(
            config.clone(),
            None,
            Some(true)
        )));
        // A visible folder whose only note sits in a hidden subfolder.
        let outer = dir.path().join("outer");
        fs::create_dir_all(outer.join(".inner")).unwrap();
        fs::write(outer.join(".inner").join("a.md"), "x").unwrap();
        assert!(!block_on(dir_has_relevant_files(outer.clone(), None, None)));
        assert!(block_on(dir_has_relevant_files(outer, None, Some(true))));
    }

    /// Windows' own convention: the hidden attribute hides a name with no dot.
    #[cfg(windows)]
    #[test]
    fn windows_hidden_attribute_hides_entries() {
        let dir = tmpdir();
        let secret = dir.path().join("secret.md");
        fs::write(&secret, "x").unwrap();
        fs::write(dir.path().join("note.md"), "x").unwrap();
        let status = std::process::Command::new("attrib")
            .arg("+h")
            .arg(&secret)
            .status()
            .unwrap();
        assert!(status.success());
        let count = |show: Option<bool>| {
            block_on(list_dir(dir.path().to_path_buf(), None, show))
                .unwrap()
                .len()
        };
        assert_eq!(count(None), 1);
        assert_eq!(count(Some(true)), 2);
    }

    #[test]
    fn dir_has_relevant_files_ignores_hidden_entries() {
        let dir = tmpdir();
        let hidden = dir.path().join(".git");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join("config.md"), "x").unwrap();
        fs::write(dir.path().join(".secret.md"), "x").unwrap();
        assert!(!block_on(dir_has_relevant_files(
            dir.path().to_path_buf(),
            None,
            None
        )));
    }

    #[test]
    fn dir_has_relevant_files_false_for_missing_or_empty_dir() {
        let dir = tmpdir();
        assert!(!block_on(dir_has_relevant_files(
            dir.path().to_path_buf(),
            None,
            None
        )));
        assert!(!block_on(dir_has_relevant_files(
            dir.path().join("nope"),
            None,
            None
        )));
    }

    #[test]
    fn read_text_file_returns_text_and_mtime() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        fs::write(&target, "content").unwrap();
        let out = block_on(read_text_file(target)).unwrap();
        assert_eq!(out.text, "content");
        assert!(out.mtime_ms > 0);
    }

    #[test]
    fn read_text_file_missing_is_not_found() {
        let dir = tmpdir();
        let err = block_on(read_text_file(dir.path().join("nope.md"))).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn list_notes_filters_non_md_and_sorts_newest_first() {
        let dir = tmpdir();
        fs::write(dir.path().join("older.md"), "1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(dir.path().join("newer.md"), "2").unwrap();
        fs::write(dir.path().join("ignored.txt"), "3").unwrap();
        fs::create_dir(dir.path().join("subdir.md")).unwrap(); // dir with .md name

        let notes = block_on(list_notes(dir.path().to_path_buf())).unwrap();
        let names: Vec<_> = notes
            .iter()
            .map(|n| Path::new(&n.path).file_name().unwrap().to_os_string())
            .collect();
        assert_eq!(
            names,
            vec![
                std::ffi::OsString::from("newer.md"),
                std::ffi::OsString::from("older.md")
            ]
        );
    }

    #[test]
    fn list_notes_missing_dir_is_empty() {
        let dir = tmpdir();
        let notes = block_on(list_notes(dir.path().join("does-not-exist"))).unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn write_file_base64_round_trips_bytes() {
        let dir = tmpdir();
        let target = dir.path().join("img.png");
        block_on(write_file_base64(target.clone(), "iVBORw==".into())).unwrap();
        assert_eq!(fs::read(&target).unwrap(), vec![0x89u8, 0x50, 0x4e, 0x47]);
    }

    #[test]
    fn write_file_base64_rejects_bad_data() {
        let dir = tmpdir();
        let err = block_on(write_file_base64(
            dir.path().join("img.png"),
            "!!!not base64!!!".into(),
        ))
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_DATA");
    }

    #[test]
    fn create_dir_creates_and_refuses_to_clobber() {
        let dir = tmpdir();
        let target = dir.path().join("sub");
        block_on(create_dir(target.clone())).unwrap();
        assert!(target.is_dir());
        let err = block_on(create_dir(target)).unwrap_err();
        assert_eq!(err.code(), "EXISTS");
    }

    #[test]
    fn copy_path_copies_and_keeps_source() {
        let dir = tmpdir();
        let a = dir.path().join("a.md");
        let b = dir.path().join("sub").join("b.md");
        fs::write(&a, "hello").unwrap();
        block_on(copy_path(a.clone(), b.clone())).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "hello");
        assert_eq!(fs::read_to_string(&b).unwrap(), "hello");
    }

    #[test]
    fn copy_path_refuses_to_clobber() {
        let dir = tmpdir();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let err = block_on(copy_path(a, b.clone())).unwrap_err();
        assert_eq!(err.code(), "EXISTS");
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");
    }

    #[test]
    fn copy_path_copies_a_whole_directory_tree() {
        let dir = tmpdir();
        let src = dir.path().join("notes");
        fs::create_dir_all(src.join("deep").join("deeper")).unwrap();
        fs::write(src.join("a.md"), "a").unwrap();
        fs::write(src.join("deep").join("b.md"), "b").unwrap();
        fs::write(src.join("deep").join("deeper").join("c.md"), "c").unwrap();
        let dst = dir.path().join("elsewhere").join("notes copy");
        block_on(copy_path(src.clone(), dst.clone())).unwrap();
        assert_eq!(fs::read_to_string(dst.join("a.md")).unwrap(), "a");
        assert_eq!(
            fs::read_to_string(dst.join("deep").join("b.md")).unwrap(),
            "b"
        );
        assert_eq!(
            fs::read_to_string(dst.join("deep").join("deeper").join("c.md")).unwrap(),
            "c"
        );
        // The source survives a copy.
        assert!(src.join("a.md").exists());
    }

    #[test]
    fn copy_path_refuses_a_directory_into_itself() {
        let dir = tmpdir();
        let src = dir.path().join("notes");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("a.md"), "a").unwrap();
        let err = block_on(copy_path(src.clone(), src.join("inner"))).unwrap_err();
        assert_eq!(err.code(), "INVALID_PATH");
        assert!(!src.join("inner").exists());
    }

    #[test]
    fn list_dir_returns_dirs_then_md_images_and_importable_docs() {
        let dir = tmpdir();
        fs::create_dir(dir.path().join("zeta")).unwrap();
        fs::create_dir(dir.path().join("Alpha")).unwrap();
        fs::create_dir(dir.path().join(".hidden")).unwrap();
        fs::write(dir.path().join("note.md"), "1").unwrap();
        fs::write(dir.path().join("photo.PNG"), "2").unwrap();
        fs::write(dir.path().join("plain.txt"), "3").unwrap();
        fs::write(dir.path().join("ignored.exe"), "3").unwrap();
        fs::write(dir.path().join(".dotfile.md"), "4").unwrap();
        // Importable documents (any case) are listed so the user can import them.
        fs::write(dir.path().join("report.pdf"), "5").unwrap();
        fs::write(dir.path().join("Memo.DOCX"), "6").unwrap();
        // Audio plays in the audio tab.
        fs::write(dir.path().join("memo.M4A"), "7").unwrap();

        let entries = block_on(list_dir(dir.path().to_path_buf(), None, None)).unwrap();
        let names: Vec<_> = entries
            .iter()
            .map(|e| {
                Path::new(&e.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(entries[0].is_dir);
        assert!(entries[1].is_dir);
        assert_eq!(&names[..2], &["Alpha", "zeta"]);
        // Files follow the dirs, themselves A→Z (case-insensitive) rather than
        // newest first — see the `list_dir` doc comment.
        let file_names = names[2..].to_vec();
        assert_eq!(
            file_names,
            vec![
                "Memo.DOCX",
                "memo.M4A",
                "note.md",
                "photo.PNG",
                "plain.txt",
                "report.pdf"
            ]
        );
    }

    #[test]
    fn list_dir_missing_dir_is_empty() {
        let dir = tmpdir();
        assert!(block_on(list_dir(dir.path().join("nope"), None, None))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn is_marp_head_mirrors_is_marp_document() {
        assert!(is_marp_head("---\nmarp: true\n---\n# Slide"));
        assert!(is_marp_head(
            "---\r\ntheme: gaia\r\nmarp:\ttrue \r\n---\r\n"
        ));
        assert!(is_marp_head("---\nmarp : true\n...\n"));
        // Not the first line, closed before it, false, or a longer key.
        assert!(!is_marp_head("# Title\n---\nmarp: true\n---\n"));
        assert!(!is_marp_head("---\ntitle: x\n---\nmarp: true\n"));
        assert!(!is_marp_head("---\nmarp: false\n---\n"));
        assert!(!is_marp_head("---\nmarpit: true\n---\n"));
        assert!(!is_marp_head(" ---\nmarp: true\n---\n"));
        assert!(!is_marp_head(""));
    }

    #[test]
    fn list_deck_files_returns_only_marp_markdown() {
        let dir = tmpdir();
        let p = dir.path();
        fs::write(p.join("deck.md"), "---\nmarp: true\n---\n# One\n").unwrap();
        fs::write(p.join("DECK2.Markdown"), "---\r\nmarp: true\r\n---\r\n").unwrap();
        fs::write(p.join("note.md"), "# Just a note\n").unwrap();
        fs::write(p.join("plain.txt"), "---\nmarp: true\n---\n").unwrap();
        fs::write(p.join(".hidden.md"), "---\nmarp: true\n---\n").unwrap();
        fs::create_dir(p.join("folder.md")).unwrap();
        let mut names: Vec<_> = block_on(list_deck_files(p.to_path_buf()))
            .unwrap()
            .into_iter()
            .map(|path| {
                Path::new(&path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert_eq!(names, [".hidden.md", "DECK2.Markdown", "deck.md"]);
        assert!(block_on(list_deck_files(p.join("nope")))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn list_session_manifests_matches_only_session_json() {
        let dir = tmpdir();
        fs::write(dir.path().join("session-w-abc123.json"), "{}").unwrap();
        fs::write(dir.path().join("session.json"), "{}").unwrap(); // main's — no "session-" prefix
        fs::write(dir.path().join("note.md"), "x").unwrap();
        fs::write(dir.path().join("session-old.txt"), "x").unwrap();
        fs::create_dir(dir.path().join("session-dir.json")).unwrap();

        let found = block_on(list_session_manifests(dir.path().to_path_buf())).unwrap();
        let names: Vec<_> = found
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, vec!["session-w-abc123.json"]);
    }

    #[test]
    fn list_session_manifests_missing_dir_is_empty() {
        let dir = tmpdir();
        assert!(block_on(list_session_manifests(dir.path().join("nope")))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn read_file_base64_round_trips() {
        let dir = tmpdir();
        let target = dir.path().join("img.png");
        fs::write(&target, [0x89u8, 0x50, 0x4e, 0x47]).unwrap();
        assert_eq!(block_on(read_file_base64(target)).unwrap(), "iVBORw==");
    }

    #[test]
    fn read_file_base64_missing_is_not_found() {
        let dir = tmpdir();
        let err = block_on(read_file_base64(dir.path().join("nope.png"))).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn rename_refuses_to_clobber() {
        let dir = tmpdir();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let err = block_on(rename_path(a.clone(), b.clone())).unwrap_err();
        assert_eq!(err.code(), "EXISTS");
        // Neither file was touched.
        assert_eq!(fs::read_to_string(&a).unwrap(), "a");
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");
    }

    #[test]
    fn rename_moves_file() {
        let dir = tmpdir();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "a").unwrap();
        block_on(rename_path(a.clone(), b.clone())).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read_to_string(&b).unwrap(), "a");
    }

    /// Names directly inside `dir`, for asserting the on-disk SPELLING of an
    /// entry (which `Path::exists` can't see on a case-insensitive filesystem).
    fn entry_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Does this filesystem fold `a` and `A` together? Windows and macOS do,
    /// Linux CI does not. The rename must work either way; the probe only
    /// decides what may be asserted about the OLD spelling afterwards.
    fn case_insensitive(dir: &Path) -> bool {
        let probe = dir.join("case-probe");
        fs::write(&probe, "x").unwrap();
        let folded = dir.join("CASE-PROBE").exists();
        fs::remove_file(&probe).unwrap();
        folded
    }

    #[test]
    fn rename_changes_only_letter_case() {
        let dir = tmpdir();
        let folded = case_insensitive(dir.path());
        let lower = dir.path().join("notes.md");
        let upper = dir.path().join("Notes.md");
        fs::write(&lower, "body").unwrap();

        // On a case-insensitive FS `upper` already "exists" here — it IS
        // `lower` — which is exactly what used to be refused as EXISTS.
        block_on(rename_path(lower.clone(), upper.clone())).unwrap();

        assert_eq!(fs::read_to_string(&upper).unwrap(), "body");
        let names = entry_names(dir.path());
        assert_eq!(names, vec!["Notes.md".to_string()], "{names:?}");
        if !folded {
            assert!(!lower.exists());
        }
    }

    #[test]
    fn rename_changes_only_letter_case_of_a_folder() {
        let dir = tmpdir();
        let folded = case_insensitive(dir.path());
        let lower = dir.path().join("notes");
        let upper = dir.path().join("Notes");
        fs::create_dir(&lower).unwrap();
        fs::write(lower.join("inside.md"), "kept").unwrap();

        block_on(rename_path(lower.clone(), upper.clone())).unwrap();

        // The contents came along, and no scratch sibling from the two-step
        // fallback was left behind.
        assert_eq!(fs::read_to_string(upper.join("inside.md")).unwrap(), "kept");
        let names = entry_names(dir.path());
        assert_eq!(names, vec!["Notes".to_string()], "{names:?}");
        if !folded {
            assert!(!lower.exists());
        }
    }

    #[test]
    fn rename_to_the_very_same_path_is_a_no_op() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        fs::write(&target, "kept").unwrap();
        block_on(rename_path(target.clone(), target.clone())).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "kept");
    }

    #[test]
    fn rename_still_refuses_a_different_existing_file_that_differs_only_in_case() {
        // Only meaningful where `notes.md` and `Notes.md` can coexist; on a
        // case-insensitive FS the second write would just overwrite the first.
        let dir = tmpdir();
        if case_insensitive(dir.path()) {
            return;
        }
        let a = dir.path().join("notes.md");
        let b = dir.path().join("Notes.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let err = block_on(rename_path(a.clone(), b.clone())).unwrap_err();
        assert_eq!(err.code(), "EXISTS");
        assert_eq!(fs::read_to_string(&a).unwrap(), "a");
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");
    }

    /// The listing-based identity test that stands in for `canonicalize` on
    /// volumes which echo the queried spelling back (Google Drive's mount).
    #[cfg(not(unix))]
    #[test]
    fn same_entry_by_listing_recognizes_a_case_only_alias() {
        let dir = tmpdir();
        let lower = dir.path().join("notes.md");
        let upper = dir.path().join("Notes.md");
        let other = dir.path().join("other.md");
        fs::write(&lower, "a").unwrap();
        fs::write(&other, "b").unwrap();

        if case_insensitive(dir.path()) {
            // One entry answers to both spellings: an alias, not a clobber.
            assert!(is_same_entry_by_listing(&lower, &upper));
            assert!(is_same_entry_by_listing(&upper, &lower));
        } else {
            // Two distinct entries under the folded name: a real collision.
            fs::write(&upper, "c").unwrap();
            assert!(!is_same_entry_by_listing(&lower, &upper));
        }
        // Different names are never the same entry, whatever the case rules.
        assert!(!is_same_entry_by_listing(&lower, &other));
        // Nor is the same name in a different directory.
        let elsewhere = tmpdir();
        fs::write(elsewhere.path().join("Notes.md"), "d").unwrap();
        assert!(!is_same_entry_by_listing(
            &lower,
            &elsewhere.path().join("Notes.md")
        ));
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        fs::write(&target, "x").unwrap();
        block_on(delete_path(target.clone())).unwrap();
        assert!(!target.exists());
        block_on(delete_path(target)).unwrap(); // second delete: still Ok
    }

    #[test]
    fn delete_removes_folder_and_contents() {
        let dir = tmpdir();
        let folder = dir.path().join("sub");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("nested.md"), "x").unwrap();
        block_on(delete_path(folder.clone())).unwrap();
        assert!(!folder.exists());
        block_on(delete_path(folder)).unwrap(); // idempotent for folders too
    }

    #[test]
    fn stat_path_reports_existence() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        assert!(!block_on(stat_path(target.clone())).unwrap().exists);
        fs::write(&target, "x").unwrap();
        let stat = block_on(stat_path(target)).unwrap();
        assert!(stat.exists);
        assert!(stat.mtime_ms.unwrap() > 0);
    }

    #[test]
    fn error_serializes_as_code_and_message() {
        let err = FsError::NotFound(PathBuf::from("x.md"));
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "NOT_FOUND");
        assert!(json["message"].as_str().unwrap().contains("x.md"));
    }
}
