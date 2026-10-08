/**
 * One terminal pane: a pty, an engine, a canvas view and an input layer, wired
 * together — the leaf of a terminal tab's split tree.
 *
 * This is the only place the four layers meet — `src/ipc` (bytes), `src/term`
 * (state), `src/renderer` (pixels and input) — and it stays deliberately thin:
 *
 *   pty bytes ─► Terminal.write ─► view.requestRender ─► canvas
 *   keystrokes ─► keymap? ─► TermInput.encode ─► pty.write
 *
 * The pty is spawned once, on mount, and lives as long as the element does
 * (which is why `PaneTree` places panes as keyed SIBLINGS — see its header).
 * `adoptPtyId` is the one exception: a pane whose tab was dragged in from
 * another window ATTACHES to the shell that is already running instead of
 * starting one, and the backend replays what it buffered so the screen comes
 * back as it was. The mirror of that is teardown — a pane whose session was
 * released (`consumePaneRelease`) detaches rather than killing its shell.
 * Everything else — settings, theme, font zoom — is applied to the live
 * objects by a second effect, so changing a setting never restarts a shell.
 * Actions the pane cannot service itself (new tab, palette, splits) go up
 * through `runShortcutAction`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { isDarkColor } from '../../core/color';
import {
  harnessName,
  profileFontSize,
  resolveTerminalProfile,
  terminalProgram,
} from '../../core/settings';
import {
  cdCommand,
  cdTarget,
  fileManagerName,
  listAllCommand,
  listCommand,
  openFolderCommand,
  quoteCommand,
  searchCommand,
  upCommand,
  type SearchTarget,
} from '../../core/shell-commands';
import { pathFromFileUrl, withShellIntegration } from '../../core/shell-integration';
import { terminalEnvHints } from '../../core/terminal-palette';
import { shellKind, type ShellKind } from '../../core/terminal-shells';
import { HARNESS_PROFILE_ID, type Settings, type TerminalProfile } from '../../core/types';
import { getClipboard } from '../../ipc/clipboard';
import { pickDirectory } from '../../ipc/dialog';
import { getPtyProvider, type PtyHandle } from '../../ipc/pty';
import { TermInput, TermView, type TerminalTheme } from '../../renderer';
import { Terminal } from '../../term';
import { runShortcutAction } from '../commands';
import { registerPaneActions, runPaneAction, type PaneAction } from '../pane-actions';
import {
  detectPlatform,
  keyEventToAction,
  type ShortcutAction,
  type TerminalScroll,
} from '../keymap';
import { isExternalHref } from '../../core/external-links';
import { desktopOs } from '../platform';
import { shellIntegrationFor } from '../shell-integration';
import { defaultShellStore } from '../stores/default-shell';
import { consumePaneRelease } from '../stores/terminals';
import { externalLinkStore } from '../stores/external-link';
import { currentFont } from '../terminal-theme';
import { workspaceRoots } from '../workspace-cues';

/** Inset between the pane edge and the first cell, in CSS pixels. */
const PADDING = 8;
/** Font zoom bounds, as steps away from the configured size. */
const MIN_ZOOM = -8;
const MAX_ZOOM = 24;
/** How long the visual bell flashes. */
const BELL_MS = 120;
/**
 * How long the cursor bell holds its shape. Longer than the flash on purpose:
 * a flash is loud enough to register in a frame or two, a change of shape has
 * to sit still long enough to be noticed without being looked for.
 */
const BELL_CURSOR_MS = 400;
/**
 * `initialInput` is typed once the shell has gone quiet: a shell announces
 * itself in a burst (banner, then the prompt a beat later), and text sent
 * mid-burst can land before the line editor is listening. So the write waits
 * for the first output and then for this long without any more.
 */
const INITIAL_INPUT_SETTLE_MS = 300;
/** …but no longer than this after spawn, in case a shell prints nothing at all. */
const INITIAL_INPUT_MAX_WAIT_MS = 4000;

const platform = detectPlatform(typeof navigator === 'undefined' ? '' : navigator.platform);

