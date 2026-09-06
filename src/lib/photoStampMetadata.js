// src/lib/photoStampMetadata.js
//
// The METADATA half of the Quick Add camera stamp: what is read from the
// source photograph's own bytes, how the altitude is chosen between the photo
// and the device, and how altitude and speed are written onto the stamp. Pure
// apart from the one injected reader; the capture bar owns the pixels.
//
// WHY ALTITUDE NEVER WORKED. The stamp used `exifr.gps(file)` for its
// coordinates and read `altitude` off that answer. exifr's `gps()` shortcut
// deliberately parses only the four latitude/longitude tags and returns only
// `{ latitude, longitude }` — see node_modules/exifr/src/highlevel/gps.mjs —
// so the altitude was `undefined` on every photograph ever taken, and the
// device fallback is `null` on most browsers. The altitude is read here with
// `exifr.parse` and an explicit pick list, from the ORIGINAL bytes, before the
// privacy pipeline strips them. It is displayed, never stored: the stamped
// output is a canvas re-encode and carries no source metadata.
//
// exifr 7.1.3 hands `GPSAltitude` back as a number (the rational already
// divided) and `GPSAltitudeRef` as it is stored — a one-element byte array,
// 0 above and 1 below sea level. It applies no sign itself, so that is done
// here.

/** The tags read from the source photograph, and only these. */
export const STAMP_SOURCE_METADATA_TAGS = Object.freeze([
  "DateTimeOriginal",
  "GPSAltitude",
  "GPSAltitudeRef",
]);

/**
 * Beyond this magnitude an altitude is a corrupt or nonsensical tag, not a
 * place a photograph was taken: the highest ground on Earth is under 9 km and
 * an airliner's cabin window under 15 km.
 */
export const STAMP_ALTITUDE_LIMIT_M = 20000;

/** What the stamp says when a value is genuinely unavailable. */
export const STAMP_UNAVAILABLE = "n/a";

/** Where the stamp's position came from. */
export const STAMP_LOCATION_SOURCE = Object.freeze({
  PHOTO: "photo",
  DEVICE: "device",
});

/** The label above the address block, by source. */
export const STAMP_LOCATION_LABELS = Object.freeze({
  [STAMP_LOCATION_SOURCE.PHOTO]: "Photo location:",
  [STAMP_LOCATION_SOURCE.DEVICE]: "Current location:",
});

/** A finite number, or null. `null`, `undefined`, `NaN` and strings are null. */
export function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether an Exif `GPSAltitudeRef` means "below sea level". Accepts the raw
 * byte array exifr returns, a plain number, and the translated strings other
 * readers produce. Anything unrecognised is read as "above": the common case,
 * and the one that leaves a positive value positive.
 */
export function exifAltitudeRefIsBelowSeaLevel(ref) {
  let value = ref;
  if (value && typeof value === "object" && typeof value.length === "number") {
    value = value.length > 0 ? value[0] : null;
  }
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    return s === "1" || s.includes("below");
  }
  return false;
}

/**
 * The signed altitude in metres from an Exif `GPSAltitude` / `GPSAltitudeRef`
 * pair, or null when there is none or it is malformed. A valid 0 m is 0, not
 * null. A reference of "below" makes the value negative; a value a writer has
 * already signed is kept as it is.
 */
export function normalizeExifAltitude(altitude, ref) {
  const value = finiteNumberOrNull(altitude);
  if (value === null) return null;
  const magnitude = Math.abs(value);
  if (magnitude > STAMP_ALTITUDE_LIMIT_M) return null;
  if (exifAltitudeRefIsBelowSeaLevel(ref)) return magnitude === 0 ? 0 : -magnitude;
  return value;
}

/**
 * The altitude the stamp shows, in metres, or null.
 *
 *   1. a valid altitude embedded in the ORIGINAL source photograph
 *   2. a valid altitude from the device's current position
 *   3. otherwise null, shown as "n/a"
 *
 * "Valid" is a finite number within `STAMP_ALTITUDE_LIMIT_M`; 0 and negative
 * values are valid. Nothing is ever coerced to zero.
 */
