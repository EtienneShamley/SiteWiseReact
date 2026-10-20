// src/lib/newNoteDefaultPreference.js
//
// THE "NEW NOTE DEFAULT" SETTING — which view a NEWLY CREATED note opens in:
// Free-form note or Template form.
//
// A PRODUCT preference, not a presentation one: it is read at the one place
// notes are created (AppStateContext → `openNewNote`), so every creation path
// — desktop sidebar, Notes pane, phone Projects screen — applies the same
// rule from the same value. There is no desktop/phone split.
//
// WHAT IT DECIDES, AND WHAT IT DOES NOT. Every note carries BOTH views; the
// one on screen is the transient session value `activeNoteView`
// (src/lib/noteSurfaces.js → NOTE_LAYOUT). This setting only chooses that
// value at the moment a note is created. The user can switch the new note's
// view straight away, exactly as before, and nothing is stored on any note —
// so changing the setting can never alter an existing note. It does not pick
// a template: Template form keeps its existing behaviour for that.
//
// STORAGE follows the established UI-preference idiom
// (src/lib/photoDetailsPreference.js): `readScopedValue` / `writeScopedValue`
// in src/lib/durableStorage.js — tolerant, never throwing, scoped to the
// active workspace when signed in (the bare key before an account exists),
// kept in this browser and never part of a cloud schema.

import { readScopedValue, writeScopedValue } from "./durableStorage";
import { NOTE_LAYOUT } from "./noteSurfaces";

export const NEW_NOTE_DEFAULT_STORAGE_KEY = "notewise-new-note-default-v1";

export const NEW_NOTE_DEFAULT = Object.freeze({
  FREEFORM: "freeform",
  TEMPLATE: "template",
});

export const NEW_NOTE_DEFAULTS = Object.freeze(Object.values(NEW_NOTE_DEFAULT));

/** First use: a new note opens as a Free-form note, as the app starts today. */
export const NEW_NOTE_DEFAULT_INITIAL = NEW_NOTE_DEFAULT.FREEFORM;

/** A stored value if it is a real choice, else null. */
export function normalizeNewNoteDefault(value) {
  return NEW_NOTE_DEFAULTS.includes(value) ? value : null;
}

/**
 * The workspace's current choice; anything unreadable or unknown reads as
 * the initial default.
 *
 * @param {Storage} [storage] injected in tests; defaults to localStorage
 * @param {{kind: string, id?: string}} [scope] injected in tests; defaults to
 *        the active durable scope
 */
export function loadNewNoteDefault(storage, scope) {
  return (
    normalizeNewNoteDefault(readScopedValue(NEW_NOTE_DEFAULT_STORAGE_KEY, storage, scope)) ||
    NEW_NOTE_DEFAULT_INITIAL
  );
}

/**
 * Record an EXPLICIT choice from Settings. An unknown value is refused.
 *
 * @returns {boolean} whether it was stored
 */
export function saveNewNoteDefault(value, storage) {
  const choice = normalizeNewNoteDefault(value);
  if (!choice) return false;
  return writeScopedValue(NEW_NOTE_DEFAULT_STORAGE_KEY, choice, storage);
}

/** THE rule: the note view (NOTE_LAYOUT) a newly created note opens in. */
export function newNoteLayout(choice) {
  return normalizeNewNoteDefault(choice) === NEW_NOTE_DEFAULT.TEMPLATE
    ? NOTE_LAYOUT.TEMPLATE
    : NOTE_LAYOUT.NATURAL;
}
