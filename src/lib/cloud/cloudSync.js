// src/lib/cloud/cloudSync.js
//
// The SYNC ENGINE of one workspace: drains the outbox into Firestore in
// coalesced batches and reports, per entity, what actually happened.
//
// Cadence. Captured changes arrive from the owner modules already coalesced
// by the Free-form write coalescer (500 ms / 2 s); this engine adds its own
// trailing delay and maximum wait so continuous editing produces ONE batch
// every few seconds rather than a Firestore write per local write — the
// per-document sustained write rate is about one per second, and a note is
// one document. A flush never drops a change: an entry stays in the outbox
// until Firestore has accepted it.
//
// Outcomes. Every flush emits `{ type: "outcome", results }` with one
//   { collection, id, outcome: "synced" | "queued" | "failed", code }
// per entity it touched, and `{ type: "status", status, pending }` where
// status is "idle" | "syncing" | "offline" | "error". The autosave status in
// the UI settles on THESE (src/components/MainArea.js), never on the local
// write: "Saved" means Firestore accepted it.
//
// Failure model.
//   offline / unavailable / timeout   → "queued": the entry stays, the
//                                        engine retries with backoff and on
//                                        the browser's `online` event
//   permission-denied / unauthenticated / invalid-argument /
//   failed-precondition / resource-exhausted
//                                     → "failed": the entry stays (a retry
//                                        may succeed after the cause is
//                                        fixed) and the user is told; the
//                                        engine retries only on the next
//                                        change or an explicit retry
//   an entity the hydration found MALFORMED in the cloud
//                                     → "failed" without a write: the cloud
//                                        record is never overwritten with a
//                                        locally derived value
//
// Deletes and upserts from one local operation travel in the same batch
// wherever the size limits allow, so a note deletion (node + content +
// instance + refs) lands atomically or not at all.

import { readDurableRecord } from "../durableStorage";
import { DURABLE_KEY_BY_COLLECTION, subscribeCapturedChanges } from "./cloudCapture";
import { buildEntityDocument, entitiesOfRecord } from "./cloudModel";
import { OUTBOX_OP, listOutboxEntries, outboxEntryKey, readOutbox, settleOutbox } from "./cloudOutbox";

export const SYNC_STATUS = Object.freeze({
  IDLE: "idle",
  SYNCING: "syncing",
  OFFLINE: "offline",
  ERROR: "error",
});

export const SYNC_OUTCOME = Object.freeze({
  SYNCED: "synced",
  QUEUED: "queued",
  FAILED: "failed",
});

export const DEFAULT_SYNC_DELAY_MS = 1500;
export const DEFAULT_SYNC_MAX_WAIT_MS = 6000;
export const DEFAULT_COMMIT_TIMEOUT_MS = 20000;
export const MAX_BATCH_OPS = 400;
export const MAX_BATCH_UNITS = 3000000; // ≈ 3 M UTF-16 units per commit, well under the 10 MiB request cap
const RETRY_BACKOFF_MS = [2000, 5000, 10000, 20000, 40000, 60000];

// Firestore error codes that mean "not now" rather than "not ever".
const TRANSIENT_CODES = new Set(["unavailable", "deadline-exceeded", "aborted", "cancelled", "internal", "timeout", "network"]);

