//! Remotes — the "where does this repository upload to" half of the git tab:
//! list them, add one, change its address, remove it, and compare HEAD with a
//! remote-tracking branch after a fetch (`git_compare_ref`), which is how the
//! connect flow tells an empty GitHub repository from one created with a
//! README. Local config edits only; talking to the remote is `net`'s job.
//!
//! Every name and URL passes `safe_arg` (git validates the name itself and
//! its refusal comes back as `GIT_FAILED` with git's words).

use super::run::{checked, run_git_with, safe_arg, GitMode};
use super::{blocking, head_sha, GitResult};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    /// The fetch URL (`remote.<name>.url`); empty when only a pushurl is set.
    pub url: String,
    /// `remote.<name>.pushurl`, when it differs from `url`.
    pub push_url: Option<String>,
}

/// How HEAD stands against another ref (`git_compare_ref`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitRefRelation {
    /// The other ref does not exist (the remote has no such branch).
    Missing,
    /// HEAD is unborn: there is nothing of ours to compare.
    Unborn,
    /// Same commit.
    Same,
    /// The other ref is behind HEAD: pushing is a fast-forward.
    Ahead,
    /// HEAD is behind the other ref: merging it is a fast-forward.
    Behind,
    /// Both moved since a common commit.
    Diverged,
    /// No common commit at all (a repository created with a README).
    Unrelated,
}

/// Parse `config --get-regexp ^remote\..*\.(url|pushurl)$` output, keeping
/// the remotes in config order. Remote names may contain dots; the key is
/// always the last segment.
fn parse_remotes(stdout: &str) -> Vec<GitRemote> {
    let mut remotes: Vec<GitRemote> = Vec::new();
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("remote.") else {
            continue;
        };
        let Some((name, field)) = rest.rsplit_once('.') else {
            continue;
        };
        let idx = match remotes.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                remotes.push(GitRemote {
                    name: name.to_string(),
                    url: String::new(),
                    push_url: None,
                });
                remotes.len() - 1
            }
        };
        let r = &mut remotes[idx];
        match field {
            "url" if r.url.is_empty() => r.url = value.to_string(),
            "pushurl" if r.push_url.is_none() => r.push_url = Some(value.to_string()),
            _ => {}
        }
    }
    for r in &mut remotes {
        if r.push_url.as_deref() == Some(r.url.as_str()) {
            r.push_url = None;
        }
    }
    remotes
}

pub(super) fn remotes(root: &Path) -> GitResult<Vec<GitRemote>> {
    let out = run_git_with(
        Some(root),
        GitMode::Read,
        &["config", "--get-regexp", r"^remote\..*\.(url|pushurl)$"],
    )?;
    // Exit 1 with nothing on stdout = no remotes at all.
    if !out.ok && out.stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(parse_remotes(&out.stdout))
}

pub(super) fn remote_add(root: &Path, name: &str, url: &str) -> GitResult<()> {
    checked(
        root,
        GitMode::Mutate,
        &["remote", "add", safe_arg(name)?, safe_arg(url)?],
    )?;
    Ok(())
}

pub(super) fn remote_set_url(root: &Path, name: &str, url: &str) -> GitResult<()> {
    checked(
        root,
        GitMode::Mutate,
        &["remote", "set-url", safe_arg(name)?, safe_arg(url)?],
    )?;
    Ok(())
}

pub(super) fn remote_remove(root: &Path, name: &str) -> GitResult<()> {
    checked(
        root,
        GitMode::Mutate,
        &["remote", "remove", safe_arg(name)?],
    )?;
    Ok(())
}

/// The commit `rev` names, or None when it names nothing.
fn commit_of(root: &Path, rev: &str) -> GitResult<Option<String>> {
    let spec = format!("{rev}^{{commit}}");
    let out = run_git_with(
        Some(root),
        GitMode::Read,
        &["rev-parse", "--verify", "--quiet", &spec],
    )?;
    let sha = out.stdout.trim();
    Ok((out.ok && !sha.is_empty()).then(|| sha.to_string()))
}

