//! Refs and history, read-only: `git_branches`, `git_log`, `git_commit_files`,
//! `git_diff_names`, `git_ahead_behind`.
//!
//! `for-each-ref` and `log` take a custom `--format` whose fields are joined
//! with the ASCII unit separator (0x1f) and whose records end with the record
//! separator (0x1e) — a commit body holds newlines, a subject may hold
//! anything printable, and neither holds those two bytes.

use super::run::{checked, safe_arg, GitMode};
use super::{blocking, head_sha, GitResult};
use serde::Serialize;
use std::path::Path;

const UNIT: char = '\u{1f}';
const RECORD: char = '\u{1e}';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitBranchKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// `feat/x` (local) or `origin/feat/x` (remote).
    pub name: String,
    pub kind: GitBranchKind,
    pub head: String,
    /// Checked out in THIS checkout (`%(HEAD)`).
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// An upstream is configured but no longer exists on the remote.
    pub gone: bool,
    /// Committer date, ISO 8601 (`%(committerdate:iso-strict)`).
    pub committed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    /// Author date, ISO 8601.
    pub at: String,
    pub subject: String,
    /// `%D` split on `, `: `HEAD -> main`, `origin/main`, `tag: v1`, … —
    /// empty when the commit is undecorated.
    pub refs: Vec<String>,
    pub body: String,
}

/// One `--name-status` row: `status` is git's letter (A M D R C T U …), a
/// rename/copy score stripped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDelta {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

/* -------------------------------- branches -------------------------------- */

/// `%(upstream:track)` → `(ahead, behind, gone)`. Empty means in sync (or no
/// upstream — the caller knows which); `[gone]` means the upstream vanished.
pub(super) fn parse_track(track: &str) -> (Option<u32>, Option<u32>, bool) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    if inner == "gone" {
        return (None, None, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (Some(ahead), Some(behind), false)
}

/// `refs/heads/x` → local `x`; `refs/remotes/o/x` → remote `o/x`; a remote's
/// symbolic `HEAD` and anything else → `None`.
fn branch_kind(refname: &str) -> Option<(GitBranchKind, &str)> {
    if let Some(n) = refname.strip_prefix("refs/heads/") {
        return Some((GitBranchKind::Local, n));
    }
    let n = refname.strip_prefix("refs/remotes/")?;
    (!n.ends_with("/HEAD")).then_some((GitBranchKind::Remote, n))
}

/// Parse the `for-each-ref` output of `BRANCH_FORMAT`. Drops the remotes'
/// symbolic `HEAD` (`refs/remotes/origin/HEAD`), which is not a branch.
pub(super) fn parse_branches(out: &str) -> Vec<GitBranch> {
    out.split(RECORD)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            if rec.trim().is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.split(UNIT).collect();
            if f.len() < 6 {
                return None;
            }
            let (kind, name) = branch_kind(f[0])?;
            let upstream = (!f[3].is_empty()).then(|| f[3].to_string());
            let (ahead, behind, gone) = if upstream.is_some() {
                parse_track(f[4])
            } else {
                (None, None, false)
            };
            Some(GitBranch {
                name: name.to_string(),
                kind,
                head: f[1].to_string(),
                current: f[2].trim() == "*",
                upstream,
                ahead,
                behind,
                gone,
                committed_at: f[5].trim().to_string(),
            })
        })
        .collect()
}

/// `%1f` / `%1e` are `for-each-ref`'s hex escapes for the separators.
const BRANCH_FORMAT: &str = "%(refname)%1f%(objectname)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:iso-strict)%1e";

pub(super) fn branches(root: &Path) -> GitResult<Vec<GitBranch>> {
    let format = format!("--format={BRANCH_FORMAT}");
    let out = checked(
        root,
        GitMode::Read,
        &["for-each-ref", &format, "refs/heads", "refs/remotes"],
    )?;
    Ok(parse_branches(&out.stdout))
}

/* ---------------------------------- log ----------------------------------- */

