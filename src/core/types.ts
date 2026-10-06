/**
 * Shared domain types. This file is the vocabulary of the whole app —
 * read it first.
 *
 * Layering (invariant I9): src/core imports NOTHING from ipc/editors/
 * preview/ui, no DOM types in runtime code, no Tauri. Pure logic only.
 */

import type { PaneNode } from './panes';
import type { ScanPreset, ScanSmoothing } from './whiteboard/scan/types';

/**
 * The edit modes. 'split' = raw editor plus a live preview pane; 'read' = a
 * full-width, read-only rendered view (no editor, optimized for reading). Both
 * 'raw', 'split', and 'read' share the one CM6 source editor under the hood
 * (see core/mode-sync `kindFor`) — 'read' just hides it behind the preview.
 *
 * 'draw' is the whiteboard editor over a `.svg` file. Which modes a given tab
 * may actually use depends on its document family (core/doc-family.ts): a
 * markdown tab offers Raw/Split/Edit/Review, an SVG tab offers Draw/Raw.
 *
 * 'term' is the sentinel mode of a terminal tab — the one mode its family
 * allows. It exists so a terminal tab's `mode` is a real value every switch
 * can see rather than a lie ('raw') every consumer has to special-case; the
 * mode picker and mod+1..4 filter it out for free via `isModeAllowed`.
 *
 * 'tool' is the same idea for a TOOL tab (the git tab): a tab that is neither
 * a document nor a shell. Its own sentinel rather than 'term' so nothing that
 * switches on the mode (the status bar's label, scroll-position stamps)
 * mistakes it for a terminal.
 */
export type EditorMode = 'raw' | 'split' | 'wysiwyg' | 'read' | 'draw' | 'term' | 'tool';

/**
 * 'note'  — an ephemeral Notepad-style tab, backed by a .md file in the
 *           notes dir that the session flusher owns entirely.
 * 'file'  — a user-opened file anywhere on disk; explicit save semantics,
 *           unsaved edits are session-buffered (see core/session).
 * 'image' — a read-only media viewer over `filePath`: an image, or — for an
 *           audio extension (core/audio.ts `isAudioPath`) — the audio player.
 *           Audio reuses this kind rather than adding one so an older build
 *           restoring the manifest degrades to "could not load" instead of
 *           rejecting the whole session. Never written, never buffered; the
 *           flusher only records it in the manifest.
 * 'import' — a foreign document (PDF/DOCX) shown as an inline import card over
 *           `filePath`: offers a one-click "Import as Markdown" (no dialog), or
 *           a link to the already-imported note. Like 'image', it holds no text
 *           and is only recorded in the manifest.
 * 'terminal' — a shell (or several, in a split layout) instead of a document.
 *           Holds no text: like 'image'/'import' it is never note-flushed and
 *           never session-buffered, and the manifest records only the pane
 *           layout needed to respawn it. Desktop only — there is no pty on
 *           Android, so the new-tab menu never offers it there.
 * 'git'   — the source-control panel for ONE repository (its main checkout
 *           and every linked worktree). Holds no text and owns no process:
 *           the manifest records only `{ root, checkout }` (the repository's
 *           main root and the checkout last shown), and restore drops the
 *           tab when that root is no longer a repository. One tab per
 *           repository per window, keyed by the main root. Desktop only —
 *           the git commands are not registered on Android.
 */
export type TabKind = 'note' | 'file' | 'image' | 'import' | 'terminal' | 'git';

export interface CursorPos {
  anchor: number;
  head: number;
}

/** UI-facing tab state held in the tabs store (src/ui builds this in M1). */
export interface TabState {
  /** nanoid; stable for the tab's lifetime, used as the session buffer name. */
  id: string;
  kind: TabKind;
  /** kind='note': backing file in the notes dir. Null until the first non-empty flush. */
  notePath: string | null;
  /** kind='file': the user's file path. */
  filePath: string | null;
  /** User rename override; null = auto-derive from first line (core/title.ts). */
  customTitle: string | null;
  mode: EditorMode;
  /** kind='file': disk mtime at last load/save, baseline for conflict detection. */
  savedMtimeMs: number | null;
  /**
   * kind='file': Live Edit override — true/false forces the mode for this tab,
   * null follows the file's workspace (`WorkspaceEntry.liveEdit`). See
   * core/live-edit.ts for the resolution.
   */
  liveEdit: boolean | null;
}

