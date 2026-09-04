// src/lib/assetStorage.js
//
// Reusable, native-IndexedDB asset storage for NoteWise template assets.
// This is the storage foundation the template logo uses today and that future
// photo / file / signature fields are intended to reuse — it stores the
// ORIGINAL Blob/File, never base64, and never places binary data in
// localStorage.
//
// The design deliberately mirrors src/lib/pdfStorage.js: native IndexedDB (no
// wrapper dependency), a versioned database + store, promise-based helpers that
// REJECT on open/read/write failure so callers can surface errors visibly, and
// pure record/validation helpers exported separately so they are unit-testable
// without a real IndexedDB (jsdom has none).
//
// WORKSPACE TAGGING (Production Readiness Phase 7.2). An asset created while a
// workspace is the active durable scope (src/lib/durableStorage.js) records
// that workspace on the record and, in the SAME IndexedDB transaction, the
// upload-queue identity the cloud is owed (src/lib/assetUploadQueue.js). An
// asset created in the local scope records no workspace and is queued for
// nobody — exactly the behaviour this module has always had.
//
// Records written BEFORE that phase carry no `workspaceId`. They are legacy,
// not orphaned: they stay readable in every scope, are never rewritten, and
// are never reassigned to whichever account happens to sign in. Associating
// them with a workspace is an explicit, user-facing migration (Phase 7.6) and
// deliberately does not happen here.
//
// The database connection and its schema live in src/lib/assetDb.js, which the
// upload queue and the remote index share — one opener, one version.

import { newId } from "./id";
import {
  ASSET_STORE,
  ASSET_UPLOAD_QUEUE_STORE,
  assetDbTransaction,
} from "./assetDb";
import { DURABLE_SCOPE_KIND, getDurableScope } from "./durableStorage";
import { isQueueableWorkspaceId, makeAssetUploadEntry } from "./assetUploadQueue";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  IMAGE_OVERSIZED_MESSAGE,
  IMAGE_UNSUPPORTED_MESSAGE,
  MAX_IMAGE_SOURCE_BYTES,
  isAllowedImageMimeType,
} from "./imageProcessing";

const STORE = ASSET_STORE;

// Logo upload constraints. SVG is intentionally excluded. The logo is a small
// brand asset with its own smaller limit and is deliberately NOT governed by
// the shared image-upload policy used for note evidence and editor images.
export const ALLOWED_LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB

// Note Photo-field constraints (evidence photos on a completed note). These are
// the SHARED image-upload policy (src/lib/imageProcessing.js): the same accepted
// types, the same 20 MB source limit and the same normalization as a Free-form
// editor image, so a user does not meet two different answers to "can I upload
// this photo" in one product.
export const ALLOWED_PHOTO_MIME_TYPES = ALLOWED_IMAGE_MIME_TYPES;
export const MAX_PHOTO_BYTES = MAX_IMAGE_SOURCE_BYTES; // 20 MB

// Note File-field constraints. MIME types vary by OS/browser for Office and CSV
// files, so validation accepts a file when EITHER its MIME type or its
// extension is on the allowlist (see validateNoteFile).
export const ALLOWED_NOTE_FILE_MIME_TYPES = [
  "application/pdf",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel", // .xls (also reported for .csv on some systems)
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/csv",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
];
export const ALLOWED_NOTE_FILE_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".csv",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
];
export const MAX_NOTE_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

// Asset kinds for note-field evidence (photo/file attachments referenced from
// a NoteTemplateInstance — see src/lib/noteAttachments.js).
export const ASSET_KIND_NOTE_PHOTO = "note-photo";
export const ASSET_KIND_NOTE_FILE = "note-file";

// Asset kind for an image placed in a FREE-FORM note. It is referenced from the
// note's rich-text document by `data-asset-id` (see src/lib/editorImageAssets.js)
// rather than from a NoteTemplateInstance, which is why it is its own kind:
// Template-form cleanup and Free-form cleanup must never reach each other's
// assets.
export const ASSET_KIND_EDITOR_IMAGE = "editor-image";

// Asset kind for a FILE attached to a Free-form note (an ordinary business
// document — see src/lib/editorFileAttachments.js). Referenced from the note's
// rich-text document by `data-file-asset-id`, which is why it is its own kind
// rather than reusing note-file: Template-form File cleanup, Free-form image
// cleanup and Free-form file cleanup must never reach each other's assets, and
// the kind is checked before a stored Blob is ever opened or downloaded.
export const ASSET_KIND_EDITOR_FILE = "editor-file";

