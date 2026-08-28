// src/lib/writeCoalescer.js
//
// Coalesces a burst of changes to the same record into one durable write,
// without ever letting a change go unwritten.
//
// The Free-form editor reports a change on every keystroke; writing the whole
// note-content record on each one is the cost docs/PRODUCTION_READINESS_AUDIT.md
// P1-10 flagged. This holds the LATEST value per id and writes it:
//   - `delayMs` after the most recent change (trailing), or
//   - `maxWaitMs` after the FIRST unwritten change, whichever comes first — so
//     continuous typing still lands on disk at a bounded cadence, or
//   - immediately, when the caller flushes (leaving the note, unmounting,
//     the page being hidden or unloaded).
//
// The write itself is the caller's synchronous function and is expected to
// THROW when it cannot be trusted; every flush — timer-driven or explicit —
// reports the per-id outcome through `onFlush` (and returns it) so the caller
// can settle a save status honestly. Nothing is swallowed and
// nothing is retried here — the next change re-queues the id.
//
// Pure apart from the injectable timers, so the exact cadence is testable.

export const DEFAULT_COALESCE_DELAY_MS = 500;
export const DEFAULT_COALESCE_MAX_WAIT_MS = 2000;

export function createWriteCoalescer({
  write,
  onFlush = null,
  delayMs = DEFAULT_COALESCE_DELAY_MS,
  maxWaitMs = DEFAULT_COALESCE_MAX_WAIT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
} = {}) {
  if (typeof write !== "function") {
    throw new Error("A write function is required");
  }
  const pending = new Map(); // id -> latest value
  let timer = null;
  let firstPendingAt = null;
  let disposed = false;

  function disarm() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function arm() {
    disarm();
    if (pending.size === 0 || disposed) return;
    const elapsed = firstPendingAt === null ? 0 : now() - firstPendingAt;
    const remaining = Math.max(0, maxWaitMs - elapsed);
    const wait = Math.min(delayMs, remaining);
    timer = setTimer(() => {
      timer = null;
      flush();
    }, wait);
  }

  /** Records the latest value for `id` and (re)arms the timers. */
  function schedule(id, value) {
    if (disposed || !id) return;
    if (firstPendingAt === null) firstPendingAt = now();
    pending.set(id, value);
    const elapsed = now() - firstPendingAt;
    if (elapsed >= maxWaitMs) {
      flush();
      return;
    }
    arm();
  }

  /**
   * Writes the given ids (default: every pending id) NOW, synchronously.
   * Returns [{ id, ok, error }] for exactly the ids that were pending.
   */
  function flush(ids) {
    const targets = Array.isArray(ids) ? ids.filter((id) => pending.has(id)) : Array.from(pending.keys());
    const results = [];
    for (const id of targets) {
      const value = pending.get(id);
      pending.delete(id);
      try {
        write(id, value);
        results.push({ id, ok: true, error: null });
      } catch (error) {
        results.push({ id, ok: false, error });
      }
    }
    if (pending.size === 0) {
      firstPendingAt = null;
      disarm();
    } else if (timer === null) {
      arm();
    }
    if (results.length > 0 && typeof onFlush === "function") onFlush(results);
    return results;
  }

  /** Drops a pending change WITHOUT writing it (the record no longer exists). */
  function cancel(id) {
    if (!pending.has(id)) return false;
    pending.delete(id);
    if (pending.size === 0) {
      firstPendingAt = null;
      disarm();
    }
    return true;
  }

  function pendingIds() {
    return Array.from(pending.keys());
  }

  function hasPending(id) {
    return id === undefined ? pending.size > 0 : pending.has(id);
  }

  /** Stops the timers. Does NOT write — flush first if anything must land. */
  function dispose() {
    disposed = true;
    disarm();
    pending.clear();
    firstPendingAt = null;
  }

  return { schedule, flush, cancel, pendingIds, hasPending, dispose };
}
