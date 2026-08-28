// src/lib/noteTombstones.js
//
// The session's record of COMMITTED note deletions — the one guard that stops
// a late asynchronous completion (a row Refine that returns after its note was
// deleted, a coalesced Free-form write, a PDF import that resolves late, a
// preference effect) from recreating a deleted note's durable records.
//
// Enforced at the DATA BOUNDARY, not in components: every owner module that
// writes note-owned data (noteContentStorage, templateModel instances,
// notePreferences, transcriptionLanguage, the note→PDF link in AppStateContext)
// asks `isNoteDeleted` first and refuses with `NoteDeletedError` (or, for a
// best-effort preference write, returns false). Deletions and reads are never
// refused — a stale operation may still clean up.
//
// Session-scoped by design: an in-flight promise or timer cannot outlive the
// page, so neither does the tombstone. Ids are minted with a timestamp and
// random suffix, so a NEW note can never reuse a deleted id by accident; note
// creation still calls `allowNoteId` so an explicit reuse is never blocked.

const deleted = new Set();

export class NoteDeletedError extends Error {
  constructor(noteId) {
    super("This note has been deleted; its data was not written.");
    this.name = "NoteDeletedError";
    this.noteId = noteId;
  }
}

/** Records that a deletion of these notes has COMMITTED. */
export function markNotesDeleted(noteIds) {
  for (const id of noteIds || []) {
    if (typeof id === "string" && id) deleted.add(id);
  }
}

/** True once a deletion of this note has committed in this session. */
export function isNoteDeleted(noteId) {
  return typeof noteId === "string" && deleted.has(noteId);
}

/** Throws NoteDeletedError when a write would resurrect a deleted note. */
export function assertNoteWritable(noteId) {
  if (isNoteDeleted(noteId)) throw new NoteDeletedError(noteId);
}

/** A note is being (re)created under this id: it may be written again. */
export function allowNoteId(noteId) {
  if (typeof noteId === "string") deleted.delete(noteId);
}

/** Test-only. */
export function __resetNoteTombstonesForTests() {
  deleted.clear();
}
