/**
 * The audio tab's "Transcribe to note": run an already-decoded recording
 * through the offline Whisper engine and open the text as a new note.
 *
 * One job at a time, app-wide — the Rust engine holds one model and runs one
 * transcription, so a second request while one is in flight is refused with
 * a notice rather than queued. There is no cancel: whisper.cpp runs to the
 * end once started (the engine has no abort hook), so the view shows the
 * elapsed time instead.
 *
 * The audio arrives as mono PCM at whatever rate the view decoded it at; the
 * Rust command resamples to Whisper's 16 kHz (the view already decodes at
 * 16 kHz, so that is a no-op in practice).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { captureErrorFor } from '../core/dictation-errors';
import { baseName } from '../core/session/plan-flush';
import { ipc } from '../ipc/commands';
import { whisperReady } from './voice-comments';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';
import { whisperModelsStore } from './stores/whisper-models';

export type TranscribePhase = 'idle' | 'transcribing' | 'needs-model' | 'error';

export interface AudioTranscribeState {
  /** The file the current (or last failed) job was for; null when idle. */
  path: string | null;
  phase: TranscribePhase;
  /** `Date.now()` when the running job started (the elapsed-time readout). */
  startedAt: number;
  /** One line for the `error` phase. */
  error: string | null;
}

const IDLE: AudioTranscribeState = { path: null, phase: 'idle', startedAt: 0, error: null };

export const audioTranscribeStore = createStore<AudioTranscribeState>()(() => ({ ...IDLE }));

export const useAudioTranscribe = <T>(selector: (s: AudioTranscribeState) => T): T =>
  useStore(audioTranscribeStore, selector);

/** The markdown a finished transcript opens as. */
export function transcriptNote(path: string, text: string): string {
  return `# Transcript: ${baseName(path)}\n\n${text.trim()}\n`;
}

/**
 * Transcribe `pcm` (mono, `sampleRate` Hz) recorded from `path` and open the
 * result as a new note. Resolves when the job has settled either way; the
 * outcome is in the store (and in a new active tab on success).
 */
export async function transcribeAudio(
  path: string,
  pcm: Float32Array,
  sampleRate: number,
): Promise<void> {
  if (audioTranscribeStore.getState().phase === 'transcribing') {
    uiStore.getState().showNotice('A transcription is already running — wait for it to finish.');
    return;
  }
  const models = whisperModelsStore.getState();
  if (!models.loaded) {
    await models.refresh();
  }
  if (!whisperReady()) {
    audioTranscribeStore.setState({ ...IDLE, path, phase: 'needs-model' });
    return;
  }
  audioTranscribeStore.setState({ ...IDLE, path, phase: 'transcribing', startedAt: Date.now() });
  try {
    const { whisperModel, whisperUseGpu } = settingsStore.getState().settings;
    const text = (await ipc.whisperTranscribe(pcm, sampleRate, whisperModel, whisperUseGpu)).trim();
    if (!text) {
      audioTranscribeStore.setState({
        ...IDLE,
        path,
        phase: 'error',
        error: 'No speech was found in this recording.',
      });
      return;
    }
    audioTranscribeStore.setState({ ...IDLE });
    const tabs = tabsStore.getState();
    tabs.newTab();
    tabsStore.getState().activeTab()?.model.pushText(transcriptNote(path, text), 'programmatic');
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: unknown } | null)?.code;
    const full = typeof code === 'string' && !raw.startsWith(code) ? `${code}:${raw}` : raw;
    if (full.includes('WHISPER_NO_MODEL')) {
      audioTranscribeStore.setState({ ...IDLE, path, phase: 'needs-model' });
      return;
    }
    audioTranscribeStore.setState({
      ...IDLE,
      path,
      phase: 'error',
      error: captureErrorFor(full, 'whisper').title,
    });
  }
}

/** Clear a finished job's message (the view's dismiss button). */
export function dismissTranscribe(): void {
  if (audioTranscribeStore.getState().phase !== 'transcribing') {
    audioTranscribeStore.setState({ ...IDLE });
  }
}
