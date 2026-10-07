# src/core/ — Pure logic (the reference implementations live here)

Everything in this directory is DOM-free, Tauri-free, React-free (invariant
I9, lint-enforced) and fully covered by Vitest. These files are **normative**:
their tests define contracts the rest of the app builds on. Extend them;
do not rewrite them.

## What lives here

| File | Status | Role |
| --- | --- | --- |
| `types.ts` | reference | shared vocabulary (TabState, Settings, EditorMode…) |
| `doc-model.ts` | reference | canonical-text document model (I1) |
| `doc-sync.ts` | reference | tab-sync hub: keeps mirror tabs of one file in step (edits, saves, hello) |
| `presenter.ts` | reference | presenter-view messages, slide clamp, stopwatch + elapsed format |
| `diff.ts` | reference | pure line diff (Myers) + side-by-side row builder with intra-line ranges — DiffView now, git integration later. Also `diffToChanges`: the minimal `{from,to,insert}` set turning one text into another, which the CM6 adapter dispatches for every external push so the caret and scroll map through instead of resetting |
| `merge.ts` | reference | three-way line merge for Live Edit (`mergeThreeWay(base, mine, theirs)`): one-sided regions take that side, identical changes are taken once, and a region both sides changed DIFFERENTLY takes THEIRS (disk) — deterministic, so two machines converge instead of ping-ponging, and no duplicate lines. What the local author loses is reported, not hidden: `removed` (ranges of the current text about to go — the red flash), `theirs` (ranges of the merged text that arrived — the green flash) and `lost` (the author's overwritten blocks + where to put them back). `restoreLostBlocks` is the Restore-mine reinsertion. `pickMergeBase(candidates, theirs)` chooses the base among our recent snapshots — the one `theirs` is closest to (changed lines, then words; ties go to the OLDER) — so a sync client's last-writer-wins overwrite of our save is SEEN as a collision rather than read as a plain edit |
| `live-edit.ts` | reference | Live Edit policy: `isLiveEditTab` (per-tab override, else the file's workspace `liveEdit` flag; never notes/images/terminals), `extraLiveWatchDirs` (folders of overridden files outside every workspace root, for the watcher), `LIVE_EDIT_POLL_MS` (the re-read timer that backs up a cloud volume's unreliable change events), `formatClockTime` for the status chip |
| `mode-sync.ts` | reference | mode-switch state machine + WYSIWYG write-back guard (I2) |
| `mode-scroll.ts` | reference | keeping your place across a mode switch: which surface owns a mode's scroll position (`scrollSurfaceFor`), the rendered surfaces' `stampedLineFor(stamps, line)` (the `data-line` block a source line lives in) and the Edit editor's heading mapping (`headingIndexForLine` / `lineForHeadingIndex`, its only shared landmark — ProseMirror nodes carry no line numbers). The 1-based SOURCE LINE is the coordinate all four modes speak; the DOM half is `ui/mode-scroll.ts` plus each surface's `getTopLine` / `scrollToLine` |
| `title.ts` | reference | `deriveTitle` / `slugifyTitle` |
| `comments.ts` | feature | the voice-note sidecar (`<name>.comments.md`): where it lives (`commentsPathFor`), how a note refers to its parent (`noteRefFor`), ids, the line quote, and the v2 parse/serialize. A note may carry an optional `unit` (`showAllFilesState (function)` — the declaration a Review-mode note is about, which outlives line drift), written as a `- unit:` meta line after `time`. `serializeCommentsFile(comments, noteRef, context?)` takes an optional `ReviewContext` and writes `- branch: … (worktree: …)` and `- compared against: … (merge-base …)` under the title; the parser ignores the preamble, so both are free to appear or not, and an unknown `- key: value` line from a newer build is dropped rather than read as transcript. `parseReviewContext(text)` reads those two lines back (so an edit made away from the review keeps them) and `notePathFromSidecar(sidecar, ref)` is `noteRefFor`'s inverse (the overview's way from a found sidecar to its document) |
| `code/vocab.ts` | feature | the voice vocabulary of a code file, from a plain `string[]` of identifiers (no parser needed): `splitIdentifier` (camel/Pascal/snake/SCREAMING/digits → spoken words), `identifierHint(identifiers, maxChars?)` → whisper.cpp's initial prompt ("show all files state, is markdown path, …"), and `snapIdentifiers(text, identifiers)` → the transcript with spoken names replaced by the real, backticked ones plus a `Snap[]` (`{from, to, index}`) that `undoSnap(text, snaps, at)` reverts one at a time. Snapping is deliberately timid — whole-word runs inside one sentence, ≥ 3 letters, a strict `fuzzy.ts` score, longest match wins, and a one-word identifier that is ordinary English (`name`, `path`, `run`… `SNAP_STOP_WORDS`) is never snapped |
| `note-marks.ts` | feature | which review notes belong to which rendered thing, for the Review panes' markers: `notesByBlock(notes, blockLines)` (a markdown block owns the notes from its first line to the next block's), `notesForUnit(notes, unit)` (a code card owns the notes naming its declaration — `unitNoteLabel(unit)`, `name (kind)` — plus label-less notes on its signature line) and `blockLineFor(line, blockLines)` (the block a line falls in, by the same rule — where the inline composer and a reveal go) |
| `notes-overview.ts` | feature | the pure side of "See all review notes": a `NoteDoc` is one sidecar's notes with its resolved document; `filterDocs(docs, query)` (text, quote, declaration or document name), `sortDocs` (A→Z), `newestFirst` (one stream, unreadable times last), `docTitle` / `docLocation(doc, roots)` (the directory under its workspace root), `totalNotes`, and `relativeTime(iso, nowMs)` ("4 min ago" … the date) |
| `dictation-errors.ts` | feature | voice-note dictation failures → what the sheet shows under the mic: title, numbered fix steps, optional note, on Windows the `ms-settings:` page that fixes it, and for Whisper the app's own Settings section (`appSettings`) (`captureErrorFor(code, engine)`, engines `android` / `windows` / `whisper`). Every URI in `SETTINGS_URIS` must be allow-listed for `opener:allow-open-url` in `src-tauri/capabilities/default.json`; a test enforces it |
| `whisper-models.ts` | feature | the pure side of offline Whisper dictation: the recommended model id and `migrateModelId` / `LEGACY_MODEL_IDS` (an earlier manifest's full-precision picks → today's quantized files), `formatBytes` / `speedHint(id, gpu)` / `acceleratorLabel` for the model list, `shouldOfferSetup` (the first-launch download offer's decision), `downloadReducer` (idle → downloading → verifying → done / failed / cancelled — the Settings dialog's progress state), and the capture limits (`WHISPER_SAMPLE_RATE`, `MAX_CAPTURE_SECONDS`, `captureLimitReached`, `concatPcm`) that `ui/pcm-capture.ts` enforces. The manifest itself (files, digests) is Rust's — `src-tauri/src/commands/whisper/models.rs` |
| `error-text.ts` | reference | `errorDetail` / `withErrorDetail`: the one-line reason behind a failed file operation, for the notice the UI shows (cloud drives fail in ways a bare "Could not rename" hides) |
| `heading-mark.ts` | feature | hand-set heading status (right-click a heading in Raw / Split / Edit): the mark is a trailing glyph IN the heading text (`⏳` running, `✅` complete), so it saves with the file and shows everywhere. `parseHeadingLine` / `setHeadingLineMark` work on an ATX line (indent, closing `#` run and CRLF kept; no stacking); `markOfText` / `stripMark` / `withMarkText` on bare heading text for Edit mode; `sectionMarks` gives each heading's section its own mark or the innermost marked ancestor's, so nested text and sub-headings share the indicator. Whether a line IS a heading (not inside a code fence) is the editor's call |
| `workspace-modules.ts` | feature | Initialize Workspace: a module = directive + seed files; `composeAgentsFile` writes the chosen ones between `<!-- module:id -->` markers (refresh in place, remove unticked, leave unknown ids and all outside text alone), `installedModuleIds` reads them back, `userModuleFrom` turns a user `.md` into a module, `planWorkspaceInit` → the writes (seeds create-only unless `refresh`, stubs/`.gitignore` appended to); `RETIRED_MODULE_IDS` (`prompt-status`) go in `knownIds` so a re-run drops their old blocks. Texts live in `workspace-module-texts.ts` |
| `deck-template.ts` | feature | `EXAMPLE_DECK`, the self-explaining Marp presentation both "New › Marp presentation" (written as `presentation.md`, `DECK_TEMPLATE_BASENAME`) and the `marp-decks` workspace module (seeded at `EXAMPLE_DECK_PATH`) hand out — one text so what a person reads and what an agent copies agree; tests pin `isMarpDocument`, the `default` theme, and that it demonstrates what it explains |
| `tab-status.ts` | terminal | agent status glyph in a terminal's OSC title (`✳ `, `◐ `) → activity + the remaining label, for the TabBar badge |
| `settings.ts` | reference | defaults + `normalizeSettings` |
| `update-schedule.ts` | reference | when an AUTOMATIC update check is due: at most once a week and never before Sunday midnight, local time. Clock injected, so the policy is testable without waiting a week |
| `notes-move.ts` | M6 | pure `planNoteMoves` for the notes-dir change flow |
| `window-drop.ts` | M8 | `pickDropWindow`: which window a tab drag released over (containment + focus-recency for overlap), for the cross-window tab drop |
| `doc-family.ts` | reference | which modes a path's document type may use (`.svg` → Raw/Split/Draw, where Split is the source beside the board; any non-note, non-image, non-document file → `code`, Raw + Review) |
| `text-files.ts` | reference | which extensions are text notes (`.md`/`.markdown`/`.txt`, mirrored by Rust `list_dir`), and `showAllFilesState` — whether a folder lists every file: nearest switch wins between `settings.showAllFilesDirs` and `settings.hideUnsupportedDirs`; `toggleShowAllFiles` resets the subfolders below the toggled one |
| `explorer-clipboard.ts` | feature | the file drawer's own cut/copy/paste: `duplicateName` (the free name a pasted duplicate takes — `notes copy.md`, `notes copy 2.md`) and `checkPaste` (a folder into itself, a cut back into its own folder). The clipboard state is `ui/stores/explorer.ts`, the disk work `ui/session/explorer-ops.ts`; the OS clipboard is deliberately not involved — it cannot carry a file list out of a webview |
| `explorer-sort.ts` | reference | the order rows appear in the file drawer: `sortExplorerEntries` (directories first, then files) over `compareEntryNames` — A→Z ignoring case, with digit runs compared as numbers (`note2.md` before `note10.md`) and a deterministic tie-break for names differing only in case. Applied in `ui/session`'s listing dispatch, not in a backend: desktop `list_dir` and the Android SAF listing return different orders (SAF also reports `mtimeMs: 0`), so one comparator over the mapped entries is what makes every workspace look the same everywhere |
| `external-links.ts` | reference | external-link policy: is an href `http(s)`, what host does it really resolve to, how is it shown in the confirmation prompt |
| `external-links.ts` | reference | link policy: is an href external, what host does it REALLY reach, how to elide it for the confirm prompt |
| `whiteboard/` | feature | the `.svg` whiteboard format — see `whiteboard/README.md` |
| `code/` | feature | the parsed model of a code file for Review mode — see the `code/` section below |
| `git/` | feature | the git tab's pure half: `types.ts` (the model — checkouts, status groups, the detail selection, the conflict tracker and the finish-worktree flow's state; wire shapes mirrored from `ipc/commands.ts` field for field) plus the modules the store computes with — status grouping, branch-name/slug validation, the conflict-marker scan, the agent conflict prompt, the finish-flow reducer, worktree planning, diff text helpers, stderr hints, the push progress reader and the remotes rules (each with its own suite) |
| `session/plan-flush.ts` | reference | pure flush planner + executor (I3, I4) |
| `export/doc-source.ts` | feature | shared export vocabulary (`DocSource`, `ExportFormat`) |
| `export/docx.ts` | feature | markdown → .docx (same remark/GFM parse as the preview, mapped onto `docx` objects; images via injected resolver) |
| `export/pdf.ts` | feature | markdown → .pdf via a pure pdfmake doc-definition (same parse/degrades as docx.ts; theme colors via `pdfThemeFromPlugin`; no print dialog) |
| `export/svg-theme.ts` | feature | recolors an embedded .svg onto the export theme's ink/paper (achromatic → theme ramp, chromatic kept) for the HTML and PDF exports; also reads an svg's intrinsic size |
| `session/debounce.ts` | reference | idle+maxWait debouncer with drain semantics |
| `panes.ts` | terminal | the split tree — immutable binary tree of panes, one per terminal tab |
| `smooth-scroll.ts` | terminal | the terminal viewport's scroll physics (renderer/ is the only consumer — DOM surfaces scroll natively, see ui/README): critically damped spring (velocity carries across retargets), the wheel-vs-touchpad classifier, and the notch-unit tracker that makes one notch scroll the same lines on every platform |
| `geometry.ts` | terminal | grid math: pixel size + cell metrics → `{cols, rows}` (never 0×0) |
| `color.ts` | terminal | color math for theming: parse/format hex, mix, adjust, `ensureContrast` (WCAG) |
| `terminal-shells.ts` | terminal | the shells the settings picker offers per desktop OS; `settings.terminalShell` is ONE global choice, not one per profile. `shellKind(program)` names the shell a program is (pwsh / powershell / cmd / bash / zsh / fish / sh) for the two modules below |
| `shell-integration.ts` | terminal | the prompt hook that makes a PLAIN shell report its cwd (OSC 7): per-shell launch extras (`shellIntegrationLaunch`), the bash/zsh script texts the app writes to disk (`SHELL_INTEGRATION_FILES`), and the OSC 7 URL decoder (`pathFromFileUrl`). Never touches a profile naming its own program |
| `shell-commands.ts` | terminal | commands the right-click helpers TYPE into a shell: `cdCommand` / `listCommand` / `quoteCommand` in the shell's own quoting dialect, `relativePath` (Windows: same drive, case-insensitive) and `cdTarget` (relative inside the same workspace, absolute otherwise) |
| `harness-install.ts` | terminal | the install command the Settings dialog's **Install** button types for a missing harness: official routes per harness × OS × available package managers (winget/brew/scoop → own installer → npm, with a Node step when npm is absent), spelled for the shell that runs it (POSIX / pwsh / Windows PowerShell / cmd) |
| `terminal-palette.ts` | terminal | `branding` → 16 ANSI + chrome colors, with a measured contrast floor (AA on light surfaces, where a dark-assuming TUI's text lands); an optional `terminal` block in a theme merges over it. Also `terminalEnvHints` — the `COLORFGBG` light/dark hint a pty is spawned with |

## `code/` — the code model (Review mode)

A `.ts`/`.js` or `.rs` file parsed into one language-neutral `CodeModel`
(`code/model.ts`) that every Review view is a projection of: the card deck,
plain-English signatures, forms, the x-ray fold, the call graph, the flow
charts, change badges and the voice vocabulary (`review_plan.md` §4). Parsing
happens here, in the webview, with Lezer (`@lezer/javascript`, `@lezer/rust`,
`@lezer/lr` — pinned exactly); it is pure, synchronous and Vitest-covered.

| File | Role |
| --- | --- |
| `model.ts` | `CodeModel` · `CodeUnit` (kind, names, `lines`, `signatureLine`, `signature`, `params`, `returns`, `doc`, `fields`, `calls`, `flow`, `children`, `skeleton`) · `Param` · `TypeRef` · `Field` · `FlowNode` (the body as a control-flow tree: `seq`, `if`, `loop`, `switch`, `try`, exits, inner `fn`) · `SkeletonLine` · `ImportGroup`. Also `xrayLines(skeleton, depth, opened?)`, the depth-n x-ray fold that turns deeper runs into `⋯ N lines` markers |
| `parse.ts` | `codeLanguageFor(path)` and `parseCode(text, pathOrExt)` — the only entry points; dispatch on extension, `null` for anything else |
| `ts.ts` / `rust.ts` | the extractors. **These two files are the only ones that know Lezer node names.** Everything downstream works on `CodeModel`, which is what the tests fix |
| `source.ts` | shared by the extractors: line arithmetic, doc-comment stripping, the skeleton depth painter, Lezer tree types (derived from `@lezer/lr`, since `@lezer/common` is transitive) |
| `changes.ts` | `changeMap(base, current, diff)` → the Review badges: a `Map` from unit id to `added` / `changed` / `signature-changed` / `same`, the baseline's `removed` units (the ghost cards), and `changedCount`. Also `changeRanges(diff)` / `deletionGaps(diff)`, the current-text line ranges `core/diff.ts` does not report |
| `calls.ts` | `resolveCalls(model)` → `{ edges }` of caller → callee unit ids: plain names, `new Foo`, `this.x` / `self.x` / `Self::x` inside a class or impl, `Foo.bar` / `Foo::bar`; unresolved callees dropped, deduped. Also `flattenUnits` and `implTargetName` |
| `flow.ts` | `flowGraph(unit)` → nodes / edges / subgraphs from the `FlowNode` tree (§5.2 collapse rules: seq boxes, condition diamonds with yes/no, loops with back edge + `done`, one labelled edge per switch arm, exits as terminals, a `?` as a conditional exit with an `ok` path, inner functions as subgraphs); above `FLOW_NODE_CAP` (60) nodes depth 1 only, `truncated`. `flowHasBranches(flow)` says whether a chart is worth drawing |
| `mermaid-text.ts` | `callGraphMermaid(model, { changed?, focus? })` → `{ text, nodes, focused, omitted, total }` (safe ids, entity-code label escaping, `exported` bold / `changed` amber classes, focus mode = exported + one-hop neighbours above 40 nodes, a 150-node cap) and `flowMermaid(graph)`. Plus `kindGlyph`, `lineCount`, `safeId`, `escapeLabel` |
| `review-state.ts` | `ReviewState` (view · filter · expanded · xrayDepth · xrayOpened · showAll · baseline), `ReviewAction` and the pure `reduceReview` — what the Review pane renders and what its taps report; `ui/stores/code-review.ts` holds one per tab |
| `plain-english.ts` | `describeType` / `describeParam` / `describeUnit`: the template sentence ("*Name* takes …, and gives back …") from table-driven name rules (`NAME_RULES`) and type rules (`TYPE_RULES`). A wrong sentence is a one-row fix with a one-line test |

Rules the tests pin:

- `lines` is 1-based inclusive and starts at the doc comment / attributes;
  `signatureLine` is the declaration itself (where the hold gesture anchors).
- `exported` means `export` in TS (an `export { a }` group counts) and any
  `pub` in Rust; a trait impl's methods are exported through the trait.
- Skeleton depths: signature, doc and closing brace 0; a control-flow keyword
  directly in the body 1; a plain statement (or comment) one deeper than the
  keywords beside it; each nested block one more. So the depth-1 x-ray is
  exactly §2.2's "declarations, signatures, doc comments and top-level
  control flow", and `xrayLines` folds the rest.
- Flow text (conditions, loop headers, arm labels, seq items) is
  whitespace-collapsed and cut at `FLOW_TEXT_MAX` (40) characters. A Rust
  `?` is a conditional `throw` exit.
- `calls` keep the callee's full dotted/pathed text (`this.x`, `Self::x`,
  `foo::bar`, `new Foo`, `name!`); a method on a computed receiver is `.name`.
