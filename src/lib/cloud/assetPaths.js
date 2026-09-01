// src/lib/cloud/assetPaths.js
//
// WHERE a workspace's binary assets live, and the error vocabulary both
// asset-store adapters speak. Pure — no Firebase, no browser API — so the
// real adapter (src/lib/cloud/firebaseStorageAdapter.js), its in-memory twin
// (src/lib/cloud/memoryAssetStore.js) and the Firestore workspace store all
// derive the SAME location from one definition instead of three string
// templates that could drift apart.
//
// ONE convention, two records per asset (Production Readiness Phase 7):
//
//   Firebase Storage object    workspaces/{workspaceId}/assets/{assetId}
//   Firestore metadata doc     workspaces/{workspaceId}/assets/{assetId}
//
// The object is the bytes; the document is what the workspace knows about
// them. Both are rooted at the workspace, so an asset can never be addressed
// outside the tenant that owns it, and neither is ever reached through a
// public download URL — reads go through the authenticated SDK.
//
// Both segments are VALIDATED, not interpolated: an id is a NoteWise id
// (`crypto.randomUUID()`, `ws-<uuid>`, `tpl-logo-<uuid>`, the `id-…`
// fallback), never user-supplied text, and a caller that passes something
// else gets a refusal rather than an object path with a `/` or a `..` in it.

import { isValidEntityId } from "./cloudModel";

/** The collection (Firestore) and path segment (Storage) assets live under. */
export const ASSET_COLLECTION = "assets";

/**
 * Error codes shared by both adapters. The values are the Firebase Storage
 * SDK's own codes, so a caller matching on them works against the real SDK
 * and the in-memory twin without translation.
 */
export const ASSET_STORAGE_ERROR = Object.freeze({
  NOT_FOUND: "storage/object-not-found",
  UNAUTHENTICATED: "storage/unauthenticated",
  UNAUTHORIZED: "storage/unauthorized",
  QUOTA_EXCEEDED: "storage/quota-exceeded",
  RETRY_LIMIT_EXCEEDED: "storage/retry-limit-exceeded",
  CANCELED: "storage/canceled",
  INVALID_ARGUMENT: "storage/invalid-argument",
  UNKNOWN: "storage/unknown",
});

/** An `Error` carrying a `code` from ASSET_STORAGE_ERROR. */
export function assetStorageError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** True when an error means "there is no such object". */
export function isAssetNotFound(error) {
  return Boolean(error) && error.code === ASSET_STORAGE_ERROR.NOT_FOUND;
}

// Ids NoteWise mints are hex/UUID-shaped with `-`, `_` and `.` at most. The
// pattern is deliberately narrower than Firestore's document-id rules (which
// `isValidEntityId` covers) because the same string also becomes a Storage
// object name.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** True for a string usable as both a Storage segment and a Firestore id. */
export function isValidAssetSegment(value) {
  return typeof value === "string" && ID_PATTERN.test(value) && isValidEntityId(value);
}

function requireSegment(value, label) {
  if (!isValidAssetSegment(value)) {
    throw assetStorageError(ASSET_STORAGE_ERROR.INVALID_ARGUMENT, `Invalid ${label}`);
  }
  return value;
}

/** `workspaces/{workspaceId}/assets` — the Storage prefix of one workspace. */
export function assetPrefix(workspaceId) {
  return `workspaces/${requireSegment(workspaceId, "workspace id")}/${ASSET_COLLECTION}`;
}

/** `workspaces/{workspaceId}/assets/{assetId}` — the Storage object path. */
export function assetObjectPath(workspaceId, assetId) {
  return `${assetPrefix(workspaceId)}/${requireSegment(assetId, "asset id")}`;
}

/** The Firestore path SEGMENTS of one asset's metadata document. */
export function assetDocumentPath(workspaceId, assetId) {
  return [
    "workspaces",
    requireSegment(workspaceId, "workspace id"),
    ASSET_COLLECTION,
    requireSegment(assetId, "asset id"),
  ];
}

/** The Firestore path SEGMENTS of one workspace's asset collection. */
export function assetCollectionPath(workspaceId) {
  return ["workspaces", requireSegment(workspaceId, "workspace id"), ASSET_COLLECTION];
}