/**
 * Review-mode side margins. Named modes instead of pixels — each maps to a
 * responsive gutter in preview.css (narrow ≈ near-full-width text, wide ≈ a
 * book-like centered column).
 */
export type ReaderMargins = 'narrow' | 'normal' | 'wide';

/**
 * Editor caret (text cursor) styles. Each maps to a `--caret-width` (and, for
 * 'underscore', a bottom-border geometry) in base.css, keyed off the
 * `data-cursor` attribute on <html>:
 * - 'bar'        — the default vertical bar, a hair thicker than CM's native 1.2px.
 * - 'thin'       — a 1px hairline bar.
 * - 'thick'      — a bold vertical bar.
 * - 'underscore' — an underline caret under the character.
 */
export const CURSOR_STYLES = ['bar', 'thin', 'thick', 'underscore'] as const;

export type CursorStyle = (typeof CURSOR_STYLES)[number];

/**
 * Where a pasted/dropped image is saved, relative to the markdown file it is
 * embedded into:
 * - 'subfolder'     — a folder (named by `imageFolderName`) beside the .md file.
 * - 'sameFolder'    — right next to the .md file, no subfolder.
 * - 'workspaceRoot' — one shared folder (named by `imageFolderName`) at the
 *                     root of the workspace the file belongs to.
 */
export type ImagePasteLocation = 'subfolder' | 'sameFolder' | 'workspaceRoot';

/**
 * Where a document's voice-notes sidecar (`<name>.comments.md`) is kept:
 * - 'workspaceFolder' — one shared folder (named by `voiceNotesFolderName`) at
 *                       the root of the workspace the document belongs to; the
 *                       document's sub-path is mirrored inside it so two files
 *                       with the same name in different folders never collide.
 * - 'nextToFile'      — right beside the document.
 */
export type VoiceNotesLocation = 'workspaceFolder' | 'nextToFile';

/** How desktop voice notes are dictated (see `Settings.desktopDictationEngine`). */
export const DESKTOP_DICTATION_ENGINES = ['auto', 'windowsVoiceTyping', 'whisper'] as const;

export type DesktopDictationEngine = (typeof DESKTOP_DICTATION_ENGINES)[number];

/** How Android voice notes are dictated (see `Settings.androidDictationEngine`). */
export const ANDROID_DICTATION_ENGINES = ['system', 'whisper'] as const;

export type AndroidDictationEngine = (typeof ANDROID_DICTATION_ENGINES)[number];

/**
 * Editor color scheme — the palette family id, chosen independently of light/dark
 * (the `theme` setting still decides light-vs-dark, and OS auto-switching keeps
 * working). A scheme supplies BOTH a light and a dark palette by overriding the
 * ten `--bg`/`--fg`/`--accent`/… variables, keyed off `data-color-scheme` on
 * <html>. Because the whole app (CM6, preview, reader) styles itself only through
 * those variables, switching schemes needs no code beyond flipping the attribute.
 *
 * The id is a free-form string, not a closed union: schemes are pluggable theme
 * files loaded from the themes folder at runtime (see core/theme-plugins.ts,
 * ipc/theme-loader.ts). 'default' is the built-in blue/grey palette in base.css
 * (it has no plugin — the base :root IS its palette); an id with no loaded plugin
 * simply matches no injected block and falls through to that default.
 */
export const DEFAULT_COLOR_SCHEME = 'default';

export type ColorScheme = string;

/**
 * Workspace accent colors — named tokens, not hex, so the palette can be
 * tuned per theme in CSS without touching persisted settings.
 */
export const WORKSPACE_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/**
 * Bundled editor typefaces (all SIL OFL 1.1, shipped via @fontsource; woff2
 * files are only fetched by the WebView when a family is actually used).
 * Display labels and CSS stacks live in ./fonts.ts.
 */
export const EDITOR_FONT_IDS = [
  'fira-code',
  'jetbrains-mono',
  'cascadia-code',
  'source-code-pro',
  'ibm-plex-mono',
  'inconsolata',
  'victor-mono',
] as const;

export type EditorFontId = (typeof EDITOR_FONT_IDS)[number];

/**
 * Terminal cells get their own typeface choice, defaulting to Fira Code
 * rather than following the editor: a terminal is box-drawing, powerline
 * glyphs and column alignment, and a proportional-feeling or narrow face that
 * reads well in prose can wreck a TUI. 'match' opts back into the editor font.
 */
