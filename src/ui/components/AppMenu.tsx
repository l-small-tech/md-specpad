/**
 * AppMenu — the shared pieces of the app's popover menus.
 *
 * Three menus offer the same app-level actions from opposite ends of the
 * chrome: the ribbon's ☰ button, the tab bar's own right-click menu (free
 * space after the last tab), and the "+ ⌄" new-tab picker. Rather than let
 * them drift, the row widget, the Themes page, and the two shared row blocks
 * (`AppActionRows`, `NewTabRows`) live here and every caller renders them.
 *
 * A row is glyph + label with an optional right-aligned shortcut hint; the
 * glyph column doubles as the ✓ column for checkable rows, so checked and
 * unchecked labels stay aligned. `keepOpen` is for rows that navigate WITHIN
 * the popover (drill-in / back) or apply live and invite a second try (picking
 * a theme).
 */

import { Fragment, type ReactNode } from 'react';
import { setDistractionFree, setOsFullscreen } from '../fullscreen';
import { detectPlatform } from '../keymap';
import { runNewTabChoice, terminalsAvailable } from '../new-tab';
import { isAndroid } from '../platform';
import { openTerminal } from '../terminal-open';
import { openHarnessInDocs } from '../harness-open';
import { copyPrompt, openPromptsDocs, PROMPTS } from '../prompts';
import { openDocs } from '../session';
import { harnessName } from '../../core/settings';
import { HARNESS_PROFILE_ID } from '../../core/types';
import { harnessInstalled, useHarnessAvailability } from '../stores/harness-availability';
import { useSettingsStore } from '../stores/settings';
import { searchStore } from '../stores/search';
import { uiStore, useUiStore } from '../stores/ui';
import { currentThemeValue, themePickerGroups, useThemeRegistry } from '../stores/theme-registry';
import { useWindowTheme } from '../stores/window-theme';
import {
  openHarnessInThemes,
  openThemesHelp,
  reloadThemes,
  selectTheme,
  unpinThemeFromWindow,
} from '../theme-actions';

/** The drill-in pages a popover that renders `AppActionRows` can show. */
export type AppMenuPage = 'root' | 'themes' | 'help' | 'prompts';

/** Which modifier the shortcut hints name. Shared so every menu agrees. */
export const IS_MAC = detectPlatform(navigator.platform) === 'mac';

/** One row of a popover menu: glyph + label, optional right-aligned shortcut. */
export function AppMenuItem({
  glyph,
  label,
  shortcut,
  title,
  disabled,
  onPick,
  onSecondaryPick,
  onClose,
  keepOpen,
}: {
  glyph: ReactNode;
  label: string;
  shortcut?: string;
  title?: string;
  disabled?: boolean;
  onPick: () => void;
  /** Right-click variant of the row's action (theme rows: this window only).
   *  Rows that don't set it keep the browser's default context menu. */
  onSecondaryPick?: () => void;
  onClose: () => void;
  /** Drill-in / back rows stay open — they navigate within the popover. */
  keepOpen?: boolean;
}) {
  return (
    <button
      className="tab-menu-item app-menu-item"
      role="menuitem"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (!keepOpen) {
          onClose();
        }
        onPick();
      }}
      onContextMenu={
        onSecondaryPick &&
        ((e) => {
          e.preventDefault();
          if (!keepOpen) {
            onClose();
          }
          onSecondaryPick();
        })
      }
    >
      <span>
        <span className="app-menu-glyph">{glyph}</span>
        {label}
      </span>
      {shortcut && <span className="app-menu-shortcut">{shortcut}</span>}
    </button>
  );
}

/** A hairline between groups of rows. */
export function AppMenuDivider() {
  return <div className="app-menu-divider" role="separator" />;
}

/**
 * The Themes page — every installed theme (same grouping and order as the
 * Settings dropdown, ✓ on the current one), then Open harness here (the
 * configured harness, started in the themes folder) / Reload, plus Help, which opens the bundled themes
 * guide.
 *
 * It's a drill-in page of its popover rather than a flyout: one panel works
 * the same under a mouse and a finger (Android has no hover), and the theme
 * list can be long.
 */
