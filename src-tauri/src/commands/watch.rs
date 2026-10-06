//! Workspace file-watching (desktop only) — powers the explorer's
//! auto-refresh. OS-native events (ReadDirectoryChangesW / inotify /
//! FSEvents via `notify`), no polling.
//!
//! Rule I5: Rust only reports "something changed under a watched root" as a
//! debounced `fs-changed` event; deciding what to re-list is TypeScript's
//! job (the listener in src/main.tsx bumps the explorer's refresh counter).
//! The same debounced batch also yields `git-changed` (roots whose `.git`
//! state moved — index, HEAD, refs, a merge in progress) for the git tab;
//! `fs-changed` keeps ignoring dot paths exactly as before.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager};

use super::fs::{FsError, FsResult};

/// The one live debouncer+watcher, replaced wholesale on every `watch_dirs`.
#[derive(Default)]
pub struct WatchState(pub Mutex<Option<Debouncer<RecommendedWatcher>>>);

/// Map debounced event paths to the watched roots they fall under. Events
/// touching only dot-files/dirs (`.git`, editor lockfiles, …) are ignored —
/// the explorer skips dot entries by default, so re-listing for them is churn.
/// With `show_hidden` (the explorer lists them) only `.git` is still ignored:
/// git rewrites it constantly and the explorer never needs a re-list for it
/// (`git_changed_roots` reports repository state separately).
fn changed_roots(paths: &[PathBuf], roots: &[PathBuf], show_hidden: bool) -> Vec<String> {
    roots
        .iter()
        .filter(|root| {
            paths.iter().any(|p| {
                p.strip_prefix(root).is_ok_and(|rel| {
                    !rel.components().any(|c| {
                        let name = c.as_os_str().to_string_lossy();
                        if show_hidden {
                            name == ".git"
                        } else {
                            name.starts_with('.')
                        }
                    })
                })
            })
        })
        .map(|r| r.to_string_lossy().into_owned())
        .collect()
}

/// Is this path, relative to its `.git` directory, one whose change means
/// the repository's state moved? Files git rewrites on every status
/// (`index` — only when a mutate call refreshes it), on commit / checkout /
/// merge (`HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `MERGE_MSG`, `refs/**`,
/// `packed-refs`, `logs/HEAD`), on fetch (`FETCH_HEAD`), and the same set
/// under a linked worktree's private dir (`worktrees/<name>/…`). Anything
/// `.lock` is excluded: git's write-then-rename leaves the real file's event
/// to fire, and reacting to the lock would refresh mid-write.
fn is_git_state_path(tail: &[String]) -> bool {
    const TOP: [&str; 7] = [
        "index",
        "HEAD",
        "ORIG_HEAD",
        "MERGE_HEAD",
        "MERGE_MSG",
        "FETCH_HEAD",
        "packed-refs",
    ];
    const IN_WORKTREE: [&str; 4] = ["HEAD", "index", "MERGE_HEAD", "ORIG_HEAD"];
    if tail.last().is_some_and(|last| last.ends_with(".lock")) {
        return false;
    }
    let s: Vec<&str> = tail.iter().map(String::as_str).collect();
    match s.as_slice() {
        [name] => TOP.contains(name),
        ["refs", _, ..] => true,
        ["logs", "HEAD"] => true,
        ["worktrees", _, name] => IN_WORKTREE.contains(name),
        ["worktrees", _, "refs", _, ..] => true,
        _ => false,
    }
}

/// The counterpart of `changed_roots` for git: the watched roots under which
/// a path's FIRST dot component is exactly `.git` and what follows it is
/// repository state (`is_git_state_path`). A linked worktree's `.git` is a
/// file pointing into the main checkout's `.git/worktrees/<name>`, so watching
/// the main root covers every worktree's state.
fn git_changed_roots(paths: &[PathBuf], roots: &[PathBuf]) -> Vec<String> {
    roots
        .iter()
        .filter(|root| {
            paths.iter().any(|p| {
                p.strip_prefix(root).is_ok_and(|rel| {
                    let comps: Vec<String> = rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect();
                    let Some(dot) = comps.iter().position(|c| c.starts_with('.')) else {
                        return false;
                    };
                    comps[dot] == ".git" && is_git_state_path(&comps[dot + 1..])
                })
            })
        })
        .map(|r| r.to_string_lossy().into_owned())
        .collect()
}

