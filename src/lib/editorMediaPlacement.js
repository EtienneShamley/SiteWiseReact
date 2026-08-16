// src/lib/editorMediaPlacement.js
//
// HORIZONTAL PLACEMENT GEOMETRY of a media body drag — which layout the
// pointer is asking for while an image is in hand.
//
// Part of the shared NoteWise editor media core (docs/PROJECT_DECISIONS.md →
// "Shared NoteWise Editor Core"). Phase C2 made the pointer own the VERTICAL
// destination (real ProseMirror positions via posAtCoords/dropPoint — that
// logic lives in editorMediaDrag.js and is not repeated or replaced here).
// Phase C3 adds the HORIZONTAL intent: where the pointer sits across the
// editor's content box decides whether the drop is asking for
//
//   wrap-left   pointer in the LEFT side band  → image floats left, text
//               flows on its right
//   block       pointer in the CENTRE band     → normal stacked placement
//   wrap-right  pointer in the RIGHT side band → image floats right, text
//               flows on its left
//
// The user "places the image there" with the pointer alone: no Left/Right/
// Block buttons, no invisible precision targets. The bands are wide fractions
// of the real content box, so sweeping left → centre → right during one drag
// visibly walks the candidate through all three placements.
//
// WHY 28%. The side band must be wide enough to hit casually (a fifth of the
// column would demand aim) but must leave a centre band that is clearly the
// majority of the column, so "drag it roughly where text goes" still means
// block. 28/44/28 gives side bands ~120px each on the editor's full-width
// 170mm (~643px) column with the centre band still dominant — and the exact
// figure is a constant here precisely so tuning it is a one-line change that
// every surface inherits.
//
// HYSTERESIS. A pointer hovering exactly on a band boundary must not flicker
// the candidate between two placements on every jittered move event. Once a
// candidate is held, its band is widened by MEDIA_WRAP_BAND_HYSTERESIS_RATIO
// on the side it would exit from: the pointer has to travel meaningfully past
// the boundary (6% of the content width, ~40px on a full column) before the
// candidate changes. Entering a band uses the plain boundary; only LEAVING is
// sticky.
//
// Pure: no DOM, no React, no editor. The caller measures the content box
// (left edge + width, padding excluded) and passes numbers in.

import {
  MEDIA_LAYOUT_MODE,
  MEDIA_LAYOUT_SIDE,
  normalizeMediaLayout,
} from "./editorMediaLayout";

/** The fraction of the content-box width each side band occupies. */
export const MEDIA_WRAP_SIDE_BAND_RATIO = 0.28;

/**
 * How far past a band boundary the pointer must travel before a HELD candidate
 * is given up, as a fraction of the content-box width.
 */
export const MEDIA_WRAP_BAND_HYSTERESIS_RATIO = 0.06;

const BLOCK = Object.freeze({ mode: MEDIA_LAYOUT_MODE.BLOCK, side: null });

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The layout candidate for one pointer position.
 *
 * @param x            pointer clientX
 * @param contentLeft  the editor content box's left edge (same coordinate space)
 * @param contentWidth the editor content box's width, padding excluded
 * @param previous     the candidate currently held (for hysteresis), or null
 * @returns a NORMALIZED layout ({mode, side}) — never null. Geometry that
 *   cannot be interpreted (missing coordinates, an unlaid-out editor) answers
 *   `block`: the safe placement every document already understands.
 */
export function mediaPlacementCandidate({ x, contentLeft, contentWidth, previous } = {}) {
  if (!finite(x) || !finite(contentLeft) || !finite(contentWidth) || contentWidth <= 0) {
    return BLOCK;
  }

  // The pointer's position across the content box, clamped: dragging past the
  // paper's edge is still an emphatic "left" or "right", never undefined.
  const rel = Math.min(1, Math.max(0, (x - contentLeft) / contentWidth));

  const band = MEDIA_WRAP_SIDE_BAND_RATIO;
  const stick = MEDIA_WRAP_BAND_HYSTERESIS_RATIO;
  const held = normalizeMediaLayout(previous || {});

  // Leaving a band is sticky; entering one is not.
  const leftEdge =
    held.mode === MEDIA_LAYOUT_MODE.WRAP && held.side === MEDIA_LAYOUT_SIDE.LEFT
      ? band + stick
      : band;
  if (rel < leftEdge) {
    return { mode: MEDIA_LAYOUT_MODE.WRAP, side: MEDIA_LAYOUT_SIDE.LEFT };
  }

  const rightEdge =
    held.mode === MEDIA_LAYOUT_MODE.WRAP && held.side === MEDIA_LAYOUT_SIDE.RIGHT
      ? 1 - band - stick
      : 1 - band;
  if (rel > rightEdge) {
    return { mode: MEDIA_LAYOUT_MODE.WRAP, side: MEDIA_LAYOUT_SIDE.RIGHT };
  }

  return BLOCK;
}

/**
 * The content box a placement is measured against: the element's border box
 * corrected for its own padding. Accepts anything shaped like an element
 * (getBoundingClientRect + ownerDocument), so it is testable against a plain
 * object; returns null when the element cannot be measured — the caller then
 * simply gets block candidates from the function above.
 */
export function mediaPlacementContentBox(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const rect = el.getBoundingClientRect();
  if (!rect || !Number.isFinite(rect.left) || !(rect.width > 0)) return null;

  let paddingLeft = 0;
  let paddingRight = 0;
  const win = el.ownerDocument && el.ownerDocument.defaultView;
  if (win && typeof win.getComputedStyle === "function") {
    const cs = win.getComputedStyle(el);
    paddingLeft = parseFloat(cs.paddingLeft) || 0;
    paddingRight = parseFloat(cs.paddingRight) || 0;
  }

  const width = rect.width - paddingLeft - paddingRight;
  if (!(width > 0)) return null;
  return { left: rect.left + paddingLeft, width };
}
