// src/lib/templateExportCapture.js
//
// The rasterisation geometry SHARED by both PDF exporters.
//
// Despite the file name (kept because renaming a verified module for tidiness
// is not worth the churn), nothing here is Template-specific: it is the
// physical A4 and html2pdf capture arithmetic, and the Free-form PDF planner
// reads exactly these values. Only the arithmetic is shared — the Template row
// pagination model (templateExportPagination.js) and the Free-form rich-text
// block model (freeformExportBlocks.js) stay entirely separate. See
// docs/PROJECT_DECISIONS.md → "Free-form PDF pagination uses measured block
// planning".
//
// html2pdf renders the whole document into ONE tall canvas and then slices that
// canvas into A4 pages. Three separate roundings decide where those slices land,
// and they must be made to agree or content drifts across page boundaries and is
// shaved at the edges:
//
//   1. html2pdf's container is `pageSize.inner.width` (170mm) wide and its page
//      height comes from `utils.toPx()`, which FLOORS the mm -> CSS px
//      conversion. That floored value (971 px) is also what the pagebreak plugin
//      uses when it pads a `.html2pdf__page-break` out to the next page.
//   2. html2canvas sizes the bitmap with `Math.floor(width * scale)`, so a
//      capture width that is not a whole number of DEVICE pixels loses its last
//      fraction — which is where the table's right border lives.
//   3. html2pdf slices that bitmap at `Math.floor(canvasWidth * inner.ratio)`
//      device px per page.
//
// Left alone, (1) and (3) disagree by 2 device px per page: the pagebreak plugin
// starts page k at 1942 device px while the slicer cuts at 1944, so every page
// carries a sliver of the next one. Pinning the capture width to a whole device
// pixel (642.5 CSS px at scale 2 => 1285 device px) makes the slice height come
// out at exactly 1942 = 2 x 971, so the two agree exactly. `assertsAligned()`
// exists so a future geometry or scale change fails a test rather than silently
// reintroducing the drift.
//
// Pure: no DOM, no html2pdf import. Everything here is derived from the shared
// page geometry (src/lib/pageGeometry.js) — no independent paper dimensions.

import {
  PAGE_MARGIN_MM,
  PAGE_SIZE_MM,
  USABLE_HEIGHT_PX,
  USABLE_WIDTH_PX,
} from "./pageGeometry";

// The html2canvas device-pixel ratio the PDF runner uses. Kept here because the
// capture arithmetic below is only correct for the scale it is computed with.
export const CAPTURE_SCALE = 2;

export const USABLE_WIDTH_MM =
  PAGE_SIZE_MM.width - PAGE_MARGIN_MM.left - PAGE_MARGIN_MM.right;
export const USABLE_HEIGHT_MM =
  PAGE_SIZE_MM.height - PAGE_MARGIN_MM.top - PAGE_MARGIN_MM.bottom;

// The usable page box as html2pdf itself computes it: `utils.toPx()` floors.
// The planner MUST use this rather than the unrounded USABLE_HEIGHT_PX, or it
// can place a row in a strip of page that html2pdf has already paged past.
export const PDF_PAGE_CONTENT_HEIGHT_PX = Math.floor(USABLE_HEIGHT_PX);

function safeScale(scale) {
  const value = Number(scale);
  return Number.isFinite(value) && value > 0 ? value : CAPTURE_SCALE;
}

function safePageCount(pageCount) {
  const value = Number(pageCount);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/**
 * The capture width in CSS px: the usable width rounded DOWN to a whole device
 * pixel. Rounding down (rather than up to 643, as the previous build did) keeps
 * the capture inside html2pdf's 170mm container, so nothing overflows it and the
 * right-hand table border is captured whole instead of being cut mid-stroke.
 */
export function captureWidthPx(scale = CAPTURE_SCALE) {
  const s = safeScale(scale);
  return Math.floor(USABLE_WIDTH_PX * s) / s;
}

/** The bitmap width html2canvas will produce for that capture width. */
export function canvasWidthDevicePx(scale = CAPTURE_SCALE) {
  const s = safeScale(scale);
  return Math.floor(captureWidthPx(s) * s);
}

/**
 * The capture height in CSS px for a plan of `pageCount` pages.
 *
 * Every page wrapper is padded out to a whole page by html2pdf's pagebreak
 * plugin, so the finished document is exactly `pageCount` page boxes tall.
 * Stating that height explicitly — rather than letting html2canvas measure the
 * container — is what stops the last page's footer being clipped: the capture no
 * longer depends on the container reporting a height that excludes overflow.
 */
export function captureHeightPx(pageCount) {
  return safePageCount(pageCount) * PDF_PAGE_CONTENT_HEIGHT_PX;
}

/** The device-px slice height html2pdf's `toPdf()` will cut the bitmap at. */
export function pdfSliceHeightDevicePx(scale = CAPTURE_SCALE) {
  return Math.floor(
    canvasWidthDevicePx(scale) * (USABLE_HEIGHT_MM / USABLE_WIDTH_MM)
  );
}

/** How many physical PDF pages html2pdf will emit for a plan of `pageCount`. */
export function pdfPageCountFor(pageCount, scale = CAPTURE_SCALE) {
  const s = safeScale(scale);
  const canvasHeight = Math.floor(captureHeightPx(pageCount) * s);
  return Math.ceil(canvasHeight / pdfSliceHeightDevicePx(s));
}

/**
 * True when the slice html2pdf cuts is exactly the page box the pagebreak plugin
 * pads to. Asserted by the unit tests: if a future margin, paper size or scale
 * change breaks it, pages drift by a pixel or two each and the test says so.
 */
export function captureIsAligned(scale = CAPTURE_SCALE) {
  return (
    pdfSliceHeightDevicePx(scale) ===
    PDF_PAGE_CONTENT_HEIGHT_PX * safeScale(scale)
  );
}
