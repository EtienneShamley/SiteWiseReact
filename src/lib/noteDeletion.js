// src/lib/noteDeletion.js
//
// What deleting a NOTE means for the data it owns — the cascade the tree
// entry's removal was previously missing (docs/PRODUCTION_READINESS_AUDIT.md
// P0-3: content, instance and preferences stayed behind as ghost data).
//
// Owned solely by the note, removed here:
//   - its Free-form content            (src/lib/noteContentStorage.js)
//   - its Template instance            (src/lib/templateModel.js)
//   - its per-note preferences         (src/lib/notePreferences.js)
//
// Handled by the caller from React state, persisted by AppStateContext's own
// effects: the tree entry itself and the note→PDF reference (a note never
// owns its PDF — the PDF is a standalone document).
//
// NOT touched here, deliberately: asset Blobs (images, files, renditions) and
// template versions. Asset references are legitimately many-to-one — paste
// copies a reference, a duplicated template shares a logo, a rendition names
// its original — and the only honest test for "unreferenced" is a sweep over
// every live note, version and rendition (src/lib/assetReferences.js is that
// sweep's input). Deleting on a guess would destroy evidence another note
// still shows. So a note's own references disappear with its content and
// instance, and the Blobs become candidates for a later reference-aware
// sweep. That is the documented, deferred boundary.
//
// Ordering and failure: `deleteNoteData` is one step of the confirmed
// deletion transaction in src/lib/treeDeletion.js — the tree is written
// first, then each note's stores are removed and confirmed here, and a failure
// is COMPENSATED from the snapshot taken beforehand (`snapshotNoteData` /
// `restoreNoteData`). Preference removal is best-effort and never decides the
// outcome.

import { deleteNoteContent, getNoteContent, saveNoteContent } from "./noteContentStorage";
import {
  deleteNoteTemplateInstance,
  getNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
} from "./templateModel";
import { loadCoordSystem, removeNotePreferences, saveCoordSystem } from "./notePreferences";
import { loadTranscriptionLanguageMap, saveTranscriptionLanguage } from "./transcriptionLanguage";

export const NOTE_DATA_STORE = Object.freeze({
  CONTENT: "content",
  TEMPLATE_INSTANCE: "templateInstance",
});

/**
 * Removes everything a note solely owns in local storage.
 *
 * @returns {{ ok: boolean, removed: string[], failed: Array<{ store: string, error: Error }> }}
 * Never throws.
 */
export function deleteNoteData(noteId) {
  const removed = [];
  const failed = [];
  if (typeof noteId !== "string" || !noteId) {
    return { ok: false, removed, failed: [{ store: "noteId", error: new Error("A note id is required") }] };
  }

  try {
    if (deleteNoteContent(noteId)) removed.push(NOTE_DATA_STORE.CONTENT);
  } catch (error) {
    failed.push({ store: NOTE_DATA_STORE.CONTENT, error });
  }

  try {
    if (deleteNoteTemplateInstance(noteId)) removed.push(NOTE_DATA_STORE.TEMPLATE_INSTANCE);
  } catch (error) {
    failed.push({ store: NOTE_DATA_STORE.TEMPLATE_INSTANCE, error });
  }

  // Preferences are forgotten last and never decide the outcome.
  removeNotePreferences(noteId);

  return { ok: failed.length === 0, removed, failed };
}

/**
 * Everything a note owns, read BEFORE a deletion so a failed transaction can
 * put it back (src/lib/treeDeletion.js). Absent stores read as null.
 */
export function snapshotNoteData(noteId) {
  const languages = loadTranscriptionLanguageMap();
  return {
    content: getNoteContent(noteId),
    instance: getNoteTemplateInstance(noteId),
    coordSystem: loadCoordSystem(noteId),
    transcriptionLanguage: noteId in languages ? languages[noteId] : null,
  };
}

/**
 * Compensation: writes a snapshot back. Only stores the snapshot holds are
 * written; the durable ones (content, instance) are confirmed, preferences
 * are best-effort. Never throws.
 *
 * @returns {{ ok: boolean, failed: string[] }}
 */
export function restoreNoteData(noteId, snapshot) {
  const failed = [];
  if (!snapshot || typeof noteId !== "string" || !noteId) return { ok: true, failed };
  // Idempotent: a store whose removal never landed (the write was refused)
  // still holds the snapshot and is not rewritten.
  if (typeof snapshot.content === "string" && getNoteContent(noteId) !== snapshot.content) {
    try {
      saveNoteContent(noteId, snapshot.content);
    } catch {
      failed.push(NOTE_DATA_STORE.CONTENT);
    }
  }
  if (snapshot.instance && typeof snapshot.instance === "object" && !getNoteTemplateInstance(noteId)) {
    try {
      saveNoteTemplateInstanceOrThrow(snapshot.instance);
    } catch {
      failed.push(NOTE_DATA_STORE.TEMPLATE_INSTANCE);
    }
  }
  if (snapshot.coordSystem) saveCoordSystem(noteId, snapshot.coordSystem);
  if (snapshot.transcriptionLanguage) saveTranscriptionLanguage(noteId, snapshot.transcriptionLanguage);
  return { ok: failed.length === 0, failed };
}

/** The user-facing message for a deletion that could not complete. Names the
 *  note, never an exception, a key or storage internals. */
export function noteDeletionFailureMessage(title) {
  const name = typeof title === "string" && title.trim() ? `"${title.trim()}"` : "the note";
  return `Could not delete ${name}: its stored content could not be removed. Browser storage may be full — the note has been kept.`;
}
