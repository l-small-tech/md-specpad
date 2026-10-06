/**
 * SettingsDialog (M6) — a minimal custom-DOM modal over the settings store
 * (the one deliberate exception to the native-dialogs rule, since a
 * form doesn't map onto plugin-dialog). Every field writes straight through
 * `settingsStore.update`, so changes take effect immediately (theme/ligatures/
 * font via the DOM subscription in main.tsx, word wrap via EditorHost, default
 * mode on the NEXT new tab) and persist via main.tsx's debounced saver.
 *
 * The notes-folder "Change…" button hands off to the session controller's
 * flow (folder picker → optional move) via the module-level dispatcher.
 */

import { Fragment, useEffect, useState } from 'react';
import type {
  EditorFontId,
  EditorMode,
  Settings,
  TerminalFontId,
  UiFontId,
} from '../../core/types';
import {
  HARNESSES,
  DEFAULT_SETTINGS,
  resolvedHarness,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TERMINAL_SCROLLBACK_RANGE,
  TERMINAL_SCROLL_LINES_RANGE,
} from '../../core/settings';
import { installCommandFor } from '../../core/harness-install';
import { EDITOR_FONTS, UI_FONTS } from '../../core/fonts';
import { HARNESS_IDS, type HarnessChoice, type HarnessId } from '../../core/types';
import {
  AUTO_SHELL,
  autoShellLabel,
  isListedShell,
  shellOptions,
} from '../../core/terminal-shells';
import { openDocs, requestChangeNotesDir } from '../session';
import { defaultShellStore, useDefaultShell } from '../stores/default-shell';
import { terminalsAvailable } from '../new-tab';
import { currentProvider } from '../../ipc/provider';
import { desktopOs, isAndroid, isWindows } from '../platform';
import { pinThemeToWindow, selectTheme, unpinThemeFromWindow } from '../theme-actions';
import { settingsStore, useSettingsStore } from '../stores/settings';
import {
  useThemeRegistry,
  currentThemeValue,
  themePickerGroups,
  themePluginOptions,
} from '../stores/theme-registry';
import { DEFAULT_COLOR_SCHEME } from '../../core/types';
import {
  harnessRowModel,
  installContextOf,
  harnessAvailabilityStore,
  useHarnessAvailability,
} from '../stores/harness-availability';
import { uiStore, useUiStore, type SettingsTabId } from '../stores/ui';
import { useWindowTheme } from '../stores/window-theme';
import { installHarness } from '../harness-install';
import { checkForUpdate, downloadAndInstall, useUpdateStore } from '../update';
import { whisperModelsStore, useWhisperModels } from '../stores/whisper-models';
import {
  acceleratorLabel,
  downloadPercent,
  formatBytes,
  recommendedModel,
  speedHint,
  type WhisperModelStatus,
} from '../../core/whisper-models';

const MODES: { value: EditorMode; label: string }[] = [
  { value: 'raw', label: 'Raw' },
  { value: 'split', label: 'Split' },
  { value: 'wysiwyg', label: 'Edit' },
  { value: 'read', label: 'Review' },
];

const READER_MARGINS: { value: Settings['readerMargins']; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
];

const CURSOR_STYLE_OPTIONS: { value: Settings['cursorStyle']; label: string }[] = [
  { value: 'bar', label: 'Bar (default)' },
  { value: 'thin', label: 'Thin' },
  { value: 'thick', label: 'Thick' },
  { value: 'underscore', label: 'Underscore' },
];

