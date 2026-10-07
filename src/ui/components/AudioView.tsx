/**
 * AudioView — the player behind an audio tab (an `image`-kind viewer tab whose
 * path is audio; see core/types.ts). Header facts, a waveform you click or
 * drag to seek, the transport, level readings, and "Transcribe to note".
 *
 * The file's bytes come through the session controller (storage provider, so
 * Android SAF paths work too). Playback is a plain <audio> on a Blob URL
 * (CSP `media-src blob:`); the waveform is a separate Web Audio decode at
 * 16 kHz — plenty for a picture, far lighter than the native rate, and exactly
 * what Whisper wants. Only the peak cache survives the decode; transcription
 * decodes again from the retained bytes rather than holding raw PCM for the
 * tab's lifetime.
 *
 * Playback keeps going when you switch tabs (listen while writing notes); it
 * stops when the tab closes.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  audioMimeType,
  bitrateLabel,
  channelLabel,
  computePeaks,
  downmix,
  formatBytes,
  formatClock,
  formatDb,
  measureLevels,
  rulerStep,
  sampleRateLabel,
  type AudioLevels,
} from '../../core/audio';
import { probeAudio, type AudioProbe } from '../../core/audio-probe';
import { downloadPercent } from '../../core/whisper-models';
import { baseName, extName } from '../../core/session/plan-flush';
import { dismissTranscribe, transcribeAudio, useAudioTranscribe } from '../audio-transcribe';
import { paintWaveform } from '../audio-waveform';
import { loadFileBytes } from '../session';
import { useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import { useWhisperModels } from '../stores/whisper-models';
import { installWhisper } from '../voice-comments';
import '../../styles/audio.css';

const DECODE_RATE = 16000;
/** Peak-cache resolution: plenty for any window width, tiny in memory. */
const PEAK_SLOTS = 4096;
const SKIP_SECONDS = 5;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

interface Loaded {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly url: string;
  readonly probe: AudioProbe;
}

interface Analysis {
  readonly path: string;
  readonly peaks: Float32Array;
  readonly levels: AudioLevels;
  readonly channels: number;
  readonly duration: number;
}

/** Decode to 16 kHz with the original channel count (decode detaches its input, so copy). */
function decode(bytes: Uint8Array): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(1, 1, DECODE_RATE);
  return context.decodeAudioData(bytes.slice().buffer);
}

function channelData(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
}

