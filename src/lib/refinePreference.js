// src/lib/refinePreference.js
//
// THE CURRENT REFINE MODE — one UI preference, owned in one place.
//
// Until 2026-08-18 the "AI writing style" lived inside the Quick Add composer
// (BottomBar) as a per-note localStorage map, and the header Refine read it
// through a callback ref. Two controls, one source, no way to see the mode
// from the header, and a per-note memory nobody had asked for. The mode is
// now ONE global preference: the style this person refines with, wherever they
// press Refine — the header control, the composer's select and the Template
// row trigger all read and write the same value.
//
// This is UI PREFERENCE state, deliberately: it is never written into a note,
// a Template Section document (`sectionDoc`), a Template answer or a
// TemplateVersion, and it travels with the person, not the document.
//
// The stored value is validated against the SHARED preset allowlist
// (src/lib/refineContract.js) on the way in and on the way out, so a stale,
// renamed or hand-edited value can never become an instruction: anything off
// the allowlist reads as the default.
//
// Pure except for the two storage helpers, which never throw.

import { DEFAULT_REFINE_STYLE, isAllowedRefineStyle } from "./refineContract";

export const REFINE_MODE_STORAGE_KEY = "notewise-refine-mode-v1";

// The retired per-note map (BottomBar's "sitewise-note-style-v1"). It is left
// in storage untouched — reading it back would resurrect a per-note memory the
// product no longer has — and is named here only so nobody reintroduces it.
export const LEGACY_PER_NOTE_STYLE_KEY = "sitewise-note-style-v1";

/** The stored value if it is a real preset, else the default. */
export function normalizeRefineMode(value) {
  return isAllowedRefineStyle(value) ? value : DEFAULT_REFINE_STYLE;
}

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadRefineMode(storage = defaultStorage()) {
  if (!storage) return DEFAULT_REFINE_STYLE;
  try {
    return normalizeRefineMode(storage.getItem(REFINE_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_REFINE_STYLE;
  }
}

/** Persist a preset value. Off-allowlist values are not written. */
export function saveRefineMode(value, storage = defaultStorage()) {
  if (!storage || !isAllowedRefineStyle(value)) return false;
  try {
    storage.setItem(REFINE_MODE_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