/// `%x1f` / `%x1e` are `log --format`'s hex escapes. The body is last: it is
/// the only multi-line field.
const LOG_FORMAT: &str = "%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1f%b%x1e";

pub(super) fn parse_log(out: &str) -> Vec<GitCommit> {
    out.split(RECORD)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            if rec.trim().is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.split(UNIT).collect();
            if f.len() < 8 {
                return None;
            }
            Some(GitCommit {
                sha: f[0].to_string(),
                short: f[1].to_string(),
                parents: f[2].split_whitespace().map(str::to_string).collect(),
                author: f[3].to_string(),
                at: f[4].to_string(),
                subject: f[5].to_string(),
                refs: f[6]
                    .split(", ")
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .map(str::to_string)
                    .collect(),
                body: f[7].trim_end().to_string(),
            })
        })
        .collect()
}

/// git's ways of saying "there is no history yet".
fn is_unborn_log(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("does not have any commits yet")
        || lower.contains("bad default revision 'head'")
        || lower.contains("bad revision 'head'")
}

/// A page of `log`. With `all`, every branch, remote-tracking branch and tag
/// (plus a detached HEAD) in date order — the commit graph's view — and `rev`
/// is ignored. Not `--all`: that would drag in `refs/stash`. A repository
/// with no refs at all then logs nothing, successfully.
pub(super) fn log(
    root: &Path,
    rev: Option<&str>,
    max: u32,
    skip: u32,
    all: bool,
) -> GitResult<Vec<GitCommit>> {
    let format = format!("--format={LOG_FORMAT}");
    let count = format!("-n{}", max.clamp(1, 1000));
    let skip = format!("--skip={skip}");
    // `%D` honours `log.decorate=full`; pin the short names.
    let mut args = vec![
        "log",
        "--decorate=short",
        format.as_str(),
        count.as_str(),
        skip.as_str(),
    ];
    if all {
        args.extend(["--date-order", "--branches", "--remotes", "--tags"]);
        // A born HEAD may be detached on a commit no ref reaches.
        if head_sha(root)?.is_some() {
            args.push("HEAD");
        }
    } else if let Some(rev) = rev {
        args.push(safe_arg(rev)?);
    }
    args.push("--");
    let out = super::run::run_git_with(Some(root), GitMode::Read, &args)?;
    if !out.ok {
        if is_unborn_log(&out.stderr) {
            return Ok(Vec::new());
        }
        return Err(super::classify(&out.stderr, root));
    }
    Ok(parse_log(&out.stdout))
}

/* ------------------------------- name-status ------------------------------ */

/// Parse `--name-status -z` output: `<status>\0<path>\0`, with a rename or
/// copy (`R100`, `C75`) followed by two paths — source, then destination.
pub(super) fn parse_name_status(raw: &str) -> Vec<GitFileDelta> {
    let mut fields = raw.split('\0');
    let mut out = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let letter = status.chars().next().unwrap_or('M');
        let Some(first) = fields.next() else { break };
        if letter == 'R' || letter == 'C' {
            let Some(dest) = fields.next() else { break };
            out.push(GitFileDelta {
                path: dest.to_string(),
                orig_path: Some(first.to_string()),
                status: letter.to_string(),
            });
        } else {
            out.push(GitFileDelta {
                path: first.to_string(),
                orig_path: None,
                status: letter.to_string(),
            });
        }
    }
    out
}

/// The files one commit touched. A merge commit is compared with its FIRST
/// parent (what the branch received); a root commit with the empty tree.
pub(super) fn commit_files(root: &Path, sha: &str) -> GitResult<Vec<GitFileDelta>> {
    let sha = safe_arg(sha)?;
    let parent_spec = format!("{sha}^");
    let parent = super::git_line_opt(root, &["rev-parse", "--verify", "--quiet", &parent_spec])?;
    let out = match parent {
        Some(parent) => checked(
            root,
            GitMode::Read,
            &[
                "diff-tree",
                "-r",
                "-M",
                "--name-status",
                "-z",
                &parent,
                sha,
                "--",
            ],
        )?,
        None => checked(
            root,
            GitMode::Read,
            &[
                "diff-tree",
                "--no-commit-id",
                "-r",
                "--root",
                "-M",
                "--name-status",
                "-z",
                sha,
                "--",
            ],
        )?,
    };
    Ok(parse_name_status(&out.stdout))
}

