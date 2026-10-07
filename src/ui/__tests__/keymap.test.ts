import { describe, expect, test } from 'vitest';
import { detectPlatform, keyEventToAction, type KeyDescriptor } from '../keymap';

function key(partial: Partial<KeyDescriptor> & { key: string }): KeyDescriptor {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

describe('detectPlatform', () => {
  test('recognizes macOS platform strings', () => {
    expect(detectPlatform('MacIntel')).toBe('mac');
    expect(detectPlatform('iPhone')).toBe('mac');
  });
  test('everything else is "other"', () => {
    expect(detectPlatform('Win32')).toBe('other');
    expect(detectPlatform('Linux x86_64')).toBe('other');
  });
});

describe('keyEventToAction — mod resolves per platform', () => {
  test('Ctrl+N on non-mac is new-window; Meta+N is not', () => {
    expect(keyEventToAction(key({ key: 'n', ctrlKey: true }), 'other')).toEqual({
      type: 'new-window',
    });
    expect(keyEventToAction(key({ key: 'n', metaKey: true }), 'other')).toBeNull();
  });

  test('Cmd+N on mac is new-window; Ctrl+N is not', () => {
    expect(keyEventToAction(key({ key: 'n', metaKey: true }), 'mac')).toEqual({
      type: 'new-window',
    });
    expect(keyEventToAction(key({ key: 'n', ctrlKey: true }), 'mac')).toBeNull();
  });
});

describe('keyEventToAction — the M1 table', () => {
  test('mod+W closes the tab', () => {
    expect(keyEventToAction(key({ key: 'w', ctrlKey: true }), 'other')).toEqual({
      type: 'close-tab',
    });
  });

  test('mod+Tab / mod+Shift+Tab cycle tabs', () => {
    expect(keyEventToAction(key({ key: 'Tab', ctrlKey: true }), 'other')).toEqual({
      type: 'next-tab',
    });
    expect(keyEventToAction(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'prev-tab',
    });
  });

  test('Ctrl+Tab / Ctrl+Shift+Tab cycle tabs on macOS too — Cmd+Tab is the app switcher', () => {
    // macOS keeps Cmd+Tab for itself (the event never reaches the app), so the
    // mac chord is Ctrl+Tab, as in every mac browser and editor.
    expect(keyEventToAction(key({ key: 'Tab', ctrlKey: true }), 'mac')).toEqual({
      type: 'next-tab',
    });
    expect(keyEventToAction(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'mac')).toEqual({
      type: 'prev-tab',
    });
    expect(keyEventToAction(key({ key: 'Tab', metaKey: true }), 'mac')).toBeNull();
    expect(keyEventToAction(key({ key: 'Tab', metaKey: true, shiftKey: true }), 'mac')).toBeNull();
  });

  test('the tab chord takes Ctrl alone', () => {
    for (const platform of ['mac', 'other'] as const) {
      expect(
        keyEventToAction(key({ key: 'Tab', ctrlKey: true, altKey: true }), platform),
      ).toBeNull();
      expect(
        keyEventToAction(key({ key: 'Tab', ctrlKey: true, metaKey: true }), platform),
      ).toBeNull();
    }
    expect(keyEventToAction(key({ key: 'Tab', metaKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'Tab' }), 'mac')).toBeNull();
  });

  test('F2 renames, with or without focus, and needs no modifier', () => {
    expect(keyEventToAction(key({ key: 'F2' }), 'other')).toEqual({ type: 'rename-tab' });
    expect(keyEventToAction(key({ key: 'F2' }), 'mac')).toEqual({ type: 'rename-tab' });
  });

  test('mod+1/2/3/4 select the four modes', () => {
    expect(keyEventToAction(key({ key: '1', ctrlKey: true }), 'other')).toEqual({
      type: 'set-mode',
      mode: 'raw',
    });
    expect(keyEventToAction(key({ key: '2', ctrlKey: true }), 'other')).toEqual({
      type: 'set-mode',
      mode: 'split',
    });
    expect(keyEventToAction(key({ key: '3', ctrlKey: true }), 'other')).toEqual({
      type: 'set-mode',
      mode: 'wysiwyg',
    });
    expect(keyEventToAction(key({ key: '4', ctrlKey: true }), 'other')).toEqual({
      type: 'set-mode',
      mode: 'read',
    });
  });
});

describe('keyEventToAction — the M3 table', () => {
  test('mod+O opens a file', () => {
    expect(keyEventToAction(key({ key: 'o', ctrlKey: true }), 'other')).toEqual({
      type: 'open-file',
    });
  });

  test('mod+S saves; mod+Shift+S saves as', () => {
    expect(keyEventToAction(key({ key: 's', ctrlKey: true }), 'other')).toEqual({ type: 'save' });
    expect(keyEventToAction(key({ key: 's', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'save-as',
    });
  });
});

describe('keyEventToAction — outline panel', () => {
  test('mod+Shift+O toggles the outline on both platforms', () => {
    expect(keyEventToAction(key({ key: 'O', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'toggle-outline',
    });
    expect(keyEventToAction(key({ key: 'O', metaKey: true, shiftKey: true }), 'mac')).toEqual({
      type: 'toggle-outline',
    });
  });

  test('plain mod+O stays open-file; bare/wrong-modifier Shift+O is ignored', () => {
    expect(keyEventToAction(key({ key: 'o', ctrlKey: true }), 'other')).toEqual({
      type: 'open-file',
    });
    expect(keyEventToAction(key({ key: 'O', shiftKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'O', metaKey: true, shiftKey: true }), 'other')).toBeNull();
  });
});

describe('keyEventToAction — the M6 table', () => {
  test('mod+, opens settings', () => {
    expect(keyEventToAction(key({ key: ',', ctrlKey: true }), 'other')).toEqual({
      type: 'open-settings',
    });
    expect(keyEventToAction(key({ key: ',', metaKey: true }), 'mac')).toEqual({
      type: 'open-settings',
    });
  });

  test('mod+= and mod++ both increase font size', () => {
    expect(keyEventToAction(key({ key: '=', ctrlKey: true }), 'other')).toEqual({
      type: 'font-inc',
    });
    expect(keyEventToAction(key({ key: '+', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'font-inc',
    });
  });

  test('mod+- and mod+_ both decrease font size', () => {
    expect(keyEventToAction(key({ key: '-', ctrlKey: true }), 'other')).toEqual({
      type: 'font-dec',
    });
    expect(keyEventToAction(key({ key: '_', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'font-dec',
    });
  });

  test('mod+0 resets font size', () => {
    expect(keyEventToAction(key({ key: '0', ctrlKey: true }), 'other')).toEqual({
      type: 'font-reset',
    });
    expect(keyEventToAction(key({ key: '0', metaKey: true }), 'mac')).toEqual({
      type: 'font-reset',
    });
  });
});

describe('keyEventToAction — command palette', () => {
  test('mod+K opens the palette on both platforms', () => {
    expect(keyEventToAction(key({ key: 'k', ctrlKey: true }), 'other')).toEqual({
      type: 'open-palette',
    });
    expect(keyEventToAction(key({ key: 'k', metaKey: true }), 'mac')).toEqual({
      type: 'open-palette',
    });
  });

  test('mod+Shift+K is NOT the palette (CM6 deleteLine owns it)', () => {
    expect(keyEventToAction(key({ key: 'k', ctrlKey: true, shiftKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'K', metaKey: true, shiftKey: true }), 'mac')).toBeNull();
  });

  test('bare K and wrong-modifier K are ignored', () => {
    expect(keyEventToAction(key({ key: 'k' }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'k', metaKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'k', ctrlKey: true }), 'mac')).toBeNull();
  });
});

describe('keyEventToAction — reader full screen', () => {
  test('bare F11 toggles fullscreen on any platform', () => {
    expect(keyEventToAction(key({ key: 'F11' }), 'other')).toEqual({ type: 'toggle-fullscreen' });
    expect(keyEventToAction(key({ key: 'F11' }), 'mac')).toEqual({ type: 'toggle-fullscreen' });
  });

  test('modified F11 is not the shortcut', () => {
    expect(keyEventToAction(key({ key: 'F11', ctrlKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'F11', shiftKey: true }), 'other')).toBeNull();
  });

  test('Ctrl+Cmd+F toggles fullscreen on mac only', () => {
    expect(keyEventToAction(key({ key: 'f', ctrlKey: true, metaKey: true }), 'mac')).toEqual({
      type: 'toggle-fullscreen',
    });
    expect(keyEventToAction(key({ key: 'f', ctrlKey: true, metaKey: true }), 'other')).toBeNull();
  });
});

describe('keyEventToAction — global workspace search', () => {
  test('mod+Shift+F opens global search on both platforms', () => {
    expect(keyEventToAction(key({ key: 'F', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'global-search',
    });
    expect(keyEventToAction(key({ key: 'F', metaKey: true, shiftKey: true }), 'mac')).toEqual({
      type: 'global-search',
    });
  });

  test('bare/wrong-modifier Shift+F is ignored', () => {
    expect(keyEventToAction(key({ key: 'F', shiftKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'F', metaKey: true, shiftKey: true }), 'other')).toBeNull();
  });
});

describe('keyEventToAction — non-interception', () => {
  test('mod+F is NOT intercepted (CM6 search owns it)', () => {
    expect(keyEventToAction(key({ key: 'f', ctrlKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'f', metaKey: true }), 'mac')).toBeNull();
  });

  test('a bare letter is not a shortcut', () => {
    expect(keyEventToAction(key({ key: 'n' }), 'other')).toBeNull();
  });

  test('Alt disqualifies our chords', () => {
    expect(keyEventToAction(key({ key: 'n', ctrlKey: true, altKey: true }), 'other')).toBeNull();
  });

  test('mod+Shift+N opens the new-tab TYPE picker', () => {
    expect(keyEventToAction(key({ key: 'n', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'new-tab-menu',
    });
  });

  test('mod+Shift+P (not in the table) is ignored', () => {
    expect(keyEventToAction(key({ key: 'p', ctrlKey: true, shiftKey: true }), 'other')).toBeNull();
  });

  test('mod+Shift+G opens the git tab; plain mod+G stays free for the editor', () => {
    expect(keyEventToAction(key({ key: 'g', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'open-git',
    });
    expect(keyEventToAction(key({ key: 'G', metaKey: true, shiftKey: true }), 'mac')).toEqual({
      type: 'open-git',
    });
    expect(keyEventToAction(key({ key: 'g', ctrlKey: true }), 'other')).toBeNull();
  });

  test('mod+Shift+G reaches through a focused terminal too', () => {
    expect(
      keyEventToAction(key({ key: 'g', ctrlKey: true, shiftKey: true }), 'other', 'terminal'),
    ).toEqual({ type: 'open-git' });
  });
});

describe('keyEventToAction — terminal context', () => {
  const term = (partial: Partial<KeyDescriptor> & { key: string }) =>
    keyEventToAction(key(partial), 'other', 'terminal');
  const doc = (partial: Partial<KeyDescriptor> & { key: string }) =>
    keyEventToAction(key(partial), 'other');

  test('terminal chords resolve only in a terminal', () => {
    const cases: [Partial<KeyDescriptor> & { key: string }, unknown][] = [
      [{ key: 'c', ctrlKey: true, shiftKey: true }, { type: 'terminal-copy' }],
      [{ key: 'v', ctrlKey: true, shiftKey: true }, { type: 'terminal-paste' }],
      [{ key: 'a', ctrlKey: true, shiftKey: true }, { type: 'terminal-select-all' }],
      [{ key: 'k', ctrlKey: true, shiftKey: true }, { type: 'terminal-clear-scrollback' }],
      [
        { key: 'd', ctrlKey: true, shiftKey: true },
        { type: 'terminal-split', direction: 'right' },
      ],
      [
        { key: 'e', ctrlKey: true, shiftKey: true },
        { type: 'terminal-split', direction: 'down' },
      ],
      [{ key: 'x', ctrlKey: true, shiftKey: true }, { type: 'terminal-close-pane' }],
      [
        { key: '[', ctrlKey: true, shiftKey: true },
        { type: 'terminal-cycle-pane', delta: -1 },
      ],
      [
        { key: ']', ctrlKey: true, shiftKey: true },
        { type: 'terminal-cycle-pane', delta: 1 },
      ],
      [
        { key: 'ArrowUp', ctrlKey: true, shiftKey: true },
        { type: 'terminal-scroll', to: 'lineUp' },
      ],
      [
        { key: 'ArrowDown', ctrlKey: true, shiftKey: true },
        { type: 'terminal-scroll', to: 'lineDown' },
      ],
      [
        { key: 'Home', ctrlKey: true, shiftKey: true },
        { type: 'terminal-scroll', to: 'top' },
      ],
      [
        { key: 'End', ctrlKey: true, shiftKey: true },
        { type: 'terminal-scroll', to: 'bottom' },
      ],
      [
        { key: 'PageUp', shiftKey: true },
        { type: 'terminal-scroll', to: 'pageUp' },
      ],
      [
        { key: 'PageDown', shiftKey: true },
        { type: 'terminal-scroll', to: 'pageDown' },
      ],
    ];
    for (const [descriptor, expected] of cases) {
      expect(term(descriptor), JSON.stringify(descriptor)).toEqual(expected);
      // Symmetry: a document tab never sees them, so CM6 keeps its bindings.
      expect(doc(descriptor)?.type ?? '', `document: ${JSON.stringify(descriptor)}`).not.toMatch(
        /^terminal-/,
      );
    }
  });

  test('plain mod+C resolves to copy — the pane turns it back into SIGINT', () => {
    // The terminal convention: with a selection it copies, without one it
    // interrupts. Only the pane knows which, so the chord resolves here and
    // TerminalPane declines it when nothing is selected.
    expect(term({ key: 'c', ctrlKey: true })).toEqual({ type: 'terminal-copy' });
    expect(doc({ key: 'c', ctrlKey: true })).toBeNull();
  });

  test('the window/tab chords a user would be stranded without still fire', () => {
    expect(term({ key: 'n', ctrlKey: true })).toEqual({ type: 'new-window' });
    expect(term({ key: 'w', ctrlKey: true })).toEqual({ type: 'close-tab' });
    expect(term({ key: 'Tab', ctrlKey: true })).toEqual({ type: 'next-tab' });
    expect(term({ key: 'Tab', ctrlKey: true, shiftKey: true })).toEqual({ type: 'prev-tab' });
    expect(term({ key: 'k', ctrlKey: true })).toEqual({ type: 'open-palette' });
    expect(term({ key: ',', ctrlKey: true })).toEqual({ type: 'open-settings' });
    expect(term({ key: '=', ctrlKey: true })).toEqual({ type: 'font-inc' });
    expect(term({ key: '0', ctrlKey: true })).toEqual({ type: 'font-reset' });
    expect(term({ key: 'F11' })).toEqual({ type: 'toggle-fullscreen' });
    expect(term({ key: 'F2' })).toEqual({ type: 'rename-tab' });
  });

  test('Ctrl+Tab still cycles tabs from a focused terminal on macOS', () => {
    const macTerm = (partial: Partial<KeyDescriptor> & { key: string }) =>
      keyEventToAction(key(partial), 'mac', 'terminal');
    expect(macTerm({ key: 'Tab', ctrlKey: true })).toEqual({ type: 'next-tab' });
    expect(macTerm({ key: 'Tab', ctrlKey: true, shiftKey: true })).toEqual({ type: 'prev-tab' });
  });

  test('everything else belongs to the shell', () => {
    // mod+S is XOFF, mod+O and mod+U are readline, mod+1..4 mean whatever the
    // running program says. Intercepting any of them would be a bug the user
    // hits inside vim within a minute.
    for (const descriptor of [
      { key: 's', ctrlKey: true },
      { key: 's', ctrlKey: true, shiftKey: true },
      { key: 'o', ctrlKey: true },
      { key: 'o', ctrlKey: true, shiftKey: true },
      { key: 'f', ctrlKey: true, shiftKey: true },
      { key: '1', ctrlKey: true },
      { key: '4', ctrlKey: true },
      { key: 'u', ctrlKey: true },
      { key: 'd', ctrlKey: true },
      { key: 'a' },
    ] satisfies (Partial<KeyDescriptor> & { key: string })[]) {
      expect(term(descriptor), JSON.stringify(descriptor)).toBeNull();
    }
  });
});

describe('keyEventToAction — AltGr characters', () => {
  // Windows reports AltGr as Ctrl+Alt with `key` set to the typed character
  // (German AltGr+7/8/9/0 are { [ ] }). The Alt guard keeps every app chord,
  // the bracket ones included, from claiming them in either context.
  test('Ctrl+Alt (+Shift) brackets and braces are never an app shortcut', () => {
    for (const k of ['[', ']', '{', '}', '@', '+', '-', '0']) {
      for (const shiftKey of [false, true]) {
        const e = key({ key: k, ctrlKey: true, altKey: true, shiftKey });
        expect(keyEventToAction(e, 'other', 'terminal')).toBeNull();
        expect(keyEventToAction(e, 'other')).toBeNull();
      }
    }
  });
});