export function resolveStampAltitude({ exifAltitude = null, browserAltitude = null } = {}) {
  for (const candidate of [exifAltitude, browserAltitude]) {
    const value = finiteNumberOrNull(candidate);
    if (value !== null && Math.abs(value) <= STAMP_ALTITUDE_LIMIT_M) return value;
  }
  return null;
}

/** A finite latitude/longitude pair, or null when either half is missing. */
function validPosition(candidate) {
  const lat = finiteNumberOrNull(candidate && candidate.lat);
  const lon = finiteNumberOrNull(candidate && candidate.lon);
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * The position the stamp uses, and where it came from (V1 product decision,
 * 2026-09-06 — see docs/PROJECT_DECISIONS.md):
 *
 *   1. valid GPS coordinates embedded in the ORIGINAL source photograph
 *   2. the device's current position, ONLY when the photograph has none
 *   3. otherwise no location at all
 *
 * NoteWise is field-documentation software: a photograph taken in Broadbeach
 * on Wednesday and added from Robina on Saturday documents Broadbeach. The
 * device's position never replaces a photograph's, the user is never asked to
 * choose, and nothing is inferred from a filename, note or project. A pair is
 * taken whole — a photograph's latitude is never combined with the device's
 * longitude.
 *
 * @returns {{lat: number|null, lon: number|null, source: string|null}}
 */
export function resolveStampLocation({ photo = null, device = null } = {}) {
  const fromPhoto = validPosition(photo);
  if (fromPhoto) return { ...fromPhoto, source: STAMP_LOCATION_SOURCE.PHOTO };
  const fromDevice = validPosition(device);
  if (fromDevice) return { ...fromDevice, source: STAMP_LOCATION_SOURCE.DEVICE };
  return { lat: null, lon: null, source: null };
}

/** "Photo location:" / "Current location:", or null for no location. */
export function stampLocationLabel(source) {
  return STAMP_LOCATION_LABELS[source] || null;
}

/**
 * "14 m", "0 m", "-3 m" or "n/a". Whole metres: a phone's GPS altitude is
 * noisy to several metres, so a decimal place would only imply a precision the
 * value does not have.
 */
export function formatStampAltitude(altitude) {
  const value = finiteNumberOrNull(altitude);
  if (value === null) return STAMP_UNAVAILABLE;
  const whole = Math.round(value);
  return `${whole === 0 ? 0 : whole} m`;
}

/**
 * "0.0 km/h" for a real reading of zero, "n/a" for no reading at all. The
 * Geolocation API's `speed` is `null` whenever the device cannot say — which
 * is most of the time — and a stamp must not present that as standing still.
 */
export function formatStampSpeed(speedMs) {
  const value = finiteNumberOrNull(speedMs);
  if (value === null || value < 0) return STAMP_UNAVAILABLE;
  return `${(value * 3.6).toFixed(1)} km/h`;
}

/**
 * Read the stamp's metadata from a source photograph's ORIGINAL bytes.
 *
 * `exifr` is injected: the capture bar passes the real module, which reads
 * JPEG, TIFF, PNG and HEIF containers alike, so an iPhone HEIC's altitude is
 * read through exactly the same call as a JPEG's. Every failure resolves to
 * "nothing known" rather than throwing — a photograph without metadata is
 * ordinary, not an error.
 *
 * @param {Blob} file  the file the user actually took, never a derived Blob
 * @param {{exifr: {gps: Function, parse: Function}}} deps
 * @returns {Promise<{lat: number|null, lon: number|null, exifDate: Date|null, altitude: number|null}>}
 */
export async function readSourcePhotoMetadata(file, { exifr } = {}) {
  const none = { lat: null, lon: null, exifDate: null, altitude: null };
  if (!file || !exifr) return none;
  try {
    const gps = await Promise.resolve(exifr.gps(file)).catch(() => null);
    const tags = await Promise.resolve(
      exifr.parse(file, [...STAMP_SOURCE_METADATA_TAGS])
    ).catch(() => null);
    const taken = tags && tags.DateTimeOriginal;
    return {
      lat: finiteNumberOrNull(gps && gps.latitude),
      lon: finiteNumberOrNull(gps && gps.longitude),
      exifDate: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken : null,
      altitude: normalizeExifAltitude(tags && tags.GPSAltitude, tags && tags.GPSAltitudeRef),
    };
  } catch {
    return none;
  }
}
