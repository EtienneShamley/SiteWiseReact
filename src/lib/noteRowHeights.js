// src/lib/noteRowHeights.js
//
// A NOTE'S OWN deliberately-dragged row heights — the per-note layout override
// for a row whose body is its own answer control (a legacy Text answer, a
// structured Number/Date/Time/Checkbox/Yes-No/Dropdown control, a Photo/File
// field head).
//
// ---------------------------------------------------------------------------
// OWNERSHIP: the note instance, and nothing else
// ---------------------------------------------------------------------------
//
// The Template Builder's row-height drag writes `row.px` + `pxExplicit` into
// the DRAFT definition and publishes it into a new immutable TemplateVersion —
// a template-layout default for every FUTURE note. A user completing a note is
// doing something categorically different: choosing the presentation of THIS
// document. That choice lives here, on the `NoteTemplateInstance`
// (`instance.rowHeights`), exactly where `sectionExtraHeight` and `customRows`
// already live — so:
//
//   - resizing a row in a filled note NEVER touches the pinned, immutable
//     TemplateVersion (there is no writer from this module to any template
//     record at all — it is a pure map helper);
//   - a second note pinned to the same version keeps the template default,
//     because its own instance simply has no entry;
//   - the override survives leaving the note, reopening it and reloading,
//     because the instance is the same persisted record everything else the
//     note owns already survives through.
//
// ---------------------------------------------------------------------------
// A MINIMUM, NEVER A TOTAL — content remains the hard floor
// ---------------------------------------------------------------------------
//
// The stored number is applied by overlaying `px` + `pxExplicit: true` onto the
// row before it reaches `rowMinHeightPx` (src/lib/templateRowHeight.js), whose
// contract is already exactly the required model:
//
//   rendered height = max(content floor, deliberate minimum)
//
// So a manual height can reserve space but can never clip: a Date control, a
// wrapped paragraph, an image or a file card that needs more room simply grows
// the row past the stored minimum, with no second rule anywhere. This is the
// same overlay shape a note-specific custom row has always used
// (`preferredHeight` + `heightExplicit` → `px` + `pxExplicit`), stated for
// master rows.
//
// It is deliberately NOT `sectionExtraHeight`. That value is ADDITIVE trailing
// space below a flexible Section's content (src/lib/templateSectionHeight.js)
// and remains that surface's own model, untouched; this one is a MINIMUM for a
// row whose body is a control, the model `row.px` has always had. The two are
// disjoint by construction: the row-height handle renders only on rows whose
// body is not a Section document, and the Section handle only on Section
// tails, so no row can ever hold both.
//
// ---------------------------------------------------------------------------
// BACK TO AUTO, NOT A STORED RESIDUE
// ---------------------------------------------------------------------------
//
// Dragging a row back to the height it would have anyway (its content floor,
// or the template's own explicit default) REMOVES the entry rather than
// storing a number that changes nothing — so a row returned to its natural
// size is indistinguishable from one that was never dragged, exactly the rule
// `setSectionExtraHeight` established. An existing note has no `rowHeights` at
// all and reads as "nothing was ever resized".
//
// Pure: no React, no DOM, no storage.

import { USABLE_HEIGHT_PX } from "./pageGeometry";

/**
 * The largest minimum a note may pin one row to: one usable page, the same
 * guard `SECTION_EXTRA_MAX_PX` applies for the same reason — beyond it the
 * value is no longer a row height but a runaway pointer event, and an
 * unbounded number would push a note's pagination into empty pages.
 */
export const NOTE_ROW_HEIGHT_MAX_PX = Math.round(USABLE_HEIGHT_PX);

/**
 * A stored note row height, defensively. Anything that is not a finite
 * positive number is 0 — "no override", the state of every note that predates
 * this feature. Whole pixels, capped at one usable page.
 */
export function normalizeNoteRowHeight(value) {
  const px = Number(value);
  if (!Number.isFinite(px) || px <= 0) return 0;
  return Math.min(NOTE_ROW_HEIGHT_MAX_PX, Math.round(px));
}

/** One row's override. 0 when this note never dragged this row. */
export function noteRowHeightFor(map, rowId) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return 0;
  if (typeof rowId !== "string" || !rowId) return 0;
  return normalizeNoteRowHeight(map[rowId]);
}

/**
 * A `rowHeights` map with ONE row's override replaced. Other rows untouched;
 * the same reference back when nothing changes, so a no-op commit cannot drive
 * a render or a save loop.
 *
 * `defaultPx` is the height the row would render WITHOUT any override — its
 * content floor, raised by the template's own explicit height if the version
 * carries one (`rowMinHeightPx` of the un-overridden row). Landing back on it
 * REMOVES the entry: the row has returned to auto, and storing the default as
 * an override would only pin the row to a number the template may later stop
 * meaning.
 */
export function setNoteRowHeight(map, rowId, px, defaultPx) {
  const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (typeof rowId !== "string" || !rowId) return base;
  const next = normalizeNoteRowHeight(px);
  if (next === 0 || next === normalizeNoteRowHeight(defaultPx)) {
    if (!(rowId in base)) return base;
    const cleared = { ...base };
    delete cleared[rowId];
    return cleared;
  }
  if (base[rowId] === next) return base;
  return { ...base, [rowId]: next };
}

/** A `rowHeights` map with ONE row's entry removed. */
export function removeNoteRowHeight(map, rowId) {
  const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (typeof rowId !== "string" || !rowId || !(rowId in base)) return base;
  const cleared = { ...base };
  delete cleared[rowId];
  return cleared;
}

/**
 * The note's rows with its overrides APPLIED — the one overlay both consumers
 * use, so the live document and the export model cannot disagree about what an
 * override means.
 *
 * An overridden row carries the override as `px` with the `pxExplicit` marker,
 * which is the ONLY shape `rowMinHeightPx` honours as deliberate — so the
 * override flows through the existing floor rule (max of content floor and the
 * stored minimum) without a single new height computation anywhere. The
 * override REPLACES a template-explicit `px` for this note: the note user's
 * deliberate choice supersedes the template's default in this one document,
 * including choosing a SMALLER height, where the content floor still holds.
 *
 * Rows without an entry are returned by reference, so an untouched note maps
 * to the same row objects it started with.
 */
export function applyNoteRowHeights(rows, map) {
  const list = Array.isArray(rows) ? rows : [];
  if (!map || typeof map !== "object" || Array.isArray(map)) return list;
  return list.map((row) => {
    if (!row || !row.id) return row;
    const px = noteRowHeightFor(map, row.id);
    return px > 0 ? { ...row, px, pxExplicit: true } : row;
  });
}
