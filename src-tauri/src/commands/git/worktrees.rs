//! Worktrees as first-class citizens: the dashboard summary (`git_worktrees`),
//! `git_worktree_add` / `git_worktree_remove`, and `git_check_ignore` (the
//! store asks it before appending `worktrees/` to `.gitignore`).

use super::refs::ahead_behind;
use super::run::{checked, run_git_with, safe_arg, safe_rel, GitMode};
use super::status::{read_status, repo_state, GitRepoState, GitStatusEntryKind};
use super::{blocking, list_worktrees, resolve_base_branch, GitError, GitResult};
use serde::Serialize;
use std::path::Path;

/// Summaries are computed for at most this many worktrees — each costs a
/// status and a rev-list, and a repository with more than twenty checkouts is
/// asking a dashboard for something it cannot show anyway.
const MAX_SUMMARIES: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeSummary {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
    pub locked: bool,
    /// The directory no longer exists (or git marks it prunable); counts are zero.
    pub missing: bool,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub state: GitRepoState,
    /// Against the base branch; `None` with no base, or when this checkout IS
    /// the base.
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

pub(super) fn worktree_summaries(
    root: &Path,
    base_branch: Option<&str>,
) -> GitResult<Vec<GitWorktreeSummary>> {
    let base = resolve_base_branch(root, base_branch)?;
    let base_ref = base.as_ref().map(|b| format!("refs/heads/{b}"));
    let mut out = Vec::new();
    for (i, wt) in list_worktrees(root)?
        .into_iter()
        .take(MAX_SUMMARIES)
        .enumerate()
    {
        let dir = Path::new(&wt.path);
        let mut summary = GitWorktreeSummary {
            path: wt.path.clone(),
            branch: wt.branch.clone(),
            head: wt.head.clone(),
            is_main: i == 0,
            locked: wt.locked,
            missing: wt.prunable || !dir.is_dir(),
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            state: GitRepoState::Clean,
            ahead: None,
            behind: None,
        };
        if summary.missing {
            out.push(summary);
            continue;
        }
        // A worktree whose status cannot be read (a foreign lock, a broken
        // gitdir file) is reported as missing rather than failing the whole
        // dashboard.
        match read_status(dir) {
            Ok(st) => {
                for e in &st.entries {
                    match e.kind {
                        GitStatusEntryKind::Ordinary | GitStatusEntryKind::Renamed => {
                            if e.index != "." {
                                summary.staged += 1;
                            }
                            if e.worktree != "." {
                                summary.unstaged += 1;
                            }
                        }
                        GitStatusEntryKind::Untracked => summary.untracked += 1,
                        GitStatusEntryKind::Unmerged => summary.conflicted += 1,
                    }
                }
            }
            Err(_) => {
                summary.missing = true;
                out.push(summary);
                continue;
            }
        }
        summary.state = repo_state(dir)
            .map(|(s, _)| s)
            .unwrap_or(GitRepoState::Clean);
        if let Some(base_ref) = &base_ref {
            let is_base = wt.branch.as_deref() == base.as_deref();
            if !is_base && !wt.head.is_empty() {
                if let Ok(ab) = ahead_behind(root, &wt.head, base_ref) {
                    summary.ahead = Some(ab.ahead);
                    summary.behind = Some(ab.behind);
                }
            }
        }
        out.push(summary);
    }
    Ok(out)
}

/// `check-ignore -q -- rel`: exit 0 = ignored, 1 = not, anything else an error.
pub(super) fn check_ignore(root: &Path, rel: &str) -> GitResult<bool> {
    let rel = safe_rel(rel)?;
    let out = run_git_with(
        Some(root),
        GitMode::Read,
        &["check-ignore", "-q", "--", rel],
    )?;
    match out.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(super::classify(&out.stderr, root)),
    }
}

/// The path a new worktree lands in must be absolute — git would otherwise
/// resolve it against the checkout, and the caller has already chosen where.
fn safe_abs_path(path: &str) -> GitResult<&str> {
    let path = safe_arg(path)?;
    if !Path::new(path).is_absolute() {
        return Err(GitError::InvalidArg(format!(
            "worktree path must be absolute: {path}"
        )));
    }
    Ok(path)
}