const TERMINAL_CURSOR_OPTIONS: { value: Settings['terminalCursorStyle']; label: string }[] = [
  { value: 'block', label: 'Block (default)' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
];

const TERMINAL_BELL_OPTIONS: { value: Settings['terminalBell']; label: string }[] = [
  { value: 'cursor', label: 'Cursor changes shape (default)' },
  { value: 'visual', label: 'Flash the pane' },
  { value: 'off', label: 'Nothing' },
];

const IMAGE_LOCATIONS: { value: Settings['imagePasteLocation']; label: string }[] = [
  { value: 'subfolder', label: 'Subfolder next to the file' },
  { value: 'sameFolder', label: 'Same folder as the file' },
  { value: 'workspaceRoot', label: 'Shared folder at workspace root' },
];

const VOICE_NOTE_LOCATIONS: { value: Settings['voiceNotesLocation']; label: string }[] = [
  { value: 'workspaceFolder', label: 'Shared folder at workspace root' },
  { value: 'nextToFile', label: 'Next to the file' },
];

/** The desktop dictation engines; the Windows entry only exists on Windows. */
function dictationEngineOptions(): { value: Settings['desktopDictationEngine']; label: string }[] {
  const windows = isWindows();
  return [
    {
      value: 'auto',
      label: windows ? 'Automatic (Windows voice typing)' : 'Automatic (Whisper, offline)',
    },
    ...(windows
      ? [{ value: 'windowsVoiceTyping' as const, label: 'Windows voice typing (online)' }]
      : []),
    { value: 'whisper', label: 'Whisper (offline, on this computer)' },
  ];
}

/** The Android dictation engines. */
const ANDROID_ENGINE_OPTIONS: { value: Settings['androidDictationEngine']; label: string }[] = [
  { value: 'system', label: "This device's speech recognizer" },
  { value: 'whisper', label: 'Whisper (offline, on this device)' },
];

function update(partial: Partial<Settings>): void {
  settingsStore.getState().update(partial);
}

/**
 * Voice notes: where the sidecar files go, which engine dictates them, and
 * the Whisper model list. Desktop picks between the platform's own engine
 * and Whisper; Android between the device's recognizer and Whisper.
 */
function VoiceNotesSection({ settings }: { settings: Settings }) {
  const desktop = !isAndroid();
  return (
    <>
      <label className="settings-row">
        <span className="settings-label">Keep voice notes</span>
        <select
          className="settings-control"
          value={settings.voiceNotesLocation}
          onChange={(e) =>
            update({ voiceNotesLocation: e.target.value as Settings['voiceNotesLocation'] })
          }
        >
          {VOICE_NOTE_LOCATIONS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      {settings.voiceNotesLocation === 'workspaceFolder' && (
        <label className="settings-row">
          <span className="settings-label">Voice notes folder name</span>
          <input
            className="settings-control"
            type="text"
            value={settings.voiceNotesFolderName}
            spellCheck={false}
            placeholder="Voice Notes"
            onChange={(e) => update({ voiceNotesFolderName: e.target.value })}
            onBlur={(e) => {
              if (e.target.value.trim().length === 0) {
                update({ voiceNotesFolderName: 'Voice Notes' });
              }
            }}
          />
        </label>
      )}

      {desktop && (
        <>
          <label className="settings-row">
            <span className="settings-label">Transcription engine</span>
            <select
              className="settings-control"
              value={settings.desktopDictationEngine}
              onChange={(e) =>
                update({
                  desktopDictationEngine: e.target.value as Settings['desktopDictationEngine'],
                })
              }
            >
              {dictationEngineOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-row settings-row-hint">
            <span className="settings-label" />
            <span className="settings-hint">
              Whisper turns speech into text on this computer, with no internet after the one-time
              model download. Windows voice typing sends your voice to Microsoft.
            </span>
          </div>
        </>
      )}

      {!desktop && (
        <>
          <label className="settings-row">
            <span className="settings-label">Transcription engine</span>
            <select
              className="settings-control"
              value={settings.androidDictationEngine}
              onChange={(e) =>
                update({
                  androidDictationEngine: e.target.value as Settings['androidDictationEngine'],
                })
              }
            >
              {ANDROID_ENGINE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-row settings-row-hint">
            <span className="settings-label" />
            <span className="settings-hint">
              The device's recognizer needs no download and may send audio to its maker. Whisper
              runs on this device after a one-time model download; Tiny or Base suit a phone.
            </span>
          </div>
        </>
      )}

      <WhisperModelsSection chosen={settings.whisperModel} useGpu={settings.whisperUseGpu} />
    </>
  );
}

/**
 * The Whisper model list: every manifest entry with its size and a speed
 * hint, the active one marked, Download / Cancel / Delete / Use per row, and
 * one progress bar for the download in flight; above it the accelerator row
 * (which GPU, and the switch to force the CPU), below it the offer to clear
 * files an earlier version downloaded. A projection of the whisper-models
 * store; the list is fetched when the section mounts.
 */
function WhisperModelsSection({ chosen, useGpu }: { chosen: string; useGpu: boolean }) {
  const models = useWhisperModels((s) => s.models);
  const loaded = useWhisperModels((s) => s.loaded);
  const download = useWhisperModels((s) => s.download);
  const strayBytes = useWhisperModels((s) => s.strayBytes);
  const accelerator = useWhisperModels((s) => s.accelerator);
  useEffect(() => {
    void whisperModelsStore.getState().refresh();
  }, []);
  const store = () => whisperModelsStore.getState();
  const active = download.kind === 'downloading' || download.kind === 'verifying';
  const chosenInstalled = models.some((m) => m.id === chosen && m.installed);
  const recommended = models.find((m) => m.id === recommendedModel());
  const gpu = accelerator !== null && accelerator !== 'none' && useGpu;
  return (
    <>
      <div className="settings-heading">Whisper models</div>
      {accelerator !== null && accelerator !== 'none' && (
        <>
          <label className="settings-row">
            <span className="settings-label">Run on the GPU</span>
            <input
              className="settings-control settings-checkbox"
              type="checkbox"
              checked={useGpu}
              onChange={(e) => update({ whisperUseGpu: e.target.checked })}
            />
          </label>
          <div className="settings-row settings-row-hint">
            <span className="settings-label" />
            <span className="settings-hint">
              {acceleratorLabel(accelerator, useGpu)}. Several times faster on the GPU; turn it off
              only if transcription fails or the driver misbehaves.
            </span>
          </div>
        </>
      )}
      <div className="settings-row settings-row-hint">
        <span className="settings-hint">
          {loaded && !chosenInstalled
            ? `Download a model to dictate with Whisper — ${recommended?.label ?? recommendedModel()} is the recommended one.`
            : 'Bigger models are more accurate and slower. All are compact (quantized) files.'}
        </span>
        <button className="settings-button" onClick={() => void store().openFolder()}>
          Open folder
        </button>
      </div>
      <div className="settings-model-list" role="list">
        {models.map((m) => (
          <WhisperModelRow
            key={m.id}
            model={m}
            chosen={m.id === chosen}
            gpu={gpu}
            downloadBusy={active}
            download={download.kind !== 'idle' && download.id === m.id ? download : null}
          />
        ))}
      </div>
      {strayBytes > 0 && (
        <div className="settings-row settings-row-hint">
          <span className="settings-hint">
            {formatBytes(strayBytes)} of model files from an earlier version are no longer used.
          </span>
          <button className="settings-button" onClick={() => void store().prune()}>
            Remove
          </button>
        </div>
      )}
    </>
  );
}

function WhisperModelRow({
  model,
  chosen,
  gpu,
  downloadBusy,
  download,
}: {
  model: WhisperModelStatus;
  chosen: boolean;
  /** The speed hint should be the GPU one. */
  gpu: boolean;
  /** Any download is running (only one at a time). */
  downloadBusy: boolean;
  /** This row's own download state, when it has one. */
  download: ReturnType<typeof whisperModelsStore.getState>['download'] | null;
}) {
  const store = () => whisperModelsStore.getState();
  const running = download?.kind === 'downloading' || download?.kind === 'verifying';
  const percent = download ? downloadPercent(download) : null;
  const status = running
    ? download.kind === 'verifying'
      ? 'Verifying…'
      : percent === null
        ? 'Downloading…'
        : `${percent}% of ${formatBytes(model.bytes)}`
    : download?.kind === 'failed'
      ? download.code === 'WHISPER_DOWNLOAD_CORRUPT'
        ? 'Download failed verification — try again'
        : 'Download failed — check your connection and try again'
      : download?.kind === 'cancelled'
        ? `Paused at ${formatBytes(model.partialBytes)} — Download resumes it`
        : model.installed
          ? `Installed · ${formatBytes(model.bytes)}`
          : model.partialBytes > 0
            ? `${formatBytes(model.partialBytes)} of ${formatBytes(model.bytes)} downloaded — resume`
            : formatBytes(model.bytes);
  const hint = speedHint(model.id, gpu);
  return (
    <div
      className={`settings-model-row${chosen ? ' settings-model-row-chosen' : ''}${model.installed ? '' : ' settings-model-row-absent'}`}
      role="listitem"
    >
      <div className="settings-model-main">
        <span className="settings-model-name">
          {model.label}
          {model.id === recommendedModel() && (
            <span className="settings-model-tag">Recommended</span>
          )}
          {chosen && <span className="settings-model-tag settings-model-tag-active">In use</span>}
        </span>
        <span className="settings-model-status">
          {status}
          {hint ? ` · ${hint}` : ''}
        </span>
        {running && (
          <div
            className="settings-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <div
              className={`settings-progress-bar${percent === null ? ' settings-progress-indeterminate' : ''}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        )}
      </div>
      <div className="settings-model-actions">
        {running ? (
          <button className="settings-button" onClick={() => store().cancelDownload()}>
            Cancel
          </button>
        ) : model.installed ? (
          <>
            {!chosen && (
              <button
                className="settings-button settings-button-primary"
                onClick={() => update({ whisperModel: model.id })}
              >
                Use
              </button>
            )}
            <button className="settings-button" onClick={() => void store().remove(model.id)}>
              Delete
            </button>
          </>
        ) : (
          <button
            className="settings-button settings-button-primary"
            disabled={downloadBusy}
            onClick={() => void store().startDownload(model.id)}
          >
            {model.partialBytes > 0 ? 'Resume' : 'Download'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Manual update check plus the automatic-check toggle (this app has no menu
 * bar, so Settings is its home). A check's outcome lands in the status bar —
 * an "up to date" notice, or the update chip — and when an update IS waiting,
 * an **Update now** button appears right beside the check button so the chip
 * isn't the only way to take it. Installing is always a click, never automatic.
 */
function UpdatesRow({ autoUpdateCheck }: { autoUpdateCheck: boolean }) {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const busy = phase === 'checking' || phase === 'downloading';
  const ready = phase === 'available' || phase === 'downloading';
  return (
    <>
      <div className="settings-row settings-row-notes">
        <span className="settings-label">Updates</span>
        <div className="settings-notes-value">
          <span className="settings-path">
            {ready
              ? `v${version} available (you have v${__APP_VERSION__})`
              : `MD Specpad v${__APP_VERSION__}`}
          </span>
          {ready && (
            <button
              className="settings-button settings-button-primary"
              disabled={phase === 'downloading'}
              title="Download, install, and restart"
              onClick={() => void downloadAndInstall()}
            >
              {phase === 'downloading' ? 'Updating…' : 'Update now'}
            </button>
          )}
          <button
            className="settings-button"
            disabled={busy}
            onClick={() => void checkForUpdate({ manual: true })}
          >
            {phase === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      </div>
      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={autoUpdateCheck}
          onChange={(e) => update({ autoUpdateCheck: e.target.checked })}
        />
        <span className="settings-label">
          Check for updates automatically (weekly, on Sunday — never installs on its own)
        </span>
      </label>
    </>
  );
}

/**
 * The dialog's sections. Terminal and Harness need a pty, so they are absent
 * on Android — the same predicate that hides the terminal section today.
 */
export function settingsTabs(terminals: boolean): readonly { id: SettingsTabId; label: string }[] {
  return [
    { id: 'appearance', label: 'Appearance' },
    { id: 'editor', label: 'Editor' },
    { id: 'files', label: 'Files' },
    { id: 'voice', label: 'Voice notes' },
    ...(terminals
      ? [
          { id: 'terminal' as const, label: 'Terminal' },
          { id: 'harness' as const, label: 'Harness' },
        ]
      : []),
    { id: 'updates', label: 'Updates' },
  ];
}

/** The tab shown last time; reopening the dialog lands there. */
let lastTab: SettingsTabId = 'appearance';

/**
 * Mounted only while the dialog is open, so the body's state starts fresh on
 * every open: the section it lands on is decided once, in `SettingsBody`'s
 * initial state, rather than synced by an effect.
 */
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  // A caller can name the section to land on — the new-tab menu's Harness row
  // does when nothing is installed. Otherwise the dialog reopens where it was
  // last left; switching tabs by hand still wins from there.
  const requestedTab = useUiStore((s) => s.settingsTab);
  if (!open) {
    return null;
  }
  return <SettingsBody initialTab={requestedTab ?? lastTab} />;
}

function SettingsBody({ initialTab }: { initialTab: SettingsTabId }) {
  const settings = useSettingsStore((s) => s.settings);
  const plugins = useThemeRegistry((s) => s.plugins);
  // A theme pinned to this window (☰ Menu → Themes right-click, or the box below);
  // Android runs a single webview, so the choice isn't offered there.
  const themeWindowOnly = useWindowTheme((s) => s.override !== null);
  const perWindowTheme = !isAndroid();
  const [tab, setTab] = useState<SettingsTabId>(initialTab);
  useEffect(() => {
    lastTab = tab;
  }, [tab]);

  const pluginOptions = themePluginOptions(plugins);
  const themeGroups = themePickerGroups(plugins);

  // Unified Theme picker: System/Light/Dark drive the built-in default palette;
  // a plugin id drives that scheme and follows the OS light/dark. The dropdown
  // shows the mode when on the default palette, else the plugin id. The folder
  // actions (open / new / reload / help) live in ☰ Menu → Themes.
  const themeValue = currentThemeValue(settings);
  const pluginMissing =
    settings.colorScheme !== DEFAULT_COLOR_SCHEME &&
    !pluginOptions.some((p) => p.value === settings.colorScheme);
  // The forced plain Light/Dark picker entries are gone, but a device that
  // saved one keeps working — surface the saved mode as a current-value-only
  // option so the select doesn't render blank until a new theme is chosen.
  const legacyForcedMode =
    settings.colorScheme === DEFAULT_COLOR_SCHEME && settings.theme !== 'system'
      ? settings.theme
      : null;

  const close = () => uiStore.getState().closeSettings();
  const tabs = settingsTabs(terminalsAvailable());

  return (
    <div
      className="settings-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button
            className="settings-button settings-docs-button"
            onClick={() => {
              close();
              openDocs();
            }}
          >
            Open Docs
          </button>
          <button className="settings-close" aria-label="Close settings" onClick={close}>
            ×
          </button>
        </header>

        <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-tab${tab === t.id ? ' settings-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-body" role="tabpanel">
          {tab === 'appearance' && (
            <>
              <label className="settings-row">
                <span className="settings-label">Theme</span>
                <select
                  className="settings-control"
                  value={themeValue}
                  onChange={(e) => selectTheme(e.target.value, themeWindowOnly)}
                >
                  {/* System, then the labeled Light / Dark / Custom sections. */}
                  {themeGroups.map((group, gi) => {
                    const options = group.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ));
                    return group.label === null ? (
                      <Fragment key={gi}>{options}</Fragment>
                    ) : (
                      <optgroup key={gi} label={group.label}>
                        {options}
                      </optgroup>
                    );
                  })}
                  {/* A saved theme whose file is missing still shows as the current
                  value (falls back to the default palette visually). */}
                  {pluginMissing && (
                    <option value={settings.colorScheme}>{settings.colorScheme} (missing)</option>
                  )}
                  {legacyForcedMode && (
                    <option value={legacyForcedMode}>
                      {legacyForcedMode === 'light' ? 'Light' : 'Dark'}
                    </option>
                  )}
                </select>
              </label>

              {perWindowTheme && (
                <label className="settings-row settings-row-inline">
                  <input
                    type="checkbox"
                    checked={themeWindowOnly}
                    onChange={(e) =>
                      e.target.checked ? pinThemeToWindow() : unpinThemeFromWindow()
                    }
                  />
                  <span className="settings-label">
                    This window only (otherwise the theme applies to every window)
                  </span>
                </label>
              )}

              <div className="settings-row settings-row-hint">
                <span className="settings-label" />
                <span className="settings-hint">
                  Add, create, or reload your own themes in ☰ Menu → Themes.
                </span>
              </div>

              <label className="settings-row">
                <span className="settings-label">Font size</span>
                <input
                  className="settings-control settings-number"
                  type="number"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  value={settings.fontSize}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isFinite(next)) {
                      update({
                        fontSize: Math.min(
                          MAX_FONT_SIZE,
                          Math.max(MIN_FONT_SIZE, Math.round(next)),
                        ),
                      });
                    }
                  }}
                />
              </label>

              <label className="settings-row">
                <span className="settings-label">Editor font</span>
                <select
                  className="settings-control"
                  value={settings.editorFont}
                  onChange={(e) => update({ editorFont: e.target.value as EditorFontId })}
                >
                  {EDITOR_FONTS.map((f) => (
                    <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-row">
                <span className="settings-label">Interface font (tabs, sidebar)</span>
                <select
                  className="settings-control"
                  value={settings.uiFont}
                  onChange={(e) => update({ uiFont: e.target.value as UiFontId })}
                >
                  {UI_FONTS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-row">
                <span className="settings-label">Review mode margins</span>
                <select
                  className="settings-control"
                  value={settings.readerMargins}
                  onChange={(e) =>
                    update({ readerMargins: e.target.value as Settings['readerMargins'] })
                  }
                >
                  {READER_MARGINS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-row settings-row-inline">
                <input
                  type="checkbox"
                  checked={settings.ligatures}
                  onChange={(e) => update({ ligatures: e.target.checked })}
                />
                <span className="settings-label">Font ligatures (→ as one glyph)</span>
              </label>
            </>
          )}

          {tab === 'editor' && (
            <>
              <label className="settings-row">
                <span className="settings-label">Default mode (new tabs)</span>
                <select
                  className="settings-control"
                  value={settings.defaultMode}
                  onChange={(e) => update({ defaultMode: e.target.value as EditorMode })}
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-row">
                <span className="settings-label">Cursor style</span>
                <select
                  className="settings-control"
                  value={settings.cursorStyle}
                  onChange={(e) =>
                    update({ cursorStyle: e.target.value as Settings['cursorStyle'] })
                  }
                >
                  {CURSOR_STYLE_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-row settings-row-inline">
                <input
                  type="checkbox"
                  checked={settings.wordWrap}
                  onChange={(e) => update({ wordWrap: e.target.checked })}
                />
                <span className="settings-label">Word wrap</span>
              </label>

              <label className="settings-row settings-row-inline">
                <input
                  type="checkbox"
                  checked={settings.lineNumbers}
                  onChange={(e) => update({ lineNumbers: e.target.checked })}
                />
                <span className="settings-label">Line numbers</span>
              </label>

              <label className="settings-row settings-row-inline">
                <input
                  type="checkbox"
                  checked={settings.smoothScrolling}
                  onChange={(e) => update({ smoothScrolling: e.target.checked })}
                />
                <span className="settings-label">
                  Smooth scrolling (editor, preview and terminal)
                </span>
              </label>

              <label className="settings-row settings-row-inline">
                <input
                  type="checkbox"
                  checked={settings.groupTabsByWorkspace}
                  onChange={(e) => update({ groupTabsByWorkspace: e.target.checked })}
                />
                <span className="settings-label">
                  Arrange tabs by workspace (keep each workspace's tabs together)
                </span>
              </label>

              <label className="settings-row settings-row-inline">
                <input
                  type="checkbox"
                  checked={settings.previewTabs}
                  onChange={(e) => update({ previewTabs: e.target.checked })}
                />
                <span className="settings-label">
                  Preview tabs (single-click opens in a reused, italic tab)
                </span>
              </label>
            </>
          )}

          {tab === 'files' && (
            <>
              <label className="settings-row settings-row-inline">
                <input
                  type="checkbox"
                  checked={settings.liveSave}
                  onChange={(e) => update({ liveSave: e.target.checked })}
                />
                <span className="settings-label">Live save (opened files save automatically)</span>
              </label>

              <label className="settings-row settings-row-inline">
                <input
                  type="checkbox"
                  checked={settings.confirmFileMove}
                  onChange={(e) => update({ confirmFileMove: e.target.checked })}
                />
                <span className="settings-label">Confirm before moving files between folders</span>
              </label>

              <label className="settings-row">
                <span className="settings-label">Pasted / dropped images</span>
                <select
                  className="settings-control"
                  value={settings.imagePasteLocation}
                  onChange={(e) =>
                    update({ imagePasteLocation: e.target.value as Settings['imagePasteLocation'] })
                  }
                >
                  {IMAGE_LOCATIONS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>

              {settings.imagePasteLocation !== 'sameFolder' && (
                <label className="settings-row">
                  <span className="settings-label">Image folder name</span>
                  <input
                    className="settings-control"
                    type="text"
                    value={settings.imageFolderName}
                    spellCheck={false}
                    placeholder="images"
                    // Persist the raw text; normalizeSettings trims and defaults a
                    // blank name on the next load, so an in-progress empty field is fine.
                    onChange={(e) => update({ imageFolderName: e.target.value })}
                    onBlur={(e) => {
                      if (e.target.value.trim().length === 0) {
                        update({ imageFolderName: 'images' });
                      }
                    }}
                  />
                </label>
              )}

              <label className="settings-row">
                <span className="settings-label">Review baseline branch</span>
                <input
                  className="settings-control"
                  type="text"
                  value={settings.reviewBaseBranch}
                  spellCheck={false}
                  placeholder="auto"
                  // Blank is meaningful (auto-detect), so there is nothing to
                  // restore on blur — normalizeSettings only trims it.
                  onChange={(e) => update({ reviewBaseBranch: e.target.value })}
                />
              </label>
              <div className="settings-row settings-row-hint">
                <span className="settings-label" />
                <span className="settings-hint">
                  Leave empty to detect development / main / master
                </span>
              </div>

              <div className="settings-row settings-row-notes">
                <span className="settings-label">Notes folder</span>
                <div className="settings-notes-value">
                  <span className="settings-path" title={settings.notesDir ?? undefined}>
                    {settings.notesDir ?? 'Default (app data folder)'}
                  </span>
                  {/* No folder picker on Android — the notes folder is fixed there. */}
                  {currentProvider().capabilities.canPickDir && (
                    <button className="settings-button" onClick={() => requestChangeNotesDir()}>
                      Change…
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {tab === 'voice' && <VoiceNotesSection settings={settings} />}

          {tab === 'terminal' && <TerminalSection settings={settings} />}

          {tab === 'harness' && <HarnessRows settings={settings} />}

          {tab === 'updates' && <UpdatesRow autoUpdateCheck={settings.autoUpdateCheck} />}
        </div>

        <footer className="settings-footer">
          <button className="settings-button" onClick={close}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Terminal settings.
 *
 * The SHELL is one global choice (`terminalShell`), not a per-profile one:
 * this is a notepad with a terminal in it, and a profile manager belongs to a
 * terminal emulator. Profiles still exist for anyone who wants them, and are
 * SELECTED here rather than edited — a full editor (program, args, cwd, env,
 * per-profile font) is a form of its own. `settings.json` holds the list;
 * hand-editing it is the documented route, and `normalizeSettings` clamps
 * whatever comes back, so a bad edit degrades to the defaults.
 *
 * The whole section is absent on Android, which has no pty.
 */
/**
 * The shell picker: this OS's usual shells, plus "Custom…" for anything else.
 *
 * "Custom" is a UI state, not a stored one — `settings.terminalShell` is only
 * ever the program to spawn. A hand-edited `settings.json` naming something
 * exotic therefore opens the dialog already in the custom row, instead of
 * being silently snapped back to a listed shell.
 */
function ShellRow({ shell }: { shell: string }) {
  const os = desktopOs();
  const [custom, setCustom] = useState(() => shell !== AUTO_SHELL && !isListedShell(os, shell));
  // What "Auto" would actually run, so its row can say so: "Auto (zsh)". The
  // backend picks it (src-tauri/src/shell.rs) and the answer is cached in
  // `defaultShellStore` — terminal panes need the same one; until it arrives,
  // plain "Auto".
  const autoShell = useDefaultShell();
  useEffect(() => {
    void defaultShellStore.getState().resolve();
  }, []);

  return (
    <>
      <label className="settings-row">
        <span className="settings-label">Shell</span>
        <select
          className="settings-control"
          value={custom ? 'custom' : shell}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              setCustom(true);
              return;
            }
            setCustom(false);
            update({ terminalShell: e.target.value });
          }}
        >
          {shellOptions(os).map((option) => (
            <option key={option.value || 'auto'} value={option.value}>
              {option.value === AUTO_SHELL ? autoShellLabel(autoShell) : option.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>

      {custom && (
        <label className="settings-row">
          <span className="settings-label">Shell command</span>
          <input
            className="settings-control"
            type="text"
            spellCheck={false}
            placeholder={os === 'windows' ? 'C:\\msys64\\usr\\bin\\bash.exe' : '/usr/bin/fish'}
            value={shell}
            onChange={(e) => update({ terminalShell: e.target.value })}
          />
        </label>
      )}

      <p className="settings-hint">
        Takes effect in terminals opened from now on; shells already running keep the one they
        started with.
      </p>
    </>
  );
}

/**
 * The harness picker: one radio row per harness plus "Custom…". Each row
 * carries what `harness-availability` knows — a muted name and an **Install**
 * button when the command is not on PATH, the resolved path when it is,
 * nothing while unknown. Every decision (what to show, whether an install
 * route exists) is made in the store and core; this only lays it out.
 *
 * A never-configured install sits on 'auto' until a scan finds a harness, so
 * the radios follow `resolvedHarness` — what would actually launch — rather
 * than the raw setting; picking a row writes that concrete choice.
 */
function HarnessRows({ settings }: { settings: Settings }) {
  const os = desktopOs();
  const harnesses = useHarnessAvailability((s) => s.harnesses);
  const custom = useHarnessAvailability((s) => s.custom);
  const tools = useHarnessAvailability((s) => s.tools);
  const checking = useHarnessAvailability((s) => s.checking);
  const installing = useHarnessAvailability((s) => s.installing);
  const refresh = () => void harnessAvailabilityStore.getState().refresh();
  // Opening the dialog is a natural moment to look again: the user may have
  // just installed something in a terminal tab.
  useEffect(refresh, []);

  const ctx = installContextOf(tools);
  const selected = resolvedHarness(settings);
  const select = (id: HarnessChoice) => update({ harness: id });
  const customModel = harnessRowModel(custom, false);

  return (
    <div className="settings-row settings-row-notes">
      <span className="settings-label">Harness</span>
      <div className="settings-agent-list" role="radiogroup" aria-label="Harness">
        {HARNESS_IDS.map((id: HarnessId) => {
          const row = harnessRowModel(
            harnesses[id],
            installCommandFor(id, os, ctx) !== null,
            installing.includes(id),
          );
          const inputId = `harness-${id}`;
          return (
            <div
              key={id}
              className={`settings-agent-row${row.dimmed ? ' settings-agent-row-missing' : ''}`}
            >
              <input
                id={inputId}
                type="radio"
                name="harness"
                checked={selected === id}
                onChange={() => select(id)}
              />
              <label className="settings-agent-name" htmlFor={inputId}>
                {HARNESSES[id].name}
                {id === HARNESS_IDS[0] ? ' (default)' : ''}
              </label>
              <span
                className={`settings-agent-hint${row.installing ? ' settings-agent-hint-pending' : ''}`}
                title={row.title ?? undefined}
              >
                {row.installing && <span className="settings-spinner" aria-hidden="true" />}
                {row.hint}
              </span>
              {row.install && (
                <button
                  className="settings-button"
                  title={`Open a terminal and run the ${HARNESSES[id].name} install command`}
                  onClick={() => void installHarness(id)}
                >
                  Install
                </button>
              )}
            </div>
          );
        })}
        <div
          className={`settings-agent-row${customModel.dimmed ? ' settings-agent-row-missing' : ''}`}
        >
          <input
            id="harness-custom"
            type="radio"
            name="harness"
            checked={selected === 'custom'}
            onChange={() => select('custom')}
          />
          <label className="settings-agent-name" htmlFor="harness-custom">
            Custom…
          </label>
          <span className="settings-agent-hint" title={customModel.title ?? undefined}>
            {customModel.hint}
          </span>
        </div>
      </div>
      {selected === 'custom' && (
        <input
          className="settings-control settings-agent-command"
          type="text"
          spellCheck={false}
          aria-label="Custom harness command"
          placeholder="aider --model sonnet"
          value={settings.harnessCustomCommand}
          onChange={(e) => update({ harnessCustomCommand: e.target.value })}
          // The custom program's own found/missing hint follows what was typed.
          onBlur={() => void harnessAvailabilityStore.getState().refresh()}
        />
      )}
      <div className="settings-agent-actions">
        <button className="settings-button" disabled={checking} onClick={refresh}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      <p className="settings-hint">
        The harness the new-tab menu&apos;s Harness row launches. Ones not found on{' '}
        <code>PATH</code> are dimmed; <b>Install</b> opens a terminal and types the official install
        command, so you see exactly what runs. Close that tab (or press <b>Re-check</b>) when it
        finishes. Until you pick one, the row launches the first harness found — Claude, then
        ChatGPT, then the rest.
      </p>
    </div>
  );
}

function TerminalSection({ settings }: { settings: Settings }) {
  if (!terminalsAvailable()) {
    return null;
  }
  return (
    <>
      <ShellRow shell={settings.terminalShell} />

      <label className="settings-row">
        <span className="settings-label">Font</span>
        <select
          className="settings-control"
          value={settings.terminalFont}
          onChange={(e) => update({ terminalFont: e.target.value as TerminalFontId })}
        >
          <option value="match">Match editor font</option>
          {EDITOR_FONTS.map((f) => (
            <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Default profile</span>
        <select
          className="settings-control"
          value={settings.defaultTerminalProfile}
          onChange={(e) => update({ defaultTerminalProfile: e.target.value })}
        >
          {settings.terminalProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>

      <p className="settings-hint">
        Profiles (arguments, folder, environment) are edited in <code>settings.json</code> under{' '}
        <code>terminalProfiles</code>. A profile with no <code>program</code> of its own runs the
        shell chosen above.
      </p>

      <label className="settings-row">
        <span className="settings-label">Cursor style</span>
        <select
          className="settings-control"
          value={settings.terminalCursorStyle}
          onChange={(e) =>
            update({ terminalCursorStyle: e.target.value as Settings['terminalCursorStyle'] })
          }
        >
          {TERMINAL_CURSOR_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Scrollback (lines)</span>
        <input
          className="settings-control"
          type="number"
          min={TERMINAL_SCROLLBACK_RANGE.min}
          max={TERMINAL_SCROLLBACK_RANGE.max}
          step={1000}
          value={settings.terminalScrollback}
          onChange={(e) => update({ terminalScrollback: clampScrollback(e.target.value) })}
        />
      </label>

      <label className="settings-row">
        <span className="settings-label">Lines per scroll</span>
        <input
          className="settings-control"
          type="number"
          min={TERMINAL_SCROLL_LINES_RANGE.min}
          max={TERMINAL_SCROLL_LINES_RANGE.max}
          value={settings.terminalScrollLines}
          onChange={(e) => update({ terminalScrollLines: clampScrollLines(e.target.value) })}
        />
      </label>

      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={settings.terminalCursorBlink}
          onChange={(e) => update({ terminalCursorBlink: e.target.checked })}
        />
        <span className="settings-label">Blinking cursor</span>
      </label>

      <label className="settings-row">
        <span className="settings-label">Bell (never a sound)</span>
        <select
          className="settings-control"
          value={settings.terminalBell}
          onChange={(e) => update({ terminalBell: e.target.value as Settings['terminalBell'] })}
        >
          {TERMINAL_BELL_OPTIONS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={settings.terminalCopyOnSelect}
          onChange={(e) => update({ terminalCopyOnSelect: e.target.checked })}
        />
        <span className="settings-label">Copy on select</span>
      </label>

      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={settings.terminalConfirmMultilinePaste}
          onChange={(e) => update({ terminalConfirmMultilinePaste: e.target.checked })}
        />
        <span className="settings-label">Confirm multi-line paste</span>
      </label>

      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={settings.terminalConfirmCloseRunning}
          onChange={(e) => update({ terminalConfirmCloseRunning: e.target.checked })}
        />
        <span className="settings-label">Confirm closing a terminal with a running shell</span>
      </label>

      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={settings.terminalOnExit === 'keep'}
          onChange={(e) => update({ terminalOnExit: e.target.checked ? 'keep' : 'close' })}
        />
        <span className="settings-label">Keep the pane open after the shell exits</span>
      </label>

      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={settings.terminalAltSendsEscape}
          onChange={(e) => update({ terminalAltSendsEscape: e.target.checked })}
        />
        <span className="settings-label">Alt sends Escape (off makes it a compose key)</span>
      </label>

      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={settings.terminalBackspaceSendsDelete}
          onChange={(e) => update({ terminalBackspaceSendsDelete: e.target.checked })}
        />
        <span className="settings-label">Backspace sends DEL (the xterm default)</span>
      </label>

      <label className="settings-row settings-row-inline">
        <input
          type="checkbox"
          checked={settings.terminalAllowOscClipboard}
          onChange={(e) => update({ terminalAllowOscClipboard: e.target.checked })}
        />
        <span className="settings-label">
          Let programs set the clipboard (OSC 52) — any program that can print here could
        </span>
      </label>
    </>
  );
}

function clampScrollback(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value)
    ? Math.min(TERMINAL_SCROLLBACK_RANGE.max, Math.max(TERMINAL_SCROLLBACK_RANGE.min, value))
    : DEFAULT_SETTINGS.terminalScrollback;
}

function clampScrollLines(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value)
    ? Math.min(TERMINAL_SCROLL_LINES_RANGE.max, Math.max(TERMINAL_SCROLL_LINES_RANGE.min, value))
    : DEFAULT_SETTINGS.terminalScrollLines;
}
