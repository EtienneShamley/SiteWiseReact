// src/lib/templateSectionImageMove.js
//
// The POINTER GESTURE RULES for moving a persisted section image.
//
// A flexible Template section should read and behave like a Word document body:
// text is typed, and an image is placed by dragging the image itself. There is
// deliberately no grip, no ▲/▼ command pair and no separate handle — the image
// IS the move surface, because that is what a user who has ever moved a picture
// in a word processor already knows how to do.
//
// ---------------------------------------------------------------------------
// CLICK AND DRAG ARE THE SAME GESTURE UNTIL THE POINTER MOVES
// ---------------------------------------------------------------------------
//
// Making the image the move surface means an ordinary click starts on the same
// element a move does. They are separated by MOVEMENT, not by a modifier key
// and not by a hold delay:
//
//   pointer down on the image        a move is PENDING — nothing has happened
//   released under the threshold     an ordinary click: focus/select, and every
//                                    existing control (Open larger, Remove)
//                                    behaves exactly as it did
//   moved past the threshold         the move ARMS, and only then does anything
//                                    visual or persistent follow from it
//
// The threshold exists because a real click is never perfectly still — a few
// pixels of travel between press and release is normal, especially on a
// trackpad. Without it every click would begin a reorder.
//
// ---------------------------------------------------------------------------
// THE CORNERS ARE RESERVED — they are NOT a move surface
// ---------------------------------------------------------------------------
//
// Proportional corner-handle resizing lives at the image's corners
// (src/lib/templateSectionImageResize.js), so the corners must not also mean
// "move": a gesture that means two things at the same pixel is a conflict.
//
// So the surface is split HERE, once, and the split is deliberate rather than
// emergent: the CENTRE/BODY of the image starts a move, and a square zone at
// each corner is declined by this rule and belongs to the resize handles
// instead. It costs a user nothing (the body is the overwhelming majority of
// any image) and the two gestures share this one definition of "corner", so
// they cannot disagree about where the boundary is.
//
// The zone is clamped against the image's own size, so a small image does not
// end up being all corner and no body.
//
// ---------------------------------------------------------------------------
// THE PREVIEW — what "being dragged" looks like
// ---------------------------------------------------------------------------
//
// Once the gesture arms, the image must look like it is in the user's hand: a
// floating, translucent preview of the picture follows the pointer while the
// insertion line shows where it would land. The geometry of that preview is
// decided here (`imageDragPreviewGeometry`) rather than at the render site, so
// "follows the pointer, keeps its proportions, stays under the point that was
// grabbed" is one tested rule. It is presentation only: the original item keeps
// its place in the document, and nothing is written until the drop.
//
// Pure: no React, no DOM, no storage. It is given a rect and a point and
// answers a question about them.

/**
 * How far the pointer must travel before a press becomes a move.
 *
 * Small enough that a deliberate drag feels immediate, large enough that the
 * incidental travel of a click never arms one.
 */
export const IMAGE_MOVE_THRESHOLD_PX = 4;

/**
 * The side of the square reserved at each corner of the image. Not a move
 * surface in this change; the resize handles will occupy it.
 */
export const IMAGE_CORNER_ZONE_PX = 20;

/**
 * The largest share of the image one corner zone may claim in either axis.
 * A 30px thumbnail must still have a usable body to drag from, so the zone
 * shrinks with the image rather than swallowing it.
 *
 * Exported because the RESIZE handles occupy exactly this zone: they read the
 * geometry from here rather than restating it, so the surface the move gesture
 * declines and the surface the resize gesture claims are the same surface.
 */
export const IMAGE_CORNER_ZONE_MAX_RATIO = 1 / 3;
const CORNER_ZONE_MAX_RATIO = IMAGE_CORNER_ZONE_MAX_RATIO;

