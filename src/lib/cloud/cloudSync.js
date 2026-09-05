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
//
// ASYNC PAYLOADS (Production Readiness Phase 7.7). An entity whose local
// copy is NOT in the workspace mirror — pdfAnnotations, kept in IndexedDB —
// registers a PAYLOAD PROVIDER for its collection:
//   load(workspaceId, id)      → Promise<{ payload, token } | undefined>
//                                 undefined = nothing to write (the record is
//                                 gone); a rejection = the local record could
//                                 not be read → that ONE entity fails with the
//                                 rejection's `code` (or "local-payload-
//                                 unreadable"), stays queued, and the rest of
//                                 the flush proceeds untouched
//   settle(workspaceId, id, token) → called after Firestore ACCEPTED the write
//                                 that carried `token`, so the owner can clear
//                                 its own durable "owed" marker — and only if
//                                 its record still IS that token (a newer
//                                 local save keeps its marker and its newer
//                                 outbox stamp)
// Every collection without a provider is read from the mirror synchronously,
// exactly as before; the outbox, the batching and the settle stamps are the
// same for both.

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
  "local-payload-unreadable": "A record on this device could not be read for upload. It stays on this device; the next change will retry.",
  "local-payload-malformed": "A record on this device is not in a form that can be uploaded. It stays on this device.",
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
 *   payloadProviders?: { [collection]: { load: Function, settle: Function } },
 * }} options
 */
export function createCloudSync({
  workspaceId,
  store,
  storage,
  payloadProviders = {},
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

  function providerFor(entry) {
    if (entry.op === OUTBOX_OP.DELETE) return null;
    const provider = payloadProviders && payloadProviders[entry.collection];
    return provider && typeof provider.load === "function" ? provider : null;
  }

  /**
   * Resolves the payload of every live entry: provider-backed ones are read
   * asynchronously, one at a time, and a failed read is turned into that
   * entry's own FAILED result — never into a batch that carries an undefined
   * document. Everything else is planned from the mirror as before.
   */
  async function prepareEntries(entries, results) {
    const prepared = [];
    const failures = [];
    for (const entry of entries) {
      const provider = providerFor(entry);
      if (!provider) {
        prepared.push({ entry, provided: false, loaded: undefined });
        continue;
      }
      try {
        const loaded = await provider.load(workspaceId, entry.id);
        prepared.push({ entry, provided: true, loaded: loaded === undefined || loaded === null ? undefined : loaded });
      } catch (error) {
        const code = error && typeof error.code === "string" && error.code ? error.code : "local-payload-unreadable";
        failures.push(code);
        results.push({ collection: entry.collection, id: entry.id, outcome: SYNC_OUTCOME.FAILED, code });
      }
    }
    return { prepared, failures };
  }

  function opsFor(entry, { provided = false, loaded = undefined } = {}) {
    const base = [entry.collection, entry.id];
    if (entry.op === OUTBOX_OP.DELETE) {
      const ops = [{ type: "delete", path: base, units: 0 }];
      for (let i = 0; i < entry.chunks; i++) ops.push({ type: "delete", path: [...base, "chunks", String(i)], units: 0 });
      return ops;
    }
    const payload = provided ? (loaded ? loaded.payload : undefined) : payloadFor(entry);
    if (payload === undefined) {
      // Removed from the mirror (or the provider's store) since it was
      // queued — a later delete replaced this entry, or the record was
      // reset: nothing to write.
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

  /** Groups prepared entries into batches that respect the op and size caps.
   *  Every entry's ops stay together in one batch. A provider-backed entry
   *  remembers the token it was planned with, for its settle. */
  function planBatches(prepared) {
    const batches = [];
    let current = { entries: [], ops: [], units: 0 };
    const push = () => {
      if (current.entries.length > 0) batches.push(current);
      current = { entries: [], ops: [], units: 0 };
    };
    for (const item of prepared) {
      const entry = item.entry;
      const ops = opsFor(entry, item);
      if (ops === null) {
        current.entries.push({ ...entry, skipped: true });
        continue;
      }
      const units = ops.reduce((n, op) => n + op.units, 0);
      if (current.ops.length > 0 && (current.ops.length + ops.length > MAX_BATCH_OPS || current.units + units > MAX_BATCH_UNITS)) {
        push();
      }
      current.entries.push(item.provided ? { ...entry, provided: true, token: item.loaded ? item.loaded.token : undefined } : entry);
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
    const { prepared, failures: providerFailures } = await prepareEntries(live, results);
    let failure = null;
    for (const batch of planBatches(prepared)) {
      const written = batch.entries.filter((e) => !e.skipped);
      const skipped = batch.entries.filter((e) => e.skipped);
      try {
        if (batch.ops.length > 0) {
          await withTimeout(store.commitBatch(workspaceId, batch.ops), commitTimeoutMs, setTimer, clearTimer);
        }
        settleOutbox(workspaceId, [...written, ...skipped], storage);
        for (const entry of written) results.push({ collection: entry.collection, id: entry.id, outcome: SYNC_OUTCOME.SYNCED, code: null });
        // The owners of provider-backed records learn that THIS token landed.
        // A refused settle leaves the owner's marker set; the next session
        // start re-derives the obligation from it (idempotent sets).
        for (const entry of written) {
          if (!entry.provided || entry.token === undefined) continue;
          const provider = payloadProviders[entry.collection];
          if (!provider || typeof provider.settle !== "function") continue;
          try {
            await provider.settle(workspaceId, entry.id, entry.token);
          } catch {
            // see above
          }
        }
      } catch (error) {
        const classified = classifySyncError(error);
        failure = { ...classified, error };
        for (const entry of written) results.push({ collection: entry.collection, id: entry.id, outcome: classified.outcome, code: classified.code });
        // Later batches are left queued untouched; they are re-planned on retry.
        break;
      }
    }

    if (!failure && providerFailures.length > 0) {
      // Every batch that could be built landed; the entries whose local
      // payload could not be read stay queued and are retried on the next
      // change or an explicit retry — like any other "failed" outcome.
      firstPendingAt = null;
      retryAttempt = 0;
      setStatus(SYNC_STATUS.ERROR, providerFailures[0]);
    } else if (!failure) {
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
