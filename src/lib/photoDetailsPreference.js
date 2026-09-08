// src/lib/photoDetailsPreference.js
//
// THE PHOTO-DETAILS STAMP'S PERSISTENT STATE — one Settings preference and
// one counter, both scoped to the workspace they belong to.
//
// WHAT THE STAMP IS. The visible documentary information box (date, location
// label, address, coordinates, altitude, speed, map thumbnail, photo number)
// burnt into a photograph's PIXELS by the Quick Add composer
// (src/components/BottomBar.js). It is documentary content, not metadata: the
// stored image still goes through the Phase 7.8 privacy pipeline and carries
// no hidden EXIF/GPS whatever this preference says.
//
// THREE MODES, ONE SETTING (2026-09-08). Until 2026-09-07 the CONTROL decided
// (camera always stamped, `+` never); for one day it was a single boolean in
// the composer. Neither was right. NoteWise is not construction-only, and the
// two capture controls are genuinely different kinds of evidence:
//
//   CAMERA     a photograph taken NOW, HERE. The device's own position,
//              altitude and clock are legitimate facts about it, so they may
//              fill in what the photograph's own metadata lacks.
//   `+` UPLOAD a photograph that may be HISTORICAL — last week, another city,
//              somebody else's camera. The device knows nothing about where or
//              when it was taken. Stamping the device's current location or
//              the time of upload onto it would fabricate evidence. So an
//              uploaded photograph may be stamped ONLY from facts stored in the
//              original file, and is left clean when it has none.
//
//   "camera-only"           camera stamped (device may fill in); `+` clean. DEFAULT.
//   "camera-and-original"   camera as above; `+` stamped from ORIGINAL metadata only.
//   "off"                   nothing stamped; no location, geocode or map work at all.
//
// The mode is chosen in Settings, not beside the capture buttons: it is a
// standing decision about what this workspace's photographs are for, not a
// per-shot switch.
//
// WHAT THIS IS NOT. UI PREFERENCE state (the idiom of
// src/lib/refinePreference.js): never written into a note, a Template answer,
// a Section document or a TemplateVersion, and never part of a cloud schema.
// It reaches storage through `readScopedValue` / `writeScopedValue`, the
// tolerant, never-throwing, scope-FOLLOWING helpers in
// src/lib/durableStorage.js that `templateModel.js` already uses for the
// default-template pointer. Those are not durable records: never quarantined,
// and never seen by the cloud write capture — nothing here reaches Firestore.
//
// SCOPE. The physical key follows the active durable scope:
// `notewise-workspace-v1/<workspaceId>/<key>` when signed in, the bare key
// for a pre-account browser. Two accounts on one browser cannot see each
// other's mode or photo numbers. The keys are deliberately NOT in
// `clearWorkspaceMirror`'s list: a preference is not workspace evidence, so
// it survives sign-out and is there again when the same workspace reopens.
//
// MIGRATION from the one-day boolean (`notewise-photo-details-v1`, "1"/"0"):
// an explicit ON meant "stamp my photographs" and becomes "camera-only" — the
// closest mode that never stamps the device's location onto an upload; an
// explicit OFF stays "off"; nothing stored is the default. Read-through, per
// scope, never across workspaces, and written forward only on the next
// explicit change. The old key is left in place.
//
// FAILING SAFE. Anything that is not one of the three mode strings (or one of
// the two legacy markers) reads as the default. Storage that throws reads as
// the default and reports a failed write rather than propagating.

import { readScopedValue, removeScopedValue, writeScopedValue } from "./durableStorage";

/** The three-mode setting. Scope-following. */
export const PHOTO_DETAILS_STORAGE_KEY = "notewise-photo-details-v2";

/**
 * The one-day BOOLEAN key ("1" / "0"). Read only as a fallback when no mode
 * is stored in the same scope, never written, never migrated across scopes.
 */
export const LEGACY_PHOTO_DETAILS_BOOLEAN_KEY = "notewise-photo-details-v1";

/** The workspace's running photo number, as printed on the stamp. */
export const PHOTO_NUMBER_STORAGE_KEY = "notewise-photo-number-v1";

/**
 * The retired BROWSER-GLOBAL counter (`BottomBar`'s former `localStorage`
 * read).
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

export const PHOTO_DETAILS_MODE = Object.freeze({
  CAMERA_ONLY: "camera-only",
  CAMERA_AND_ORIGINAL: "camera-and-original",
  OFF: "off",
});

export const PHOTO_DETAILS_MODES = Object.freeze(Object.values(PHOTO_DETAILS_MODE));

/** First use: camera photographs are stamped, uploads are not. */
export const PHOTO_DETAILS_DEFAULT_MODE = PHOTO_DETAILS_MODE.CAMERA_ONLY;