export interface TerminalPaneProps {
  paneId: string;
  profile: TerminalProfile;
  settings: Settings;
  /**
   * The palette to paint with, already resolved for the active theme. Resolved
   * by the app rather than read from the DOM here: the renderer takes numbers,
   * and one pane must never see a different theme than another.
   */
  theme: TerminalTheme;
  /** True when this is the focused pane of the frontmost tab. */
  active: boolean;
  /** Where to start: a restored or inherited working directory. */
  cwd?: string | null;
  /**
   * A line to type into the shell once it is ready, Enter included (the
   * Settings dialog's Install button). Read once, at spawn — see the store
   * field of the same name for why it is transient.
   */
  initialInput?: string | null;
  /** `initialInput` has been written; the owner forgets it so it is never sent twice. */
  onInitialInputSent?: () => void;
  /**
   * A live pty to take over instead of spawning a shell: this pane's tab was
   * handed over from another window. Read once, at mount; a shell that is
   * gone by then (NOT_FOUND) falls back to a fresh spawn.
   */
  adoptPtyId?: number | null;
  /** The pty this pane ended up on — null once it has none. */
  onPty?: (ptyId: number | null) => void;
  onTitle: (title: string) => void;
  onCwd: (cwd: string) => void;
  /** The child exited; the app decides whether the pane closes (settings). */
  onExit: (code: number) => void;
  /** The user interacted with this pane — it should become the focused one. */
  onFocus: () => void;
}

