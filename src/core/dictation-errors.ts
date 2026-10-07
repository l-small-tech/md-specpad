/**
 * dictation-errors.ts — what to tell the user when voice-note dictation fails.
 *
 * Capture failures arrive as short codes — from the Android SpeechRecognizer
 * bridge (src-tauri commands/android.rs) or the Windows voice-typing flow
 * (ui/voice-comments.ts). This module turns a code into something the voice-note sheet can show
 * IN PLACE, under the microphone: a title, numbered steps to fix it, an
 * optional note, and — on Windows — the exact Settings page to open. A status
 * bar notice was too easy to miss: the sheet dims everything behind it.
 *
 * Pure and platform-free (I9): the engine is passed in, and the Settings pages
 * are plain `ms-settings:` URIs the UI hands to the opener plugin. Every URI
 * here must also be allow-listed in src-tauri/capabilities/default.json (the
 * test suite checks), or the opener refuses it.
 */

/**
 * The speech-to-text engine that captures voice notes on this platform:
 * Android's on-device recognizer, Windows voice typing, or the offline
 * Whisper model (any desktop OS).
 */
export type DictationEngine = 'android' | 'windows' | 'whisper';

/** A failed capture, shaped for the sheet. */
export interface CaptureError {
  /** The raw bridge code, shown small for support ("STT_PRIVACY"). */
  code: string;
  /** One line: what's wrong. */
  title: string;
  /** Numbered steps to fix it, in order. The last one says how to retry. */
  steps: string[];
  /** Optional context (e.g. what enabling a setting means for privacy). */
  note?: string;
  /** A Settings page that jumps straight to the fix (Windows only). */
  settings?: { label: string; uri: string };
  /** A section of md-specpad's OWN Settings dialog that holds the fix. */
  appSettings?: { label: string; tab: 'voice' };
}

/** The `ms-settings:` pages this module may link to (mirrored in capabilities). */
export const SETTINGS_URIS = {
  speechPrivacy: 'ms-settings:privacy-speech',
} as const;

const RETRY = 'Come back here and tap the microphone again.';

/** Windows: voice notes are typed by Windows voice typing (Win+H). */
function windowsError(code: string): Omit<CaptureError, 'code'> {
  if (code.includes('VOICE_TYPING_EMPTY')) {
    return {
      title: 'Nothing was typed',
      steps: [
        'Check that Windows voice typing works: click in any text box, press Win+H and speak.',
        'If voice typing asks for it, turn on "Online speech recognition" in Windows Settings > Privacy & security > Speech.',
        RETRY,
      ],
      note:
        'Voice notes on Windows use Windows voice typing, which sends your voice to ' +
        'Microsoft to turn it into text. md-specpad never records or keeps audio.',
      settings: { label: 'Open speech settings', uri: SETTINGS_URIS.speechPrivacy },
    };
  }
  if (code.includes('VOICE_TYPING_FAILED')) {
    return {
      title: "Couldn't start Windows voice typing",
      steps: [
        'Make sure the md-specpad window is in front, then tap the microphone again.',
        'If it keeps failing, close md-specpad and open it again.',
      ],
    };
  }
  return sharedError(code);
}

/** Android: the fix for each bridge code (`STT_ERROR:<n>` = SpeechRecognizer.ERROR_*). */
function androidError(code: string): Omit<CaptureError, 'code'> {
  const numeric = /STT_ERROR:(-?\d+)/.exec(code);
  const n = numeric ? Number(numeric[1]) : null;
  if (code.includes('PERMISSION_DENIED') || n === 9) {
    return {
      title: 'Microphone permission is off',
      steps: [
        'Open Android Settings > Apps > md-specpad > Permissions.',
        'Set Microphone to "Allow only while using the app".',
        RETRY,
      ],
    };
  }
  if (code.includes('STT_UNAVAILABLE')) {
    return {
      title: "Speech recognition isn't available on this device",
      steps: [
        'Install or update "Speech Recognition & Synthesis from Google" in the Play Store.',
        RETRY,
      ],
    };
  }
  if (n === 1 || n === 2) {
    return {
      title: 'Speech recognition needs a connection',
      steps: [
        "Connect to the internet, or download offline speech for your language in your keyboard's voice typing settings.",
        RETRY,
      ],
    };
  }
  if (n === 12 || n === 13) {
    return {
      title: 'No speech model for your language',
      steps: [
        "Download offline speech for your language in your keyboard's voice typing settings, or connect to the internet.",
        RETRY,
      ],
    };
  }
  if (n === 6 || n === 7) {
    return sharedError('STT_NO_MATCH');
  }
  if (n === 8) {
    return sharedError('STT_BUSY');
  }
  return sharedError(code);
}

