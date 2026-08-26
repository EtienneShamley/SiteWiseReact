// src/lib/pdfZoom.js
//
// The pure model of the PDF viewer's scale: bounds, the wheel/trackpad zoom
// gesture and focal-point preservation. Presentation only — nothing here
// touches annotation geometry, which is stored in page space and is therefore
// scale-independent by construction (src/lib/pdfCoords.js).
//
// GESTURE CHOICE. Plain wheel scrolling must keep scrolling the document —
// that is what every document viewer does and what the user's hands expect.
// Zoom is Ctrl/Cmd + wheel, which is also exactly what a trackpad pinch
// arrives as in every major browser (a `wheel` event with `ctrlKey` set), so
// one handler serves mouse-wheel-with-modifier and pinch alike. The browser's
// own page zoom is suppressed for that gesture only.

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 4;
export const ZOOM_STEPS = [50, 75, 100, 125, 150, 175, 200, 300];

/** Per-notch multiplier for a click-wheel; a pinch supplies finer deltas. */
const WHEEL_SENSITIVITY = 0.0025;
/** No single event may move the scale by more than this factor. */
const MAX_STEP_FACTOR = 1.25;

export function clampScale(scale) {
  const n = Number.isFinite(scale) ? scale : 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
}

/** Whether a wheel event is a zoom gesture rather than a scroll. */
export function isZoomWheel(evt) {
  return !!evt && (evt.ctrlKey === true || evt.metaKey === true);
}

/**
 * The next scale for a wheel/pinch delta. Wheel-up (negative deltaY) zooms in.
 * Exponential so the feel is uniform across the range; bounded per event so
 * an inertial trackpad burst cannot run away; clamped to the viewer's range.
 */
export function wheelZoomScale(scale, deltaY, deltaMode = 0) {
  const d = Number.isFinite(deltaY) ? deltaY : 0;
  // deltaMode 1 = lines, 2 = pages; scale them up to pixel-ish magnitudes.
  const px = deltaMode === 1 ? d * 16 : deltaMode === 2 ? d * 400 : d;
  let factor = Math.exp(-px * WHEEL_SENSITIVITY);
  factor = Math.min(MAX_STEP_FACTOR, Math.max(1 / MAX_STEP_FACTOR, factor));
  return clampScale(clampScale(scale) * factor);
}

/**
 * Scroll offsets that keep the document point under the pointer stationary
 * when the scale changes from `from` to `to`.
 *
 * `focal` is the pointer position relative to the scroll viewport's top-left
 * (client coords minus the scroller's bounding rect). Layout scales
 * uniformly from the scroller's content origin, so the point under the
 * pointer, measured in content px, is (scroll + focal) and moves by the
 * scale ratio.
 */
export function focalScroll({ scrollLeft = 0, scrollTop = 0 }, focal, from, to) {
  const ratio = clampScale(to) / clampScale(from);
  const fx = Number.isFinite(focal?.x) ? focal.x : 0;
  const fy = Number.isFinite(focal?.y) ? focal.y : 0;
  return {
    scrollLeft: Math.max(0, (scrollLeft + fx) * ratio - fx),
    scrollTop: Math.max(0, (scrollTop + fy) * ratio - fy),
  };
}

/** Zoom-select options: the fixed steps plus the current value if it is off-ladder. */
export function zoomOptionsFor(scale) {
  const pct = Math.round(clampScale(scale) * 100);
  return ZOOM_STEPS.includes(pct) ? ZOOM_STEPS : [...ZOOM_STEPS, pct].sort((a, b) => a - b);
}
