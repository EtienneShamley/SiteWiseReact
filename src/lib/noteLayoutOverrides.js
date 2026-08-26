// src/lib/noteLayoutOverrides.js
//
// A NOTE'S OWN table WIDTH overrides — the per-note presentation layer over
// the pinned TemplateVersion's layout:
//
//   instance.layoutOverrides = {
//     leftPct?:      number                      — the label/value divider
//     columnWidths?: { [columnId]: widthPct }    — the A2 value-column grid
//   }
//
// ---------------------------------------------------------------------------
// OWNERSHIP: the note instance, and nothing else
// ---------------------------------------------------------------------------
//
// The Builder's vertical dividers edit the TEMPLATE's layout defaults
// (`version.leftPct`, `version.valueColumns`) and publish them for every
// future note. A user completing a note is formatting THIS document: their
// drag lands here, on the `NoteTemplateInstance`, beside `rowHeights` and
// `sectionExtraHeight`. This module writes no template record (it is a pure
// map helper), a second note pinned to the same version simply has no entry
// and keeps the template defaults, and the override persists with the note.
//
// PRESENTATION ONLY, ONE GRID. A width override changes NO structure: no cell,
// no span, no column count, nothing a `rowCells` projection reads. The note
// stores only numbers against the version's own stable column ids, so every
// row still lays out against the ONE shared grid — a divider move realigns
// every row exposing that boundary, and a spanning cell simply spans the
// resulting note-level columns. There is deliberately no per-row width
// anywhere.
//
// ---------------------------------------------------------------------------
// GRID IDENTITY, AND WHY INVALID MEANS "TEMPLATE DEFAULTS"
// ---------------------------------------------------------------------------
//
// `columnWidths` is keyed by the grid's OWN stable column ids, never a blind
// positional array — so an override can never be applied to a grid it was not
// dragged on. A note is pinned to an immutable version, but it can be
// RE-PINNED to another template: the override then simply stops matching. The
// match rule is exact and total — the stored keys must be precisely the
// current grid's id set, every value a positive finite number — and anything
// else (missing id, extra id, junk value, wrong shape) falls back to the
// template defaults WITHOUT being repaired, rewritten or deleted on read,
// exactly the read-only tolerance every other instance collection follows.
//
// ---------------------------------------------------------------------------
// ONE WIDTH ALGORITHM
// ---------------------------------------------------------------------------
//
// Widths pass through the SAME `normalizeColumnWidths` the Builder's grid uses
// (sum to 100, `MIN_COLUMN_WIDTH_PCT` floor), and the label divider uses the
// same 10–40% clamp the Builder and the renderer already apply. Nothing here
// invents a second geometry.
//
// BACK TO THE TEMPLATE DEFAULT, NO RESIDUE. A drag that lands back on the
// template's own value REMOVES the override (leftPct by exact integer match —
// the drag rounds to integers; column widths within a small deterministic
// tolerance, because they are fractional percentages a pointer cannot be
// expected to hit exactly) — so a note returned to the default layout is
// indistinguishable from one that was never resized.
//
// Pure: no React, no DOM, no storage.

import { normalizeColumnWidths } from "./templateColumns";

/** The label divider's range — the same clamp the Builder and renderer apply. */
export const NOTE_LEFT_PCT_MIN = 10;
export const NOTE_LEFT_PCT_MAX = 40;

/**
 * How close (in percentage points, per column) a committed width must be to
 * the template default for the override to be considered "back at the
 * default" and removed. A quarter of one percent of the value area is well
 * under a pixel at A4, so removal can never visibly move the table.
 */
export const NOTE_WIDTH_MATCH_TOLERANCE_PCT = 0.25;

function clampLeftPct(value) {
  const px = Math.round(Number(value));
  if (!Number.isFinite(px)) return null;
  return Math.max(NOTE_LEFT_PCT_MIN, Math.min(NOTE_LEFT_PCT_MAX, px));
}

/**
 * A stored `layoutOverrides` object, defensively. Anything that is not a
 * plain object reads as "no overrides"; each key is kept only in its valid
 * shape. Never repairs or rewrites storage — this is a read-side view.
 */