/// Replace the watched set of workspace roots (recursive). Non-existent dirs
/// are skipped silently — a workspace folder may be on a disconnected drive.
/// Emits `fs-changed` (payload: affected root paths) app-wide, debounced,
/// and `git-changed` (same payload shape) when repository state moved.
/// `show_hidden` mirrors the explorer's "Show hidden files" (see
/// `changed_roots`).
#[tauri::command]
pub async fn watch_dirs(
    app: AppHandle,
    dirs: Vec<String>,
    show_hidden: Option<bool>,
) -> FsResult<()> {
    let show_hidden = show_hidden.unwrap_or(false);
    let roots: Vec<PathBuf> = dirs
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect();

    let emit_app = app.clone();
    let event_roots = roots.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(800),
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let paths: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
                let changed = changed_roots(&paths, &event_roots, show_hidden);
                if !changed.is_empty() {
                    let _ = emit_app.emit("fs-changed", changed);
                }
                let git = git_changed_roots(&paths, &event_roots);
                if !git.is_empty() {
                    let _ = emit_app.emit("git-changed", git);
                }
            }
        },
    )
    .map_err(|e| FsError::Io(std::io::Error::other(e)))?;

    for root in &roots {
        debouncer
            .watcher()
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| FsError::Io(std::io::Error::other(e)))?;
    }

    // Swap in the new watcher; dropping the old one releases its OS handles.
    *app.state::<WatchState>().0.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{changed_roots, git_changed_roots};
    use std::path::PathBuf;

    #[test]
    fn git_state_files_map_to_their_root() {
        let roots = [p("/ws/a"), p("/ws/b")];
        for tail in [
            ".git/index",
            ".git/HEAD",
            ".git/ORIG_HEAD",
            ".git/MERGE_HEAD",
            ".git/MERGE_MSG",
            ".git/FETCH_HEAD",
            ".git/packed-refs",
            ".git/refs/heads/main",
            ".git/refs/remotes/origin/feat/x",
            ".git/logs/HEAD",
            ".git/worktrees/feat-x/HEAD",
            ".git/worktrees/feat-x/index",
            ".git/worktrees/feat-x/MERGE_HEAD",
            ".git/worktrees/feat-x/ORIG_HEAD",
            ".git/worktrees/feat-x/refs/heads/x",
        ] {
            let paths = [p(&format!("/ws/a/{tail}"))];
            assert_eq!(
                git_changed_roots(&paths, &roots),
                vec!["/ws/a".to_string()],
                "{tail}"
            );
            // The same path never counts as an explorer change.
            assert!(changed_roots(&paths, &roots, false).is_empty(), "{tail}");
        }
    }

    #[test]
    fn git_noise_and_locks_do_not_count() {
        let roots = [p("/ws/a")];
        for tail in [
            ".git/index.lock",
            ".git/HEAD.lock",
            ".git/refs/heads/main.lock",
            ".git/worktrees/feat-x/index.lock",
            ".git/objects/ab/cdef",
            ".git/logs/refs/heads/main",
            ".git/config",
            ".git/COMMIT_EDITMSG",
            ".git/worktrees/feat-x/COMMIT_EDITMSG",
            ".git/worktrees/feat-x/logs/HEAD",
            ".git/refs",
            ".gitignore",
            ".github/workflows/ci.yml",
            "src/HEAD",
            "src/.cache/index",
            ".vscode/.git/index",
            "notes/a.md",
        ] {
            let paths = [p(&format!("/ws/a/{tail}"))];
            assert!(git_changed_roots(&paths, &roots).is_empty(), "{tail}");
        }
    }

    #[test]
    fn git_changes_dedupe_roots_and_allow_a_nested_repo() {
        let roots = [p("/ws/a"), p("/ws/b")];
        let paths = [
            p("/ws/a/.git/HEAD"),
            p("/ws/a/.git/index"),
            p("/ws/a/sub/.git/refs/heads/main"),
            p("/elsewhere/.git/HEAD"),
        ];
        assert_eq!(git_changed_roots(&paths, &roots), vec!["/ws/a".to_string()]);
        // A root that is itself under a dot dir is fine — only components
        // BELOW the root are inspected.
        let dotted = [p("/home/.config/notes")];
        assert_eq!(
            git_changed_roots(&[p("/home/.config/notes/.git/HEAD")], &dotted),
            vec!["/home/.config/notes".to_string()]
        );
    }

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn maps_paths_to_their_root() {
        let roots = [p("/ws/a"), p("/ws/b")];
        let paths = [p("/ws/a/note.md")];
        assert_eq!(
            changed_roots(&paths, &roots, false),
            vec!["/ws/a".to_string()]
        );
    }

    #[test]
    fn dedupes_and_skips_unrelated_roots() {
        let roots = [p("/ws/a"), p("/ws/b")];
        let paths = [p("/ws/a/x.md"), p("/ws/a/sub/y.md"), p("/elsewhere/z.md")];
        assert_eq!(
            changed_roots(&paths, &roots, false),
            vec!["/ws/a".to_string()]
        );
    }

    #[test]
    fn ignores_dot_components() {
        let roots = [p("/ws/a")];
        let paths = [p("/ws/a/.git/index"), p("/ws/a/sub/.lock")];
        assert!(changed_roots(&paths, &roots, false).is_empty());
    }

    #[test]
    fn show_hidden_reports_dot_paths_but_not_git() {
        let roots = [p("/ws/a")];
        let shown = [p("/ws/a/.config/notes.md")];
        assert_eq!(
            changed_roots(&shown, &roots, true),
            vec!["/ws/a".to_string()]
        );
        let git = [p("/ws/a/.git/index"), p("/ws/a/sub/.git/HEAD")];
        assert!(changed_roots(&git, &roots, true).is_empty());
    }

    #[test]
    fn dot_in_root_itself_is_fine() {
        // Only components BELOW the root are dot-filtered.
        let roots = [p("/home/.config/notes")];
        let paths = [p("/home/.config/notes/a.md")];
        assert_eq!(
            changed_roots(&paths, &roots, false),
            vec!["/home/.config/notes".to_string()]
        );
    }
}
