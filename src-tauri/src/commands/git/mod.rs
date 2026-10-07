//! Git, by shelling out to the `git` binary — desktop only.
//!
//! Two consumers share this module. Review mode's "What changed" asks three
//! questions: where am I (`git_repo_info`), what did this file look like at a
//! revision (`git_show_file`), and does this file differ on the other
//! worktrees' branches (`git_file_changes`). The git tab drives the repository:
//! status, branches, log, staging, commits, merges, worktrees and the three
//! network operations — each a named command in a child module (`status`,
//! `refs`, `worktrees`, `ops`, `net`, `remotes`) that builds its own argv over the one
//! runner in `run`. No `git2`/libgit2: this feature only runs where a
//! developer already has git installed, and a large native build is a poor
//! trade for a process spawn.
//!
//! Policy stays in TypeScript (rule I5): which revision is "the baseline",
//! when to refresh, what a badge means, and which button a merge outcome
//! enables are `src/core/code/changes.ts`, `src/core/git/*` and the stores'
//! concerns. This module only reports and executes explicit argv — there is
//! deliberately no "run these args" command.
//!
//! Every command runs on the blocking pool (spawning a process and waiting for
//! it is blocking work) under a hard timeout chosen by its mode (`run::GitMode`:
//! 3 s read, 30 s mutate, 120 s network) — a git call that hangs on a network
//! mount must never freeze the pane, which renders first and takes facts when
//! they arrive. Android compiles none of this: the module is
//! `#[cfg(not(target_os = "android"))]` in `commands/mod.rs` and the handler
//! entries are `#[cfg(desktop)]`, so the features simply hide there.

pub mod net;
pub mod ops;
pub mod refs;
pub mod remotes;
pub mod run;
pub mod status;
#[cfg(test)]
pub(crate) mod testutil;
pub mod worktrees;

pub use net::{git_fetch, git_op_cancel, git_pull, git_push};
pub use ops::{
    git_commit, git_create_branch, git_delete_branch, git_discard, git_merge, git_merge_abort,
    git_stage, git_switch, git_unstage,
};
pub use refs::{git_ahead_behind, git_branches, git_commit_files, git_diff_names, git_log};
pub use remotes::{
    git_compare_ref, git_remote_add, git_remote_remove, git_remote_set_url, git_remotes,
};
pub use status::git_status;
pub use worktrees::{git_check_ignore, git_worktree_add, git_worktree_remove, git_worktrees};
// `generate_handler!` reaches each command's two `#[macro_export]`ed helper
// macros through this module's path (`commands::git::__cmd__<name>!`), so
// the fn re-exports above need these beside them (relative paths: an
// absolute `crate::` path to a macro-expanded export is a future-incompat
// lint).
#[doc(hidden)]
pub use {
    net::__cmd__git_fetch, net::__cmd__git_op_cancel, net::__cmd__git_pull, net::__cmd__git_push,
    net::__tauri_command_name_git_fetch, net::__tauri_command_name_git_op_cancel,
    net::__tauri_command_name_git_pull, net::__tauri_command_name_git_push, ops::__cmd__git_commit,
    ops::__cmd__git_create_branch, ops::__cmd__git_delete_branch, ops::__cmd__git_discard,
    ops::__cmd__git_merge, ops::__cmd__git_merge_abort, ops::__cmd__git_stage,
    ops::__cmd__git_switch, ops::__cmd__git_unstage, ops::__tauri_command_name_git_commit,
    ops::__tauri_command_name_git_create_branch, ops::__tauri_command_name_git_delete_branch,
    ops::__tauri_command_name_git_discard, ops::__tauri_command_name_git_merge,
    ops::__tauri_command_name_git_merge_abort, ops::__tauri_command_name_git_stage,
    ops::__tauri_command_name_git_switch, ops::__tauri_command_name_git_unstage,
    refs::__cmd__git_ahead_behind, refs::__cmd__git_branches, refs::__cmd__git_commit_files,
    refs::__cmd__git_diff_names, refs::__cmd__git_log, refs::__tauri_command_name_git_ahead_behind,
    refs::__tauri_command_name_git_branches, refs::__tauri_command_name_git_commit_files,
    refs::__tauri_command_name_git_diff_names, refs::__tauri_command_name_git_log,
    remotes::__cmd__git_compare_ref, remotes::__cmd__git_remote_add,
    remotes::__cmd__git_remote_remove, remotes::__cmd__git_remote_set_url,
    remotes::__cmd__git_remotes, remotes::__tauri_command_name_git_compare_ref,
    remotes::__tauri_command_name_git_remote_add, remotes::__tauri_command_name_git_remote_remove,
    remotes::__tauri_command_name_git_remote_set_url, remotes::__tauri_command_name_git_remotes,
    status::__cmd__git_status, status::__tauri_command_name_git_status,
    worktrees::__cmd__git_check_ignore, worktrees::__cmd__git_worktree_add,
    worktrees::__cmd__git_worktree_remove, worktrees::__cmd__git_worktrees,
    worktrees::__tauri_command_name_git_check_ignore,
    worktrees::__tauri_command_name_git_worktree_add,
    worktrees::__tauri_command_name_git_worktree_remove,
    worktrees::__tauri_command_name_git_worktrees,
};

use run::{run_git_with, GitMode, GitOutput};
use serde::Serialize;
use std::path::Path;