/** True for an element a user may be typing into — never steal its focus. */
function isTextField(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/** What the right-click menu needs to know at the moment it opens. */
interface MenuState {
  x: number;
  y: number;
  /** Whether Copy has anything to copy; the selection cannot change while the menu is up. */
  hasSelection: boolean;
  /**
   * A full-screen program (an agent TUI, vim) holds the alternate screen: the
   * shell helpers are hidden then, since typing `cd` into vim helps nobody.
   */
  altScreen: boolean;
}

export function TerminalPane({
  paneId,
  profile,
  settings,
  theme,
  active,
  cwd,
  initialInput,
  onInitialInputSent,
  adoptPtyId,
  onPty,
  onTitle,
  onCwd,
  onExit,
  onFocus,
}: TerminalPaneProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TermView | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const inputRef = useRef<TermInput | null>(null);
  const handleRef = useRef<PtyHandle | null>(null);

  const [status, setStatus] = useState<string | null>('starting…');
  const [bell, setBell] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** Font zoom, in steps from the configured size. Per pane, not persisted. */
  const [zoom, setZoom] = useState(0);
  /**
   * Which shell this pane runs — known once the spawn has resolved the
   * program; null for anything that is not a plain shell (an agent TUI, a
   * profile with its own program) and therefore gets no shell helpers.
   */
  const [paneShell, setPaneShell] = useState<ShellKind | null>(null);

  // Props the long-lived objects read: kept in a ref so a new callback identity
  // (every render, in practice) never tears down a pty.
  const latest = useRef({
    profile,
    settings,
    theme,
    cwd,
    initialInput,
    onInitialInputSent,
    adoptPtyId,
    onPty,
    onTitle,
    onCwd,
    onExit,
    onFocus,
  });
  useEffect(() => {
    latest.current = {
      profile,
      settings,
      theme,
      cwd,
      initialInput,
      onInitialInputSent,
      adoptPtyId,
      onPty,
      onTitle,
      onCwd,
      onExit,
      onFocus,
    };
  });

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }
    const {
      profile: initialProfile,
      settings: initialSettings,
      theme: initialTheme,
      cwd: initialCwd,
      initialInput: pendingInput,
      adoptPtyId: adoptedPty,
    } = latest.current;

    let disposed = false;
    // Set by the cleanup below: this pane's session was released, so its pty
    // belongs to another window now. A handle that arrives after that (the
    // spawn/attach was still in flight) is let go of, not killed.
    let released = false;
    let bellTimer: ReturnType<typeof setTimeout> | null = null;
    // The one-shot `initialInput`: armed by the first output, re-armed by each
    // further chunk, fired when the shell has been quiet for a moment.
    let inputSent = false;
    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    let inputDeadline: ReturnType<typeof setTimeout> | null = null;
    function sendInitialInput(): void {
      if (inputSent || disposed || !pendingInput) {
        return;
      }
      inputSent = true;
      if (inputTimer) {
        clearTimeout(inputTimer);
      }
      if (inputDeadline) {
        clearTimeout(inputDeadline);
      }
      void handleRef.current?.write(`${pendingInput}\r`);
      latest.current.onInitialInputSent?.();
    }
    function armInitialInput(): void {
      if (inputSent || !pendingInput) {
        return;
      }
      if (inputTimer) {
        clearTimeout(inputTimer);
      }
      inputTimer = setTimeout(sendInitialInput, INITIAL_INPUT_SETTLE_MS);
    }
    // The view sizes the engine from the element, so the pty is spawned with
    // the grid that is actually on screen — no initial 80×24 redraw.
    const term = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: initialSettings.terminalScrollback,
    });
    const view = new TermView(surface, {
      terminal: term,
      theme: initialTheme,
      font: (() => {
        const font = currentFont(initialSettings.terminalFont);
        return { ...font, size: profileFontSize(initialProfile, font.size) };
      })(),
      padding: PADDING,
      cursorStyle: initialSettings.terminalCursorStyle,
      cursorBlink: initialSettings.terminalCursorBlink,
      smoothScroll: initialSettings.smoothScrolling,
    });
    // Seed OSC 10/11/12 so an application querying the background color learns
    // the theme's, and gets light/dark detection right. The theme effect below
    // re-seeds on every change, which is also what pushes a DEC 2031 report to
    // a subscribed TUI when the user switches between a light and a dark theme.
    view.setTheme(initialTheme);
    termRef.current = term;
    viewRef.current = view;

    const input = new TermInput(surface, {
      terminal: term,
      view,
      write: (data) => void handleRef.current?.write(data),
      // The keymap gets every key first; only what it declines is encoded.
      keymap: (event) => {
        const action = keyEventToAction(event, platform, 'terminal');
        if (!action) {
          return false;
        }
        // Ctrl+C is SIGINT first and copy second: with nothing selected the
        // chord is declined here and encoded for the shell like any other key.
        // The shifted form always copies, so the terminal convention still has
        // an unconditional route.
        if (action.type === 'terminal-copy' && !event.shiftKey && !input.hasSelection) {
          return false;
        }
        runAction(action);
        return true;
      },
      copyOnSelect: initialSettings.terminalCopyOnSelect,
      altSendsEscape: initialSettings.terminalAltSendsEscape,
      backspaceSendsDelete: initialSettings.terminalBackspaceSendsDelete,
      scrollLines: initialSettings.terminalScrollLines,
      confirmPaste: (text) => confirmMultilinePaste(text),
      // The system clipboard, not the web view's — see src/ipc/clipboard.ts.
      clipboard: getClipboard(),
      // Whether Copy is worth offering, and whether a shell prompt is even
      // there to type at, are decided when the menu opens: neither can change
      // while it is up.
      onContextMenu: (event) =>
        setMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: input.hasSelection,
          altScreen: term.altScreen,
        }),
    });
    inputRef.current = input;

    async function confirmMultilinePaste(text: string): Promise<boolean> {
      if (!latest.current.settings.terminalConfirmMultilinePaste) {
        return true;
      }
      const lines = text.split('\n').length;
      try {
        return await confirm(
          `Paste ${lines} lines into the terminal? Everything after the first newline runs immediately.`,
          { title: 'Paste', kind: 'warning' },
        );
      } catch {
        // Outside a Tauri webview there is no native dialog; don't block.
        return true;
      }
    }

    /** Actions this pane owns; the rest go up to the app shell. */
    function runAction(action: ShortcutAction | PaneAction): void {
      switch (action.type) {
        case 'terminal-send':
          // Typed as keystrokes (not a paste): a shell with bracketed paste on
          // would otherwise hold the trailing Enter as a literal newline.
          void handleRef.current?.write(action.text);
          input.focus();
          return;
        case 'terminal-copy':
          // Clearing after a copy is what makes Ctrl+C safe to bind: the next
          // one finds no selection and goes to the shell as SIGINT.
          void input.copySelection().then((copied) => {
            if (copied) {
              input.clearSelection();
            }
          });
          return;
        case 'terminal-paste':
          void input.pasteFromClipboard();
          return;
        case 'terminal-select-all':
          input.selectAll();
          return;
        case 'terminal-clear-scrollback':
          term.clearScrollback();
          view.refresh();
          return;
        case 'terminal-scroll':
          scroll(action.to);
          return;
        // Font zoom is per-pane, not the app-wide editor font size: zooming a
        // shell to read a wide table must not reflow every open note.
        case 'font-inc':
          setZoom((current) => Math.min(MAX_ZOOM, current + 1));
          return;
        case 'font-dec':
          setZoom((current) => Math.max(MIN_ZOOM, current - 1));
          return;
        case 'font-reset':
          setZoom(0);
          return;
        default:
          runShortcutAction(action);
          return;
      }
    }

    function scroll(to: TerminalScroll): void {
      switch (to) {
        case 'lineUp':
          scrollBy(1);
          return;
        case 'lineDown':
          scrollBy(-1);
          return;
        case 'pageUp':
          scrollBy(term.rows - 1);
          return;
        case 'pageDown':
          scrollBy(-(term.rows - 1));
          return;
        case 'top':
          scrollBy(term.scrollbackLength);
          return;
        case 'bottom':
          view.scrollToBottom();
          return;
      }
    }

    function scrollBy(lines: number): void {
      view.scrollLines(lines);
    }

    term.setHandlers({
      title: (value) => latest.current.onTitle(value),
      cursorStyle: (style, blink) => view.setCursorStyle(style, blink),
      cwd: (url) => {
        const path = pathFromFileUrl(url);
        if (path) {
          latest.current.onCwd(path);
        }
      },
      bell: () => {
        const mode = latest.current.settings.terminalBell;
        if (mode === 'off') {
          return;
        }
        if (bellTimer) {
          clearTimeout(bellTimer);
        }
        // Backspace at an empty prompt and completion with nothing left to
        // complete both ring on every keystroke, so the quiet answer is the
        // default: change the cursor's shape, never flash the pane.
        if (mode === 'cursor') {
          view.setBellCursor(true);
          bellTimer = setTimeout(() => view.setBellCursor(false), BELL_CURSOR_MS);
          return;
        }
        // Clear a cursor bell the setting may have interrupted mid-ring.
        view.setBellCursor(false);
        setBell(true);
        bellTimer = setTimeout(() => setBell(false), BELL_MS);
      },
      clipboard: (base64) => {
        // OSC 52 lets *any* program that can write to this terminal set the
        // clipboard, so it stays behind a setting.
        if (!latest.current.settings.terminalAllowOscClipboard) {
          return;
        }
        try {
          const text = new TextDecoder().decode(
            Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
          );
          void getClipboard().write(text);
        } catch {
          // A malformed payload is the application's bug, not ours.
        }
      },
    });
    registerPaneActions(paneId, (action: PaneAction) => runAction(action));
    // The engine's answers to the queries a shell asks — `report`, not
    // `write`, because a handover replay carries queries that were already
    // answered in the window this shell came from (see `PtyHandle.report`).
    const offData = term.onData((bytes) => void handleRef.current?.report(bytes));
    const offResize = view.onResize(({ cols, rows }) => {
      void handleRef.current?.resize(cols, rows);
    });

    // The profile's directory wins over the inherited one: a profile that names
    // a project directory means it, wherever the tab was opened from.
    const startCwd = initialProfile.cwd ?? initialCwd;
    // Unset = the platform default, resolved in Rust at spawn time.
    const program = terminalProgram(initialSettings, initialProfile);

    /** Take the handle, or let go of it if the pane died while we waited. */
    function keep(handle: PtyHandle): boolean {
      if (disposed) {
        void (released ? handle.detach() : handle.kill());
        return false;
      }
      handleRef.current = handle;
      latest.current.onPty?.(handle.id);
      setStatus(null);
      return true;
    }

    const handlers = {
      onData: (bytes: Uint8Array) => {
        term.write(bytes);
        view.requestRender();
        armInitialInput();
      },
      onExit: (code: number) => {
        setStatus(code === 0 ? 'shell exited' : `shell exited (${code})`);
        latest.current.onExit(code);
      },
      // The pty is drained and reaped: there is nothing left to hand to
      // another window, so the pane stops advertising one.
      onClose: () => latest.current.onPty?.(null),
    };

    void (async () => {
      // A tab dragged in from another window brings its shell with it: attach
      // to the running pty, which replays its recent output into this fresh
      // engine. A pty that is gone (the shell exited, or the id outlived the
      // app that minted it) falls through to a normal spawn.
      if (typeof adoptedPty === 'number') {
        try {
          // Which shell this is, for the context menu's helpers: resolved the
          // same way the spawn path does, minus the integration it already
          // has (this shell was launched with it, in the other window).
          if (initialProfile.program === undefined) {
            const resolved = terminalProgram(initialSettings, initialProfile);
            setPaneShell(shellKind(resolved ?? (await defaultShellStore.getState().resolve())));
          }
          if (disposed) {
            return;
          }
          // The grid goes WITH the attach: the backend resizes the shell
          // before replaying, so the replay is drawn for THIS pane and the
          // shell is not left running at the size of the window the tab came
          // from. Any later size change rides the normal resize path.
          const handle = await getPtyProvider().attach(adoptedPty, view.gridSize, handlers);
          keep(handle);
          return;
        } catch {
          // Fall through and start a shell, which beats an empty pane.
        }
        if (disposed) {
          return;
        }
      }
      try {
        // Shell integration — the prompt hook that reports `cd` (OSC 7) and
        // lets the tab wear its workspace's color — goes ONLY to a plain
        // shell profile: one naming no program of its own, so the app's Shell
        // setting or the platform default decides. An agent TUI, ssh, or a
        // hand-configured profile is spawned exactly as written.
        let launch = { args: initialProfile.args, env: initialProfile.env };
        let kind: ShellKind | null = null;
        if (initialProfile.program === undefined) {
          kind = shellKind(program ?? (await defaultShellStore.getState().resolve()));
          if (kind) {
            launch = withShellIntegration(launch, await shellIntegrationFor(kind));
          }
        }
        if (disposed) {
          return;
        }
        setPaneShell(kind);
        const handle = await getPtyProvider().spawn(
          {
            ...view.gridSize,
            ...(program ? { program } : {}),
            args: launch.args,
            ...(startCwd ? { cwd: startCwd } : {}),
            // The light/dark hint goes FIRST so shell integration and, above
            // all, a profile that sets the same variable override it — a
            // user's own env is never second-guessed.
            env: {
              ...terminalEnvHints(isDarkColor(initialTheme.background)),
              ...launch.env,
            },
          },
          handlers,
        );
        if (!keep(handle)) {
          return;
        }
        if (pendingInput) {
          inputDeadline = setTimeout(sendInitialInput, INITIAL_INPUT_MAX_WAIT_MS);
        }
      } catch (error) {
        setStatus(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    return () => {
      disposed = true;
      // Asked exactly once, whether or not the pty has arrived yet: a released
      // pane is moving to another window, not closing.
      released = consumePaneRelease(paneId);
      if (bellTimer) {
        clearTimeout(bellTimer);
      }
      if (inputTimer) {
        clearTimeout(inputTimer);
      }
      if (inputDeadline) {
        clearTimeout(inputDeadline);
      }
      registerPaneActions(paneId, null);
      offResize();
      offData();
      input.dispose();
      view.dispose();
      // Let go of a released pane's pty so the shell keeps running and the
      // window that adopted the tab can attach to it; kill a closing one's.
      const handle = handleRef.current;
      if (handle) {
        void (released ? handle.detach() : handle.kill());
      }
      handleRef.current = null;
      inputRef.current = null;
      viewRef.current = null;
      termRef.current = null;
    };
    // `paneId` is fixed for the life of an element (it is the React key), so
    // this effect runs exactly once: one pane, one pty.
  }, [paneId]);

  // Settings, profile, theme and zoom applied to the live objects. Everything
  // here is idempotent, so re-running it on any change is safe — which is what
  // makes a theme switch a repaint rather than a shell restart.
  useEffect(() => {
    const view = viewRef.current;
    const input = inputRef.current;
    const term = termRef.current;
    if (!view || !input || !term) {
      return;
    }
    const font = currentFont(settings.terminalFont);
    view.setFont({ ...font, size: Math.max(1, profileFontSize(profile, font.size) + zoom) });
    view.setCursorStyle(settings.terminalCursorStyle, settings.terminalCursorBlink);
    view.setSmoothScroll(settings.smoothScrolling);
    view.setTheme(theme);
    term.setScrollbackLimit(settings.terminalScrollback);
    input.configure({
      copyOnSelect: settings.terminalCopyOnSelect,
      altSendsEscape: settings.terminalAltSendsEscape,
      backspaceSendsDelete: settings.terminalBackspaceSendsDelete,
      scrollLines: settings.terminalScrollLines,
    });
  }, [settings, profile, theme, zoom]);

  // Focus follows the store: exactly one pane holds the keyboard, and a pane in
  // a background tab must never take it.
  //
  // Focusing TWICE is deliberate. Activating a tab from the strip happens on
  // `pointerdown`, so this effect runs before the compatibility `mousedown` —
  // whose default action moves focus to the nearest focusable ancestor of the
  // (unfocusable) tab, i.e. off our textarea and onto the body. The pane's own
  // input layer dodges that by preventing the default (see renderer/input.ts);
  // the tab strip cannot, since it must stay a plain click target. So the
  // focus is re-asserted on the next frame, after every default action of the
  // click that activated us has run. The same re-assert covers menus and the
  // palette, which hand focus back when they close.
  useEffect(() => {
    if (!active) {
      return;
    }
    inputRef.current?.focus();
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.focused) {
        return;
      }
      // Never yank focus out of an open text field (App.tsx applies the same
      // rule): a rename input over a terminal tab must get to keep it.
      if (isTextField(document.activeElement)) {
        return;
      }
      input.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // Ctrl/Cmd-click opens a link; plain clicks belong to the selection.
  const onClick = useCallback((event: React.MouseEvent) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    const link = viewRef.current?.hoveredLink;
    if (!link) {
      return;
    }
    event.preventDefault();
    // Same confirm-then-open path as a markdown link: a URL detected in
    // terminal output is no more trustworthy than one in a document — and an
    // OSC 8 hyperlink can carry any scheme, so only http(s) may reach the OS.
    if (!isExternalHref(link.uri)) {
      return;
    }
    externalLinkStore.getState().request(link.uri);
  }, []);

  const classes = ['term-pane'];
  if (active) {
    classes.push('term-pane-active');
  }
  if (bell) {
    classes.push('term-pane-bell');
  }

  return (
    <div
      className={classes.join(' ')}
      data-pane-id={paneId}
      onClick={onClick}
      // Clicking anywhere in the pane focuses it (and its hidden textarea), so
      // the pane itself never needs to be focusable.
      onPointerDown={() => {
        onFocus();
        inputRef.current?.focus();
      }}
    >
      <div className="term-surface" ref={surfaceRef} />
      {status ? <div className="term-status">{status}</div> : null}
      {/* Outside `.term-surface` on purpose: that element is the input layer's
          host, and a menu inside it would hand every click to the selection. */}
      {menu && (
        <PaneMenu
          menu={menu}
          paneId={paneId}
          // Helpers only at a shell prompt: a plain shell, not showing a
          // full-screen program.
          shell={menu.altScreen ? null : paneShell}
          cwd={cwd ?? null}
          settings={settings}
          onClose={() => {
            // Focus inside the menu (the search form's field) would fall to
            // the body when it unmounts; hand it back to the shell instead.
            if (document.activeElement?.closest('.term-pane-menu')) {
              inputRef.current?.focus();
            }
            setMenu(null);
          }}
          mac={platform === 'mac'}
        />
      )}
    </div>
  );
}

/**
 * The pane's right-click menu, in this app's menu idiom (see TabBar's
 * `TabContextMenu`). Every item runs through the pane's registered action
 * runner rather than a second copy of the switch: "Copy" from the menu, from
 * the palette and from Ctrl+Shift+C have to be one implementation.
 *
 * With `shell` set the menu also carries the SHELL HELPERS — items that type
 * an ordinary command at the prompt (and press Enter) so a user who finds the
 * shell intimidating can watch what they would have typed: change directory
 * through the OS folder picker or up one, list the files (hidden ones too),
 * search by regex, open the folder in the file manager, start the AI agent.
 * The tooltips spell the command out; that is the teaching. The two searches
 * need a pattern, so they turn the menu into a small form (`SearchPrompt`)
 * that shows the exact command as it is typed.
 */
function PaneMenu({
  menu,
  paneId,
  shell,
  cwd,
  settings,
  onClose,
  mac,
}: {
  menu: MenuState;
  paneId: string;
  /** The plain shell at the prompt, or null when the helpers do not apply. */
  shell: ShellKind | null;
  /** The pane's current working directory, as far as the app knows. */
  cwd: string | null;
  settings: Settings;
  onClose: () => void;
  mac: boolean;
}) {
  /** Set while the menu is the search form instead of the item list. */
  const [search, setSearch] = useState<SearchTarget | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the menu on screen: opened near the bottom or right edge it would
  // spill out of the window (more so now that it is taller, and again when it
  // turns into the search form).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) {
      return;
    }
    const margin = 4;
    const rect = el.getBoundingClientRect();
    const left = Math.max(margin, Math.min(menu.x, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(menu.y, window.innerHeight - rect.height - margin));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [menu.x, menu.y, search]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const chord = (letter: string) => (mac ? `⇧⌘${letter}` : `Ctrl+Shift+${letter}`);

  function run(action: PaneAction) {
    onClose();
    runPaneAction(paneId, action);
  }

  function global(action: ShortcutAction) {
    onClose();
    runShortcutAction(action);
  }

  /** Type a command at the prompt and press Enter. */
  function type(command: string) {
    onClose();
    runPaneAction(paneId, { type: 'terminal-send', text: `${command}\r` });
  }

  async function changeDirectory(kind: ShellKind) {
    onClose();
    const picked = await pickDirectory(cwd, 'Change directory');
    if (!picked) {
      return;
    }
    // Relative inside the workspace the shell is already in (`cd ..\docs`),
    // absolute anywhere else — the spelling a person would choose.
    const os = desktopOs() === 'windows' ? 'windows' : 'posix';
    const target = cdTarget(cwd, picked, workspaceRoots(), os);
    runPaneAction(paneId, {
      type: 'terminal-send',
      text: `${cdCommand(kind, target.path)}\r`,
    });
  }

  // The agent the "Open <agent>" helper starts: the configured harness's
  // command line, quoted for this shell. Hidden while unconfigured (a custom
  // harness with an empty command has no program).
  const agentProfile = resolveTerminalProfile(settings, HARNESS_PROFILE_ID);
  const agent =
    shell && agentProfile.program
      ? {
          name: harnessName(settings),
          command: quoteCommand(shell, agentProfile.program, agentProfile.args),
        }
      : null;

  const os = desktopOs();

  if (shell && search) {
    return (
      <div
        ref={rootRef}
        className="tab-menu term-pane-menu"
        role="dialog"
        aria-label={search === 'names' ? 'Find files by name' : 'Search in files'}
        style={{ left: menu.x, top: menu.y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <SearchPrompt shell={shell} target={search} onRun={type} onCancel={onClose} />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="tab-menu term-pane-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className="tab-menu-item"
        role="menuitem"
        disabled={!menu.hasSelection}
        onClick={() => run({ type: 'terminal-copy' })}
      >
        Copy<span className="tab-menu-chord">{chord('C')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => run({ type: 'terminal-paste' })}
      >
        Paste<span className="tab-menu-chord">{chord('V')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => run({ type: 'terminal-select-all' })}
      >
        Select all<span className="tab-menu-chord">{chord('A')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => run({ type: 'terminal-clear-scrollback' })}
      >
        Clear scrollback<span className="tab-menu-chord">{chord('K')}</span>
      </button>
      {shell && (
        <>
          <div className="tab-menu-sep" role="separator" />
          <button
            className="tab-menu-item"
            role="menuitem"
            title={`Pick a folder, then type ${cdCommand(shell, '<folder>')} — the shell moves there`}
            onClick={() => void changeDirectory(shell)}
          >
            Change directory…
          </button>
          <button
            className="tab-menu-item"
            role="menuitem"
            title={`Type ${upCommand()} — move to the folder that contains this one`}
            onClick={() => type(upCommand())}
          >
            Up a folder
          </button>
          <button
            className="tab-menu-item"
            role="menuitem"
            title={`Type ${listCommand(shell)} — show the files in the current folder`}
            onClick={() => type(listCommand(shell))}
          >
            List files
          </button>
          <button
            className="tab-menu-item"
            role="menuitem"
            title={`Type ${listAllCommand(shell)} — list the files, hidden ones (.git, .env…) included`}
            onClick={() => type(listAllCommand(shell))}
          >
            Show hidden files
          </button>
          <button
            className="tab-menu-item"
            role="menuitem"
            title={`Type a regular expression, then ${searchCommand(shell, '<regex>', { target: 'contents', matchCase: false })} — every matching line in this folder and below`}
            onClick={() => setSearch('contents')}
          >
            Search in files…
          </button>
          <button
            className="tab-menu-item"
            role="menuitem"
            title={`Type a regular expression, then ${searchCommand(shell, '<regex>', { target: 'names', matchCase: false })} — every file whose path matches`}
            onClick={() => setSearch('names')}
          >
            Find files by name…
          </button>
          <button
            className="tab-menu-item"
            role="menuitem"
            title={`Type ${openFolderCommand(shell, os)} — open the current folder in ${fileManagerName(os)}`}
            onClick={() => type(openFolderCommand(shell, os))}
          >
            Open in {fileManagerName(os)}
          </button>
          {agent && (
            <button
              className="tab-menu-item"
              role="menuitem"
              title={`Type ${agent.command} — start ${agent.name} in the current folder`}
              onClick={() => type(agent.command)}
            >
              Open {agent.name}
            </button>
          )}
        </>
      )}
      <div className="tab-menu-sep" role="separator" />
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => global({ type: 'terminal-split', direction: 'right' })}
      >
        Split right<span className="tab-menu-chord">{chord('D')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => global({ type: 'terminal-split', direction: 'down' })}
      >
        Split down<span className="tab-menu-chord">{chord('E')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => global({ type: 'terminal-close-pane' })}
      >
        Close pane<span className="tab-menu-chord">{chord('X')}</span>
      </button>
    </div>
  );
}

/**
 * The search helpers' form: a regex, a Match case box, and the command that
 * will be typed, shown live underneath — the user watches the pattern land
 * inside the quotes. Enter (or Run) types it at the prompt; Escape is the
 * menu's own close.
 */
function SearchPrompt({
  shell,
  target,
  onRun,
  onCancel,
}: {
  shell: ShellKind;
  target: SearchTarget;
  onRun: (command: string) => void;
  onCancel: () => void;
}) {
  const [pattern, setPattern] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const command = searchCommand(shell, pattern, { target, matchCase });
  const hint =
    pattern === ''
      ? target === 'names'
        ? 'e.g. \\.md$ — files ending in .md'
        : 'e.g. TODO|FIXME — lines with either word'
      : 'Command Prompt cannot quote a " inside a pattern';

  return (
    <form
      className="term-search"
      onSubmit={(e) => {
        e.preventDefault();
        if (command) {
          onRun(command);
        }
      }}
    >
      <label className="term-search-label">
        {target === 'names' ? 'Find files whose path matches' : 'Search inside files for'}
        <input
          className="settings-control term-search-input"
          type="text"
          value={pattern}
          spellCheck={false}
          autoFocus
          placeholder="Regular expression"
          onChange={(e) => setPattern(e.target.value)}
        />
      </label>
      <label className="term-search-check">
        <input
          type="checkbox"
          checked={matchCase}
          onChange={(e) => setMatchCase(e.target.checked)}
        />
        Match case
      </label>
      <code className={command ? 'term-search-preview' : 'term-search-preview term-search-hint'}>
        {command
          ? // One box per word, so a line wraps only BETWEEN words: a break
            // at the hyphen of `-CaseSensitive` reads as a stray `-`.
            command.split(' ').map((word, i) => (
              <span key={i}>
                {i > 0 && ' '}
                <span className="term-search-word">{word}</span>
              </span>
            ))
          : hint}
      </code>
      <div className="term-search-actions">
        <button type="button" className="settings-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="settings-button settings-button-primary"
          disabled={!command}
        >
          Run
        </button>
      </div>
    </form>
  );
}