function AudioViewImpl({ tabId, active }: { tabId: string; active: boolean }) {
  const filePath = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  const [loaded, setLoaded] = useState<Loaded | { path: string; failed: true } | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | { path: string; failed: true } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [playError, setPlayError] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [waveWidth, setWaveWidth] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(1);
  const dragging = useRef(false);

  // Load the bytes, hand them to <audio>, then decode for the waveform.
  useEffect(() => {
    if (!filePath) {
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    setPlaying(false);
    setCurrent(0);
    setMediaDuration(0);
    setPlayError(false);
    void loadFileBytes(filePath)
      .then((bytes) => {
        if (cancelled) {
          return;
        }
        url = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: audioMimeType(filePath) }),
        );
        setLoaded({ path: filePath, bytes, url, probe: probeAudio(bytes) });
        return decode(bytes).then((buffer) => {
          if (cancelled) {
            return;
          }
          const channels = channelData(buffer);
          setAnalysis({
            path: filePath,
            peaks: computePeaks(channels, Math.min(PEAK_SLOTS, buffer.length)),
            levels: measureLevels(channels),
            channels: buffer.numberOfChannels,
            duration: buffer.duration,
          });
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        // Distinguish "could not read" from "could not decode the waveform".
        setLoaded((prev) =>
          prev && prev.path === filePath ? prev : { path: filePath, failed: true },
        );
        setAnalysis({ path: filePath, failed: true });
      });
    return () => {
      cancelled = true;
      // No explicit pause: removing the <audio> (tab closed) pauses it per spec.
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [filePath]);

  const file = loaded && loaded.path === filePath && !('failed' in loaded) ? loaded : null;
  const readFailed = loaded !== null && loaded.path === filePath && 'failed' in loaded;
  const facts = analysis && analysis.path === filePath && !('failed' in analysis) ? analysis : null;
  const waveFailed = analysis !== null && analysis.path === filePath && 'failed' in analysis;
  const duration = mediaDuration > 0 ? mediaDuration : (facts?.duration ?? 0);

  // Smooth playhead: poll currentTime every frame while playing (timeupdate is ~4 Hz).
  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = requestAnimationFrame(function tick() {
      const audio = audioRef.current;
      if (audio && !dragging.current) {
        setCurrent(audio.currentTime);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    const wave = waveRef.current;
    if (!wave) {
      return;
    }
    const observer = new ResizeObserver(() => setWaveWidth(wave.clientWidth));
    observer.observe(wave);
    return () => observer.disconnect();
  }, [file]);

  // Repaint on anything the picture depends on; a theme switch repaints too.
  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas && active) {
      paintWaveform(canvas, { peaks: facts?.peaks ?? null, duration, current, hover });
    }
  }, [facts, duration, current, hover, active]);
  useEffect(repaint, [repaint, waveWidth]);
  useEffect(() => {
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [repaint]);

  const seek = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio || !(duration > 0)) {
        return;
      }
      const t = Math.min(duration, Math.max(0, seconds));
      audio.currentTime = t;
      setCurrent(t);
    },
    [duration],
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.paused) {
      void audio.play().catch(() => setPlayError(true));
    } else {
      audio.pause();
    }
  }, []);

  const timeAt = (clientX: number): number => {
    const rect = waveRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      return 0;
    }
    return (Math.min(rect.width, Math.max(0, clientX - rect.left)) / rect.width) * duration;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') {
      return;
    }
    const handled = (() => {
      switch (e.key) {
        case ' ':
        case 'k':
          togglePlay();
          return true;
        case 'ArrowLeft':
          seek(current - (e.shiftKey ? 1 : SKIP_SECONDS));
          return true;
        case 'ArrowRight':
          seek(current + (e.shiftKey ? 1 : SKIP_SECONDS));
          return true;
        case 'Home':
          seek(0);
          return true;
        case 'End':
          seek(duration);
          return true;
        default:
          return false;
      }
    })();
    if (handled) {
      e.preventDefault();
    }
  };

  const cycleSpeed = () => {
    const next =
      SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length] ?? 1;
    setSpeed(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
    }
  };

  const onTranscribe = async () => {
    if (!file) {
      return;
    }
    try {
      const buffer = await decode(file.bytes);
      await transcribeAudio(file.path, downmix(channelData(buffer)), buffer.sampleRate);
    } catch {
      uiStore.getState().showNotice('This recording could not be decoded for transcription.');
    }
  };

  const name = filePath ? baseName(filePath) : 'audio';
  const ext = filePath ? extName(filePath).slice(1).toUpperCase() : '';

  return (
    <div className="editor-host audio-host" style={{ display: active ? 'flex' : 'none' }}>
      <div className="audio-view" tabIndex={0} onKeyDown={onKeyDown}>
        {readFailed ? (
          <div className="image-view-status">Could not read this file.</div>
        ) : !file ? (
          <div className="image-view-status">Loading…</div>
        ) : (
          <div className="audio-panel">
            <audio
              ref={audioRef}
              src={file.url}
              preload="auto"
              loop={loop}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false);
                setCurrent(duration);
              }}
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                setMediaDuration(Number.isFinite(d) ? d : 0);
              }}
              onTimeUpdate={(e) => {
                if (!dragging.current) setCurrent(e.currentTarget.currentTime);
              }}
              onError={() => setPlayError(true)}
            />

            <header className="audio-head">
              <span className="import-card-badge">{ext}</span>
              <span className="audio-name" title={filePath ?? undefined}>
                {name}
              </span>
            </header>
            <FactsLine file={file} channels={facts?.channels ?? null} duration={duration} />

            <div
              className="audio-wave"
              ref={waveRef}
              onPointerDown={(e) => {
                if (e.button !== 0 || !(duration > 0)) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                dragging.current = true;
                seek(timeAt(e.clientX));
              }}
              onPointerMove={(e) => {
                const t = timeAt(e.clientX);
                setHover(t);
                if (dragging.current) seek(t);
              }}
              onPointerUp={() => {
                dragging.current = false;
              }}
              onPointerCancel={() => {
                dragging.current = false;
              }}
              onPointerLeave={() => {
                if (!dragging.current) setHover(null);
              }}
            >
              <canvas ref={canvasRef} className="audio-canvas" />
              {hover !== null && duration > 0 && (
                <span className="audio-hover-time" style={{ left: `${(hover / duration) * 100}%` }}>
                  {formatClock(hover, true)}
                </span>
              )}
              {!facts && (
                <span className="audio-wave-note">
                  {waveFailed ? 'No waveform for this format' : 'Reading waveform…'}
                </span>
              )}
            </div>
            <Ruler duration={duration} width={waveWidth} />

            <div className="audio-transport">
              <button
                type="button"
                className="audio-play"
                onClick={togglePlay}
                disabled={playError}
                title={playing ? 'Pause (Space)' : 'Play (Space)'}
                aria-label={playing ? 'Pause' : 'Play'}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  {playing ? (
                    <path d="M5 3.5v9M11 3.5v9" />
                  ) : (
                    <path d="M5.5 3.2v9.6l7.5-4.8z" className="audio-fill" />
                  )}
                </svg>
              </button>
              <span className="audio-clock">
                <span>{formatClock(current)}</span>
                <span className="audio-clock-total"> / {formatClock(duration)}</span>
              </span>
              <span className="audio-spacer" />
              <button
                type="button"
                className="audio-btn"
                onClick={() => seek(current - SKIP_SECONDS)}
                title="Back 5 seconds (←)"
              >
                −5s
              </button>
              <button
                type="button"
                className="audio-btn"
                onClick={() => seek(current + SKIP_SECONDS)}
                title="Forward 5 seconds (→)"
              >
                +5s
              </button>
              <button
                type="button"
                className="audio-btn audio-speed"
                onClick={cycleSpeed}
                title="Playback speed"
              >
                {speed}×
              </button>
              <button
                type="button"
                className="audio-btn"
                aria-pressed={loop}
                onClick={() => setLoop((l) => !l)}
                title="Loop"
              >
                loop
              </button>
              <input
                className="audio-volume"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                aria-label="Volume"
                title={`Volume ${Math.round(volume * 100)}%`}
                onChange={(e) => {
                  const v = Number(e.currentTarget.value);
                  setVolume(v);
                  if (audioRef.current) audioRef.current.volume = v;
                }}
              />
            </div>
            {playError && (
              <p className="audio-note audio-note-error">
                This format can’t be played on this system.
              </p>
            )}

            {facts && <LevelsRow levels={facts.levels} />}

            <TranscribeRow path={file.path} canRun={!waveFailed} onRun={onTranscribe} />
          </div>
        )}
      </div>
    </div>
  );
}

