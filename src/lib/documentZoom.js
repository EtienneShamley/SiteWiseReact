// src/lib/documentZoom.js
//
// DOCUMENT ZOOM — the pure model of the note document's viewing scale.
//
// This is PRESENTATION state and nothing else. Zoom changes how large the
// document is drawn; it never changes the document. No font-size mark, no
// `sectionDoc`, no stored Free-form HTML, no Template answer, no
// TemplateVersion, no image `widthPct`, no table width, no editor transaction
// and no export is affected by it — see docs/ARCHITECTURE.md → Document zoom.
//
// WHY A STEP LADDER RATHER THAN A CONTINUOUS SCALE. A document editor's zoom
// is a small set of understandable values a user can return to exactly ("put
// it back to 100%"), not a slider that lands on 103%. Zoom in / zoom out walk
// this ladder; the reset control goes straight to 100%.
//
// WHY THE VALUES ARE PERCENTAGES. The user-facing unit IS the percentage, so
// the model stores exactly what is displayed and the CSS factor is derived
// (`zoomScale`), rather than storing a float and rounding it for display —
// which is how a "99%" would eventually appear.
//
// Pure except for the two storage helpers, which never throw.

/** The zoom ladder, ascending. 100 is the default and always present. */
export const DOCUMENT_ZOOM_LEVELS = Object.freeze([75, 90, 100, 110, 125, 150]);

export const DEFAULT_DOCUMENT_ZOOM = 100;
export const MIN_DOCUMENT_ZOOM = DOCUMENT_ZOOM_LEVELS[0];
export const MAX_DOCUMENT_ZOOM = DOCUMENT_ZOOM_LEVELS[DOCUMENT_ZOOM_LEVELS.length - 1];

export function isDocumentZoom(value) {
  return DOCUMENT_ZOOM_LEVELS.indexOf(value) !== -1;
}

/**
 * A requested value snapped to the nearest ladder step and clamped to the
 * range. Anything that is not a usable number — a string, NaN, null, a stored
 * value from a future version — falls back to 100% rather than to the nearest
 * end of the scale, because "unreadable" is not the same as "very small".
 */
export function normalizeDocumentZoom(value) {
  // Only a real number, or a string that is one (which is what comes back out
  // of storage), is a zoom. Everything else falls back to the default rather
  // than being coerced: `Number(true)` is 1 and `Number("")` is 0, and both
  // would otherwise clamp to the SMALLEST zoom — turning a corrupt preference
  // into a document nobody can read.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  if (!Number.isFinite(n)) return DEFAULT_DOCUMENT_ZOOM;
  if (n <= MIN_DOCUMENT_ZOOM) return MIN_DOCUMENT_ZOOM;
  if (n >= MAX_DOCUMENT_ZOOM) return MAX_DOCUMENT_ZOOM;
  // Nearest step; a tie resolves downward, so a value never silently magnifies.
  let best = DOCUMENT_ZOOM_LEVELS[0];
  let bestGap = Math.abs(n - best);
  for (const level of DOCUMENT_ZOOM_LEVELS) {
    const gap = Math.abs(n - level);
    if (gap < bestGap) {
      best = level;
      bestGap = gap;
    }
  }
  return best;
}

/** The next step up the ladder — the maximum stays the maximum. */
export function zoomIn(value) {
  const current = normalizeDocumentZoom(value);
  const index = DOCUMENT_ZOOM_LEVELS.indexOf(current);
  return DOCUMENT_ZOOM_LEVELS[Math.min(index + 1, DOCUMENT_ZOOM_LEVELS.length - 1)];
}

/** The next step down the ladder — the minimum stays the minimum. */
export function zoomOut(value) {
  const current = normalizeDocumentZoom(value);
  const index = DOCUMENT_ZOOM_LEVELS.indexOf(current);
  return DOCUMENT_ZOOM_LEVELS[Math.max(index - 1, 0)];
}

export function canZoomIn(value) {
  return normalizeDocumentZoom(value) < MAX_DOCUMENT_ZOOM;
}

export function canZoomOut(value) {
  return normalizeDocumentZoom(value) > MIN_DOCUMENT_ZOOM;
}

export function isDefaultDocumentZoom(value) {
  return normalizeDocumentZoom(value) === DEFAULT_DOCUMENT_ZOOM;
}

/** The CSS `zoom` factor for a percentage — 125 → 1.25. */
export function zoomScale(value) {
  return normalizeDocumentZoom(value) / 100;
}

/** The visible label. The unit is part of the value, never a separate glyph. */
export function documentZoomLabel(value) {
  return `${normalizeDocumentZoom(value)}%`;
}

/**
 * Convert a length MEASURED IN VISUAL PIXELS (what `getBoundingClientRect()`
 * reports inside a zoomed subtree) back into the LAYOUT PIXELS the document
 * actually occupies.
 *
 * This is the one compensation the zoom architecture needs. CSS `zoom`
 * participates in layout, so the browser handles scrolling extent, hit
 * testing, selection and drag coordinates natively — but a client rect read
 * from inside the zoomed subtree comes back multiplied by the zoom, while the
 * geometry constants it is compared against (A4 page sizes, `pageGeometry.js`)
 * are layout pixels. Dividing here keeps the Free-form page guides landing on
 * the same words at every zoom level, which is what a page guide must do:
 * zooming a document changes how big a page looks, never where it breaks.
 *
 * Measurements taken with `offsetHeight`/`offsetWidth` are already layout
 * pixels and must NOT be passed through this.
 */
export function layoutPxFromVisualPx(visualPx, zoom) {
  const n = Number(visualPx);
  if (!Number.isFinite(n)) return 0;
  const scale = zoomScale(zoom);
  if (!Number.isFinite(scale) || scale <= 0) return n;
  return n / scale;
}

/* ============================== Persistence ============================== */

// One global UI preference — NOT per note, per project or per template. Zoom
// is how this person likes to look at documents, so it follows them between
// notes rather than being remembered as a property of any one of them.
export const DOCUMENT_ZOOM_STORAGE_KEY = "notewise-document-zoom-v1";

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * The remembered zoom, always a valid ladder value. A missing, corrupt,
 * out-of-range or future value reads as 100% — never as a broken layout.
 */
export function loadDocumentZoom(storage = defaultStorage()) {
  if (!storage) return DEFAULT_DOCUMENT_ZOOM;
  try {
    const raw = storage.getItem(DOCUMENT_ZOOM_STORAGE_KEY);
    if (raw === null || raw === undefined) return DEFAULT_DOCUMENT_ZOOM;
    return normalizeDocumentZoom(raw);
  } catch {
    return DEFAULT_DOCUMENT_ZOOM;
  }
}

/** Remember the zoom. Never throws; writes nothing else and no note data. */
export function saveDocumentZoom(value, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(DOCUMENT_ZOOM_STORAGE_KEY, String(normalizeDocumentZoom(value)));
  } catch {
    // Storage full or unavailable: the session keeps its own choice.
  }
}