fn is_ancestor(root: &Path, a: &str, b: &str) -> GitResult<bool> {
    let out = run_git_with(
        Some(root),
        GitMode::Read,
        &["merge-base", "--is-ancestor", a, b],
    )?;
    Ok(out.ok)
}

pub(super) fn compare_ref(root: &Path, other: &str) -> GitResult<GitRefRelation> {
    let other = safe_arg(other)?;
    let Some(theirs) = commit_of(root, other)? else {
        return Ok(GitRefRelation::Missing);
    };
    let Some(ours) = head_sha(root)? else {
        return Ok(GitRefRelation::Unborn);
    };
    if ours == theirs {
        return Ok(GitRefRelation::Same);
    }
    if is_ancestor(root, &theirs, &ours)? {
        return Ok(GitRefRelation::Ahead);
    }
    if is_ancestor(root, &ours, &theirs)? {
        return Ok(GitRefRelation::Behind);
    }
    let base = run_git_with(Some(root), GitMode::Read, &["merge-base", &ours, &theirs])?;
    Ok(if base.ok && !base.stdout.trim().is_empty() {
        GitRefRelation::Diverged
    } else {
        GitRefRelation::Unrelated
    })
}

/* -------------------------------- commands -------------------------------- */

/// Every remote with its URL(s), in config order.
#[tauri::command]
pub async fn git_remotes(root: String) -> GitResult<Vec<GitRemote>> {
    blocking(move || remotes(Path::new(&root))).await
}

/// `remote add <name> <url>`.
#[tauri::command]
pub async fn git_remote_add(root: String, name: String, url: String) -> GitResult<()> {
    blocking(move || remote_add(Path::new(&root), &name, &url)).await
}

/// `remote set-url <name> <url>`.
#[tauri::command]
pub async fn git_remote_set_url(root: String, name: String, url: String) -> GitResult<()> {
    blocking(move || remote_set_url(Path::new(&root), &name, &url)).await
}

/// `remote remove <name>` (its remote-tracking branches go with it).
#[tauri::command]
pub async fn git_remote_remove(root: String, name: String) -> GitResult<()> {
    blocking(move || remote_remove(Path::new(&root), &name)).await
}

/// How HEAD stands against `other` (usually `origin/main` after a fetch).
#[tauri::command]
pub async fn git_compare_ref(root: String, other: String) -> GitResult<GitRefRelation> {
    blocking(move || compare_ref(Path::new(&root), &other)).await
}

#[cfg(test)]
mod tests {
    use super::super::ops::{merge, GitMergeResult};
    use super::super::testutil::{
        clone_of, git_ok, have_git, init_repo, temp_repo, temp_repo_with_remote, write,
    };
    use super::super::GitError;
    use super::*;

    #[test]
    fn parse_keeps_order_dotted_names_and_drops_same_pushurl() {
        let out = "remote.origin.url https://github.com/a/b.git\n\
                   remote.my.fork.url git@host:me/b.git\n\
                   remote.my.fork.pushurl git@host:me/b-push.git\n\
                   remote.origin.pushurl https://github.com/a/b.git\n";
        assert_eq!(
            parse_remotes(out),
            vec![
                GitRemote {
                    name: "origin".into(),
                    url: "https://github.com/a/b.git".into(),
                    push_url: None,
                },
                GitRemote {
                    name: "my.fork".into(),
                    url: "git@host:me/b.git".into(),
                    push_url: Some("git@host:me/b-push.git".into()),
                },
            ]
        );
        assert!(parse_remotes("").is_empty());
    }

