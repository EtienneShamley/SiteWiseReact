// src/lib/editorMediaResize.js
//
// THE SHARED RESIZE ARITHMETIC of the NoteWise editor media core.
//
// The proportional corner-resize rules were built and proven on Template
// section images (src/lib/templateSectionImageResize.js): four corners, one
// output (`widthPct`, 15–100, whole points), drag-away-grows direction, a 5%
// keyboard step, and "a gesture that ends where it started saves nothing".
// Those rules are the product's resize model, not a Template detail — so this
// module is the surface-agnostic boundary the shared NodeView (and any future
// consumer) imports them through, under media-core names.
//
// DELIBERATELY A WRAPPER, NOT A COPY. The arithmetic continues to live in
// templateSectionImageResize.js, which the running Template UI still imports
// directly; duplicating it would create two clamps that could drift apart.
// Consolidating the implementation's home (moving it here and re-pointing the
// Template consumer) is Phase G of the shared-core plan — after the Template
// surface has switched to the shared core — per docs/PROJECT_DECISIONS.md →
// "Shared NoteWise Editor Core".
//
// Pure: given numbers, returns numbers. No DOM, no React, no storage.

import {
  IMAGE_RESIZE_CORNER,
  IMAGE_RESIZE_CORNERS,
  IMAGE_WIDTH_KEY_STEP_PCT,
  clampImageWidthPct,
  cornerGrowsRightward,
  cornerResizeCursor,
  isResizeCorner,
  nudgeImageWidthPct,
  resizeWidthPctFromPointer,
  widthPctChanged,
} from "./templateSectionImageResize";

/** The four corners — `top-left`, `top-right`, `bottom-left`, `bottom-right`. */
export const MEDIA_RESIZE_CORNER = IMAGE_RESIZE_CORNER;

/** All four, in a stable order — the handles a resizable media node renders. */
export const MEDIA_RESIZE_CORNERS = IMAGE_RESIZE_CORNERS;

/** The keyboard step (Alt/Option + Arrow), in percentage points. */
export const MEDIA_WIDTH_KEY_STEP_PCT = IMAGE_WIDTH_KEY_STEP_PCT;

export const isMediaResizeCorner = isResizeCorner;

/** Does dragging to the RIGHT grow the media from this corner? */
export const mediaCornerGrowsRightward = cornerGrowsRightward;

/** The resize cursor for a corner — the diagonal it sits on. */
export const mediaCornerResizeCursor = cornerResizeCursor;

/** Model clamp (15–100) plus an optional caller display cap. */
export const clampMediaWidthPct = clampImageWidthPct;

/**
 * The width percentage a corner drag is currently asking for — PREVIEW ONLY.
 * The caller shows the result and persists exactly once, on release.
 */
export const mediaWidthPctFromPointer = resizeWidthPctFromPointer;

/** One keyboard step through the same clamp as the pointer path; null = no-op. */
export const nudgeMediaWidthPct = nudgeImageWidthPct;

/** Is this a width worth persisting? Whole points; same-point gestures save nothing. */
export const mediaWidthPctChanged = widthPctChanged;
