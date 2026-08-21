// src/lib/templateRowHeight.js
//
// HOW TALL A TEMPLATE ROW IS — the one statement of the rule, so the live
// document, the pagination planner and the PDF exporter can never disagree
// about it.
//
// ---------------------------------------------------------------------------
// THE MODEL: content-driven, with a floor that fits what the cell renders
// ---------------------------------------------------------------------------
//
// A row is as tall as what is in it. Nothing here sets a height; everything here
// returns a MINIMUM, and every consumer applies it as a `min-height` on a real
// box or as a pagination floor that measurement replaces. One line of text is a
// compact row; a second line grows it; an image grows it further; a structured
// control keeps enough room to stay fully clickable. There is no rigid pixel
// height anywhere in this model, and no path by which content can be clipped.
//
// The floors are derived from what the cell actually renders, measured off the
// classes the renderer uses rather than chosen by eye:
//
//   COMPACT_ROW_MIN_PX   36 = 20px line box + 8px + 8px cell padding
//                        (`.twocol-cell-right` is `py-2`; document text is
//                        `text-sm`, a 20px line box). One line of prose, its
//                        normal vertical breathing room, and nothing else.
//
//   CONTROL_ROW_MIN_PX   48 = 30px control + 8px + 8px cell padding, rounded up
//                        to the next even pixel for the focus ring. A structured
//                        control (`.twocol-*` input: `text-sm`, `py-1`, 1px
//                        border) is 30px tall, and a native date/time input
//                        carries its picker button INSIDE that box — so a row at
//                        this floor shows the whole control, button included,
//                        with room for the focus outline. This is the number
//                        that keeps Date, Time, Number and the two select-based
//                        types from being clipped by a compact row.
//
//   ATTACHMENT_HEAD_MIN_PX  56 — unchanged. The legacy Photo/File field's head
//                        holds an upload button and its hint; this is the value
//                        that surface has always used.
//
//   LEGACY_EVIDENCE_MIN_PX  170 — unchanged. A row rendering the legacy base64
//                        compatibility strip needs room for its images whatever
//                        else the row is doing.
//
// ---------------------------------------------------------------------------
// WHY STORED `px` NO LONGER RESERVES BLANK HEIGHT
// ---------------------------------------------------------------------------
//
// `row.px` was documented from the beginning as "the row's PREFERRED height
// while it is still empty — a starting point the user may drag". In practice
// every row carries one: the default scaffold ships 56–128px, `makeNewRow` wrote
// 64, and read-time normalization supplied 120 for a row that had none. Nothing
// distinguished "a user dragged this row to this height" from "the scaffold
// wrote a number here", so every template reserved blank vertical space in every
// row — the tall-rows problem, and it could not be fixed while `px` alone was
// the answer.
//
// So `px` is DEMOTED, not removed: it is honoured as a floor only on a row that
// carries `pxExplicit: true`, the marker written when a user genuinely drags a
// row's height (see `explicitRowHeight`). A stored row without the marker —
// every row published before this phase — is sized by its content instead.
//
// Nothing is lost and nothing is rewritten by this. `px` stays in storage on
// every row that has it, stays readable, and is honoured again the moment the
// marker is present. No content-bearing row shrinks: a row's height is the
// larger of this floor and what it actually renders, so demoting the floor can
// only remove EMPTY reserved space. Adopted 2026-08-20 — see
// `docs/PROJECT_DECISIONS.md`.

import { FIELD_TYPE, normalizeType } from "./templateFields";

/** One line of document prose, with its cell padding. */
export const COMPACT_ROW_MIN_PX = 36;

/** A structured control, its cell padding and its focus ring. */
export const CONTROL_ROW_MIN_PX = 48;

/** The legacy Photo/File field head (upload control + hint). Unchanged. */
export const ATTACHMENT_HEAD_MIN_PX = 56;

/** A row rendering the legacy base64 evidence strip. Unchanged. */
export const LEGACY_EVIDENCE_MIN_PX = 170;

