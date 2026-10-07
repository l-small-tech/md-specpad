import { beforeEach, describe, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ whisperTranscribe: vi.fn() }));
const whisper = vi.hoisted(() => ({ ready: true, loaded: true, refresh: vi.fn() }));
const notices = vi.hoisted(() => [] as string[]);
const tabs = vi.hoisted(() => ({
  opened: [] as string[],
  newTab: vi.fn(),
}));

vi.mock('../../ipc/commands', () => ({ ipc }));
vi.mock('../voice-comments', () => ({ whisperReady: () => whisper.ready }));
vi.mock('../stores/whisper-models', () => ({
  whisperModelsStore: {
    getState: () => ({ loaded: whisper.loaded, refresh: whisper.refresh }),
  },
}));
vi.mock('../stores/settings', () => ({
  settingsStore: {
    getState: () => ({ settings: { whisperModel: 'base.en', whisperUseGpu: false } }),
  },
}));
vi.mock('../stores/tabs', () => ({
  tabsStore: {
    getState: () => ({
      newTab: tabs.newTab,
      activeTab: () => ({ model: { pushText: (text: string) => tabs.opened.push(text) } }),
    }),
  },
}));
vi.mock('../stores/ui', () => ({
  uiStore: { getState: () => ({ showNotice: (text: string) => notices.push(text) }) },
}));

import {
  audioTranscribeStore,
  dismissTranscribe,
  transcribeAudio,
  transcriptNote,
} from '../audio-transcribe';

const PCM = new Float32Array([0.1, -0.1]);

beforeEach(() => {
  ipc.whisperTranscribe.mockReset();
  whisper.ready = true;
  whisper.loaded = true;
  whisper.refresh.mockReset();
  tabs.newTab.mockReset();
  tabs.opened.length = 0;
  notices.length = 0;
  audioTranscribeStore.setState({ path: null, phase: 'idle', startedAt: 0, error: null });
});

describe('transcriptNote', () => {
  test('titles the note after the file', () => {
    expect(transcriptNote('C:\\rec\\standup.m4a', '  hello there \n')).toBe(
      '# Transcript: standup.m4a\n\nhello there\n',
    );
  });
});

describe('transcribeAudio', () => {
  test('sends the PCM with the configured model and opens a note', async () => {
    ipc.whisperTranscribe.mockResolvedValue(' hello world ');
    await transcribeAudio('/r/memo.mp3', PCM, 16000);
    expect(ipc.whisperTranscribe).toHaveBeenCalledWith(PCM, 16000, 'base.en', false);
    expect(tabs.newTab).toHaveBeenCalledOnce();
    expect(tabs.opened).toEqual(['# Transcript: memo.mp3\n\nhello world\n']);
    expect(audioTranscribeStore.getState().phase).toBe('idle');
  });

  test('is "transcribing" while the engine runs', async () => {
    let finish: (text: string) => void = () => {};
    ipc.whisperTranscribe.mockReturnValue(new Promise<string>((r) => (finish = r)));
    const job = transcribeAudio('/r/a.wav', PCM, 16000);
    await Promise.resolve();
    expect(audioTranscribeStore.getState()).toMatchObject({
      phase: 'transcribing',
      path: '/r/a.wav',
    });
    // A second request is refused, not queued.
    await transcribeAudio('/r/b.wav', PCM, 16000);
    expect(notices).toHaveLength(1);
    expect(ipc.whisperTranscribe).toHaveBeenCalledOnce();
    finish('ok');
    await job;
    expect(audioTranscribeStore.getState().phase).toBe('idle');
  });

  test('no model: asks for one instead of calling the engine', async () => {
    whisper.ready = false;
    whisper.loaded = false;
    await transcribeAudio('/r/a.wav', PCM, 16000);
    expect(whisper.refresh).toHaveBeenCalledOnce();
    expect(ipc.whisperTranscribe).not.toHaveBeenCalled();
    expect(audioTranscribeStore.getState()).toMatchObject({
      phase: 'needs-model',
      path: '/r/a.wav',
    });
  });

  test('engine reports a missing model the same way', async () => {
    ipc.whisperTranscribe.mockRejectedValue(
      Object.assign(new Error('model file gone'), { code: 'WHISPER_NO_MODEL' }),
    );
    await transcribeAudio('/r/a.wav', PCM, 16000);
    expect(audioTranscribeStore.getState().phase).toBe('needs-model');
  });

  test('silence and failures end in an error line, and no note', async () => {
    ipc.whisperTranscribe.mockResolvedValue('   ');
    await transcribeAudio('/r/a.wav', PCM, 16000);
    expect(audioTranscribeStore.getState()).toMatchObject({
      phase: 'error',
      error: 'No speech was found in this recording.',
    });

    ipc.whisperTranscribe.mockRejectedValue(new Error('WHISPER_FAILED: boom'));
    await transcribeAudio('/r/a.wav', PCM, 16000);
    expect(audioTranscribeStore.getState()).toMatchObject({
      phase: 'error',
      error: 'Transcription failed',
    });
    expect(tabs.newTab).not.toHaveBeenCalled();

    dismissTranscribe();
    expect(audioTranscribeStore.getState()).toMatchObject({ phase: 'idle', path: null });
  });
});
