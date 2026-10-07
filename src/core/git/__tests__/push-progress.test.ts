import { describe, expect, test } from 'vitest';
import { pushProgress } from '../push-progress';

const L = (...texts: string[]) => texts.map((text) => ({ text }));

describe('pushProgress', () => {
  test('nothing yet is indeterminate: connecting', () => {
    expect(pushProgress([])).toEqual({
      percent: null,
      step: 'Connecting to the server…',
      upToDate: false,
    });
  });

  test('each phase lands inside its slice and the bar moves forward', () => {
    const seen = [
      'Enumerating objects: 7, done.',
      'Counting objects:  42% (3/7)',
      'Counting objects: 100% (7/7), done.',
      'Delta compression using up to 16 threads',
      'Compressing objects:  50% (2/4)',
      'Writing objects:   0% (0/4)',
      'Writing objects:  50% (2/4), 1.20 MiB | 2.10 MiB/s',
      'Writing objects: 100% (4/4), 2.40 MiB | 2.10 MiB/s, done.',
      'Total 4 (delta 2), reused 0 (delta 0), pack-reused 0',
      'remote: Resolving deltas: 100% (2/2), completed with 2 local objects.',
      'To https://github.com/acme/repo.git',
      '   abc1234..def5678  main -> main',
    ];
    let last = -1;
    for (let n = 1; n <= seen.length; n += 1) {
      const p = pushProgress(L(...seen.slice(0, n)));
      expect(p.percent).not.toBeNull();
      expect(p.percent!).toBeGreaterThanOrEqual(last);
      last = p.percent!;
    }
    expect(pushProgress(L(...seen.slice(0, 7)))).toMatchObject({ percent: 57, step: 'Uploading…' });
    expect(last).toBeLessThan(100);
  });

  test('a late redraw from an earlier phase never pulls the bar back', () => {
    const p = pushProgress(L('Writing objects:  80% (4/5)', 'Counting objects:  10% (1/10)'));
    expect(p.step).toBe('Uploading…');
    expect(p.percent).toBe(75);
  });

  test('done pins 100; "Everything up-to-date" says nothing was sent', () => {
    expect(pushProgress(L('Writing objects: 40% (2/5)'), true).percent).toBe(100);
    const up = pushProgress(L('Everything up-to-date'), true);
    expect(up).toEqual({ percent: 100, step: 'Nothing new to push', upToDate: true });
  });
});