/// Branches tried, in order, when the caller names no baseline branch. Matches
/// this repo's own convention (`development` is where work lands) and then the
/// two common defaults.
const BASE_BRANCH_CANDIDATES: [&str; 3] = ["development", "main", "master"];

/// Mirrors the `{code, message}` wire shape of `FsError` (see
/// src-tauri/README.md's error table). `Failed` carries git's own stderr,
/// which is for logs and a status line — never for branching.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git was not found on PATH")]
    NoGit,
    #[error("not a git repository: {0}")]
    NotARepo(String),
    /// git's `safe.directory` check refused the repository: it is owned by
    /// another account (a folder an elevated process made, a FAT/exFAT or
    /// network drive). The payload is the path git named. `git_trust_directory`
    /// is the fix, and only on the user's say-so.
    #[error("git does not trust this repository (owned by another user): {0}")]
    Untrusted(String),
    /// Killed at its mode's limit; the payload is that limit in seconds.
    #[error("git timed out after {0}s")]
    Timeout(u64),
    #[error("git failed: {stderr}")]
    Failed { stderr: String },
    /// `git_op_cancel` landed on a running fetch / pull / push.
    #[error("git operation cancelled")]
    Cancelled,
    /// A network operation is already running for that repository.
    #[error("a git network operation is already running for this repository")]
    Busy,
    /// A caller bug: a user string the runner refuses to hand to git.
    #[error("invalid argument: {0}")]
    InvalidArg(String),
}

impl GitError {
    pub fn code(&self) -> &'static str {
        match self {
            GitError::NoGit => "GIT_NOT_FOUND",
            GitError::NotARepo(_) => "GIT_NOT_A_REPO",
            GitError::Untrusted(_) => "GIT_UNTRUSTED",
            GitError::Timeout(_) => "GIT_TIMEOUT",
            GitError::Failed { .. } => "GIT_FAILED",
            GitError::Cancelled => "GIT_CANCELLED",
            GitError::Busy => "GIT_BUSY",
            GitError::InvalidArg(_) => "GIT_INVALID_ARG",
        }
    }

    pub(crate) fn failed(stderr: impl Into<String>) -> Self {
        GitError::Failed {
            stderr: stderr.into(),
        }
    }
}

impl Serialize for GitError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("GitError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type GitResult<T> = Result<T, GitError>;

/// One entry of `git worktree list --porcelain`. `branch` is the short name
/// (`feat/x`), `None` for a detached HEAD. `locked` / `prunable` mirror the
/// porcelain's optional lines (a lock reason is not reported).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub locked: bool,
    pub prunable: bool,
}

/// Everything the review pane needs to describe "where am I" for one file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    /// Absolute repository root, forward slashes (git's own spelling).
    pub root: String,
    /// The repository's MAIN checkout (the first `worktree list` record) —
    /// equals `root` unless `root` is a linked worktree. The git tab's
    /// identity: one tab per `main_root`.
    pub main_root: String,
    /// The asked-about path relative to `root`, forward slashes, no leading `/`.
    pub rel: String,
    /// Short branch name, or `None` on a detached HEAD.
    pub branch: Option<String>,
    /// HEAD's commit sha; empty string in a repo with no commits yet.
    pub head: String,
    /// True when `root` is a linked worktree rather than the main checkout.
    pub is_worktree: bool,
    /// The baseline branch that exists locally, or `None` when none does.
    pub base_branch: Option<String>,
    /// `merge-base(HEAD, base_branch)`; `None` when HEAD *is* the base branch
    /// (compare against HEAD instead) or no merge base is computable.
    pub base_ref: Option<String>,
    /// Every checkout of this repository, the main one included.
    pub worktrees: Vec<GitWorktree>,
}

/// Whether one branch's blob for a path differs from the baseline's — the
/// "also changed on: feat/other" radar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub branch: String,
    pub differs: bool,
}

/* ------------------------------- running git ------------------------------ */

/// Read-mode `git [-C root] <args>`: `--no-optional-locks`, 3 s. A non-zero
/// exit is NOT an error here — `rev-parse --verify` and `show` use it to mean
/// "no", so the caller decides. See `run` for the modes.
fn run_git(root: Option<&Path>, args: &[&str]) -> GitResult<GitOutput> {
    run_git_with(root, GitMode::Read, args)
}

/// `run_git` for the common "one line of output, failure is an error" case.
fn git_line(root: &Path, args: &[&str]) -> GitResult<String> {
    let out = run_git(Some(root), args)?;
    if !out.ok {
        return Err(classify(&out.stderr, root));
    }
    Ok(out.stdout.trim().to_string())
}

/// The same, but a non-zero exit means "no such thing" rather than an error —
/// what `rev-parse --verify --quiet` and `symbolic-ref --quiet` are for.
fn git_line_opt(root: &Path, args: &[&str]) -> GitResult<Option<String>> {
    let out = run_git(Some(root), args)?;
    if !out.ok {
        // A repo-level failure is still a failure; only a plain "no" is None.
        if is_not_a_repo(&out.stderr) || dubious_path(&out.stderr).is_some() {
            return Err(classify(&out.stderr, root));
        }
        return Ok(None);
    }
    let line = out.stdout.trim().to_string();
    Ok((!line.is_empty()).then_some(line))
}

fn is_not_a_repo(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("not a git repository") || lower.contains("not a working tree")
}

