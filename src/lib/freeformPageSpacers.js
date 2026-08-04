// src/lib/freeformPageSpacers.js
//
// The measured page PLAN for the Free-form editor's visual sheets: given the
// laid-out geometry of the document's top-level blocks, decide where a sheet
// ends and how much real vertical space has to be inserted before the next one
// begins.
//
// Pure arithmetic. No React, no DOM, no TipTap, no ProseMirror, no persistence
// — and deliberately not part of any export path. The caller measures; this
// module decides; the ProseMirror plugin renders. Keeping the decision here is
// what makes it testable without a browser layout engine.
//
// ---------------------------------------------------------------------------
// Why a plan, and not a painted overlay
// ---------------------------------------------------------------------------
// An overlay drawn at arithmetic multiples of the page height cannot separate
// anything: text keeps flowing straight through it, so a sentence still lands
// in the painted "bottom margin" and the next sheet still starts mid-paragraph.
// The only way an editable document can genuinely read as separate sheets is to
// occupy real vertical space at the boundary. That space is inserted as a
// non-persistent ProseMirror widget decoration (see
// src/components/editor/freeformPageSpacerPlugin.js) — never as a node, never
// as stored content.
//
// ---------------------------------------------------------------------------
// Natural coordinates
// ---------------------------------------------------------------------------
// Spacers are themselves part of the rendered layout, so measuring the document
// while they exist would feed their own height back into the next plan. Every
// measurement is therefore converted to NATURAL coordinates first — the
// positions the blocks would have with no spacer present — by subtracting the
// cumulative spacer height above each block (see `naturalBlockGeometry`). A
// plan computed in natural coordinates is stable: inserting the spacers it asks
// for shifts every later block by exactly the amount that is subtracted back
// out on the next measurement, so a second pass produces an identical plan and
// the layout settles after one extra frame.
import { PAGE_FIT_EPSILON_PX } from "./freeformPageGuides";

// A note always occupies at least one sheet, including an empty one.
export const MIN_VISUAL_PAGE_COUNT = 1;

const toFinite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/**
 * Convert an ordered measurement of the editable element's direct children into
 * spacer-free NATURAL block geometry.
 *
 * `entries` must be in document order, each one either
 *   { spacer: true, heightPx }                      — a rendered page spacer
 *   { spacer: false, pos, top, bottom }             — a top-level block
 * with `top`/`bottom` measured relative to the top of the editable element as
 * it is CURRENTLY rendered (spacers included). Anything else in the element —
 * a gap cursor, a placeholder — is simply left out by the caller.
 *
 * The returned blocks carry the positions those same blocks would occupy with
 * no spacer in the document at all, which is the only coordinate space in which
 * a plan can be compared with the plan that produced the current layout.
 */
export function naturalBlockGeometry(entries) {
  if (!Array.isArray(entries)) return [];
  let spacerOffset = 0;
  const blocks = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.spacer) {
      spacerOffset += Math.max(0, toFinite(entry.heightPx));
      continue;
    }
    const top = toFinite(entry.top) - spacerOffset;
    const bottom = toFinite(entry.bottom) - spacerOffset;
    blocks.push({
      pos: entry.pos,
      top,
      // A block can never be shorter than nothing; a zero-height measurement
      // (an image still decoding) is carried through honestly rather than
      // inverted.
      bottom: Math.max(top, bottom),
    });
  }
  return blocks;
}

/**
 * How much real space a spacer must occupy at one sheet boundary.
 *
 *   fillPx   the unused remainder of the sheet that is ending, so the sheet
 *            keeps its full height and the next one starts at a sheet top
 *   marginPx the ending sheet's bottom paper margin
 *   gapPx    the visible workspace gap between the two pieces of paper
 *   marginPx the next sheet's top paper margin
 *
 * `fillPx` is floored at zero: a single block taller than one sheet overruns
 * its sheet (see the oversized-block rule below) rather than producing negative
 * space.
 */
export function pageSpacerHeightPx({ fillPx, marginPx, gapPx }) {
  const fill = Math.max(0, toFinite(fillPx));
  const margin = Math.max(0, toFinite(marginPx));
  const gap = Math.max(0, toFinite(gapPx));
  return fill + margin + gap + margin;
}

/** Where the workspace gap starts inside a spacer, measured from its own top. */
export function pageSpacerGapOffsetPx(spacer) {
  if (!spacer) return 0;
  return Math.max(0, toFinite(spacer.fillPx)) + Math.max(0, toFinite(spacer.marginPx));
}

