// src/lib/freeformPageGuides.js
//
// Pure page GEOMETRY for the Free-form note editor's visual sheets.
//
// This module answers three questions, from numbers only:
//   1. How tall is one sheet's usable content region, at the width the editable
//      element is currently laid out at?
//   2. How deep is one sheet's paper margin at that width?
//   3. How big is the workspace gap between two sheets at that width?
//
// It has no knowledge of React, the DOM, TipTap, ProseMirror or persistence,
// and it is deliberately NOT part of any export path. The measured page PLAN
// (where a sheet actually ends, given real blocks) lives in
// freeformPageSpacers.js; this module only supplies the geometry that plan is
// measured against.
//
// ---------------------------------------------------------------------------
// This is a VISUAL guide, not a page plan.
// ---------------------------------------------------------------------------
// The authoritative Free-form PDF pagination system (src/lib/freeformExportPlan.js
// and src/lib/freeformExportBlocks.js) measures real rendered blocks in an
// offscreen probe carrying the export stylesheet, and fragments them at safe
// structural boundaries. NOTHING here participates in that. Browser editing
// typography and PDF export typography differ, so a sheet boundary drawn here
// and a physical page break in an exported PDF are not guaranteed to coincide,
// and the on-screen indicators must never claim otherwise — see
// docs/ARCHITECTURE.md → Free-form Paged Editor (visual page sheets).
//
// ---------------------------------------------------------------------------
// Why every dimension is derived from the CONTENT width
// ---------------------------------------------------------------------------
// The on-screen paper is responsive: it is a full A4 column when the workspace
// is wide enough and narrows with the available width, without any CSS
// transform scaling. What must stay constant at every width is the A4 page's
// PROPORTIONS — 257mm of usable height and 20mm of paper margin per 170mm of
// usable width. Deriving all three from the measured content width is what
// keeps the sheets correct when the sidebar collapses, the window resizes, or
// the layout reflows.
//
// The ratios are read from the shared page geometry rather than restated, so
// the editor sheets and the Template/PDF page geometry can never drift apart.
// The module deliberately reads only RATIOS of the shared mm constants — never
// `mmToPx`/`pxToMm`, and never the device-pixel capture arithmetic those other
// modules own — so this stays a proportion, not a second physical page model.
import { PAGE_MARGIN_MM, PAGE_SIZE_MM, USABLE_HEIGHT_PX, USABLE_WIDTH_PX } from "./pageGeometry";

// The usable content width in mm (170), used only to form ratios below.
const USABLE_WIDTH_MM =
  PAGE_SIZE_MM.width - PAGE_MARGIN_MM.left - PAGE_MARGIN_MM.right;

// 257mm / 170mm — the A4 usable content box's aspect. Expressed as a ratio so
// it is density-independent: the on-screen editor does not need to render at
// literal physical millimetres to keep A4 proportions.
export const VISUAL_PAGE_ASPECT = USABLE_HEIGHT_PX / USABLE_WIDTH_PX;

// 20mm / 170mm — one paper margin as a fraction of the usable content WIDTH.
// This is the depth of the blank paper above and below the usable region of
// every sheet: the space a sentence must never be allowed to sit in.
export const VISUAL_PAGE_MARGIN_RATIO = PAGE_MARGIN_MM.top / USABLE_WIDTH_MM;

// Sub-pixel tolerance, mirroring FIT_EPSILON_PX in paginateBlocks.js: content
// that measures a fraction of a pixel over an exact page fit is still one page.
// Without it, fractional-pixel layout would manufacture a spurious sheet for
// content that visually fills exactly one.
export const PAGE_FIT_EPSILON_PX = 0.5;

/* ---------------------------------------------------------------------------
 * The workspace gap between two sheets
 * -------------------------------------------------------------------------
 * A restrained physical separation, not a design flourish: enough that two
 * sheets read as two pieces of paper, never so much that scrolling a long note
 * becomes a chore. 20px at a full-width A4 column, tapering with the paper and
 * floored so a narrow screen still shows a real gap rather than a hairline. */
export const PAGE_GAP_PX = 20;
export const PAGE_GAP_MIN_PX = 10;

/**
 * The height of one sheet's usable CONTENT region, at the given content width.
 *
 * `contentWidthPx` must be the width of the editable element's own content box
 * (i.e. `editor.view.dom.clientWidth` with no padding on that element) — never
 * the outer paper width, its border, its shadow or its responsive padding.
 * Returns 0 for a width that has not been laid out yet, which callers treat as
 * "not measurable", never as "zero-height pages".
 */
export function visualPageContentHeight(contentWidthPx) {
  const width = Number(contentWidthPx);
  if (!Number.isFinite(width) || width <= 0) return 0;
  return width * VISUAL_PAGE_ASPECT;
}

/**
 * The depth of one paper margin — the blank band at the top and the bottom of
 * every sheet — at the given content width.
 *
 * The same value is used three ways, so they can never disagree: as the paper's
 * own top/bottom padding (sheet 1's top margin and the last sheet's bottom
 * margin), and as the two margin portions inside every page spacer.
 */
export function visualPageMarginHeight(contentWidthPx) {
  const width = Number(contentWidthPx);
  if (!Number.isFinite(width) || width <= 0) return 0;
  return width * VISUAL_PAGE_MARGIN_RATIO;
}

/**
 * The workspace gap shown between two sheets at the given content width.
 *
 * Proportional to the paper, then clamped: exactly PAGE_GAP_PX at a full-width
 * A4 column, never more, and never below PAGE_GAP_MIN_PX however narrow the
 * screen gets — a gap that collapses to nothing would stop reading as a
 * separation at all.
 */
export function visualPageWorkspaceGap(contentWidthPx) {
  const width = Number(contentWidthPx);
  if (!Number.isFinite(width) || width <= 0) return 0;
  const proportional = (width / USABLE_WIDTH_PX) * PAGE_GAP_PX;
  return Math.min(PAGE_GAP_PX, Math.max(PAGE_GAP_MIN_PX, proportional));
}

/**
 * The one honest caption shown once near the sheets — never repeated per page,
 * never inside editor content, never stored, never exported. It states plainly
 * that the layout is approximate and points at the exact alternative (Document
 * Preview's PDF, which renders through the same verified planner the download
 * uses) rather than letting a sheet boundary be mistaken for a real page break.
 */
export const FREEFORM_PAGE_GUIDE_CAPTION =
  "Approximate page layout — use Document Preview and select PDF for exact export pages.";
