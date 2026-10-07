/**
 * Audio-file vocabulary and the pure math behind the audio tab: which paths
 * are audio, the waveform's peak buckets, level readings, the time ruler and
 * the clock text. The extension list mirrors `AUDIO_EXTENSIONS` in
 * src-tauri/src/commands/fs.rs (Rust is the listing gatekeeper; TS decides how
 * a clicked path opens).
 *
 * An audio file opens in the same read-only viewer tab kind as an image
 * (`kind: 'image'`, see core/types.ts) — the tab is routed to the audio view
 * by this extension check, so the session manifest needs no new kind.
 */

import { extName } from './session/plan-flush';

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
};

export function isAudioPath(path: string): boolean {
  return extName(path).toLowerCase() in AUDIO_MIME;
}

/** MIME type for the playback Blob; octet-stream for a non-audio path. */
export function audioMimeType(path: string): string {
  return AUDIO_MIME[extName(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The waveform's columns: for each of `buckets` equal slices of the track, the
 * lowest and highest sample across every channel, interleaved
 * `[min0, max0, min1, max1, …]`. Taking the extremes across channels (rather
 * than drawing a downmix) keeps out-of-phase stereo from reading as silence.
 * A slice with no samples (more buckets than samples) is `[0, 0]`.
 */
export function computePeaks(channels: readonly Float32Array[], buckets: number): Float32Array {
  const out = new Float32Array(Math.max(0, buckets) * 2);
  const length = channels[0]?.length ?? 0;
  if (buckets <= 0 || length === 0) {
    return out;
  }
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * length) / buckets);
    const end = Math.floor(((b + 1) * length) / buckets);
    let min = 0;
    let max = 0;
    for (const data of channels) {
      for (let i = start; i < end; i++) {
        const v = data[i] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

/**
 * Fit a peak cache (from {@link computePeaks}) to `bars` display columns:
 * each bar takes the extremes of the cache slots it covers. More bars than
 * slots repeats slots, so a short clip still spans the full width.
 */
export function resamplePeaks(peaks: Float32Array, bars: number): Float32Array {
  const slots = peaks.length / 2;
  const out = new Float32Array(Math.max(0, bars) * 2);
  if (slots === 0 || bars <= 0) {
    return out;
  }
  for (let b = 0; b < bars; b++) {
    const start = Math.floor((b * slots) / bars);
    const end = Math.max(start + 1, Math.floor(((b + 1) * slots) / bars));
    let min = 0;
    let max = 0;
    for (let s = start; s < end; s++) {
      min = Math.min(min, peaks[s * 2] ?? 0);
      max = Math.max(max, peaks[s * 2 + 1] ?? 0);
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

/** The largest absolute value in a peak array (the waveform's normalizer). */
export function peakExtent(peaks: Float32Array): number {
  let extent = 0;
  for (let i = 0; i < peaks.length; i++) {
    extent = Math.max(extent, Math.abs(peaks[i] ?? 0));
  }
  return extent;
}

export interface AudioLevels {
  /** Loudest sample, dBFS (0 = full scale); -Infinity for digital silence. */
  readonly peakDb: number;
  /** Average power over the whole track, dBFS; -Infinity for digital silence. */
  readonly rmsDb: number;
}

export function measureLevels(channels: readonly Float32Array[]): AudioLevels {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] ?? 0);
      if (v > peak) peak = v;
      sumSquares += v * v;
    }
    count += data.length;
  }
  return {
    peakDb: toDb(peak),
    rmsDb: count === 0 ? -Infinity : toDb(Math.sqrt(sumSquares / count)),
  };
}

function toDb(amplitude: number): number {
  return amplitude <= 0 ? -Infinity : 20 * Math.log10(amplitude);
}

/** "-3.2 dB", or "−∞ dB" for silence. */
export function formatDb(db: number): string {
  if (!Number.isFinite(db)) {
    return '−∞ dB';
  }
  return `${db.toFixed(1).replace('-', '−')} dB`;
}

/** Average all channels into one (Whisper wants mono). One channel is returned as-is. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  const [first] = channels;
  if (!first) {
    return new Float32Array(0);
  }
  if (channels.length === 1) {
    return first;
  }
  const out = new Float32Array(first.length);
  for (const data of channels) {
    for (let i = 0; i < out.length; i++) {
      out[i] = (out[i] ?? 0) + (data[i] ?? 0);
    }
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] ?? 0) * scale;
  }
  return out;
}

/**
 * Clock text: `m:ss` under an hour, `h:mm:ss` beyond; `tenths` adds `.d`
 * (the hover readout, where a second is too coarse). Negative and non-finite
 * input read as 0.
 */
export function formatClock(seconds: number, tenths = false): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const whole = Math.floor(safe);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, '0');
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  return tenths ? `${base}.${Math.floor((safe - whole) * 10)}` : base;
}

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/**
 * The time ruler's label interval: the smallest "round" step that keeps
 * labels at least `minGapPx` apart across a `widthPx`-wide waveform.
 */
export function rulerStep(duration: number, widthPx: number, minGapPx = 72): number {
  if (!(duration > 0) || !(widthPx > 0)) {
    return 1;
  }
  const maxLabels = Math.max(1, Math.floor(widthPx / minGapPx));
  const step = TICK_STEPS.find((s) => duration / s <= maxLabels);
  return step ?? Math.ceil(duration / maxLabels / 3600) * 3600;
}

/** "4.2 MB" / "812 KB" / "96 B". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "mono" / "stereo" / "6 ch". */
export function channelLabel(channels: number): string {
  return channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} ch`;
}

/** "44.1 kHz" / "48 kHz". */
export function sampleRateLabel(hz: number): string {
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/** Average bitrate from size and duration: "128 kbps". Null when unknowable. */
export function bitrateLabel(bytes: number, duration: number): string | null {
  if (!(duration > 0) || !(bytes > 0)) {
    return null;
  }
  return `${Math.round((bytes * 8) / duration / 1000)} kbps`;
}
