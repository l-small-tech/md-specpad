# src-tauri/ — Rust backend (keep it thin)

Rule I5: Rust has **no business logic**. It offers primitive, generic
filesystem operations plus plugin wiring; every decision about *which* file
to touch and *when* is TypeScript's. If you find yourself encoding tab or
session concepts in Rust, stop and move it to `src/core`.

## What lives here

- `src/lib.rs` — builder: plugin registration (single-instance FIRST),
  managed `StartupFiles` state, `drain_startup_files` command, `open-files`
  event for second-instance argv. Read its doc comments — the
  "why not emit from setup" note matters. `handle_second_instance` reuses a
  live window only when the user can SEE it (`vdesk`), else builds a new
  `w-<millis>` one carrying the argv files in its `?open=` URL param.
- `src/vdesk.rs` — **Windows only**: `IVirtualDesktopManager`, the one
  documented virtual-desktop interface (never reach for the undocumented
  `…Internal` one — its vtable shifts between OS builds). Answers "is this
  window on the desktop the user is looking at?"; `None` (any COM failure)
  means "assume yes", degrading to the old always-focus behaviour.
- `src/commands/fs.rs` — the entire custom IPC surface (reference
  implementation, tested): `read_text_file`, `atomic_write_text`,
  `list_notes`, `list_dir`, `list_session_manifests`, `read_file_base64`,
  `write_file_base64`, `copy_path`, `create_dir`, `rename_path`,
  `delete_path`, `stat_path`.
