import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDebouncedFlusher } from '../session/debounce';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createDebouncedFlusher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const IDLE = 1000;
  const MAX_WAIT = 5000;

  test('flushes once after idleMs of quiet', async () => {
    const run = vi.fn(async () => {});
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });

    flusher.request();
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledOnce();
    expect(flusher.isIdle()).toBe(true);
  });

  test('continuous typing cannot starve persistence past maxWaitMs', async () => {
    const run = vi.fn(async () => {});
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });

    // A request every 500ms keeps resetting the idle timer forever…
    for (let elapsed = 0; elapsed < MAX_WAIT; elapsed += 500) {
      flusher.request();
      await vi.advanceTimersByTimeAsync(500);
    }
    // …but the max-wait timer fired at the 5s mark regardless.
    expect(run).toHaveBeenCalledOnce();
  });

  test('requests during an in-flight run coalesce into exactly one follow-up', async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });

    flusher.request();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(run).toHaveBeenCalledOnce();

    flusher.request(); // three requests while the first run hangs
    flusher.request();
    flusher.request();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('flushNow drains pending work immediately', async () => {
    const run = vi.fn(async () => {});
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });

    flusher.request();
    await flusher.flushNow();
    expect(run).toHaveBeenCalledOnce();

    // The cancelled timers must not fire a second run later.
    await vi.advanceTimersByTimeAsync(MAX_WAIT * 2);
    expect(run).toHaveBeenCalledOnce();
  });

  test('flushNow on an idle flusher does nothing', async () => {
    const run = vi.fn(async () => {});
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });
    await flusher.flushNow();
    expect(run).not.toHaveBeenCalled();
  });

  test('flushNow waits out an in-flight run, then flushes what arrived meanwhile', async () => {
    const gate = deferred();
    let calls = 0;
    const run = vi.fn(() => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve();
    });
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });

    flusher.request();
    await vi.advanceTimersByTimeAsync(IDLE); // run #1 hangs on the gate
    flusher.request(); // dirty again mid-flight

    const drained = flusher.flushNow();
    gate.resolve();
    await drained;
    expect(run).toHaveBeenCalledTimes(2);
    expect(flusher.isIdle()).toBe(true);
  });

  test('a failed run keeps state dirty and retries on the next cycle', async () => {
    const onError = vi.fn();
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run, onError });

    flusher.request();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(run).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(flusher.isIdle()).toBe(false); // still dirty

    flusher.request(); // next activity retries
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(run).toHaveBeenCalledTimes(2);
    expect(flusher.isIdle()).toBe(true);
  });

  test('flushNow resolves true once drained', async () => {
    const run = vi.fn(async () => {});
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });
    flusher.request();
    await expect(flusher.flushNow()).resolves.toBe(true);
    await expect(flusher.flushNow()).resolves.toBe(true); // idle: nothing to do
  });

  test('flushNow on a persistently failing run makes ONE attempt and resolves false', async () => {
    const onError = vi.fn();
    // Fails "forever" — bounded at 100 only so a regression to the old hot
    // retry loop fails this test instead of hanging the runner.
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls <= 100) {
        throw new Error('disk full');
      }
    });
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run, onError });

    flusher.request();
    await expect(flusher.flushNow()).resolves.toBe(false);
    expect(run).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(flusher.isIdle()).toBe(false); // the work is still pending

    // …and the normal debounced retry still re-attempts on its own.
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('flushNow retries once itself when the in-flight run it waited on failed', async () => {
    const gate = deferred();
    let calls = 0;
    const run = vi.fn(() => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve();
    });
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });

    flusher.request();
    await vi.advanceTimersByTimeAsync(IDLE); // run #1 in flight
    const drained = flusher.flushNow();
    gate.reject(new Error('transient'));
    await expect(drained).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(flusher.isIdle()).toBe(true);
  });

  test('dispose cancels timers and ignores later requests', async () => {
    const run = vi.fn(async () => {});
    const flusher = createDebouncedFlusher({ idleMs: IDLE, maxWaitMs: MAX_WAIT, run });

    flusher.request();
    await flusher.dispose();
    flusher.request();
    await vi.advanceTimersByTimeAsync(MAX_WAIT * 2);
    expect(run).not.toHaveBeenCalled();
  });
});