export const TERMINAL_FONT_IDS = ['match', ...EDITOR_FONT_IDS] as const;

export type TerminalFontId = (typeof TERMINAL_FONT_IDS)[number];

/**
 * Typeface for the UI chrome (tabs, sidebar, dialogs — not the note text).
 * 'match' follows the editor font (the app's classic monospace-everywhere
 * look); 'inter' is the bundled Inter sans; 'system' is the OS UI font.
 */
export const UI_FONT_IDS = ['match', 'inter', 'system'] as const;

export type UiFontId = (typeof UI_FONT_IDS)[number];

/**
 * A workspace is just a folder the file explorer lists. The notes dir is the
 * implicit default workspace and is NOT stored here — this array holds only
 * the extra folders the user added (removing one never touches its files).
 */
export interface WorkspaceEntry {
  /** Display name; defaults to the folder's basename when added. */
  name: string;
  /**
   * The workspace root identifier. For a local workspace this is an absolute
   * folder path; for a `kind: 'synced'` workspace it is the opaque scheme-
   * prefixed id `saf://<encodeURIComponent(treeUri)>` the storage router
   * dispatches on (see src/ipc/provider.ts). Never lowercase/normalize a
   * synced id — SAF document ids are case-sensitive.
   */
  path: string;
  /** Accent color, or null for none. */
  color: WorkspaceColor | null;
  /**
   * Live Edit (shared cloud folder): files opened from this workspace save
   * themselves as you type AND merge changes other people save into the
   * editor, three-way, as they arrive (core/live-edit.ts, core/merge.ts).
   * Absent = off.
   */
  liveEdit?: boolean;
  /**
   * Read-only workspace (the bundled documentation): files open pinned to
   * Review mode and the explorer offers no create/rename/move/delete for it.
   */
  readOnly?: boolean;
  /**
   * 'synced' = an Android Storage-Access-Framework folder (Google Drive,
   * OneDrive, an SD card, …) whose ops route through the SafProvider. Absent
   * or 'local' = an ordinary filesystem folder. Persisted so the workspace
   * survives relaunch.
   */
  kind?: 'local' | 'synced';
  /**
   * `kind: 'synced'` only — the durable SAF tree URI whose persisted
   * permission Android re-grants on launch. It is the release handle used when
   * the workspace is removed (releasePersistableUriPermission).
   */
  treeUri?: string;
}

/**
 * Terminal cursor shapes. Deliberately NOT the editor's `CursorStyle`: the
 * renderer speaks block/underline/bar, the CM6 caret speaks bar/thin/thick/
 * underscore, and collapsing the two would mean translating in both
 * directions forever.
 */
export const TERMINAL_CURSOR_STYLES = ['block', 'underline', 'bar'] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

/**
 * What a bell does. There is no audible option — a notepad should not beep.
 *
 * `cursor` is the quiet one, and the default: a bell only changes the shape of
 * the cursor for a moment. Backspacing at an empty prompt (or a completion
 * with nothing left to complete) rings the bell constantly, and answering that
 * with a full-pane flash is what makes terminals irritating to type in.
 */
export const TERMINAL_BELLS = ['off', 'visual', 'cursor'] as const;
export type TerminalBell = (typeof TERMINAL_BELLS)[number];

/** What happens to a pane whose shell exited. */
export const TERMINAL_EXIT_BEHAVIORS = ['close', 'keep'] as const;
export type TerminalExitBehavior = (typeof TERMINAL_EXIT_BEHAVIORS)[number];

/**
 * A terminal launch configuration. `program` unset means the user's login
 * shell, which Rust resolves at spawn time — that way the default profile
 * stays correct on a machine whose `$SHELL` differs from the one these
 * settings were written on.
 */
export interface TerminalProfile {
  id: string;
  name: string;
  /** Unset = the login shell (`default_shell`). */
  program?: string;
  args: string[];
  /** Unset = inherit: a new terminal starts in the active pane's cwd. */
  cwd?: string;
  /** Extra environment on top of the inherited one. */
  env: Record<string, string>;
  /** Per-profile cell-size override, in CSS pixels. Unset = the editor font size. */
  fontSize?: number;
  /**
   * Cell size relative to the editor font, in CSS pixels (`+2` = two pixels
   * larger than the editor, and it keeps following mod+=/-/0). Ignored when
   * `fontSize` is set — an absolute size is an absolute size. The virtual AI
   * profiles use this: an agent's TUI is read, not typed into, and reads
   * better a touch larger than the note beside it.
   */
  fontSizeDelta?: number;
}