/// The path git names when its `safe.directory` check refuses a repository,
/// or `None` when `stderr` says something else. git (2.35.2+) writes
///
/// ```text
/// fatal: detected dubious ownership in repository at 'C:/x'
/// …
///     git config --global --add safe.directory C:/x
/// ```
///
/// The suggested command's argument is preferred — it is exactly what git
/// wants added (a UNC share comes back as `%(prefix)///server/share` there);
/// the quoted path in the first line is the fallback.
fn dubious_path(stderr: &str) -> Option<String> {
    if !stderr.contains("detected dubious ownership") {
        return None;
    }
    let unquote = |s: &str| {
        let s = s.trim();
        s.strip_prefix('\'')
            .and_then(|s| s.strip_suffix('\''))
            .unwrap_or(s)
            .to_string()
    };
    let suggested = stderr
        .lines()
        .find_map(|l| {
            l.trim()
                .strip_prefix("git config --global --add safe.directory ")
        })
        .map(unquote);
    let named = || {
        let rest = stderr.split("dubious ownership in repository at ").nth(1)?;
        Some(unquote(rest.lines().next()?))
    };
    suggested.or_else(named).filter(|p| !p.is_empty())
}

fn classify(stderr: &str, path: &Path) -> GitError {
    if let Some(owned) = dubious_path(stderr) {
        GitError::Untrusted(owned)
    } else if is_not_a_repo(stderr) {
        GitError::NotARepo(display(path))
    } else {
        GitError::failed(stderr)
    }
}

fn display(path: &Path) -> String {
    to_slashes(&path.to_string_lossy())
}

/// HEAD's sha, or `None` on an unborn branch (a repo with no commits yet).
fn head_sha(root: &Path) -> GitResult<Option<String>> {
    git_line_opt(root, &["rev-parse", "--verify", "--quiet", "HEAD"])
}

/// Run a closure on the blocking pool and flatten the join error into
/// `GitError` — every command's body.
async fn blocking<T, F>(f: F) -> GitResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> GitResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| GitError::failed(e.to_string()))?
}

/* ----------------------------- pure path logic ---------------------------- */

/// Windows separators → forward slashes, and any trailing slash dropped (a
/// drive root like `C:/` keeps its slash so it stays a valid path).
fn to_slashes(path: &str) -> String {
    let s = path.replace('\\', "/");
    match s.strip_suffix('/') {
        Some(trimmed) if !trimmed.is_empty() && !trimmed.ends_with(':') => trimmed.to_string(),
        _ => s,
    }
}

/// Comparison key for two paths naming the same place: forward slashes, and on
/// Windows (and macOS, whose default filesystem is also case-insensitive)
/// ASCII-folded case. ASCII-only folding on purpose — it preserves length, so
/// byte offsets taken on the key are valid in the normalized path.
fn path_key(path: &str) -> String {
    let slashed = to_slashes(path);
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        slashed.to_ascii_lowercase()
    } else {
        slashed
    }
}

/// `path` expressed relative to `root`, forward slashes, no leading slash.
/// `Some("")` when they name the same place, `None` when `path` is not under
/// `root` (a symlinked ancestor, say — the caller then asks git itself).
fn relative_path(root: &str, path: &str) -> Option<String> {
    let root_key = path_key(root);
    let target = path_key(path);
    if root_key == target {
        return Some(String::new());
    }
    let root_prefix = if root_key.ends_with('/') {
        root_key.clone()
    } else {
        format!("{root_key}/")
    };
    if !target.starts_with(&root_prefix) {
        return None;
    }
    let normalized = to_slashes(path);
    Some(normalized[root_prefix.len()..].to_string())
}

/// Parse `git worktree list --porcelain`. Records are separated by blank
/// lines; each opens with `worktree <path>` and carries `HEAD <sha>` plus
/// either `branch refs/heads/<name>` or `detached`, and optionally `locked`
/// / `prunable` (each with an optional reason). Bare records (no HEAD) are
/// dropped — there is no blob to compare against in one.
fn parse_worktrees(out: &str) -> Vec<GitWorktree> {
    #[derive(Default)]
    struct Partial {
        path: Option<String>,
        head: Option<String>,
        branch: Option<String>,
        locked: bool,
        prunable: bool,
    }
    let mut found = Vec::new();
    let mut cur = Partial::default();
    // A record is only reported once it has both a path and a HEAD; a bare or
    // malformed one is dropped, fields and all.
    let mut flush = |cur: &mut Partial| {
        let done = std::mem::take(cur);
        if let (Some(p), Some(h)) = (done.path, done.head) {
            found.push(GitWorktree {
                path: to_slashes(&p),
                branch: done.branch,
                head: h,
                locked: done.locked,
                prunable: done.prunable,
            });
        }
    };
    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut cur);
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut cur);
            cur.path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            cur.head = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            cur.branch = Some(short_branch(rest));
        } else if line == "detached" {
            cur.branch = None;
        } else if line == "locked" || line.starts_with("locked ") {
            cur.locked = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            cur.prunable = true;
        }
        // `bare` carries nothing we report.
    }
    flush(&mut cur);
    found
}

fn short_branch(refname: &str) -> String {
    refname
        .strip_prefix("refs/heads/")
        .unwrap_or(refname)
        .to_string()
}

/// The main checkout's path: the first record of `worktree list`, which git
/// always prints first. Falls back to `root` for a list with no usable record.
fn main_root_of(worktrees: &[GitWorktree], root: &str) -> String {
    worktrees
        .first()
        .map(|w| w.path.clone())
        .unwrap_or_else(|| root.to_string())
}

/* -------------------------------- the work -------------------------------- */