export function classifySyncError(error) {
  const code = error && typeof error.code === "string" ? error.code.replace(/^firestore\//, "") : "";
  if (TRANSIENT_CODES.has(code)) return { outcome: SYNC_OUTCOME.QUEUED, code: code || "unavailable" };
  if (error && error.name === "TypeError" && !code) return { outcome: SYNC_OUTCOME.QUEUED, code: "network" };
  return { outcome: SYNC_OUTCOME.FAILED, code: code || "unknown" };
}

export const SYNC_FAILURE_MESSAGE = Object.freeze({
  "permission-denied": "Your account is not allowed to write to this workspace. Sign out and back in; if it persists, contact support.",
  unauthenticated: "Your session could not be verified. Sign out and back in.",
  "resource-exhausted": "The cloud storage quota is exhausted right now. Your changes stay on this device and will be retried.",
  "invalid-argument": "A record could not be stored in the cloud in its current form. Your change stays on this device.",
  "malformed-cloud-record": "This record is unreadable in the cloud and was not overwritten. Your change stays on this device.",
  unknown: "Your latest changes could not be saved to your account. They stay on this device and will be retried.",
});

export function syncFailureMessage(code) {
  return SYNC_FAILURE_MESSAGE[code] || SYNC_FAILURE_MESSAGE.unknown;
}

function withTimeout(promise, ms, setTimer, clearTimer) {
  if (!ms) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => reject(Object.assign(new Error("commit timed out"), { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimer(timer);
  });
}

/**
 * @param {{
 *   workspaceId: string,
 *   store: { commitBatch: (workspaceId: string, ops: object[]) => Promise<void> },
 *   storage?: Storage,
 *   isOnline?: () => boolean,
 *   delayMs?: number, maxWaitMs?: number, commitTimeoutMs?: number,
 *   setTimer?: Function, clearTimer?: Function, now?: () => number,
 *   addOnlineListener?: (fn: Function) => (() => void),
 * }} options
 */
export function createCloudSync({
  workspaceId,
  store,
  storage,
  isOnline = () => (typeof navigator === "undefined" || navigator.onLine !== false),
  delayMs = DEFAULT_SYNC_DELAY_MS,
  maxWaitMs = DEFAULT_SYNC_MAX_WAIT_MS,
  commitTimeoutMs = DEFAULT_COMMIT_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
  addOnlineListener = (fn) => {
    if (typeof window === "undefined" || !window.addEventListener) return () => {};
    window.addEventListener("online", fn);
    return () => window.removeEventListener("online", fn);
  },
} = {}) {
  if (!workspaceId || !store) throw new Error("A workspace id and a store are required");

  const listeners = new Set();
  const scope = Object.freeze({ kind: "workspace", id: workspaceId });
  // "collection/id" keys the hydration found malformed in the cloud.
  const quarantined = new Set();
  let status = SYNC_STATUS.IDLE;
  let lastError = null;
  let timer = null;
  let firstPendingAt = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let flushing = null; // the in-flight flush promise
  let flushAgain = false;
  let stopped = false;
  let unsubscribeCapture = null;
  let removeOnline = null;

  function emit(event) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch {
        // a listener must never break the engine
      }
    }
  }

  function pendingCount() {
    return Object.keys(readOutbox(workspaceId, storage).entries).length;
  }

  function setStatus(next, error = null) {
    status = next;
    lastError = error;
    emit({ type: "status", status, pending: pendingCount(), error });
  }

  function disarm() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }
  function disarmRetry() {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  function arm() {
    disarm();
    if (stopped) return;
    const elapsed = firstPendingAt === null ? 0 : now() - firstPendingAt;
    const wait = Math.max(0, Math.min(delayMs, maxWaitMs - elapsed));
    timer = setTimer(() => {
      timer = null;
      flush();
    }, wait);
  }

  /** A change was captured (or the outbox is known to be non-empty). */
  function scheduleFlush() {
    if (stopped) return;
    if (firstPendingAt === null) firstPendingAt = now();
    retryAttempt = 0;
    disarmRetry();
    arm();
  }

  function scheduleRetry() {
    if (stopped) return;
    disarmRetry();
    const wait = RETRY_BACKOFF_MS[Math.min(retryAttempt, RETRY_BACKOFF_MS.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      flush();
    }, wait);
  }

  // ---- building a flush -------------------------------------------------

  function payloadFor(entry) {
    const key = DURABLE_KEY_BY_COLLECTION[entry.collection];
    if (!key) return undefined;
    const record = readDurableRecord(key, { storage, scope }).value;
    const entities = entitiesOfRecord(entry.collection, record) || {};
    return entities[entry.id];
  }

  function opsFor(entry) {
    const base = [entry.collection, entry.id];
    if (entry.op === OUTBOX_OP.DELETE) {
      const ops = [{ type: "delete", path: base, units: 0 }];
      for (let i = 0; i < entry.chunks; i++) ops.push({ type: "delete", path: [...base, "chunks", String(i)], units: 0 });
      return ops;
    }
    const payload = payloadFor(entry);
    if (payload === undefined) {
      // Removed from the mirror since it was queued (a later delete replaced
      // this entry, or the record was reset): nothing to write.
      return null;
    }
    const built = buildEntityDocument({ workspaceId, collection: entry.collection, id: entry.id, payload });
    const ops = [{ type: "set", path: base, fields: built.fields, units: JSON.stringify(built.fields).length }];
    built.chunks.forEach((textChunk, i) => {
      ops.push({
        type: "set",
        path: [...base, "chunks", String(i)],
        fields: { workspaceId, id: entry.id, kind: entry.collection, index: i, text: textChunk },
        units: textChunk.length,
      });
    });
    return ops;
  }

  /** Groups entries into batches that respect the op and size caps. Every
   *  entry's ops stay together in one batch. */
  function planBatches(entries) {
    const batches = [];
    let current = { entries: [], ops: [], units: 0 };
    const push = () => {
      if (current.entries.length > 0) batches.push(current);
      current = { entries: [], ops: [], units: 0 };
    };
    for (const entry of entries) {
      const ops = opsFor(entry);
      if (ops === null) {
        current.entries.push({ ...entry, skipped: true });
        continue;
      }
      const units = ops.reduce((n, op) => n + op.units, 0);
      if (current.ops.length > 0 && (current.ops.length + ops.length > MAX_BATCH_OPS || current.units + units > MAX_BATCH_UNITS)) {
        push();
      }
      current.entries.push(entry);
      current.ops.push(...ops.map(({ units: _u, ...op }) => op));
      current.units += units;
    }
    push();
    return batches;
  }

  // ---- the flush --------------------------------------------------------

  async function runFlush() {
    const entries = listOutboxEntries(workspaceId, storage);
    if (entries.length === 0) {
      firstPendingAt = null;
      if (status !== SYNC_STATUS.IDLE) setStatus(SYNC_STATUS.IDLE);
      return { ok: true, results: [] };
    }

    const results = [];
    const live = [];
    for (const entry of entries) {
      if (quarantined.has(outboxEntryKey(entry.collection, entry.id)) && entry.op !== OUTBOX_OP.DELETE) {
        results.push({ collection: entry.collection, id: entry.id, outcome: SYNC_OUTCOME.FAILED, code: "malformed-cloud-record" });
      } else {
        live.push(entry);
      }
    }

    if (!isOnline()) {
      for (const entry of live) results.push({ collection: entry.collection, id: entry.id, outcome: SYNC_OUTCOME.QUEUED, code: "offline" });
      setStatus(SYNC_STATUS.OFFLINE);
      emit({ type: "outcome", results });
      scheduleRetry();
      return { ok: false, results };
    }

    setStatus(SYNC_STATUS.SYNCING);
    let failure = null;
    for (const batch of planBatches(live)) {
      const written = batch.entries.filter((e) => !e.skipped);
      const skipped = batch.entries.filter((e) => e.skipped);
      try {
        if (batch.ops.length > 0) {
          await withTimeout(store.commitBatch(workspaceId, batch.ops), commitTimeoutMs, setTimer, clearTimer);
        }
        settleOutbox(workspaceId, [...written, ...skipped], storage);
        for (const entry of written) results.push({ collection: entry.collection, id: entry.id, outcome: SYNC_OUTCOME.SYNCED, code: null });
      } catch (error) {
        const classified = classifySyncError(error);
        failure = { ...classified, error };
        for (const entry of written) results.push({ collection: entry.collection, id: entry.id, outcome: classified.outcome, code: classified.code });
        // Later batches are left queued untouched; they are re-planned on retry.
        break;
      }
    }

    if (!failure) {
      firstPendingAt = null;
      retryAttempt = 0;
      setStatus(pendingCount() === 0 ? SYNC_STATUS.IDLE : SYNC_STATUS.SYNCING);
    } else if (failure.outcome === SYNC_OUTCOME.QUEUED) {
      setStatus(SYNC_STATUS.OFFLINE, failure.code);
      scheduleRetry();
    } else {
      setStatus(SYNC_STATUS.ERROR, failure.code);
    }
    emit({ type: "outcome", results });
    return { ok: !failure, results, error: failure ? failure.error : null };
  }

  /** Flushes now. Concurrent calls share one flush; a call during a flush
   *  schedules another right after it. */
  function flush() {
    disarm();
    if (stopped) return Promise.resolve({ ok: false, results: [] });
    if (flushing) {
      flushAgain = true;
      return flushing;
    }
    flushing = runFlush()
      .catch((error) => ({ ok: false, results: [], error }))
      .finally(() => {
        flushing = null;
        if (flushAgain) {
          flushAgain = false;
          if (pendingCount() > 0) flush();
        } else if (pendingCount() > 0 && status === SYNC_STATUS.SYNCING) {
          // Something remained after a successful batch (re-queued mid-flight).
          scheduleFlush();
        }
      });
    return flushing;
  }

  function start() {
    if (stopped) throw new Error("A stopped sync cannot be restarted");
    unsubscribeCapture = subscribeCapturedChanges((event) => {
      if (event.workspaceId === workspaceId) scheduleFlush();
    });
    removeOnline = addOnlineListener(() => {
      if (pendingCount() > 0) {
        retryAttempt = 0;
        flush();
      }
    });
    if (pendingCount() > 0) scheduleFlush();
    else setStatus(SYNC_STATUS.IDLE);
    return api;
  }

  function stop() {
    stopped = true;
    disarm();
    disarmRetry();
    if (unsubscribeCapture) unsubscribeCapture();
    if (removeOnline) removeOnline();
    listeners.clear();
  }

  const api = Object.freeze({
    workspaceId,
    start,
    stop,
    flush,
    /** An explicit retry after a reported failure. */
    retry: () => {
      retryAttempt = 0;
      return flush();
    },
    scheduleFlush,
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getStatus: () => ({ status, pending: pendingCount(), error: lastError }),
    hasPending: (collection, id) => outboxEntryKey(collection, id) in readOutbox(workspaceId, storage).entries,
    markQuarantined(collection, id) {
      quarantined.add(outboxEntryKey(collection, id));
    },
    isQuarantined: (collection, id) => quarantined.has(outboxEntryKey(collection, id)),
  });
  return api;
}