/** The profile that runs the login shell. Always present. */
export const SHELL_PROFILE_ID = 'shell';

/**
 * The harnesses (terminal coding agents) the "Harness" new-tab row can launch;
 * which one is active lives in `settings.harness`. The id → command table is
 * `HARNESSES` (core/settings.ts). Order is the preference order the automatic
 * choice walks (`pickDefaultHarness`): Claude first, then ChatGPT, then the
 * rest as listed.
 */
export const HARNESS_IDS = ['claude', 'chatgpt', 'gemini', 'grok', 'copilot', 'opencode'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * What `settings.harness` may hold: a known harness, 'custom' — the
 * user-entered command line in `settings.harnessCustomCommand` — or 'auto',
 * the state a never-configured install starts in. 'auto' resolves against
 * what is actually on PATH (`pickDefaultHarness`) and is replaced by the
 * chosen id the first time a scan finds one, so the pick is made once and
 * stays put.
 */
export type HarnessChoice = HarnessId | 'custom' | 'auto';

/**
 * The VIRTUAL profile id the "Harness" row opens. It is never stored in
 * `terminalProfiles` — `resolveTerminalProfile` synthesizes it from
 * `settings.harness` on demand, so a persisted terminal snapshot naming it
 * respawns whatever agent is configured at restore time.
 */
export const HARNESS_PROFILE_ID = 'harness';

/**
 * What `HARNESS_PROFILE_ID` was called before the row was renamed to Harness.
 * Persisted terminal snapshots written by older versions still name it, so
 * `resolveTerminalProfile` accepts it as an alias forever.
 */
export const LEGACY_HARNESS_PROFILE_ID = 'ai-tui';

/**
 * The virtual profile the Themes menu's "AI theme" row opens: the configured
 * harness, started in the THEMES folder with an opening prompt that has
 * it read the folder's AGENTS.md guide and ask what to change. Synthesized by
 * `resolveTerminalProfile` like `HARNESS_PROFILE_ID`.
 */
export const AI_THEME_PROFILE_ID = 'ai-theme';

/**
 * A terminal tab's persistable layout: enough to respawn the same shells in
 * the same arrangement, and nothing more. Scrollback is never persisted — a
 * restored terminal is a NEW shell in the recorded directory, which is the
 * only honest thing a terminal can restore.
 */
export interface TerminalSnapshot {
  /** The split tree, in the JSON shape `core/panes.ts` round-trips. */
  tree: PaneNode;
  activePaneId: string;
  panes: {
    id: string;
    profileId: string;
    cwd?: string;
    /**
     * The live pty behind this pane, for a HANDOVER snapshot only (a tab
     * dragged into another window): the receiving pane attaches to this
     * shell instead of spawning one. Never persisted — pty ids are
     * per-process, so a stale one from a previous run could name somebody
     * else's shell.
     */
    ptyId?: number;
  }[];
}

export interface Settings {
  /**
   * Schema version of the persisted blob, so a field whose *meaning* changed
   * can be upgraded exactly once (see `SETTINGS_SCHEMA` and `normalizeSettings`).
   * Not user-facing: no dialog field, no reason for anyone to set it by hand.
   */
  schemaVersion: number;
  /** null = platform default: appDataDir()/notes (resolved in src/ipc, not here). */
  notesDir: string | null;
  theme: 'system' | 'light' | 'dark';
  /** Palette family; light-vs-dark still comes from `theme`. Default 'default'. */
  colorScheme: ColorScheme;
  fontSize: number;
  /** Editor/content typeface. Default 'fira-code'. */
  editorFont: EditorFontId;
  /** UI-chrome typeface. Default 'match' (follow the editor font). */
  uiFont: UiFontId;
  defaultMode: EditorMode;
  wordWrap: boolean;
  /** Line-number gutter in the source (CM6) editor. Default off (Notepad feel). */
  lineNumbers: boolean;
  /**
   * Code ligatures (-> as a single glyph) in fonts that carry them
   * (Fira Code, JetBrains Mono, Cascadia Code, Victor Mono). Default on.
   */
  ligatures: boolean;
  readerMargins: ReaderMargins;
  /**
   * Animate scrolling instead of jumping: wheel scrolling glides in every
   * scrollable surface (source editor, preview, wysiwyg, explorer, dialogs)
   * and the terminal viewport eases between lines. Default on.
   */
  smoothScrolling: boolean;
  /** Editor caret shape/weight. Default 'bar'. */
  cursorStyle: CursorStyle;
  /**
   * Ask for confirmation before an in-explorer drag moves a file into another
   * folder (VSCode-style). Default on; unchecking it suppresses the prompt.
   */
  confirmFileMove: boolean;
  /**
   * Live save: automatically write dirty FILE tabs to their own path at the
   * session-flush cadence, instead of only buffering edits until Ctrl+S.
   * Note tabs always autosave regardless. Default off.
   */
  liveSave: boolean;
  /**
   * Automatic update checks: once a week, on/after Sunday (the policy lives in
   * `core/update-schedule.ts`). Informational only — an available update
   * surfaces as the status-bar chip and a Settings button; nothing installs
   * without a click. Default on. Desktop-only in effect (Android updates come
   * from the store).
   */
  autoUpdateCheck: boolean;
  /**
   * Epoch ms of the last update check, automatic OR manual; null if none has
   * run. Not a dialog field — it rides along on the persisted settings so the
   * weekly schedule survives a restart.
   */
  lastUpdateCheck: number | null;
  /**
   * Preview tabs (VSCode-style): single-clicking a file in the explorer opens
   * it in a shared, italic "preview" tab; selecting another file reuses that
   * tab instead of piling up new ones. The preview becomes a permanent tab as
   * soon as you edit it, double-click it in the explorer, or pick "Keep open".
   * Default on; off makes every click open its own persistent tab.
   */
  previewTabs: boolean;
  /**
   * Auto-arrange the tab strip by workspace: tabs whose file lives in the same
   * workspace are kept CONTIGUOUS, in first-opened workspace order, so the
   * colored runs read as bands. Default off — tabs then keep whatever order
   * the user drags them into and only carry their workspace's color cue.
   */
  groupTabsByWorkspace: boolean;
  /** Extra explorer workspaces beyond the default notes dir. */
  workspaces: WorkspaceEntry[];
  /** Accent color of the default (notes dir) workspace, which has no entry above. */
  defaultWorkspaceColor: WorkspaceColor | null;
  /** Where pasted/dropped images land relative to their markdown file. Default 'subfolder'. */
  imagePasteLocation: ImagePasteLocation;
  /**
   * Folder name used by the 'subfolder' and 'workspaceRoot' storage modes
   * (ignored by 'sameFolder'). Default 'images'.
   */
  imageFolderName: string;
  /** Where voice-notes sidecars are kept. Default 'workspaceFolder'. */
  voiceNotesLocation: VoiceNotesLocation;
  /** Folder name used by the 'workspaceFolder' mode. Default 'Voice Notes'. */
  voiceNotesFolderName: string;
  /**
   * Desktop dictation engine for voice notes. 'auto' = Windows voice typing
   * on Windows, else Whisper; 'whisper' = the offline Whisper model on every
   * desktop OS; 'windowsVoiceTyping' = Win+H (Windows only — elsewhere it
   * means no engine). Android ignores it (on-device SpeechRecognizer).
   * Default 'auto'.
   */
  desktopDictationEngine: DesktopDictationEngine;
  /**
   * Android dictation engine for voice notes. 'system' = the on-device
   * SpeechRecognizer (no download, needs whatever the device's recognizer
   * needs); 'whisper' = the offline Whisper model. Desktop ignores it.
   * Default 'system'.
   */
  androidDictationEngine: AndroidDictationEngine;
  /**
   * Manifest id of the Whisper model to transcribe with. Default
   * 'small.en-q5_1'; ids from earlier versions are migrated on load.
   */
  whisperModel: string;
  /**
   * Let whisper.cpp run the model on the GPU (Vulkan on Windows/Linux, Metal
   * on macOS) when the build has one. Off forces the CPU — the escape hatch
   * for a broken driver. Default true.
   */
  whisperUseGpu: boolean;
  /**
   * The first-launch "download the recommended model?" bar has been shown
   * (whatever was answered), so it never is again. Default false.
   */
  whisperSetupOffered: boolean;
  /**
   * Explorer tree shape, persisted so the drawer reopens (and the app relaunches)
   * looking exactly as it was left. Not user-facing settings — no dialog field —
   * they just ride along on the same persisted store.
   *
   * Note the inverted polarity, which mirrors the defaults: workspaces start
   * EXPANDED so this holds the collapsed ones; subfolders start COLLAPSED so
   * `explorerExpandedDirs` holds the open ones.
   */
  explorerCollapsedWorkspaces: string[];
  explorerExpandedDirs: string[];
  /**
   * Workspace roots and folders where the explorer lists EVERY file, not just
   * notes/images/documents (right-click → "Show unsupported files"). Applies
   * to subfolders too — `showAllFilesState` in core/text-files.ts. Default [].
   */
  showAllFilesDirs: string[];
  /**
   * Folders that switch "Show unsupported files" back OFF under a parent that
   * shows them. The nearest switch wins (see `showAllFilesState`). Default [].
   */
  hideUnsupportedDirs: string[];
  /**
   * "Show hidden files": the explorer also lists hidden entries — dot-prefixed
   * names everywhere, plus whatever the OS marks hidden (the Windows hidden
   * attribute, the macOS hidden flag; see Rust `is_hidden_entry`). One global
   * switch, like Finder's Cmd+Shift+. or Explorer's "Hidden items". Default false.
   */
  showHiddenFiles: boolean;
  /**
   * Review mode's "What changed" baseline: the branch a code file is compared
   * against (via `merge-base(HEAD, <branch>)`). Empty — the default — means
   * auto-detect, trying `development`, then `main`, then `master`. A name this
   * checkout does not have falls back to the same auto-detection. Desktop only
   * in effect: Android has no git, and the view hides itself there.
   */
  reviewBaseBranch: string;
  /**
   * Whiteboard-scan panel: last-used quality preset and trace smoothing.
   * Not dialog fields — the scan panel's own selects write them, so the next
   * scan opens the way the previous one was tuned.
   */
  scanPreset: ScanPreset;
  scanSmoothing: ScanSmoothing;

  /*
   * Terminal tabs. Flat `terminal*` fields rather than a nested object,
   * because every other setting here is flat and `normalizeSettings` and the
   * settings dialog both assume that. Desktop-only in effect: Android never
   * opens a terminal tab, so these simply go unread there.
   */
  /** Launch configurations offered by the new-tab menu. */
  terminalProfiles: TerminalProfile[];
  /** Id of the profile a plain "New terminal" uses. */
  defaultTerminalProfile: string;
  /**
   * Which harness the "Harness" new-tab row launches. Default 'auto': the
   * first of `HARNESS_IDS` actually installed, resolved once a PATH scan has
   * run (`ui/stores/harness-availability.ts`).
   */
  harness: HarnessChoice;
  /**
   * The command line the 'custom' Harness choice runs — a program (resolved
   * against `PATH`, or an absolute path) optionally followed by arguments;
   * quotes group values with spaces. Unread unless `harness` is 'custom'.
   */
  harnessCustomCommand: string;
  /**
   * The shell every terminal runs — one choice for the whole app, not one per
   * profile (see `core/terminal-shells.ts`). A program name resolved against
   * `PATH` or an absolute path; empty means the platform default, picked in
   * Rust. A profile that names its own `program` still wins over this.
   */
  terminalShell: string;
  /** Typeface for terminal cells. Default 'fira-code'; 'match' follows the editor. */
  terminalFont: TerminalFontId;
  /** Lines of scrollback kept per pane (0…1,000,000). */
  terminalScrollback: number;
  /** Lines scrolled per wheel notch. */
  terminalScrollLines: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalBell: TerminalBell;
  /** Copy to the clipboard the moment a selection is made (X11 habit). */
  terminalCopyOnSelect: boolean;
  /** Confirm before pasting text that would submit more than one line. */
  terminalConfirmMultilinePaste: boolean;
  /** Let applications write the clipboard through OSC 52. Off: any program
   *  that can print to the terminal could otherwise set it. */
  terminalAllowOscClipboard: boolean;
  /** Alt as an ESC prefix; off makes it a compose key. */
  terminalAltSendsEscape: boolean;
  /** Backspace sends DEL (the xterm default) rather than BS. */
  terminalBackspaceSendsDelete: boolean;
  /** A pane whose shell exited: close it, or keep it showing why. */
  terminalOnExit: TerminalExitBehavior;
  /** Confirm closing a terminal tab or pane whose shell is still alive. */
  terminalConfirmCloseRunning: boolean;
}
