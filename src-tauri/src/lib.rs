mod commands;
// Desktop-only: the pty engine and login-shell resolution behind the terminal
// tabs. Android has no pty (see commands/mod.rs).
#[cfg(desktop)]
mod pty;
// Desktop-only: the one-time move of pre-rename (MD Notepad) app data.
#[cfg(desktop)]
mod rename_migration;
#[cfg(desktop)]
mod shell;
// Windows-only: which virtual desktop a window sits on, for the
// single-instance handoff below.
#[cfg(windows)]
mod vdesk;
// Windows-only: page-supplied items (heading marks) in WebView2's native
// context menu, beside the spell checker's suggestions.
#[cfg(windows)]
mod native_menu;

use std::sync::Mutex;

use tauri_plugin_log::log::LevelFilter;
// Only the single-instance closure below uses these traits (emit_to /
// get_webview_window), and that closure is release-desktop-only: gated out on
// mobile (no second process) and in debug builds (so a dev instance can coexist
// with an installed release instead of folding into it).
#[cfg(all(desktop, not(debug_assertions)))]
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The shell a terminal profile spawns when it names no program. The frontend
/// shows it in Settings and passes it back on spawn.
#[cfg(desktop)]
#[tauri::command]
fn default_shell() -> String {
    shell::default_shell()
}

/// File paths passed on the command line at first launch.
///
/// These CANNOT be delivered as an event from `setup` — the webview has not
/// loaded the frontend yet at that point, so the event would fire before any
/// listener exists and be silently lost. Instead they sit in managed state
/// until the frontend boots and calls `drain_startup_files`.
///
/// Second-instance argv (user double-clicks a .md while the app runs) has no
/// such problem: the frontend is already listening, so the single-instance
/// callback below delivers those live via the `open-files` event.
pub struct StartupFiles(pub Mutex<Vec<String>>);

#[tauri::command]
fn drain_startup_files(state: tauri::State<'_, StartupFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Extract candidate file paths from an argv slice: everything after the
/// executable path that isn't a flag. Validation (does it exist, is it
/// openable) is frontend business.
fn file_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect()
}

/// Max log level for `tauri_plugin_log`, from `MDS_LOG` or argv.
///
/// The plugin's own default is TRACE, and nothing in this crate logs at all —
/// so every TRACE line came from a dependency. The explorer's `notify` watcher
/// is the worst of them: one line per inotify event under every watched folder,
/// which on a dev run with this repo open buried cargo errors and vite HMR
/// messages under ~700k lines in 90 seconds. INFO costs us nothing and keeps
/// `tauri dev` readable.
///
/// `--verbose` (what `pnpm run tauri:dev:verbose` passes) opens it to DEBUG;
/// `MDS_LOG` takes an explicit off/error/warn/info/debug/trace and wins over
/// the flag. TRACE is the old firehose — reach for it deliberately.
fn log_level_from(env: Option<&str>, args: &[String]) -> LevelFilter {
    if let Some(level) = env.and_then(|v| v.trim().parse::<LevelFilter>().ok()) {
        return level;
    }
    if args.iter().any(|a| a == "--verbose" || a == "-v") {
        return LevelFilter::Debug;
    }
    LevelFilter::Info
}

/// Shared window geometry/chrome for every window the app creates, as
/// (width, height, min width, min height). Mirrors `WINDOW_OPTIONS` in
/// `src/main.tsx` — a window born in Rust (the second-instance handoff below)
/// must look exactly like one born in JS.
#[cfg(all(desktop, not(debug_assertions)))]
const NEW_WINDOW: (f64, f64, f64, f64) = (900.0, 650.0, 400.0, 300.0);