pub(super) fn worktree_add(
    root: &Path,
    path: &str,
    branch: &str,
    start_point: Option<&str>,
    create_branch: bool,
) -> GitResult<()> {
    let path = safe_abs_path(path)?;
    let branch = safe_arg(branch)?;
    let mut args = vec!["worktree", "add"];
    if create_branch {
        args.extend(["-b", branch, "--", path]);
        if let Some(start) = start_point {
            args.push(safe_arg(start)?);
        }
    } else {
        args.extend(["--", path, branch]);
    }
    checked(root, GitMode::Mutate, &args)?;
    Ok(())
}

/// How many times the leftover-directory delete is retried, and the pause
/// between tries. A shell that was closed a moment ago can still hold the
/// directory on Windows; a couple of seconds covers its exit.
const LEFTOVER_DELETE_TRIES: u32 = 6;
const LEFTOVER_DELETE_PAUSE: std::time::Duration = std::time::Duration::from_millis(400);

/// `git worktree remove` validates the checkout (dirty? locked? a worktree at
/// all?) before deleting anything, so once stderr reports a *delete* failure
/// the refusal stage is over: git has already dropped the worktree's record
/// and only the folder is left. On Windows that happens for every pnpm
/// worktree — `node_modules/.pnpm` paths exceed MAX_PATH and git's own delete
/// does not use the long-path form, even with `core.longpaths=true`.
fn is_delete_failure(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("failed to delete") || text.contains("failed to remove")
}

/// Whether `dir` is the leftover folder of a worktree of `root` that git no
/// longer lists: its `.git` is a file whose `gitdir:` points into `root`'s
/// `.git/worktrees/`. Only such a folder is deleted without git's say-so.
fn is_orphaned_worktree_of(root: &Path, dir: &Path) -> bool {
    let marker = dir.join(".git");
    if !marker.is_file() {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(&marker) else {
        return false;
    };
    let Some(gitdir) = text.trim().strip_prefix("gitdir:") else {
        return false;
    };
    // Compared as written, not canonicalised: on Windows `canonicalize`
    // yields a verbatim (`//?/`) path that git's plain `gitdir:` never has.
    let plain = |p: &str| {
        let key = super::path_key(p);
        key.strip_prefix("//?/").map(str::to_string).unwrap_or(key)
    };
    let admin = root.join(".git").join("worktrees");
    let admin_key = format!("{}/", plain(&admin.to_string_lossy()));
    plain(gitdir.trim()).starts_with(&admin_key)
}

/// Delete a worktree folder ourselves. `std::fs::remove_dir_all` uses the
/// long-path form on Windows, never follows a junction or symlink (a linked
/// `node_modules` loses the link, not its target), and ignores read-only
/// attributes. Transient holds ("being used by another process", a
/// directory a closing shell has not released) are retried.
fn remove_leftover_dir(dir: &Path) -> GitResult<()> {
    let mut last = None;
    for attempt in 0..LEFTOVER_DELETE_TRIES {
        if attempt > 0 {
            std::thread::sleep(LEFTOVER_DELETE_PAUSE);
        }
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => last = Some(e),
        }
        if !dir.exists() {
            return Ok(());
        }
    }
    let e = last.expect("at least one attempt");
    Err(GitError::failed(format!(
        "git unregistered the worktree but its folder could not be deleted: {} ({e}). Close any terminal or program inside it, then remove the folder by hand.",
        dir.display()
    )))
}