/// The files differing between `from`'s merge base with `to` and `to`
/// (`from...to`) — "what this branch would bring in".
pub(super) fn diff_names(root: &Path, from: &str, to: &str) -> GitResult<Vec<GitFileDelta>> {
    let range = format!("{}...{}", safe_arg(from)?, safe_arg(to)?);
    let out = checked(
        root,
        GitMode::Read,
        &["diff", "--name-status", "-z", "-M", &range, "--"],
    )?;
    Ok(parse_name_status(&out.stdout))
}

/// `rev-list --left-right --count a...b`: commits only in `a` (ahead), only
/// in `b` (behind).
pub(super) fn ahead_behind(root: &Path, a: &str, b: &str) -> GitResult<GitAheadBehind> {
    let range = format!("{}...{}", safe_arg(a)?, safe_arg(b)?);
    let out = checked(
        root,
        GitMode::Read,
        &["rev-list", "--left-right", "--count", &range],
    )?;
    let mut nums = out
        .stdout
        .split_whitespace()
        .map(|n| n.parse::<u32>().unwrap_or(0));
    Ok(GitAheadBehind {
        ahead: nums.next().unwrap_or(0),
        behind: nums.next().unwrap_or(0),
    })
}

/* -------------------------------- commands -------------------------------- */

/// Local and remote branches with tracking info.
#[tauri::command]
pub async fn git_branches(root: String) -> GitResult<Vec<GitBranch>> {
    blocking(move || branches(Path::new(&root))).await
}

/// `max` commits reachable from `rev` (HEAD when null), skipping `skip`.
/// `all`: from every branch, remote branch and tag (+ HEAD) in date order
/// instead, `rev` ignored. `[]` on an unborn HEAD / a repo with no refs.
#[tauri::command]
pub async fn git_log(
    root: String,
    rev: Option<String>,
    max: u32,
    skip: u32,
    all: bool,
) -> GitResult<Vec<GitCommit>> {
    blocking(move || {
        let root = Path::new(&root);
        // An unborn HEAD has no log; asking git prints an error we would
        // only have to recognise, so check first when HEAD is what is asked.
        if !all && rev.is_none() && head_sha(root)?.is_none() {
            return Ok(Vec::new());
        }
        log(root, rev.as_deref(), max, skip, all)
    })
    .await
}

/// The files one commit touched (renames detected).
#[tauri::command]
pub async fn git_commit_files(root: String, sha: String) -> GitResult<Vec<GitFileDelta>> {
    blocking(move || commit_files(Path::new(&root), &sha)).await
}

/// The files differing between `from`'s merge base with `to` and `to`.
#[tauri::command]
pub async fn git_diff_names(
    root: String,
    from: String,
    to: String,
) -> GitResult<Vec<GitFileDelta>> {
    blocking(move || diff_names(Path::new(&root), &from, &to)).await
}

