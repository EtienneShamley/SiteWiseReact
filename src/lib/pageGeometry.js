// src/lib/pageGeometry.js
//
// Single source of truth for the document page geometry used by the template
// system. Both the Template Builder and the completed note render onto the same
// A4 page surfaces, and future export/print calculations should read these same
// values rather than re-deriving page dimensions locally.
//
// This module is pure and framework-agnostic so it can be unit-tested in
// isolation and reused by future export logic. It intentionally does NOT know
// anything about React, the DOM, rows, or blocks — only paper geometry.
//
// Scope for this phase: A4 portrait only, with symmetric professional-report
// margins. Landscape, custom paper sizes, and per-page margins are explicitly
// out of scope (see docs/ROADMAP.md) — kept as future extensions of the shape
// exported here, not hardcoded assumptions scattered across components.

// CSS reference density: 96 CSS px per inch, 25.4 mm per inch. This is the
// conversion the browser itself uses for physical CSS units (mm/cm/in), so a
// value converted here matches how the same mm value would lay out in CSS.
export const CSS_PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
export const PX_PER_MM = CSS_PX_PER_INCH / MM_PER_INCH; // ≈ 3.779527559

// A4 portrait, the initial default document size.
export const PAGE_SIZE_MM = Object.freeze({ width: 210, height: 297 });

// Symmetric professional-report margins (~20mm on every side).
export const PAGE_MARGIN_MM = Object.freeze({
  top: 20,
  right: 20,
  bottom: 20,
  left: 20,
});

// Convert millimetres to CSS pixels. Pure; no rounding, so callers can decide
// how (or whether) to round for layout vs. measurement.
export function mmToPx(mm) {
  return (Number(mm) || 0) * PX_PER_MM;
}

// Convert CSS pixels back to millimetres (useful for future export math).
export function pxToMm(px) {
  return (Number(px) || 0) / PX_PER_MM;
}

// Full page dimensions in CSS px (the white paper surface size).
export const PAGE_WIDTH_PX = mmToPx(PAGE_SIZE_MM.width);
export const PAGE_HEIGHT_PX = mmToPx(PAGE_SIZE_MM.height);

// Usable content box in CSS px — the area inside the margins that document
// blocks may occupy. Pagination fills usable HEIGHT; blocks are laid out at
// usable WIDTH (constant on every page, which is what makes a block's measured
// height independent of the page it lands on — see PagedDocument).
export const USABLE_WIDTH_PX = mmToPx(
  PAGE_SIZE_MM.width - PAGE_MARGIN_MM.left - PAGE_MARGIN_MM.right
);
export const USABLE_HEIGHT_PX = mmToPx(
  PAGE_SIZE_MM.height - PAGE_MARGIN_MM.top - PAGE_MARGIN_MM.bottom
);

// Convenience accessor returning every derived value for the current (A4)
// geometry. Kept as a function so a future orientation/size parameter can be
// threaded through one place without changing call sites' shape.
export function getPageGeometry() {
  return {
    sizeMm: PAGE_SIZE_MM,
    marginMm: PAGE_MARGIN_MM,
    pxPerMm: PX_PER_MM,
    pageWidthPx: PAGE_WIDTH_PX,
    pageHeightPx: PAGE_HEIGHT_PX,
    usableWidthPx: USABLE_WIDTH_PX,
    usableHeightPx: USABLE_HEIGHT_PX,
  };
}
