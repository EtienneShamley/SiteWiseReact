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

export const NOTE_PDF_REFS_KEY = "notewise-note-pdf-refs-v1";

export function getNotePdfRefs() {
  try {
    const raw = localStorage.getItem(NOTE_PDF_REFS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveNotePdfRefs(map) {
  localStorage.setItem(NOTE_PDF_REFS_KEY, JSON.stringify(map || {}));
}

export function getNotePdfRef(map, noteId) {
  if (!noteId) return null;
  const refs = map || getNotePdfRefs();
  return refs[noteId] || null;
}
