// src/lib/pdfDocuments.js
//
// Canonical PDF document registry — the lightweight metadata layer that makes a
// PDF an independent, folder-level resource rather than something bound to a
// note. One record per PDF:
//
//   { id, sourceAssetId, projectId, folderId, name, createdAt, updatedAt }
//
// Placement mirrors the note hierarchy exactly:
//   - project folder PDF -> projectId set,  folderId = the project folder id
//   - root folder PDF    -> projectId null,  folderId = the root folder id
//   - root-level PDF     -> projectId null,  folderId null
//
// The registry is metadata only. The PDF's ANNOTATIONS live in IndexedDB
// keyed by this `id`; its SOURCE BYTES are keyed by `sourceAssetId`
// (src/lib/pdfStorage.js) — a separate, immutable identity for one version of
// the file. Replacing the file (Production Readiness Phase 7.0) mints a new
// `sourceAssetId` under the SAME document id, so note links, the library row
// and the editor keep their identity while no byte store — local cache or
// cloud object — is ever overwritten in place under an old id. Records
// created before this field existed have no `sourceAssetId`: `pdfSourceId`
// resolves them to `id`, which is where their bytes have always been.
//
// Persisted in localStorage under a versioned key. `save*` throws on failure
// so callers can surface storage errors instead of silently losing data.

import { newId } from "./id";
import { DURABLE_KEYS, readDurableMap, writeDurableRecord } from "./durableStorage";

export const PDF_DOCS_KEY = DURABLE_KEYS.pdfDocs;

/** Loads the registry map. Absent data yields an empty map; a malformed
 *  record is set aside for recovery first (src/lib/durableStorage.js). */
export function getPdfDocs() {
  return readDurableMap(PDF_DOCS_KEY).map;
}

/** Persists the registry map. Throws on quota/serialization failure. */
export function savePdfDocs(map) {
  writeDurableRecord(PDF_DOCS_KEY, map || {});
}

export function getPdfDoc(id) {
  return (id && getPdfDocs()[id]) || null;
}

/**
 * Lists PDFs for a given project + folder scope, matching the note model:
 *   listPdfDocs(projectId, folderId)
 * Nulls are normalized so root-level (null,null) and root-folder (null,fid)
 * scopes filter correctly. Sorted oldest-first for a stable order.
 */
export function listPdfDocs(map, projectId, folderId) {
  const docs = map || getPdfDocs();
  const pid = projectId || null;
  const fid = folderId || null;
  return Object.values(docs)
    .filter((d) => (d.projectId || null) === pid && (d.folderId || null) === fid)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** The id under which a document's CURRENT source bytes are stored. */
export function pdfSourceId(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (typeof doc.sourceAssetId === "string" && doc.sourceAssetId) return doc.sourceAssetId;
  return typeof doc.id === "string" && doc.id ? doc.id : null;
}

/**
 * Builds a new registry record. Pure — does not persist. The caller owns the
 * map so byte/annotation writes and the metadata write can be coordinated.
 * A fresh document gets its own `sourceAssetId`, distinct from `id`.
 */
export function makePdfDoc({ projectId = null, folderId = null, name, now = Date.now() } = {}) {
  return {
    id: newId(),
    sourceAssetId: newId(),
    projectId: projectId || null,
    folderId: folderId || null,
    name: name || "Untitled PDF",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The registry record after its file was replaced: same id, provenance and
 * creation time; the new `sourceAssetId`; the new name when one is given;
 * `updatedAt` stamped. Pure — never mutates its input.
 */
export function withReplacedPdfSource(doc, { sourceAssetId, name, now = Date.now() } = {}) {
  if (!doc || typeof doc !== "object" || !doc.id) throw new Error("A registry record is required");
  if (typeof sourceAssetId !== "string" || !sourceAssetId) throw new Error("A new source id is required");
  const trimmed = typeof name === "string" ? name.trim() : "";
  return {
    ...doc,
    sourceAssetId,
    name: trimmed || doc.name || "Untitled PDF",
    updatedAt: now,
  };
}
