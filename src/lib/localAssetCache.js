// src/lib/localAssetCache.js
//
// WHERE this browser keeps the bytes of an asset — and the boundary that means
// nothing else has to know.
//
// NoteWise stores binary data in two different IndexedDB databases, for
// reasons that are correct and are not going to change:
//
//   general assets   `notewise-assets` → `assets`, one record per Blob
//                    (src/lib/assetStorage.js): logos, note Photo and File
//                    evidence, Free-form editor images and file attachments.
//   PDF SOURCE bytes `notewise-pdf-editor` → `pdfDocBytes`, keyed by a
//                    document's SOURCE id (src/lib/pdfStorage.js). A PDF's
//                    bytes are one immutable version of a file, replaced by
//                    storing a NEW source id rather than overwriting; the
//                    editor reads them as a Uint8Array and hands them to
//                    pdf.js. Copying them into `assets` as well would double
//                    every PDF on the device and create a second copy that
//                    could disagree with the first.
//
// Before this module every reader knew which of the two it was talking to.
// That was workable while "read an asset" meant "read this browser's disk";
// it stops being workable the moment a read may have to fall back to the
// workspace's cloud copy, because the fallback would have to be written twice
// and kept in step by discipline. So the ROUTE is decided here, once, from the
// asset's KIND, and src/lib/assetReader.js above it can be written as if there
// were one store.
//
// IT NOW WRITES, TOO (Production Readiness Phase 7.5). A read that missed
// locally and was satisfied from the workspace's cloud copy has to put the
// bytes somewhere, and "somewhere" is the same routing decision this module
// already owns — `writeDownloadedAsset` below. It is deliberately NOT a
// second creation path: a downloaded asset is never queued for upload, never
// tagged as locally created, and never allowed to overwrite a record that
// contradicts it or one another workspace owns.
//
// WHAT IS PRESERVED, deliberately:
//   - a general asset is returned as the STORED RECORD, unchanged, so every
//     existing reader's own kind check, MIME policy and metadata reads keep
//     working against exactly what they read before;
//   - the `kind` argument ROUTES; it does not replace a caller's kind policy.
//     Which asset kinds a surface may open is a security decision that stays
//     with that surface (src/lib/editorFileAttachments.js →
//     `isAcceptedFileAssetKind`, src/lib/templateExportAssets.js), and it is
//     still made from the record's own stored kind, never from a filename,
//     an extension or a serialized attribute;
//   - a PDF's bytes stay in `pdfDocBytes`, keyed by source id, and are never
//     duplicated into the asset store.

import {
  DOWNLOADED_ASSET_REASON,
  assetExists,
  getAsset,
  makeAssetRecord,
  saveDownloadedAsset,
} from "./assetStorage";
import { loadPdfBytes, pdfSourceByteLength, savePdfBytes } from "./pdfStorage";
import { isValidAssetSegment } from "./cloud/assetPaths";

/**
 * The SOURCE BYTES of one PDF document. Not a record in the asset store: it
 * is the immutable file a `pdfDocs` entry names through its `sourceAssetId`
 * (src/lib/pdfDocuments.js → `pdfSourceId`, which falls back to the document
 * id for a document created before source ids existed).
 */
export const ASSET_KIND_PDF_SOURCE = "pdf-source";

/** Every kind whose bytes live in the general asset store. */
export const GENERAL_ASSET_KINDS = Object.freeze([
  "logo",
  "note-photo",
  "note-file",
  "editor-image",
  "editor-file",
]);

/** True for the one kind that is routed to the PDF store. */
export function isPdfSourceKind(kind) {
  return kind === ASSET_KIND_PDF_SOURCE;
}

/**
 * Read one asset's bytes from this browser, whichever store holds them.
 *
 * @param {string} assetId
 * @param {{ kind?: string|null }} [options] `kind` ROUTES the read. Anything
 *        other than `pdf-source` — including no kind at all — is a general
 *        asset; a caller that does not know the kind gets the general store,
 *        which is where every kind but PDF source bytes lives.
 *
 * @returns for a general asset, the stored record:
 *   `{ id, kind, name, mimeType, size, blob, createdAt, updatedAt, metadata,
 *      workspaceId }`
 * for `pdf-source`:
 *   `{ id, kind: "pdf-source", name, mimeType: "application/pdf", size,
 *      bytes: Uint8Array, updatedAt, workspaceId: null }`
 * and `null` when this browser does not hold it. The two shapes differ
 * because their consumers do: an image needs a Blob to make an object URL
 * from, and pdf.js needs bytes it owns.
 */
export async function readLocalAsset(assetId, { kind = null } = {}) {
  if (!assetId) return null;
  if (isPdfSourceKind(kind)) {
    const rec = await loadPdfBytes(assetId);
    if (!rec || !rec.bytes) return null;
    return {
      id: assetId,
      kind: ASSET_KIND_PDF_SOURCE,
      name: rec.name || null,
      mimeType: "application/pdf",
      size: rec.bytes.byteLength,
      bytes: rec.bytes,
      updatedAt: rec.updatedAt || null,
      // PDF source bytes are not workspace-tagged locally: the document that
      // names them is a durable, workspace-scoped record already, and the
      // bytes are addressed only through it.
      workspaceId: null,
    };
  }
  const asset = await getAsset(assetId);
  return asset && asset.blob ? asset : null;
}