pub(super) fn worktree_remove(root: &Path, path: &str, force: bool) -> GitResult<()> {
    let path = safe_abs_path(path)?;
    let dir = Path::new(path);
    // A directory that is already gone (deleted by hand) has nothing to
    // remove; `prune` alone drops git's record of it.
    if dir.exists() {
        let key = super::path_key(path);
        let registered = list_worktrees(root)?
            .iter()
            .any(|w| super::path_key(&w.path) == key);
        if !registered && is_orphaned_worktree_of(root, dir) {
            // An earlier removal got as far as unregistering it (the app was
            // closed mid-delete, or an older build ran git alone).
            remove_leftover_dir(dir)?;
        } else {
            let mut args = vec!["worktree", "remove"];
            if force {
                args.push("--force");
            }
            args.extend(["--", path]);
            match checked(root, GitMode::Mutate, &args) {
                Ok(_) => {}
                // Git gave up on the folder after dropping its record of the
                // worktree ("Filename too long", a held directory): finish
                // the job with a delete that copes with both.
                Err(GitError::Failed { stderr }) if is_delete_failure(&stderr) => {
                    remove_leftover_dir(dir)?;
                }
                Err(e) => return Err(e),
            }
        }
    }
    checked(root, GitMode::Mutate, &["worktree", "prune"])?;
    Ok(())
}

/* -------------------------------- commands -------------------------------- */

/// Every checkout with its dashboard facts (dirty counts, ahead/behind the
/// base branch). `base_branch` as for `git_repo_info`.
#[tauri::command]
pub async fn git_worktrees(
    root: String,
    base_branch: Option<String>,
) -> GitResult<Vec<GitWorktreeSummary>> {
    blocking(move || worktree_summaries(Path::new(&root), base_branch.as_deref())).await
}

/// Is `rel` ignored?
#[tauri::command]
pub async fn git_check_ignore(root: String, rel: String) -> GitResult<bool> {
    blocking(move || check_ignore(Path::new(&root), &rel)).await
}

/// `worktree add`: with `create_branch`, `-b <branch> <path> [<start_point>]`;
/// otherwise checks out the existing `branch` at `path`. `path` is absolute.
#[tauri::command]
pub async fn git_worktree_add(
    root: String,
    path: String,
    branch: String,
    start_point: Option<String>,
    create_branch: bool,
) -> GitResult<()> {
    blocking(move || {
        worktree_add(
            Path::new(&root),
            &path,
            &branch,
            start_point.as_deref(),
            create_branch,
        )
    })
    .await
}