/** Whisper (offline): codes from ui/pcm-capture.ts and src-tauri commands/whisper. */
function whisperError(code: string): Omit<CaptureError, 'code'> {
  const voiceSettings = { label: 'Open voice notes settings', tab: 'voice' as const };
  if (code.includes('WHISPER_NO_MODEL')) {
    return {
      title: 'No Whisper model is downloaded',
      steps: [
        'Open Settings > Voice notes.',
        'Download the recommended model (Small, English) — about 490 MB, once.',
        RETRY,
      ],
      note: 'Transcription runs on this computer. Nothing is sent anywhere, and no audio is kept.',
      appSettings: voiceSettings,
    };
  }
  if (code.includes('WHISPER_MODEL_CORRUPT') || code.includes('WHISPER_LOAD_FAILED')) {
    return {
      title: "The Whisper model couldn't be loaded",
      steps: [
        'Open Settings > Voice notes, delete the model and download it again.',
        'If it keeps failing, pick a smaller model — a large one may not fit in memory.',
        RETRY,
      ],
      appSettings: voiceSettings,
    };
  }
  if (code.includes('WHISPER_MIC_DENIED')) {
    return {
      title: 'Microphone access was refused',
      steps: [
        'Allow md-specpad to use the microphone when asked, or in your system privacy settings.',
        RETRY,
      ],
    };
  }
  if (code.includes('WHISPER_NO_MIC')) {
    return {
      title: 'No microphone was found',
      steps: ['Plug in or turn on a microphone.', RETRY],
    };
  }
  if (code.includes('WHISPER_TOO_LONG')) {
    return {
      title: 'That note hit the 10-minute limit',
      steps: ['Tap the microphone to record the rest as a second note.'],
    };
  }
  if (code.includes('WHISPER_FAILED')) {
    return {
      title: 'Transcription failed',
      steps: [RETRY, 'If it keeps failing, try a smaller model in Settings > Voice notes.'],
      appSettings: voiceSettings,
    };
  }
  return sharedError(code);
}

/** Codes both bridges use, and the fallback. */
function sharedError(code: string): Omit<CaptureError, 'code'> {
  if (code.includes('STT_NO_MATCH')) {
    return {
      title: "Didn't catch that",
      steps: [
        'Tap the microphone and start speaking right away.',
        'Tap it again when you are done.',
      ],
    };
  }
  if (code.includes('STT_BUSY')) {
    return {
      title: 'Still finishing the last recording',
      steps: ['Wait a moment, then tap the microphone again.'],
    };
  }
  if (code.includes('STT_STOP_TIMEOUT')) {
    return {
      title: "Dictation didn't finish",
      steps: [
        'Tap the microphone to record the note again.',
        'If it keeps happening, close md-specpad and open it again.',
      ],
    };
  }
  if (code.includes('PERMISSION_BRIDGE_FAILED')) {
    return {
      title: "Couldn't ask for microphone permission",
      steps: ['Close this sheet, open it again, and tap the microphone.'],
    };
  }
  return {
    title: 'Speech recognition failed',
    steps: ['Tap the microphone to try again.'],
  };
}

/** The sheet-ready error for a bridge rejection on the given engine. */
export function captureErrorFor(raw: string, engine: DictationEngine): CaptureError {
  const code = raw.trim() || 'UNKNOWN';
  const shaped =
    engine === 'windows'
      ? windowsError(code)
      : engine === 'whisper'
        ? whisperError(code)
        : androidError(code);
  return { code, ...shaped };
}
