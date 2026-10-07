/**
 * The single keyboard-shortcut registry (src/ui/README "Keyboard shortcuts").
 *
 * `keyEventToAction` is a PURE decision function — it maps a keyboard event
 * (or any structurally-compatible descriptor) plus the platform to an action,
 * or `null` when the app should not intercept the key. Keeping it pure is
 * what lets the shortcut table be unit-tested without a DOM; `src/main.tsx`
 * installs the one real `keydown` listener that calls this and dispatches
 * into store actions.
 *
 * `mod` = Cmd on macOS, Ctrl elsewhere. Shortcuts not in the M1 table return
 * `null` so the event falls through — notably mod+F, which CM6's own search
 * keymap handles while the editor is focused.
 *
 * CONTEXT. A focused shell owns almost every key: mod+S is XOFF, mod+O and
 * mod+W are readline bindings, mod+1..4 mean whatever the running program
 * says. So `keyEventToAction` takes the context it is being asked about, and
 * in `'terminal'` it answers for a deliberately short ALLOWLIST — the window
 * and tab chords a user would be stranded without, plus the terminal's own —
 * and `null` for everything else, which is then encoded and sent to the
 * child. Terminal actions are symmetrically invisible in `'document'`, so
 * CM6 keeps its bindings.
 */

import type { EditorMode } from '../core/types';

export type Platform = 'mac' | 'other';

/** Which surface has the keyboard. See the CONTEXT note above. */
export type KeyContext = 'document' | 'terminal';

/** Where the scrollback view goes. */
export type TerminalScroll = 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown' | 'top' | 'bottom';

export type ShortcutAction =
  | { type: 'new-tab' }
  | { type: 'new-window' }
  /** The new-tab TYPE picker (mod+Shift+N), anchored to the + button. */
  | { type: 'new-tab-menu' }
  | { type: 'close-tab' }
  | { type: 'next-tab' }
  | { type: 'prev-tab' }
  | { type: 'rename-tab' }
  | { type: 'set-mode'; mode: EditorMode }
  | { type: 'open-file' }
  | { type: 'save' }
  | { type: 'save-as' }
  | { type: 'open-settings' }
  | { type: 'font-inc' }
  | { type: 'font-dec' }
  | { type: 'font-reset' }
  | { type: 'toggle-fullscreen' }
  | { type: 'toggle-distraction-free' }
  | { type: 'open-palette' }
  | { type: 'toggle-outline' }
  | { type: 'global-search' }
  /** The git tab for the repository around the active tab (mod+Shift+G). */
  | { type: 'open-git' }
  /* Terminal-only. Never returned in the 'document' context. */
  | { type: 'terminal-copy' }
  | { type: 'terminal-paste' }
  | { type: 'terminal-select-all' }
  | { type: 'terminal-clear-scrollback' }
  | { type: 'terminal-split'; direction: 'right' | 'down' }
  | { type: 'terminal-close-pane' }
  | { type: 'terminal-cycle-pane'; delta: number }
  | { type: 'terminal-scroll'; to: TerminalScroll };

/**
 * The non-terminal actions a focused shell still gives up. Everything else in
 * `ShortcutAction` is left to the child — notably save (XOFF), open, and the
 * mode shortcuts, which a terminal tab has no use for anyway.
 */
const TERMINAL_PASSTHROUGH: readonly ShortcutAction['type'][] = [
  'new-tab',
  'new-window',
  'new-tab-menu',
  'close-tab',
  'next-tab',
  'prev-tab',
  'rename-tab',
  'open-settings',
  'open-palette',
  'toggle-fullscreen',
  'toggle-distraction-free',
  'font-inc',
  'font-dec',
  'font-reset',
  // The git tab for the shell's repository — a chord no shell binds.
  'open-git',
];

