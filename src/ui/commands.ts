/**
 * The single source of truth for app-level actions.
 *
 * `runShortcutAction` is the one implementation behind every global keyboard
 * shortcut — the body moved here verbatim from main.tsx's `dispatchShortcut`
 * so the command palette and the keydown listener share it exactly.
 *
 * `buildCommands` is the palette's command table: every ShortcutAction that
 * makes sense as a palette entry (each delegating to `runShortcutAction`, so
 * behavior can never drift from the shortcut), plus a few palette-only
 * commands that call existing session/store functions directly.
 */

import { DEFAULT_SETTINGS, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../core/settings';
import type { EditorMode } from '../core/types';
import { detectPlatform, type ShortcutAction } from './keymap';
import {
  addWorkspace,
  closeAllTabs,
  closeTab,
  newWindow,
  openDocs,
  openExportPreview,
  openFile,
  saveActiveTab,
  saveActiveTabAs,
} from './session';
import { toggleDistractionFree, toggleFullscreen } from './fullscreen';
import { searchStore } from './stores/search';
import { openOverview } from './notes-overview';
import { createWorkspace, openWorkspaceInit } from './workspace-init';
import { settingsStore } from './stores/settings';
import { isAndroid } from './platform';
import { tabsStore } from './stores/tabs';
import { openPresenterForActiveTab } from './presenter';
import { activePaneOf, terminalsStore } from './stores/terminals';
import { runPaneAction } from './pane-actions';
import { uiStore } from './stores/ui';
import { openTerminal } from './terminal-open';
import { newTabDefault, runNewTabChoice, terminalsAvailable } from './new-tab';
import { openGitTabForActiveTab, openNewWorktreeForActiveTab } from './git-open';

export interface AppCommand {
  /** Stable kebab-case identifier. */
  id: string;
  /** Palette label, e.g. "New tab". */
  title: string;
  /** Extra fuzzy-search terms not worth putting in the title. */
  keywords?: string[];
  /** Display-only shortcut hint ("Ctrl+N" / "⌘N" per platform). */
  shortcut?: string;
  /** When present and false, the command is hidden from the palette. */
  enabled?: () => boolean;
  run: () => void;
}

function clampFontSize(px: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, px));
}

/** Execute a global-shortcut action (moved verbatim from main.tsx). */
export function runShortcutAction(action: ShortcutAction): void {
  const store = tabsStore.getState();
  switch (action.type) {
    case 'new-tab':
      // "New tab" has always meant a tab, not a note: from a terminal or a
      // drawing it makes another one of those (core/new-tab.ts).
      newTabDefault();
      break;
    case 'new-window':
      newWindow();
      break;
    case 'new-tab-menu':
      uiStore.getState().openNewTabMenu();
      break;
    case 'close-tab':
      closeTab(store.activeTabId);
      break;
    case 'next-tab':
      store.activateAdjacent(1);
      break;
    case 'prev-tab':
      store.activateAdjacent(-1);
      break;
    case 'rename-tab':
      store.beginRename(store.activeTabId);
      break;
    case 'set-mode':
      store.setMode(store.activeTabId, action.mode);
      break;
    case 'open-file':
      openFile();
      break;
    case 'save':
      saveActiveTab();
      break;
    case 'save-as':
      saveActiveTabAs();
      break;
    case 'open-settings':
      uiStore.getState().openSettings();
      break;
    case 'font-inc':
      settingsStore
        .getState()
        .update({ fontSize: clampFontSize(settingsStore.getState().settings.fontSize + 1) });
      break;
    case 'font-dec':
      settingsStore
        .getState()
        .update({ fontSize: clampFontSize(settingsStore.getState().settings.fontSize - 1) });
      break;
    case 'font-reset':
      settingsStore.getState().update({ fontSize: DEFAULT_SETTINGS.fontSize });
      break;
    case 'toggle-fullscreen':
      // OS full screen — the interface is untouched. Available in every mode.
      toggleFullscreen();
      break;
    case 'toggle-distraction-free':
      // Hide (or bring back) the app chrome; the OS window stays as it is.
      toggleDistractionFree();
      break;
    case 'open-palette':
      uiStore.getState().togglePalette();
      break;
    case 'toggle-outline':
      uiStore.getState().toggleOutline();
      break;
    case 'global-search':
      // Toggle like the palette: the shortcut both opens and dismisses it.
      searchStore.getState().setOpen(!searchStore.getState().open);
      break;
    case 'open-git':
      // The git tab for the repository around whatever is in front.
      void openGitTabForActiveTab();
      break;
    case 'terminal-split':
      terminalsStore
        .getState()
        .splitActivePane(store.activeTabId ?? '', action.direction === 'right' ? 'row' : 'column');
      break;
    case 'terminal-close-pane':
      closeActiveTerminalPane();
      break;
    case 'terminal-cycle-pane':
      terminalsStore.getState().cyclePane(store.activeTabId ?? '', action.delta);
      break;
    case 'terminal-copy':
    case 'terminal-paste':
    case 'terminal-select-all':
    case 'terminal-clear-scrollback':
    case 'terminal-scroll': {
      // Pane-local: routed to the focused pane's own runner so the palette,
      // the context menu and the keyboard share one implementation.
      const pane = store.activeTabId ? activePaneOf(store.activeTabId) : null;
      if (pane) {
        runPaneAction(pane.id, action);
      }
      break;
    }
  }
}