/** Where a photograph came from — the only thing the composer knows about it. */
export const PHOTO_ORIGIN = Object.freeze({ CAMERA: "camera", UPLOAD: "upload" });

/**
 * HOW a photograph may be stamped, or `null` for not at all.
 *
 *   DOCUMENTARY    the full stamp: the photograph's own metadata first, the
 *                  device's current position / altitude / speed / clock
 *                  filling in what it lacks. Camera captures only.
 *   ORIGINAL_ONLY  the stamp may say only what the ORIGINAL file says. No
 *                  device position, altitude, speed or clock is consulted;
 *                  a photograph without its own GPS is not stamped at all.
 */
export const STAMP_POLICY = Object.freeze({ DOCUMENTARY: "documentary", ORIGINAL_ONLY: "original-only" });

/** The first number a workspace's first stamped photograph carries. */
export const FIRST_PHOTO_NUMBER = 1;

const LEGACY_ON = "1";
const LEGACY_OFF = "0";

/** A stored value if it is a real mode, else null. */
export function normalizePhotoDetailsMode(value) {
  return PHOTO_DETAILS_MODES.includes(value) ? value : null;
}

/**
 * The workspace's current mode.
 *
 * @param {Storage} [storage] injected in tests; defaults to localStorage
 * @param {{kind: string, id?: string}} [scope] injected in tests; defaults to
 *        the active durable scope
 * @returns {string} one of PHOTO_DETAILS_MODE
 */
export function loadPhotoDetailsMode(storage, scope) {
  const stored = normalizePhotoDetailsMode(readScopedValue(PHOTO_DETAILS_STORAGE_KEY, storage, scope));
  if (stored) return stored;
  // The one-day boolean, in THIS scope only. An explicit ON asked for stamped
  // photographs and maps to the closest mode that cannot put the device's
  // location onto an upload; an explicit OFF stays off.
  const legacy = readScopedValue(LEGACY_PHOTO_DETAILS_BOOLEAN_KEY, storage, scope);
  if (legacy === LEGACY_ON) return PHOTO_DETAILS_MODE.CAMERA_ONLY;
  if (legacy === LEGACY_OFF) return PHOTO_DETAILS_MODE.OFF;
  return PHOTO_DETAILS_DEFAULT_MODE;
}

/**
 * Record an EXPLICIT choice. Called only from the Settings control — never on
 * mount or on read, so a user who has not touched it keeps the default rather
 * than having it written back at them. An unknown value is refused.
 *
 * @returns {boolean} whether it was stored
 */
export function savePhotoDetailsMode(mode, storage) {
  const value = normalizePhotoDetailsMode(mode);
  if (!value) return false;
  return writeScopedValue(PHOTO_DETAILS_STORAGE_KEY, value, storage);
}

/**
 * THE decision both capture controls make, in one place: given the
 * workspace's mode and where this photograph came from, how may it be stamped?
 *
 * @returns {string|null} a STAMP_POLICY, or null for "not at all"
 */
export function stampPolicyFor(mode, origin) {
  const m = normalizePhotoDetailsMode(mode) || PHOTO_DETAILS_DEFAULT_MODE;
  if (m === PHOTO_DETAILS_MODE.OFF) return null;
  if (origin === PHOTO_ORIGIN.CAMERA) return STAMP_POLICY.DOCUMENTARY;
  if (origin === PHOTO_ORIGIN.UPLOAD && m === PHOTO_DETAILS_MODE.CAMERA_AND_ORIGINAL) {
    return STAMP_POLICY.ORIGINAL_ONLY;
  }
  return null;
}

/**
 * Whether an UPLOADED photograph's own metadata is enough for a photo-details
 * stamp under ORIGINAL_ONLY.
 *
 * Conservative by design: the stamp exists to say WHERE and WHEN, and without
 * the photograph's own GPS position there is no location line, no address, no
 * coordinates and no map — the device's position is never a substitute for an
 * upload. So a valid original position is REQUIRED. The capture date is
 * printed when the file carries one and simply omitted when it does not; it
 * is not required, because a photograph that knows where it was taken is
 * already documentary, and the upload time is never written in its place.
 *
 * @param {{ lat: number|null, lon: number|null }} sourceMeta as returned by
 *        readSourcePhotoMetadata (src/lib/photoStampMetadata.js)
 */
export function hasSufficientOriginalDetails(sourceMeta) {
  if (!sourceMeta) return false;
  const { lat, lon } = sourceMeta;
  return (
    typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lon === "number" && Number.isFinite(lon) && Math.abs(lon) <= 180
  );
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