/// Percent-encode a query-parameter VALUE (the RFC 3986 unreserved set is kept).
///
/// The second-instance handoff hands file paths to a brand-new window through
/// its URL, and Windows paths are full of characters a query string reads as
/// structure — backslashes, spaces, `#`, `&`, `%` — so nothing may travel raw.
// Dead where the only caller is not compiled (debug builds, mobile): the
// second-instance handoff is release-desktop-only. The unit tests below still
// cover it everywhere.
#[cfg_attr(not(all(desktop, not(debug_assertions))), allow(dead_code))]
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A window label no live window is using.
///
/// `w-<millis>` — the `w-` prefix is what the frontend's restore sweep and
/// `capabilities/default.json` both match on, so a handoff window is an
/// ordinary secondary window in every other respect. Two launches inside the
/// same millisecond (or a restored window that already owns the label) fall
/// through to a `-<n>` suffix, which the frontend's manifest regex accepts.
// Dead where the only caller is not compiled (debug builds, mobile): the
// second-instance handoff is release-desktop-only. The unit tests below still
// cover it everywhere.
#[cfg_attr(not(all(desktop, not(debug_assertions))), allow(dead_code))]
fn fresh_window_label(millis: u128, taken: &[String]) -> String {
    let base = format!("w-{millis}");
    if !taken.contains(&base) {
        return base;
    }
    (1u32..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or(base)
}

/// Can the user see this window from where they are standing?
///
/// On Windows 11 that is a real question: `set_focus()` on a window parked on
/// another virtual desktop switches the user's whole desktop out from under
/// them. Everywhere else — and whenever the shell refuses to answer — it is
/// yes, which keeps the old always-focus behaviour.
#[cfg(all(desktop, not(debug_assertions)))]
fn is_reachable(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        window
            .hwnd()
            .ok()
            .and_then(vdesk::is_on_current_desktop)
            .unwrap_or(true)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        true
    }
}