export function normalizeNoteLayoutOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  const left = clampLeftPct(raw.leftPct);
  if (left !== null && Number.isFinite(Number(raw.leftPct))) out.leftPct = left;
  const widths = raw.columnWidths;
  if (widths && typeof widths === "object" && !Array.isArray(widths)) {
    const map = {};
    let ok = true;
    for (const id of Object.keys(widths)) {
      const value = Number(widths[id]);
      if (typeof id !== "string" || !id || !Number.isFinite(value) || value <= 0) {
        ok = false;
        break;
      }
      map[id] = value;
    }
    if (ok && Object.keys(map).length > 0) out.columnWidths = map;
  }
  return out;
}

/** The label share THIS NOTE renders: its override, else the template's. */
export function noteLeftPct(overrides, defaultPct) {
  const own = overrides && Number.isFinite(Number(overrides.leftPct))
    ? clampLeftPct(overrides.leftPct)
    : null;
  return own !== null ? own : defaultPct;
}

/**
 * The grid THIS NOTE renders: the template's grid with the note's widths, or
 * the template's grid UNCHANGED (same reference) when the note has no
 * override or the override does not match this grid — see the identity rule
 * in the file header. Structure (ids, order, count) always comes from the
 * grid; only `widthPct` can differ.
 */
export function noteColumnWidths(grid, overrides) {
  const columns = Array.isArray(grid) ? grid : [];
  const map = overrides && overrides.columnWidths;
  if (!map || typeof map !== "object" || Array.isArray(map)) return columns;
  const keys = Object.keys(map);
  if (keys.length !== columns.length || columns.length === 0) return columns;
  for (const column of columns) {
    const value = Number(map[column.id]);
    if (!(column.id in map) || !Number.isFinite(value) || value <= 0) {
      return columns;
    }
  }
  const widths = normalizeColumnWidths(
    columns.map((c) => Number(map[c.id])),
    columns.length
  );
  if (columns.every((c, i) => c.widthPct === widths[i])) return columns;
  return columns.map((c, i) =>
    c.widthPct === widths[i] ? c : { ...c, widthPct: widths[i] }
  );
}

/** Remove one key from an overrides object, dropping to `{}` when empty. */
function without(base, key) {
  if (!(key in base)) return base;
  const next = { ...base };
  delete next[key];
  return next;
}

/**
 * A `layoutOverrides` with the note's LABEL share replaced. Landing back on
 * the template default removes the key; a no-op returns the same reference.
 */
export function setNoteLeftPct(overrides, pct, defaultPct) {
  const base = normalizeNoteLayoutOverrides(overrides);
  const next = clampLeftPct(pct);
  if (next === null) return base;
  const fallback = clampLeftPct(defaultPct);
  if (fallback !== null && next === fallback) return without(base, "leftPct");
  if (base.leftPct === next) return base;
  return { ...base, leftPct: next };
}

/**
 * A `layoutOverrides` with the note's COLUMN WIDTHS replaced, keyed by the
 * template grid's own stable column ids.
 *
 * `defaultGrid` is the version's normalized grid — both the identity the
 * override is stored against and the defaults a landing drag is measured by.
 * Widths that match the defaults (within the tolerance above) REMOVE the
 * override; anything mis-shaped is refused with the same reference back.
 */
export function setNoteColumnWidths(overrides, defaultGrid, widths) {
  const base = normalizeNoteLayoutOverrides(overrides);
  const grid = Array.isArray(defaultGrid) ? defaultGrid : [];
  if (grid.length < 2) return base;
  if (!Array.isArray(widths) || widths.length !== grid.length) return base;
  const normalized = normalizeColumnWidths(widths, grid.length);
  const matchesDefault = grid.every(
    (c, i) => Math.abs(normalized[i] - c.widthPct) <= NOTE_WIDTH_MATCH_TOLERANCE_PCT
  );
  if (matchesDefault) return without(base, "columnWidths");
  const map = {};
  grid.forEach((c, i) => {
    map[c.id] = normalized[i];
  });
  const prev = base.columnWidths;
  if (
    prev &&
    Object.keys(prev).length === grid.length &&
    grid.every((c) => prev[c.id] === map[c.id])
  ) {
    return base;
  }
  return { ...base, columnWidths: map };
}
