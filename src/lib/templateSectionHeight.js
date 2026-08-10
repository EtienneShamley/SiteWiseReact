// src/lib/templateSectionHeight.js
//
// The OPTIONAL extra working space a user has dragged onto the bottom of a
// flexible Template section.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE VALUE FROM `row.px`
// ---------------------------------------------------------------------------
//
// A row's `px` is the LEGACY whole-row height: for a master row it comes from
// the note's pinned, immutable TemplateVersion; for a note-specific custom row
// it is `customRows[].preferredHeight`. It sizes a row whose body is its own
// answer control — a legacy Text row, a structured row, a Photo/File field —
// and none of that changes.
//
// It must NEVER be reinterpreted as a flexible section's height. That is
// precisely the defect that was fixed: a section whose first text item
// inherited `row.px || 120` reserved a large blank area above the photo beneath
// it. Reusing `row.px` here would recreate it for every existing note at once,
// silently, with no user action — so a flexible section's extra height is a
// SEPARATE, ADDITIVE, per-note value that only ever exists because the user
// dragged it into existence.
//
// The distinction is therefore structural rather than heuristic:
//
//   row.px                      legacy row height     — never read here
//   sectionExtraHeight[rowId]   explicit user drag    — absent until dragged
//
// An existing note has no `sectionExtraHeight` at all, so every existing
// flexible section stays exactly as content-driven as it is today. No
// migration, no schema bump, no TemplateVersion is ever rewritten.
//
// ---------------------------------------------------------------------------
// ADDITIVE, NOT A TOTAL — and why that is the safe model
// ---------------------------------------------------------------------------
//
// The stored number is EXTRA TRAILING SPACE, appended after the section's last
// item:
//
//   section height = natural content height + extra
//
// It is not a total minimum, and that matters when the content changes:
//
//   - a total would silently evaporate as content grew past it, and — worse —
//     would turn into a blank band the moment a tall item was REMOVED, which is
//     the same class of defect as the inherited `row.px`;
//   - extra space is what the user actually asked for ("give me room to work
//     below this"), and it stays exactly that size whatever the content does.
//
// Content therefore always establishes the minimum height: with no extra, a
// section wraps tightly around its items, and dragging upward reduces the extra
// to zero and stops. Nothing can be clipped, because the extra is real layout
// BELOW the content rather than a constraint on it.
//
// Pure: no React, no DOM, no storage.

import { USABLE_HEIGHT_PX } from "./pageGeometry";

/**
 * The largest extra a section may hold.
 *
 * One usable page. Beyond that the space is no longer "room to work below this
 * section" but a document structure problem, and an unbounded value would let a
 * mis-read pointer event push a note's pagination into hundreds of empty pages.
 */
export const SECTION_EXTRA_MAX_PX = Math.round(USABLE_HEIGHT_PX);

/**
 * A stored extra height, defensively.
 *
 * Anything that is not a finite non-negative number is 0 — no extra — which is
 * exactly the state of every note that predates this feature. Rounded to whole
 * pixels: the value is a layout hint that is measured back as an integer, so
 * storing sub-pixel drift would produce writes that change nothing visible.
 */
export function normalizeSectionExtraHeight(value) {
  const px = Number(value);
  if (!Number.isFinite(px) || px <= 0) return 0;
  return Math.min(SECTION_EXTRA_MAX_PX, Math.round(px));
}

/** One row's extra height. 0 when the user has never dragged this section. */
export function sectionExtraHeightFor(map, rowId) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return 0;
  if (typeof rowId !== "string" || !rowId) return 0;
  return normalizeSectionExtraHeight(map[rowId]);
}

/**
 * A `sectionExtraHeight` map with ONE row's value replaced. Other rows are
 * untouched.
 *
 * A value of 0 REMOVES the key rather than storing a zero. Dragging the handle
 * back up to the content leaves the section in the same state as one that was
 * never dragged at all — no residue in storage, and nothing for a later reader
 * to have to interpret.
 */
export function setSectionExtraHeight(map, rowId, px) {
  const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (typeof rowId !== "string" || !rowId) return base;
  const next = normalizeSectionExtraHeight(px);
  if (next === 0) {
    if (!(rowId in base)) return base;
    const cleared = { ...base };
    delete cleared[rowId];
    return cleared;
  }
  return { ...base, [rowId]: next };
}

/** A `sectionExtraHeight` map with ONE row's entry removed (row deletion). */
export function removeSectionExtraHeight(map, rowId) {
  return setSectionExtraHeight(map, rowId, 0);
}

/**
 * The extra a drag should produce, from where it started and how far it moved.
 *
 * Kept here rather than in the pointer handler so the one rule that makes the
 * gesture safe is testable without a DOM: the result can never go below zero,
 * so dragging upward stops at the content and can never ask for a section
 * shorter than what is in it.
 */
export function resizeSectionExtraHeight(startExtraPx, deltaY) {
  const start = normalizeSectionExtraHeight(startExtraPx);
  const dy = Number(deltaY);
  if (!Number.isFinite(dy)) return start;
  return normalizeSectionExtraHeight(start + dy);
}