export const IMAGE_MOVE_ZONE = {
  BODY: "body",
  CORNER: "corner",
};

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function usableRect(rect) {
  if (!rect) return null;
  const { left, top, width, height } = rect;
  if (!finite(left) || !finite(top) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/**
 * Which zone of an image a point falls in.
 *
 * Returns null when the rect is unusable or the point is outside it — "not on
 * this image" is a different answer from "on its body", and a caller must not
 * be able to confuse the two.
 */
export function imagePointerZone({
  rect,
  clientX,
  clientY,
  cornerPx = IMAGE_CORNER_ZONE_PX,
} = {}) {
  const box = usableRect(rect);
  if (!box) return null;
  if (!finite(clientX) || !finite(clientY)) return null;

  const x = clientX - box.left;
  const y = clientY - box.top;
  if (x < 0 || y < 0 || x > box.width || y > box.height) return null;

  const zone = finite(cornerPx) && cornerPx > 0 ? cornerPx : IMAGE_CORNER_ZONE_PX;
  const zoneW = Math.min(zone, box.width * CORNER_ZONE_MAX_RATIO);
  const zoneH = Math.min(zone, box.height * CORNER_ZONE_MAX_RATIO);

  const nearHorizontalEdge = x <= zoneW || x >= box.width - zoneW;
  const nearVerticalEdge = y <= zoneH || y >= box.height - zoneH;

  // A CORNER is both at once. An edge alone — the middle of the top edge, say —
  // is still body: only the corners are reserved.
  return nearHorizontalEdge && nearVerticalEdge
    ? IMAGE_MOVE_ZONE.CORNER
    : IMAGE_MOVE_ZONE.BODY;
}

/** Would a press at this point be allowed to begin a move? */
export function isImageMoveSurface(args) {
  return imagePointerZone(args) === IMAGE_MOVE_ZONE.BODY;
}

/**
 * Has the pointer travelled far enough for a pending press to become a move?
 *
 * Straight-line distance, so travel in any direction counts the same. Exactly
 * at the threshold is still a click: a move must be unambiguously intended.
 */
export function exceedsMoveThreshold({
  startX,
  startY,
  clientX,
  clientY,
  thresholdPx = IMAGE_MOVE_THRESHOLD_PX,
} = {}) {
  if (!finite(startX) || !finite(startY)) return false;
  if (!finite(clientX) || !finite(clientY)) return false;
  const limit = finite(thresholdPx) && thresholdPx >= 0 ? thresholdPx : IMAGE_MOVE_THRESHOLD_PX;
  return Math.hypot(clientX - startX, clientY - startY) > limit;
}

/**
 * The largest a drag preview may be drawn.
 *
 * A section image is commonly the full width of the content column, and a ghost
 * that size would cover the document the user is trying to aim at — including
 * the insertion line that tells them where it will land. So a large image's
 * preview is scaled DOWN, proportionally; a small one is shown at its real
 * size. It is a preview of the thing being held, not a second copy of the page.
 */
export const IMAGE_DRAG_PREVIEW_MAX_PX = 240;

/**
 * Where to draw the floating preview of the image currently being dragged.
 *
 * The preview exists so the image feels HELD: it follows the pointer, keeps the
 * proportions of the picture on the page, and stays under the same point of the
 * image the user pressed on (scaled with it), so it does not jump to a corner
 * the moment the gesture arms.
 *
 * Purely presentational — this decides pixels on the screen and nothing else.
 * It touches no stored data, and the original item keeps its place in the
 * document while it is shown, so the layout underneath never moves.
 *
 * Returns null for an unusable rect or point, and a caller then simply draws no
 * preview: a drag with no ghost is still a working drag.
 */
export function imageDragPreviewGeometry({
  rect,
  grabX,
  grabY,
  clientX,
  clientY,
  maxPx = IMAGE_DRAG_PREVIEW_MAX_PX,
} = {}) {
  const box = usableRect(rect);
  if (!box) return null;
  if (!finite(clientX) || !finite(clientY)) return null;

  const limit = finite(maxPx) && maxPx > 0 ? maxPx : IMAGE_DRAG_PREVIEW_MAX_PX;
  // Scaled by WIDTH only, and height follows — the aspect ratio is preserved by
  // construction rather than by clamping two dimensions independently.
  const scale = box.width > limit ? limit / box.width : 1;
  const width = box.width * scale;
  const height = box.height * scale;

  // The grab point, in the preview's own coordinates. An unusable grab point
  // falls back to the centre, which is still "held" rather than misplaced.
  const offsetX = finite(grabX) ? (grabX - box.left) * scale : width / 2;
  const offsetY = finite(grabY) ? (grabY - box.top) * scale : height / 2;

  return {
    left: clientX - offsetX,
    top: clientY - offsetY,
    width,
    height,
  };
}