function FactsLine({
  file,
  channels,
  duration,
}: {
  file: Loaded;
  channels: number | null;
  duration: number;
}) {
  const { probe } = file;
  const parts = [
    probe.codec,
    duration > 0 ? formatClock(duration) : null,
    probe.sampleRate ? sampleRateLabel(probe.sampleRate) : null,
    probe.bitDepth ? `${probe.bitDepth}-bit` : null,
    (probe.channels ?? channels) ? channelLabel(probe.channels ?? channels ?? 0) : null,
    probe.bitDepth ? null : bitrateLabel(file.bytes.length, duration),
    formatBytes(file.bytes.length),
  ].filter((p): p is string => !!p);
  return <div className="audio-facts">{parts.join(' · ')}</div>;
}

function Ruler({ duration, width }: { duration: number; width: number }) {
  if (!(duration > 0) || width === 0) {
    return <div className="audio-ruler" />;
  }
  const step = rulerStep(duration, width);
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) {
    ticks.push(t);
  }
  return (
    <div className="audio-ruler" aria-hidden="true">
      {ticks.map((t) => (
        <span
          key={t}
          className={t / duration > 0.94 ? 'audio-tick audio-tick-end' : 'audio-tick'}
          style={{ left: `${(t / duration) * 100}%` }}
        >
          {formatClock(t)}
        </span>
      ))}
    </div>
  );
}

function LevelsRow({ levels }: { levels: AudioLevels }) {
  return (
    <div className="audio-levels">
      <span className="audio-stat" title="Loudest moment (0 dB = the maximum a file can hold)">
        <span className="audio-stat-label">peak</span>
        {formatDb(levels.peakDb)}
      </span>
      <span className="audio-stat" title="Average loudness over the whole recording (RMS)">
        <span className="audio-stat-label">average</span>
        {formatDb(levels.rmsDb)}
      </span>
    </div>
  );
}

function TranscribeRow({
  path,
  canRun,
  onRun,
}: {
  path: string;
  canRun: boolean;
  onRun: () => void;
}) {
  const jobPath = useAudioTranscribe((s) => s.path);
  const phase = useAudioTranscribe((s) => s.phase);
  const startedAt = useAudioTranscribe((s) => s.startedAt);
  const error = useAudioTranscribe((s) => s.error);
  const download = useWhisperModels((s) => s.download);
  const [now, setNow] = useState(0);
  const mine = jobPath === path;
  const running = phase === 'transcribing';

  useEffect(() => {
    if (!(mine && running)) {
      return;
    }
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [mine, running]);

  const percent = downloadPercent(download);
  return (
    <div className="audio-transcribe">
      <button
        type="button"
        className="import-card-btn"
        onClick={onRun}
        disabled={!canRun || running}
        title="Turn the speech in this recording into a new note (offline, Whisper)"
      >
        {mine && running ? 'Transcribing…' : 'Transcribe to note'}
      </button>
      {mine && running && (
        <span className="audio-note">
          {formatClock((now - startedAt) / 1000)} elapsed — long recordings take a while
        </span>
      )}
      {!mine && running && <span className="audio-note">Another file is being transcribed.</span>}
      {mine && phase === 'needs-model' && (
        <span className="audio-note">
          {percent !== null ? (
            `Downloading the Whisper model… ${percent}%`
          ) : download.kind === 'done' ? (
            'Model ready — press Transcribe again.'
          ) : (
            <>
              Transcription runs offline and needs a Whisper model.{' '}
              <button type="button" className="audio-link" onClick={() => void installWhisper()}>
                Download it
              </button>
            </>
          )}
        </span>
      )}
      {mine && phase === 'error' && (
        <span className="audio-note audio-note-error">
          {error}{' '}
          <button type="button" className="audio-link" onClick={dismissTranscribe}>
            Dismiss
          </button>
        </span>
      )}
    </div>
  );
}

export const AudioView = memo(AudioViewImpl);