/// The directory to run git in: `path` itself if it is a directory, else its
/// parent (git needs a directory for `-C`, and the review pane asks about a
/// file).
fn work_dir(path: &Path) -> &Path {
    if path.is_dir() {
        return path;
    }
    path.parent().unwrap_or(path)
}

fn repo_info(path: &str, base_branch: Option<&str>) -> GitResult<GitRepoInfo> {
    let raw = Path::new(path);
    let dir = work_dir(raw);
    let root = to_slashes(&git_line(dir, &["rev-parse", "--show-toplevel"])?);
    if root.is_empty() {
        return Err(GitError::NotARepo(display(raw)));
    }

    // Prefer the pure computation; fall back to git's own answer when the
    // path reaches the root through a symlink (`--show-prefix` is the dir's
    // path under the root, so the file name is appended back on).
    let rel = match relative_path(&root, path) {
        Some(rel) => rel,
        None => {
            let prefix = git_line(dir, &["rev-parse", "--show-prefix"])?;
            let name = if raw.is_dir() {
                String::new()
            } else {
                raw.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            };
            format!("{prefix}{name}")
        }
    };

    let branch = git_line_opt(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    // An unborn HEAD (a repo with no commits) is not an error — the pane just
    // has nothing to compare against.
    let head = head_sha(dir)?.unwrap_or_default();

    // `--git-dir` is THIS checkout's git dir, `--git-common-dir` the main
    // one's. They are the same directory in the main checkout and differ in a
    // linked worktree (`<main>/.git/worktrees/<name>` vs `<main>/.git`) — a
    // comparison that needs no path arithmetic and works on every git version.
    let git_dir = git_line(dir, &["rev-parse", "--git-dir"])?;
    let common_dir = git_line(dir, &["rev-parse", "--git-common-dir"])?;
    let is_worktree = path_key(&git_dir) != path_key(&common_dir);

    let root_path = Path::new(&root);
    let base_branch = resolve_base_branch(root_path, base_branch)?;
    let base_ref = match (&base_branch, &branch) {
        // HEAD already IS the baseline: there is no merge-base to compare
        // against, so the caller falls back to HEAD (uncommitted changes).
        (Some(base), Some(current)) if base == current => None,
        (Some(base), _) if !head.is_empty() => git_line_opt(
            root_path,
            &["merge-base", "HEAD", &format!("refs/heads/{base}")],
        )?,
        _ => None,
    };

    let worktrees = list_worktrees(root_path)?;
    let main_root = main_root_of(&worktrees, &root);

    Ok(GitRepoInfo {
        root,
        main_root,
        rel,
        branch,
        head,
        is_worktree,
        base_branch,
        base_ref,
        worktrees,
    })
}

/// Every checkout of the repository `root` belongs to, main one first.
fn list_worktrees(root: &Path) -> GitResult<Vec<GitWorktree>> {
    Ok(parse_worktrees(&git_line(
        root,
        &["worktree", "list", "--porcelain"],
    )?))
}

/// The caller's choice when it names a local branch, else the first of
/// `development` / `main` / `master` that exists.
fn resolve_base_branch(root: &Path, requested: Option<&str>) -> GitResult<Option<String>> {
    let asked = requested.map(str::trim).filter(|b| !b.is_empty());
    if let Some(name) = asked {
        if branch_exists(root, name)? {
            return Ok(Some(name.to_string()));
        }
        // A setting naming a branch this checkout doesn't have degrades to the
        // auto-detected one rather than disabling the whole view.
    }
    for candidate in BASE_BRANCH_CANDIDATES {
        if branch_exists(root, candidate)? {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

fn branch_exists(root: &Path, branch: &str) -> GitResult<bool> {
    let refname = format!("refs/heads/{branch}");
    Ok(git_line_opt(root, &["rev-parse", "--verify", "--quiet", &refname])?.is_some())
}

/// `git show <rev>:<rel>`. `None` means the path does not exist at that
/// revision (a new file), which is a fact, not a failure.
fn show_file(root: &str, rev: &str, rel: &str) -> GitResult<Option<String>> {
    let spec = format!("{rev}:{rel}");
    let out = run_git(Some(Path::new(root)), &["show", &spec])?;
    if out.ok {
        return Ok(Some(out.stdout));
    }
    if is_not_a_repo(&out.stderr) || dubious_path(&out.stderr).is_some() {
        return Err(classify(&out.stderr, Path::new(root)));
    }
    if is_missing_at_rev(&out.stderr) {
        return Ok(None);
    }
    Err(GitError::failed(out.stderr))
}

/// git's several ways of saying "that path isn't in that revision":
/// `path 'x' does not exist in 'rev'`, `path 'x' exists on disk, but not in
/// 'rev'`, and `invalid object name` for a revision with no such tree entry.
fn is_missing_at_rev(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("does not exist in")
        || lower.contains("exists on disk, but not in")
        || lower.contains("does not exist in the given revision")
        || lower.contains("invalid object name")
}

/// The blob sha of `rev:rel`, or `None` when the path is absent there.
fn blob_at(root: &Path, rev: &str, rel: &str) -> GitResult<Option<String>> {
    let spec = format!("{rev}:{rel}");
    git_line_opt(root, &["rev-parse", "--verify", "--quiet", &spec])
}

fn file_changes(
    root: &str,
    rel: &str,
    base_ref: &str,
    branches: Vec<String>,
) -> GitResult<Vec<GitFileChange>> {
    let root = Path::new(root);
    let base = blob_at(root, base_ref, rel)?;
    let mut out = Vec::with_capacity(branches.len());
    for branch in branches {
        let blob = blob_at(root, &branch, rel)?;
        // Missing on exactly one side counts as a difference; missing on both
        // (the file exists on neither branch) does not.
        let differs = blob != base;
        out.push(GitFileChange { branch, differs });
    }
    Ok(out)
}

/// Add the repository holding `path` to the user's global `safe.directory`
/// list — git's own fix for "dubious ownership", run only when the user said
/// so. The path added is the one git itself names for `path` (never the
/// caller's string), so this can only ever trust the repository git just
/// refused. Already trusted (git answers normally) is a no-op.
fn trust_directory(path: &str) -> GitResult<()> {
    let dir = work_dir(Path::new(path));
    let probe = run_git(Some(dir), &["rev-parse", "--show-toplevel"])?;
    if probe.ok {
        return Ok(());
    }
    let Some(owned) = dubious_path(&probe.stderr) else {
        return Err(classify(&probe.stderr, dir));
    };
    let added = run_git_with(
        None,
        GitMode::Mutate,
        &[
            "config",
            "--global",
            "--add",
            "safe.directory",
            run::safe_arg(&owned)?,
        ],
    )?;
    if !added.ok {
        return Err(GitError::failed(added.stderr));
    }
    Ok(())
}

/// `git init` in the folder `path` — the git tab's "Start tracking with Git"
/// button. A folder already inside a repository is left alone (nothing is
/// nested), and an untrusted one stays an error. Without an
/// `init.defaultBranch` of the user's own, the first branch is `main`.
/// Returns the new repository's root as git spells it.
fn init_repo(path: &str) -> GitResult<String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(GitError::failed(format!(
            "{} is not a folder",
            display(dir)
        )));
    }
    match git_line(dir, &["rev-parse", "--show-toplevel"]) {
        Ok(top) if !top.is_empty() => return Ok(to_slashes(&top)),
        Ok(_) | Err(GitError::NotARepo(_)) => {}
        Err(e) => return Err(e),
    }
    let configured = run_git(None, &["config", "--get", "init.defaultBranch"])?;
    let args: &[&str] = if configured.ok && !configured.stdout.trim().is_empty() {
        &["init"]
    } else {
        &["-c", "init.defaultBranch=main", "init"]
    };
    run::checked(dir, GitMode::Mutate, args)?;
    git_line(dir, &["rev-parse", "--show-toplevel"]).map(|top| to_slashes(&top))
}

/// Who git will say made a commit in `path`: `user.name` / `user.email` as
/// git resolves them there (repository, then global, then system config).
/// `None` for one that is not set — the first commit would fail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

fn identity(path: &str) -> GitResult<GitIdentity> {
    let dir = work_dir(Path::new(path));
    let get = |key: &str| -> GitResult<Option<String>> {
        let out = run_git(Some(dir), &["config", "--get", key])?;
        Ok(Some(out.stdout.trim().to_string()).filter(|v| out.ok && !v.is_empty()))
    };
    Ok(GitIdentity {
        name: get("user.name")?,
        email: get("user.email")?,
    })
}

/// Save `user.name` / `user.email` in the user's GLOBAL git config, so every
/// repository on this computer commits as them. Called only from the git
/// tab's "Who's making these commits?" form.
fn set_identity(name: &str, email: &str) -> GitResult<()> {
    for (key, value) in [("user.name", name.trim()), ("user.email", email.trim())] {
        let out = run_git_with(
            None,
            GitMode::Mutate,
            &["config", "--global", key, run::safe_arg(value)?],
        )?;
        if !out.ok {
            return Err(GitError::failed(out.stderr));
        }
    }
    Ok(())
}

/* -------------------------------- commands -------------------------------- */

/// Where this path sits in git: root, branch, HEAD, the baseline branch and
/// its merge-base, and every worktree of the repository. `base_branch` is the
/// `reviewBaseBranch` setting (empty = auto-detect).
#[tauri::command]
pub async fn git_repo_info(path: String, base_branch: Option<String>) -> GitResult<GitRepoInfo> {
    blocking(move || repo_info(&path, base_branch.as_deref())).await
}

/// One file's contents at a revision, or `None` when it did not exist there.
#[tauri::command]
pub async fn git_show_file(root: String, rev: String, rel: String) -> GitResult<Option<String>> {
    blocking(move || show_file(&root, &rev, &rel)).await
}

/// Per branch: does its blob for `rel` differ from `base_ref`'s? One
/// `rev-parse` per branch — no checkouts, no working-tree churn.
#[tauri::command]
pub async fn git_file_changes(
    root: String,
    rel: String,
    base_ref: String,
    branches: Vec<String>,
) -> GitResult<Vec<GitFileChange>> {
    blocking(move || file_changes(&root, &rel, &base_ref, branches)).await
}

/// Trust the repository holding `path` (`git config --global --add
/// safe.directory <the path git names>`). The UI calls this only after the
/// user confirmed a `GIT_UNTRUSTED` failure.
#[tauri::command]
pub async fn git_trust_directory(path: String) -> GitResult<()> {
    blocking(move || trust_directory(&path)).await
}

/// Turn the folder `path` into a git repository (`git init`). The UI calls
/// this only from the git tab's "not a repository" panel, on a click.
#[tauri::command]
pub async fn git_init(path: String) -> GitResult<String> {
    blocking(move || init_repo(&path)).await
}

/// The name and email git would put on a commit made in `path`.
#[tauri::command]
pub async fn git_identity(path: String) -> GitResult<GitIdentity> {
    blocking(move || identity(&path)).await
}

/// Save the user's name and email in their global git config. The UI calls
/// this only when the user submits the git tab's identity form.
#[tauri::command]
pub async fn git_set_identity(name: String, email: String) -> GitResult<()> {
    blocking(move || set_identity(&name, &email)).await
}

#[cfg(test)]
mod tests {
    use super::testutil::{git_ok, have_git, temp_repo};
    use super::*;

    #[test]
    fn slashes_normalize_and_drop_a_trailing_separator() {
        assert_eq!(to_slashes(r"C:\work\proj\"), "C:/work/proj");
        assert_eq!(to_slashes("/home/u/proj/"), "/home/u/proj");
        // A drive root keeps its slash — `C:` alone is not the same path.
        assert_eq!(to_slashes(r"C:\"), "C:/");
        assert_eq!(to_slashes("/"), "/");
    }

    #[test]
    fn rel_path_is_root_relative_with_forward_slashes() {
        assert_eq!(
            relative_path("C:/work/proj", r"C:\work\proj\src\core\a.ts").as_deref(),
            Some("src/core/a.ts"),
        );
        assert_eq!(relative_path("/r", "/r/a/b.rs").as_deref(), Some("a/b.rs"));
        // The root itself is the empty relative path, not None.
        assert_eq!(relative_path("/r", "/r").as_deref(), Some(""));
        assert_eq!(relative_path("/r", "/r/").as_deref(), Some(""));
        // A sibling whose name merely starts with the root is not under it.
        assert_eq!(relative_path("/r", "/rr/a.ts"), None);
        assert_eq!(relative_path("/r", "/other/a.ts"), None);
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn rel_path_folds_case_on_case_insensitive_filesystems() {
        // The tab's path and git's toplevel routinely disagree on drive case.
        assert_eq!(
            relative_path("c:/Work/Proj", r"C:\work\proj\src\A.ts").as_deref(),
            Some("src/A.ts"),
        );
    }

    #[test]
    fn porcelain_parses_branches_detached_heads_and_bare_records() {
        let out = concat!(
            "worktree C:/Users/x/repo\n",
            "HEAD 1111111111111111111111111111111111111111\n",
            "branch refs/heads/development\n",
            "\n",
            "worktree C:/Users/x/repo/worktrees/cr-git\n",
            "HEAD 2222222222222222222222222222222222222222\n",
            "branch refs/heads/feat/cr-git\n",
            "prunable gitdir file points to non-existent location\n",
            "\n",
            "worktree C:/Users/x/repo/worktrees/spike\n",
            "HEAD 3333333333333333333333333333333333333333\n",
            "detached\n",
            "locked\n",
            "\n",
        );
        let found = parse_worktrees(out);
        assert_eq!(
            found,
            vec![
                GitWorktree {
                    path: "C:/Users/x/repo".into(),
                    branch: Some("development".into()),
                    head: "1111111111111111111111111111111111111111".into(),
                    locked: false,
                    prunable: false,
                },
                GitWorktree {
                    path: "C:/Users/x/repo/worktrees/cr-git".into(),
                    branch: Some("feat/cr-git".into()),
                    head: "2222222222222222222222222222222222222222".into(),
                    locked: false,
                    prunable: true,
                },
                GitWorktree {
                    path: "C:/Users/x/repo/worktrees/spike".into(),
                    branch: None,
                    head: "3333333333333333333333333333333333333333".into(),
                    locked: true,
                    prunable: false,
                },
            ],
        );
        assert_eq!(main_root_of(&found, "/fallback"), "C:/Users/x/repo");
        assert_eq!(main_root_of(&[], "/fallback"), "/fallback");
    }

    #[test]
    fn porcelain_drops_a_bare_record_and_survives_a_missing_trailing_blank_line() {
        let out = concat!(
            "worktree /repo.git\n",
            "bare\n",
            "\n",
            "worktree /repo/wt\n",
            "HEAD 4444444444444444444444444444444444444444\n",
            "branch refs/heads/main",
        );
        let found = parse_worktrees(out);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "/repo/wt");
        assert_eq!(found[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn porcelain_of_nothing_is_no_worktrees() {
        assert!(parse_worktrees("").is_empty());
        assert!(parse_worktrees("\n\n").is_empty());
    }

    #[test]
    fn backslashed_worktree_paths_come_back_with_forward_slashes() {
        let out = "worktree C:\\repo\\wt\nHEAD abc\nbranch refs/heads/feat/x\n";
        assert_eq!(parse_worktrees(out)[0].path, "C:/repo/wt");
    }

    #[test]
    fn error_codes_and_wire_shape_match_the_readme_table() {
        let cases = [
            (GitError::NoGit, "GIT_NOT_FOUND"),
            (GitError::NotARepo("/x".into()), "GIT_NOT_A_REPO"),
            (GitError::Untrusted("/x".into()), "GIT_UNTRUSTED"),
            (GitError::Timeout(3), "GIT_TIMEOUT"),
            (GitError::failed("boom"), "GIT_FAILED"),
            (GitError::Cancelled, "GIT_CANCELLED"),
            (GitError::Busy, "GIT_BUSY"),
            (GitError::InvalidArg("x".into()), "GIT_INVALID_ARG"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code);
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json["code"], code);
            assert!(json["message"].is_string());
        }
        // The timeout names its mode's limit — the UI text quotes it.
        assert!(GitError::Timeout(120).to_string().contains("120s"));
    }

    #[test]
    fn missing_at_rev_is_told_apart_from_a_real_failure() {
        assert!(is_missing_at_rev(
            "fatal: path 'src/new.ts' does not exist in 'HEAD'"
        ));
        assert!(is_missing_at_rev(
            "fatal: path 'src/new.ts' exists on disk, but not in 'abc123'"
        ));
        assert!(!is_missing_at_rev("fatal: bad revision 'nope'"));
        assert!(is_not_a_repo(
            "fatal: not a git repository (or any of the parent directories): .git"
        ));
    }

    #[test]
    fn dubious_ownership_names_the_path_git_wants_trusted() {
        // git 2.55 on Windows, verbatim.
        let win = "fatal: detected dubious ownership in repository at 'C:/Users/x/proj'\n\
                   To add an exception for this directory, call:\n\n\
                   \tgit config --global --add safe.directory C:/Users/x/proj";
        assert_eq!(dubious_path(win).as_deref(), Some("C:/Users/x/proj"));
        // The suggested argument wins over the first line (a UNC share).
        let unc = "fatal: detected dubious ownership in repository at '//srv/share/proj'\n\
                   '//srv/share/proj' is owned by:\n\tS-1-5-32-544\nbut the current user is:\n\tS-1-5-21-1\n\
                   To add an exception for this directory, call:\n\n\
                   \tgit config --global --add safe.directory '%(prefix)///srv/share/proj'";
        assert_eq!(
            dubious_path(unc).as_deref(),
            Some("%(prefix)///srv/share/proj")
        );
        // No suggestion line: the quoted path from the first line.
        let bare = "fatal: detected dubious ownership in repository at '/srv/repo'";
        assert_eq!(dubious_path(bare).as_deref(), Some("/srv/repo"));
        assert_eq!(dubious_path("fatal: not a git repository"), None);

        match classify(win, Path::new("C:/Users/x/proj/sub")) {
            GitError::Untrusted(p) => assert_eq!(p, "C:/Users/x/proj"),
            other => panic!("expected Untrusted, got {other:?}"),
        }
    }

    /* ---------------------- against a real git binary ---------------------- */

    #[test]
    fn repo_info_and_show_file_round_trip_in_a_real_repo() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_guard, root) = temp_repo();
        let file = root.join("a.ts");

        let info = repo_info(&file.to_string_lossy(), None).expect("repo info");
        assert_eq!(info.rel, "a.ts");
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.head.len(), 40);
        assert!(!info.is_worktree, "the main checkout is not a worktree");
        assert_eq!(info.base_branch.as_deref(), Some("main"));
        // HEAD is the baseline, so there is no merge-base to compare against.
        assert_eq!(info.base_ref, None);
        assert_eq!(info.worktrees.len(), 1);
        assert_eq!(info.worktrees[0].branch.as_deref(), Some("main"));
        assert_eq!(
            path_key(&info.worktrees[0].path),
            path_key(&info.root),
            "the single worktree is the root itself",
        );
        assert_eq!(path_key(&info.main_root), path_key(&info.root));

        // The committed text comes back; an uncommitted edit does not change it.
        std::fs::write(&file, "export const a = 2;\n").unwrap();
        let shown = show_file(&info.root, "HEAD", "a.ts").expect("show");
        assert_eq!(shown.as_deref(), Some("export const a = 1;\n"));

        // A path that never existed at that revision is None, not an error.
        assert_eq!(
            show_file(&info.root, "HEAD", "nope.ts").expect("show"),
            None
        );
    }

    #[test]
    fn a_branch_off_the_baseline_gets_a_merge_base_and_a_changed_radar() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_guard, root) = temp_repo();
        let base_head = repo_info(&root.to_string_lossy(), None).unwrap().head;

        git_ok(&root, &["checkout", "-b", "feat/x"]);
        std::fs::write(root.join("a.ts"), "export const a = 2;\n").unwrap();
        git_ok(&root, &["commit", "-am", "second"]);

        let info = repo_info(&root.join("a.ts").to_string_lossy(), None).expect("repo info");
        assert_eq!(info.branch.as_deref(), Some("feat/x"));
        assert_eq!(info.base_branch.as_deref(), Some("main"));
        assert_eq!(info.base_ref.as_deref(), Some(base_head.as_str()));

        let changes = file_changes(
            &info.root,
            "a.ts",
            &base_head,
            vec!["feat/x".into(), "main".into()],
        )
        .expect("file changes");
        assert_eq!(changes[0].branch, "feat/x");
        assert!(changes[0].differs, "the feature branch rewrote the file");
        assert_eq!(changes[1].branch, "main");
        assert!(!changes[1].differs, "main IS the baseline");

        // A file that exists on neither side is not a difference.
        let none = file_changes(&info.root, "ghost.ts", &base_head, vec!["feat/x".into()]).unwrap();
        assert!(!none[0].differs);
    }

    #[test]
    fn a_linked_worktree_knows_it_is_one_and_lists_its_sibling() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_guard, root) = temp_repo();
        let wt = root.join("worktrees").join("feat-x");
        git_ok(
            &root,
            &["worktree", "add", "-b", "feat/x", &wt.to_string_lossy()],
        );

        let info = repo_info(&wt.join("a.ts").to_string_lossy(), None).expect("repo info");
        assert!(info.is_worktree, "a linked worktree reports itself as one");
        assert_eq!(info.branch.as_deref(), Some("feat/x"));
        assert_eq!(info.rel, "a.ts");
        assert_eq!(info.base_branch.as_deref(), Some("main"));
        // A fresh branch off main: the merge-base is main's tip.
        assert_eq!(info.base_ref.as_deref(), Some(info.head.as_str()));
        assert_eq!(info.worktrees.len(), 2);
        assert!(info
            .worktrees
            .iter()
            .any(|w| w.branch.as_deref() == Some("feat/x")));
        // The tab's identity is the MAIN checkout, not the worktree asked about.
        assert_ne!(path_key(&info.main_root), path_key(&info.root));
        assert_eq!(
            path_key(&info.main_root),
            path_key(&root.to_string_lossy()),
            "main_root is the first worktree record — the main checkout",
        );

        // The main checkout, asked the same question, says it is not a worktree.
        let main = repo_info(&root.join("a.ts").to_string_lossy(), None).expect("repo info");
        assert!(!main.is_worktree);
        assert_eq!(path_key(&main.main_root), path_key(&main.root));
    }

    /// End to end against real git's ownership check. Ignored by default: it
    /// needs the whole process to run with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`
    /// (git then treats every repository as foreign) and `GIT_CONFIG_GLOBAL`
    /// pointing at a scratch file — never the real ~/.gitconfig. Run with
    /// both set: `cargo test --lib untrusted_repo_round_trip -- --ignored`.
    #[test]
    #[ignore]
    fn untrusted_repo_round_trip() {
        if std::env::var("GIT_TEST_ASSUME_DIFFERENT_OWNER").as_deref() != Ok("1")
            || std::env::var("GIT_CONFIG_GLOBAL").is_err()
        {
            panic!("set GIT_TEST_ASSUME_DIFFERENT_OWNER=1 and GIT_CONFIG_GLOBAL=<scratch file>");
        }
        let dir = tempfile::tempdir().unwrap();
        let out = run_git(Some(dir.path()), &["init", "-q"]).unwrap();
        assert!(out.ok, "{}", out.stderr);
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();

        match repo_info(&sub.to_string_lossy(), None) {
            Err(GitError::Untrusted(_)) => {}
            other => panic!("expected Untrusted, got {other:?}"),
        }
        trust_directory(&sub.to_string_lossy()).expect("trust");
        repo_info(&sub.to_string_lossy(), None).expect("trusted now");
        // Trusting again is a no-op, not a second config entry.
        trust_directory(&sub.to_string_lossy()).expect("idempotent");
        let list = run_git_with(
            None,
            GitMode::Read,
            &["config", "--global", "--get-all", "safe.directory"],
        )
        .unwrap();
        assert_eq!(list.stdout.lines().count(), 1, "{}", list.stdout);
    }

    #[test]
    fn a_path_outside_any_repo_reports_not_a_repo() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        // A temp dir is not inside a repository on any of the CI runners.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "x\n").unwrap();
        match repo_info(&dir.path().join("a.ts").to_string_lossy(), None) {
            Err(GitError::NotARepo(_)) => {}
            other => panic!("expected NotARepo, got {other:?}"),
        }
    }

    #[test]
    fn init_makes_a_repository_and_leaves_an_existing_one_alone() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.ts"),
            "x
",
        )
        .unwrap();
        let root = init_repo(&dir.path().to_string_lossy()).expect("init");
        let info = repo_info(&root, None).expect("a repository now");
        assert_eq!(path_key(&info.root), path_key(&root));
        // No commits yet: an unborn branch, not an error.
        assert_eq!(info.head, "");
        // A second init (or one from a subfolder) changes nothing.
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let again = init_repo(&sub.to_string_lossy()).expect("already a repo");
        assert_eq!(path_key(&again), path_key(&root));
        assert!(!sub.join(".git").exists());
        // A file is not a folder to init.
        assert!(init_repo(&dir.path().join("a.ts").to_string_lossy()).is_err());
    }

    #[test]
    fn identity_reads_what_git_would_commit_as() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        // temp_repo sets a repo-local identity, which wins over any global one.
        let (_dir, root) = temp_repo();
        let id = identity(&root.to_string_lossy()).expect("identity");
        assert_eq!(id.name.as_deref(), Some("Test"));
        assert_eq!(id.email.as_deref(), Some("t@example.com"));
    }

    #[test]
    fn set_identity_refuses_an_empty_or_option_like_value() {
        assert!(matches!(
            set_identity("  ", "a@b.c"),
            Err(GitError::InvalidArg(_))
        ));
        assert!(matches!(
            set_identity("Ann", "--global"),
            Err(GitError::InvalidArg(_))
        ));
    }

    /// Writes the GLOBAL git config, so it is ignored by default and refuses
    /// to run unless `GIT_CONFIG_GLOBAL` points at a scratch file:
    /// `cargo test --lib set_identity_round_trip -- --ignored`.
    #[test]
    #[ignore]
    fn set_identity_round_trip() {
        if std::env::var("GIT_CONFIG_GLOBAL").is_err() {
            panic!("set GIT_CONFIG_GLOBAL=<scratch file>");
        }
        let dir = tempfile::tempdir().unwrap();
        set_identity(" Ann Example ", "ann@example.com").expect("saved");
        let id = identity(&dir.path().to_string_lossy()).expect("identity");
        assert_eq!(id.name.as_deref(), Some("Ann Example"));
        assert_eq!(id.email.as_deref(), Some("ann@example.com"));
    }
}