/**
 * A Blob's bytes.
 *
 * `Blob.arrayBuffer()` is the direct route and is what every supported browser
 * provides; `FileReader` is the fallback for a platform that does not (an
 * older Safari, and the jsdom the component suites run under), so the PDF path
 * is not silently unavailable there.
 */
async function blobBytes(blob) {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  const buffer = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read the downloaded asset"));
    reader.readAsArrayBuffer(blob);
  });
  return new Uint8Array(buffer);
}

/**
 * Cache the bytes of an asset DOWNLOADED from the workspace's cloud copy.
 *
 * The same routing as the read: a `pdf-source` goes to the PDF byte store
 * under its source id, everything else to the asset store as a workspace-owned
 * record. What it never does, in either store:
 *
 *   - enqueue an upload. These bytes came FROM the account; owing them back to
 *     it would upload the workspace's own object onto its own immutable path.
 *   - present a download as a local creation. The record carries the workspace
 *     that owns it and the cloud document's own `createdAt`, `mimeType`,
 *     `name`, `metadata` and `sourceAssetId` — the validated cloud identity,
 *     not a fresh local one.
 *   - overwrite. A record already standing under this id is inspected and
 *     never replaced (src/lib/assetStorage.js -> `saveDownloadedAsset`); the
 *     same asset arriving twice is idempotent, and a contradicting one is a
 *     refusal.
 *
 * @param {{
 *   workspaceId: string, assetId: string, assetKind: string,
 *   blob: Blob, mimeType: string, size: number,
 *   name?: string|null, metadata?: object|null, sourceAssetId?: string|null,
 *   createdAt?: number|null,
 * }} input
 * @returns {Promise<{ ok: boolean, reason?: string, reused?: boolean }>}
 */
export async function writeDownloadedAsset({
  workspaceId,
  assetId,
  assetKind,
  blob,
  mimeType,
  size,
  name = null,
  metadata = null,
  sourceAssetId = null,
  createdAt = null,
} = {}) {
  if (!isValidAssetSegment(workspaceId) || !isValidAssetSegment(assetId)) {
    return { ok: false, reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT };
  }
  if (!blob || typeof blob.size !== "number" || blob.size === 0) {
    return { ok: false, reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT };
  }
  // The size the workspace recorded is the size that must have arrived. The
  // caller has already checked it against the Blob; checking again here means
  // no future caller can write bytes this boundary was told were a different
  // length.
  if (Number.isFinite(size) && size !== blob.size) {
    return { ok: false, reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT };
  }

  if (isPdfSourceKind(assetKind)) {
    const bytes = await blobBytes(blob);
    const existing = await loadPdfBytes(assetId);
    if (existing && existing.bytes && existing.bytes.byteLength > 0) {
      // A PDF source is one IMMUTABLE version of a file: bytes of the same
      // length under the same source id are that version, already here.
      return existing.bytes.byteLength === bytes.byteLength
        ? { ok: true, reused: true }
        : { ok: false, reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT };
    }
    await savePdfBytes(assetId, bytes, name || null);
    return { ok: true, reused: false };
  }

  const base = makeAssetRecord({
    id: assetId,
    kind: assetKind,
    name,
    blob,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    workspaceId,
  });
  const record = {
    ...base,
    // The cloud document's facts win over the local clock and over a Blob
    // whose type the platform did not report: they are what the workspace
    // says this asset IS.
    createdAt: Number.isInteger(createdAt) && createdAt > 0 ? createdAt : base.createdAt,
    mimeType: base.mimeType || (typeof mimeType === "string" && mimeType ? mimeType : null),
    ...(typeof sourceAssetId === "string" && sourceAssetId ? { sourceAssetId } : {}),
  };
  const outcome = await saveDownloadedAsset(record);
  if (outcome.stored) return { ok: true, reused: false };
  if (outcome.reason === DOWNLOADED_ASSET_REASON.ALREADY_PRESENT) return { ok: true, reused: true };
  return { ok: false, reason: outcome.reason };
}

/**
 * How many bytes this browser holds for one asset, or 0 when it holds none.
 * Same routing as the read, and the same reason this module exists: a caller
 * that needs a SIZE should not have to know which of the two databases the
 * bytes are in. Nothing is copied and no Blob is opened.
 */
export async function localAssetSize(assetId, { kind = null } = {}) {
  if (!assetId) return 0;
  if (isPdfSourceKind(kind)) return pdfSourceByteLength(assetId);
  const asset = await getAsset(assetId);
  if (!asset) return 0;
  if (typeof asset.size === "number" && asset.size > 0) return asset.size;
  return asset.blob && typeof asset.blob.size === "number" ? asset.blob.size : 0;
}

/**
 * Whether this browser holds the bytes, without reading them. Same routing.
 */
export async function localAssetExists(assetId, { kind = null } = {}) {
  if (!assetId) return false;
  if (isPdfSourceKind(kind)) {
    const rec = await loadPdfBytes(assetId);
    return Boolean(rec && rec.bytes && rec.bytes.byteLength > 0);
  }
  return assetExists(assetId);
}
