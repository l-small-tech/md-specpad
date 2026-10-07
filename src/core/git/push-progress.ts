/**
 * Push progress — git's `push --progress` stderr read as one number and one
 * plain sentence, for a progress bar aimed at people who do not know what
 * "Compressing objects" means. Pure; no DOM, no Tauri, no React.
 *
 * git reports a push in phases, each with its own 0–100%; this maps them onto
 * one bar by giving each phase a slice. The bar only moves forward: a line
 * from an earlier phase (a late redraw) never pulls it back.
 */

export interface PushProgress {
  /** 0–100, or null before git has said anything we can place (connecting). */
  percent: number | null;
  /** What is happening, in plain words. */
  step: string;
  /** git said "Everything up-to-date": there was nothing to send. */
  upToDate: boolean;
}

interface Phase {
  pattern: RegExp;
  from: number;
  to: number;
  step: string;
}

/** In the order git runs them. `from`/`to` are the phase's slice of the bar. */
const PHASES: readonly Phase[] = [
  { pattern: /^Enumerating objects:/, from: 2, to: 5, step: 'Getting your changes ready…' },
  { pattern: /^Counting objects:/, from: 5, to: 12, step: 'Getting your changes ready…' },
  { pattern: /^Compressing objects:/, from: 12, to: 25, step: 'Packing your changes…' },
  { pattern: /^Writing objects:/, from: 25, to: 88, step: 'Uploading…' },
  { pattern: /^Total \d+/, from: 88, to: 88, step: 'Waiting for the server…' },
  {
    pattern: /^remote: Resolving deltas:/,
    from: 88,
    to: 96,
    step: 'The server is saving your changes…',
  },
  { pattern: /^To \S/, from: 97, to: 97, step: 'Finishing up…' },
];

const PERCENT = /:\s*(\d{1,3})%/;

/** Read the streamed lines so far (oldest first). `done` pins the bar to 100. */
export function pushProgress(lines: readonly { text: string }[], done = false): PushProgress {
  let phase = -1;
  let fraction = 0;
  let upToDate = false;
  for (const { text } of lines) {
    const line = text.trim();
    if (/^Everything up-to-date/.test(line)) {
      upToDate = true;
      continue;
    }
    const i = PHASES.findIndex((p) => p.pattern.test(line));
    if (i < 0 || i < phase) {
      continue;
    }
    const m = PERCENT.exec(line);
    const f = m ? Math.min(100, Number(m[1])) / 100 : 0;
    fraction = i > phase ? f : Math.max(fraction, f);
    phase = i;
  }
  if (done) {
    return { percent: 100, step: upToDate ? 'Nothing new to push' : 'Done', upToDate };
  }
  const p = PHASES[phase];
  if (p === undefined) {
    return {
      percent: null,
      step: upToDate ? 'Nothing new to push' : 'Connecting to the server…',
      upToDate,
    };
  }
  return { percent: Math.round(p.from + (p.to - p.from) * fraction), step: p.step, upToDate };
}