/**
 * Close the focused pane of the active terminal tab. Closing the LAST pane
 * closes the tab, which is what makes mod+Shift+X feel like mod+W once a
 * split has been collapsed back to one shell.
 */
function closeActiveTerminalPane(): void {
  const store = tabsStore.getState();
  const tabId = store.activeTabId;
  const tab = tabId ? store.tabs.find((t) => t.id === tabId) : undefined;
  if (!tabId || tab?.kind !== 'terminal') {
    return;
  }
  const pane = activePaneOf(tabId);
  if (pane && terminalsStore.getState().closePane(pane.id)) {
    closeTab(tabId);
  }
}

/* ---- Palette command table ----------------------------------------------- */

// Same mac-vs-other distinction keymap.ts resolves at dispatch time; guarded
// so importing this module in a node test needs no DOM.
const IS_MAC =
  typeof navigator !== 'undefined' && detectPlatform(navigator.platform ?? '') === 'mac';

/** "Ctrl+Shift+S" / "⇧⌘S" from a key name + modifier flags. */
function modKey(key: string, opts: { shift?: boolean } = {}): string {
  return IS_MAC ? `${opts.shift ? '⇧' : ''}⌘${key}` : `Ctrl+${opts.shift ? 'Shift+' : ''}${key}`;
}

function hasActiveTab(): boolean {
  return tabsStore.getState().activeTab() !== undefined;
}

/** An active tab that holds markdown text (not an image/import/terminal/git tab). */
function hasActiveTextTab(): boolean {
  const tab = tabsStore.getState().activeTab();
  return (
    tab !== undefined &&
    tab.kind !== 'image' &&
    tab.kind !== 'import' &&
    tab.kind !== 'terminal' &&
    tab.kind !== 'git'
  );
}

/** A terminal tab is in front, so the terminal-only commands can act. */
function hasActiveTerminal(): boolean {
  return tabsStore.getState().activeTab()?.kind === 'terminal';
}

/** A palette entry that delegates to the shared shortcut implementation. */
function fromAction(
  id: string,
  title: string,
  action: ShortcutAction,
  extra: Partial<Pick<AppCommand, 'keywords' | 'shortcut' | 'enabled'>> = {},
): AppCommand {
  return { id, title, ...extra, run: () => runShortcutAction(action) };
}

/**
 * `key` is the digit chord (mod+1..4), which the four MARKDOWN modes own —
 * `setMode` drops one aimed at a family that has no such mode, so the chords
 * cost nothing on a drawing or a code file. Draw has no digit of its own (it
 * is nobody's mod+3) and is reachable here and from the status bar instead.
 */
const MODE_ENTRIES: { id: string; title: string; mode: EditorMode; key?: string }[] = [
  { id: 'mode-raw', title: 'Mode: Raw', mode: 'raw', key: '1' },
  { id: 'mode-split', title: 'Mode: Split', mode: 'split', key: '2' },
  { id: 'mode-edit', title: 'Mode: Edit', mode: 'wysiwyg', key: '3' },
  { id: 'mode-read', title: 'Mode: Review', mode: 'read', key: '4' },
  { id: 'mode-draw', title: 'Mode: Draw', mode: 'draw' },
];

