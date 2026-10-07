//! Test fixtures shared by the git modules: throwaway repositories against
//! the real `git` binary. Every integration test starts with `have_git()` and
//! skips (not fails) without git — CI images have it, a minimal box may not.

use super::run::{run_git_with, GitMode};
use super::GitError;
use std::path::{Path, PathBuf};

/// Whether this machine has git at all.
pub fn have_git() -> bool {
    !matches!(
        run_git_with(None, GitMode::Read, &["--version"]),
        Err(GitError::NoGit)
    )
}

/// Run git in `dir` and require success.
pub fn git_ok(dir: &Path, args: &[&str]) {
    let out = run_git_with(Some(dir), GitMode::Mutate, args).expect("git ran");
    assert!(out.ok, "git {args:?} failed: {}", out.stderr);
}

/// Run git in `dir`, require success, return trimmed stdout.
pub fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = run_git_with(Some(dir), GitMode::Mutate, args).expect("git ran");
    assert!(out.ok, "git {args:?} failed: {}", out.stderr);
    out.stdout.trim().to_string()
}

pub fn head_of(dir: &Path) -> String {
    git_out(dir, &["rev-parse", "HEAD"])
}

pub fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, text).unwrap();
}

/// Deterministic identity, no signing, no CRLF surprises, no reliance on the
/// machine's `init.defaultBranch`.
pub fn configure(root: &Path) {
    git_ok(root, &["config", "user.email", "t@example.com"]);
    git_ok(root, &["config", "user.name", "Test"]);
    git_ok(root, &["config", "commit.gpgsign", "false"]);
    git_ok(root, &["config", "core.autocrlf", "false"]);
}

/// `git init` + config, no commits (an unborn `main`).
pub fn init_repo(root: &Path) {
    std::fs::create_dir_all(root).unwrap();
    git_ok(root, &["init", "--initial-branch=main"]);
    configure(root);
}

/// `root` as git itself spells it. The temp dir is often an alias of its real
/// path — `/var` → `/private/var` on macOS, an 8.3 `RUNNER~1` on Windows CI —
/// and git always reports the resolved form, so fixtures must use that one.
fn as_git_sees_it(root: &Path) -> PathBuf {
    PathBuf::from(git_out(root, &["rev-parse", "--show-toplevel"]))
}

/// A throwaway repo with one commit (`a.ts`).
pub fn temp_repo() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    init_repo(dir.path());
    let root = as_git_sees_it(dir.path());
    write(&root, "a.ts", "export const a = 1;\n");
    git_ok(&root, &["add", "a.ts"]);
    git_ok(&root, &["commit", "-m", "first"]);
    (dir, root)
}

/// A repo at `<tmp>/repo` whose `origin` is a bare repository at
/// `<tmp>/remote.git`, `main` pushed and tracking — so fetch / pull / push run
/// entirely offline. Returns `(guard, root, remote_path)`.
pub fn temp_repo_with_remote() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let remote = dir.path().join("remote.git");
    init_repo(&dir.path().join("repo"));
    let root = as_git_sees_it(&dir.path().join("repo"));
    write(&root, "a.ts", "export const a = 1;\n");
    git_ok(&root, &["add", "a.ts"]);
    git_ok(&root, &["commit", "-m", "first"]);
    std::fs::create_dir_all(&remote).unwrap();
    git_ok(&remote, &["init", "--bare", "--initial-branch=main"]);
    git_ok(
        &root,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );
    git_ok(&root, &["push", "-u", "origin", "main"]);
    (dir, root, remote)
}

/// A second clone of `remote` at `path`, configured, on `main`.
pub fn clone_of(remote: &Path, path: &Path) {
    let parent = path.parent().unwrap();
    git_ok(
        parent,
        &[
            "clone",
            "--quiet",
            &remote.to_string_lossy(),
            &path.to_string_lossy(),
        ],
    );
    configure(path);
}

/// Two branches editing the same line of `a.ts`: `main` gets one version,
/// `feat/conflict` the other. Leaves the checkout on `main`. Returns the
/// branch to merge for a conflict.
pub fn make_conflict(root: &Path) -> &'static str {
    git_ok(root, &["switch", "-c", "feat/conflict"]);
    write(root, "a.ts", "export const a = 'theirs';\n");
    git_ok(root, &["commit", "-am", "theirs"]);
    git_ok(root, &["switch", "main"]);
    write(root, "a.ts", "export const a = 'ours';\n");
    git_ok(root, &["commit", "-am", "ours"]);
    "feat/conflict"
}

pub fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