/// A second launch of the app: reuse a window the user can actually see, or
/// give them a new one here rather than teleporting them to an old one.
///
/// Files (a double-clicked `.md`) reach a REUSED window over the `open-files`
/// event — its frontend is already listening. A NEW window has no listener yet
/// when it is built, so they ride its URL as `?open=` instead, the same trick
/// `spawnTabWindow` uses for `?adopt=`.
#[cfg(all(desktop, not(debug_assertions)))]
fn handle_second_instance(app: &tauri::AppHandle, args: &[String]) {
    let files = file_args(args);

    // Windows close independently, so "main" may be gone while the app still
    // runs — every surviving window is a candidate, main first. Tab-drag ghosts
    // ("ghost-*") are transient cursor-followers, never a reuse target; nor is
    // the presenter view ("w-presenter"), which holds no tabs.
    let mut candidates: Vec<WebviewWindow> = app.get_webview_window("main").into_iter().collect();
    candidates.extend(
        app.webview_windows()
            .into_iter()
            .filter(|(label, _)| {
                label != "main" && label != "w-presenter" && !label.starts_with("ghost-")
            })
            .map(|(_, window)| window),
    );

    if let Some(window) = candidates.into_iter().find(is_reachable) {
        let _ = window.set_focus();
        // Target the event at that one window only (every window listens on its
        // own label), so the files open exactly once.
        if !files.is_empty() {
            let _ = app.emit_to(window.label(), "open-files", files);
        }
        return;
    }

    // Nothing on this virtual desktop: build a window, which Windows places on
    // the desktop the user is looking at.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let taken: Vec<String> = app.webview_windows().into_keys().collect();
    let label = fresh_window_label(millis, &taken);

    let url = match serde_json::to_string(&files) {
        Ok(json) if !files.is_empty() => format!("index.html?open={}", encode_query(&json)),
        _ => "index.html".to_string(),
    };

    let (width, height, min_width, min_height) = NEW_WINDOW;
    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("MD Specpad")
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .decorations(false)
        .build();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Before the builder: no plugin or webview may open the app folders first.
    #[cfg(desktop)]
    rename_migration::migrate(&context.config().identifier);

    let args = std::env::args().collect::<Vec<_>>();
    let startup_files = file_args(&args);
    let log_level = log_level_from(std::env::var("MDS_LOG").ok().as_deref(), &args);

    let builder = tauri::Builder::default();

    // Desktop-only plugins. On mobile there is no second process to fold in, no
    // native window geometry to persist, no self-updater (the store handles
    // updates), and no process restart/exit — and single-instance does not even
    // compile for Android/iOS. See the target-gated deps in Cargo.toml.
    #[cfg(desktop)]
    let builder = {
        // single-instance is release-only. Debug builds share the release's app
        // identifier, so the plugin's lock is shared too: launching `tauri dev`
        // while an installed release runs would fold the dev instance into the
        // release (focus it, forward args) and immediately exit the dev process —
        // no window. Skipping it in debug lets a dev build coexist with release.
        #[cfg(not(debug_assertions))]
        let builder = builder
            // single-instance must be the FIRST plugin registered (its docs) so it
            // can bail out before any other plugin does work in a doomed instance.
            .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
                handle_second_instance(app, &args);
            }));

        builder
            // Restore only geometry. The default flags also restore DECORATIONS /
            // FULLSCREEN / VISIBLE, and a state file saved by an older (decorated)
            // build resurrects the native titlebar over the config's
            // decorations: false (the TabBar is the titlebar now).
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::SIZE
                            | tauri_plugin_window_state::StateFlags::POSITION
                            | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                    )
                    // Tab-drag ghost windows (label "ghost-*") are transient
                    // cursor-followers: never save their throwaway geometry,
                    // never restore stale geometry onto one.
                    .with_filter(|label| !label.starts_with("ghost-"))
                    .build(),
            )
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
    };

    // Desktop-only: workspace file-watcher state (explorer auto-refresh) and
    // the live-pty registry behind terminal tabs.
    #[cfg(desktop)]
    let builder = builder
        .manage(commands::watch::WatchState::default())
        // The git tab's running fetch / pull / push ops (one per repository).
        .manage(commands::git::net::GitOps::default())
        .manage(commands::pty::PtyRegistry::default())
        // Whisper voice notes: the loaded model and the one download at a time.
        .manage(commands::whisper::engine::EngineState::default())
        .manage(commands::whisper::models::DownloadState::default());

    // Android-only: native Context APIs (external files dir now; content:// reads
    // and incoming intents later) that pure-Rust JNI can't reach in Tauri.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_androidfs::init());

    // Windows-only: every webview gets the native-menu hook as it is created
    // (see native_menu.rs), so page items like the heading marks can join
    // the native context menu instead of replacing it.
    #[cfg(windows)]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("native-menu")
            .on_webview_ready(|webview| native_menu::install(&webview))
            .build(),
    );

    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log_level)
                .build(),
        )
        .manage(StartupFiles(Mutex::new(startup_files)))
        .invoke_handler(tauri::generate_handler![
            drain_startup_files,
            commands::fs::read_text_file,
            commands::fs::atomic_write_text,
            commands::fs::list_notes,
            commands::fs::list_dir,
            commands::fs::dir_has_relevant_files,
            commands::fs::list_deck_files,
            commands::fs::list_session_manifests,
            commands::fs::list_theme_files,
            commands::fs::read_file_base64,
            commands::fs::write_file_base64,
            commands::fs::copy_path,
            commands::fs::create_dir,
            commands::fs::rename_path,
            commands::fs::delete_path,
            commands::fs::stat_path,
            commands::search::search_notes,
            #[cfg(desktop)]
            commands::watch::watch_dirs,
            #[cfg(desktop)]
            commands::webview::set_smooth_scrolling,
            #[cfg(desktop)]
            default_shell,
            #[cfg(desktop)]
            commands::programs::find_programs,
            // Review mode's "What changed" (git facts), desktop only.
            #[cfg(desktop)]
            commands::git::git_repo_info,
            #[cfg(desktop)]
            commands::git::git_show_file,
            #[cfg(desktop)]
            commands::git::git_file_changes,
            #[cfg(desktop)]
            commands::git::git_trust_directory,
            #[cfg(desktop)]
            commands::git::git_init,
            #[cfg(desktop)]
            commands::git::git_identity,
            #[cfg(desktop)]
            commands::git::git_set_identity,
            // The git tab (status, refs, staging, commits, merges, worktrees,
            // network), desktop only.
            #[cfg(desktop)]
            commands::git::git_status,
            #[cfg(desktop)]
            commands::git::git_branches,
            #[cfg(desktop)]
            commands::git::git_log,
            #[cfg(desktop)]
            commands::git::git_commit_files,
            #[cfg(desktop)]
            commands::git::git_diff_names,
            #[cfg(desktop)]
            commands::git::git_ahead_behind,
            #[cfg(desktop)]
            commands::git::git_worktrees,
            #[cfg(desktop)]
            commands::git::git_check_ignore,
            #[cfg(desktop)]
            commands::git::git_stage,
            #[cfg(desktop)]
            commands::git::git_unstage,
            #[cfg(desktop)]
            commands::git::git_discard,
            #[cfg(desktop)]
            commands::git::git_commit,
            #[cfg(desktop)]
            commands::git::git_switch,
            #[cfg(desktop)]
            commands::git::git_create_branch,
            #[cfg(desktop)]
            commands::git::git_delete_branch,
            #[cfg(desktop)]
            commands::git::git_merge,
            #[cfg(desktop)]
            commands::git::git_merge_abort,
            #[cfg(desktop)]
            commands::git::git_worktree_add,
            #[cfg(desktop)]
            commands::git::git_worktree_remove,
            #[cfg(desktop)]
            commands::git::git_fetch,
            #[cfg(desktop)]
            commands::git::git_pull,
            #[cfg(desktop)]
            commands::git::git_push,
            #[cfg(desktop)]
            commands::git::git_op_cancel,
            #[cfg(desktop)]
            commands::git::git_remotes,
            #[cfg(desktop)]
            commands::git::git_remote_add,
            #[cfg(desktop)]
            commands::git::git_remote_set_url,
            #[cfg(desktop)]
            commands::git::git_remote_remove,
            #[cfg(desktop)]
            commands::git::git_compare_ref,
            #[cfg(desktop)]
            commands::pty::pty_spawn,
            #[cfg(desktop)]
            commands::pty::pty_write,
            #[cfg(desktop)]
            commands::pty::pty_resize,
            #[cfg(desktop)]
            commands::pty::pty_kill,
            #[cfg(desktop)]
            commands::pty::pty_attach,
            #[cfg(desktop)]
            commands::pty::pty_detach,
            // Whisper voice notes (offline transcription), every platform.
            commands::whisper::models::whisper_models_list,
            commands::whisper::models::whisper_models_stray,
            commands::whisper::models::whisper_models_prune,
            commands::whisper::models::whisper_model_dir,
            commands::whisper::models::whisper_model_download,
            commands::whisper::models::whisper_model_cancel,
            commands::whisper::models::whisper_model_delete,
            commands::whisper::engine::whisper_accelerator,
            commands::whisper::engine::whisper_prepare,
            commands::whisper::engine::whisper_transcribe,
            #[cfg(target_os = "android")]
            commands::android::extract_docs_dir,
            #[cfg(target_os = "android")]
            commands::android::external_files_dir,
            #[cfg(target_os = "android")]
            commands::android::read_content_uri,
            #[cfg(target_os = "android")]
            commands::android::take_incoming_uris,
            #[cfg(target_os = "android")]
            commands::android::pick_synced_tree,
            #[cfg(target_os = "android")]
            commands::android::saf_list,
            #[cfg(target_os = "android")]
            commands::android::saf_refresh,
            #[cfg(target_os = "android")]
            commands::android::saf_read,
            #[cfg(target_os = "android")]
            commands::android::saf_write,
            #[cfg(target_os = "android")]
            commands::android::saf_create_dir,
            #[cfg(target_os = "android")]
            commands::android::saf_rename,
            #[cfg(target_os = "android")]
            commands::android::saf_delete,
            #[cfg(target_os = "android")]
            commands::android::saf_stat,
            #[cfg(target_os = "android")]
            commands::android::release_synced_tree,
            #[cfg(target_os = "android")]
            commands::android::stt_available,
            #[cfg(target_os = "android")]
            commands::android::stt_permission,
            #[cfg(target_os = "android")]
            commands::android::stt_request_permission,
            #[cfg(target_os = "android")]
            commands::android::stt_start,
            #[cfg(target_os = "android")]
            commands::android::stt_stop,
            #[cfg(target_os = "android")]
            commands::android::capture_photo,
            #[cfg(target_os = "android")]
            commands::android::ink_recognize,
            #[cfg(target_os = "android")]
            commands::android::text_recognize,
            #[cfg(target_os = "windows")]
            commands::ocr::ocr_image_available,
            #[cfg(target_os = "windows")]
            commands::ocr::ocr_image_recognize,
            // Voice notes on Windows: Win+H toggles Windows voice typing.
            #[cfg(target_os = "windows")]
            commands::voice_typing::voice_typing_toggle,
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{encode_query, file_args, fresh_window_label, log_level_from, LevelFilter};

    fn argv(flags: &[&str]) -> Vec<String> {
        std::iter::once("md-specpad")
            .chain(flags.iter().copied())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn file_args_skips_exe_and_flags() {
        let args = vec![
            "C:\\apps\\md-specpad.exe".to_string(),
            "--flag".to_string(),
            "-v".to_string(),
            "C:\\notes\\a.md".to_string(),
        ];
        assert_eq!(file_args(&args), vec!["C:\\notes\\a.md".to_string()]);
    }

    #[test]
    fn file_args_empty_argv() {
        assert!(file_args(&[]).is_empty());
        assert!(file_args(&["exe".to_string()]).is_empty());
    }

    #[test]
    fn log_level_defaults_to_info() {
        assert_eq!(log_level_from(None, &argv(&[])), LevelFilter::Info);
        assert_eq!(log_level_from(None, &argv(&["a.md"])), LevelFilter::Info);
    }

    #[test]
    fn log_level_verbose_flag_opens_debug() {
        assert_eq!(
            log_level_from(None, &argv(&["--verbose"])),
            LevelFilter::Debug
        );
        assert_eq!(log_level_from(None, &argv(&["-v"])), LevelFilter::Debug);
    }

    #[test]
    fn log_level_env_wins_over_flag_and_ignores_junk() {
        let verbose = argv(&["--verbose"]);
        assert_eq!(log_level_from(Some("trace"), &verbose), LevelFilter::Trace);
        assert_eq!(log_level_from(Some("OFF"), &verbose), LevelFilter::Off);
        assert_eq!(
            log_level_from(Some(" warn\n"), &argv(&[])),
            LevelFilter::Warn
        );
        // Unparseable MDS_LOG falls through to the flag rather than panicking.
        assert_eq!(log_level_from(Some("loud"), &verbose), LevelFilter::Debug);
        assert_eq!(log_level_from(Some(""), &argv(&[])), LevelFilter::Info);
    }

    #[test]
    fn encode_query_escapes_everything_a_url_would_read() {
        // A Windows path is the real payload: backslashes, spaces, and the
        // characters a query string treats as structure.
        assert_eq!(
            encode_query("C:\\my notes\\a&b#c.md"),
            "C%3A%5Cmy%20notes%5Ca%26b%23c.md"
        );
        // Unreserved characters survive untouched; non-ASCII leaves as UTF-8.
        assert_eq!(encode_query("a-z_0.9~"), "a-z_0.9~");
        assert_eq!(encode_query("\u{e9}"), "%C3%A9");
        assert_eq!(encode_query(""), "");
    }

    #[test]
    fn fresh_window_label_avoids_live_labels() {
        assert_eq!(fresh_window_label(17, &[]), "w-17");
        assert_eq!(
            fresh_window_label(17, &["main".to_string(), "w-16".to_string()]),
            "w-17"
        );
        assert_eq!(fresh_window_label(17, &["w-17".to_string()]), "w-17-1");
        assert_eq!(
            fresh_window_label(17, &["w-17".to_string(), "w-17-1".to_string()]),
            "w-17-2"
        );
    }
}
