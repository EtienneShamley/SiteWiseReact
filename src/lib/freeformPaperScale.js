// src/lib/freeformPaperScale.js
//
// HOW THE FREE-FORM PAPER SCALES UNDER DOCUMENT ZOOM — the pure model of the
// one CSS rule that makes zoom-out actually shrink the sheet (Phase 8E.1).
//
// THE DEFECT IT REPLACES. The paper was `width: 100%; max-width: 210mm`. CSS
// `zoom` on the document wrapper scales every LENGTH inside it, but a
// percentage width resolves against the containing block, and the wrapper
// always fills its container visually — so a percent-wide sheet is the SAME
// visual width at every zoom. Wherever the container is narrower than A4 (a
// phone, always), zooming out therefore never shrank the sheet: it only shrank
// the type, packed more characters per line, and — because the A4-proportioned
// sheet height is derived from the now-wider layout content width — made the
// sheet TALLER. Lower percentage, bigger document. The Template never had the
// defect because its sheet is a fixed `210mm`, which zoom scales rigidly.
//
// THE MODEL. The sheet's LAYOUT width (in the zoomed subtree's own CSS px) is
// the width it would have at 100% — the container width, capped at A4 — held
// constant across zoom. Visually that is `container × scale` (or `A4 × scale`),
// so the sheet grows and shrinks with the percentage exactly as the Template's
// does, and the text column never changes width: zoom never reflows a line.
//
// One asymmetry is deliberate: above 100% the sheet is still capped at the
// container, which is precisely what the paper did before (zooming in enlarged
// the type inside a full-width sheet, no horizontal scrolling on any shell) —
// desktop behaviour above 100% is unchanged. In CSS:
//
//   width:     calc(100% * var(--nw-doc-zoom-scale, 1))   ← container × scale
//   max-width: min(210mm, 100%)                           ← A4, and never wider than the container
//
// where `100%` inside the zoomed subtree is the container's width in that
// subtree's own px (container ÷ scale), so `100% × scale` is the container's
// REAL width expressed in the subtree's px — a constant, whatever the zoom.
import { PAGE_WIDTH_PX } from "./pageGeometry";
import { zoomScale } from "./documentZoom";

/** The custom property `FreeformPagedEditor` sets and the stylesheet reads. */
export const FREEFORM_ZOOM_SCALE_VAR = "--nw-doc-zoom-scale";

/**
 * The sheet's width in the zoomed subtree's OWN px — what the browser lays the
 * text column out at. Constant for every zoom at or below 100%, so the same
 * words sit on the same lines at 25% as at 100%.
 */
export function freeformPaperLayoutWidth({ containerPx, zoom }) {
  const scale = zoomScale(zoom);
  const container = Number(containerPx);
  if (!Number.isFinite(container) || container <= 0) return 0;
  // 100% of the zoomed containing block, in the subtree's own px.
  const percent = container / scale;
  return Math.min(percent * scale, PAGE_WIDTH_PX, percent);
}

/** The sheet's width as SEEN — its layout width drawn at the zoom scale. */
export function freeformPaperVisualWidth({ containerPx, zoom }) {
  return freeformPaperLayoutWidth({ containerPx, zoom }) * zoomScale(zoom);
}

/** A font-size (or any px length) inside the sheet, as seen. */
export function freeformVisualLength(layoutPx, zoom) {
  return Number(layoutPx) * zoomScale(zoom);
}
