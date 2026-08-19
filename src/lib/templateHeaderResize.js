// src/lib/templateHeaderResize.js
//
// THE HEADER HEIGHT DRAG — pure geometry for the Template Editor's direct
// vertical resize of the branded header (the affordance on the header's bottom
// edge; see BrandedDocumentHeader.js).
//
// The stored value is millimetres (`branding.header.heightMm`, the same value
// the numeric precision input edits). The pointer moves in VISUAL pixels, and
// the document may be visually scaled (CSS `zoom`, src/lib/documentZoom.js) or
// otherwise drawn larger or smaller than layout px. The conversion therefore
// goes through a UNIT-FREE RATIO of one element's visual width to its layout
// width — the same rule the media core uses (src/lib/editorMediaGeometry.js) —
// so the header's edge tracks the pointer 1:1 at 75 / 100 / 125 / 150 %
// without this module ever knowing the zoom.
//
//   visualScale  = visualWidthPx / layoutWidthPx      (1 at 100 %)
//   deltaMm      = (dyVisualPx / visualScale) / PX_PER_MM
//   next         = clamp(startHeightMm + deltaMm)     rounded to 0.1 mm
//
// Pure: no DOM, no React. The one DOM reader (`measureVisualScale`) is a thin
// wrapper the component calls once at pointer-down.

import { PX_PER_MM } from "./pageGeometry";
import { HEADER_HEIGHT_MM, clampHeaderHeightMm } from "./templateBranding";

/** Keyboard steps for the focused resize handle (Arrow / Shift+Arrow). */
export const HEADER_RESIZE_STEP_MM = 1;
export const HEADER_RESIZE_STEP_LARGE_MM = 5;

/**
 * The visual/layout scale of an element, or 1 when it cannot be measured (no
 * layout — jsdom, a detached node — or a zero-width box). Never 0, never NaN.
 */
export function visualScaleOf(visualWidthPx, layoutWidthPx) {
  const v = Number(visualWidthPx);
  const l = Number(layoutWidthPx);
  if (!Number.isFinite(v) || !Number.isFinite(l) || v <= 0 || l <= 0) return 1;
  return v / l;
}

/** Thin DOM reader for `visualScaleOf` — one call at pointer-down. */
export function measureVisualScale(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return 1;
  try {
    return visualScaleOf(el.getBoundingClientRect().width, el.offsetWidth);
  } catch {
    return 1;
  }
}

/**
 * The header height a drag has reached, bounded and rounded.
 *
 * @param startHeightMm  the height the gesture started from (mm)
 * @param dyVisualPx     pointer travel since pointer-down, in VISUAL px
 *                       (positive = down = taller)
 * @param visualScale    visual px per layout px (see visualScaleOf)
 */
export function headerHeightFromDrag({ startHeightMm, dyVisualPx, visualScale = 1 }) {
  const start = clampHeaderHeightMm(startHeightMm);
  const dy = Number(dyVisualPx);
  const scale = Number(visualScale) > 0 ? Number(visualScale) : 1;
  if (!Number.isFinite(dy)) return start;
  return clampHeaderHeightMm(start + dy / scale / PX_PER_MM);
}

/**
 * The height the gesture should start from: the stored minimum, or the box's
 * actual rendered height when content has grown the header past it — so the
 * dragged edge is always the edge the user grabbed, never an invisible line
 * above it.
 *
 * @param heightMm          stored `branding.header.heightMm`
 * @param renderedLayoutPx  the header box's layout height (offsetHeight)
 */
export function headerDragStartMm(heightMm, renderedLayoutPx) {
  const stored = clampHeaderHeightMm(heightMm);
  const px = Number(renderedLayoutPx);
  if (!Number.isFinite(px) || px <= 0) return stored;
  const renderedMm = px / PX_PER_MM;
  return renderedMm > stored ? Math.min(HEADER_HEIGHT_MM.max, renderedMm) : stored;
}

/** Keyboard step from the current height (Arrow up/down, Shift for large). */
export function stepHeaderHeightMm(currentMm, direction, large = false) {
  const step = large ? HEADER_RESIZE_STEP_LARGE_MM : HEADER_RESIZE_STEP_MM;
  const sign = direction < 0 ? -1 : 1;
  return clampHeaderHeightMm(clampHeaderHeightMm(currentMm) + sign * step);
}
