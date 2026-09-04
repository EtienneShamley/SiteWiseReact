// src/lib/assetUploadQueue.js
//
// WHICH of this browser's assets a workspace still owes the cloud — the
// durable identity half of the upload path (Production Readiness Phase 7.2).
//
// It stores IDENTITIES AND RETRY METADATA, never bytes. The bytes already
// live in this browser's local cache (src/lib/localAssetCache.js) and are
// read from there when the queue is drained; duplicating them here would
// double every asset's storage cost and create a second copy that could
// disagree with the first.
//
// WHY IT IS DURABLE. A local asset creation succeeds locally first, so the
// user's note is never blocked on the network. What is owed must therefore
// survive a reload, a crash and a sign-out — otherwise an asset created
// offline would silently never reach the cloud. The queue is written in the
// SAME IndexedDB transaction as the asset record it belongs to
// (src/lib/assetStorage.js), so "the asset exists locally" and "the cloud is
// owed this asset" can never disagree.
//
// WHY EVERY OPERATION NAMES A WORKSPACE. Entries are keyed by
// ["workspaceId", "assetId"] (src/lib/assetDb.js), so there is no operation
// that can read, settle or count another workspace's entries — not by
// filtering, but because the key of an entry cannot be formed without its
// workspace. Two accounts sharing one browser therefore cannot see or drain
// each other's queues. A caller that does not name a valid workspace is
// REFUSED rather than served the local/unscoped case: a local-only asset is
// owed to nobody and is never queued at all.
//
// DELIBERATELY NOT HERE: backoff timers, `online` listeners, the drain loop,
// and any Firebase Storage call — those belong to the upload engine
// (src/lib/cloud/assetUploadSync.js). This module records what is owed and
// what has been tried; it never decides when to try. The one thing it does
// own is the END of an upload: `settleAssetUploadAsStored` writes the remote
// index and removes the queue entry in ONE transaction, so local sync state
// cannot become self-contradictory.

import {
  ASSET_REMOTE_INDEX_STORE,
  ASSET_UPLOAD_QUEUE_STORE,
  assetDbTransaction,
  workspaceAssetKeyRange,
} from "./assetDb";
import { REMOTE_ASSET_STATE, makeRemoteAssetEntry } from "./assetRemoteIndex";
import { isValidAssetSegment } from "./cloud/assetPaths";

/**
 * True for a workspace id usable as a queue key. It is the SAME rule the
 * Storage object path uses (src/lib/cloud/assetPaths.js) so an entry can
 * never be queued that could not later be addressed as an object.
 */
export function isQueueableWorkspaceId(workspaceId) {
  return isValidAssetSegment(workspaceId);
}

function requireWorkspaceId(workspaceId) {
  if (!isQueueableWorkspaceId(workspaceId)) {
    throw new Error("A valid workspace id is required to use the asset upload queue");
  }
  return workspaceId;
}

function requireAssetId(assetId) {
  if (!isValidAssetSegment(assetId)) {
    throw new Error("A valid asset id is required to use the asset upload queue");
  }
  return assetId;
}

/**
 * Build ONE queue entry. Pure, so its shape and validation are testable
 * without IndexedDB — and so the atomic asset creation in
 * src/lib/assetStorage.js can build the entry before it opens a transaction.
 *
 * `nextAttemptAt` starts at `at`: the entry is due immediately, and only a
 * failed attempt (Phase 7.4) pushes it into the future.
 */
export function makeAssetUploadEntry({ workspaceId, assetId, kind, at = Date.now() }) {
  requireWorkspaceId(workspaceId);
  requireAssetId(assetId);
  const when = Number.isFinite(at) ? at : Date.now();
  return {
    workspaceId,
    assetId,
    kind: typeof kind === "string" && kind ? kind : "asset",
    at: when,
    attempts: 0,
    nextAttemptAt: when,
    lastCode: null,
  };
}

/**
 * Record that a workspace owes the cloud one asset.
 *
 * Idempotent by key: re-queueing an asset that is already pending REPLACES
 * its entry rather than creating a second one, so a retried creation cannot
 * make the same asset owed twice.
 */
export async function enqueueAssetUpload({ workspaceId, assetId, kind, at } = {}) {
  const entry = makeAssetUploadEntry({ workspaceId, assetId, kind, at });
  await assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readwrite", (stores) =>
    stores[ASSET_UPLOAD_QUEUE_STORE].put(entry)
  );
  return entry;
}

/** One workspace's entry for one asset, or null. */
export async function getAssetUpload(workspaceId, assetId) {
  requireWorkspaceId(workspaceId);
  requireAssetId(assetId);
  const entry = await assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readonly", (stores) =>
    stores[ASSET_UPLOAD_QUEUE_STORE].get([workspaceId, assetId])
  );
  return entry || null;
}

/**
 * Every entry ONE workspace still owes, oldest first. The key range covers
 * exactly that workspace, so no other workspace's rows are ever read.
 */
