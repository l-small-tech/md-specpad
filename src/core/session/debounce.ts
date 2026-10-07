/**
 * The session flusher's debouncer. One instance exists app-wide; every
 * change that must survive a crash calls `request()`.
 *
 * Contract (pinned by __tests__/debounce.test.ts):
 * - Trailing-edge: a flush runs `idleMs` after the LAST request…
 * - …but never later than `maxWaitMs` after the FIRST unflushed request —
 *   continuous typing cannot starve persistence (this is the "lose at most
 *   ~5s on a crash" guarantee).
 * - In-flight coalescing: requests arriving while `run()` is executing are
 *   absorbed into exactly ONE follow-up run, scheduled after it finishes.
 * - `flushNow()` drains: when it resolves `true`, every request made before
 *   the call has been flushed. Used on window blur and close-requested (see
 *   src/README.md — the close path must flush WITHOUT prompting).
 * - A failed `run()` keeps the state dirty so the next request or timer
 *   retries; the error goes to `onError` (log + status bar, never a dialog).
 *   `flushNow()` makes at most ONE attempt of its own: when that fails it
 *   resolves `false` (never rejects, never spins) and leaves the retry to the
 *   timers — callers that hand data on (tear-off, a note move) must check it.
 *
 * Why not lodash.debounce: maxWait + async coalescing + drain semantics
 * together are exactly the part lodash doesn't give you, and this contract
 * is load-bearing for crash safety.
 */

export interface DebouncedFlusherOptions {
  idleMs: number;
  maxWaitMs: number;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface DebouncedFlusher {
  /** Mark state dirty and (re)arm the timers. Cheap; call on every change. */
  request(): void;
  /** Drain: resolves `true` once everything requested before this call is
   *  flushed, or `false` as soon as its own attempt fails (work stays pending). */
  flushNow(): Promise<boolean>;
  isIdle(): boolean;
  /** Cancel timers and wait out any in-flight run. Does NOT flush pending
   *  work — call `flushNow()` first when shutting down cleanly. */
  dispose(): Promise<void>;
}

export function createDebouncedFlusher(options: DebouncedFlusherOptions): DebouncedFlusher {
  let dirty = false;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  /** The running flush; resolves to whether it succeeded (never rejects). */
  let inflight: Promise<boolean> | null = null;

  function clearTimers() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (maxTimer !== null) {
      clearTimeout(maxTimer);
      maxTimer = null;
    }
  }

  async function runOnce(): Promise<boolean> {
    dirty = false;
    try {
      await options.run();
      return true;
    } catch (error) {
      dirty = true; // failed writes stay pending; the next timer/request retries
      options.onError?.(error);
      return false;
    }
  }

  function fire() {
    clearTimers();
    if (!dirty || inflight !== null || disposed) {
      return;
    }
    inflight = runOnce().finally(() => {
      inflight = null;
      if (dirty && !disposed) {
        // Coalesced follow-up for requests that arrived mid-run.
        schedule();
      }
    });
  }

  function schedule() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(fire, options.idleMs);
    if (maxTimer === null) {
      // Armed on the FIRST unflushed request only; never pushed back.
      maxTimer = setTimeout(fire, options.maxWaitMs);
    }
  }

  return {
    request() {
      if (disposed) {
        return;
      }
      dirty = true;
      schedule();
    },

    async flushNow() {
      clearTimers();
      while (!disposed && (inflight !== null || dirty)) {
        // Waiting out a run already in flight costs nothing; firing is ours.
        const own = inflight === null;
        if (own) {
          fire();
        }
        const ok = await (inflight ?? Promise.resolve(true));
        if (!ok && own) {
          // Our own attempt failed: report it instead of retrying in a hot
          // loop. The failed run re-armed the timers, so the normal debounced
          // retry still happens.
          return false;
        }
      }
      return !dirty;
    },

    isIdle: () => !dirty && inflight === null,

    async dispose() {
      disposed = true;
      clearTimers();
      if (inflight !== null) {
        await inflight;
      }
    },
  };
}
