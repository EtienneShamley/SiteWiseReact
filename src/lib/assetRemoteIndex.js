// src/lib/assetRemoteIndex.js
//
// What this browser KNOWS the cloud to hold for one workspace — the local
// index of `workspaces/{workspaceId}/assets/{assetId}` (Production Readiness
// Phase 7.2).
//
// It is a CACHE OF KNOWLEDGE, never a source of truth and never bytes. An
// entry says "the last time this browser looked, the workspace's asset store
// held this asset, of this kind, this size" — which is what lets a later
// phase tell "this device has not downloaded it yet" apart from "it does not
// exist anywhere", the difference between offering a download and admitting
// the file is gone.
//
// Like the upload queue it is keyed by ["workspaceId", "assetId"]
// (src/lib/assetDb.js), so an entry cannot be addressed without naming the
// workspace that owns it and one account's index can never be read through
// another's.
//
// DELIBERATELY NOT HERE: any Firebase call, and any decision about WHEN an
// entry is stale. This module records what is known; WHO learns it is the
// upload engine's settlement (src/lib/assetUploadQueue.js) and the workspace's
// remote reader, which hydrates the index from Firestore at session start and
// corrects one entry at a time as reads confirm or contradict it
// (src/lib/cloud/assetRemoteRead.js, Production Readiness Phase 7.5).

import {
  ASSET_REMOTE_INDEX_STORE,
  assetDbTransaction,
  workspaceAssetKeyRange,
} from "./assetDb";
import { isValidAssetSegment } from "./cloud/assetPaths";

/**
 * What this browser believes about one asset's cloud copy.
 *
 *   UNKNOWN     recorded locally, nothing confirmed about the cloud
 *   PENDING     the workspace owes it (an upload queue entry exists)
 *   STORED      the workspace's asset store was observed to hold it
 *   MISSING     the workspace's asset store was observed NOT to hold it
 *   TOMBSTONED  the workspace's metadata marks it for collection
 *               (src/lib/cloud/assetCloudModel.js). It is NOT the same as
 *               MISSING: the object may still exist, and the record may be
 *               brought back by the approved tombstoned -> stored transition.
 *               Recording it faithfully is what lets a read say "not
 *               available on this device" instead of claiming the file is
 *               gone (Production Readiness Phase 7.5).
 */
export const REMOTE_ASSET_STATE = Object.freeze({
  UNKNOWN: "unknown",
  PENDING: "pending",
  STORED: "stored",
  MISSING: "missing",
  TOMBSTONED: "tombstoned",
});

const STATES = new Set(Object.values(REMOTE_ASSET_STATE));

function requireSegment(value, label) {
  if (!isValidAssetSegment(value)) {
    throw new Error(`A valid ${label} is required to use the asset remote index`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value ? value : null;
}

function optionalNumber(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Build ONE index entry. Pure, so the shape is testable without IndexedDB.
 * Unknown fields are stored as null rather than omitted, so a reader never
 * has to tell "not recorded" from "absent".
 */
export function makeRemoteAssetEntry({
  workspaceId,
  assetId,
  kind,
  name,
  mimeType,
  size,
  sourceAssetId,
  state,
  updatedAt = Date.now(),
} = {}) {
  requireSegment(workspaceId, "workspace id");
  requireSegment(assetId, "asset id");
  return {
    workspaceId,
    assetId,
    kind: optionalString(kind) || "asset",
    name: optionalString(name),
    mimeType: optionalString(mimeType),
    size: optionalNumber(size),
    // A PDF annotation rendition and its source share an identity chain; the
    // field is null for every asset that is not derived from another.
    sourceAssetId: optionalString(sourceAssetId),
    state: STATES.has(state) ? state : REMOTE_ASSET_STATE.UNKNOWN,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

/** Record (or replace) what is known about one asset's cloud copy. */
export async function putRemoteAssetEntry(entry) {
  const record = makeRemoteAssetEntry(entry);
  await assetDbTransaction(ASSET_REMOTE_INDEX_STORE, "readwrite", (stores) =>
    stores[ASSET_REMOTE_INDEX_STORE].put(record)
  );
  return record;
}

/** What is known about ONE asset in ONE workspace, or null. */
export async function getRemoteAssetEntry(workspaceId, assetId) {
  requireSegment(workspaceId, "workspace id");
  requireSegment(assetId, "asset id");
  const entry = await assetDbTransaction(ASSET_REMOTE_INDEX_STORE, "readonly", (stores) =>
    stores[ASSET_REMOTE_INDEX_STORE].get([workspaceId, assetId])
  );
  return entry || null;
}

/** Everything known about ONE workspace's cloud assets. Never another's. */
export async function listRemoteAssetEntries(workspaceId) {
  requireSegment(workspaceId, "workspace id");
  const rows = await assetDbTransaction(ASSET_REMOTE_INDEX_STORE, "readonly", (stores) =>
    stores[ASSET_REMOTE_INDEX_STORE].getAll(workspaceAssetKeyRange(workspaceId))
  );
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((entry) => entry && entry.workspaceId === workspaceId && entry.assetId);
}

/** Forget what was known about one asset. Removing nothing is not an error. */
export async function deleteRemoteAssetEntry(workspaceId, assetId) {
  requireSegment(workspaceId, "workspace id");
  requireSegment(assetId, "asset id");
  await assetDbTransaction(ASSET_REMOTE_INDEX_STORE, "readwrite", (stores) =>
    stores[ASSET_REMOTE_INDEX_STORE].delete([workspaceId, assetId])
  );
}

/** Forget everything known about ONE workspace's cloud assets. */
export async function clearWorkspaceRemoteAssets(workspaceId) {
  requireSegment(workspaceId, "workspace id");
  await assetDbTransaction(ASSET_REMOTE_INDEX_STORE, "readwrite", (stores) =>
    stores[ASSET_REMOTE_INDEX_STORE].delete(workspaceAssetKeyRange(workspaceId))
  );
}
