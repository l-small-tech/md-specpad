//! Mutations on one checkout: staging, discarding, committing, branch
//! operations and merging. Every command is `GitMode::Mutate` (30 s, hooks
//! included) and builds one explicit argv; every user string passes
//! `safe_arg` / `safe_rel`, and every path list sits behind `--`.
//!
//! A merge that stops on conflicts is an OUTCOME here, not an error — the
//! store arms its conflict tracker from it — while a refusal (a dirty tree,
//! unrelated histories) is `GIT_FAILED` carrying git's own words.

use super::run::{checked, message_file, run_git_with, safe_arg, safe_rel, GitMode, GitOutput};
use super::status::{read_status, GitStatusEntryKind};
use super::{blocking, head_sha, GitError, GitResult};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitMergeResult {
    Merged,
    FastForward,
    UpToDate,
    Conflicts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMergeOutcome {
    pub outcome: GitMergeResult,
    /// HEAD after the merge (unchanged on `conflicts`).
    pub head: String,
    /// The unmerged paths, from status's `u` records; empty unless `conflicts`.
    pub conflicted: Vec<String>,
}

/* --------------------------------- staging -------------------------------- */

fn rels(paths: &[String]) -> GitResult<Vec<&str>> {
    paths.iter().map(|p| safe_rel(p)).collect()
}

pub(super) fn stage(root: &Path, paths: &[String]) -> GitResult<()> {
    let rels = rels(paths)?;
    if rels.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add", "-A", "--"];
    args.extend(rels);
    checked(root, GitMode::Mutate, &args)?;
    Ok(())
}

pub(super) fn unstage(root: &Path, paths: &[String]) -> GitResult<()> {
    let rels = rels(paths)?;
    if rels.is_empty() {
        return Ok(());
    }
    // `restore --staged` restores from HEAD, which an unborn branch lacks;
    // there, "unstage" means "forget from the index".
    let mut args = if head_sha(root)?.is_some() {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-r", "-q", "--"]
    };
    args.extend(rels);
    checked(root, GitMode::Mutate, &args)?;
    Ok(())
}

/// Throw away the UNSTAGED changes: `tracked` paths are restored from the
/// index (`restore --worktree`, no `--source`), so whatever is staged stays —
/// a file added or renamed in the index and then edited goes back to its
/// staged copy instead of being deleted, as a restore from HEAD (which has
/// no such path) would do. `untracked` ones are deleted (`clean`; a `dir/`
/// entry, as status lists an untracked directory, gets `-d`). Each half runs
/// only when it has paths.
pub(super) fn discard(root: &Path, tracked: &[String], untracked: &[String]) -> GitResult<()> {
    let tracked = rels(tracked)?;
    let untracked = rels(untracked)?;
    if !tracked.is_empty() {
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(tracked);
        checked(root, GitMode::Mutate, &args)?;
    }
    let (dirs, files): (Vec<&str>, Vec<&str>) = untracked.iter().partition(|p| p.ends_with('/'));
    if !files.is_empty() {
        let mut args = vec!["clean", "-f", "--"];
        args.extend(files);
        checked(root, GitMode::Mutate, &args)?;
    }
    if !dirs.is_empty() {
        let mut args = vec!["clean", "-f", "-d", "--"];
        args.extend(dirs);
        checked(root, GitMode::Mutate, &args)?;
    }
    Ok(())
}

/* -------------------------------- committing ------------------------------ */

/// `commit --cleanup=whitespace [--amend] (-F <tmp> | --no-edit)` → the new HEAD.
/// The message always travels as a file (see `run::message_file`); `None`
/// means "keep what git has" — a merge's prepared message, or an amend that
/// changes only the content.
pub(super) fn commit(root: &Path, message: Option<&str>, amend: bool) -> GitResult<String> {
    // `whitespace`, not `strip`: a commit message in a markdown-first app may
    // well begin a line with `#`, and strip would silently drop it.
    let mut args = vec!["commit", "--cleanup=whitespace"];
    if amend {
        args.push("--amend");
    }
    let file;
    let file_path;
    match message {
        None => args.push("--no-edit"),
        Some(m) if m.trim().is_empty() => {
            return Err(GitError::InvalidArg("empty commit message".into()));
        }
        Some(m) => {
            file = message_file(m)?;
            file_path = file.to_string_lossy().into_owned();
            args.extend(["-F", file_path.as_str()]);
        }
    }
    checked(root, GitMode::Mutate, &args)?;
    head_sha(root)?.ok_or_else(|| GitError::failed("no HEAD after commit"))
}

/* --------------------------------- branches ------------------------------- */

pub(super) fn switch(root: &Path, name: &str, track_remote: Option<&str>) -> GitResult<()> {
    let name = safe_arg(name)?;
    match track_remote {
        Some(remote) => {
            let upstream = format!("{}/{name}", safe_arg(remote)?);
            checked(
                root,
                GitMode::Mutate,
                &["switch", "-c", name, "--track", &upstream],
            )?;
        }
        None => {
            checked(root, GitMode::Mutate, &["switch", name])?;
        }
    }
    Ok(())
}

pub(super) fn create_branch(
    root: &Path,
    name: &str,
    start_point: Option<&str>,
    switch_to: bool,
) -> GitResult<()> {
    let name = safe_arg(name)?;
    // git's own ref grammar is the authority; a name it refuses is a caller
    // bug (core/git/refs.ts validates first), not a failure to report.
    let check = run_git_with(
        Some(root),
        GitMode::Read,
        &["check-ref-format", "--branch", name],
    )?;
    if !check.ok {
        return Err(GitError::InvalidArg(format!("invalid branch name: {name}")));
    }
    let mut args = if switch_to {
        vec!["switch", "-c", name]
    } else {
        vec!["branch", name]
    };
    if let Some(start) = start_point {
        args.push(safe_arg(start)?);
    }
    checked(root, GitMode::Mutate, &args)?;
    Ok(())
}

pub(super) fn delete_branch(root: &Path, name: &str, force: bool) -> GitResult<()> {
    let name = safe_arg(name)?;
    let flag = if force { "-D" } else { "-d" };
    checked(root, GitMode::Mutate, &["branch", flag, name])?;
    Ok(())
}

/* --------------------------------- merging -------------------------------- */

/// git's words for "I did not even start" — a non-zero exit with these is a
/// refusal even if the tree happens to hold unmerged paths from before.
fn is_merge_refusal(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("not possible because you have unmerged files")
        || lower.contains("you have not concluded your merge")
        || lower.contains("would be overwritten")
        || lower.contains("refusing to merge unrelated histories")
        || lower.contains("not something we can merge")
        || lower.contains("cannot be used as a starting point")
}

/// Read a finished `merge` / `pull` into an outcome. `Some` when the merge
/// ran (including stopping on conflicts — the unmerged paths come from
/// status); `None` when git refused, and the caller reports its stderr.
pub(super) fn merge_outcome(root: &Path, out: &GitOutput) -> GitResult<Option<GitMergeOutcome>> {
    let head = head_sha(root)?.unwrap_or_default();
    if out.ok {
        let lower = out.stdout.to_lowercase();
        let outcome =
            if lower.contains("already up to date") || lower.contains("already up-to-date") {
                GitMergeResult::UpToDate
            } else if lower.contains("fast-forward") {
                GitMergeResult::FastForward
            } else {
                GitMergeResult::Merged
            };
        return Ok(Some(GitMergeOutcome {
            outcome,
            head,
            conflicted: Vec::new(),
        }));
    }
    if is_merge_refusal(&out.stderr) {
        return Ok(None);
    }
    let conflicted: Vec<String> = read_status(root)?
        .entries
        .into_iter()
        .filter(|e| e.kind == GitStatusEntryKind::Unmerged)
        .map(|e| e.path)
        .collect();
    if conflicted.is_empty() {
        return Ok(None);
    }
    Ok(Some(GitMergeOutcome {
        outcome: GitMergeResult::Conflicts,
        head,
        conflicted,
    }))
}

/// The error for a refused merge: git's stderr, or its stdout when it only
/// spoke there.
pub(super) fn merge_failure(root: &Path, out: &GitOutput) -> GitError {
    let text = if out.stderr.is_empty() {
        out.stdout.trim()
    } else {
        out.stderr.as_str()
    };
    super::classify(text, root)
}

pub(super) fn merge(
    root: &Path,
    target: &str,
    no_ff: bool,
    allow_unrelated: bool,
) -> GitResult<GitMergeOutcome> {
    let target = safe_arg(target)?;
    let mut args = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    if allow_unrelated {
        // Only the connect flow asks: a repository created on GitHub / Gitea
        // with a README shares no commit with the workspace.
        args.push("--allow-unrelated-histories");
    }
    args.push(target);
    let out = run_git_with(Some(root), GitMode::Mutate, &args)?;
    match merge_outcome(root, &out)? {
        Some(outcome) => Ok(outcome),
        None => Err(merge_failure(root, &out)),
    }
}

pub(super) fn merge_abort(root: &Path) -> GitResult<()> {
    checked(root, GitMode::Mutate, &["merge", "--abort"])?;
    Ok(())
}

/* -------------------------------- commands -------------------------------- */

/// `add -A -- <rels>`: stages modifications, additions and deletions alike.
#[tauri::command]
pub async fn git_stage(root: String, rels: Vec<String>) -> GitResult<()> {
    blocking(move || stage(Path::new(&root), &rels)).await
}

/// `restore --staged -- <rels>` (`rm --cached` on an unborn branch).
#[tauri::command]
pub async fn git_unstage(root: String, rels: Vec<String>) -> GitResult<()> {
    blocking(move || unstage(Path::new(&root), &rels)).await
}

/// Restore `tracked` from the index (staged changes stay) and delete
/// `untracked`. Irreversible — the caller confirms first.
#[tauri::command]
pub async fn git_discard(
    root: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> GitResult<()> {
    blocking(move || discard(Path::new(&root), &tracked, &untracked)).await
}

/// Commit the index; resolves with the new sha. `message` null = `--no-edit`;
/// an empty string is `GIT_INVALID_ARG`.
#[tauri::command]
pub async fn git_commit(root: String, message: Option<String>, amend: bool) -> GitResult<String> {
    blocking(move || commit(Path::new(&root), message.as_deref(), amend)).await
}

/// `switch <name>`, or with `track_remote` create a local branch tracking
/// `<track_remote>/<name>` and switch to it.
#[tauri::command]
pub async fn git_switch(root: String, name: String, track_remote: Option<String>) -> GitResult<()> {
    blocking(move || switch(Path::new(&root), &name, track_remote.as_deref())).await
}

/// `switch -c <name> [<start_point>]` or `branch <name> [<start_point>]`.
#[tauri::command]
pub async fn git_create_branch(
    root: String,
    name: String,
    start_point: Option<String>,
    switch_to: bool,
) -> GitResult<()> {
    blocking(move || create_branch(Path::new(&root), &name, start_point.as_deref(), switch_to))
        .await
}

/// `branch -d <name>` (`-D` with `force`).
#[tauri::command]
pub async fn git_delete_branch(root: String, name: String, force: bool) -> GitResult<()> {
    blocking(move || delete_branch(Path::new(&root), &name, force)).await
}

/// `merge --no-edit [--no-ff] [--allow-unrelated-histories] <target>` into
/// the current branch.
#[tauri::command]
pub async fn git_merge(
    root: String,
    target: String,
    no_ff: bool,
    allow_unrelated: Option<bool>,
) -> GitResult<GitMergeOutcome> {
    blocking(move || {
        merge(
            Path::new(&root),
            &target,
            no_ff,
            allow_unrelated.unwrap_or(false),
        )
    })
    .await
}

/// `merge --abort`.
#[tauri::command]
pub async fn git_merge_abort(root: String) -> GitResult<()> {
    blocking(move || merge_abort(Path::new(&root))).await
}

#[cfg(test)]
mod tests {
    use super::super::status::{status, GitRepoState};
    use super::super::testutil::{
        git_ok, git_out, have_git, head_of, init_repo, make_conflict, temp_repo, write,
    };
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn entry_xy(root: &Path, path: &str) -> Option<(String, String)> {
        status(root)
            .unwrap()
            .entries
            .into_iter()
            .find(|e| e.path == path)
            .map(|e| (e.index, e.worktree))
    }

    #[test]
    fn real_stage_and_unstage_round_trip() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        write(&root, "a.ts", "changed\n");
        write(&root, "new.ts", "new\n");
        stage(&root, &v(&["a.ts", "new.ts"])).unwrap();
        assert_eq!(entry_xy(&root, "a.ts"), Some(("M".into(), ".".into())));
        assert_eq!(entry_xy(&root, "new.ts"), Some(("A".into(), ".".into())));
        unstage(&root, &v(&["a.ts", "new.ts"])).unwrap();
        assert_eq!(entry_xy(&root, "a.ts"), Some((".".into(), "M".into())));
        assert_eq!(entry_xy(&root, "new.ts"), Some(("?".into(), "?".into())));
        // A deletion stages through `add -A` too.
        std::fs::remove_file(root.join("a.ts")).unwrap();
        stage(&root, &v(&["a.ts"])).unwrap();
        assert_eq!(entry_xy(&root, "a.ts"), Some(("D".into(), ".".into())));
        // Empty lists are no-ops; escaping paths are caller bugs.
        stage(&root, &[]).unwrap();
        unstage(&root, &[]).unwrap();
        assert!(matches!(
            stage(&root, &v(&["../x"])),
            Err(GitError::InvalidArg(_))
        ));
        assert!(matches!(
            stage(&root, &v(&["--all"])),
            Err(GitError::InvalidArg(_))
        ));
    }

    #[test]
    fn real_unstage_in_an_unborn_repo_forgets_from_the_index() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        write(root, "x.md", "x\n");
        stage(root, &v(&["x.md"])).unwrap();
        assert_eq!(entry_xy(root, "x.md"), Some(("A".into(), ".".into())));
        unstage(root, &v(&["x.md"])).unwrap();
        assert_eq!(entry_xy(root, "x.md"), Some(("?".into(), "?".into())));
        assert!(root.join("x.md").exists(), "the file itself stays");
    }

    #[test]
    fn real_discard_tracked_untracked_file_and_untracked_dir() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        write(&root, "a.ts", "changed\n");
        write(&root, "loose.md", "x\n");
        write(&root, "dir/inner.md", "x\n");
        write(&root, "keep.md", "keep\n");
        discard(&root, &v(&["a.ts"]), &v(&["loose.md", "dir/"])).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.ts")).unwrap(),
            "export const a = 1;\n"
        );
        assert!(!root.join("loose.md").exists());
        assert!(!root.join("dir").exists());
        assert!(root.join("keep.md").exists(), "only the named paths go");
        // Nothing to do is fine.
        discard(&root, &[], &[]).unwrap();
        // A deleted tracked file comes back.
        std::fs::remove_file(root.join("a.ts")).unwrap();
        discard(&root, &v(&["a.ts"]), &[]).unwrap();
        assert!(root.join("a.ts").exists());
    }

    #[test]
    fn real_discard_keeps_the_staged_version_of_a_new_or_renamed_file() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        // Staged as new, then edited: `AM`. HEAD has no such file, so a
        // restore from HEAD would delete it; discard goes back to the index.
        write(&root, "new.md", "staged\n");
        stage(&root, &v(&["new.md"])).unwrap();
        write(&root, "new.md", "staged\nthen edited\n");
        assert_eq!(entry_xy(&root, "new.md"), Some(("A".into(), "M".into())));
        discard(&root, &v(&["new.md"]), &[]).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("new.md")).unwrap(),
            "staged\n",
            "the staged copy survives"
        );
        assert_eq!(entry_xy(&root, "new.md"), Some(("A".into(), ".".into())));

        // Staged as a rename, then edited: `RM` under the new name.
        git_ok(&root, &["mv", "a.ts", "b.ts"]);
        write(
            &root,
            "b.ts",
            "export const a = 1;\n// edited after the rename\n",
        );
        assert_eq!(entry_xy(&root, "b.ts"), Some(("R".into(), "M".into())));
        discard(&root, &v(&["b.ts"]), &[]).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("b.ts")).unwrap(),
            "export const a = 1;\n"
        );
        assert_eq!(entry_xy(&root, "b.ts"), Some(("R".into(), ".".into())));
        assert!(
            !root.join("a.ts").exists(),
            "the rename itself stays staged"
        );

        // Partly staged (`MM`): only the unstaged half goes.
        write(&root, "c.md", "base\n");
        stage(&root, &v(&["c.md"])).unwrap();
        git_ok(&root, &["commit", "-q", "-m", "c"]);
        write(&root, "c.md", "base\nstaged line\n");
        stage(&root, &v(&["c.md"])).unwrap();
        write(&root, "c.md", "base\nstaged line\nunstaged line\n");
        assert_eq!(entry_xy(&root, "c.md"), Some(("M".into(), "M".into())));
        discard(&root, &v(&["c.md"]), &[]).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("c.md")).unwrap(),
            "base\nstaged line\n"
        );
        assert_eq!(entry_xy(&root, "c.md"), Some(("M".into(), ".".into())));
    }

    #[test]
    fn real_discard_works_on_an_unborn_branch() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        write(root, "x.md", "x\n");
        stage(root, &v(&["x.md"])).unwrap();
        write(root, "x.md", "x\ny\n");
        discard(root, &v(&["x.md"]), &[]).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("x.md")).unwrap(), "x\n");
    }

    #[test]
    fn real_commit_multi_line_leading_dash_amend_and_no_edit() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        write(&root, "a.ts", "2\n");
        stage(&root, &v(&["a.ts"])).unwrap();
        let msg = "- first line starts with a dash\n\nSecond paragraph.\n\n\n\nThird after blank run.  \n";
        let sha = commit(&root, Some(msg), false).unwrap();
        assert_eq!(sha, head_of(&root));
        let stored = git_out(&root, &["log", "-1", "--format=%B"]);
        assert_eq!(
            stored,
            "- first line starts with a dash\n\nSecond paragraph.\n\nThird after blank run."
        );

        // Amend with a new message.
        write(&root, "a.ts", "3\n");
        stage(&root, &v(&["a.ts"])).unwrap();
        let amended = commit(&root, Some("amended subject"), true).unwrap();
        assert_ne!(amended, sha);
        assert_eq!(
            git_out(&root, &["log", "-1", "--format=%s"]),
            "amended subject"
        );
        assert_eq!(git_out(&root, &["rev-list", "--count", "HEAD"]), "2");

        // Amend keeping the message.
        write(&root, "a.ts", "4\n");
        stage(&root, &v(&["a.ts"])).unwrap();
        commit(&root, None, true).unwrap();
        assert_eq!(
            git_out(&root, &["log", "-1", "--format=%s"]),
            "amended subject"
        );

        // Empty and whitespace-only messages are caller bugs; nothing staged
        // is git's refusal.
        assert!(matches!(
            commit(&root, Some(""), false),
            Err(GitError::InvalidArg(_))
        ));
        assert!(matches!(
            commit(&root, Some("  \n"), false),
            Err(GitError::InvalidArg(_))
        ));
        assert!(matches!(
            commit(&root, Some("nothing staged"), false),
            Err(GitError::Failed { .. })
        ));
    }

    #[test]
    fn real_switch_create_and_delete_with_unmerged_refusal_and_force() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        create_branch(&root, "feat/one", None, false).unwrap();
        assert_eq!(git_out(&root, &["symbolic-ref", "--short", "HEAD"]), "main");
        create_branch(&root, "feat/two", Some("main"), true).unwrap();
        assert_eq!(
            git_out(&root, &["symbolic-ref", "--short", "HEAD"]),
            "feat/two"
        );
        write(&root, "two.ts", "2\n");
        stage(&root, &v(&["two.ts"])).unwrap();
        commit(&root, Some("two"), false).unwrap();
        switch(&root, "main", None).unwrap();
        assert_eq!(git_out(&root, &["symbolic-ref", "--short", "HEAD"]), "main");

        // A name git's grammar refuses is a caller bug.
        assert!(matches!(
            create_branch(&root, "bad..name", None, false),
            Err(GitError::InvalidArg(_))
        ));
        assert!(matches!(
            create_branch(&root, "-x", None, false),
            Err(GitError::InvalidArg(_))
        ));
        // Creating an existing branch is git's refusal.
        assert!(matches!(
            create_branch(&root, "feat/one", None, false),
            Err(GitError::Failed { .. })
        ));

        // Unmerged: refused without force, gone with it.
        match delete_branch(&root, "feat/two", false) {
            Err(GitError::Failed { stderr }) => {
                assert!(stderr.contains("not fully merged"), "{stderr}")
            }
            other => panic!("expected refusal, got {other:?}"),
        }
        delete_branch(&root, "feat/two", true).unwrap();
        delete_branch(&root, "feat/one", false).unwrap();
        let out = run_git_with(Some(&root), GitMode::Read, &["branch", "--list"]).unwrap();
        assert_eq!(out.stdout.trim(), "* main");

        // A switch that would clobber a dirty file is git's refusal.
        create_branch(&root, "feat/three", None, true).unwrap();
        write(&root, "a.ts", "on three\n");
        stage(&root, &v(&["a.ts"])).unwrap();
        commit(&root, Some("three"), false).unwrap();
        switch(&root, "main", None).unwrap();
        write(&root, "a.ts", "dirty on main\n");
        match switch(&root, "feat/three", None) {
            Err(GitError::Failed { stderr }) => assert!(stderr.contains("overwritten"), "{stderr}"),
            other => panic!("expected refusal, got {other:?}"),
        }
    }

    #[test]
    fn real_merge_fast_forward_true_merge_and_up_to_date() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        let base = head_of(&root);
        create_branch(&root, "feat/ff", None, true).unwrap();
        write(&root, "ff.ts", "ff\n");
        stage(&root, &v(&["ff.ts"])).unwrap();
        let tip = commit(&root, Some("ff"), false).unwrap();
        switch(&root, "main", None).unwrap();

        let ff = merge(&root, "feat/ff", false, false).unwrap();
        assert_eq!(ff.outcome, GitMergeResult::FastForward);
        assert_eq!(ff.head, tip);
        assert!(ff.conflicted.is_empty());

        let again = merge(&root, "feat/ff", false, false).unwrap();
        assert_eq!(again.outcome, GitMergeResult::UpToDate);
        assert_eq!(again.head, tip);

        // A true merge: --no-ff of a branch off the old base.
        git_ok(&root, &["branch", "feat/nf", &base]);
        switch(&root, "feat/nf", None).unwrap();
        write(&root, "nf.ts", "nf\n");
        stage(&root, &v(&["nf.ts"])).unwrap();
        commit(&root, Some("nf"), false).unwrap();
        switch(&root, "main", None).unwrap();
        let merged = merge(&root, "feat/nf", true, false).unwrap();
        assert_eq!(merged.outcome, GitMergeResult::Merged);
        assert_eq!(merged.head, head_of(&root));
        assert_eq!(
            git_out(&root, &["rev-list", "--count", "--merges", "HEAD"]),
            "1"
        );
        assert!(matches!(
            merge(&root, "-x", false, false),
            Err(GitError::InvalidArg(_))
        ));
        assert!(matches!(
            merge(&root, "no/such", false, false),
            Err(GitError::Failed { .. })
        ));
    }

    #[test]
    fn real_merge_conflicts_are_an_outcome_continue_with_none_and_abort() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        let other = make_conflict(&root);
        let before = head_of(&root);

        let c = merge(&root, other, false, false).unwrap();
        assert_eq!(c.outcome, GitMergeResult::Conflicts);
        assert_eq!(c.conflicted, vec!["a.ts".to_string()]);
        assert_eq!(c.head, before, "HEAD does not move on a conflict");
        assert_eq!(status(&root).unwrap().state, GitRepoState::Merging);

        merge_abort(&root).unwrap();
        assert_eq!(status(&root).unwrap().state, GitRepoState::Clean);
        assert_eq!(head_of(&root), before);

        // Again, resolved by hand and continued with git's prepared message.
        let c2 = merge(&root, other, false, false).unwrap();
        assert_eq!(c2.outcome, GitMergeResult::Conflicts);
        write(&root, "a.ts", "export const a = 'both';\n");
        stage(&root, &v(&["a.ts"])).unwrap();
        let sha = commit(&root, None, false).unwrap();
        assert_ne!(sha, before);
        assert_eq!(status(&root).unwrap().state, GitRepoState::Clean);
        assert!(git_out(&root, &["log", "-1", "--format=%s"]).starts_with("Merge branch"));
        assert_eq!(
            git_out(&root, &["log", "-1", "--format=%P"])
                .split(' ')
                .count(),
            2
        );
    }

    #[test]
    fn real_merge_refused_by_a_dirty_tree_is_a_failure_not_an_outcome() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        let other = make_conflict(&root);
        write(&root, "a.ts", "uncommitted\n");
        match merge(&root, other, false, false) {
            Err(GitError::Failed { stderr }) => assert!(stderr.contains("overwritten"), "{stderr}"),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(status(&root).unwrap().state, GitRepoState::Clean);
    }
}
