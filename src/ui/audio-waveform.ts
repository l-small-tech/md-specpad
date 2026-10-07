/**
 * Paints the audio tab's waveform onto a canvas: mirrored bars from a peak
 * cache (`core/audio.ts computePeaks`), the played part in the accent color,
 * the stretch between the playhead and the pointer lightly previewed, and a
 * playhead line. Colors are read from the canvas's own CSS variables at paint
 * time, so a theme switch needs only a repaint.
 *
 * Kept out of the component so AudioView stays layout + wiring; the geometry
 * that is worth testing (bucketing, normalizing) lives in core/audio.ts.
 */

import { peakExtent, resamplePeaks } from '../core/audio';

/** Bar width and gap, CSS px. */
const BAR = 2;
const GAP = 1;
/** Quieter than this and the waveform is not scaled up further (noise floor). */
const MIN_EXTENT = 0.02;

export interface WaveformState {
  /** The peak cache, or null while the file is still decoding. */
  readonly peaks: Float32Array | null;
  readonly duration: number;
  readonly current: number;
  /** Pointer position in seconds, or null when the pointer is elsewhere. */
  readonly hover: number | null;
}

/** How many bars a waveform `width` CSS px wide shows. */
export function barCount(width: number): number {
  return Math.max(1, Math.floor((width + GAP) / (BAR + GAP)));
}

export function paintWaveform(canvas: HTMLCanvasElement, state: WaveformState): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) {
    return;
  }
  const pxW = Math.round(width * dpr);
  const pxH = Math.round(height * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const css = getComputedStyle(canvas);
  const accent = css.getPropertyValue('--accent').trim() || '#00703c';
  const muted = css.getPropertyValue('--fg-muted').trim() || '#586a5b';
  const fg = css.getPropertyValue('--fg').trim() || '#17241b';

  const mid = height / 2;
  const { duration } = state;
  const fraction = (t: number) => (duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0);
  const playX = fraction(state.current) * width;
  const hoverX = state.hover === null ? null : fraction(state.hover) * width;

  if (!state.peaks) {
    // Still decoding: a quiet center line where the waveform will be.
    ctx.fillStyle = muted;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, mid - 0.5, width, 1);
    ctx.globalAlpha = 1;
  } else {
    const bars = barCount(width);
    const cols = resamplePeaks(state.peaks, bars);
    const scale = (mid * 0.92) / Math.max(MIN_EXTENT, peakExtent(state.peaks));
    const previewFrom = hoverX === null ? 0 : Math.min(playX, hoverX);
    const previewTo = hoverX === null ? 0 : Math.max(playX, hoverX);
    for (let i = 0; i < bars; i++) {
      const x = i * (BAR + GAP);
      const center = x + BAR / 2;
      const top = Math.max(0.5, -(cols[i * 2] ?? 0) * scale);
      const bottom = Math.max(0.5, (cols[i * 2 + 1] ?? 0) * scale);
      if (center <= playX) {
        ctx.fillStyle = accent;
        ctx.globalAlpha = center >= previewFrom && center <= previewTo ? 0.55 : 1;
      } else {
        ctx.fillStyle = muted;
        ctx.globalAlpha = center >= previewFrom && center <= previewTo ? 0.75 : 0.4;
      }
      ctx.fillRect(x, mid - bottom, BAR, top + bottom);
    }
    ctx.globalAlpha = 1;
  }

  if (hoverX !== null) {
    ctx.fillStyle = muted;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(Math.round(hoverX) - 0.5, 0, 1, height);
    ctx.globalAlpha = 1;
  }
  if (duration > 0) {
    ctx.fillStyle = fg;
    ctx.fillRect(Math.min(width - 1.5, Math.max(0, playX - 0.75)), 0, 1.5, height);
  }
}
