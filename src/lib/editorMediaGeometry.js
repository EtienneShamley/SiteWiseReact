// src/lib/editorMediaGeometry.js
//
// THE CANONICAL CONTAINER GEOMETRY of the NoteWise editor media core.
//
// One rule, stated once, for every surface that resizes media: the Free-form
// document, a Template Section, a padded paper column and an unpadded one.
//
// ---------------------------------------------------------------------------
// THE COORDINATE-SPACE RULE
// ---------------------------------------------------------------------------
// A resize is a RATIO:
//
//     deltaPct = pointer delta / container content width * 100
//
// and a ratio is only meaningful when both terms are measured in the SAME
// coordinate space. Two spaces exist in a browser, and a document surface that
// is visually scaled (NoteWise's document zoom uses CSS `zoom` — see
// src/lib/documentZoom.js) makes them differ:
//
//   VISUAL px  what the user actually sees and points at.
//              `getBoundingClientRect()`, `event.clientX/Y`.
//   LAYOUT px  what the box model is expressed in.
//              `getComputedStyle()` lengths, `offsetWidth`.
//
// The pointer delta is VISUAL and cannot be anything else, so the container's
// content width must be VISUAL too. The defect this module removes was a
// subtraction across the boundary — a rect width (VISUAL) minus a computed
// padding (LAYOUT) — which is exact at 100% and drifts by the padding's share
// of the container at every other zoom level.
//
// ---------------------------------------------------------------------------
// WHY NO ZOOM VALUE IS NEEDED
// ---------------------------------------------------------------------------
// The conversion is done with a UNIT-FREE RATIO of two lengths read from the
// same source, so whatever space they are in cancels:
//
//     ratio         = layout content width / layout border-box width
//     visual content = visual border-box width * ratio
//
// Nothing here is told the zoom, imports it, or could be wrong if it changed.
// That keeps the media core correct whenever its containing surface is
// visually scaled — by document zoom, by browser zoom, or by anything a future
// surface does — rather than correct only for the one scaling mechanism that
// happened to exist when it was written.
//
// It also fixes a smaller pre-existing inaccuracy in passing: a border on the
// container is part of the border box the rect reports but is not part of the
// content box a width percentage is a percentage of, and it was previously
// never subtracted at all.
//
// Pure arithmetic plus one thin DOM reader. No React, no storage, no zoom.

const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** A computed-style length in px, or 0 when it is absent or not a length. */
function px(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The container's CONTENT-BOX width, in the same coordinate space as
 * `borderBoxWidth` — which is the space the pointer is measured in.
 *
 * @param borderBoxWidth the container's border-box width in VISUAL px
 *                       (`getBoundingClientRect().width`)
 * @param contentWidth   its content width in LAYOUT px (`getComputedStyle`'s
 *                       resolved `width`, which is the content box)
 * @param paddingX       left + right padding in LAYOUT px
 * @param borderX        left + right border width in LAYOUT px
 *
 * The three LAYOUT values are only ever used as a ratio against one another,
 * so they never leak into the result's units.
 *
 * Returns null when the container cannot describe a usable width, which every
 * caller must treat as "no resize" rather than as a width of zero.
 */
export function mediaContentBoxWidth({
  borderBoxWidth,
  contentWidth,
  paddingX = 0,
  borderX = 0,
} = {}) {
  if (!finite(borderBoxWidth) || borderBoxWidth <= 0) return null;

  // No usable box-model reading (an `auto` width, a display type that resolves
  // no length, no computed style at all): degrade to the border box. That is
  // the honest answer in ONE space — never a mixed one — and it is what the
  // unpadded, unbordered case reduces to anyway.
  if (!finite(contentWidth) || contentWidth <= 0) return borderBoxWidth;

  const layoutBorderBox = contentWidth + (finite(paddingX) ? paddingX : 0) + (finite(borderX) ? borderX : 0);
  if (!finite(layoutBorderBox) || layoutBorderBox <= 0) return borderBoxWidth;

  // Unit-free: whatever space the three layout lengths are in cancels here.
  const contentRatio = contentWidth / layoutBorderBox;
  const width = borderBoxWidth * contentRatio;
  return width > 0 ? width : null;
}

/**
 * Read a live element's content-box width in VISUAL px — the one measurement
 * a media resize may divide a pointer delta by.
 */
export function measureMediaContentBoxWidth(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const rect = el.getBoundingClientRect();
  const borderBoxWidth = rect && Number.isFinite(rect.width) ? rect.width : 0;

  const win = el.ownerDocument && el.ownerDocument.defaultView;
  if (!win || typeof win.getComputedStyle !== "function") {
    return mediaContentBoxWidth({ borderBoxWidth, contentWidth: null });
  }

  const cs = win.getComputedStyle(el);
  // `width` resolves to the CONTENT box, whatever `box-sizing` is set to, so
  // the three readings below always describe the same box model.
  return mediaContentBoxWidth({
    borderBoxWidth,
    contentWidth: px(cs.width),
    paddingX: px(cs.paddingLeft) + px(cs.paddingRight),
    borderX: px(cs.borderLeftWidth) + px(cs.borderRightWidth),
  });
}
