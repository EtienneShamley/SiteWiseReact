// src/lib/assetGcLedger.js
//
// WHEN this browser first observed one of a workspace's cloud assets to be
// unreferenced — and what the last garbage-collection mark pass did
// (Production Readiness Phase 7.9A).
//
// WHY IT IS LOCAL. The approved lifecycle gives a newly unreferenced asset a
// 48-hour grace period before it may be tombstoned. The cloud document has no
// field for "unreferenced since" and adding one would mean a schema bump and a
// Security Rules change to widen the mutable-field set. It is not worth it:
// the grace period is a SAFETY DELAY, not a correctness invariant, and every
// way of losing this ledger — a new device, cleared browser storage, a browser
// that has never swept — delays a deletion rather than hastening one. The
// clock that governs the DESTRUCTIVE step is the cloud document's own server
// `tombstonedAt`, which no client can back-date or refresh
// (src/lib/cloud/assetCloudModel.js, `firestore.rules`).
//
// THE OBSERVATION INVARIANT, which is the whole point of the store:
//
//   an asset that is UNREFERENCED and whose CURRENT cloud document says
//   `stored` is a garbage-collection candidate, and its observation is
//   CREATED once and then PRESERVED, pass after pass, so the 48-hour clock
//   can accumulate. `firstUnreferencedAt` is written exactly once and is
//   never moved forward.
//
// An observation is FORGOTTEN — the clock reset — only when the asset stops
// being a candidate:
//
//   referenced again        the workspace names it; it is not garbage
//   cloud document absent   there is nothing to collect
//   tombstoned              the 48-hour pre-tombstone question is settled;
//                           the 14-day clock is the server's `tombstonedAt`
//   malformed / unreadable  nothing is inferred in either direction (the
//                           mark pass refuses rather than writing here)
//
// Keyed by ["workspaceId", "assetId"] like the upload queue and the remote
// index (src/lib/assetDb.js), so an observation cannot be addressed without
// naming the workspace that owns it and one account's ledger can never be read
// through another's. `assetGcRuns` holds one record per workspace, keyed by
// the workspace alone.
//
// DELIBERATELY NOT HERE: any decision about what is referenced, any cloud
// call, and any tombstone or delete. This module records observations; the
// mark pass (src/lib/cloud/assetGarbageCollection.js) decides what to record,
// and the sweep that acts on a matured observation is Phase 7.9B.

import {
  ASSET_GC_OBSERVATION_STORE,
  ASSET_GC_RUN_STORE,
  assetDbTransaction,
  workspaceAssetKeyRange,
} from "./assetDb";
import { isValidAssetSegment } from "./cloud/assetPaths";

function requireSegment(value, label) {
  if (!isValidAssetSegment(value)) {
    throw new Error(`A valid ${label} is required to use the asset GC ledger`);
  }
  return value;
}

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Build ONE observation. Pure, so its shape is testable without IndexedDB.
 *
 * `firstUnreferencedAt` is the local clock at the moment this browser FIRST
 * saw the asset unreferenced-and-stored; `observations` counts the fully
 * gated mark passes that have agreed since. Phase 7.9B's sweep requires both
 * an elapsed 48 hours AND more than one agreeing pass, so a single pass on a
 * device with a wrong clock cannot mature a candidate on its own.
 */
export function makeGcObservation({
  workspaceId,
  assetId,
  firstUnreferencedAt,
  lastObservedAt,
  observations,
} = {}) {
  requireSegment(workspaceId, "workspace id");
  requireSegment(assetId, "asset id");
  const first = positiveInt(firstUnreferencedAt, Date.now());
  return {
    workspaceId,
    assetId,
    firstUnreferencedAt: first,
    lastObservedAt: positiveInt(lastObservedAt, first),
    observations: positiveInt(observations, 1),
  };
}

/** What this browser has observed about ONE asset, or null. */
export async function getGcObservation(workspaceId, assetId) {
  requireSegment(workspaceId, "workspace id");
  requireSegment(assetId, "asset id");
  const row = await assetDbTransaction(ASSET_GC_OBSERVATION_STORE, "readonly", (stores) =>
    stores[ASSET_GC_OBSERVATION_STORE].get([workspaceId, assetId])
  );
  return row || null;
}

/** Every observation of ONE workspace. Never another's. */
export async function listGcObservations(workspaceId) {
  requireSegment(workspaceId, "workspace id");
  const rows = await assetDbTransaction(ASSET_GC_OBSERVATION_STORE, "readonly", (stores) =>
    stores[ASSET_GC_OBSERVATION_STORE].getAll(workspaceAssetKeyRange(workspaceId))
  );
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => row && row.workspaceId === workspaceId && row.assetId);
}

