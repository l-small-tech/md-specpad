/**
 * Which edges of a sideways strip have content clipped out of view — what
 * the worktree strip's fades and chevrons key on. Pure: the caller reads
 * `scrollLeft` / `clientWidth` / `scrollWidth` off the scroller.
 */

export type StripClip = 'none' | 'start' | 'end' | 'both';

/** Sub-pixel scroll positions make `scrollLeft + clientWidth` land a hair short. */
const SLACK_PX = 1;

export function stripClipState(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): StripClip {
  const start = scrollLeft > SLACK_PX;
  const end = scrollLeft + clientWidth < scrollWidth - SLACK_PX;
  if (start && end) {
    return 'both';
  }
  if (start) {
    return 'start';
  }
  return end ? 'end' : 'none';
}