/** The subset of KeyboardEvent this function reads (so tests need no DOM). */
export interface KeyDescriptor {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function detectPlatform(platformString: string): Platform {
  return /mac|iphone|ipad|ipod/i.test(platformString) ? 'mac' : 'other';
}

export function keyEventToAction(
  e: KeyDescriptor,
  platform: Platform,
  context: KeyContext = 'document',
): ShortcutAction | null {
  if (context === 'terminal') {
    const own = terminalAction(e, platform);
    if (own) {
      return own;
    }
    const shared = keyEventToAction(e, platform, 'document');
    return shared && TERMINAL_PASSTHROUGH.includes(shared.type) ? shared : null;
  }
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
  // The "wrong" primary modifier for the platform must not also fire the
  // shortcut (Ctrl+N on macOS is not new-window).
  const wrongMod = platform === 'mac' ? e.ctrlKey : e.metaKey;

  // F2 rename is unmodified and platform-independent.
  if (e.key === 'F2' && !mod && !e.altKey) {
    return { type: 'rename-tab' };
  }

  // Full screen: F11 is the unmodified convention on Windows/Linux (and works
  // on external mac keyboards too); Ctrl+Cmd+F is the macOS-native chord. Both
  // must be matched before the mod/wrongMod guard — on mac the chord holds
  // Ctrl AND Cmd, which that guard would reject as a "wrong modifier".
  if (e.key === 'F11' && !mod && !e.altKey && !e.shiftKey) {
    return { type: 'toggle-fullscreen' };
  }
  if (
    platform === 'mac' &&
    e.metaKey &&
    e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === 'f'
  ) {
    return { type: 'toggle-fullscreen' };
  }

  // Ctrl+Tab cycles tabs (Shift reverses) on EVERY platform — it is the one
  // chord here that is Ctrl on macOS too, ahead of the mod/wrongMod guard
  // that would reject Ctrl there. macOS keeps Cmd+Tab for the app switcher
  // (the keydown never reaches a webview), and Ctrl+Tab is what mac browsers
  // and editors use. (Cmd+Shift+[ / ] is not bound: in a terminal tab that is
  // the pane-cycling chord.)
  if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
    return e.shiftKey ? { type: 'prev-tab' } : { type: 'next-tab' };
  }

  if (!mod || wrongMod || e.altKey) {
    return null;
  }

  // mod+S / mod+Shift+S (save / save as) are the only M1+ Shift-combos.
  if (e.key.toLowerCase() === 's') {
    return e.shiftKey ? { type: 'save-as' } : { type: 'save' };
  }

  // mod+Shift+N opens the new-tab TYPE picker (note / drawing / terminal).
  // Nothing else binds it — CM6 leaves Shift-Mod-n alone.
  if (e.key.toLowerCase() === 'n' && e.shiftKey) {
    return { type: 'new-tab-menu' };
  }

  // mod+Shift+O toggles the outline panel (plain mod+O below is open-file;
  // neither CM6's keymaps nor Crepe bind Shift-Mod-O, so this is free).
  if (e.key.toLowerCase() === 'o' && e.shiftKey) {
    return { type: 'toggle-outline' };
  }

  // mod+Shift+F opens global workspace search. Plain mod+F stays UN-intercepted
  // (the fall-through below) — CM6's own search keymap owns it in the editor.
  // The mac fullscreen chord (Ctrl+Cmd+F) was matched earlier, before the
  // wrongMod guard, and holds no Shift, so there is no collision.
  if (e.key.toLowerCase() === 'f' && e.shiftKey) {
    return { type: 'global-search' };
  }

  // mod+Shift+G opens the git tab (VS Code's Source Control chord). CM6's
  // search keymap binds Mod-g / Shift-Mod-g (find next / previous) with
  // preventDefault, so `editors/cm6.ts` filters that one entry out of
  // `searchKeymap` — F3 / Shift+F3 keep next / previous — and the chord
  // reaches this listener from a focused editor. A focused whiteboard still
  // owns it (ungroup) and prevents the default first.
  if (e.key.toLowerCase() === 'g' && e.shiftKey) {
    return { type: 'open-git' };
  }

