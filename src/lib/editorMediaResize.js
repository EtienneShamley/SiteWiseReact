// src/lib/editorMediaResize.js
//
// THE SHARED RESIZE ARITHMETIC of the NoteWise editor media core.
//
// The proportional corner-resize rules were built and proven on Template
// section images: four corners, one output (`widthPct`, 15–100, whole points),
// drag-away-grows direction, a 5% keyboard step, and "a gesture that ends where
// it started saves nothing". Those rules are the product's resize model, not a
// Template detail — this module is their ONE home, imported by the shared
// AssetImage NodeView (and any future consumer) under media-core names.
//
// HISTORY. Until Phase G this file WRAPPED `templateSectionImageResize.js`,
// where the arithmetic had been proven on the legacy per-item Template Section
// interaction; the running Template UI imported that module directly, so a copy
// would have created two clamps that could drift apart. Phase G retired that
// interaction (a Template Section is now the shared editor), so the arithmetic
// moved HERE unchanged and the legacy module was deleted — per
// docs/PROJECT_DECISIONS.md → "Shared NoteWise Editor Core". The functions
// below are the proven ones, byte-for-byte in behaviour; only their home and
// their names changed.
//
// The percentage bounds are the attachment model's own (`clampWidthPct`,
// MIN/MAX_PHOTO_WIDTH_PCT in src/lib/noteAttachments.js), so a width the media
// core previews is always a width the stored model can keep.
//
// Pure: given numbers, returns numbers. No DOM, no React, no storage.

import {
  MAX_PHOTO_WIDTH_PCT,
  MIN_PHOTO_WIDTH_PCT,
  clampWidthPct,
} from "./noteAttachments";

/** The four corners — `top-left`, `top-right`, `bottom-left`, `bottom-right`. */
export const MEDIA_RESIZE_CORNER = {
  TOP_LEFT: "top-left",
  TOP_RIGHT: "top-right",
  BOTTOM_LEFT: "bottom-left",
  BOTTOM_RIGHT: "bottom-right",
};

/** All four, in a stable order — the handles a resizable media node renders. */
export const MEDIA_RESIZE_CORNERS = [
  MEDIA_RESIZE_CORNER.TOP_LEFT,
  MEDIA_RESIZE_CORNER.TOP_RIGHT,
  MEDIA_RESIZE_CORNER.BOTTOM_LEFT,
  MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
];

/**
 * The keyboard step (Alt/Option + Arrow), in percentage points.
 *
 * Big enough that a few presses make a visible difference, small enough to land
 * on a width the user actually wanted. The keyboard path and the pointer path
 * share every other rule — the same clamp, and one transaction per command.
 */
export const MEDIA_WIDTH_KEY_STEP_PCT = 5;

/** The model's own ceiling and floor, so a caller can state them without restating them. */
export const MEDIA_MAX_WIDTH_PCT = MAX_PHOTO_WIDTH_PCT;
export const MEDIA_MIN_WIDTH_PCT = MIN_PHOTO_WIDTH_PCT;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function isMediaResizeCorner(corner) {
  return MEDIA_RESIZE_CORNERS.includes(corner);
}

/** Does dragging to the RIGHT grow the media from this corner? */
export function mediaCornerGrowsRightward(corner) {
  return (
    corner === MEDIA_RESIZE_CORNER.TOP_RIGHT ||
    corner === MEDIA_RESIZE_CORNER.BOTTOM_RIGHT
  );
}

/** The resize cursor for a corner — the diagonal it actually sits on. */
export function mediaCornerResizeCursor(corner) {
  if (
    corner === MEDIA_RESIZE_CORNER.TOP_LEFT ||
    corner === MEDIA_RESIZE_CORNER.BOTTOM_RIGHT
  ) {
    return "nwse-resize";
  }
  if (
    corner === MEDIA_RESIZE_CORNER.TOP_RIGHT ||
    corner === MEDIA_RESIZE_CORNER.BOTTOM_LEFT
  ) {
    return "nesw-resize";
  }
  return "default";
}

/**
 * Model clamp (15–100) plus an optional caller display cap.
 *
 * The order matters: the cap may never push a width below the model minimum,
 * because a width the model refuses to store is not a width to preview either.
 */
export function clampMediaWidthPct(pct, maxPct = null) {
  if (!finite(pct)) return null;
  const clamped = clampWidthPct(pct);
  if (!finite(maxPct)) return clamped;
  return Math.max(MIN_PHOTO_WIDTH_PCT, Math.min(clamped, maxPct));
}

/**
 * The width percentage a corner drag is currently asking for — PREVIEW ONLY.
 * The caller shows the result and persists exactly once, on release.
 *
 * @param corner          which corner is being dragged
 * @param startWidthPct   the width when the press landed (the persisted one)
 * @param startX          the pointer x when the press landed
 * @param clientX         the pointer x now
 * @param containerWidth  the AVAILABLE content width in px — the box `widthPct`
 *                        is a percentage OF, so a drag of n px is always the
 *                        same fraction of the column whatever the page zoom
 * @param maxPct          optional display cap (e.g. a one-page height rule)
 *
 * Returns null when the inputs cannot describe a resize, which the caller must
 * treat as "no preview and nothing to save" rather than as a width of zero.
 */
export function mediaWidthPctFromPointer({
  corner,
  startWidthPct,
  startX,
  clientX,
  containerWidth,
  maxPct = null,
} = {}) {
  if (!isMediaResizeCorner(corner)) return null;
  if (!finite(startWidthPct) || !finite(startX) || !finite(clientX)) return null;
  if (!finite(containerWidth) || containerWidth <= 0) return null;

  const dx = clientX - startX;
  const signed = mediaCornerGrowsRightward(corner) ? dx : -dx;
  const deltaPct = (signed / containerWidth) * 100;
  return clampMediaWidthPct(startWidthPct + deltaPct, maxPct);
}

/**
 * Is this a width worth persisting? Whole points; same-point gestures save
 * nothing — a gesture that ends where it started must save NOTHING.
 */
export function mediaWidthPctChanged(next, previous) {
  if (!finite(next) || !finite(previous)) return false;
  return Math.round(next) !== Math.round(previous);
}

/**
 * One keyboard step through the same clamp as the pointer path; null = no-op.
 *
 * Alt/Option + ArrowRight grows, Alt/Option + ArrowLeft shrinks. The modifier is
 * the caller's business; what matters here is that the step goes through the
 * SAME clamp as the pointer path, so the two can never reach a width the other
 * cannot. "Already at the maximum" is a silent no-op rather than a save that
 * stores the width it already had.
 */
export function nudgeMediaWidthPct({ widthPct, stepPct, maxPct = null } = {}) {
  if (!finite(widthPct) || !finite(stepPct) || stepPct === 0) return null;
  const next = clampMediaWidthPct(widthPct + stepPct, maxPct);
  if (next === null) return null;
  const rounded = Math.round(next);
  return mediaWidthPctChanged(rounded, widthPct) ? rounded : null;
}