function txRequest(mode, run) {
  return assetDbTransaction(STORE, mode, (stores) => run(stores[STORE]));
}

/**
 * The workspace a NEW asset belongs to, or null when there is none.
 *
 * It is read from the ACTIVE DURABLE SCOPE — the same session boundary every
 * owner module already resolves its records against (src/lib/durableStorage.js,
 * set once per session by src/lib/cloud/workspaceSession.js) — rather than from
 * a second global of this module's own. There is one answer to "whose data is
 * this", and assets now use it too.
 */
export function activeAssetWorkspaceId() {
  const scope = getDurableScope();
  if (!scope || scope.kind !== DURABLE_SCOPE_KIND.WORKSPACE) return null;
  return isQueueableWorkspaceId(scope.id) ? scope.id : null;
}

/* ------------------------- pure, testable helpers ------------------------ */

// Builds an asset record. Pure (no IndexedDB) so its shape and id handling are
// unit-testable. `id` must be supplied by the caller: user uploads pass a fresh
// newId() (see createLogoAsset); the legacy migration passes a DETERMINISTIC id
// derived from the TemplateVersion so a retry can never create a duplicate
// asset.
//
// `workspaceId` is the workspace that OWNS the asset, or null for a local-only
// asset. It is written, never inferred later: a record with no workspace is a
// record that belongs to this browser alone until a user explicitly migrates it.
export function makeAssetRecord({ id, kind, name, blob, metadata, workspaceId }) {
  if (!id) throw new Error("An asset id is required");
  if (!blob || typeof blob.size !== "number") {
    throw new Error("A Blob is required to store an asset");
  }
  if (blob.size === 0) throw new Error("Cannot store an empty asset");
  const now = Date.now();
  return {
    id,
    kind: kind || "asset",
    name: name || null,
    mimeType: blob.type || null,
    size: blob.size,
    blob,
    createdAt: now,
    updatedAt: now,
    metadata: metadata || {},
    workspaceId: isQueueableWorkspaceId(workspaceId) ? workspaceId : null,
  };
}

// Validates a candidate logo File/Blob against the allowed types and size.
// Returns { ok: true } or { ok: false, error } — never throws — so the builder
// can show a clear message and preserve the previous logo.
export function validateLogoFile(file) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file was selected." };
  }
  if (file.size === 0) {
    return { ok: false, error: "That file is empty or unreadable." };
  }
  if (!ALLOWED_LOGO_MIME_TYPES.includes(file.type)) {
    return {
      ok: false,
      error: "Unsupported image type. Use a PNG, JPEG or WebP file.",
    };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return { ok: false, error: "That image is larger than the 5 MB limit." };
  }
  return { ok: true };
}

// Validates a candidate note-Photo File/Blob. Same contract as
// validateLogoFile: returns { ok: true } or { ok: false, error }, never throws.
//
// The rules and the wording come from the shared image policy, so a Photo field
// and the Free-form editor accept exactly the same files and say exactly the
// same thing when they do not.
export function validatePhotoFile(file) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file was selected." };
  }
  if (file.size === 0) {
    return { ok: false, error: "That file is empty or unreadable." };
  }
  if (!isAllowedImageMimeType(file.type)) {
    return { ok: false, error: IMAGE_UNSUPPORTED_MESSAGE };
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: IMAGE_OVERSIZED_MESSAGE };
  }
  return { ok: true };
}

// Extracts a lowercase ".ext" from a filename, or "" when there is none.
export function fileExtension(name) {
  if (typeof name !== "string") return "";
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx).toLowerCase();
}

// Validates a candidate note-File attachment. A file passes when its MIME type
// OR its extension is allowlisted — Office/CSV MIME types are inconsistent
// across platforms, so extension is an accepted fallback signal; anything
// matching neither is rejected.
export function validateNoteFile(file) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file was selected." };
  }
  if (file.size === 0) {
    return { ok: false, error: "That file is empty or unreadable." };
  }
  const mimeOk = ALLOWED_NOTE_FILE_MIME_TYPES.includes(file.type);
  const extOk = ALLOWED_NOTE_FILE_EXTENSIONS.includes(fileExtension(file.name));
  if (!mimeOk && !extOk) {
    return {
      ok: false,
      error:
        "Unsupported file type. Use PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, PNG, JPEG or WebP.",
    };
  }
  if (file.size > MAX_NOTE_FILE_BYTES) {
    return { ok: false, error: "That file is larger than the 20 MB limit." };
  }
  return { ok: true };
}

