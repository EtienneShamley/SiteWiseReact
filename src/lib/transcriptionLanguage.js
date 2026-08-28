// src/lib/transcriptionLanguage.js
//
// TRANSCRIPTION LANGUAGE — the language a Live Transcript session listens in.
//
// This is deliberately a preference of its own, separate from any DOCUMENT
// language: a user may write an English report from an Afrikaans interview or
// the other way round, so the two are never bound together. NoteWise has no
// document-language setting at all today; what it does have is this per-note
// TRANSCRIPTION language memory (the key predates this module — it was the
// composer's "voice language" memory, and it keeps its key so an existing
// preference is not lost). A Live Transcript session is SEEDED from it for the
// open note and may be overridden freely for the session; choosing a language
// in the session updates only this memory — never a note, a template, a
// version or a section document.
//
// "auto" is REAL auto-detection: the server omits the language and the primary
// transcription model detects it. An explicit choice is passed to the model as
// the language to transcribe in. The engine does not report which language it
// detected, so nothing here pretends to know.
//
// Pure except for the localStorage helpers, which never throw.

import { isNoteDeleted } from "./noteTombstones";

export const TRANSCRIPTION_LANGUAGE_AUTO = "auto";

// The supported languages: ISO-639-1 codes the transcription models accept.
export const TRANSCRIPTION_LANGUAGES = Object.freeze([
  { label: "Auto-detect", value: TRANSCRIPTION_LANGUAGE_AUTO },
  { label: "English", value: "en" },
  { label: "Afrikaans", value: "af" },
  { label: "Spanish", value: "es" },
  { label: "French", value: "fr" },
  { label: "German", value: "de" },
  { label: "Portuguese", value: "pt" },
  { label: "Italian", value: "it" },
  { label: "Dutch", value: "nl" },
  { label: "Chinese (Mandarin)", value: "zh" },
  { label: "Japanese", value: "ja" },
  { label: "Korean", value: "ko" },
  { label: "Arabic", value: "ar" },
  { label: "Hindi", value: "hi" },
  { label: "Filipino (Tagalog)", value: "tl" },
]);

export function isTranscriptionLanguage(value) {
  return TRANSCRIPTION_LANGUAGES.some((l) => l.value === value);
}

/** A stored or requested value normalized to a supported one ("auto" otherwise). */
export function normalizeTranscriptionLanguage(value) {
  return isTranscriptionLanguage(value) ? value : TRANSCRIPTION_LANGUAGE_AUTO;
}

export function transcriptionLanguageLabel(value) {
  const found = TRANSCRIPTION_LANGUAGES.find((l) => l.value === value);
  return found ? found.label : "";
}

// Per-note memory. The key is unchanged from the composer's former voice
// language memory, so a preference chosen before this module existed still
// applies.
export const TRANSCRIPTION_LANGUAGE_MEMORY_KEY = "sitewise-note-voice-lang-v1";

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readMemory(storage) {
  try {
    const raw = storage.getItem(TRANSCRIPTION_LANGUAGE_MEMORY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The remembered transcription language for a note — "auto" when none. */
export function loadTranscriptionLanguage(noteId, storage = defaultStorage()) {
  if (!noteId || !storage) return TRANSCRIPTION_LANGUAGE_AUTO;
  return normalizeTranscriptionLanguage(readMemory(storage)[noteId]);
}

/** Every remembered language, keyed by note id and normalized. Never throws. */
export function loadTranscriptionLanguageMap(storage = defaultStorage()) {
  if (!storage) return {};
  const raw = readMemory(storage);
  const map = {};
  for (const noteId of Object.keys(raw)) {
    map[noteId] = normalizeTranscriptionLanguage(raw[noteId]);
  }
  return map;
}

/**
 * Forgets a note's remembered language (note deletion). Never throws; returns
 * false only when the memory could not be rewritten. This module is the ONE
 * writer of the key — nothing else rewrites the map.
 */
export function forgetTranscriptionLanguage(noteId, storage = defaultStorage()) {
  if (!noteId || !storage) return true;
  try {
    const map = readMemory(storage);
    if (!(noteId in map)) return true;
    delete map[noteId];
    storage.setItem(TRANSCRIPTION_LANGUAGE_MEMORY_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** Remember a note's transcription language. Never throws; writes nothing else. */
export function saveTranscriptionLanguage(noteId, language, storage = defaultStorage()) {
  if (!noteId || !storage) return;
  if (isNoteDeleted(noteId)) return; // never resurrect a deleted note's memory
  try {
    const map = readMemory(storage);
    map[noteId] = normalizeTranscriptionLanguage(language);
    storage.setItem(TRANSCRIPTION_LANGUAGE_MEMORY_KEY, JSON.stringify(map));
  } catch {
    // Storage full or unavailable: the session keeps its own choice.
  }
}