/// `rev-list --left-right --count a...b`.
#[tauri::command]
pub async fn git_ahead_behind(root: String, a: String, b: String) -> GitResult<GitAheadBehind> {
    blocking(move || ahead_behind(Path::new(&root), &a, &b)).await
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{
        git_ok, have_git, head_of, init_repo, temp_repo, temp_repo_with_remote, write,
    };
    use super::super::GitError;
    use super::*;

    #[test]
    fn track_field_parses_ahead_behind_gone_and_in_sync() {
        assert_eq!(
            parse_track("[ahead 1, behind 2]"),
            (Some(1), Some(2), false)
        );
        assert_eq!(parse_track("[ahead 3]"), (Some(3), Some(0), false));
        assert_eq!(parse_track("[behind 7]"), (Some(0), Some(7), false));
        assert_eq!(parse_track("[gone]"), (None, None, true));
        assert_eq!(parse_track(""), (Some(0), Some(0), false));
    }

    #[test]
    fn branch_records_parse_and_remote_head_is_dropped() {
        let out = [
            "refs/heads/main\u{1f}aaa\u{1f}*\u{1f}origin/main\u{1f}[ahead 1, behind 2]\u{1f}2026-09-24T10:00:00+02:00\u{1e}\n",
            "refs/heads/feat/x\u{1f}bbb\u{1f} \u{1f}\u{1f}\u{1f}2026-09-23T10:00:00+02:00\u{1e}\n",
            "refs/heads/old\u{1f}ccc\u{1f} \u{1f}origin/old\u{1f}[gone]\u{1f}2026-01-01T00:00:00Z\u{1e}\n",
            "refs/remotes/origin/HEAD\u{1f}aaa\u{1f} \u{1f}\u{1f}\u{1f}2026-09-24T10:00:00+02:00\u{1e}\n",
            "refs/remotes/origin/main\u{1f}aaa\u{1f} \u{1f}\u{1f}\u{1f}2026-09-24T10:00:00+02:00\u{1e}\n",
        ]
        .concat();
        let b = parse_branches(&out);
        assert_eq!(b.len(), 4, "{b:?}");
        assert_eq!(
            b[0],
            GitBranch {
                name: "main".into(),
                kind: GitBranchKind::Local,
                head: "aaa".into(),
                current: true,
                upstream: Some("origin/main".into()),
                ahead: Some(1),
                behind: Some(2),
                gone: false,
                committed_at: "2026-09-24T10:00:00+02:00".into(),
            }
        );
        assert_eq!(b[1].name, "feat/x");
        assert!(!b[1].current);
        assert_eq!(
            (b[1].upstream.as_deref(), b[1].ahead, b[1].behind),
            (None, None, None)
        );
        assert!(b[2].gone);
        assert_eq!((b[2].ahead, b[2].behind), (None, None));
        assert_eq!(b[3].name, "origin/main");
        assert_eq!(b[3].kind, GitBranchKind::Remote);
    }

    #[test]
    fn log_records_parse_with_multi_line_bodies_and_merge_parents() {
        let out = concat!(
            "s1\u{1f}s1s\u{1f}p1 p2\u{1f}Ann\u{1f}2026-09-24T10:00:00+02:00\u{1f}Merge x\u{1f}\u{1f}\u{1e}\n",
            "s2\u{1f}s2s\u{1f}p3\u{1f}Bob\u{1f}2026-09-23T10:00:00+02:00\u{1f}feat: y\u{1f}\u{1f}line one\n\nline three\n\u{1e}\n",
        );
        let c = parse_log(out);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["p1", "p2"]);
        assert_eq!(c[0].body, "");
        assert_eq!(c[1].subject, "feat: y");
        assert_eq!(c[1].body, "line one\n\nline three");
        assert_eq!(c[1].author, "Bob");
    }

    #[test]
    fn log_records_split_decorations_into_refs() {
        let out = concat!(
            "s1\u{1f}s1s\u{1f}p1\u{1f}Ann\u{1f}2026-09-24T10:00:00+02:00\u{1f}tip\u{1f}HEAD -> development, origin/development, tag: v0.10.1\u{1f}body\n\u{1e}\n",
            "s2\u{1f}s2s\u{1f}p2\u{1f}Ann\u{1f}2026-09-23T10:00:00+02:00\u{1f}plain\u{1f}\u{1f}\u{1e}\n",
        );
        let c = parse_log(out);
        assert_eq!(c.len(), 2);
        assert_eq!(
            c[0].refs,
            vec!["HEAD -> development", "origin/development", "tag: v0.10.1"]
        );
        assert_eq!(c[0].body, "body");
        assert_eq!(c[1].subject, "plain");
        assert!(c[1].refs.is_empty());
    }

    #[test]
    fn name_status_parses_plain_rows_and_renames() {
        let raw = "M\0a.ts\0A\0b.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0";
        let d = parse_name_status(raw);
        assert_eq!(d.len(), 4);
        assert_eq!((d[0].status.as_str(), d[0].path.as_str()), ("M", "a.ts"));
        assert_eq!(
            d[2],
            GitFileDelta {
                path: "new.ts".into(),
                orig_path: Some("old.ts".into()),
                status: "R".into()
            }
        );
        assert_eq!(d[3].status, "D");
        assert!(parse_name_status("").is_empty());
    }

    /* ---------------------- against a real git binary ---------------------- */

    #[test]
    fn real_branches_local_remote_and_tracking() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root, _remote) = temp_repo_with_remote();
        git_ok(&root, &["branch", "feat/x"]);
        write(&root, "a.ts", "2\n");
        git_ok(&root, &["commit", "-am", "second"]);

        let b = branches(&root).unwrap();
        let main = b.iter().find(|b| b.name == "main").expect("main");
        assert!(main.current);
        assert_eq!(main.kind, GitBranchKind::Local);
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert_eq!((main.ahead, main.behind), (Some(1), Some(0)));
        assert!(!main.gone);
        assert!(main.committed_at.starts_with("20"), "{}", main.committed_at);
        let feat = b.iter().find(|b| b.name == "feat/x").expect("feat/x");
        assert!(!feat.current);
        assert_eq!(feat.upstream, None);
        let remote = b
            .iter()
            .find(|b| b.name == "origin/main")
            .expect("origin/main");
        assert_eq!(remote.kind, GitBranchKind::Remote);
        assert!(!b.iter().any(|b| b.name.ends_with("/HEAD")));
    }

    #[test]
    fn real_log_pages_and_carries_the_body() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        for i in 2..=4 {
            write(&root, "a.ts", &format!("{i}\n"));
            git_ok(
                &root,
                &[
                    "commit",
                    "-am",
                    &format!("commit {i}"),
                    "-m",
                    "body line\n\nmore",
                ],
            );
        }
        let page1 = log(&root, None, 2, 0, false).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0].subject, "commit 4");
        assert_eq!(page1[0].body, "body line\n\nmore");
        assert_eq!(page1[0].sha, head_of(&root));
        assert_eq!(page1[0].short.len(), 7.min(page1[0].short.len()));
        assert_eq!(page1[0].parents.len(), 1);
        assert_eq!(page1[0].author, "Test");
        let page2 = log(&root, None, 2, 2, false).unwrap();
        assert_eq!(page2.len(), 2);
        assert_eq!(page2[1].subject, "first");
        assert!(page2[1].parents.is_empty(), "root commit has no parents");
        assert!(page2[1].body.is_empty());
        assert!(log(&root, None, 2, 4, false).unwrap().is_empty());
        // A rev other than HEAD.
        let from_second = log(&root, Some("HEAD~2"), 10, 0, false).unwrap();
        assert_eq!(from_second.len(), 2);
        assert!(matches!(
            log(&root, Some("-n"), 1, 0, false),
            Err(GitError::InvalidArg(_))
        ));
    }

    #[test]
    fn real_log_of_an_unborn_repo_is_empty() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        assert!(log(dir.path(), None, 10, 0, false).unwrap().is_empty());
        assert!(log(dir.path(), Some("HEAD"), 10, 0, false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn real_log_all_spans_every_branch_and_decorates_the_tips() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        git_ok(&root, &["switch", "-c", "feat/side"]);
        write(&root, "side.ts", "s\n");
        git_ok(&root, &["add", "side.ts"]);
        git_ok(&root, &["commit", "-m", "side"]);
        git_ok(&root, &["switch", "main"]);
        write(&root, "a.ts", "2\n");
        git_ok(&root, &["commit", "-am", "main two"]);
        git_ok(&root, &["tag", "v1"]);
        // A stash must not show up: `--all` would include refs/stash.
        write(&root, "a.ts", "3\n");
        git_ok(&root, &["stash", "push", "-m", "wip"]);

        let c = log(&root, None, 50, 0, true).unwrap();
        let subjects: Vec<&str> = c.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(c.len(), 3, "{subjects:?}");
        assert!(subjects.contains(&"side"), "{subjects:?}");
        assert!(subjects.contains(&"main two"), "{subjects:?}");
        assert!(subjects.contains(&"first"), "{subjects:?}");
        let tip = c.iter().find(|c| c.subject == "main two").unwrap();
        assert!(
            tip.refs.iter().any(|r| r == "HEAD -> main"),
            "{:?}",
            tip.refs
        );
        assert!(tip.refs.iter().any(|r| r == "tag: v1"), "{:?}", tip.refs);
        let side = c.iter().find(|c| c.subject == "side").unwrap();
        assert_eq!(side.refs, vec!["feat/side"]);
        let first = c.iter().find(|c| c.subject == "first").unwrap();
        assert!(first.refs.is_empty(), "{:?}", first.refs);
        // `rev` is ignored with `all`; the plain log sees main only.
        assert_eq!(log(&root, Some("HEAD~1"), 50, 0, true).unwrap().len(), 3);
        assert_eq!(log(&root, None, 50, 0, false).unwrap().len(), 2);
    }

    #[test]
    fn real_log_all_of_an_empty_repo_is_empty() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        assert!(log(dir.path(), None, 10, 0, true).unwrap().is_empty());
    }

    #[test]
    fn real_commit_files_detects_a_rename_and_diff_names_uses_the_merge_base() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        let first = head_of(&root);
        let root_files = commit_files(&root, &first).unwrap();
        assert_eq!(root_files.len(), 1);
        assert_eq!(
            (root_files[0].status.as_str(), root_files[0].path.as_str()),
            ("A", "a.ts")
        );

        git_ok(&root, &["mv", "a.ts", "b.ts"]);
        write(&root, "c.ts", "c\n");
        git_ok(&root, &["add", "c.ts"]);
        git_ok(&root, &["commit", "-m", "rename + add"]);
        let files = commit_files(&root, "HEAD").unwrap();
        let renamed = files.iter().find(|f| f.status == "R").expect("rename row");
        assert_eq!(renamed.orig_path.as_deref(), Some("a.ts"));
        assert_eq!(renamed.path, "b.ts");
        assert!(files.iter().any(|f| f.status == "A" && f.path == "c.ts"));

        // A branch off HEAD adds d.ts; main moves on with e.ts. `main...feat`
        // reports only what feat brings.
        git_ok(&root, &["switch", "-c", "feat/d"]);
        write(&root, "d.ts", "d\n");
        git_ok(&root, &["add", "d.ts"]);
        git_ok(&root, &["commit", "-m", "d"]);
        git_ok(&root, &["switch", "main"]);
        write(&root, "e.ts", "e\n");
        git_ok(&root, &["add", "e.ts"]);
        git_ok(&root, &["commit", "-m", "e"]);
        let names = diff_names(&root, "main", "feat/d").unwrap();
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].path, "d.ts");
        assert_eq!(
            ahead_behind(&root, "feat/d", "main").unwrap(),
            GitAheadBehind {
                ahead: 1,
                behind: 1
            }
        );
        assert_eq!(
            ahead_behind(&root, "main", "main").unwrap(),
            GitAheadBehind {
                ahead: 0,
                behind: 0
            }
        );

        // A merge commit lists what it brought from the second parent.
        git_ok(&root, &["merge", "--no-ff", "--no-edit", "feat/d"]);
        let merge_files = commit_files(&root, "HEAD").unwrap();
        assert_eq!(merge_files.len(), 1);
        assert_eq!(merge_files[0].path, "d.ts");
        let top = log(&root, None, 1, 0, false).unwrap();
        assert_eq!(top[0].parents.len(), 2);
    }
}