// Converts a data: URL (e.g. a legacy base64 logoSrc) into a Blob without
// fetch(). Returns null for anything that is not a valid, non-empty data URL,
// so the migration can safely skip non-migratable values.
export function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = !!match[2];
  const data = match[3] || "";
  try {
    let bytes;
    if (isBase64) {
      const binary = atob(data);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      const decoded = decodeURIComponent(data);
      bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    }
    if (bytes.length === 0) return null;
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

// True only for a valid, non-empty data:image/* URL — the exact class of legacy
// logo the migration should convert.
export function isMigratableLogoSrc(logoSrc) {
  return (
    typeof logoSrc === "string" &&
    /^data:image\//i.test(logoSrc) &&
    dataUrlToBlob(logoSrc) !== null
  );
}

/* ------------------------------ public API ------------------------------ */

export async function saveAsset(record) {
  if (!record || !record.id) throw new Error("Cannot save an asset without an id");
  await txRequest("readwrite", (store) => store.put(record));
  return record.id;
}

/**
 * The ATOMIC creation of a workspace-owned asset: the local record and the
 * upload identity the cloud is owed, written in ONE IndexedDB transaction.
 *
 * The invariant it exists for, in both directions:
 *
 *   resolved  the local asset exists AND its queue identity exists
 *   rejected  NEITHER exists — no asset the cloud will never hear about, and
 *             no queue entry naming bytes that were never stored
 *
 * An asynchronous failure (quota, a refused write) is rolled back by
 * IndexedDB itself; a synchronous one (a value the structured clone refuses)
 * aborts the transaction explicitly in src/lib/assetDb.js. Neither can leave
 * half of the pair behind.
 *
 * A record with NO workspace is written exactly as it always was — one put
 * into `assets`, no queue entry, no second store touched — so the local-only
 * path keeps its current behaviour and cost.
 *
 * The resolved promise remains the LOCAL WRITE CONFIRMATION every insertion
 * path depends on: callers still must not put a reference into a document
 * until it resolves.
 */
export async function saveNewAsset(record) {
  if (!record || !record.id) throw new Error("Cannot save an asset without an id");
  const workspaceId = record.workspaceId;
  if (workspaceId === null || workspaceId === undefined) {
    await txRequest("readwrite", (store) => store.put(record));
    return record.id;
  }
  // A record CLAIMING a workspace that could never be addressed as a Storage
  // path is refused rather than stored: it would be owed to a workspace no
  // upload could name. `makeAssetRecord` normalises such a value to null, so
  // this is a fail-closed guard, not a path the product can reach.
  if (!isQueueableWorkspaceId(workspaceId)) {
    throw new Error("An asset cannot be owned by an invalid workspace id");
  }
  // Built BEFORE the transaction opens: a rejected entry must never be the
  // reason a transaction aborts halfway.
  const entry = makeAssetUploadEntry({
    workspaceId,
    assetId: record.id,
    kind: record.kind,
    at: record.createdAt,
  });
  await assetDbTransaction([STORE, ASSET_UPLOAD_QUEUE_STORE], "readwrite", (stores) => {
    stores[STORE].put(record);
    stores[ASSET_UPLOAD_QUEUE_STORE].put(entry);
  });
  return record.id;
}

/**
 * Build and persist one NEW asset under the ACTIVE workspace scope.
 * The single place every `create…Asset` below goes through, so none of them
 * can grow its own idea of tagging, queueing or ordering.
 */
async function createScopedAsset({ kind, name, blob, metadata }) {
  const record = makeAssetRecord({
    id: newId(),
    kind,
    name,
    blob,
    metadata,
    workspaceId: activeAssetWorkspaceId(),
  });
  await saveNewAsset(record);
  return record.id;
}

/** Resolves to the asset record ({ id, kind, ..., blob }) or null when absent. */
export async function getAsset(id) {
  if (!id) return null;
  const rec = await txRequest("readonly", (store) => store.get(id));
  return rec || null;
}

/**
 * Remove one asset AND the upload identity it may still owe the cloud, in ONE
 * transaction.
 *
 * This is the rollback path of every insertion sequence (editorImageInsert,
 * editorFileInsert, photoAnnotationSave, the Template attachment flows): when
 * the reference could not be made, the bytes are provably unreferenced and are
 * deleted. A pending queue entry left behind would name bytes that no longer
 * exist and would be uploaded — or retried forever — for nothing, so it goes
 * with them.
 *
 * WHICH WORKSPACE'S QUEUE ENTRY IS REMOVED IS NEVER INFERRED FROM THE SESSION.
 * It comes from the RECORD being deleted, read inside the same transaction —
 * the asset's own statement of who owns it. A caller that must delete a queue
 * entry whose record is already gone passes the originating workspace
 * EXPLICITLY (`{ workspaceId }`); with neither, no queue entry is touched.
 *
 * The ambient alternative — falling back to whichever workspace happens to be
 * active — is what this deliberately does not do. A rollback is asynchronous:
 * it can land after a sign-out and a sign-in as another account, and an
 * ambient owner would then aim the delete at the NEW workspace's queue. The
 * rollback paths never need it, because they run while the record they created
 * still exists and therefore still names its own workspace.
 *
 * This function does NOT delete anything in the cloud. Cloud collection is the
 * approved mark-and-sweep, and it is not this phase's work.
 *
 * @param {string} id
 * @param {{ workspaceId?: string }} [options] the ORIGINATING workspace, for
 *        the caller that knows it and whose record may already be gone.
 */
export async function deleteAsset(id, { workspaceId } = {}) {
  if (!id) return;
  const declaredOwner = isQueueableWorkspaceId(workspaceId) ? workspaceId : null;
  await assetDbTransaction([STORE, ASSET_UPLOAD_QUEUE_STORE], "readwrite", (stores) => {
    const store = stores[STORE];
    const queue = stores[ASSET_UPLOAD_QUEUE_STORE];
    const read = store.get(id);
    read.onsuccess = () => {
      const existing = read.result;
      const recordOwner =
        existing && isQueueableWorkspaceId(existing.workspaceId) ? existing.workspaceId : null;
      // The record's own owner wins; the caller's declaration is the fallback
      // for a record that is already gone. Never the active session.
      const owner = recordOwner || declaredOwner;
      if (owner) queue.delete([owner, id]);
      store.delete(id);
    };
  });
}

/** Why a downloaded asset was not written. */
export const DOWNLOADED_ASSET_REASON = Object.freeze({
  ALREADY_PRESENT: "already-present",
  FOREIGN_WORKSPACE: "foreign-workspace",
  LOCAL_CONFLICT: "local-conflict",
});

/**
 * Whether a stored record and a downloaded one are the SAME asset.
 *
 * Kind and byte length only. A name is display metadata and may legitimately
 * differ between devices; the bytes and what the asset IS may not. Pure, so
 * the rule is testable without IndexedDB.
 */
export function describesSameAsset(existing, incoming) {
  if (!existing || !incoming) return false;
  if ((existing.kind || null) !== (incoming.kind || null)) return false;
  const a = typeof existing.size === "number" ? existing.size : existing.blob ? existing.blob.size : null;
  const b = typeof incoming.size === "number" ? incoming.size : incoming.blob ? incoming.blob.size : null;
  return a !== null && b !== null && a === b;
}

/**
 * Store bytes DOWNLOADED from the workspace's cloud copy (Production
 * Readiness Phase 7.5) — the one local write that is not a local creation.
 *
 * It differs from `saveNewAsset` in the two ways that matter:
 *
 *   NO QUEUE ENTRY   the workspace already holds these bytes; that is where
 *                    they came from. Queueing them would upload the account's
 *                    own object back to itself, and the create-only rule
 *                    would refuse it.
 *   NEVER OVERWRITES a record already standing under this id is inspected,
 *                    never replaced. Three outcomes, decided inside ONE
 *                    transaction so no concurrent write can land between the
 *                    look and the decision:
 *                      foreign-workspace  the record belongs to another
 *                                         workspace — refused outright
 *                      local-conflict     the record is this workspace's (or
 *                                         legacy) but describes something
 *                                         else — refused, nothing changed
 *                      already-present    it is the same asset; the download
 *                                         is redundant and the write is a
 *                                         no-op, which is what makes a
 *                                         concurrent download idempotent
 *
 * A LEGACY record (no workspace) that matches is left exactly as it is: it is
 * not re-tagged with a workspace here, because associating pre-Phase-7.2
 * assets with an account is an explicit, user-facing migration (Phase 7.6).
 *
 * @returns {Promise<{ stored: boolean, reason: string|null }>}
 */
export async function saveDownloadedAsset(record) {
  if (!record || !record.id) throw new Error("Cannot save an asset without an id");
  if (!isQueueableWorkspaceId(record.workspaceId)) {
    throw new Error("A downloaded asset must name the workspace it was downloaded for");
  }
  return assetDbTransaction(STORE, "readwrite", (stores) => {
    const store = stores[STORE];
    let outcome = { stored: false, reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT };
    const read = store.get(record.id);
    read.onsuccess = () => {
      const existing = read.result;
      if (!existing) {
        store.put(record);
        outcome = { stored: true, reason: null };
        return;
      }
      const owner =
        existing && isQueueableWorkspaceId(existing.workspaceId) ? existing.workspaceId : null;
      if (owner && owner !== record.workspaceId) {
        outcome = { stored: false, reason: DOWNLOADED_ASSET_REASON.FOREIGN_WORKSPACE };
        return;
      }
      outcome = describesSameAsset(existing, record)
        ? { stored: false, reason: DOWNLOADED_ASSET_REASON.ALREADY_PRESENT }
        : { stored: false, reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT };
    };
    return () => outcome;
  });
}

export async function assetExists(id) {
  if (!id) return false;
  const count = await txRequest("readonly", (store) => store.count(id));
  return (count || 0) > 0;
}

/**
 * Enumerates stored assets WITHOUT their Blobs — `{ id, kind, name, mimeType,
 * size, createdAt, updatedAt, metadata }` — optionally filtered by kind. This
 * is the listing a reference-aware sweep needs (src/lib/assetReferences.js);
 * it never loads binary data into memory for the whole store.
 */
export async function listAssets({ kind } = {}) {
  const rows = await txRequest("readonly", (store) => store.getAll());
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((rec) => rec && rec.id && (!kind || rec.kind === kind))
    .map(({ blob, ...meta }) => meta);
}

/** Every stored asset id. */
export async function listAssetIds() {
  const keys = await txRequest("readonly", (store) => store.getAllKeys());
  return Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [];
}

// Creates and persists a NEW user-uploaded logo asset. Validates first; on
// invalid input it throws with a user-facing message and creates NO record, so
// the caller can preserve the previous logo. User uploads get a fresh UUID id.
export async function createLogoAsset(file) {
  const check = validateLogoFile(file);
  if (!check.ok) throw new Error(check.error);
  return createScopedAsset({ kind: "logo", name: file.name || null, blob: file });
}

// Creates and persists a NEW note-Photo asset (validation is the caller's
// responsibility via validatePhotoFile so per-file errors can be collected for
// multi-select uploads). Resolves to the new asset id after the IndexedDB
// transaction completes — a resolved promise IS the write confirmation.
//
// `blob` may be a normalized Blob rather than the picked File (see
// src/lib/imageProcessing.js), which is why `name` can be supplied separately —
// a Blob produced by re-encoding has no filename of its own.
export async function createPhotoAsset(blob, metadata, name) {
  return createScopedAsset({
    kind: ASSET_KIND_NOTE_PHOTO,
    name: name || blob.name || null,
    blob,
    metadata,
  });
}

// Creates and persists a NEW Free-form editor-image asset. Same contract as
// createPhotoAsset: the resolved promise IS the write confirmation, and the
// caller must not insert an editor node until it resolves.
export async function createEditorImageAsset(blob, { name, metadata } = {}) {
  return createScopedAsset({
    kind: ASSET_KIND_EDITOR_IMAGE,
    name: name || blob.name || null,
    blob,
    metadata,
  });
}

// Creates and persists a NEW Free-form file-attachment asset. Same contract as
// createPhotoAsset: the resolved promise IS the write confirmation, and the
// caller must not insert an editor node until it resolves.
//
// `blob` may be the picked File itself, or the same bytes re-wrapped with the
// canonical MIME type when the browser reported a generic one — which is why
// `name` is supplied separately (a re-wrapped Blob has no filename of its own).
// The record's mimeType comes from the Blob, so the stored type is always the
// one the safe-open policy will later read.
export async function createEditorFileAsset(blob, { name, metadata } = {}) {
  return createScopedAsset({
    kind: ASSET_KIND_EDITOR_FILE,
    name: name || blob.name || null,
    blob,
    metadata,
  });
}

// Creates and persists a NEW note-File asset. Same contract as createPhotoAsset.
export async function createNoteFileAsset(file, metadata) {
  return createScopedAsset({
    kind: ASSET_KIND_NOTE_FILE,
    name: file.name || null,
    blob: file,
    metadata,
  });
}