export async function listPendingAssetUploads(workspaceId) {
  requireWorkspaceId(workspaceId);
  const rows = await assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readonly", (stores) =>
    stores[ASSET_UPLOAD_QUEUE_STORE].getAll(workspaceAssetKeyRange(workspaceId))
  );
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((entry) => entry && entry.workspaceId === workspaceId && entry.assetId)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

/** How many entries one workspace still owes. */
export async function countPendingAssetUploads(workspaceId) {
  requireWorkspaceId(workspaceId);
  const count = await assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readonly", (stores) =>
    stores[ASSET_UPLOAD_QUEUE_STORE].count(workspaceAssetKeyRange(workspaceId))
  );
  return count || 0;
}

/**
 * Record the OUTCOME of one attempt: a new attempt count, when the entry may
 * be tried again, and the error code (`storage/…`) that ended it.
 *
 * Resolves to the updated entry, or null when the entry is already gone — a
 * settled upload must never be resurrected by a late failure report.
 */
export async function updateAssetUploadAttempt(
  workspaceId,
  assetId,
  { attempts, nextAttemptAt, lastCode } = {}
) {
  requireWorkspaceId(workspaceId);
  requireAssetId(assetId);
  return assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readwrite", (stores) => {
    const store = stores[ASSET_UPLOAD_QUEUE_STORE];
    const read = store.get([workspaceId, assetId]);
    let updated = null;
    read.onsuccess = () => {
      const existing = read.result;
      if (!existing) return;
      updated = {
        ...existing,
        attempts: Number.isFinite(attempts) ? attempts : (existing.attempts || 0) + 1,
        nextAttemptAt: Number.isFinite(nextAttemptAt)
          ? nextAttemptAt
          : existing.nextAttemptAt || existing.at || 0,
        lastCode: typeof lastCode === "string" && lastCode ? lastCode : null,
      };
      store.put(updated);
    };
    return () => updated;
  });
}

/**
 * The workspace no longer owes this asset — it uploaded, or it turned out
 * never to have needed uploading. Removing an entry that is already gone is
 * success, not an error.
 */
export async function settleAssetUpload(workspaceId, assetId) {
  requireWorkspaceId(workspaceId);
  requireAssetId(assetId);
  await assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readwrite", (stores) =>
    stores[ASSET_UPLOAD_QUEUE_STORE].delete([workspaceId, assetId])
  );
}

/**
 * The END of one successful upload, as ONE local transaction (Production
 * Readiness Phase 7.4): what the cloud is now known to hold is recorded in
 * `assetRemoteIndex`, and the workspace stops owing the asset, together or
 * not at all.
 *
 * WHY IT IS ONE TRANSACTION. The two writes are the two halves of a single
 * fact — "this asset is in the cloud". Written separately, a crash between
 * them leaves this browser contradicting itself in one of two ways: an index
 * saying `stored` with a queue entry that will re-upload (harmless but
 * wasteful, and it makes "what is pending" a lie), or a settled queue with an
 * index that never learned, which is the dangerous one — nothing would ever
 * re-derive that the asset is in the cloud. Both stores live in the SAME
 * IndexedDB database (src/lib/assetDb.js), so one transaction is available
 * and there is no reason to accept the contradiction.
 *
 * The uploaded BYTES are deliberately not touched: a synced asset stays in
 * this browser's cache, and cache eviction is its own approved policy.
 *
 * @param {{ workspaceId, assetId, kind, name, mimeType, size, sourceAssetId,
 *           at }} entry the asset as it was actually uploaded.
 * @returns the remote-index record that was written.
 */
export async function settleAssetUploadAsStored({
  workspaceId,
  assetId,
  kind,
  name,
  mimeType,
  size,
  sourceAssetId,
  at,
} = {}) {
  requireWorkspaceId(workspaceId);
  requireAssetId(assetId);
  // Built BEFORE the transaction opens, exactly as the atomic creation in
  // src/lib/assetStorage.js does: a refused record must never be the reason a
  // transaction aborts halfway.
  const record = makeRemoteAssetEntry({
    workspaceId,
    assetId,
    kind,
    name,
    mimeType,
    size,
    sourceAssetId,
    state: REMOTE_ASSET_STATE.STORED,
    updatedAt: Number.isFinite(at) ? at : Date.now(),
  });
  await assetDbTransaction(
    [ASSET_REMOTE_INDEX_STORE, ASSET_UPLOAD_QUEUE_STORE],
    "readwrite",
    (stores) => {
      stores[ASSET_REMOTE_INDEX_STORE].put(record);
      stores[ASSET_UPLOAD_QUEUE_STORE].delete([workspaceId, assetId]);
    }
  );
  return record;
}

/**
 * Remove EVERY entry of one workspace. Used when a workspace's local cache is
 * discarded; it can never reach another workspace's rows.
 */
export async function clearWorkspaceAssetUploads(workspaceId) {
  requireWorkspaceId(workspaceId);
  await assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readwrite", (stores) =>
    stores[ASSET_UPLOAD_QUEUE_STORE].delete(workspaceAssetKeyRange(workspaceId))
  );
}