/**
 * Plan the sheet boundaries for one measured document.
 *
 * `blocks` must be NATURAL geometry in document order (see
 * `naturalBlockGeometry`). Every boundary lands on a block start — between two
 * top-level blocks and nowhere else — so a paragraph, a list item, a table row,
 * an image, a file card, a code block or an inline mark can never be split.
 *
 * OVERSIZED BLOCKS. A single block may be taller than one sheet. It is never
 * fragmented on this branch: it stays intact and editable, it is allowed to
 * overrun its sheet, and the block AFTER it starts a new sheet. That rule is
 * deterministic — the first block on a sheet never triggers a boundary — which
 * is also what makes the planner terminate on any input.
 *
 * Returns a frozen plan:
 *   pageCount       how many sheets the document occupies (at least one)
 *   spacers         one entry per boundary, in document order
 *   columnHeightPx  the rendered height the paper column must reserve so the
 *                   final sheet is drawn whole rather than cut off at the last
 *                   line of text
 */
export function planFreeformPageSpacers(
  blocks,
  { capacityPx, marginPx = 0, gapPx = 0, epsilonPx = PAGE_FIT_EPSILON_PX } = {}
) {
  const capacity = toFinite(capacityPx);
  const empty = Object.freeze({
    pageCount: MIN_VISUAL_PAGE_COUNT,
    spacers: Object.freeze([]),
    columnHeightPx: capacity > 0 ? capacity : 0,
  });
  if (capacity <= 0) return empty;
  if (!Array.isArray(blocks) || blocks.length === 0) return empty;

  const epsilon = Math.max(0, toFinite(epsilonPx));
  const spacers = [];

  // The natural y-coordinate at which the CURRENT sheet's usable region starts.
  let pageTop = 0;
  // The natural bottom of the last block placed on the current sheet.
  let pageBottom = 0;
  let firstOnPage = true;

  for (const block of blocks) {
    if (!block) continue;
    const top = toFinite(block.top);
    const bottom = toFinite(block.bottom);

    // The first block on a sheet always stays on it, however tall it is. Any
    // later block that would run past the usable region moves to the next.
    if (!firstOnPage && bottom - pageTop > capacity + epsilon) {
      const fillPx = pageTop + capacity - pageBottom;
      spacers.push(
        Object.freeze({
          pos: block.pos,
          // The sheet this boundary INTRODUCES: the first spacer starts page 2.
          page: spacers.length + 2,
          fillPx: Math.max(0, fillPx),
          marginPx: Math.max(0, toFinite(marginPx)),
          gapPx: Math.max(0, toFinite(gapPx)),
          heightPx: pageSpacerHeightPx({ fillPx, marginPx, gapPx }),
        })
      );
      pageTop = top;
      firstOnPage = true;
    }

    pageBottom = bottom;
    firstOnPage = false;
  }

  const spacerHeightPx = spacers.reduce((total, one) => total + one.heightPx, 0);
  // The final sheet is drawn at its full height unless a single oversized block
  // has already pushed past it, in which case the real content height wins.
  const lastPageHeightPx = Math.max(capacity, pageBottom - pageTop);

  return Object.freeze({
    pageCount: spacers.length + 1,
    spacers: Object.freeze(spacers),
    columnHeightPx: pageTop + spacerHeightPx + lastPageHeightPx,
  });
}

/**
 * Whether two plans describe the same layout.
 *
 * A measurement that produces an identical plan must produce NO update at all —
 * no ProseMirror transaction, no decoration rebuild and no React state change —
 * because the spacers themselves are part of what is being measured, and an
 * update per measurement is exactly how a layout feedback loop starts.
 */
export function samePageSpacerPlan(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.pageCount !== b.pageCount) return false;
  if (!nearly(a.columnHeightPx, b.columnHeightPx)) return false;
  if (a.spacers.length !== b.spacers.length) return false;
  for (let index = 0; index < a.spacers.length; index += 1) {
    const one = a.spacers[index];
    const other = b.spacers[index];
    if (one.pos !== other.pos) return false;
    if (one.page !== other.page) return false;
    if (!nearly(one.heightPx, other.heightPx)) return false;
    if (!nearly(one.fillPx, other.fillPx)) return false;
    if (!nearly(one.marginPx, other.marginPx)) return false;
    if (!nearly(one.gapPx, other.gapPx)) return false;
  }
  return true;
}

// Sub-pixel layout jitter in a geometry that has not really changed must not
// count as a change; the threshold matches the planner's own fit tolerance.
function nearly(a, b) {
  return Math.abs(toFinite(a) - toFinite(b)) <= PAGE_FIT_EPSILON_PX;
}