/**
 * The field types that render a structured CONTROL rather than prose, and so
 * need the taller floor.
 *
 * Photo/File are absent deliberately: they are the compound attachment field,
 * whose head has its own floor above, and whose type is never a cell's control.
 */
const CONTROL_FIELD_TYPES = new Set([
  FIELD_TYPE.NUMBER,
  FIELD_TYPE.DATE,
  FIELD_TYPE.TIME,
  FIELD_TYPE.CHECKBOX,
  FIELD_TYPE.YESNO,
  FIELD_TYPE.SELECT,
]);

/** The content floor for ONE value cell, from what that cell renders. */
export function cellMinHeightPx(type) {
  return CONTROL_FIELD_TYPES.has(normalizeType(type))
    ? CONTROL_ROW_MIN_PX
    : COMPACT_ROW_MIN_PX;
}

/**
 * The height a user DELIBERATELY dragged this row to, or 0.
 *
 * The marker is what separates a deliberate height from a scaffold default —
 * see the file header. A row carrying the marker but no usable number has no
 * explicit height, so a corrupt or hand-edited marker degrades to
 * content-driven sizing rather than to a broken box.
 */
export function explicitRowHeight(row) {
  if (!row || row.pxExplicit !== true) return 0;
  const px = Number(row.px);
  return Number.isFinite(px) && px > 0 ? Math.round(px) : 0;
}

/** True when this row's stored height is a deliberate one. */
export function hasExplicitRowHeight(row) {
  return explicitRowHeight(row) > 0;
}

/**
 * The MINIMUM height of one row's box.
 *
 * `cells` is the row's value cells (see `templateColumns.js`): a multi-column
 * row is as tall as its TALLEST column needs to be, which is what makes a row
 * of one-line fields compact and a row containing a date control tall enough
 * for it.
 *
 * `hasLegacyEvidence` raises the floor for the legacy base64 compatibility
 * strip; `isAttachmentField` selects the Photo/File head's own floor. An
 * explicit dragged height wins over all of them when it is larger — a user who
 * made a row taller keeps that row taller — but can never make a row SHORTER
 * than its content needs, because this is a minimum and the content is measured.
 */
export function rowMinHeightPx({
  row = null,
  cells = null,
  isAttachmentField = false,
  hasLegacyEvidence = false,
} = {}) {
  const list = Array.isArray(cells) && cells.length ? cells : null;
  const contentFloor = isAttachmentField
    ? ATTACHMENT_HEAD_MIN_PX
    : list
    ? list.reduce((max, cell) => Math.max(max, cellMinHeightPx(cell.type)), 0)
    : cellMinHeightPx(row ? row.type : FIELD_TYPE.TEXT);

  const floor = hasLegacyEvidence
    ? Math.max(contentFloor, LEGACY_EVIDENCE_MIN_PX)
    : contentFloor;

  return Math.max(floor, explicitRowHeight(row));
}

/**
 * The lower bound of the row-height DRAG.
 *
 * It is the row's own content floor, so a user can always drag a row back down
 * to compact — the legacy stored `minPx` (100 by default, which is nearly three
 * lines) would otherwise make the tall rows this phase removes impossible to
 * shrink by hand. Dragging can only ever set a minimum, so this cannot clip
 * anything either.
 */
export function rowDragMinPx({
  row = null,
  cells = null,
  isAttachmentField = false,
  hasLegacyEvidence = false,
} = {}) {
  // `row: null` deliberately: the drag floor is the CONTENT floor, never the
  // height the row is currently pinned to — otherwise a row could only ever be
  // dragged taller.
  return rowMinHeightPx({
    row: row ? { type: row.type } : null,
    cells,
    isAttachmentField,
    hasLegacyEvidence,
  });
}

/**
 * The patch a completed row-height drag writes.
 *
 * Always stamps the marker: a height a user dragged is, by definition, a
 * deliberate one. Kept here rather than at the drag site so the marker and the
 * rule that reads it can never drift apart.
 */
export function explicitRowHeightPatch(px) {
  const value = Math.round(Number(px) || 0);
  return { px: Math.max(COMPACT_ROW_MIN_PX, value), pxExplicit: true };
}
