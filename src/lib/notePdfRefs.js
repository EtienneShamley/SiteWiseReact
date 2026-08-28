// src/lib/notePdfRefs.js
//
// The note -> PDF relationship. A note stores ONLY a pdfDocId reference; the
// PDF document itself is a standalone folder-level resource that exists
// independently of any note. Modeled as a map keyed by note id so the note
// node shape (kept in the hierarchy) doesn't have to change:
//
//   { [noteId]: pdfDocId }
//
// Rules enforced by the callers (AppStateContext):
//   - Removing a note's reference must NOT delete the PDF.
//   - Deleting a PDF must clear the reference from every note pointing at it.
//
// Persisted in localStorage under a versioned key. `save` throws on failure so
// callers can surface storage errors.

import { DURABLE_KEYS, readDurableMap, writeDurableRecord } from "./durableStorage";

export const NOTE_PDF_REFS_KEY = DURABLE_KEYS.notePdfRefs;

/** Absent data yields an empty map; a malformed record is set aside for
 *  recovery first (src/lib/durableStorage.js). */
export function getNotePdfRefs() {
  return readDurableMap(NOTE_PDF_REFS_KEY).map;
}

export function saveNotePdfRefs(map) {
  writeDurableRecord(NOTE_PDF_REFS_KEY, map || {});
}

export function getNotePdfRef(map, noteId) {
  if (!noteId) return null;
  const refs = map || getNotePdfRefs();
  return refs[noteId] || null;
}
