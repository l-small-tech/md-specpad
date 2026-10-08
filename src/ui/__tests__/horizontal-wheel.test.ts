import { describe, expect, test } from 'vitest';
import { horizontalWheelDelta, WHEEL_LINE_PX, type WheelLike } from '../horizontal-wheel';

const wheel = (over: Partial<WheelLike> = {}): WheelLike => ({
  deltaX: 0,
  deltaY: 100,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  ...over,
});

const box = { scrollLeft: 200, scrollWidth: 1000, clientWidth: 400 };

describe('horizontalWheelDelta', () => {
  test('a vertical notch moves the strip sideways by its pixels, down = right', () => {
    expect(horizontalWheelDelta(wheel(), box)).toBe(100);
    expect(horizontalWheelDelta(wheel({ deltaY: -100 }), box)).toBe(-100);
  });

  test('line and page wheels are converted to pixels', () => {
    expect(horizontalWheelDelta(wheel({ deltaMode: 1, deltaY: 3 }), box)).toBe(3 * WHEEL_LINE_PX);
    expect(horizontalWheelDelta(wheel({ deltaMode: 2, deltaY: 1 }), box)).toBe(400);
  });

  test('clamped to the ends; at an end, the event is left alone', () => {
    expect(horizontalWheelDelta(wheel({ deltaY: 1000 }), box)).toBe(400);
    expect(horizontalWheelDelta(wheel({ deltaY: -1000 }), box)).toBe(-200);
    expect(horizontalWheelDelta(wheel(), { ...box, scrollLeft: 600 })).toBeNull();
    expect(horizontalWheelDelta(wheel({ deltaY: -5 }), { ...box, scrollLeft: 0 })).toBeNull();
  });

  test('starts from a glide target in flight, so a fast spin is not cut short', () => {
    expect(horizontalWheelDelta(wheel(), box, 300)).toBe(100);
    expect(horizontalWheelDelta(wheel(), box, 550)).toBe(50);
    expect(horizontalWheelDelta(wheel(), box, 600)).toBeNull();
  });

  test('horizontal gestures, Shift, Ctrl and a strip with nothing clipped are left alone', () => {
    expect(horizontalWheelDelta(wheel({ deltaX: 120, deltaY: 30 }), box)).toBeNull();
    expect(horizontalWheelDelta(wheel({ deltaX: 50, deltaY: 50 }), box)).toBeNull();
    expect(horizontalWheelDelta(wheel({ shiftKey: true }), box)).toBeNull();
    expect(horizontalWheelDelta(wheel({ ctrlKey: true }), box)).toBeNull();
    expect(horizontalWheelDelta(wheel({ deltaY: 0 }), box)).toBeNull();
    expect(horizontalWheelDelta(wheel(), { ...box, scrollWidth: 400 })).toBeNull();
  });
});