    #[test]
    fn real_add_set_url_remove_round_trip() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        assert!(remotes(&root).unwrap().is_empty());
        remote_add(&root, "origin", "https://example.com/a/b.git").unwrap();
        remote_add(&root, "backup", "C:/somewhere/else.git").unwrap();
        let names: Vec<String> = remotes(&root)
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(names, vec!["origin", "backup"]);
        // A duplicate is git's refusal, carried as GIT_FAILED.
        assert!(matches!(
            remote_add(&root, "origin", "https://example.com/x.git"),
            Err(GitError::Failed { .. })
        ));
        // Option-shaped input never reaches git.
        assert!(matches!(
            remote_add(&root, "x", "--upload-pack=evil"),
            Err(GitError::InvalidArg(_))
        ));
        remote_set_url(&root, "origin", "https://example.com/a/c.git").unwrap();
        assert_eq!(
            remotes(&root).unwrap()[0].url,
            "https://example.com/a/c.git"
        );
        remote_remove(&root, "backup").unwrap();
        assert_eq!(remotes(&root).unwrap().len(), 1);
        assert!(matches!(
            remote_remove(&root, "nope"),
            Err(GitError::Failed { .. })
        ));
    }

    #[test]
    fn real_compare_ref_covers_each_relation() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (guard, root, remote) = temp_repo_with_remote();
        assert_eq!(
            compare_ref(&root, "origin/nope").unwrap(),
            GitRefRelation::Missing
        );
        assert_eq!(
            compare_ref(&root, "origin/main").unwrap(),
            GitRefRelation::Same
        );

        write(&root, "b.ts", "b\n");
        git_ok(&root, &["add", "b.ts"]);
        git_ok(&root, &["commit", "-m", "ours"]);
        assert_eq!(
            compare_ref(&root, "origin/main").unwrap(),
            GitRefRelation::Ahead
        );

        let other = guard.path().join("other");
        clone_of(&remote, &other);
        write(&other, "c.ts", "c\n");
        git_ok(&other, &["add", "c.ts"]);
        git_ok(&other, &["commit", "-m", "theirs"]);
        git_ok(&other, &["push", "origin", "main"]);
        git_ok(&root, &["fetch", "origin"]);
        assert_eq!(
            compare_ref(&root, "origin/main").unwrap(),
            GitRefRelation::Diverged
        );
        assert_eq!(
            compare_ref(&other, "HEAD~1").unwrap(),
            GitRefRelation::Ahead
        );
        git_ok(&other, &["reset", "--hard", "HEAD~1"]);
        assert_eq!(
            compare_ref(&other, "origin/main").unwrap(),
            GitRefRelation::Behind
        );

        // A repository made on the server with its own first commit.
        let fresh = guard.path().join("fresh");
        init_repo(&fresh);
        write(&fresh, "README.md", "hi\n");
        git_ok(&fresh, &["add", "README.md"]);
        git_ok(&fresh, &["commit", "-m", "Initial commit"]);
        git_ok(&root, &["remote", "add", "gh", &fresh.to_string_lossy()]);
        git_ok(&root, &["fetch", "gh"]);
        assert_eq!(
            compare_ref(&root, "gh/main").unwrap(),
            GitRefRelation::Unrelated
        );
        // Plain merge refuses; the connect flow's opt-in brings the README in.
        assert!(merge(&root, "gh/main", false, false).is_err());
        let merged = merge(&root, "gh/main", false, true).unwrap();
        assert_eq!(merged.outcome, GitMergeResult::Merged);
        assert!(root.join("README.md").exists());
        assert_eq!(
            compare_ref(&root, "gh/main").unwrap(),
            GitRefRelation::Ahead
        );

        let unborn = guard.path().join("unborn");
        init_repo(&unborn);
        git_ok(&unborn, &["remote", "add", "gh", &fresh.to_string_lossy()]);
        git_ok(&unborn, &["fetch", "gh"]);
        assert_eq!(
            compare_ref(&unborn, "gh/main").unwrap(),
            GitRefRelation::Unborn
        );
        // A workspace with no commits yet simply takes the server's files.
        merge(&unborn, "gh/main", false, false).unwrap();
        assert!(unborn.join("README.md").exists());
        assert_eq!(
            compare_ref(&unborn, "gh/main").unwrap(),
            GitRefRelation::Same
        );
    }
}
