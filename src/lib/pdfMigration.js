// src/lib/pdfMigration.js
//
// One-time migration from the legacy note-scoped PDF model (v1 IndexedDB stores
// keyed by noteId) to the canonical PDF document model (documentId-keyed stores
// + a metadata registry). It exists so existing local PDF data is preserved,
// not silently orphaned, when the app upgrades.
//
// PDFs are global standalone documents, so each legacy PDF becomes a canonical
// GLOBAL document (projectId/folderId null), reachable in the global PDF
// library. For each legacy note-keyed PDF it:
//   1. creates a canonical global PDF document record,
//   2. moves the bytes and annotations under the new documentId,
//   3. sets the originating note's pdfDocId reference,
//   4. removes the legacy record.
//
// Guarded by a localStorage flag so it never runs twice.

import {
  listLegacyPdfRecords,
  loadLegacyAnnotations,
  removeLegacyNoteRecord,
  savePdfBytes,
  saveAnnotations,
} from "./pdfStorage";
import { getPdfDocs, savePdfDocs } from "./pdfDocuments";
import { getNotePdfRefs, saveNotePdfRefs } from "./notePdfRefs";
import { newId } from "./id";

export const PDF_DOCID_MIGRATION_GUARD = "notewise-pdf-docid-migration-v1-complete";

/**
 * Runs the migration at most once. Resolves to a summary:
 *   { migrated: boolean, count: number }
 * Rejects if any storage step fails, so the caller can surface the error and
 * (importantly) leave the guard UNSET so it can be retried next load.
 */
export async function migrateLegacyNotePdfs() {
  if (localStorage.getItem(PDF_DOCID_MIGRATION_GUARD)) {
    return { migrated: false, count: 0 };
  }

  const legacy = await listLegacyPdfRecords();
  if (!legacy.length) {
    localStorage.setItem(PDF_DOCID_MIGRATION_GUARD, "1");
    return { migrated: false, count: 0 };
  }

  const docs = getPdfDocs();
  const refs = getNotePdfRefs();

  let count = 0;
  for (const rec of legacy) {
    const documentId = newId();
    const now = rec.updatedAt || Date.now();

    // 2. Move bytes + annotations under the new documentId FIRST, so metadata
    //    is only committed for data that actually persisted.
    await savePdfBytes(documentId, rec.bytes, rec.name);
    const anns = await loadLegacyAnnotations(rec.noteId);
    await saveAnnotations(documentId, anns);

    // 1. Canonical GLOBAL registry record (no project/folder ownership).
    docs[documentId] = {
      id: documentId,
      projectId: null,
      folderId: null,
      name: rec.name || "Recovered PDF",
      createdAt: now,
      updatedAt: now,
    };

    // 3. Preserve the note reference (harmless if that note no longer exists).
    if (rec.noteId) refs[rec.noteId] = documentId;

    // 4. Remove the legacy record now that it has been moved.
    await removeLegacyNoteRecord(rec.noteId);
    count += 1;
  }

  // Persist metadata only after all byte/annotation moves succeeded.
  savePdfDocs(docs);
  saveNotePdfRefs(refs);

  localStorage.setItem(PDF_DOCID_MIGRATION_GUARD, "1");
  return { migrated: true, count };
}