export function buildCommands(): AppCommand[] {
  return [
    // Tabs
    fromAction('new-window', 'New window', { type: 'new-window' }, { shortcut: modKey('N') }),
    fromAction('new-tab', 'New tab', { type: 'new-tab' }),
    // Every type stays explicitly reachable, so the inference above is never
    // the only route to one.
    {
      id: 'new-note',
      title: 'New note',
      keywords: ['markdown', 'document', 'tab'],
      run: () => runNewTabChoice('note'),
    },
    {
      id: 'new-drawing',
      title: 'New vector drawing',
      keywords: ['svg', 'whiteboard', 'board', 'sketch', 'diagram'],
      run: () => runNewTabChoice('drawing'),
    },
    {
      id: 'new-deck',
      title: 'New Marp presentation',
      keywords: ['slides', 'deck', 'slideshow', 'present', 'marp', 'powerpoint'],
      run: () => runNewTabChoice('deck'),
    },
    fromAction(
      'close-tab',
      'Close tab',
      { type: 'close-tab' },
      { shortcut: modKey('W'), enabled: hasActiveTab },
    ),
    fromAction(
      'next-tab',
      'Next tab',
      { type: 'next-tab' },
      // Ctrl on macOS too: Cmd+Tab is the system app switcher (keymap.ts).
      { shortcut: IS_MAC ? '⌃Tab' : 'Ctrl+Tab', enabled: hasActiveTab },
    ),
    fromAction(
      'prev-tab',
      'Previous tab',
      { type: 'prev-tab' },
      { shortcut: IS_MAC ? '⌃⇧Tab' : 'Ctrl+Shift+Tab', enabled: hasActiveTab },
    ),
    fromAction(
      'rename-tab',
      'Rename tab',
      { type: 'rename-tab' },
      { shortcut: 'F2', enabled: hasActiveTab },
    ),
    // Files
    fromAction(
      'open-file',
      'Open file…',
      { type: 'open-file' },
      { keywords: ['browse'], shortcut: modKey('O') },
    ),
    fromAction('save', 'Save', { type: 'save' }, { shortcut: modKey('S'), enabled: hasActiveTab }),
    fromAction(
      'save-as',
      'Save as…',
      { type: 'save-as' },
      { shortcut: modKey('S', { shift: true }), enabled: hasActiveTab },
    ),
    {
      id: 'export',
      title: 'Export…',
      keywords: ['pdf', 'docx', 'html', 'word', 'share', 'save', 'print', 'standalone', 'theme'],
      enabled: hasActiveTextTab,
      run: () => openExportPreview(),
    },
    {
      id: 'presenter-view',
      title: 'Presenter view (notes, next slide, timer)',
      keywords: ['present', 'slides', 'deck', 'marp', 'speaker', 'notes', 'second', 'screen'],
      enabled: () => tabsStore.getState().activeTab()?.deck === true && !isAndroid(),
      run: () => openPresenterForActiveTab(),
    },
    // View modes
    ...MODE_ENTRIES.map(({ id, title, mode, key }) =>
      fromAction(
        id,
        title,
        { type: 'set-mode', mode },
        {
          keywords: ['view', 'editor'],
          ...(key === undefined ? {} : { shortcut: modKey(key) }),
          enabled: hasActiveTab,
        },
      ),
    ),
    // Display
    fromAction(
      'font-increase',
      'Increase text size',
      { type: 'font-inc' },
      { keywords: ['zoom', 'font', 'bigger'], shortcut: modKey('=') },
    ),
    fromAction(
      'font-decrease',
      'Decrease text size',
      { type: 'font-dec' },
      { keywords: ['zoom', 'font', 'smaller'], shortcut: modKey('-') },
    ),
    fromAction(
      'font-reset',
      'Reset text size',
      { type: 'font-reset' },
      { keywords: ['zoom', 'font', 'default'], shortcut: modKey('0') },
    ),
    fromAction(
      'toggle-fullscreen',
      'Toggle full screen',
      { type: 'toggle-fullscreen' },
      { keywords: ['fullscreen', 'window'], shortcut: IS_MAC ? '⌃⌘F' : 'F11' },
    ),
    fromAction(
      'toggle-distraction-free',
      'Toggle distraction-free',
      { type: 'toggle-distraction-free' },
      { keywords: ['distraction', 'free', 'zen', 'chrome', 'focus'] },
    ),
    // App
    fromAction(
      'open-settings',
      'Open settings',
      { type: 'open-settings' },
      { keywords: ['preferences', 'options', 'theme'], shortcut: modKey(',') },
    ),
    fromAction(
      'global-search',
      'Search in workspaces',
      { type: 'global-search' },
      {
        keywords: ['find', 'grep', 'text', 'notes', 'everywhere'],
        shortcut: modKey('F', { shift: true }),
      },
    ),
    {
      id: 'review-notes-overview',
      title: 'Show all review notes',
      keywords: ['voice', 'comments', 'review', 'annotations', 'overview'],
      run: () => openOverview(),
    },
    fromAction(
      'toggle-outline',
      'Toggle outline',
      { type: 'toggle-outline' },
      {
        keywords: ['headings', 'toc', 'table', 'contents', 'navigate'],
        shortcut: modKey('O', { shift: true }),
      },
    ),
    // Terminal
    {
      id: 'new-terminal',
      title: 'New terminal',
      keywords: ['shell', 'console', 'bash', 'zsh', 'powershell', 'command'],
      enabled: terminalsAvailable,
      run: () => void openTerminal(),
    },
    // One entry per configured profile, so every launch configuration is
    // reachable from the keyboard. Hidden when there is only the one.
    ...(settingsStore.getState().settings.terminalProfiles.length > 1
      ? settingsStore.getState().settings.terminalProfiles.map((profile) => ({
          id: `new-terminal-${profile.id}`,
          title: `New terminal: ${profile.name}`,
          keywords: ['shell', 'console', 'profile'],
          enabled: terminalsAvailable,
          run: () => void openTerminal(profile.id),
        }))
      : []),
    fromAction(
      'terminal-split-right',
      'Terminal: split right',
      { type: 'terminal-split', direction: 'right' },
      { shortcut: modKey('D', { shift: true }), enabled: hasActiveTerminal },
    ),
    fromAction(
      'terminal-split-down',
      'Terminal: split down',
      { type: 'terminal-split', direction: 'down' },
      { shortcut: modKey('E', { shift: true }), enabled: hasActiveTerminal },
    ),
    fromAction(
      'terminal-close-pane',
      'Terminal: close pane',
      { type: 'terminal-close-pane' },
      { shortcut: modKey('X', { shift: true }), enabled: hasActiveTerminal },
    ),
    fromAction(
      'terminal-copy',
      'Terminal: copy',
      { type: 'terminal-copy' },
      { shortcut: modKey('C', { shift: true }), enabled: hasActiveTerminal },
    ),
    fromAction(
      'terminal-paste',
      'Terminal: paste',
      { type: 'terminal-paste' },
      { shortcut: modKey('V', { shift: true }), enabled: hasActiveTerminal },
    ),
    fromAction(
      'terminal-select-all',
      'Terminal: select all',
      { type: 'terminal-select-all' },
      { shortcut: modKey('A', { shift: true }), enabled: hasActiveTerminal },
    ),
    fromAction(
      'terminal-clear-scrollback',
      'Terminal: clear scrollback',
      { type: 'terminal-clear-scrollback' },
      { shortcut: modKey('K', { shift: true }), enabled: hasActiveTerminal },
    ),
    // Palette-only commands (no keyboard shortcut today)
    {
      id: 'toggle-explorer',
      title: 'Toggle file explorer',
      keywords: ['sidebar', 'files', 'workspace', 'drawer'],
      run: () => uiStore.getState().toggleExplorer(),
    },
    {
      id: 'open-docs',
      title: 'Open documentation',
      keywords: ['help', 'manual', 'guide'],
      run: () => openDocs(),
    },
    {
      id: 'add-workspace',
      title: 'Add workspace…',
      keywords: ['folder', 'directory', 'notes'],
      run: () => addWorkspace(),
    },
    {
      id: 'create-workspace',
      title: 'Create new workspace…',
      keywords: ['folder', 'directory', 'new', 'agents', 'AGENTS.md', 'init'],
      enabled: () => !isAndroid(),
      run: () => void createWorkspace(),
    },
    {
      id: 'init-workspace',
      title: 'Initialize workspace…',
      keywords: ['agents', 'AGENTS.md', 'CLAUDE.md', 'folder', 'project', 'directives', 'new'],
      enabled: () => !isAndroid(),
      run: () => void openWorkspaceInit(),
    },
    {
      id: 'workspace-directives',
      title: 'Workspace directives… (active workspace)',
      keywords: ['agents', 'AGENTS.md', 'modules', 'changelog', 'manifest', 'worktree'],
      enabled: () => !isAndroid() && uiStore.getState().selectedExplorerDir !== null,
      run: () => {
        const dir = uiStore.getState().selectedExplorerDir;
        if (dir !== null) {
          void openWorkspaceInit(dir);
        }
      },
    },
    // Git (desktop only): the source-control tab for the repository around
    // the active tab, and the new-worktree dialog inside it.
    fromAction(
      'git-open',
      'Git: source control',
      { type: 'open-git' },
      {
        keywords: ['source', 'control', 'repository', 'worktree', 'branch', 'commit', 'scm'],
        shortcut: modKey('G', { shift: true }),
        enabled: () => !isAndroid(),
      },
    ),
    {
      id: 'git-new-worktree',
      title: 'Git: new worktree…',
      keywords: ['branch', 'agent', 'worktrees', 'checkout'],
      enabled: () => !isAndroid(),
      run: () => void openNewWorktreeForActiveTab(),
    },
    {
      id: 'close-all-tabs',
      title: 'Close all tabs',
      enabled: hasActiveTab,
      run: () => closeAllTabs(),
    },
  ];
}
