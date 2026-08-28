// src/lib/noteContentStorage.js
//
// The owner of Free-form note content — the `{ [noteId]: html }` record that
// was previously written and read by three components with their own copy of
// the key literal.
//
// The API is PER NOTE: read one note, write one note, delete one note. The
// storage representation underneath is still the one map under one key, for
// compatibility with every note ever saved — a map that was written before
// this module existed reads back unchanged. Nothing outside this module knows
// that, which is what lets a later backend store one document per note
// without touching a caller.
//
// Writes throw when they cannot be trusted (src/lib/durableStorage.js); the
// caller reports that as a failed save. Reads never throw and never treat a
// corrupt record as empty without setting it aside first.

import { DURABLE_KEYS, readDurableMap, writeDurableRecord } from "./durableStorage";
import { assertNoteWritable } from "./noteTombstones";

export const NOTE_CONTENT_KEY = DURABLE_KEYS.noteContent;

function readMap(options) {
  return readDurableMap(NOTE_CONTENT_KEY, options).map;
}

function assertNoteId(noteId) {
  if (typeof noteId !== "string" || !noteId) {
    throw new Error("A note id is required");
  }
}

/** Every stored note's HTML, keyed by note id — only string entries, as a copy. */
export function loadNoteContentMap(options) {
  const raw = readMap(options);
  const map = {};
  for (const noteId of Object.keys(raw)) {
    if (typeof raw[noteId] === "string") map[noteId] = raw[noteId];
  }
  return map;
}

/** The stored HTML of one note, or null when it has never been saved. */
export function getNoteContent(noteId, options) {
  if (typeof noteId !== "string" || !noteId) return null;
  const value = readMap(options)[noteId];
  return typeof value === "string" ? value : null;
}

export function hasNoteContent(noteId, options) {
  return getNoteContent(noteId, options) !== null;
}

/** The ids of every note with stored content. */
export function listNoteContentIds(options) {
  return Object.keys(loadNoteContentMap(options));
}

/**
 * Persists one note's HTML. Other notes' entries are read from storage and
 * carried across untouched — a caller never has to hold the whole map.
 * Throws on any failure; returning is the confirmation.
 */
export function saveNoteContent(noteId, html, options) {
  assertNoteId(noteId);
  // A committed deletion is final for this session: a late asynchronous write
  // (src/lib/noteTombstones.js) must not bring the note's content back.
  assertNoteWritable(noteId);
  if (typeof html !== "string") {
    throw new Error("Note content must be a string");
  }
  const map = readMap(options);
  map[noteId] = html;
  writeDurableRecord(NOTE_CONTENT_KEY, map, options);
}

/**
 * Removes one note's stored content. A note with no entry is a no-op (nothing
 * is written). Throws when the removal could not be persisted.
 */
export function deleteNoteContent(noteId, options) {
  assertNoteId(noteId);
  const map = readMap(options);
  if (!(noteId in map)) return false;
  delete map[noteId];
  writeDurableRecord(NOTE_CONTENT_KEY, map, options);
  return true;
}