export function ThemesMenuPage({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const plugins = useThemeRegistry((s) => s.plugins);
  const settings = useSettingsStore((s) => s.settings);
  const pinned = useWindowTheme((s) => s.override !== null);
  const current = currentThemeValue(settings);
  const groups = themePickerGroups(plugins);
  // Android runs a single webview — a per-window theme has nothing to be per
  // (and there is no right-click there either).
  const perWindow = !isAndroid();
  return (
    <>
      <AppMenuItem glyph="‹" label="Back" onPick={onBack} onClose={onClose} keepOpen />
      <AppMenuDivider />
      {/* Picking sets the theme for every window; right-clicking pins it here. */}
      {perWindow && (
        <>
          <div className="app-menu-heading">Right-click: this window only</div>
          {pinned && (
            <AppMenuItem
              glyph="⌂"
              label="Use shared theme"
              title="Stop pinning a theme to this window and follow the all-windows theme again"
              onPick={unpinThemeFromWindow}
              onClose={onClose}
              keepOpen
            />
          )}
          <AppMenuDivider />
        </>
      )}
      {groups.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <AppMenuDivider />}
          {group.label !== null && <div className="app-menu-heading">{group.label}</div>}
          {group.options.map((option) => (
            <AppMenuItem
              key={option.value}
              // The ✓ column is the glyph slot, so checked and unchecked rows
              // keep their labels aligned.
              glyph={option.value === current ? '✓' : ''}
              label={option.label}
              title={perWindow ? 'Set for all windows (right-click: this window only)' : undefined}
              onPick={() => selectTheme(option.value)}
              onSecondaryPick={perWindow ? () => selectTheme(option.value, true) : undefined}
              onClose={onClose}
              // Picking applies live — staying open lets the user try a few.
              keepOpen
            />
          ))}
        </Fragment>
      ))}
      <AppMenuDivider />
      {/* The harness, standing in the themes folder: it edits, creates and
          reveals theme files by conversation. Nothing is typed into it. */}
      {terminalsAvailable() && (
        <AppMenuItem
          glyph={<AiGlyph />}
          label="Open harness here"
          title="Open the configured harness in the themes folder"
          onPick={() => void openHarnessInThemes()}
          onClose={onClose}
        />
      )}
      <AppMenuItem
        glyph="⟲"
        label="Reload"
        title="Re-read the themes folder after editing or adding files"
        onPick={() => void reloadThemes()}
        onClose={onClose}
      />
      <AppMenuItem
        glyph="?"
        label="Help"
        title="How to create your own theme"
        onPick={openThemesHelp}
        onClose={onClose}
      />
    </>
  );
}

/**
 * The shell icon the terminal rows wear — a terminal window with a prompt,
 * drawn rather than borrowed from a font so it reads as a shell at every UI
 * scale (the ❯ it replaces read as a submenu arrow next to the other rows).
 * `currentColor` keeps it on-theme, including in a row's disabled state.
 */