/// `worktree remove [--force] <path>` then `worktree prune`.
#[tauri::command]
pub async fn git_worktree_remove(root: String, path: String, force: bool) -> GitResult<()> {
    blocking(move || worktree_remove(Path::new(&root), &path, force)).await
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{git_ok, have_git, s, temp_repo, write};
    use super::super::{path_key, GitError};
    use super::*;

    #[test]
    fn real_worktree_summaries_two_worktrees_one_dirty_one_ahead() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        let dirty = root.join("worktrees").join("dirty");
        let ahead = root.join("worktrees").join("ahead");
        worktree_add(&root, &s(&dirty), "feat/dirty", None, true).unwrap();
        worktree_add(&root, &s(&ahead), "feat/ahead", Some("main"), true).unwrap();
        write(&dirty, "a.ts", "edited\n");
        write(&dirty, "new.ts", "new\n");
        write(&dirty, "staged.ts", "s\n");
        git_ok(&dirty, &["add", "staged.ts"]);
        write(&ahead, "b.ts", "b\n");
        git_ok(&ahead, &["add", "b.ts"]);
        git_ok(&ahead, &["commit", "-m", "ahead by one"]);
        // main moves on too, so `ahead` is also behind.
        write(&root, "c.ts", "c\n");
        git_ok(&root, &["add", "c.ts"]);
        git_ok(&root, &["commit", "-m", "main moves"]);

        let all = worktree_summaries(&root, None).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all[0].is_main);
        assert_eq!(path_key(&all[0].path), path_key(&s(&root)));
        assert_eq!(all[0].branch.as_deref(), Some("main"));
        assert_eq!(
            (all[0].ahead, all[0].behind),
            (None, None),
            "the base itself"
        );
        assert!(!all[1].is_main && !all[2].is_main);

        let d = all
            .iter()
            .find(|w| w.branch.as_deref() == Some("feat/dirty"))
            .unwrap();
        assert_eq!(
            (d.staged, d.unstaged, d.untracked, d.conflicted),
            (1, 1, 1, 0)
        );
        assert_eq!((d.ahead, d.behind), (Some(0), Some(1)));
        assert_eq!(d.state, GitRepoState::Clean);
        assert!(!d.missing && !d.locked);

        let a = all
            .iter()
            .find(|w| w.branch.as_deref() == Some("feat/ahead"))
            .unwrap();
        assert_eq!((a.staged, a.unstaged, a.untracked), (0, 0, 0));
        assert_eq!((a.ahead, a.behind), (Some(1), Some(1)));

        // An explicit base that exists wins; one that does not falls back.
        let vs_ahead = worktree_summaries(&root, Some("feat/ahead")).unwrap();
        let main_row = vs_ahead.iter().find(|w| w.is_main).unwrap();
        assert_eq!((main_row.ahead, main_row.behind), (Some(1), Some(1)));
        let fallback = worktree_summaries(&root, Some("nope")).unwrap();
        assert_eq!(fallback[0].ahead, None);
    }

    #[test]
    fn real_worktree_summary_marks_a_deleted_directory_missing_and_a_lock() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        let gone = root.join("worktrees").join("gone");
        let locked = root.join("worktrees").join("locked");
        worktree_add(&root, &s(&gone), "feat/gone", None, true).unwrap();
        worktree_add(&root, &s(&locked), "feat/locked", None, true).unwrap();
        git_ok(&root, &["worktree", "lock", &s(&locked)]);
        std::fs::remove_dir_all(&gone).unwrap();

        let all = worktree_summaries(&root, None).unwrap();
        let g = all
            .iter()
            .find(|w| w.branch.as_deref() == Some("feat/gone"))
            .unwrap();
        assert!(g.missing);
        assert_eq!(
            (g.staged, g.unstaged, g.untracked, g.conflicted),
            (0, 0, 0, 0)
        );
        assert_eq!((g.ahead, g.behind), (None, None));
        let l = all
            .iter()
            .find(|w| w.branch.as_deref() == Some("feat/locked"))
            .unwrap();
        assert!(l.locked && !l.missing);

        // Removing the vanished one is a prune, and it succeeds.
        worktree_remove(&root, &s(&gone), false).unwrap();
        assert!(worktree_summaries(&root, None)
            .unwrap()
            .iter()
            .all(|w| w.branch.as_deref() != Some("feat/gone")));
    }

    #[test]
    fn real_check_ignore_before_and_after() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        assert!(!check_ignore(&root, "worktrees/").unwrap());
        assert!(!check_ignore(&root, "a.ts").unwrap());
        write(&root, ".gitignore", "worktrees/\n");
        assert!(check_ignore(&root, "worktrees/").unwrap());
        assert!(check_ignore(&root, "worktrees/x/file.ts").unwrap());
        assert!(!check_ignore(&root, "a.ts").unwrap());
        assert!(matches!(
            check_ignore(&root, "../x"),
            Err(GitError::InvalidArg(_))
        ));
        assert!(matches!(
            check_ignore(&root, "/abs"),
            Err(GitError::InvalidArg(_))
        ));
    }

    #[test]
    fn real_worktree_add_existing_branch_and_remove_refuses_dirty_unless_forced() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        git_ok(&root, &["branch", "feat/existing"]);
        let wt = root.join("worktrees").join("existing");
        worktree_add(&root, &s(&wt), "feat/existing", None, false).unwrap();
        assert!(wt.join("a.ts").exists());
        let all = worktree_summaries(&root, None).unwrap();
        assert!(all
            .iter()
            .any(|w| w.branch.as_deref() == Some("feat/existing")));

        // Relative paths and option-shaped strings are caller bugs.
        assert!(matches!(
            worktree_add(&root, "worktrees/rel", "feat/rel", None, true),
            Err(GitError::InvalidArg(_))
        ));
        assert!(matches!(
            worktree_add(&root, &s(&root.join("x")), "--force", None, true),
            Err(GitError::InvalidArg(_))
        ));
        // A branch already checked out elsewhere is git's refusal, verbatim.
        match worktree_add(
            &root,
            &s(&root.join("worktrees").join("dup")),
            "main",
            None,
            false,
        ) {
            Err(GitError::Failed { stderr }) => assert!(stderr.contains("already"), "{stderr}"),
            other => panic!("expected Failed, got {other:?}"),
        }

        write(&wt, "a.ts", "dirty\n");
        match worktree_remove(&root, &s(&wt), false) {
            Err(GitError::Failed { stderr }) => {
                assert!(
                    stderr.to_lowercase().contains("modified") || stderr.contains("--force"),
                    "{stderr}"
                )
            }
            other => panic!("expected a dirty refusal, got {other:?}"),
        }
        assert!(wt.exists());
        worktree_remove(&root, &s(&wt), true).unwrap();
        assert!(!wt.exists());
        assert_eq!(worktree_summaries(&root, None).unwrap().len(), 1);
        // The branch survives the worktree.
        git_ok(
            &root,
            &["rev-parse", "--verify", "refs/heads/feat/existing"],
        );
    }

    #[test]
    fn delete_failure_is_recognised_after_the_refusal_stage() {
        assert!(is_delete_failure(
            "error: failed to delete 'C:/r/worktrees/a': Filename too long\n"
        ));
        assert!(is_delete_failure(
            "warning: failed to remove 'C:/r/worktrees/a/x': The process cannot access the file"
        ));
        assert!(!is_delete_failure(
            "fatal: 'worktrees/a' contains modified or untracked files, use --force to delete it"
        ));
        assert!(!is_delete_failure("fatal: 'C:/x' is not a working tree"));
    }

    #[test]
    fn real_remove_deletes_a_folder_git_already_unregistered() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        let wt = root.join("worktrees").join("orphan");
        worktree_add(&root, &s(&wt), "feat/orphan", None, true).unwrap();
        // What a failed `git worktree remove` leaves behind: the record under
        // .git/worktrees/ is gone, the folder (with its `.git` file) is not.
        std::fs::remove_dir_all(root.join(".git").join("worktrees").join("orphan")).unwrap();
        assert!(wt.join(".git").is_file());
        assert!(list_worktrees(&root).unwrap().len() == 1);
        assert!(is_orphaned_worktree_of(&root, &wt));

        worktree_remove(&root, &s(&wt), false).unwrap();
        assert!(!wt.exists());

        // A plain folder that was never a worktree is git's refusal, verbatim.
        let plain = root.join("worktrees").join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!is_orphaned_worktree_of(&root, &plain));
        // (The runner classifies git's "is not a working tree" as NotARepo.)
        match worktree_remove(&root, &s(&plain), false) {
            Err(GitError::NotARepo(_)) => {}
            Err(GitError::Failed { stderr }) => {
                assert!(stderr.contains("not a working tree"), "{stderr}")
            }
            other => panic!("expected git's refusal, got {other:?}"),
        }
        assert!(plain.exists());
    }

    /// The Windows failure this module exists for: a worktree with a path
    /// deeper than MAX_PATH (pnpm's `node_modules/.pnpm`). git drops its
    /// record and then cannot delete the folder; the fallback can.
    #[cfg(windows)]
    #[test]
    fn real_remove_survives_paths_beyond_max_path() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        git_ok(&root, &["config", "core.longpaths", "false"]);
        let wt = root.join("worktrees").join("deep");
        worktree_add(&root, &s(&wt), "feat/deep", None, true).unwrap();
        let mut deep = wt.join("node_modules").join(".pnpm");
        for i in 0..12 {
            deep = deep.join(format!("package-{i}-with-a-rather-long-name"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("index.js"), "module.exports = 1;\n").unwrap();
        assert!(deep.to_string_lossy().len() > 300);

        worktree_remove(&root, &s(&wt), true).unwrap();
        assert!(!wt.exists(), "the folder is gone, node_modules included");
        assert_eq!(worktree_summaries(&root, None).unwrap().len(), 1);
    }
}
