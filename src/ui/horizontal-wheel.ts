/**
 * A vertical mouse wheel over a sideways-only strip scrolls it sideways.
 *
 * The webview does not do this on its own: a wheel's vertical delta goes to
 * the nearest ancestor that scrolls VERTICALLY, so over a row that only
 * overflows horizontally (the git tab's worktree cards) a plain wheel does
 * nothing and only Shift+wheel or the scrollbar move it.
 *
 * Smooth scrolling stays the ENGINE's (src/ui/README.md, "Smooth scrolling"):
 * a ratcheted wheel's notch becomes one native `scrollTo({behavior:
 * 'smooth'})` toward an accumulated target — a fast spin keeps extending the
 * same glide rather than restarting it a notch short — and a touchpad's
 * vertical stream (`WheelSourceTracker`, core/smooth-scroll.ts) is applied
 * 1:1, since the OS has already put its inertia in it. A gesture that is
 * mostly horizontal (a trackpad swipe, a tilt wheel), Shift+wheel and
 * Ctrl+wheel (zoom) are left to the engine untouched, and so is a wheel the
 * strip cannot follow (nothing clipped, or already at that end) — the page
 * gets it as before.
 */

import { WheelSourceTracker } from '../core/smooth-scroll';

/** Pixels per line for a line-mode (`deltaMode` 1) wheel. */
export const WHEEL_LINE_PX = 40;

/** The parts of a wheel event the rule reads. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
}

/** The parts of the scroller the rule reads. */
export interface HScrollBox {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * How far (px, + = right) a wheel event should move a sideways strip, or
 * null to leave the event alone. `from` is where the motion starts: the
 * glide's pending target when one is in flight, else `scrollLeft`.
 */
export function horizontalWheelDelta(
  e: WheelLike,
  box: HScrollBox,
  from = box.scrollLeft,
): number | null {
  if (e.shiftKey || e.ctrlKey || e.deltaY === 0 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) {
    return null;
  }
  const max = box.scrollWidth - box.clientWidth;
  if (max <= 0) {
    return null;
  }
  const px =
    e.deltaMode === 1
      ? e.deltaY * WHEEL_LINE_PX
      : e.deltaMode === 2
        ? e.deltaY * box.clientWidth
        : e.deltaY;
  const next = Math.min(max, Math.max(0, from + px));
  return next === from ? null : next - from;
}

/** How long after the last notch a glide's target is forgotten (no `scrollend`). */
const TARGET_TTL_MS = 450;

/**
 * Wire the rule onto `el`. `smooth()` is read per event (the app's Smooth
 * scrolling setting). Returns the detach function.
 */
export function installHorizontalWheel(el: HTMLElement, smooth: () => boolean): () => void {
  const tracker = new WheelSourceTracker();
  let target: number | null = null;
  let forget: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    target = null;
  };
  const onWheel = (e: WheelEvent) => {
    const kind = tracker.classify(e.deltaY, e.deltaMode, e.timeStamp);
    const glide = kind === 'notch' && smooth();
    const from = glide && target !== null ? target : el.scrollLeft;
    const delta = horizontalWheelDelta(e, el, from);
    if (delta === null) {
      return;
    }
    e.preventDefault();
    if (!glide) {
      target = null;
      el.scrollLeft = from + delta;
      return;
    }
    target = from + delta;
    el.scrollTo({ left: target, behavior: 'smooth' });
    clearTimeout(forget);
    forget = setTimeout(reset, TARGET_TTL_MS);
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('scrollend', reset);
  return () => {
    clearTimeout(forget);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('scrollend', reset);
  };
}