function ShellGlyph() {
  return (
    <svg className="app-menu-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.9 6.6 6.9 8.4 4.9 10.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.4 10.4h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The Harness row's glyph: a six-spoke asterisk, the same mark the harnesses
 * themselves print as their status glyph (✳), drawn so it matches the
 * ShellGlyph's stroke weight.
 */
function AiGlyph() {
  return (
    <svg
      className="app-menu-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <path d="M8 2.5v11M3.24 5.25l9.52 5.5M12.76 5.25l-9.52 5.5" />
    </svg>
  );
}

/**
 * The "what kind of tab" rows — note, the harness, the terminal profile(s),
 * drawing.
 *
 * Shared because the choice is offered from two places: the "+" button's
 * picker and the bar menu's New tab page. Terminal profiles sit in the same
 * flat list as the document kinds rather than under a heading of their own:
 * a shell is one more thing the + button makes, not a separate section.
 * Order is by how often it's picked — note, shell, then the drawing — and the
 * shells are absent entirely on Android, which has no pty.
 */
export function NewTabRows({ onClose }: { onClose: () => void }) {
  const profiles = useSettingsStore((s) => s.settings.terminalProfiles);
  const harnessLabel = useSettingsStore((s) => harnessName(s.settings));
  const installed = useHarnessAvailability(harnessInstalled);

  return (
    <>
      <AppMenuItem
        glyph="📝"
        label="Markdown File"
        onPick={() => runNewTabChoice('note')}
        onClose={onClose}
      />
      {/* The harness: a terminal running the configured coding agent, above
          the plain shell because reaching for it is the more common pick. The
          row wears the harness's name — which one it is lives in Settings.
          With none installed there is nothing to launch, so the row opens the
          Harness settings, where every harness has an Install button. */}
      {terminalsAvailable() && (
        <AppMenuItem
          glyph={<AiGlyph />}
          label={installed ? harnessLabel : 'Harness'}
          title={
            installed
              ? 'Harness — switch the harness in Settings'
              : 'No harness installed — open Settings to install one'
          }
          onPick={() =>
            installed
              ? openTerminal(HARNESS_PROFILE_ID)
              : uiStore.getState().openSettings('harness')
          }
          onClose={onClose}
        />
      )}
      {terminalsAvailable() &&
        profiles.map((profile) => (
          <AppMenuItem
            key={profile.id}
            glyph={<ShellGlyph />}
            label={profile.name}
            onPick={() => openTerminal(profile.id)}
            onClose={onClose}
          />
        ))}
      <AppMenuItem
        glyph="✎"
        label="Vector drawing (.svg)"
        onPick={() => runNewTabChoice('drawing')}
        onClose={onClose}
      />
      <AppMenuItem
        glyph="▭"
        label="Marp presentation (.md)"
        onPick={() => runNewTabChoice('deck')}
        onClose={onClose}
      />
    </>
  );
}

/**
 * The app-level rows every popover carries: search, the command palette,
 * Themes, Settings, and the two full-screen stages.
 *
 * Shared so the tab bar's menu and the "+" picker cannot drift — a user who
 * opened the picker to start something is one row away from the settings and
 * the stage that thing should open into, without hunting for a second menu.
 * Themes is a drill-in page rather than a flyout (see `ThemesMenuPage`), so
 * the caller owns the page state and passes `onOpenThemes`.
 *
 * These are APP rows: everything here means the same thing whatever tab is in
 * front. What acts on one document (export, copy raw text) belongs to that
 * tab's own right-click menu instead — TabBar's `TabContextMenu`.
 */
export function AppActionRows({
  onOpenThemes,
  onOpenHelp,
  onClose,
}: {
  onOpenThemes: () => void;
  onOpenHelp: () => void;
  onClose: () => void;
}) {
  const distractionFree = useUiStore((s) => s.distractionFree);
  const osFullscreen = useUiStore((s) => s.osFullscreen);

  return (
    <>
      <AppMenuItem
        glyph="🔍"
        label="Search workspaces"
        shortcut={IS_MAC ? '⇧⌘F' : 'Ctrl+Shift+F'}
        onPick={() => searchStore.getState().openSearch()}
        onClose={onClose}
      />
      {/* The menu is the palette's only entry point on Android (no Ctrl+K
          there), and a discoverable one on desktop. */}
      <AppMenuItem
        glyph="»"
        label="Command palette"
        shortcut={IS_MAC ? '⌘K' : 'Ctrl+K'}
        onPick={() => uiStore.getState().togglePalette()}
        onClose={onClose}
      />
      <AppMenuDivider />
      <AppMenuItem
        glyph="🎨"
        label="Themes"
        title="Pick a theme, or make your own"
        shortcut="›"
        onPick={onOpenThemes}
        onClose={onClose}
        keepOpen
      />
      <AppMenuItem
        glyph="⚙"
        label="Settings"
        shortcut={IS_MAC ? '⌘,' : 'Ctrl+,'}
        onPick={() => uiStore.getState().openSettings()}
        onClose={onClose}
      />
      <AppMenuDivider />
      {/* Two independent switches (the ✓ shows which are on): distraction-free
          hides the chrome, full screen fills the screen; either works alone. */}
      <AppMenuItem
        glyph={distractionFree ? '✓' : '⤢'}
        label="Distraction-free"
        title="Hide the app chrome and show only the document"
        onPick={() => setDistractionFree(!distractionFree)}
        onClose={onClose}
      />
      {/* Android's window already fills the screen — there is no OS full
          screen to toggle there (see ui/fullscreen.ts). */}
      {!isAndroid() && (
        <AppMenuItem
          glyph={osFullscreen ? '✓' : '⛶'}
          label="Full screen"
          title="Make the window fill the screen; the interface stays as it is"
          shortcut={IS_MAC ? '⌃⌘F' : 'F11'}
          onPick={() => setOsFullscreen(!osFullscreen)}
          onClose={onClose}
        />
      )}
      <AppMenuDivider />
      <AppMenuItem
        glyph="?"
        label="Help…"
        title="The user guide, and prompts to hand an AI agent"
        shortcut="›"
        onPick={onOpenHelp}
        onClose={onClose}
        keepOpen
      />
    </>
  );
}

/**
 * The Help page — the bundled user guide, the shortcuts page, the harness
 * opened in the docs folder, and the Prompts page (a further drill-in). A page rather than a flyout for the same reason
 * Themes is one (mouse and finger alike).
 */
export function HelpMenuPage({
  onBack,
  onOpenPrompts,
  onClose,
}: {
  onBack: () => void;
  onOpenPrompts: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <AppMenuItem glyph="‹" label="Back" onPick={onBack} onClose={onClose} keepOpen />
      <AppMenuDivider />
      <AppMenuItem
        glyph="📖"
        label="User guide"
        title="Open the documentation in the sidebar"
        onPick={() => openDocs()}
        onClose={onClose}
      />
      <AppMenuItem
        glyph="⌨"
        label="Keyboard shortcuts"
        title="Every shortcut on one page"
        onPick={() => openDocs('keyboard-shortcuts.md')}
        onClose={onClose}
      />
      {terminalsAvailable() && (
        <AppMenuItem
          glyph={<AiGlyph />}
          label="Open harness in docs"
          title="Open the configured harness in the documentation folder — ask it about the app"
          onPick={openHarnessInDocs}
          onClose={onClose}
        />
      )}
      <AppMenuDivider />
      <AppMenuItem
        glyph={<AiGlyph />}
        label="Prompts"
        title="Ready-made briefs to paste into an AI agent"
        shortcut="›"
        onPick={onOpenPrompts}
        onClose={onClose}
        keepOpen
      />
    </>
  );
}

/**
 * The Prompts page — one row per bundled prompt (ui/prompts.ts). Picking a
 * row copies the prompt to the clipboard for pasting into a harness terminal
 * or a chat assistant; right-clicking opens its docs page instead. The last
 * row opens the guide that explains them.
 */
export function PromptsMenuPage({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  return (
    <>
      <AppMenuItem glyph="‹" label="Back" onPick={onBack} onClose={onClose} keepOpen />
      <AppMenuDivider />
      <div className="app-menu-heading">Click copies · right-click reads</div>
      {PROMPTS.map((prompt) => (
        <AppMenuItem
          key={prompt.id}
          glyph="📋"
          label={prompt.label}
          title={`${prompt.title} — click to copy, right-click to read`}
          onPick={() => void copyPrompt(prompt)}
          onSecondaryPick={() => openPromptsDocs(prompt)}
          onClose={onClose}
        />
      ))}
      <AppMenuDivider />
      <AppMenuItem
        glyph="?"
        label="About prompts"
        title="What these are and how to use them"
        onPick={() => openPromptsDocs()}
        onClose={onClose}
      />
    </>
  );
}
