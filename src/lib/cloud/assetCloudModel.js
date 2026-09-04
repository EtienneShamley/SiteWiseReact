// src/lib/cloud/assetCloudModel.js
//
// The Firestore DOMAIN MODEL of one ASSET'S METADATA, as pure functions
// (Production Readiness Phase 7.3). No Firebase SDK, no browser API: the
// Firestore adapter, its in-memory twin, the Security Rules tests and the
// later upload / garbage-collection phases all validate the SAME document
// shape from this one definition.
//
// TWO RECORDS PER ASSET (src/lib/cloud/assetPaths.js):
//
//   Firebase Storage object    workspaces/{workspaceId}/assets/{assetId}   the bytes
//   Firestore document         workspaces/{workspaceId}/assets/{assetId}   what the workspace knows
//
// The document carries the Phase 6 ENVELOPE — `{ workspaceId, id, kind,
// schemaVersion, updatedAt }`, where `kind` is the COLLECTION name exactly as
// on every other entity document (src/lib/cloud/cloudModel.js) — and the
// asset's own record:
//
//   assetKind        the real kind the local layer stored it under — logo,
//                    note-photo, note-file, editor-image, editor-file,
//                    pdf-source — preserved, never derived from the path
//   name             display filename or null
//   mimeType         the content type the object was written with
//   size             bytes, a positive integer, ≤ the 50 MB object ceiling
//   createdAt        the local record's creation time (ms since epoch)
//   metadata         the local record's metadata map (photo capture data,
//                    image normalisation facts, an annotation layer)
//   sourceAssetId?   the asset this one was derived from (an annotated
//                    rendition names its original)
//   state            "stored" | "tombstoned"
//   tombstonedAt?    a SERVER timestamp, present exactly when tombstoned
//
// `updatedAt` and `tombstonedAt` are server timestamps the STORE stamps, so
// no client can back-date a tombstone to hurry garbage collection or refresh
// one to delay it. `createdAt` is informational (the local clock) and never a
// lifecycle input.
//
// LIFECYCLE the rules permit: create as `stored` → `tombstoned` (when the
// workspace no longer references the asset) → back to `stored` (a reference
// reappeared inside the grace period) → deleted by the workspace OWNER. On
// an update nothing but `state`, `tombstonedAt` and `updatedAt` may change:
// the object is immutable, so its description is too.
//
// The MIME policy below is the ONE canonical list for cloud assets — the
// Storage rules' content-type allow-list and the Firestore rules' `mimeType`
// check enumerate exactly it (asserted by src/lib/cloud/assetCloudModel.test.js
// against both rules files). It is a TRANSPORT check: a content type proves
// nothing about bytes, and opening / downloading an attachment still decides
// from the Blob itself (src/lib/safeAttachmentOpen.js).

import { CLOUD_SCHEMA_VERSION, payloadSignature } from "./cloudModel";
import { ASSET_COLLECTION, isValidAssetSegment } from "./assetPaths";
import { normalizeMimeType } from "../imageProcessing";

/* ------------------------------ catalogue -------------------------------- */

export const ASSET_SCHEMA_VERSION = CLOUD_SCHEMA_VERSION;

/** The real asset kinds, as the local layer stores them. */
export const CLOUD_ASSET_KIND = Object.freeze({
  LOGO: "logo",
  NOTE_PHOTO: "note-photo",
  NOTE_FILE: "note-file",
  EDITOR_IMAGE: "editor-image",
  EDITOR_FILE: "editor-file",
  PDF_SOURCE: "pdf-source",
});

export const CLOUD_ASSET_KINDS = Object.freeze(Object.values(CLOUD_ASSET_KIND));

export const CLOUD_ASSET_STATE = Object.freeze({ STORED: "stored", TOMBSTONED: "tombstoned" });

export const CLOUD_ASSET_STATES = Object.freeze(Object.values(CLOUD_ASSET_STATE));

/** The absolute Storage object ceiling — the same number as the PDF import cap. */
export const MAX_CLOUD_ASSET_BYTES = 50 * 1024 * 1024;

export const MAX_CLOUD_ASSET_NAME_LENGTH = 255;
export const MAX_CLOUD_ASSET_MIME_LENGTH = 128;

