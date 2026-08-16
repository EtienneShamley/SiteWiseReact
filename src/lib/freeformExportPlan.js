// src/lib/freeformExportPlan.js
//
// The Free-form PDF page planner.
//
// Given the prepared export HTML and a height oracle, it produces a
// DETERMINISTIC page plan: an ordered array of pages, each an ordered array of
// block fragments. One planned page becomes one page wrapper becomes one
// physical PDF page — nothing downstream re-decides where a page ends.
//
// It runs in two passes, and the order matters:
//
//   PASS 1  Reduce every block to fragments that each fit a WHOLE page. After
//           this the distributor can never be handed something taller than a
//           page, so it can never be forced to place an oversized block and let
//           it overflow. Content that genuinely cannot be divided fails here —
//           it is never clipped.
//   PASS 2  Distribute those fragments with the shared, already-tested pure
//           block distributor (src/lib/paginateBlocks.js), supplying a splitter
//           so a fragment that does not fit the REMAINING space is divided at
//           the boundary instead of leaving a large blank region. The splitter
//           may always decline: pass 1 guarantees the whole fragment fits a
//           fresh page, so declining is safe.
//
// The footer is reserved BEFORE anything is placed: "Page 1 of 1" and
// "Page 12 of 34" occupy the same single line at the same size, so one
// measurement is exact for every page.
//
// Pure: no DOM of its own, no React, no storage, no html2pdf. The oracle is
// injected, so every rule here is unit-testable without a browser — but it is
// this module and src/lib/freeformExportBlocks.js, never the oracle, that
// decide fragment boundaries and page membership.

import { paginateBlocks } from "./paginateBlocks";
import {
  FREEFORM_FRAGMENT_FAILURE,
  extractFreeformBlocks,
  fitFreeformBlocks,
  groupWrappedImageBlocks,
  splitFreeformBlockHtml,
} from "./freeformExportBlocks";
import {
  blockWrapperHtml,
  buildFreeformPageFooterHtml,
} from "./freeformExportPdfHtml";
import { PDF_PAGE_CONTENT_HEIGHT_PX } from "./templateExportCapture";

export const FREEFORM_PLAN_FAILURE = Object.freeze({
  UNSPLITTABLE: FREEFORM_FRAGMENT_FAILURE.UNSPLITTABLE,
});

// Shown to the user verbatim, so it states the outcome and never carries an
// internal reason. Mapped to a short detail by exportIdentity.js.
export const EXPORT_UNSPLITTABLE_MESSAGE =
  "This note could not be exported: part of it is too large to fit on a single page and could not be divided safely. Nothing was downloaded, and the note is unchanged.";

/**
 * The height available to CONTENT on one page: html2pdf's own floored page box
 * (see templateExportCapture) less the reserved footer.
 *
 * The floored box is used deliberately rather than the unrounded geometry —
 * placing a block in a strip of page html2pdf has already paged past is exactly
 * how content ends up straddling a break.
 */
export function pageCapacityPx(footerHeightPx) {
  const footer = Number(footerHeightPx);
  const reserved = Number.isFinite(footer) && footer > 0 ? footer : 0;
  return Math.max(1, PDF_PAGE_CONTENT_HEIGHT_PX - reserved);
}

/**
 * Plan the pages for one prepared Free-form document.
 *
 * @param html    the prepared export HTML (assets resolved, images sized)
 * @param measure (blockHtml) => number — the rendered height of that block as
 *                it will appear on the page, wrapper included
 * @returns {{ok: true, pages, capacityPx}} | {{ok: false, reason, blockId}}
 */
export function planFreeformPdf(html, measure) {
  // The oracle is always handed the SAME markup the page will render, so the
  // planner can never measure one representation and emit another.
  const measureBlock = (blockHtml) => measure(blockWrapperHtml(blockHtml));

  const footerHeight = measure(buildFreeformPageFooterHtml(1, 1));
  const capacityPx = pageCapacityPx(footerHeight);

  // Wrapped images (Phase C3) are fused with the text flowing beside them
  // into single atomic wrap groups BEFORE any fitting — a page break can then
  // never slice through a float; a group that cannot fit a whole page has
  // already degraded its image to block placement deterministically. See
  // groupWrappedImageBlocks.
  const blocks = groupWrappedImageBlocks(
    extractFreeformBlocks(html),
    capacityPx,
    measureBlock
  );
  if (blocks.length === 0) {
    return { ok: true, pages: [[]], capacityPx };
  }

  /* ------------------------------ pass 1 ------------------------------ */
  const fitted = fitFreeformBlocks(blocks, capacityPx, measureBlock);
  if (!fitted.ok) return fitted;

  /* ------------------------------ pass 2 ------------------------------ */
  const byId = new Map();
  for (const block of fitted.blocks) byId.set(block.id, block);

  let splitCounter = 0;
  const splitBlock = (placed, remainingPx) => {
    const block = byId.get(placed.id);
    if (!block || !block.splittable) return null;

    const parts = splitFreeformBlockHtml(block.html, remainingPx, measureBlock);
    if (!parts) return null;

    const headHeight = measureBlock(parts.head);
    const tailHeight = measureBlock(parts.tail);
    // Defensive: a tail is a strict subset of its source laid out at the same
    // width, so it cannot be taller — but declining rather than trusting that
    // keeps pass 1's guarantee absolute. Declining simply moves the whole
    // fragment to a fresh page, where it is known to fit.
    if (headHeight > remainingPx || tailHeight > capacityPx) return null;

    splitCounter += 1;
    const headId = `${block.id}~h${splitCounter}`;
    const tailId = `${block.id}~t${splitCounter}`;
    byId.set(headId, { ...block, id: headId, html: parts.head, continued: true });
    byId.set(tailId, { ...block, id: tailId, html: parts.tail, continued: true });

    return {
      head: { id: headId, height: headHeight, splittable: false },
      tail: { id: tailId, height: tailHeight, splittable: block.splittable },
    };
  };

  const { pages } = paginateBlocks(
    fitted.blocks.map((block) => ({
      id: block.id,
      height: block.height,
      splittable: block.splittable,
      keepWithNext: block.keepWithNext,
    })),
    capacityPx,
    { splitBlock }
  );

  return {
    ok: true,
    capacityPx,
    pages: pages.map((page) =>
      page.map((placed) => byId.get(placed.id)).filter(Boolean)
    ),
  };
}

/** Every block of every page, in order — for the "exactly once, in order" invariant. */
export function flattenPlannedBlocks(pages) {
  const out = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const block of page || []) out.push(block);
  }
  return out;
}
