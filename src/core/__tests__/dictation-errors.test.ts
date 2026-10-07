import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { captureErrorFor, SETTINGS_URIS } from '../dictation-errors';

describe('captureErrorFor — Windows (voice typing)', () => {
  test('nothing typed: how to check voice typing, with a speech settings link', () => {
    const e = captureErrorFor('VOICE_TYPING_EMPTY', 'windows');
    expect(e.title).toBe('Nothing was typed');
    expect(e.steps.join(' ')).toMatch(/Win\+H/);
    expect(e.steps.join(' ')).toMatch(/Online speech recognition/);
    expect(e.steps.at(-1)).toMatch(/tap the microphone again/i);
    expect(e.note).toMatch(/Microsoft/);
    expect(e.settings).toEqual({
      label: 'Open speech settings',
      uri: 'ms-settings:privacy-speech',
    });
  });

  test('Win+H could not be pressed: says so, keeps the raw reason', () => {
    const e = captureErrorFor('VOICE_TYPING_FAILED:Access is denied.', 'windows');
    expect(e.title).toMatch(/voice typing/);
    expect(e.code).toBe('VOICE_TYPING_FAILED:Access is denied.');
  });
});

describe('captureErrorFor — Android', () => {
  test('permission denied (by code or ERROR_INSUFFICIENT_PERMISSIONS) explains app permissions', () => {
    for (const raw of ['PERMISSION_DENIED', 'STT_ERROR:9']) {
      const e = captureErrorFor(raw, 'android');
      expect(e.steps.join(' ')).toMatch(/Apps > md-specpad > Permissions/);
      expect(e.settings).toBeUndefined(); // no ms-settings on a phone
    }
  });

  test('SpeechRecognizer numeric codes map to the shared messages', () => {
    expect(captureErrorFor('STT_ERROR:7', 'android').title).toBe("Didn't catch that");
    expect(captureErrorFor('STT_ERROR:6', 'android').title).toBe("Didn't catch that");
    expect(captureErrorFor('STT_ERROR:8', 'android').title).toMatch(/Still finishing/);
    expect(captureErrorFor('STT_ERROR:2', 'android').title).toMatch(/connection/);
    expect(captureErrorFor('STT_ERROR:13', 'android').title).toMatch(/language/);
  });
});

describe('captureErrorFor — Whisper (offline)', () => {
  test('no model: points at the Voice notes settings, no ms-settings link', () => {
    const e = captureErrorFor('WHISPER_NO_MODEL', 'whisper');
    expect(e.title).toMatch(/no whisper model/i);
    expect(e.steps.join(' ')).toMatch(/Settings > Voice notes/);
    expect(e.steps.at(-1)).toMatch(/tap the microphone again/i);
    expect(e.appSettings).toEqual({ label: 'Open voice notes settings', tab: 'voice' });
    expect(e.settings).toBeUndefined();
    expect(e.note).toMatch(/on this computer/);
  });

  test('a corrupt or unloadable model says to re-download', () => {
    for (const code of ['WHISPER_MODEL_CORRUPT', 'WHISPER_LOAD_FAILED:oom']) {
      const e = captureErrorFor(code, 'whisper');
      expect(e.steps.join(' ')).toMatch(/download it again/);
      expect(e.appSettings?.tab).toBe('voice');
    }
  });

  test('microphone problems and the length cap have their own words', () => {
    expect(captureErrorFor('WHISPER_MIC_DENIED', 'whisper').title).toMatch(/refused/);
    expect(captureErrorFor('WHISPER_NO_MIC', 'whisper').title).toMatch(/No microphone/);
    expect(captureErrorFor('WHISPER_TOO_LONG', 'whisper').title).toMatch(/10-minute/);
    expect(captureErrorFor('WHISPER_FAILED:boom', 'whisper').title).toBe('Transcription failed');
  });

  test('an empty transcript uses the shared "did not catch that"', () => {
    expect(captureErrorFor('STT_NO_MATCH', 'whisper').title).toBe("Didn't catch that");
  });

  test('every whisper code has a title and steps', () => {
    for (const code of [
      'WHISPER_NO_MODEL',
      'WHISPER_MODEL_CORRUPT',
      'WHISPER_MIC_DENIED',
      'WHISPER_NO_MIC',
      'WHISPER_TOO_LONG',
      'WHISPER_LOAD_FAILED',
      'WHISPER_FAILED',
      'STT_NO_MATCH',
      'WHATEVER',
    ]) {
      const e = captureErrorFor(code, 'whisper');
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.steps.length).toBeGreaterThan(0);
    }
  });
});

describe('captureErrorFor — shared', () => {
  test('an unknown code falls back to a retry, and keeps the raw code for support', () => {
    const e = captureErrorFor('STT_FAILED:0x80004005 boom', 'windows');
    expect(e.title).toBe('Speech recognition failed');
    expect(e.code).toBe('STT_FAILED:0x80004005 boom');
    expect(e.steps.length).toBeGreaterThan(0);
  });

  test('a dictation that never finishes says so, on both engines', () => {
    for (const engine of ['android', 'windows'] as const) {
      expect(captureErrorFor('STT_STOP_TIMEOUT', engine).title).toMatch(/didn't finish/);
    }
  });

  test('an empty rejection still produces a usable error', () => {
    expect(captureErrorFor('  ', 'android').code).toBe('UNKNOWN');
  });

  test('every error has a title and at least one step, on both engines', () => {
    const codes = [
      'STT_PRIVACY',
      'PERMISSION_DENIED',
      'PERMISSION_BRIDGE_FAILED',
      'STT_BUSY',
      'STT_UNAVAILABLE',
      'STT_NO_MIC',
      'STT_NETWORK',
      'STT_LANGUAGE',
      'STT_AUDIO_QUALITY',
      'STT_NO_MATCH',
      'VOICE_TYPING_EMPTY',
      'VOICE_TYPING_FAILED',
      'STT_STOP_TIMEOUT',
      'STT_ERROR:1',
      'STT_ERROR:12',
      'WHATEVER',
    ];
    for (const engine of ['android', 'windows', 'whisper'] as const) {
      for (const code of codes) {
        const e = captureErrorFor(code, engine);
        expect(e.title.length).toBeGreaterThan(0);
        expect(e.steps.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('Settings links are allowed by the app capabilities', () => {
  test('every ms-settings URI is allow-listed for the opener plugin', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const capPath = resolve(here, '../../../src-tauri/capabilities/default.json');
    const cap = JSON.parse(readFileSync(capPath, 'utf8')) as {
      permissions: (string | { identifier: string; allow?: { url: string }[] })[];
    };
    const allowed = cap.permissions
      .filter((p): p is { identifier: string; allow?: { url: string }[] } => typeof p === 'object')
      .filter((p) => p.identifier === 'opener:allow-open-url')
      .flatMap((p) => p.allow ?? [])
      .map((a) => a.url);
    for (const uri of Object.values(SETTINGS_URIS)) {
      expect(allowed).toContain(uri);
    }
  });
});