// The metadata map: at most this many top-level keys, nested no deeper than
// this, and no longer than this many UTF-16 units serialised — the same
// budget one inline JSON payload gets (cloudModel.MAX_INLINE_PAYLOAD_UNITS),
// because an annotated photo's rendition carries its editable layer here.
export const MAX_CLOUD_ASSET_METADATA_KEYS = 64;
export const MAX_CLOUD_ASSET_METADATA_DEPTH = 8;
export const MAX_CLOUD_ASSET_METADATA_UNITS = 240000;

/**
 * Every content type NoteWise legitimately accepts for a stored asset today:
 * the shared image policy (logos, note photos, editor images and their
 * normalised outputs), the PDF import, and the note-file / editor-file
 * document allow-lists — including the alternative types real systems
 * report for a CSV. Nothing scriptable or executable is on it.
 */
export const CLOUD_ASSET_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/csv",
]);

/** Every field an asset document may carry. */
export const ASSET_DOCUMENT_FIELDS = Object.freeze([
  "workspaceId",
  "id",
  "kind",
  "schemaVersion",
  "updatedAt",
  "assetKind",
  "name",
  "mimeType",
  "size",
  "createdAt",
  "metadata",
  "sourceAssetId",
  "state",
  "tombstonedAt",
]);

/** The only fields an UPDATE may change. */
export const MUTABLE_ASSET_FIELDS = Object.freeze(["state", "tombstonedAt", "updatedAt"]);

/** The custom metadata keys the Storage create rule requires on an object. */
export const ASSET_STORAGE_METADATA_KEYS = Object.freeze(["assetId", "workspaceId", "assetKind"]);

const KIND_SET = new Set(CLOUD_ASSET_KINDS);
const STATE_SET = new Set(CLOUD_ASSET_STATES);
const MIME_SET = new Set(CLOUD_ASSET_MIME_TYPES);
const FIELD_SET = new Set(ASSET_DOCUMENT_FIELDS);
const MUTABLE_SET = new Set(MUTABLE_ASSET_FIELDS);

/* ------------------------------- predicates ------------------------------ */

export function isCloudAssetKind(kind) {
  return typeof kind === "string" && KIND_SET.has(kind);
}

export function isCloudAssetState(state) {
  return typeof state === "string" && STATE_SET.has(state);
}

/** "image/jpeg; charset=x" → "image/jpeg"; anything unusable → "". */
export function normalizeCloudMimeType(type) {
  return normalizeMimeType(type);
}

