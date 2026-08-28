// src/lib/notePreferences.js
//
// Per-note UI preferences that are keyed by note id but are NOT customer
// content: the coordinate system the location tools last used for a note, and
// (delegated to src/lib/transcriptionLanguage.js, which owns that key) the
// note's remembered transcription language.
//
// These are deliberately tolerant: a preference read never throws and a
// preference write never throws — losing one costs the user a dropdown
// choice, not their work — so none of them goes through the durable-record
// path and none of them can put a "Save failed" on screen.
//
// What this module adds is a single place a note's preferences are FORGOTTEN
// when the note is deleted (see src/lib/noteDeletion.js), so a deleted note
// leaves no per-note memory behind.

import {
  forgetTranscriptionLanguage,
  loadTranscriptionLanguageMap,
} from "./transcriptionLanguage";
import { isNoteDeleted } from "./noteTombstones";

export const COORD_SYSTEM_KEY = "sitewise-coord-system-v1";

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readMap(key, storage) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(key, map, storage) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** The remembered coordinate system for a note, or null when none. */
export function loadCoordSystem(noteId, storage = defaultStorage()) {
  if (!noteId) return null;
  const value = readMap(COORD_SYSTEM_KEY, storage)[noteId];
  return typeof value === "string" && value ? value : null;
}

/** Remembers a note's coordinate system. Never throws. */
export function saveCoordSystem(noteId, value, storage = defaultStorage()) {
  if (!noteId || typeof value !== "string" || !value) return false;
  if (isNoteDeleted(noteId)) return false; // never resurrect a deleted note's memory
  const map = readMap(COORD_SYSTEM_KEY, storage);
  if (map[noteId] === value) return true;
  map[noteId] = value;
  return writeMap(COORD_SYSTEM_KEY, map, storage);
}

/** Drops a note's coordinate-system memory. Never throws. */
export function forgetCoordSystem(noteId, storage = defaultStorage()) {
  if (!noteId) return false;
  const map = readMap(COORD_SYSTEM_KEY, storage);
  if (!(noteId in map)) return true;
  delete map[noteId];
  return writeMap(COORD_SYSTEM_KEY, map, storage);
}

/** Every note id that still has a coordinate-system memory. */
export function listCoordSystemNoteIds(storage = defaultStorage()) {
  return Object.keys(readMap(COORD_SYSTEM_KEY, storage));
}

/**
 * Forgets every per-note preference of one note. Never throws; reports which
 * preference stores could not be updated so a caller can decide whether that
 * matters (for a deletion it does not — the note itself is gone).
 */
export function removeNotePreferences(noteId, storage = defaultStorage()) {
  const failed = [];
  if (!noteId) return { ok: true, failed };
  if (!forgetCoordSystem(noteId, storage)) failed.push("coordSystem");
  if (!forgetTranscriptionLanguage(noteId, storage)) failed.push("transcriptionLanguage");
  return { ok: failed.length === 0, failed };
}

/** True when any per-note preference for this note is still stored. */
export function hasNotePreferences(noteId, storage = defaultStorage()) {
  if (!noteId) return false;
  return (
    loadCoordSystem(noteId, storage) !== null ||
    noteId in loadTranscriptionLanguageMap(storage)
  );
}