/** Forget one observation. Removing nothing is not an error. */
export async function deleteGcObservation(workspaceId, assetId) {
  requireSegment(workspaceId, "workspace id");
  requireSegment(assetId, "asset id");
  await assetDbTransaction(ASSET_GC_OBSERVATION_STORE, "readwrite", (stores) =>
    stores[ASSET_GC_OBSERVATION_STORE].delete([workspaceId, assetId])
  );
}

/** Forget every observation of ONE workspace. */
export async function clearWorkspaceGcObservations(workspaceId) {
  requireSegment(workspaceId, "workspace id");
  await assetDbTransaction(ASSET_GC_OBSERVATION_STORE, "readwrite", (stores) =>
    stores[ASSET_GC_OBSERVATION_STORE].delete(workspaceAssetKeyRange(workspaceId))
  );
}

/**
 * Apply ONE mark pass's conclusions to the ledger, in ONE transaction:
 *
 *   observe   the asset is still an unreferenced, stored candidate. An
 *             existing observation is CARRIED FORWARD — same
 *             `firstUnreferencedAt`, a refreshed `lastObservedAt`, one more
 *             agreeing pass. A missing one is created at `now`.
 *   forget    the asset is no longer a candidate; its clock is reset.
 *
 * Ids that are not valid asset segments are skipped rather than throwing: a
 * malformed id in the cloud listing must not abort the ledger write for every
 * other asset in the workspace.
 *
 * @returns {Promise<{ created: string[], carried: string[], forgotten: string[] }>}
 */
export async function applyGcObservations(
  workspaceId,
  { observe = [], forget = [] } = {},
  { now = Date.now } = {}
) {
  requireSegment(workspaceId, "workspace id");
  const at = now();
  const observeIds = [...new Set((observe || []).filter((id) => isValidAssetSegment(id)))];
  const forgetIds = [...new Set((forget || []).filter((id) => isValidAssetSegment(id)))];
  const observeSet = new Set(observeIds);
  return assetDbTransaction(ASSET_GC_OBSERVATION_STORE, "readwrite", (stores) => {
    const store = stores[ASSET_GC_OBSERVATION_STORE];
    const outcome = { created: [], carried: [], forgotten: [] };
    for (const assetId of forgetIds) {
      // An id in both lists is a caller error; observing wins, because
      // forgetting is what resets the clock.
      if (observeSet.has(assetId)) continue;
      store.delete([workspaceId, assetId]);
      outcome.forgotten.push(assetId);
    }
    for (const assetId of observeIds) {
      const read = store.get([workspaceId, assetId]);
      read.onsuccess = () => {
        const existing = read.result;
        if (existing && Number.isFinite(existing.firstUnreferencedAt) && existing.firstUnreferencedAt > 0) {
          store.put(
            makeGcObservation({
              workspaceId,
              assetId,
              // NEVER moved forward: this is the 48-hour clock.
              firstUnreferencedAt: existing.firstUnreferencedAt,
              lastObservedAt: at,
              observations: (Number(existing.observations) || 0) + 1,
            })
          );
          outcome.carried.push(assetId);
          return;
        }
        store.put(
          makeGcObservation({
            workspaceId,
            assetId,
            firstUnreferencedAt: at,
            lastObservedAt: at,
            observations: 1,
          })
        );
        outcome.created.push(assetId);
      };
    }
    return () => outcome;
  });
}

/* ------------------------------ the run record ---------------------------- */

/**
 * What the last mark pass did for ONE workspace. It is the durable half of
 * the pass's own state — the part a later session can read without redoing
 * the work — and the record Phase 7.9B extends with the ~24-hour sweep
 * cadence it must not consume on a skipped attempt.
 *
 * `lastSweepAt` is DELIBERATELY absent: nothing sweeps yet, and a field that
 * no code writes would be a claim the product cannot keep.
 */
export async function readAssetGcRun(workspaceId) {
  requireSegment(workspaceId, "workspace id");
  const row = await assetDbTransaction(ASSET_GC_RUN_STORE, "readonly", (stores) =>
    stores[ASSET_GC_RUN_STORE].get(workspaceId)
  );
  return row || null;
}

/**
 * Record the outcome of one mark pass. Merges into whatever is there, so a
 * later phase's fields on the same record are never dropped by this one.
 */
export async function writeAssetGcRun(workspaceId, patch = {}, { now = Date.now } = {}) {
  requireSegment(workspaceId, "workspace id");
  const at = now();
  return assetDbTransaction(ASSET_GC_RUN_STORE, "readwrite", (stores) => {
    const store = stores[ASSET_GC_RUN_STORE];
    let written = null;
    const read = store.get(workspaceId);
    read.onsuccess = () => {
      const existing = read.result && read.result.workspaceId === workspaceId ? read.result : {};
      written = { ...existing, ...patch, workspaceId, lastMarkPassAt: at };
      store.put(written);
    };
    return () => written;
  });
}
