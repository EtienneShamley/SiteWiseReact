// src/lib/templateSectionImageResize.js
//
// PROPORTIONAL CORNER RESIZING of a section image — the arithmetic, in one
// place, with no React and no DOM.
//
// src/lib/templateSectionImageMove.js already splits the image surface: the
// BODY moves the image, and a square at each CORNER was reserved and started
// nothing. This module is what those corners now do. The two rules share the
// one geometry constant (`IMAGE_CORNER_ZONE_PX`) rather than each having their
// own idea of where a corner is, so the gestures cannot disagree at the pixel
// where they meet.
//
//   image body      → move (Word-like placement within the section)
//   image corner    → resize (this module)
//   short click     → the existing select / Open larger behaviour
//   toolbar Remove  → the existing per-item removal
//
// None of them can trigger another: the corner handles are elements layered ON
// TOP of the image, so a press on one never reaches the move surface, and the
// move surface declines the corner zone anyway.
//
// ---------------------------------------------------------------------------
// ONLY A WIDTH PERCENTAGE IS EVER PRODUCED
// ---------------------------------------------------------------------------
//
// The stored model is unchanged: `display.widthPct`, a percentage of the
// section's own content column, clamped by the existing `clampWidthPct`
// (MIN_PHOTO_WIDTH_PCT..MAX_PHOTO_WIDTH_PCT, i.e. 15–100 — the maximum is
// exactly the "fills the content column" width a new image now arrives at).
//
// NO PIXEL WIDTH AND NO HEIGHT IS EVER PRODUCED OR PERSISTED. Height follows
// the image's intrinsic aspect ratio through ordinary layout, which is what
// makes it impossible for a resize to stretch, squash or crop the photograph:
// there is simply no second dimension to get wrong. A portrait photo becomes
// tall; a landscape photo fills the column. Both are correct.
//
// `maxPct` is an OPTIONAL additional cap the caller may pass — the existing
// rule that a photo's rendered height must never exceed one usable page, so a
// photo block is always moved whole by pagination rather than clipped or split.
// It is a display constraint on top of the model's own clamp, never a change to
// the model's bounds.
//
// ---------------------------------------------------------------------------
// THE DIRECTION RULE
// ---------------------------------------------------------------------------
//
//   a RIGHT corner: drag right → bigger, drag left  → smaller
//   a LEFT  corner: drag left  → bigger, drag right → smaller
//
// i.e. dragging AWAY from the image grows it and dragging INTO it shrinks it,
// which is the behaviour of every corner handle a user has met before. Vertical
// travel is deliberately ignored: the height is not an independent dimension
// here, so reading it would only add noise to a gesture whose one output is a
// width.
//
// Pure: given numbers, it returns a number.

import {
  MAX_PHOTO_WIDTH_PCT,
  MIN_PHOTO_WIDTH_PCT,
  clampWidthPct,
} from "./noteAttachments";

export const IMAGE_RESIZE_CORNER = {
  TOP_LEFT: "top-left",
  TOP_RIGHT: "top-right",
  BOTTOM_LEFT: "bottom-left",
  BOTTOM_RIGHT: "bottom-right",
};

/** All four, in a stable order — the handles a resizable image renders. */
export const IMAGE_RESIZE_CORNERS = [
  IMAGE_RESIZE_CORNER.TOP_LEFT,
  IMAGE_RESIZE_CORNER.TOP_RIGHT,
  IMAGE_RESIZE_CORNER.BOTTOM_LEFT,
  IMAGE_RESIZE_CORNER.BOTTOM_RIGHT,
];

/**
 * The keyboard step, in percentage points.
 *
 * Big enough that a few presses make a visible difference, small enough to land
 * on a width the user actually wanted. The keyboard path and the pointer path
 * share every other rule — the same clamp, the same stable item id, and one
 * confirmed save per command.
 */
export const IMAGE_WIDTH_KEY_STEP_PCT = 5;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function isResizeCorner(corner) {
  return IMAGE_RESIZE_CORNERS.includes(corner);
}

