import { describe, expect, test } from 'vitest';
import { stripClipState } from '../strip-clip';

describe('stripClipState', () => {
  test('nothing clipped when the content fits', () => {
    expect(stripClipState(0, 800, 800)).toBe('none');
    expect(stripClipState(0, 800, 500)).toBe('none');
  });

  test('clipped at the end from the start position, at both ends mid-way, at the start when scrolled to the end', () => {
    expect(stripClipState(0, 800, 2000)).toBe('end');
    expect(stripClipState(600, 800, 2000)).toBe('both');
    expect(stripClipState(1200, 800, 2000)).toBe('start');
  });

  test('a sub-pixel remainder does not count as clipped', () => {
    expect(stripClipState(1199.5, 800, 2000)).toBe('start');
    expect(stripClipState(0.5, 800, 800)).toBe('none');
  });
});