/** True when a (normalised) content type is on the canonical cloud list. */
export function isCloudAssetMimeType(type) {
  const mime = normalizeCloudMimeType(type);
  return mime.length > 0 && mime.length <= MAX_CLOUD_ASSET_MIME_LENGTH && MIME_SET.has(mime);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * A value a store hands back for a server timestamp: a number of
 * milliseconds (the in-memory store), a Date, or a Firestore Timestamp-shaped
 * object (`toMillis()` or `seconds`).
 */
export function isTimestampLike(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (!isPlainObject(value)) return false;
  if (typeof value.toMillis === "function") return true;
  return Number.isFinite(value.seconds);
}

/* -------------------------------- metadata ------------------------------- */

function metadataValueOk(value, depth) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (type !== "object") return false; // functions, symbols, bigint
  if (depth > MAX_CLOUD_ASSET_METADATA_DEPTH) return false;
  if (Array.isArray(value)) {
    // Firestore refuses an array directly inside an array.
    return value.every((item) => !Array.isArray(item) && metadataValueOk(item, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.keys(value).every((key) => metadataValueOk(value[key], depth + 1));
}

/**
 * `{ ok: true }` for a metadata map the document may carry — a plain object
 * of JSON-safe values, bounded in keys, depth and serialised size —
 * otherwise `{ ok: false, reason }`.
 */
export function validateAssetMetadata(metadata) {
  if (!isPlainObject(metadata)) return { ok: false, reason: "bad-metadata" };
  const keys = Object.keys(metadata);
  if (keys.length > MAX_CLOUD_ASSET_METADATA_KEYS) return { ok: false, reason: "metadata-too-many-keys" };
  if (!keys.every((key) => key.length > 0 && key.length <= 128)) return { ok: false, reason: "bad-metadata-key" };
  if (!metadataValueOk(metadata, 1)) return { ok: false, reason: "bad-metadata-value" };
  let serialized;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return { ok: false, reason: "bad-metadata-value" };
  }
  if (typeof serialized !== "string" || serialized.length > MAX_CLOUD_ASSET_METADATA_UNITS) {
    return { ok: false, reason: "metadata-too-large" };
  }
  return { ok: true };
}

/* ------------------------------- validation ------------------------------ */

/**
 * Validates one asset document against its path identity and returns the
 * asset it describes:
 *   { ok: true, asset }        asset = { workspaceId, id, assetKind, name, mimeType,
 *                                        size, createdAt, metadata, sourceAssetId,
 *                                        state, tombstonedAt, updatedAt }
 *   { ok: false, reason }
 * Optional fields come back as null, never undefined. A document that fails
 * here is MALFORMED: the caller records it and never treats it as an asset
 * (the same rule readEntityDocument applies to every other entity).
 */
export function validateAssetDocument({ workspaceId, id, fields }) {
  if (!isValidAssetSegment(workspaceId)) return { ok: false, reason: "bad-workspace-id" };
  if (!isValidAssetSegment(id)) return { ok: false, reason: "bad-id" };
  if (!isPlainObject(fields)) return { ok: false, reason: "bad-document" };

  for (const key of Object.keys(fields)) {
    if (!FIELD_SET.has(key)) return { ok: false, reason: "unknown-field" };
  }
  if (fields.workspaceId !== workspaceId) return { ok: false, reason: "workspace-mismatch" };
  if (fields.id !== id) return { ok: false, reason: "id-mismatch" };
  if (fields.kind !== ASSET_COLLECTION) return { ok: false, reason: "kind-mismatch" };
  if (fields.schemaVersion !== ASSET_SCHEMA_VERSION) return { ok: false, reason: "bad-schema-version" };
  if (!isCloudAssetKind(fields.assetKind)) return { ok: false, reason: "bad-asset-kind" };

  const name = fields.name === undefined ? null : fields.name;
  if (name !== null && (typeof name !== "string" || name.length > MAX_CLOUD_ASSET_NAME_LENGTH)) {
    return { ok: false, reason: "bad-name" };
  }
  if (
    typeof fields.mimeType !== "string" ||
    fields.mimeType !== normalizeCloudMimeType(fields.mimeType) ||
    !isCloudAssetMimeType(fields.mimeType)
  ) {
    return { ok: false, reason: "bad-mime-type" };
  }
  if (!isPositiveInteger(fields.size) || fields.size > MAX_CLOUD_ASSET_BYTES) return { ok: false, reason: "bad-size" };
  if (!isPositiveInteger(fields.createdAt)) return { ok: false, reason: "bad-created-at" };

  const metadataCheck = validateAssetMetadata(fields.metadata);
  if (!metadataCheck.ok) return metadataCheck;

  const sourceAssetId = fields.sourceAssetId === undefined ? null : fields.sourceAssetId;
  if (sourceAssetId !== null && (!isValidAssetSegment(sourceAssetId) || sourceAssetId === id)) {
    return { ok: false, reason: "bad-source-asset-id" };
  }

  if (!isCloudAssetState(fields.state)) return { ok: false, reason: "bad-state" };
  const tombstonedAt = fields.tombstonedAt === undefined ? null : fields.tombstonedAt;
  if (fields.state === CLOUD_ASSET_STATE.TOMBSTONED) {
    if (!isTimestampLike(tombstonedAt)) return { ok: false, reason: "bad-tombstoned-at" };
  } else if (tombstonedAt !== null) {
    return { ok: false, reason: "unexpected-tombstoned-at" };
  }

  return {
    ok: true,
    asset: {
      workspaceId,
      id,
      assetKind: fields.assetKind,
      name,
      mimeType: fields.mimeType,
      size: fields.size,
      createdAt: fields.createdAt,
      metadata: fields.metadata,
      sourceAssetId,
      state: fields.state,
      tombstonedAt,
      updatedAt: fields.updatedAt === undefined ? null : fields.updatedAt,
    },
  };
}

/**
 * Whether `next` is a permitted rewrite of the existing document `previous`
 * (both already valid): identity and description immutable, and the state
 * machine respected —
 *   stored     → stored       nothing changes (an idempotent re-write)
 *   stored     → tombstoned   tombstonedAt is set (the store stamps it)
 *   tombstoned → stored       tombstonedAt is gone
 *   tombstoned → tombstoned   tombstonedAt is unchanged
 * `{ ok: true }` or `{ ok: false, reason }`.
 */
export function validateAssetTransition(previous, next) {
  if (!isPlainObject(previous) || !isPlainObject(next)) return { ok: false, reason: "bad-document" };
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (MUTABLE_SET.has(key)) continue;
    const before = previous[key] === undefined ? null : previous[key];
    const after = next[key] === undefined ? null : next[key];
    if (payloadSignature(before) !== payloadSignature(after)) return { ok: false, reason: `immutable-field:${key}` };
  }
  const wasTombstoned = previous.state === CLOUD_ASSET_STATE.TOMBSTONED;
  if (next.state === CLOUD_ASSET_STATE.STORED) {
    if (next.tombstonedAt !== undefined && next.tombstonedAt !== null) return { ok: false, reason: "unexpected-tombstoned-at" };
    return { ok: true };
  }
  if (next.state !== CLOUD_ASSET_STATE.TOMBSTONED) return { ok: false, reason: "bad-state" };
  if (!isTimestampLike(next.tombstonedAt)) return { ok: false, reason: "bad-tombstoned-at" };
  if (wasTombstoned && payloadSignature(previous.tombstonedAt) !== payloadSignature(next.tombstonedAt)) {
    return { ok: false, reason: "tombstoned-at-changed" };
  }
  return { ok: true };
}

/* -------------------------------- builders ------------------------------- */

/**
 * The document fields of a NEW asset (state `stored`) from a local record's
 * facts. `updatedAt` is left to the store, exactly as buildEntityDocument
 * does; optional fields are omitted rather than written as null, matching
 * what the rules accept. The display name is trimmed to its cap — it is
 * metadata, not identity — while every other fact is validated strictly:
 *   { ok: true, fields } | { ok: false, reason }
 */
export function buildAssetDocument({
  workspaceId,
  id,
  assetKind,
  name,
  mimeType,
  size,
  createdAt,
  metadata,
  sourceAssetId,
  now = Date.now,
} = {}) {
  const displayName =
    typeof name === "string" && name.length > 0 ? name.slice(0, MAX_CLOUD_ASSET_NAME_LENGTH) : null;
  const fields = {
    workspaceId,
    id,
    kind: ASSET_COLLECTION,
    schemaVersion: ASSET_SCHEMA_VERSION,
    assetKind,
    name: displayName,
    mimeType: normalizeCloudMimeType(mimeType),
    size,
    createdAt: isPositiveInteger(createdAt) ? createdAt : now(),
    metadata: metadata === undefined || metadata === null ? {} : metadata,
    state: CLOUD_ASSET_STATE.STORED,
  };
  if (typeof sourceAssetId === "string" && sourceAssetId) fields.sourceAssetId = sourceAssetId;
  const check = validateAssetDocument({ workspaceId, id, fields });
  if (!check.ok) return check;
  return { ok: true, fields };
}

/**
 * The same document marked `tombstoned`. `tombstonedAt` is the STORE's
 * server-timestamp sentinel (`store.timestamp()`), never a client clock.
 */
export function tombstoneAssetDocument(fields, tombstonedAt) {
  const { updatedAt: _updatedAt, ...rest } = fields || {};
  return { ...rest, state: CLOUD_ASSET_STATE.TOMBSTONED, tombstonedAt };
}

/** The same document back in `stored`, its tombstone removed. */
export function restoreAssetDocument(fields) {
  const { updatedAt: _updatedAt, tombstonedAt: _tombstonedAt, ...rest } = fields || {};
  return { ...rest, state: CLOUD_ASSET_STATE.STORED };
}

/**
 * The custom metadata the Storage object must be created with — the create
 * rule requires it to name the same workspace, asset and kind as the path
 * and the document, so a byte upload can never be filed under a different
 * identity than its record.
 */
export function assetStorageMetadata(fields) {
  const f = fields || {};
  return { assetId: String(f.id), workspaceId: String(f.workspaceId), assetKind: String(f.assetKind) };
}