- Plain English: the NAME rule wins over the type (`dir: string` is "a folder
  path"; a plural name matching a rule is "a list of folders"), `@param`
  overrides both, and an object / resolved struct return is spelled field by
  field. The worked example in `review_plan.md` §2.1 is a verbatim test.
- "What changed" needs BOTH the line diff and the parsed baseline, and
  `changes.ts` keeps the division of labour strict: the diff decides whether a
  surviving unit was touched (its span in the CURRENT text against
  `changeRanges`, plus `deletionGaps` — a pure deletion badges only a unit that
  SPANS the gap, so lines dropped between two declarations badge neither), and
  the two models decide what kind of change it was. Units match by `id`
  (kind + qualified name) and fall back to kind + plain name, so a method that
  moved `impl` blocks is one `changed` unit instead of an addition and a
  removal. `signature-changed` beats `changed` and carries the note — the
  parameter NAME lists and the return type text are compared ("now also takes
  hiddenDirs", "no longer takes b", "now gives back yes or no" through
  `describeType`); a changed parameter TYPE is an ordinary body change. A
  `null` baseline (a file git has never seen) makes every unit `added`;
  baseline units with no match become `removed` ghost cards, outermost only (a
  removed class keeps its methods in its own `children`), and `changedCount`
  counts the badged units plus those ghosts.

## `git/` — the git tab's pure half

Everything the git tab DECIDES lives here; `ui/stores/git.ts` sequences the
IPC and `src-tauri/src/commands/git/` only runs git. Wire shapes are mirrored
from `ipc/commands.ts` field for field in `types.ts` (core imports nothing
from `ipc/`), so an error is matched structurally (`{ code }` on an `Error`).

| File               | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `types.ts`         | the model: `GitCheckout`, `StatusGroups`, `SelectedItem`, `ConflictTracker`, the finish flow's `FinishState` / `FinishStep*` / `FinishBlocker`, and the wire mirrors                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `status.ts`        | `groupStatus(entries)` → the four sections (an `MM` entry is in `staged` AND `unstaged`; an unmerged `u` entry is `conflicted` only; `?` is `untracked`), `dirtyCount`, `statusCounts` / `statusLabel` (`1 conflicted · 2 staged · …`, `clean`), `isTreeClean`, `mergingInto(status, branches)` (the two names of an in-progress merge from `MERGE_HEAD`)                                                                                                                                                                                                                                  |
| `refs.ts`          | `validateBranchName` (`git check-ref-format --branch`: no `..`, `@{`, `//`, control chars or ` ~^:?*[\`, no `.`-led or `.lock`-ended component, no leading `-` or `/`, not `HEAD` / `@`), `validateSlug` (kebab-case, ≤ `SLUG_MAX` 64), `worktreeTarget(mainRoot, slug, {prefix, dir})` → `{path, rel, branch}`, `shortSha`, `formatAheadBehind` (`↑2 ↓1`), `branchForWorktree(checkouts, branch)` (the checkout holding a branch — git refuses to delete or switch to it)                                                                                                                 |
| `checkouts.ts`     | `buildCheckouts(info, summaries)` (main first), `pickSelected(checkouts, remembered, activeWorkspaceDir)` (remembered → the checkout the active workspace lies in → main), `terminalsInside(tabs, checkoutPath, nested?)` by `tab-workspaces.ts`'s `pathKey` prefix rule, `extraGitWatchDirs(repos, watchedRoots)`, `checkoutKey` / `isInsideCheckout`                                                                                                                                                                                                                                      |
| `conflicts.ts`     | DETECT only: `hasConflictMarkers`, `conflictMarkerLines`, `countConflictBlocks` (a block is `<<<<<<<` … [`\|\|\|\|\|\|\|` …] `=======` … `>>>>>>>`; a lone `=======` — a setext underline — is not one; CRLF tolerated), `continueGate(unmergedCount, tracker)` (Continue merge is enabled only when git reports no unmerged entry AND every tracked file scanned clean), `trackerProgress`                                                                                                                                                                                                 |
| `prompts.ts`       | `conflictPrompt({mainRoot, checkoutPath, into, from, files})` — the clipboard text for the user's agent, in the app's agent-brief voice: where, what merges into what, the files, the directive's `KEEP_BOTH_SIDES_RULE` verbatim, and the finishing rule (remove markers, re-verify, `git add` each file, **do not commit** — the user continues from the app); ends in a `Merge-context:` line. Pinned verbatim by its test                                                                                                                                                                 |
| `finish-flow.ts`   | the finish-worktree machine: `FINISH_STEPS` (`merge-base-in` → `verify` → `merge-into-base` → `cleanup` → `remove-worktree` → `delete-branch`), `finishPreflight(facts)` → `FinishBlocker[]`, `createFinishState`, `reduceFinish(state, event)` (start / step-done / step-failed / paused / resume / conflicts / conflicts-cleared / skip / retry / abort), `nextAction(state)` (`run` / `wait` / `stopped` / `done`), `currentStep`, `finishStepLabel`, `recoverFinishState(facts)` (where a restarted tab's repository stands)                                                              |
| `worktree-plan.ts` | `planNewWorktree({mainRoot, slug, prefix, base, openTerminal})` → validated `{path, rel, branch, startPoint, gitignoreLine, terminal}` or `{error}`; `appendMissingLines(existing, lines)` — the `.gitignore` seeding rule, moved here from `workspace-modules.ts`'s `ensureLines` (which now calls it); `WORKTREES_DIR` / `WORKTREES_IGNORE_LINE`                                                                                                                                                                                                                                             |
| `diff-text.ts`     | `normalizeEol`, `isBinaryText` (a NUL in the first 8 000 chars), `eolOnlyDifference` (the "only line endings differ" hint), `diffLabels(selection, {base, branch})` — the two column headers                                                                                                                                                                                                                                                                                                                                                                                                |
| `graph.ts`         | `layoutGraph(commits)` → one `GraphRow` per commit (newest first, as `log --date-order` lists them): the node's lane and colour, `merge`, and the row's edges — `in` (a lane closing into the node), `out` (the node to a parent's lane), `through` (untouched lanes) — by the classic active-lanes sweep: a commit lands in the first lane awaiting it, that lane then awaits its first parent, other parents join a lane already awaiting them or open a new one, lanes never shift sideways; `LANE_COLORS` (8, cycling), `graphWidth(rows)`                                                                                      |
| `decorations.ts`   | `parseDecorations(refs, remotes)` — `%D` items → `CommitRef`s (`HEAD -> x` = current local, `tag: x`, `<remote>/x` by the known remote names so `feat/x` stays local, bare `HEAD` = detached; `<remote>/HEAD` dropped), current first; `remoteNames(branches)`; `foldRemotes(refs, remotes)` → `RefPill`s (a remote mirroring a local on the same commit folds into it as `synced`); `checkoutsAt(checkouts)` — head sha → the worktrees standing there                                                                                                                                                     |
| `hints.ts`         | `networkHint(stderr)` — a first-match table turning a failed fetch / pull / push into one actionable sentence (no credential helper → `git config --global credential.helper manager`, publickey, unresolved host, non-fast-forward, no upstream, protected branch, …), null when it has nothing to say; `gitFailureText(err)` — the status-bar notice for a rejected command (git's own first line for `GIT_FAILED`); `gitHint(err)` (moved here from `ui/code-review-git.ts`, which re-exports it); `errorCode`, `firstGitLine`                                                            |
| `remotes.ts` | the connect flow's rules: `parseRemoteUrl` (a pasted address → the URL git gets, its provider and `owner/name`; a copied page URL — `/tree/…`, `/src/branch/…`, `?tab=` — is trimmed, a profile or bare site is refused in plain words), `validateRemoteName` / `suggestRemoteName` (`origin`, then the provider, then `remote-N`), `publishRemote` (origin, else the first), `remoteBranchNames`, `connectPlan(relation, unborn)` → publish / bring-in (`allowUnrelated` for a server repo made with a README) / first-commit |

Two rules the modules enforce and the tests pin:

- **Nothing types into a terminal.** A failure that would traditionally be
  fixed by running a command is TEXT here (`hints.ts`); the store's only
  terminal call opens a shell or the harness _in a directory_ and takes no
  input. `refs.ts` validates every user string before it reaches git.
- **Conflicts are the agent's.** `prompts.ts` hands them over; `conflicts.ts`
  only detects markers (over the files git reported unmerged, never
  arbitrary files) so the panel can watch resolution happen and gate
  Continue. There is no resolve transform in core and there will not be one.

## Contracts you must not break

1. **DocModel** — the markdown string is the only truth (I1). Subscription
   dispatch is SYNCHRONOUS; echo suppression therefore uses a reentrancy
   flag (pattern in `doc-model.ts` header + `doc-model.test.ts`). Dirty
   tracking is snapshot-per-persistence-kind (`session` vs `file`);
   `markPersistedAs(kind, text)` records a snapshot OTHER than the current
   text — a Live Edit merge sets the `file` snapshot to what disk now holds
   while the editor holds the merged result, so the tab is dirty by exactly
   the lines the next live save must write. Every change of a snapshot pushes
   the outgoing one onto `getPersistedHistory(kind)` (newest first, deduped,
   capped at `PERSISTED_HISTORY_LIMIT`) — the candidates `pickMergeBase`
   chooses from.
2. **Write-back guard** (I2) — WYSIWYG serialization is pushed only after a
   user edit since attach. `detach()` must call `flushSync()`. The
   "mount → look → leave is byte-identical" test is the guarantee users
   feel; treat a change that breaks it as data corruption.
3. **Mode-sync** — transitions serialize on one promise chain; raw⇄split
   never detaches the source editor; failures revert with canonical text
   untouched. Adapters must survive re-attach.
4. **planFlush / executeFlushPlan** — the manifest is written LAST (I4).
   Rename failures are tolerated and redirected; any other IO failure
   aborts BEFORE the manifest. `planFlush` stays pure — if you need more
   information in a plan, add it to `AppSessionView` and pass it in (M2 did
   exactly this with the optional `suppressedRenamePaths`, which lets the
   flusher stop planning a rename it has failed ~3× in a row). Two safety
   rules the planner enforces: a name being renamed away from stays taken
   for the whole plan (the rename may fail and leave the file there), and
   a delete never targets a path the plan writes or any tab points to (a
   tombstone can be stale — Save As onto the note's own file).
5. **Debouncer** — `flushNow()` drains everything requested before the
   call and resolves `true`; a failed run stays dirty and retries on the
   timers. `flushNow()` makes at most one attempt of its own and resolves
   `false` when it fails — never a hot retry loop; callers that hand data on
   must check it. maxWait is armed on the first unflushed request and never
   pushed back.

## Session persistence — how the pieces compose (M2)

```
model change / tab op ──▶ flusher.request()
                              │ (idle 1s or maxWait 5s)
                              ▼
        view = assemble AppSessionView from stores
        plan = planFlush(view)                     ← pure, tested
        result = await executeFlushPlan(plan, ipc) ← manifest last
        apply result.assignedNotePaths + renameFailures to store
        markPersisted('session') on flushed models
        refresh cached existingNoteFiles
```

- `existingNoteFiles` exists so a NEW note never clobbers an on-disk file
  no tab owns. Keep the cache fresh: seed from `ipc.listNotes` at startup,
  update after each flush (you know exactly what you wrote/renamed).
- Rename-failure policy: keep old path, retry next flush; after ~3
  consecutive failures for the same rename, stop planning it (track the
  count in the store tombstone) — the file simply keeps its old name.
- `parseManifest`
  here is the only manifest reader — never `JSON.parse` a manifest anywhere
  else.

## Two-tier data placement (why notes ≠ buffers)

- **Notes dir** = user data. Real `.md` files, human-readable names,
  browsable, syncable. The manifest stores only *metadata* about note tabs.
- **Session dir** (`<appDataDir>/session`) = machine state. `session.json`
  + `buffers/<tabId>.md` for FILE tabs' unsaved edits only.
- Consequence: a lost/corrupt manifest costs tab order, modes and cursors —
  never note content. This property is load-bearing; don't move note
  content into the manifest or buffers.
- A note tab's file lives at the notes dir ROOT — `planFlush` never writes
  one anywhere else, and its NAME follows the tab title. So a note file that
  leaves that directory (dragged into another workspace, or into a
  subfolder) can no longer be a note: the ui side converts the tab to a file
  tab (`tabsStore.adoptMovedNoteAsFile`). Anything that relocates a note file
  owes the same conversion, or the next title change will drag the file back.

## Gotchas

- Slugs are lowercase-ASCII and collision checks are CASE-INSENSITIVE
  (Windows/macOS filesystems). `slugifyTitle` also guards Windows reserved
  basenames (`con`, `nul`, …) — don't "simplify" that away.
- `joinPath` uses `/` even on Windows — Rust's `PathBuf` normalizes. Don't
  introduce a platform-path dependency in core.
- Keep `SessionManifest.schema = 1` until a breaking manifest change ships;
  then bump it and make `parseManifest` migrate or reject old schemas
  explicitly.

## Testing expectations

Every exported function has suite coverage in `__tests__/`. When you extend
a reference file, extend its tests in the same commit. Fake timers for
anything time-based; no sleeps.
