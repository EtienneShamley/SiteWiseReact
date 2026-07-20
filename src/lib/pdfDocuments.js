// src/lib/pdfDocuments.js
//
// Canonical PDF document registry — the lightweight metadata layer that makes a
// PDF an independent, folder-level resource rather than something bound to a
// note. One record per PDF:
//
//   { id, projectId, folderId, name, createdAt, updatedAt }
//
// Placement mirrors the note hierarchy exactly:
//   - project folder PDF -> projectId set,  folderId = the project folder id
//   - root folder PDF    -> projectId null,  folderId = the root folder id
//   - root-level PDF     -> projectId null,  folderId null
//
// The registry is metadata only. The PDF bytes and annotations live in
// IndexedDB keyed by the same `id` (src/lib/pdfStorage.js). Persisted in
// localStorage under a versioned key. `save*` throws on failure so callers can
// surface storage errors instead of silently losing data.

import { newId } from "./id";

export const PDF_DOCS_KEY = "notewise-pdf-docs-v1";

/** Loads the registry map. Malformed/absent data yields an empty map. */
export function getPdfDocs() {
  try {
    const raw = localStorage.getItem(PDF_DOCS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Persists the registry map. Throws on quota/serialization failure. */
export function savePdfDocs(map) {
  localStorage.setItem(PDF_DOCS_KEY, JSON.stringify(map || {}));
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

/**
 * Builds a new registry record. Pure — does not persist. The caller owns the
 * map so byte/annotation writes and the metadata write can be coordinated.
 */
export function makePdfDoc({ projectId = null, folderId = null, name }) {
  const now = Date.now();
  return {
    id: newId(),
    projectId: projectId || null,
    folderId: folderId || null,
    name: name || "Untitled PDF",
    createdAt: now,
    updatedAt: now,
  };
}
