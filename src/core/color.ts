/**
 * Color math for theming — pure, no DOM.
 *
 * Two representations meet here. Theme *files* hold CSS hex strings (that is
 * what a human edits and what md-specpad's format already uses), while the
 * renderer wants 0xRRGGBB numbers (`src/renderer/theme.ts`). Everything in this
 * file works on the numbers; the string form is only the door in and out.
 *
 * The interesting function is `ensureContrast`: a theme that ships no `terminal`
 * block gets its ANSI palette derived from ten UI colors, and a derived color
 * that lands too close to the background would make some TUI unreadable. Rather
 * than hope, we measure — WCAG relative luminance — and step the color away
 * from the background until it clears a ratio.
 */

/** `#rgb` or `#rrggbb` → 0xRRGGBB. Anything else (a `color-mix()`) → null. */
export function parseColor(value: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1]!;
  if (hex.length === 3) {
    const [r, g, b] = hex;
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  return Number.parseInt(hex, 16);
}

/** 0xRRGGBB → `#rrggbb`. */
export function formatColor(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

function channel(rgb: number, shift: number): number {
  return (rgb >> shift) & 0xff;
}

/** Linear blend: `t` = 0 gives `a`, 1 gives `b`. */
export function mix(a: number, b: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const part = (shift: number) => {
    const from = channel(a, shift);
    const to = channel(b, shift);
    return Math.round(from + (to - from) * clamped) & 0xff;
  };
  return (part(16) << 16) | (part(8) << 8) | part(0);
}

const WHITE = 0xffffff;
const BLACK = 0x000000;

/** Toward white for positive `amount`, toward black for negative. */
export function adjust(rgb: number, amount: number): number {
  return amount >= 0 ? mix(rgb, WHITE, amount) : mix(rgb, BLACK, -amount);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: number): number {
  const part = (shift: number) => {
    const value = channel(rgb, shift) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * part(16) + 0.7152 * part(8) + 0.0722 * part(0);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: number, b: number): number {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
}

/** Is this a color you would put light text on? */
export function isDarkColor(rgb: number): boolean {
  return luminance(rgb) < 0.35;
}

const STEP = 0.05;
const MAX_STEPS = 20;

/**
 * `color`, moved away from `background` until it clears `min` contrast.
 *
 * The direction is decided by the background, not the color: on a dark surface
 * every ANSI color gets lighter, on a light one darker. That is also why the
 * loop can give up — it walks to pure white or pure black in `MAX_STEPS` and
 * returns the best it managed, which is the most contrast that exists.
 */
export function ensureContrast(color: number, background: number, min = 3): number {
  if (contrastRatio(color, background) >= min) return color;
  const direction = isDarkColor(background) ? 1 : -1;
  let candidate = color;
  for (let step = 1; step <= MAX_STEPS; step++) {
    candidate = adjust(color, direction * STEP * step);
    if (contrastRatio(candidate, background) >= min) return candidate;
  }
  return candidate;
}
