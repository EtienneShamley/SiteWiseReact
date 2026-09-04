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

import { getAsset, assetExists } from "./assetStorage";
import { loadPdfBytes } from "./pdfStorage";

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
