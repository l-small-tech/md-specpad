/**
 * pcm-capture.ts — the microphone, as a growing in-memory PCM buffer.
 *
 * The Whisper engine transcribes a whole capture at once, so all this does is
 * open the mic, ask the audio graph for Whisper's 16 kHz, and collect every
 * frame an `AudioWorkletNode` posts back until `stop()` hands the lot over as
 * one `Float32Array`. Nothing is written anywhere: the buffer lives for one
 * capture and is dropped with it (the "no audio files" rule).
 *
 * DOM-only plumbing, deliberately thin (and therefore not unit-tested — see
 * the ui testing policy): the size cap and the concatenation live in
 * `core/whisper-models.ts`, where they are tested. Failures are thrown as the
 * capture codes `core/dictation-errors.ts` knows (`WHISPER_MIC_DENIED`,
 * `WHISPER_NO_MIC`, `WHISPER_FAILED:<why>`).
 *
 * The worklet is its own file, `pcm-tap.worklet.js`, emitted by the build as
 * a same-origin asset and loaded by URL. It must not be a Blob or data: URL:
 * Chromium checks `audioWorklet.addModule` fetches against `script-src`
 * (worklets are script-like destinations; `worker-src` covers only
 * Worker/SharedWorker/ServiceWorker), which falls back to the release CSP's
 * `default-src 'self'` — so `blob:`/`data:` would be refused in installed
 * builds only, `tauri dev` applying no CSP. `no-inline` stops Vite from
 * turning the small file into a data: URL; `__tests__/pcm-worklet-asset.test.ts`
 * builds this module and checks the output.
 */

import { captureLimitReached, concatPcm, WHISPER_SAMPLE_RATE } from '../core/whisper-models';
import pcmTapWorkletUrl from './pcm-tap.worklet.js?url&no-inline';

export interface PcmCapture {
  /** The rate the graph actually runs at — 16 000 unless the backend refused it. */
  readonly sampleRate: number;
  /** Stop the mic and return everything captured (mono f32, -1..1). */
  stop(): Float32Array;
  /** Stop the mic and throw the audio away. */
  cancel(): void;
}

export interface PcmCaptureOptions {
  /**
   * Called once, from the audio thread's message, when the capture reaches
   * `MAX_CAPTURE_SECONDS`. Frames after it are dropped; the caller stops.
   */
  onLimit?: () => void;
}

/** The capture code for a `getUserMedia` rejection. */
export function micErrorCode(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'WHISPER_MIC_DENIED';
  }
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError'
  ) {
    return 'WHISPER_NO_MIC';
  }
  const detail = e instanceof Error ? `${name}: ${e.message}` : String(e);
  return `WHISPER_FAILED:${detail}`;
}

/** Open the microphone and start collecting PCM. Rejects with a capture code. */
export async function startPcmCapture(options: PcmCaptureOptions = {}): Promise<PcmCapture> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('WHISPER_NO_MIC');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    throw new Error(micErrorCode(e), { cause: e });
  }

  const stopTracks = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  // Whisper wants 16 kHz. A backend that refuses the rate (some Linux audio
  // stacks) gets the default; Rust resamples what it is told the rate was.
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  } catch {
    ctx = new AudioContext();
  }

  let source: MediaStreamAudioSourceNode;
  let tap: AudioWorkletNode;
  try {
    await ctx.audioWorklet.addModule(pcmTapWorkletUrl);
    source = ctx.createMediaStreamSource(stream);
    tap = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
  } catch (e) {
    stopTracks();
    void ctx.close().catch(() => {});
    throw new Error(`WHISPER_FAILED:${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }

  const chunks: Float32Array[] = [];
  let samples = 0;
  let live = true;
  tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (!live) {
      return;
    }
    const frame = event.data;
    chunks.push(frame);
    samples += frame.length;
    if (captureLimitReached(samples, ctx.sampleRate)) {
      live = false;
      options.onLimit?.();
    }
  };
  source.connect(tap);
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const teardown = () => {
    live = false;
    tap.port.onmessage = null;
    try {
      source.disconnect();
      tap.disconnect();
    } catch {
      // Already torn down.
    }
    stopTracks();
    void ctx.close().catch(() => {});
  };

  return {
    sampleRate: ctx.sampleRate,
    stop() {
      teardown();
      const pcm = concatPcm(chunks);
      chunks.length = 0;
      return pcm;
    },
    cancel() {
      teardown();
      chunks.length = 0;
    },
  };
}
