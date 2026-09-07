// src/lib/photoDetailsPreference.js
//
// THE PHOTO-DETAILS STAMP'S PERSISTENT STATE — one preference and one
// counter, both scoped to the workspace they belong to.
//
// Until 2026-09-07 the visible documentary stamp was decided by the CONTROL
// the user pressed: a camera capture was always stamped and a `+` pick never
// was. That is the wrong axis. NoteWise is not construction-only — a user
// photographing a whiteboard wants an ordinary clean picture, and a user
// documenting a site wants visible date/location evidence from whichever
// control was nearest. The stamp is therefore an explicit, SOURCE-NEUTRAL
// choice: one toggle, read by both flows, applied by one shared decision
// (`preparePhotoBytes` in src/components/BottomBar.js).
//
// FIRST-USE DEFAULT IS OFF, deliberately, for the camera too. NoteWise must
// stay useful as a general documentation product and must not assume every
// photograph is field evidence. A user who wants the stamp turns it on once
// and it is remembered.
//
// WHAT THIS IS NOT. This is UI PREFERENCE state (the idiom of
// src/lib/refinePreference.js): never written into a note, a Template answer,
// a Section document or a TemplateVersion, and never part of a cloud schema.
// It reaches storage through `readScopedValue` / `writeScopedValue`, the
// tolerant, never-throwing, scope-FOLLOWING helpers in
// src/lib/durableStorage.js that `templateModel.js` already uses for the
// default-template pointer. Those helpers are not durable records: they are
// never quarantined, and — the point that matters here — they are never seen
// by the cloud write capture, so nothing about this preference reaches
// Firestore and no schema changes.
//
// SCOPE. The physical key follows the active durable scope, so a signed-in
// session reads and writes
// `notewise-workspace-v1/<workspaceId>/notewise-photo-details-v1` and a
// pre-account browser reads the bare key. Two accounts on one browser
// therefore cannot see each other's choice or each other's photo numbers, and
// the values are NOT in `clearWorkspaceMirror`'s list: a preference is not
// workspace evidence, so it survives sign-out and is there again when the same
// workspace is reopened.
//
// FAILING SAFE. Anything that is not the exact stored "on" marker reads as
// OFF, so a stale, truncated or hand-edited value cannot silently turn the
// stamp on for a user who never asked for it. Storage that throws (Safari
// private mode, a browser refusing writes) reads as the default and reports a
// failed write rather than propagating.

import { readScopedValue, removeScopedValue, writeScopedValue } from "./durableStorage";

/** Whether the visible photo-details stamp is applied. Scope-following. */
export const PHOTO_DETAILS_STORAGE_KEY = "notewise-photo-details-v1";

/** The workspace's running photo number, as printed on the stamp. */
export const PHOTO_NUMBER_STORAGE_KEY = "notewise-photo-number-v1";

/**
 * The retired BROWSER-GLOBAL counter (`BottomBar`'s `localStorage` read).
 *
 * It was wrong on two counts once `+` uploads could also be stamped: the
 * number is VISIBLE DOCUMENTARY CONTENT, and a single global counter is shared
 * by every account and workspace on the browser, so one workspace's numbering
 * advanced because of another's photographs. It is named here so nobody
 * reintroduces it, and it is deliberately NEVER READ AND NEVER MIGRATED: the
 * old value's ownership is ambiguous (it counted every account that ever used
 * this browser), so adopting it into any one workspace would be a guess
 * printed onto evidence. It is left where it is, untouched.
 */
export const LEGACY_GLOBAL_PHOTO_INDEX_KEY = "sitewise_photo_index";

/** First use: the stamp is off. */
export const PHOTO_DETAILS_DEFAULT = false;

/** The first number a workspace's first stamped photograph carries. */
export const FIRST_PHOTO_NUMBER = 1;

const ON = "1";
const OFF = "0";

/**
 * The workspace's current setting.
 *
 * @param {Storage} [storage] injected in tests; defaults to localStorage
 * @param {{kind: string, id?: string}} [scope] injected in tests; defaults to
 *        the active durable scope
 * @returns {boolean}
 */
export function loadPhotoDetails(storage, scope) {
  return readScopedValue(PHOTO_DETAILS_STORAGE_KEY, storage, scope) === ON;
}

/**
 * Record an EXPLICIT choice. Called only from the toggle — never on mount, so
 * a user who has not touched the control keeps the default rather than having
 * it written back at them.
 *
 * @returns {boolean} whether it was stored
 */
export function savePhotoDetails(value, storage) {
  return writeScopedValue(PHOTO_DETAILS_STORAGE_KEY, value ? ON : OFF, storage);
}

/** A stored counter value if it is a usable count, else 0. */
function storedPhotoNumber(storage, scope) {
  const raw = readScopedValue(PHOTO_NUMBER_STORAGE_KEY, storage, scope);
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

/**
 * The number the NEXT stamped photograph would carry — WITHOUT consuming it.
 *
 * Reserve-then-commit is the whole point: the number is drawn into the pixels
 * before the canvas has produced anything, and a stamp that fails afterwards
 * (geolocation denied, a decode that throws, a canvas that yields no Blob)
 * falls back to the unstamped photograph. Consuming the number at read time
 * would leave a gap in the workspace's numbering for a photograph that was
 * never stamped. Nothing is written here.
 */
export function peekNextPhotoNumber(storage, scope) {
  return storedPhotoNumber(storage, scope) + FIRST_PHOTO_NUMBER;
}

/**
 * Consume the number a stamp actually used. Called ONCE, after the stamped
 * Blob exists.
 *
 * Only ever advances: a late or duplicated commit from a slower concurrent
 * stamp cannot rewind the workspace's numbering, because a number already
 * printed onto a stored photograph must never be handed out again.
 *
 * @returns {boolean} whether the counter moved
 */
export function commitPhotoNumber(value, storage) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < FIRST_PHOTO_NUMBER) return false;
  if (value <= storedPhotoNumber(storage)) return false;
  return writeScopedValue(PHOTO_NUMBER_STORAGE_KEY, String(value), storage);
}

/** Test/reset helper: forget this scope's counter. Never used by the product. */
export function resetPhotoNumber(storage) {
  return removeScopedValue(PHOTO_NUMBER_STORAGE_KEY, storage);
}