/** Does dragging to the RIGHT grow the image from this corner? */
export function cornerGrowsRightward(corner) {
  return (
    corner === IMAGE_RESIZE_CORNER.TOP_RIGHT ||
    corner === IMAGE_RESIZE_CORNER.BOTTOM_RIGHT
  );
}

/** The resize cursor for a corner — the diagonal it actually sits on. */
export function cornerResizeCursor(corner) {
  if (
    corner === IMAGE_RESIZE_CORNER.TOP_LEFT ||
    corner === IMAGE_RESIZE_CORNER.BOTTOM_RIGHT
  ) {
    return "nwse-resize";
  }
  if (
    corner === IMAGE_RESIZE_CORNER.TOP_RIGHT ||
    corner === IMAGE_RESIZE_CORNER.BOTTOM_LEFT
  ) {
    return "nesw-resize";
  }
  return "default";
}

/**
 * Apply the model's own bounds, and then the caller's optional display cap.
 *
 * The order matters: the cap may never push a width below the model minimum,
 * because a width the model refuses to store is not a width to preview either.
 */
export function clampImageWidthPct(pct, maxPct = null) {
  if (!finite(pct)) return null;
  const clamped = clampWidthPct(pct);
  if (!finite(maxPct)) return clamped;
  return Math.max(MIN_PHOTO_WIDTH_PCT, Math.min(clamped, maxPct));
}

/**
 * The width percentage a corner drag is currently asking for.
 *
 * PREVIEW ONLY — nothing here writes anything. The caller shows the result and
 * persists exactly once, on release.
 *
 * @param corner          which corner is being dragged
 * @param startWidthPct   the width when the press landed (the persisted one)
 * @param startX          the pointer x when the press landed
 * @param clientX         the pointer x now
 * @param containerWidth  the AVAILABLE content width in px — the box `widthPct`
 *                        is a percentage OF, so a drag of n px is always the
 *                        same fraction of the column whatever the page zoom
 * @param maxPct          optional display cap (the one-page height rule)
 *
 * Returns null when the inputs cannot describe a resize, which the caller must
 * treat as "no preview and nothing to save" rather than as a width of zero.
 */
export function resizeWidthPctFromPointer({
  corner,
  startWidthPct,
  startX,
  clientX,
  containerWidth,
  maxPct = null,
} = {}) {
  if (!isResizeCorner(corner)) return null;
  if (!finite(startWidthPct) || !finite(startX) || !finite(clientX)) return null;
  if (!finite(containerWidth) || containerWidth <= 0) return null;

  const dx = clientX - startX;
  const signed = cornerGrowsRightward(corner) ? dx : -dx;
  const deltaPct = (signed / containerWidth) * 100;
  return clampImageWidthPct(startWidthPct + deltaPct, maxPct);
}

/**
 * One keyboard step — the non-cluttering equivalent of a corner drag.
 *
 * Alt/Option + ArrowRight grows, Alt/Option + ArrowLeft shrinks. The modifier is
 * the caller's business; what matters here is that the step goes through the
 * SAME clamp as the pointer path, so the two can never reach a width the other
 * cannot.
 *
 * Returns null when there is nothing to do, so "already at the maximum" is a
 * silent no-op rather than a save that stores the width it already had.
 */
export function nudgeImageWidthPct({ widthPct, stepPct, maxPct = null } = {}) {
  if (!finite(widthPct) || !finite(stepPct) || stepPct === 0) return null;
  const next = clampImageWidthPct(widthPct + stepPct, maxPct);
  if (next === null) return null;
  const rounded = Math.round(next);
  return widthPctChanged(rounded, widthPct) ? rounded : null;
}

/**
 * Is this a width worth persisting?
 *
 * Stored widths are whole percentage points, so a sub-point difference is not a
 * change the user could see or the model could keep. A gesture that ends where
 * it started must save NOTHING.
 */
export function widthPctChanged(next, previous) {
  if (!finite(next) || !finite(previous)) return false;
  return Math.round(next) !== Math.round(previous);
}

/** Exposed so a caller can state the model's own ceiling without restating it. */
export const IMAGE_MAX_WIDTH_PCT = MAX_PHOTO_WIDTH_PCT;
export const IMAGE_MIN_WIDTH_PCT = MIN_PHOTO_WIDTH_PCT;
