import { describe, expect, test } from 'vitest';
import {
  HARNESSES,
  HARNESS_FONT_SIZE_DELTA,
  harnessName,
  DEFAULT_SETTINGS,
  FONT_SIZE_DELTA_RANGE,
  SETTINGS_SCHEMA,
  keepWindowLocalSettings,
  MAX_EXPLORER_PATHS,
  normalizePathList,
  normalizeSettings,
  normalizeTerminalProfile,
  parseCommandLine,
  pickDefaultHarness,
  pickUnusedColor,
  profileFontSize,
  resolveTerminalProfile,
  resolvedHarness,
} from '../settings';
import {
  HARNESS_IDS,
  HARNESS_PROFILE_ID,
  LEGACY_AI_THEME_PROFILE_ID,
  LEGACY_HARNESS_PROFILE_ID,
} from '../types';
import {
  CURSOR_STYLES,
  EDITOR_FONT_IDS,
  TERMINAL_BELLS,
  UI_FONT_IDS,
  WORKSPACE_COLORS,
} from '../types';

describe('normalizeSettings', () => {
  test('non-object input yields pure defaults', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  test('valid fields pass through', () => {
    const settings = normalizeSettings({
      notesDir: 'D:/notes',
      harness: 'chatgpt',
      // Light/Dark is a meaningful override only on the built-in default palette;
      // a plugin scheme is exercised by the merged-model test below.
      theme: 'dark',
      colorScheme: 'default',
      fontSize: 16,
      editorFont: 'jetbrains-mono',
      uiFont: 'inter',
      defaultMode: 'split',
      wordWrap: false,
      lineNumbers: true,
      collapsibleHeadings: true,
      ligatures: false,
      readerMargins: 'wide',
      smoothScrolling: false,
      cursorStyle: 'underscore',
      confirmFileMove: false,
      liveSave: true,
      autoUpdateCheck: false,
      lastUpdateCheck: 1756000000000,
      previewTabs: false,
      groupTabsByWorkspace: false,
      workspaces: [{ name: 'Work', path: 'D:/work-notes', color: 'teal' }],
      defaultWorkspaceColor: 'blue',
      imagePasteLocation: 'workspaceRoot',
      imageFolderName: 'assets',
      voiceNotesLocation: 'nextToFile',
      voiceNotesFolderName: 'Review Notes',
      showAllFilesDirs: ['C:/work/proj', 42, ''],
      hideUnsupportedDirs: ['C:/work/proj/bin', null],
      showHiddenFiles: true,
      scanPreset: 'balanced',
      scanSmoothing: 'precise',
      schemaVersion: SETTINGS_SCHEMA,
    });
    expect(settings).toEqual({
      notesDir: 'D:/notes',
      harness: 'chatgpt',
      harnessCustomCommand: '',
      theme: 'dark',
      colorScheme: 'default',
      fontSize: 16,
      editorFont: 'jetbrains-mono',
      uiFont: 'inter',
      defaultMode: 'split',
      wordWrap: false,
      lineNumbers: true,
      collapsibleHeadings: true,
      ligatures: false,
      readerMargins: 'wide',
      smoothScrolling: false,
      cursorStyle: 'underscore',
      confirmFileMove: false,
      liveSave: true,
      autoUpdateCheck: false,
      lastUpdateCheck: 1756000000000,
      previewTabs: false,
      groupTabsByWorkspace: false,
      workspaces: [{ name: 'Work', path: 'D:/work-notes', color: 'teal' }],
      defaultWorkspaceColor: 'blue',
      imagePasteLocation: 'workspaceRoot',
      imageFolderName: 'assets',
      voiceNotesLocation: 'nextToFile',
      voiceNotesFolderName: 'Review Notes',
      desktopDictationEngine: 'auto',
      androidDictationEngine: 'system',
      whisperModel: 'small.en-q5_1',
      whisperUseGpu: true,
      whisperSetupOffered: false,
      explorerCollapsedWorkspaces: [],
      explorerExpandedDirs: [],
      showAllFilesDirs: ['C:/work/proj'],
      hideUnsupportedDirs: ['C:/work/proj/bin'],
      showHiddenFiles: true,
      reviewBaseBranch: '',
      gitActiveWorktreesOnly: false,
      diffInline: false,
      scanPreset: 'balanced',
      scanSmoothing: 'precise',
      schemaVersion: SETTINGS_SCHEMA,
      // Not supplied above, so every terminal field comes back at its default.
      terminalProfiles: DEFAULT_SETTINGS.terminalProfiles,
      defaultTerminalProfile: 'shell',
      terminalShell: '',
      terminalFont: 'fira-code',
      terminalScrollback: 10_000,
      terminalScrollLines: 3,
      terminalCursorStyle: 'block',
      terminalCursorBlink: true,
      terminalBell: 'cursor',
      terminalCopyOnSelect: false,
      terminalConfirmMultilinePaste: true,
      terminalAllowOscClipboard: false,
      terminalAltSendsEscape: true,
      terminalBackspaceSendsDelete: true,
      terminalOnExit: 'close',
      terminalConfirmCloseRunning: true,
    });
  });

  test('a plugin colorScheme forces theme to system (merged Theme picker)', () => {
    // The unified Theme picker makes a plugin scheme always follow the OS
    // light/dark, so a legacy `theme: 'light'|'dark'` paired with a plugin is
    // coerced back to 'system'. The plugin id itself passes through.
    expect(normalizeSettings({ theme: 'dark', colorScheme: 'nord' })).toMatchObject({
      theme: 'system',
      colorScheme: 'nord',
    });
    // On the default palette, a forced light/dark is preserved.
    expect(normalizeSettings({ theme: 'dark', colorScheme: 'default' })).toMatchObject({
      theme: 'dark',
      colorScheme: 'default',
    });
  });

  test('each invalid field independently falls back to its default', () => {
    const settings = normalizeSettings({
      notesDir: 123,
      theme: 'sepia',
      // colorScheme accepts any non-empty string now (pluggable themes), so an
      // "invalid" value here is a non-string that must fall back to the default.
      colorScheme: 42,
      fontSize: 'big',
      editorFont: 'comic-sans',
      uiFont: 'papyrus',
      defaultMode: 'zen',
      wordWrap: 'yes',
      lineNumbers: 'on',
      collapsibleHeadings: 'yes',
      ligatures: 1,
      readerMargins: 'huge',
      smoothScrolling: 'yes',
      cursorStyle: 'beam',
      confirmFileMove: 'sure',
      liveSave: 'always',
      autoUpdateCheck: 'weekly',
      lastUpdateCheck: 'never',
      previewTabs: 'maybe',
      workspaces: 'not-a-list',
      defaultWorkspaceColor: 'mauve',
      imagePasteLocation: 'wherever',
      imageFolderName: 42,
      voiceNotesLocation: 'somewhere',
      voiceNotesFolderName: '   ',
      desktopDictationEngine: 'siri',
      whisperModel: 7,
      scanPreset: 'ultra',
      scanSmoothing: 'extreme',
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test('update-check prefs: on by default, NaN/Infinity stamps degrade to never-checked', () => {
    expect(DEFAULT_SETTINGS.autoUpdateCheck).toBe(true);
    expect(DEFAULT_SETTINGS.lastUpdateCheck).toBeNull();
    expect(normalizeSettings({ lastUpdateCheck: Number.NaN }).lastUpdateCheck).toBeNull();
    expect(
      normalizeSettings({ lastUpdateCheck: Number.POSITIVE_INFINITY }).lastUpdateCheck,
    ).toBeNull();
    expect(normalizeSettings({ lastUpdateCheck: 0 }).lastUpdateCheck).toBe(0);
  });

  test('scan prefs round-trip and reject unknown values', () => {
    expect(normalizeSettings({ scanPreset: 'fast', scanSmoothing: 'simplified' })).toMatchObject({
      scanPreset: 'fast',
      scanSmoothing: 'simplified',
    });
    expect(normalizeSettings({ scanPreset: 3600, scanSmoothing: 2 })).toMatchObject({
      scanPreset: DEFAULT_SETTINGS.scanPreset,
      scanSmoothing: DEFAULT_SETTINGS.scanSmoothing,
    });
  });

  test('workspaces keeps well-formed entries and drops malformed ones', () => {
    const settings = normalizeSettings({
      workspaces: [
        { name: 'Work', path: 'D:/work', color: 'red' },
        { name: '   ', path: 'D:/unnamed' }, // blank name falls back to path
        { name: 'no path' },
        { path: '' },
        'garbage',
        null,
      ],
    });
    expect(settings.workspaces).toEqual([
      { name: 'Work', path: 'D:/work', color: 'red' },
      { name: 'D:/unnamed', path: 'D:/unnamed', color: null },
    ]);
  });

  test('workspaces keep a true liveEdit flag and drop anything else', () => {
    const settings = normalizeSettings({
      workspaces: [
        { name: 'Team', path: 'D:/drive/team', liveEdit: true },
        { name: 'Off', path: 'D:/off', liveEdit: false },
        { name: 'Junk', path: 'D:/junk', liveEdit: 'yes' },
      ],
    });
    expect(settings.workspaces).toEqual([
      { name: 'Team', path: 'D:/drive/team', color: null, liveEdit: true },
      { name: 'Off', path: 'D:/off', color: null },
      { name: 'Junk', path: 'D:/junk', color: null },
    ]);
  });

  test('pickUnusedColor prefers the first unused palette color', () => {
    expect(pickUnusedColor([])).toBe(WORKSPACE_COLORS[0]);
    expect(pickUnusedColor(['red', null])).toBe('orange');
    expect(pickUnusedColor(['orange', 'red'])).toBe('yellow');
  });

  test('pickUnusedColor cycles fairly once the palette is exhausted', () => {
    // Every color used once, 'red' used twice → the next least-used in
    // palette order is 'orange'.
    expect(pickUnusedColor([...WORKSPACE_COLORS, 'red'])).toBe('orange');
    // All used equally → back to the first palette color.
    expect(pickUnusedColor([...WORKSPACE_COLORS])).toBe('red');
  });

  test('an unknown workspace color falls back to null', () => {
    const settings = normalizeSettings({
      workspaces: [{ name: 'W', path: 'D:/w', color: '#ff0000' }],
      defaultWorkspaceColor: 42,
    });
    expect(settings.workspaces[0]!.color).toBeNull();
    expect(settings.defaultWorkspaceColor).toBeNull();
  });

  test('empty notesDir string means "use platform default"', () => {
    expect(normalizeSettings({ notesDir: '' }).notesDir).toBeNull();
  });

  test('image paste location accepts the three modes and rejects others', () => {
    for (const loc of ['subfolder', 'sameFolder', 'workspaceRoot'] as const) {
      expect(normalizeSettings({ imagePasteLocation: loc }).imagePasteLocation).toBe(loc);
    }
    expect(normalizeSettings({ imagePasteLocation: 'nope' }).imagePasteLocation).toBe('subfolder');
  });

  test('image folder name trims, and blank/non-string falls back to default', () => {
    expect(normalizeSettings({ imageFolderName: '  assets  ' }).imageFolderName).toBe('assets');
    expect(normalizeSettings({ imageFolderName: '   ' }).imageFolderName).toBe('images');
  });

  test('review baseline branch defaults to auto-detect and keeps a blank as blank', () => {
    // '' is the auto-detect sentinel (development / main / master), so unlike
    // the folder-name fields a blank string must survive normalization.
    expect(DEFAULT_SETTINGS.reviewBaseBranch).toBe('');
    expect(normalizeSettings({}).reviewBaseBranch).toBe('');
    expect(normalizeSettings({ reviewBaseBranch: '  trunk  ' }).reviewBaseBranch).toBe('trunk');
    expect(normalizeSettings({ reviewBaseBranch: '   ' }).reviewBaseBranch).toBe('');
    expect(normalizeSettings({ reviewBaseBranch: 42 }).reviewBaseBranch).toBe('');
  });

  test('diffs default to side by side; the inline choice persists', () => {
    expect(DEFAULT_SETTINGS.diffInline).toBe(false);
    expect(normalizeSettings({}).diffInline).toBe(false);
    expect(normalizeSettings({ diffInline: true }).diffInline).toBe(true);
    expect(normalizeSettings({ diffInline: 'yes' }).diffInline).toBe(false);
  });

  test('voice notes default to a shared "Voice Notes" workspace folder', () => {
    expect(DEFAULT_SETTINGS.voiceNotesLocation).toBe('workspaceFolder');
    expect(DEFAULT_SETTINGS.voiceNotesFolderName).toBe('Voice Notes');
    expect(DEFAULT_SETTINGS.desktopDictationEngine).toBe('auto');
    expect(DEFAULT_SETTINGS.whisperModel).toBe('small.en-q5_1');
    expect(DEFAULT_SETTINGS.androidDictationEngine).toBe('system');
    expect(DEFAULT_SETTINGS.whisperUseGpu).toBe(true);
    expect(DEFAULT_SETTINGS.whisperSetupOffered).toBe(false);
    expect(normalizeSettings({ androidDictationEngine: 'whisper' }).androidDictationEngine).toBe(
      'whisper',
    );
    expect(normalizeSettings({ androidDictationEngine: 'siri' }).androidDictationEngine).toBe(
      'system',
    );
    expect(normalizeSettings({ whisperUseGpu: false }).whisperUseGpu).toBe(false);
    expect(normalizeSettings({ whisperUseGpu: 'no' }).whisperUseGpu).toBe(true);
    expect(normalizeSettings({ whisperSetupOffered: true }).whisperSetupOffered).toBe(true);
    expect(normalizeSettings({ desktopDictationEngine: 'whisper' }).desktopDictationEngine).toBe(
      'whisper',
    );
    expect(normalizeSettings({ desktopDictationEngine: 'siri' }).desktopDictationEngine).toBe(
      'auto',
    );
    expect(normalizeSettings({ whisperModel: ' base.en-q5_1 ' }).whisperModel).toBe('base.en-q5_1');
    expect(normalizeSettings({ whisperModel: '' }).whisperModel).toBe('small.en-q5_1');
    // A pick from the earlier, full-precision manifest lands on its replacement.
    expect(normalizeSettings({ whisperModel: 'small.en' }).whisperModel).toBe('small.en-q5_1');
    expect(normalizeSettings({ whisperModel: 'medium.en' }).whisperModel).toBe(
      'large-v3-turbo-q5_0',
    );
    expect(normalizeSettings({ whisperModel: 'custom' }).whisperModel).toBe('custom');
    expect(normalizeSettings({ voiceNotesFolderName: '  Notes  ' }).voiceNotesFolderName).toBe(
      'Notes',
    );
    expect(normalizeSettings({ voiceNotesLocation: 'nextToFile' }).voiceNotesLocation).toBe(
      'nextToFile',
    );
    expect(normalizeSettings({ imageFolderName: 5 }).imageFolderName).toBe('images');
  });

  test('every editor mode is accepted as a default, including read', () => {
    for (const mode of ['raw', 'split', 'wysiwyg', 'read'] as const) {
      expect(normalizeSettings({ defaultMode: mode }).defaultMode).toBe(mode);
    }
  });

  test('fontSize is rounded and clamped to a sane range', () => {
    expect(normalizeSettings({ fontSize: 13.6 }).fontSize).toBe(14);
    expect(normalizeSettings({ fontSize: 2 }).fontSize).toBe(8);
    expect(normalizeSettings({ fontSize: 400 }).fontSize).toBe(40);
    expect(normalizeSettings({ fontSize: Number.NaN }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  test('every bundled editor font and ui font id is accepted', () => {
    for (const id of EDITOR_FONT_IDS) {
      expect(normalizeSettings({ editorFont: id }).editorFont).toBe(id);
    }
    for (const id of UI_FONT_IDS) {
      expect(normalizeSettings({ uiFont: id }).uiFont).toBe(id);
    }
    // A font family name (rather than an id) is not accepted — defaults win.
    expect(normalizeSettings({ editorFont: 'Fira Code' }).editorFont).toBe('fira-code');
    expect(normalizeSettings({ uiFont: 'Inter' }).uiFont).toBe('match');
  });

  test('any non-empty string is a valid (pluggable) color scheme id', () => {
    // Themes are now pluggable, so an arbitrary id is accepted and kept — an id
    // with no loaded theme falls back to the default palette at render time.
    for (const scheme of ['default', 'solarized', 'my-custom-theme']) {
      expect(normalizeSettings({ colorScheme: scheme }).colorScheme).toBe(scheme);
    }
    expect(normalizeSettings({ colorScheme: '  spaced  ' }).colorScheme).toBe('spaced');
    // Blank / non-string / missing degrade to the default id.
    expect(normalizeSettings({ colorScheme: '   ' }).colorScheme).toBe('default');
    expect(normalizeSettings({ colorScheme: 42 }).colorScheme).toBe('default');
    expect(normalizeSettings({}).colorScheme).toBe('default');
  });

  test('every reader-margins mode is accepted', () => {
    for (const margins of ['narrow', 'normal', 'wide'] as const) {
      expect(normalizeSettings({ readerMargins: margins }).readerMargins).toBe(margins);
    }
  });

  test('every cursor style is accepted; anything else defaults to bar', () => {
    for (const style of CURSOR_STYLES) {
      expect(normalizeSettings({ cursorStyle: style }).cursorStyle).toBe(style);
    }
    expect(normalizeSettings({ cursorStyle: 'beam' }).cursorStyle).toBe('bar');
  });

  test('every bell mode is accepted; anything else defaults to the cursor bell', () => {
    for (const bell of TERMINAL_BELLS) {
      // Stamped with the current schema, so the 'visual' migration below is
      // out of the way and this is validation only.
      expect(
        normalizeSettings({ terminalBell: bell, schemaVersion: SETTINGS_SCHEMA }).terminalBell,
      ).toBe(bell);
    }
    // Including 'audible': there is no such mode, and a settings file that asks
    // for one must not silently become a flashing pane.
    expect(normalizeSettings({ terminalBell: 'audible' }).terminalBell).toBe('cursor');
  });

  test('a pre-versioning "visual" bell upgrades to the cursor bell, once', () => {
    // The old dialog had one checkbox: 'visual' meant "a bell at all", never a
    // preference for the flash — so an unversioned file upgrades.
    expect(normalizeSettings({ terminalBell: 'visual' }).terminalBell).toBe('cursor');
    expect(normalizeSettings({ terminalBell: 'off' }).terminalBell).toBe('off');
    // Once stamped, a deliberate pick of the flash survives every later load.
    const chosen = normalizeSettings({ terminalBell: 'visual', schemaVersion: SETTINGS_SCHEMA });
    expect(chosen.terminalBell).toBe('visual');
    expect(normalizeSettings(chosen).terminalBell).toBe('visual');
  });

  test('unknown extra fields are dropped', () => {
    const settings = normalizeSettings({ legacyField: true, theme: 'light' });
    expect(settings).not.toHaveProperty('legacyField');
    expect(settings.theme).toBe('light');
  });
});

describe('normalizePathList (persisted explorer tree shape)', () => {
  test('drops non-strings and empties, de-duplicates, preserves order', () => {
    expect(normalizePathList(['D:/a', 42, '', 'D:/b', null, 'D:/a'])).toEqual(['D:/a', 'D:/b']);
  });

  test('a non-array (missing/garbage key) yields an empty list', () => {
    expect(normalizePathList(undefined)).toEqual([]);
    expect(normalizePathList('D:/a')).toEqual([]);
  });

  test('keeps the newest entries when over the cap', () => {
    const many = Array.from({ length: MAX_EXPLORER_PATHS + 5 }, (_, i) => `D:/d${i}`);
    const kept = normalizePathList(many);
    expect(kept).toHaveLength(MAX_EXPLORER_PATHS);
    expect(kept.at(-1)).toBe(many.at(-1));
    expect(kept[0]).toBe('D:/d5');
  });

  test('round-trips through normalizeSettings', () => {
    expect(
      normalizeSettings({
        explorerCollapsedWorkspaces: ['D:/work'],
        explorerExpandedDirs: ['D:/work/sub', 7],
      }),
    ).toMatchObject({
      explorerCollapsedWorkspaces: ['D:/work'],
      explorerExpandedDirs: ['D:/work/sub'],
    });
  });
});

describe('terminal profiles: the schema-2 migration', () => {
  const stockClaude = { id: 'claude', name: 'Claude Code', program: 'claude', args: [], env: {} };
  const stockShell = { id: 'shell', name: 'System shell', args: [], env: {} };

  test('a pre-2 file loses the stock Claude Code profile and gains the new shell name', () => {
    const s = normalizeSettings({
      schemaVersion: 1,
      terminalProfiles: [stockShell, stockClaude],
      defaultTerminalProfile: 'claude',
    });
    expect(s.terminalProfiles).toEqual([{ id: 'shell', name: 'Shell', args: [], env: {} }]);
    // Its default pointed at the profile that just went away.
    expect(s.defaultTerminalProfile).toBe('shell');
    expect(s.schemaVersion).toBe(2);
  });

  test('a claude profile the user configured is a real choice and survives', () => {
    const configured = { ...stockClaude, args: ['--resume'] };
    const s = normalizeSettings({ schemaVersion: 1, terminalProfiles: [stockShell, configured] });
    expect(s.terminalProfiles.map((p) => p.id)).toEqual(['shell', 'claude']);
    // A renamed shell is a choice too — only the stock string is rewritten.
    const renamed = normalizeSettings({
      schemaVersion: 1,
      terminalProfiles: [{ ...stockShell, name: 'My shell' }],
    });
    expect(renamed.terminalProfiles[0]!.name).toBe('My shell');
  });

  test('a file already at schema 2 is left alone — a re-added claude profile stays', () => {
    const s = normalizeSettings({
      schemaVersion: 2,
      terminalProfiles: [{ id: 'shell', name: 'Shell', args: [], env: {} }, stockClaude],
    });
    expect(s.terminalProfiles.map((p) => p.id)).toEqual(['shell', 'claude']);
  });

  test('migrating away every profile falls back to the defaults, never an empty list', () => {
    const s = normalizeSettings({ schemaVersion: 0, terminalProfiles: [stockClaude] });
    expect(s.terminalProfiles).toEqual(DEFAULT_SETTINGS.terminalProfiles);
  });
});

describe('terminal profiles: font size', () => {
  const base = { id: 'p', name: 'P', args: [], env: {} };

  test('fontSizeDelta is rounded, clamped, and dropped when zero or absent', () => {
    expect(normalizeTerminalProfile({ ...base, fontSizeDelta: 2 })!.fontSizeDelta).toBe(2);
    expect(normalizeTerminalProfile({ ...base, fontSizeDelta: -3.4 })!.fontSizeDelta).toBe(-3);
    expect(normalizeTerminalProfile({ ...base, fontSizeDelta: 99 })!.fontSizeDelta).toBe(
      FONT_SIZE_DELTA_RANGE.max,
    );
    expect(normalizeTerminalProfile({ ...base, fontSizeDelta: -99 })!.fontSizeDelta).toBe(
      FONT_SIZE_DELTA_RANGE.min,
    );
    expect(normalizeTerminalProfile({ ...base, fontSizeDelta: 0 })).not.toHaveProperty(
      'fontSizeDelta',
    );
    expect(normalizeTerminalProfile({ ...base, fontSizeDelta: 'big' })).not.toHaveProperty(
      'fontSizeDelta',
    );
    expect(normalizeTerminalProfile(base)).not.toHaveProperty('fontSizeDelta');
    // Through the whole settings blob too.
    const s = normalizeSettings({ terminalProfiles: [{ ...base, fontSizeDelta: 4 }] });
    expect(s.terminalProfiles[0]!.fontSizeDelta).toBe(4);
  });

  test('profileFontSize: absolute fontSize wins, else editor size plus delta, never below 1', () => {
    expect(profileFontSize({ ...base }, 14)).toBe(14);
    expect(profileFontSize({ ...base, fontSizeDelta: 2 }, 14)).toBe(16);
    expect(profileFontSize({ ...base, fontSizeDelta: -2 }, 14)).toBe(12);
    expect(profileFontSize({ ...base, fontSize: 20, fontSizeDelta: 2 }, 14)).toBe(20);
    expect(profileFontSize({ ...base, fontSizeDelta: -8 }, 8)).toBe(1);
  });
});

describe('the Harness virtual profile', () => {
  test("the harness setting defaults to 'auto' and rejects unknown values", () => {
    expect(DEFAULT_SETTINGS.harness).toBe('auto');
    // Preference order, and every known id round-trips.
    expect(HARNESS_IDS).toEqual(['claude', 'chatgpt', 'gemini', 'grok', 'copilot', 'opencode']);
    for (const id of HARNESS_IDS) {
      expect(normalizeSettings({ harness: id }).harness).toBe(id);
    }
    expect(normalizeSettings({ harness: 'custom' }).harness).toBe('custom');
    expect(normalizeSettings({ harness: 'auto' }).harness).toBe('auto');
    expect(normalizeSettings({ harness: 'skynet' }).harness).toBe('auto');
    // Case matters: ids are what the table is keyed by.
    expect(normalizeSettings({ harness: 'Copilot' }).harness).toBe('auto');
  });

  test('the pre-rename aiTui* keys are read when the harness ones are absent', () => {
    expect(normalizeSettings({ aiTuiAgent: 'gemini' }).harness).toBe('gemini');
    expect(
      normalizeSettings({ aiTuiAgent: 'custom', aiTuiCustomCommand: ' aider ' }),
    ).toMatchObject({ harness: 'custom', harnessCustomCommand: 'aider' });
    // The new keys win where both are written.
    expect(normalizeSettings({ harness: 'grok', aiTuiAgent: 'gemini' }).harness).toBe('grok');
  });

  test("'auto' resolves to Claude until a scan settles it; pickDefaultHarness ranks by order", () => {
    expect(resolvedHarness(DEFAULT_SETTINGS)).toBe('claude');
    expect(resolvedHarness({ ...DEFAULT_SETTINGS, harness: 'grok' })).toBe('grok');
    expect(resolveTerminalProfile(DEFAULT_SETTINGS, HARNESS_PROFILE_ID).program).toBe('claude');

    expect(pickDefaultHarness(() => true)).toBe('claude');
    expect(pickDefaultHarness((id) => id !== 'claude')).toBe('chatgpt');
    expect(pickDefaultHarness((id) => id === 'opencode' || id === 'gemini')).toBe('gemini');
    expect(pickDefaultHarness(() => false)).toBeNull();
  });

  test('a snapshot naming the pre-rename profile id still restores the harness', () => {
    const legacy = resolveTerminalProfile(DEFAULT_SETTINGS, LEGACY_HARNESS_PROFILE_ID);
    expect(legacy.program).toBe('claude');
    expect(legacy.name).toBe('Claude');
    expect(legacy.fontSizeDelta).toBe(HARNESS_FONT_SIZE_DELTA);
  });

  test('every harness has a command; Copilot and opencode launch by their own names', () => {
    for (const id of HARNESS_IDS) {
      expect(HARNESSES[id].program.length).toBeGreaterThan(0);
      expect(HARNESSES[id].name.length).toBeGreaterThan(0);
    }
    expect(HARNESSES.copilot).toEqual({ name: 'Copilot', program: 'copilot' });
    expect(HARNESSES.opencode).toEqual({ name: 'opencode', program: 'opencode' });
  });

  test('the harness is launched with no injected args — no prompt, no model pins', () => {
    for (const harness of HARNESS_IDS) {
      const settings = { ...DEFAULT_SETTINGS, harness };
      for (const id of [
        HARNESS_PROFILE_ID,
        LEGACY_HARNESS_PROFILE_ID,
        LEGACY_AI_THEME_PROFILE_ID,
      ]) {
        const profile = resolveTerminalProfile(settings, id);
        expect(profile.program).toBe(HARNESSES[harness].program);
        expect(profile.args).toEqual([]);
      }
    }
  });

  test('a snapshot naming the retired ai-theme id restores the plain harness', () => {
    const legacy = resolveTerminalProfile(DEFAULT_SETTINGS, LEGACY_AI_THEME_PROFILE_ID);
    expect(legacy).toBe(resolveTerminalProfile(DEFAULT_SETTINGS, HARNESS_PROFILE_ID));
    expect(legacy.name).toBe('Claude');
  });

  test('the virtual AI profiles render slightly larger than the editor', () => {
    for (const id of [HARNESS_PROFILE_ID, LEGACY_AI_THEME_PROFILE_ID]) {
      const profile = resolveTerminalProfile(DEFAULT_SETTINGS, id);
      expect(profile.fontSize).toBeUndefined();
      expect(profile.fontSizeDelta).toBe(HARNESS_FONT_SIZE_DELTA);
      expect(profileFontSize(profile, 14)).toBe(14 + HARNESS_FONT_SIZE_DELTA);
    }
    // A real profile shadowing the id keeps its own (absent) delta.
    const shadow = { id: HARNESS_PROFILE_ID, name: 'Mine', program: 'aider', args: [], env: {} };
    const s = {
      ...DEFAULT_SETTINGS,
      terminalProfiles: [...DEFAULT_SETTINGS.terminalProfiles, shadow],
    };
    expect(resolveTerminalProfile(s, HARNESS_PROFILE_ID).fontSizeDelta).toBeUndefined();
  });

  test('harness profile resolves to the configured agent command', () => {
    const claude = resolveTerminalProfile(DEFAULT_SETTINGS, HARNESS_PROFILE_ID);
    expect(claude).toMatchObject({ name: 'Claude', program: 'claude' });
    const chatgpt = resolveTerminalProfile(
      { ...DEFAULT_SETTINGS, harness: 'chatgpt' },
      HARNESS_PROFILE_ID,
    );
    expect(chatgpt).toMatchObject({
      name: HARNESSES.chatgpt.name,
      program: HARNESSES.chatgpt.program,
    });
    for (const id of ['gemini', 'grok'] as const) {
      expect(
        resolveTerminalProfile({ ...DEFAULT_SETTINGS, harness: id }, HARNESS_PROFILE_ID),
      ).toMatchObject({
        name: HARNESSES[id].name,
        program: HARNESSES[id].program,
      });
    }
  });

  test('resolution is identity-stable per agent (TerminalPane contract)', () => {
    expect(resolveTerminalProfile(DEFAULT_SETTINGS, HARNESS_PROFILE_ID)).toBe(
      resolveTerminalProfile(DEFAULT_SETTINGS, HARNESS_PROFILE_ID),
    );
  });

  test('a real profile with the harness id shadows the virtual one', () => {
    const shadow = { id: HARNESS_PROFILE_ID, name: 'Mine', program: 'aider', args: [], env: {} };
    const s = {
      ...DEFAULT_SETTINGS,
      terminalProfiles: [...DEFAULT_SETTINGS.terminalProfiles, shadow],
    };
    expect(resolveTerminalProfile(s, HARNESS_PROFILE_ID)).toBe(shadow);
  });

  test("'custom' is accepted by normalize and the command line trims/defaults", () => {
    expect(normalizeSettings({ harness: 'custom' }).harness).toBe('custom');
    expect(
      normalizeSettings({ harnessCustomCommand: '  aider --pro  ' }).harnessCustomCommand,
    ).toBe('aider --pro');
    expect(normalizeSettings({ harnessCustomCommand: 42 }).harnessCustomCommand).toBe('');
  });

  test('custom harness resolves to the parsed command, identity-stable per command', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      harness: 'custom' as const,
      harnessCustomCommand: 'aider --model "gpt 5"',
    };
    const profile = resolveTerminalProfile(s, HARNESS_PROFILE_ID);
    expect(profile).toMatchObject({ name: 'aider', program: 'aider', args: ['--model', 'gpt 5'] });
    expect(resolveTerminalProfile(s, HARNESS_PROFILE_ID)).toBe(profile);
    // An edited command is a NEW profile identity (TerminalPane re-applies).
    const edited = { ...s, harnessCustomCommand: 'aider' };
    expect(resolveTerminalProfile(edited, HARNESS_PROFILE_ID)).not.toBe(profile);
  });

  test('custom harness under the retired ai-theme id carries only the custom args', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      harness: 'custom' as const,
      harnessCustomCommand: 'aider --pro',
    };
    const profile = resolveTerminalProfile(s, LEGACY_AI_THEME_PROFILE_ID);
    expect(profile.program).toBe('aider');
    expect(profile.args).toEqual(['--pro']);
  });

  test('an empty custom command resolves to no program (falls back to the shell)', () => {
    const s = { ...DEFAULT_SETTINGS, harness: 'custom' as const, harnessCustomCommand: '' };
    expect(resolveTerminalProfile(s, HARNESS_PROFILE_ID).program).toBeUndefined();
  });
});

describe('parseCommandLine', () => {
  test('splits on whitespace; quotes group values with spaces', () => {
    expect(parseCommandLine('aider')).toEqual({ program: 'aider', args: [] });
    expect(parseCommandLine('aider --model "gpt 5" -v')).toEqual({
      program: 'aider',
      args: ['--model', 'gpt 5', '-v'],
    });
    expect(parseCommandLine("run 'two words'")).toEqual({ program: 'run', args: ['two words'] });
  });

  test('empty or blank input yields no program', () => {
    expect(parseCommandLine('')).toEqual({ program: undefined, args: [] });
    expect(parseCommandLine('   ')).toEqual({ program: undefined, args: [] });
  });
});

describe('harnessName', () => {
  test('known agents use their product name', () => {
    expect(harnessName(DEFAULT_SETTINGS)).toBe('Claude');
    expect(harnessName({ ...DEFAULT_SETTINGS, harness: 'chatgpt' })).toBe('ChatGPT');
    expect(harnessName({ ...DEFAULT_SETTINGS, harness: 'gemini' })).toBe('Gemini');
    expect(harnessName({ ...DEFAULT_SETTINGS, harness: 'grok' })).toBe('Grok');
  });

  test("custom uses the command's program basename, or a placeholder", () => {
    const custom = { ...DEFAULT_SETTINGS, harness: 'custom' as const };
    expect(harnessName({ ...custom, harnessCustomCommand: '/usr/bin/aider --pro' })).toBe('aider');
    expect(harnessName({ ...custom, harnessCustomCommand: 'C:\\tools\\agent.exe' })).toBe(
      'agent.exe',
    );
    expect(harnessName({ ...custom, harnessCustomCommand: '' })).toBe('Custom AI');
  });
});

describe('keepWindowLocalSettings (per-window explorer tree shape)', () => {
  test('keeps the local collapse/expand sets over an incoming broadcast', () => {
    const local = {
      ...DEFAULT_SETTINGS,
      explorerCollapsedWorkspaces: ['C:/ws-a'],
      explorerExpandedDirs: ['C:/ws-a/sub'],
    };
    const incoming = {
      ...DEFAULT_SETTINGS,
      fontSize: 18,
      explorerCollapsedWorkspaces: ['C:/ws-b'],
      explorerExpandedDirs: [],
    };
    const merged = keepWindowLocalSettings(incoming, local);
    expect(merged.fontSize).toBe(18);
    expect(merged.explorerCollapsedWorkspaces).toEqual(['C:/ws-a']);
    expect(merged.explorerExpandedDirs).toEqual(['C:/ws-a/sub']);
  });

  test('returns the incoming object itself when the shapes already match', () => {
    const incoming = { ...DEFAULT_SETTINGS, fontSize: 18 };
    expect(keepWindowLocalSettings(incoming, DEFAULT_SETTINGS)).toBe(incoming);
  });
});
