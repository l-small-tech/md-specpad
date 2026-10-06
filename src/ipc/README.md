# src/ipc/ — the Tauri boundary

This directory is the ONLY place `invoke()` and `@tauri-apps/api/*` are
allowed (invariant I9, lint-enforced). Everything above it calls `ipc.*`
wrappers, so the Rust↔TS contract lives in exactly two files that must be
edited together: `commands.ts` here and `src-tauri/src/commands/<area>.rs`
there. The checklist for adding a command is in `src-tauri/README.md`.

## Contracts

- **One wrapper per Rust command, same name.** `read_text_file` →
  `readTextFile`. Argument keys are camelCase in TS and snake_case in Rust;
  Tauri maps between them, so `baseBranch` fills `base_branch`. Wire structs
  carry `#[serde(rename_all = "camelCase")]`, and the TS `interface` beside the
  wrapper mirrors it field for field.
- **`ipc` imports nothing app-local.** Types the rest of the app also needs are
  declared here and re-declared (or structurally matched) in `core` — never
  imported from it.
- **Errors are `{ code, message }`.** `call<T>` turns a rejection into a typed
  `IpcError`; logic switches on `.code`, and `.message` is for logs and the
  status bar only. An unknown or unshaped rejection degrades to `IO`. Adding a
  Rust error variant means adding its code to `IpcErrorCode` *and* to the table
  in `src-tauri/README.md`, same commit.
- **Platform-only commands reject rather than exist.** A command registered
  behind `#[cfg(desktop)]` or `#[cfg(target_os = "android")]` is not in the
  handler on the other platform, so calling it there rejects with a
  "command not found" message (an `IO` `IpcError`). Every such wrapper's doc
  comment names its platform; callers go behind a platform check
  (`isAndroid()`, `dictationEngine()`, …), never a try/catch.
- **Big payloads skip JSON.** Raw bytes travel as the request body
  (`whisperTranscribe`) or as `InvokeResponseBody::Raw` on a `Channel`
  (`ptySpawn`), not as arrays in JSON.

## What else lives here

`provider.ts` (the storage router's local/SAF providers), `paths.ts`
(notes/session dirs per platform), `pty.ts` (the terminal's channel plumbing),
`git-ops.ts` (the git tab's fetch/pull/push channel plumbing),
`settings-store.ts`, `clipboard.ts`, `dialog.ts`, `theme-loader.ts`,
`theme-seed-images.ts`.

## Git (desktop only)

The `git*` wrappers front `src-tauri/src/commands/git/`, which shells out to
the `git` binary on Rust's blocking pool — no libgit2. None of them is
registered on Android. Every call takes `root`, the CHECKOUT to run in (the
main root or a linked worktree's path). Reads are killed at 3 s, mutations at
30 s; the three network commands stream for up to 120 s and can be cancelled.
Nothing ever prompts (`GIT_TERMINAL_PROMPT=0`, stdin closed), and nothing here
types into a terminal: a user string (branch, path, message) travels as one
argv element and Rust refuses anything it will not pass (`GIT_INVALID_ARG`),
so callers validate first with `core/git/refs.ts`.

**Review mode's facts** (`gitRepoInfo`, `gitShowFile`, `gitFileChanges`):

| Wrapper | Answers |
| --- | --- |
| `gitRepoInfo(path, baseBranch?)` | `root`, `mainRoot` (the repository's main checkout — the git tab's identity), `rel`, branch, HEAD, `isWorktree`, the baseline branch and its `merge-base` (`baseRef`), and every worktree |
| `gitShowFile(root, rev, rel)` | the file's text at `rev` (`:0` = index, `HEAD`, a sha), or `null` when it did not exist there |
| `gitFileChanges(root, rel, baseRef, branches)` | per branch, whether its blob for `rel` differs from `baseRef`'s (the worktree radar) |

`baseBranch` is the `reviewBaseBranch` setting; pass it only when non-empty.
A branch the checkout does not have falls back to auto-detection
(`development`, then `main`, then `master`).

**The git tab** (`src/ui/stores/git.ts` is the only caller):

| Wrapper | Does |
| --- | --- |
| `gitStatus(root)` | `status --porcelain=v2` → `GitStatus` (entries, upstream, ahead/behind, `state`, `mergeHead`) |
| `gitBranches(root)` | local + remote branches with tracking |
| `gitLog(root, rev, max, skip, all?)` | a page of commits with their `refs` (`%D` decorations); `all` = every branch, remote branch and tag (+ HEAD) in date order, `rev` ignored (`[]` on an unborn HEAD) |
| `gitCommitFiles(root, sha)` / `gitDiffNames(root, from, to)` | `--name-status` rows of a commit / of `from...to` |
| `gitAheadBehind(root, a, b)` | `rev-list --left-right --count` |
| `gitWorktrees(root, baseBranch?)` | every checkout with dirty counts and ahead/behind the base (the dashboard) |
| `gitCheckIgnore(root, rel)` | is `rel` ignored |
| `gitStage` / `gitUnstage` / `gitDiscard` | file-level `add -A` / `restore --staged` / restore + `clean` |
| `gitCommit(root, message, amend)` | `commit -F <tmp>`; `message` null = `--no-edit` |
| `gitSwitch` / `gitCreateBranch` / `gitDeleteBranch` | branch ops; refusals come back as `GIT_FAILED` with git's text |
| `gitMerge(root, target, noFf)` | → `GitMergeOutcome`; a conflict is the outcome `conflicts`, never an error |
| `gitMergeAbort(root)` | `merge --abort` |
| `gitWorktreeAdd` / `gitWorktreeRemove` | `worktree add [-b]` / `worktree remove [--force]` + `prune` |
| `gitFetch` / `gitPull` / `gitPush` (+ `opId`, channel) | streamed; resolve with `GitNetResult` (`ok:false` + stderr is a result) |
| `gitOpCancel(opId)` | kill that op |

| `code` | Meaning |
| --- | --- |
| `GIT_NOT_FOUND` | no `git` on `PATH` |
| `GIT_NOT_A_REPO` | the path is outside any repository |
| `GIT_UNTRUSTED` | git's "dubious ownership" check refused the repo; `gitTrustDirectory(path)` adds it to `safe.directory` (only after the user confirms) |
| `GIT_TIMEOUT` | git was killed at its mode's limit (a hung network mount, a slow hook) |
| `GIT_FAILED` | git ran and failed; `message` carries its stderr |
| `GIT_CANCELLED` | the user cancelled a fetch / pull / push |
| `GIT_BUSY` | a network op is already running for that repository |
| `GIT_INVALID_ARG` | caller bug: a string Rust would not pass to git (empty, leading `-`, control chars) |

`isGitUnavailable(err)` is true for the first three: all mean "hide the
feature behind a one-line hint", while everything else is worth surfacing.