- `src/commands/git/` — everything git (**desktop only**,
  `#[cfg(not(target_os = "android"))]` on the module). Shells out to the `git`
  binary — no `git2`/libgit2, because the feature only runs where a developer
  already has git and a large native build buys a process spawn nothing.
  - `mod.rs` — `GitError`, the path helpers, `parse_worktrees`, and Review
    mode's three facts: `git_repo_info` (root, `main_root` = the first
    `worktree list` record and the git tab's identity, `rel`, branch, HEAD,
    `is_worktree`, the baseline branch + its merge-base, every worktree),
    `git_show_file` (`git show <rev>:<rel>`; `None` — not an error — when the
    path did not exist at that revision), `git_file_changes` (per branch, does
    its blob for one path differ from the baseline's? one `rev-parse` per
    branch, no checkouts). Plus `git_trust_directory`: git's "dubious
    ownership" refusal (`safe.directory`) classifies as `GIT_UNTRUSTED`, and
    on the user's confirmation this adds the path GIT names (never the
    caller's string) to the global `safe.directory` list. The baseline branch is auto-detected —
    `development`, then `main`, then `master` — and overridden by the
    frontend's `reviewBaseBranch` setting. `pub use`s every command fn (and
    the two helper macros `#[tauri::command]` emits per fn) so `lib.rs` keeps
    `commands::git::<name>`.
  - `run.rs` — the ONE runner. `GitMode { Read, Mutate, Network }` picks the
    flag and the limit: Read = `--no-optional-locks`, 3 s; Mutate = 30 s;
    Network = 120 s, streamed over a `tauri::ipc::Channel<GitOutputEvent>`
    (`{kind:"line", stream:"out"|"err", text}` per line — split on `\n` AND
    `\r`, git's progress redraws with a bare CR — then one `{kind:"done"}`
    last, on every path out) and cancellable (an `AtomicBool` polled every
    20 ms; set → `child.kill()` → `GIT_CANCELLED`). Every invocation is
    `git -c color.ui=never -c core.quotepath=false [--no-optional-locks]
    [-C root] <args>` with `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `LANG=C`,
    `stdin` null (nothing can prompt), both pipes drained by their own thread
    (a full pipe can't deadlock the wait), `CREATE_NO_WINDOW` on Windows, and
    killed at its mode's limit (`GIT_TIMEOUT` names the seconds). `safe_arg`
    (refuses empty, leading `-`, control chars) and `safe_rel` (also absolute
    paths and `..` segments) gate EVERY user-supplied string → `GIT_INVALID_ARG`;
    path lists always sit behind `--`. **There is no generic "run these args"
    command**: every command below is named and builds its own argv.
    `message_file` carries a commit message to `commit -F` as a temp file —
    never `-m`.
  - `status.rs` — `git_status`: `status --porcelain=v2 -z --branch
    --untracked-files=normal` (never `-uall`), record types `1`/`2`/`u`/`?`,
    plus `state` (merging / rebasing / cherry-picking / reverting / bisecting)
    from the marker files under `rev-parse --git-path` and `merge_head`.
  - `refs.rs` — `git_branches` (`for-each-ref` with a `%1f`/`%1e`-separated
    format over `refs/heads` + `refs/remotes`, `%(upstream:track)` parsed into
    ahead/behind/gone, `refs/remotes/*/HEAD` dropped), `git_log` (paged; each
    commit's `refs` from `%D`; `all` logs `--date-order --branches --remotes
    --tags [HEAD]` — never `--all`, which includes `refs/stash` — ignoring
    `rev`; `[]` on an unborn HEAD or a repo with no refs), `git_commit_files` (a merge commit against its first
    parent), `git_diff_names` (`from...to`), `git_ahead_behind`.
  - `worktrees.rs` — `git_worktrees` (the dashboard: per checkout, capped at
    20, dirty counts from a status + ahead/behind the base from `rev-list`;
    a vanished directory is `missing: true`, not an error), `git_check_ignore`,
    `git_worktree_add`, `git_worktree_remove` (+ `worktree prune`).
  - `ops.rs` — `git_stage` / `git_unstage` (`rm --cached` on an unborn branch)
    / `git_discard` (`restore --worktree --source=HEAD` + `clean -f [-d]`),
    `git_commit` (`--cleanup=strip -F <tmp>` | `--no-edit`; returns the new
    sha), `git_switch`, `git_create_branch` (`check-ref-format` first),
    `git_delete_branch`, `git_merge` (a conflict is the OUTCOME `conflicts`
    with the unmerged paths — never an error; a refusal is `GIT_FAILED`),
    `git_merge_abort`.
  - `net.rs` — `GitOps` managed state (op id → cancel flag; one op per
    `path_key(root)` at a time → `GIT_BUSY`; a cancel that arrives before its
    op begins is remembered), `git_fetch` / `git_pull` / `git_push` /
    `git_op_cancel`. A push git rejected or a fetch that could not reach its
    remote is a RESULT (`ok:false`, `exitCode`, `stderr`), never a rejection;
    a pull's merge half is reported as a `GitMergeOutcome` (conflicts keep
    `ok:true` — the pull ran).
  Every command runs on the blocking pool. Policy-free (rule I5): which
  revision is "the baseline", what a badge means, which group a status letter
  lands in and what a merge outcome enables are `src/core/code/changes.ts`'s,
  `src/core/git/*`'s and the stores'.
- `src/commands/watch.rs` — the workspace watcher (**desktop only**): one
  `notify` debouncer (800 ms) over every workspace root, emitting `fs-changed`
  (roots whose non-dot paths changed — the explorer re-lists) and, from the
  SAME batch, `git-changed` (roots whose `.git` state moved: `index`, `HEAD`,
  `ORIG_HEAD`, `MERGE_HEAD`, `MERGE_MSG`, `FETCH_HEAD`, `packed-refs`,
  `refs/**`, `logs/HEAD`, and the same under `worktrees/<name>/`; anything
  `.lock` excluded — the git tab refreshes). A linked worktree's `.git` is a
  file pointing into the main checkout's `.git/worktrees/<name>`, so watching
  the main root covers every worktree.
- `src/pty.rs` — the pty engine behind terminal tabs (**desktop only**):
  spawn a child on a pseudo-terminal, four threads per session
  (reader → bounded channel → emitter, a waiter, and a writer fed by a
  bounded queue so `write()` never blocks the caller), output coalesced
  into ≤64 KB chunks every 4 ms. Deliberately Tauri-free so its tests run a real
  shell. A session's sink is SWAPPABLE (`Relay`): a pty outlives the webview
  that spawned it, so `detach` / `attach` move the listener between windows
  when a terminal tab is dragged out, and the last ≤1 MB of output (plus an
  exit code the old window never saw) is replayed to whoever attaches, which
  is what repaints the screen there. `attach` resizes to the new window's grid
  FIRST (the shell's redraw then belongs to the replay instead of landing on
  top of it) and closes the replay with `PtyEvent::ReplayEnd` — the frontend
  must not answer the queries a replay contains, so it needs to know when the
  stream goes live. `src/shell.rs` resolves the default shell when the frontend's
  profile names no program: PowerShell 7 (else Windows PowerShell) on
  Windows, zsh on macOS, bash on Linux — each probed on `PATH` first, then
  `$SHELL`, then a shell that always exists. It also owns `search_path`
  (the inherited `PATH` plus what a running process never sees: the
  registry's user/machine `PATH` on Windows, the user-space bin dirs a
  desktop launch lacks on unix) and `find_program` (a `which` honoring
  `PATHEXT`) — used by the pty spawn and by `commands/programs.rs`.
- `src/commands/programs.rs` — `find_programs(names)` (**desktop only**):
  each name → its resolved path or null, so the Settings dialog can dim the
  harnesses that are not installed and offer to install them. Policy-free:
  which names to ask about lives in `src/ui/stores/harness-availability.ts`.
- `src/commands/voice_typing.rs` — **Windows only**: `voice_typing_toggle`
  presses Win+H, which opens or closes Windows voice typing in the focused
  text field (the voice-note sheet's draft box). Voice notes don't use
  `Windows.Media.SpeechRecognition`: for an app without package identity,
  Windows hands that recognizer silence. No audio is touched.
- `src/commands/whisper/` — every platform: offline voice-note
  transcription with whisper.cpp (`whisper-rs`). The GPU backend is chosen
  per target in Cargo.toml — Vulkan on Windows/Linux, Metal on macOS, CPU
  only on Android — and whisper.cpp falls back to the CPU on its own when
  no device works. On Windows `vulkan-1.dll` is delay-loaded (build.rs +
  `src/vulkan_delayload.cpp`): the failure hook turns a missing DLL into the
  C++ exception ggml's Vulkan registration catches, so a driverless machine
  starts and transcribes on the CPU; `MD_SPECPAD_NO_VULKAN=1` forces the
  same path. `models.rs` owns the pinned manifest (four q5 quantized Hugging
  Face `ggerganov/whisper.cpp` files with sizes and SHA-256 digests), the
  model folder (`<app_data_dir>/whisper`), and the download commands:
  `whisper_models_list`, `whisper_models_stray` / `whisper_models_prune`
  (files an earlier manifest downloaded — reported as a total, deleted on
  request), `whisper_model_dir`, `whisper_model_download` (streams to
  `<file>.part` while hashing, resumes with `Range`, renames into place only
  on a matching digest, reports progress on a `Channel`),
  `whisper_model_cancel`, `whisper_model_delete`. `engine.rs` caches one
  loaded `WhisperContext` per session (keyed by file and GPU flag) and runs
  `whisper_accelerator` ("vulkan" / "metal" / "none"), `whisper_prepare`
  (warm the model; `use_gpu` mirrors the setting) and `whisper_transcribe` —
  raw f32 PCM as the request body (`tauri::ipc::Request`, no JSON/base64)
  with `sample-rate`, `model-id` and `use-gpu` headers, resampled to 16 kHz
  if needed, on the blocking pool. An optional `hint` header is whisper.cpp's initial
  prompt (`FullParams::set_initial_prompt`): words the decoder should expect,
  which Review mode fills with the reviewed file's identifiers as spoken
  words (`src/core/code/vocab.ts` `identifierHint`) — without it the decode
  is unchanged. Audio only ever lives in memory. The network is touched
  only by `whisper_model_download`, only when the user clicks Download.
- `src/commands/pty.rs` — the thin Tauri skin (**desktop only**): the
  `PtyRegistry` and the wire format. Output crosses as
  `InvokeResponseBody::Raw` on a `Channel`, so bytes stay bytes; `exit` and
  `closed` travel down the same channel as JSON so they stay ordered against
  the output they follow. The registry is APP-wide, not per-window — that is
  what lets `pty_attach` hand a running shell to another window (and
  `pty_detach` let go of one without killing it). Commands: `default_shell`,
  `find_programs`, `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`,
  `pty_attach`, `pty_detach`.
- `capabilities/default.json` — plugin/core permissions for every app
  window: `main` plus torn-off tab windows (`w-*`, M8). Custom commands
  need NO capability entries.
- `tauri.conf.json` — app config. `createUpdaterArtifacts` stays `false`
  until M7's key ceremony.

## Error contract (mirrored in src/ipc/commands.ts — keep in sync)

| Rust `FsError` | wire `code` | TS meaning |
| --- | --- | --- |
| `NotFound(path)` | `NOT_FOUND` | subject missing; often expected (stat, restore) |
| `Exists(path)` | `EXISTS` | rename refused to clobber a DIFFERENT entry; caller resolves collisions |
| `InvalidPath(msg)` | `INVALID_PATH` | caller bug — surface loudly in dev |
| `InvalidData(msg)` | `INVALID_DATA` | malformed payload (e.g. bad base64) — caller bug |
| `Io(err)` | `IO` | everything else; message is for logs only |

`PtyError` (`src/pty.rs`) serializes the same `{code, message}` shape and
shares `NOT_FOUND` (no such session — a kill/resize that raced the child's
own exit; callers treat it as success) and `IO`, plus one code of its own:

| Rust `PtyError` | wire `code` | TS meaning |
| --- | --- | --- |
| `Spawn(msg)` | `SPAWN` | the child could not be started (bad program or cwd) |

`WhisperError` (`src/commands/whisper/mod.rs`) serializes the same shape,
shares `INVALID_DATA` / `IO`, and adds its own codes — the sheet's
`core/dictation-errors.ts` turns the first four into steps:

| Rust `WhisperError` | wire `code` | TS meaning |
| --- | --- | --- |
| `NoModel(path)` | `WHISPER_NO_MODEL` | the chosen model isn't downloaded — Settings ▸ Voice notes |
| `ModelCorrupt(msg)` | `WHISPER_MODEL_CORRUPT` | file length ≠ manifest; delete + re-download |
| `LoadFailed(msg)` | `WHISPER_LOAD_FAILED` | whisper.cpp refused the file (bad file, or out of memory) |
| `Failed(msg)` | `WHISPER_FAILED` | transcription itself failed |
| `UnknownModel(id)` | `WHISPER_UNKNOWN_MODEL` | caller bug: id not in the manifest |
| `DownloadFailed(msg)` | `WHISPER_DOWNLOAD_FAILED` | network / HTTP error; the `.part` stays for a resume |
| `DownloadCorrupt` | `WHISPER_DOWNLOAD_CORRUPT` | digest mismatch; the `.part` was deleted |
| `DownloadCancelled` | `WHISPER_DOWNLOAD_CANCELLED` | `whisper_model_cancel` landed; the `.part` stays |
| `DownloadBusy` | `WHISPER_DOWNLOAD_BUSY` | one download at a time |

`GitError` (`src/commands/git/mod.rs`) serializes the same shape with eight
codes of its own; `isGitUnavailable` in `src/ipc/commands.ts` treats the first
three as "hide the feature", not as failures:

| Rust `GitError` | wire `code` | TS meaning |
| --- | --- | --- |
| `NoGit` | `GIT_NOT_FOUND` | no `git` binary on `PATH` |
| `NotARepo(path)` | `GIT_NOT_A_REPO` | the path is outside any repository |
| `Untrusted(path)` | `GIT_UNTRUSTED` | git's `safe.directory` check refused the repo (owned by another account); `git_trust_directory` fixes it |
| `Timeout` | `GIT_TIMEOUT` | git was killed at its mode's limit (3 s read, 30 s mutate, 120 s network) |
| `Failed { stderr }` | `GIT_FAILED` | git ran and failed; message is its stderr |
| `Cancelled` | `GIT_CANCELLED` | `git_op_cancel` landed on a fetch / pull / push |
| `Busy` | `GIT_BUSY` | one network op per repository at a time |
| `InvalidArg(what)` | `GIT_INVALID_ARG` | caller bug: a user string the runner refuses to pass (empty, leading `-`, control chars) |

Adding a variant = adding it to `IpcErrorCode` in `src/ipc/commands.ts` and
to this table, same commit.

## Checklist: adding a Tauri command

1. Write the `#[tauri::command]` fn in `src/commands/<area>.rs` (new module
   → add to `commands/mod.rs`). Return `Result<T, FsError>` (or a new
   error enum following the same serialize pattern).
2. Register it in `lib.rs` → `tauri::generate_handler![...]`.
3. Add the typed wrapper to `src/ipc/commands.ts` (camelCase args — Tauri
   maps them onto snake_case params).
4. `#[cfg(test)]` tests beside the command (tempfile-based, no mocks).
5. `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`.

Plugin permissions (only when adding a PLUGIN, not a custom command): add
the permission string to `capabilities/default.json`.

Desktop-only commands (the pty is the example): gate the `pub mod` in
`commands/mod.rs` with `#[cfg(desktop)]`, gate each `generate_handler!`
entry and the `.manage(...)` the same way, and put the crate in the
`cfg(not(any(target_os = "android", target_os = "ios")))` dependency table
so it never enters the mobile graph. CI's
`cargo check --target aarch64-linux-android` is what catches a miss.

## Atomicity (I3) — why atomic_write_text looks the way it does

Temp file in the target's own directory (rename is atomic only within a
filesystem) → write → `sync_all` (fsync BEFORE rename, or a crash can leave
a renamed-but-empty file) → `NamedTempFile::persist`, which is `rename(2)`
on Unix and `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows — plain
`std::fs::rename` fails on Windows when the target exists. The cargo tests
pin all of this; they run on the 3-OS CI matrix because this is exactly the
code that behaves differently per OS.

`rename_path` carries the other two per-OS traps:

- A **case-only rename** (`notes` → `Notes`) hits a destination that already
  "exists" on Windows/macOS because it IS the source. `is_same_entry`
  (device+inode on Unix, canonical path on Windows) separates that from a real
  collision; the same-entry case renames directly, falling back to a two-step
  rename through a `.…rename<n>.tmp` sibling when a filesystem refuses it.
- A **move across filesystems** (a workspace on another drive) has no rename
  primitive: `EXDEV` / `ERROR_NOT_SAME_DEVICE` falls back to the same atomic
  copy `copy_path` uses, then removes the source. Files only — no recursive
  directory copy.

## Build notes

- `tauri::generate_context!` embeds `../dist` at compile time — run
  `pnpm run build` once before any `cargo test`/`clippy` on a fresh clone
  (CI does this; the error otherwise is a confusing "frontendDist path
  doesn't exist").
- Dev loop: `pnpm run tauri dev` (spawns vite + cargo). Rust-only iteration:
  `cargo test` in `src-tauri/` is fast after the first build.
- Logging: `tauri_plugin_log` defaults to TRACE, and no code in this crate
  logs — so that level is pure dependency noise (the explorer's `notify`
  watcher alone emitted ~700k lines in a 90-second dev run). `run()` caps it
  at INFO. `pnpm run tauri:dev:verbose` passes `--verbose` for DEBUG, and
  `MDS_LOG=off|error|warn|info|debug|trace` overrides both.
- Windows needs MSVC Build Tools; Linux needs the webkit2gtk-4.1 stack
  (exact apt list in `.github/workflows/ci.yml`).
- `whisper-rs` builds whisper.cpp from source, which needs **CMake** on
  `PATH` and **libclang** for bindgen. Windows: `winget install
  Kitware.CMake LLVM.LLVM`, then set `LIBCLANG_PATH` to
  `C:\Program Files\LLVM\bin` (the CMake installer adds itself to `PATH`;
  open a new shell). Linux: `apt-get install cmake libclang-dev`. macOS:
  `brew install cmake llvm` and `LIBCLANG_PATH=$(brew --prefix llvm)/lib`.
  Without them cargo fails inside `whisper-rs-sys`'s build script (a
  "could not find cmake" / "Unable to find libclang" message). The first
  build compiles whisper.cpp (~1–2 min); later builds are cached.
  ggml uses `std::filesystem`, which Apple marks unavailable below macOS
  10.15, so `bundle.macOS.minimumSystemVersion` in `tauri.conf.json` is
  pinned to 10.15 — `tauri build` turns it into `MACOSX_DEPLOYMENT_TARGET`,
  and Tauri's own default (10.13) fails the whisper build. A bare
  `cargo build` sets no deployment target, so only a bundle build sees it.
  A real-model engine test exists behind `#[ignore]`:
  `MD_SPECPAD_WHISPER_MODEL=<path to ggml-*.bin> cargo test -- --ignored real_model`.