  // Font size (mod += / - / 0). "mod+=" often arrives as '+' (Shift held on a
  // US layout), and "mod+-" as '_', so these must be checked BEFORE the
  // no-Shift guard below and tolerate either form.
  if (e.key === '=' || e.key === '+') {
    return { type: 'font-inc' };
  }
  if (e.key === '-' || e.key === '_') {
    return { type: 'font-dec' };
  }
  if (e.key === '0') {
    return { type: 'font-reset' };
  }

  // The remaining shortcuts are not Shift-combos.
  if (e.shiftKey) {
    return null;
  }

  switch (e.key.toLowerCase()) {
    // mod+N opens a NEW WINDOW with one fresh note (the tab bar's "+" and
    // the palette still make a tab in this window; mod+Shift+N picks a type).
    case 'n':
      return { type: 'new-window' };
    case 'w':
      return { type: 'close-tab' };
    case 'o':
      return { type: 'open-file' };
    // mod+K opens the command palette. Plain mod+K only — CM6 binds
    // Shift-Mod-k (deleteLine), which the Shift guard above already excludes.
    case 'k':
      return { type: 'open-palette' };
    case ',':
      return { type: 'open-settings' };
    case '1':
      return { type: 'set-mode', mode: 'raw' satisfies EditorMode };
    case '2':
      return { type: 'set-mode', mode: 'split' satisfies EditorMode };
    case '3':
      return { type: 'set-mode', mode: 'wysiwyg' satisfies EditorMode };
    case '4':
      return { type: 'set-mode', mode: 'read' satisfies EditorMode };
    default:
      return null;
  }
}

/**
 * The chords only a focused terminal answers.
 *
 * Almost everything here is a mod+SHIFT chord, because the unshifted forms
 * belong to the shell: mod+C is SIGINT, mod+D is EOF, mod+K kills a line.
 * mod+C is the one deliberate overlap — the terminal convention is that it
 * copies when there IS a selection and interrupts otherwise, so it is
 * returned here and the pane declines it (letting it encode as SIGINT) when
 * nothing is selected.
 */
function terminalAction(e: KeyDescriptor, platform: Platform): ShortcutAction | null {
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
  const wrongMod = platform === 'mac' ? e.ctrlKey : e.metaKey;

  // Scrollback paging is Shift+PgUp/PgDn with no mod — the xterm convention.
  if (!mod && !wrongMod && !e.altKey && e.shiftKey) {
    if (e.key === 'PageUp') {
      return { type: 'terminal-scroll', to: 'pageUp' };
    }
    if (e.key === 'PageDown') {
      return { type: 'terminal-scroll', to: 'pageDown' };
    }
  }
  if (!mod || wrongMod || e.altKey) {
    return null;
  }

  if (!e.shiftKey) {
    // See the note above: the pane turns this back into SIGINT when there is
    // no selection to copy.
    return e.key.toLowerCase() === 'c' ? { type: 'terminal-copy' } : null;
  }

  switch (e.key) {
    case 'ArrowUp':
      return { type: 'terminal-scroll', to: 'lineUp' };
    case 'ArrowDown':
      return { type: 'terminal-scroll', to: 'lineDown' };
    case 'Home':
      return { type: 'terminal-scroll', to: 'top' };
    case 'End':
      return { type: 'terminal-scroll', to: 'bottom' };
    // Bracket keys report unshifted on most layouts and shifted on some.
    case '[':
    case '{':
      return { type: 'terminal-cycle-pane', delta: -1 };
    case ']':
    case '}':
      return { type: 'terminal-cycle-pane', delta: 1 };
  }

  switch (e.key.toLowerCase()) {
    case 'c':
      return { type: 'terminal-copy' };
    case 'v':
      return { type: 'terminal-paste' };
    case 'a':
      return { type: 'terminal-select-all' };
    case 'k':
      return { type: 'terminal-clear-scrollback' };
    case 'd':
      return { type: 'terminal-split', direction: 'right' };
    case 'e':
      return { type: 'terminal-split', direction: 'down' };
    case 'x':
      return { type: 'terminal-close-pane' };
    default:
      return null;
  }
}
