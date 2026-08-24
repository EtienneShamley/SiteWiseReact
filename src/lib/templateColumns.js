// src/lib/templateColumns.js
//
// THE TEMPLATE TABLE GRID — the value-column grid a template's table is built
// on, and the cells each row maps onto it.
//
// A Template's table has ALWAYS had a label column and a value area. This module
// gives the value area a real GRID of vertical columns, shared by every row, and
// lets one row divide its own share of that grid without inventing a second
// column system.
//
//     TABLE   the authoritative value-column grid: an ordered list of columns
//             with normalized percentage widths that sum to 100. It belongs to
//             the TemplateVersion, exactly as `leftPct` already does, so a
//             column runs vertically THROUGH the table and every row aligns to
//             the same edges.
//
//     ROW     an ordered list of CELLS mapped onto that grid. Each cell has a
//             stable id and SPANS one or more grid columns. A row's spans always
//             total the grid's column count, so every row covers the value area
//             exactly once — the same rule an HTML table's `colspan` obeys.
//
// So the two product behaviours are ONE model:
//
//     Insert table column right      the GRID gains a column; every row is
//                                    adjusted (a cell the new column falls
//                                    inside simply grows, a cell boundary gains
//                                    a new cell)
//     Split cell                     this row's cell becomes two. If it already
//                                    spans several grid columns nothing else in
//                                    the table changes at all; if it spans one,
//                                    the grid gains a column and EVERY OTHER
//                                    row's covering cell absorbs it, so no other
//                                    row's structure changes either
//
//     table value grid = 3 columns
//     Row A  [ ------------ 3 ------------ ]
//     Row B  [ --- 1 --- ][ ------ 2 ------ ]
//     Row C  [ - 1 - ][ - 1 - ][ - 1 - ]
//
// This is a constrained DOCUMENT table and nothing more: no formulas, no
// selection model, no arbitrary cell positioning, no row spanning, no merge
// tooling beyond the one operation that reverses a split.
//
// ---------------------------------------------------------------------------
// THE COMPATIBILITY PROJECTION (why no template is ever migrated)
// ---------------------------------------------------------------------------
//
// Both keys are ADDITIVE and OPTIONAL:
//
//   version.valueColumns   absent  ->  ONE column at 100% of the value area
//   row.cells              absent  ->  ONE cell spanning the WHOLE grid, whose
//                                      id IS the row id and which carries the
//                                      row's own type and options
//
// So an existing `| Label | Value |` template is exactly what it always was: a
// one-column grid with one full-width cell per row. When the grid later grows, a
// row nobody has touched keeps its single cell and that cell simply spans the
// available value grid — it still stores no `cells` key at all, because "one
// cell spanning everything, keyed by the row id" is precisely what its absence
// already means. A row writes `cells` only once it genuinely differs from that,
// and drops the key again the moment it returns to it.
//
// THE FIRST/DEFAULT CELL'S ID IS THE ROW ID, and that single fact is what makes
// the whole change additive. Every per-row collection a completed note owns —
// `answers`, `attachments`, `evidence`, `sectionContent`, `sectionDoc`,
// `sectionExtraHeight` — is keyed by an OPAQUE id, as are Section editor
// identities, Refine target keys and Quick Add routing. Reading them by CELL id
// resolves the identical entry, so an existing note renders and exports through
// the same code with the same inputs. A cell created by a split or a column
// insertion mints a fresh id and keys into those same maps beside it; a cell
// that is split KEEPS its id, so its content stays exactly where it was.
//
// Nothing here writes storage, mints an id on an ordinary read, or rewrites an
// immutable TemplateVersion.
//
// ---------------------------------------------------------------------------
// WIDTHS BELONG TO THE TABLE, NEVER TO A ROW
// ---------------------------------------------------------------------------
//
// A grid column's `widthPct` is a normalized percentage of the VALUE AREA (the
// table less the label column). The widths of the grid sum to exactly 100, no
// width is ever negative, NaN or below `MIN_COLUMN_WIDTH_PCT`, and no row holds
// a width of its own: a cell simply occupies the combined width of the columns
// it spans. There is no per-row width authority and no pixel authority anywhere
// in this model — a percentage means the same thing at every zoom level, on
// every page size and in every export flavour.
//
// The LABEL column keeps its existing owner, the version-level `leftPct`. It is
// one ratio shared by every row and is deliberately not part of this grid: the
// label column must stay a straight edge down the whole page, and keeping it
// where it already is means no stored template changes shape.

import { newId } from "./id";
import {
  DEFAULT_BUILDER_FIELD_TYPE,
  canAddFieldControl,
  canRemoveFieldControl,
  isFieldControlType,
  makeOption,
  normalizeOptions,
  normalizeType,
} from "./templateFields";
import { normalizeFill, storedFill } from "./templateFill";

/**
 * The most value columns one table's grid may hold, label column excluded.
 *
 * Four, because the constraint is PAGE USABILITY rather than an arbitrary
 * ceiling: at the shared page geometry the value area is ~139mm wide (170mm
 * usable, less an 18% label column), so four columns are ~35mm each — still wide
 * enough for the widest structured control this system renders (a native date
 * input with its picker button). A fifth would produce columns no control fits
 * in, which is not a layout anybody wants and not one this editor should be able
 * to create.
 */
export const MAX_VALUE_COLUMNS = 4;

/**
 * The narrowest a grid column may become, as a percentage of the value area.
 *
 * A floor rather than a pixel minimum, for the same reason widths are
 * percentages: it means the same thing at every page size and zoom level. At the
 * shared geometry 12% of ~139mm is ~17mm, which is the point below which a
 * column stops being able to show anything at all.
 */
export const MIN_COLUMN_WIDTH_PCT = 12;

/** Which side of a cell a table column is inserted on, or a cell merged with. */
export const COLUMN_SIDE = { LEFT: "left", RIGHT: "right" };

export function normalizeColumnSide(side) {
  return side === COLUMN_SIDE.LEFT ? COLUMN_SIDE.LEFT : COLUMN_SIDE.RIGHT;
}

// Percentages are rounded to two decimal places before being stored, so a stored
// grid never carries a 17-digit float, and the ROUNDING REMAINDER is absorbed by
// the last column — which is what makes the sum exactly 100 rather than 99.99.
const WIDTH_DECIMALS = 2;

function roundPct(value) {
  const factor = 10 ** WIDTH_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Clamp every width to the minimum, rebalance the deficit across the columns
 * that have room, and make the total exactly 100.
 *
 * The deficit is taken PROPORTIONALLY from the columns above the minimum, so a
 * wide column gives up more than a narrow one and the relative shape of the
 * table survives. The loop is bounded by the column count: each pass either
 * finishes or pins one more column at the minimum, and `MAX_VALUE_COLUMNS × MIN`
 * is always well under 100, so it always converges.
 */
function enforceMinimum(values) {
  const n = values.length;
  if (n === 1) return [100];
  let current = values.slice();

  for (let pass = 0; pass < n; pass += 1) {
    const below = current.filter((v) => v < MIN_COLUMN_WIDTH_PCT).length;
    if (below === 0) break;
    const pinnedTotal = below * MIN_COLUMN_WIDTH_PCT;
    const freeTotal = current.reduce(
      (sum, v) => sum + (v < MIN_COLUMN_WIDTH_PCT ? 0 : v),
      0
    );
    const room = Math.max(0, 100 - pinnedTotal);
    current = current.map((v) => {
      if (v < MIN_COLUMN_WIDTH_PCT) return MIN_COLUMN_WIDTH_PCT;
      return freeTotal > 0 ? (v * room) / freeTotal : room / (n - below);
    });
  }

  const rounded = current.map(roundPct);
  const drift = roundPct(100 - rounded.reduce((sum, v) => sum + v, 0));
  if (drift !== 0) {
    rounded[rounded.length - 1] = roundPct(rounded[rounded.length - 1] + drift);
  }
  return rounded;
}

/**
 * Turn any list of candidate widths into a valid one: `count` positive numbers,
 * none below the minimum, summing to exactly 100.
 *
 * Every path that can produce a width goes through this — insertion, deletion,
 * splitting, resizing and the read-time projection of a stored grid — so an
 * invalid width cannot reach layout or storage from any direction, including
 * from a hand-edited or foreign stored version.
 *
 * A missing, non-finite or non-positive entry is treated as ABSENT rather than
 * as zero, and absent entries share whatever the present ones leave over. When
 * nothing usable is present at all the columns are simply equal.
 */
export function normalizeColumnWidths(widths, count) {
  const n = Math.max(1, Math.min(MAX_VALUE_COLUMNS, Math.floor(Number(count) || 0)));
  if (n === 1) return [100];

  const list = Array.isArray(widths) ? widths : [];
  const raw = [];
  for (let i = 0; i < n; i += 1) {
    const value = Number(list[i]);
    raw.push(Number.isFinite(value) && value > 0 ? value : null);
  }

  const presentTotal = raw.reduce((sum, v) => sum + (v || 0), 0);
  const missing = raw.filter((v) => v === null).length;

  let scaled;
  if (presentTotal <= 0) {
    scaled = raw.map(() => 100 / n);
  } else if (missing === 0) {
    scaled = raw.map((v) => (v * 100) / presentTotal);
  } else {
    // Keep the present columns' own shares (capped so the absent ones are not
    // squeezed below the minimum) and split the remainder equally among them.
    const room = Math.max(0, 100 - missing * MIN_COLUMN_WIDTH_PCT);
    const factor = presentTotal > room ? room / presentTotal : 1;
    const used = presentTotal * factor;
    const share = (100 - used) / missing;
    scaled = raw.map((v) => (v === null ? share : v * factor));
  }

  return enforceMinimum(scaled);
}

/**
 * The table's VALUE-COLUMN GRID, for rendering — `[{ id, widthPct }]`, always at
 * least one column and never more than `MAX_VALUE_COLUMNS`.
 *
 * Pure and non-destructive: it never writes, never mints an id on a read (a
 * stored column without an id falls back to a DETERMINISTIC positional id, the
 * same rule `normalizeRow` uses for a row) and never rewrites the stored
 * version. Absent, empty or malformed storage reads as the single full-width
 * column every template has always had.
 */
export function valueColumns(stored) {
  const list = Array.isArray(stored) ? stored.slice(0, MAX_VALUE_COLUMNS) : [];
  if (list.length === 0) return [{ id: "col-0", widthPct: 100 }];
  const widths = normalizeColumnWidths(
    list.map((c) => (c && typeof c === "object" ? c.widthPct : c)),
    list.length
  );
  return list.map((c, index) => ({
    id: (c && typeof c === "object" && c.id) || `col-${index}`,
    widthPct: widths[index],
  }));
}

/** How many value columns the table's grid has. Always at least one. */
export function valueColumnCount(stored) {
  return valueColumns(stored).length;
}

/**
 * The grid as it should be STORED, or `null` for the default single full-width
 * column.
 *
 * `null` rather than a one-entry array is what keeps an untouched template
 * publishing exactly the bytes it always did: a version that predates the grid
 * has no such key, and `publishTemplateVersion` compares the two by canonical
 * identity, so the projection of "no grid" and a freshly normalized default must
 * be the same value.
 */
export function storedValueColumns(columns) {
  const list = valueColumns(columns);
  return list.length <= 1 ? null : list.map((c) => ({ id: c.id, widthPct: c.widthPct }));
}

/** A brand-new grid column. One of the two places an id is minted here. */
function makeColumn(widthPct) {
  return { id: newId(), widthPct: Number(widthPct) || 0 };
}

/**
 * A brand-new value cell. The other place an id is minted here.
 *
 * It carries NO fill, deliberately: a cell created by a split, by a table-column
 * insertion or by any other structural action inherits the table's default
 * rather than cloning whatever explicit override happened to be next to it. An
 * override is something a user chose for one cell, not a property of the shape.
 */
export function makeCell(type, span = 1) {
  return {
    id: newId(),
    type: normalizeType(type),
    options: [],
    span: Math.max(1, Math.floor(Number(span) || 1)),
    fill: null,
  };
}

/* ------------------------------------------------------------------------ */
/* A row's cells on the grid                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The VALUE CELLS of one row, mapped onto a grid of `columnCount` columns.
 *
 * Returns `[{ id, span, start, type, options }]` where `start` is the cell's
 * first grid column (derived, never stored) and the spans always total
 * `columnCount` exactly — so every row covers the value area once, whatever a
 * stored row happens to contain.
 *
 * Repair is deterministic and invents nothing: spans below 1 are clamped, a row
 * whose cells overrun the grid is truncated with its last cell clamped, and a
 * row whose cells fall short has its LAST cell extended to reach the edge. No id
 * is minted, no cell is fabricated, and the stored row is never rewritten.
 *
 * A stored cell's `widthPct` — the shape the superseded per-row width model
 * used — is deliberately IGNORED rather than honoured: widths belong to the
 * table's grid, and reading a per-row width here would resurrect the very
 * architecture this model replaces.
 */
export function rowCells(row, columnCount = 1) {
  const r = row || {};
  const rowId = r.id;
  const total = Math.max(1, Math.min(MAX_VALUE_COLUMNS, Math.floor(Number(columnCount) || 1)));
  const stored = Array.isArray(r.cells) && r.cells.length ? r.cells : null;

  // A row with no `cells` key has never been divided AND has never been given a
  // fill of its own — a fill is stored on the cell, so a row carrying one is by
  // definition no longer the trivial shape (see `withCells`). Its single cell
  // therefore inherits the table's default, which is what `null` means.
  const wholeRow = () => [
    {
      id: rowId,
      span: total,
      start: 0,
      type: normalizeType(r.type),
      options: normalizeOptions(r.options),
      fill: null,
    },
  ];

  if (!stored) return wholeRow();

  const out = [];
  let start = 0;
  for (let index = 0; index < stored.length && start < total; index += 1) {
    const cell = stored[index] || {};
    const raw = Math.floor(Number(cell.span));
    const span = Math.max(1, Math.min(total - start, Number.isFinite(raw) ? raw : 1));
    out.push({
      id: cell.id || (index === 0 ? rowId : `${rowId}::cell-${index}`),
      span,
      start,
      type: normalizeType(cell.type),
      options: normalizeOptions(cell.options),
      // This cell's FILL OVERRIDE, or `null` for "inherit the table default".
      // Never repaired into an arbitrary colour: an unreadable override simply
      // is not one (src/lib/templateFill.js).
      fill: normalizeFill(cell.fill),
    });
    start += span;
  }

  if (out.length === 0) return wholeRow();
  // Short of the edge: the last cell reaches it. Nothing is fabricated.
  if (start < total) out[out.length - 1].span += total - start;
  return out;
}

/** The cell of `cells` that covers grid column `index`. Never null. */
export function cellAtColumn(cells, index) {
  const list = Array.isArray(cells) ? cells : [];
  for (const cell of list) {
    if (index >= cell.start && index < cell.start + cell.span) return cell;
  }
  return list[list.length - 1] || null;
}

/**
 * Attach a cell list to a row for STORAGE.
 *
 * A row that is back to the TRIVIAL shape — one cell, keyed by the row's own id,
 * spanning the whole grid — carries NO `cells` key at all, because that is
 * precisely what its absence already means. So a row that was never divided
 * stores nothing however wide the grid becomes, and a row that gained and then
 * lost a division publishes the same bytes as one that was never touched — which
 * is what keeps the unchanged-definition no-op in `publishTemplateVersion`
 * working for every existing template.
 *
 * Only what a cell genuinely needs is written: id, span, and the type/options it
 * actually carries. A width is never written onto a cell.
 */
function withCells(row, cells, columnCount) {
  // A cell carrying a FILL is not the trivial shape, whatever its span: the
  // override has to be stored somewhere, and "no `cells` key" already means
  // "one cell spanning everything, with no override". Clearing the fill again
  // returns the row to the trivial shape and drops the key — which is what
  // makes "Use default" the exact inverse of setting a fill.
  const trivial =
    cells.length === 1 &&
    cells[0].id === row.id &&
    cells[0].span >= columnCount &&
    !normalizeFill(cells[0].fill);
  if (trivial) {
    const next = { ...row, type: cells[0].type, options: cells[0].options };
    delete next.cells;
    return next;
  }
  return {
    ...row,
    cells: cells.map((cell) => {
      const out = {
        id: cell.id,
        span: cell.span,
        type: cell.type,
        options: cell.options,
      };
      // Written ONLY when the cell genuinely has one, so a divided row that has
      // never been recoloured publishes exactly the keys it always did.
      const fill = storedFill(cell.fill);
      if (fill) out.fill = fill;
      return out;
    }),
  };
}

/* ------------------------------------------------------------------------ */
/* TABLE-WIDE actions — the grid, and every row with it                      */
/* ------------------------------------------------------------------------ */

/** May the table's grid gain another column? */
export function canInsertTableColumn(columns) {
  return valueColumns(columns).length < MAX_VALUE_COLUMNS;
}

/**
 * May a column be REMOVED from the table's grid?
 *
 * False at one column, and that is the structural protection: a table with no
 * value column is not a narrower table, it is an unusable one — nothing could be
 * filled in, and every note's data keyed to those cells would have nowhere to
 * render. There is deliberately no override.
 */
export function canDeleteTableColumn(columns) {
  return valueColumns(columns).length > 1;
}

/**
 * Insert a REAL vertical column into the table's grid at grid index `at`, and
 * bring every row onto the new grid.
 *
 * Returns `{ columns, rows }`; the inputs are never mutated. The table is
 * returned unchanged when it is already at `MAX_VALUE_COLUMNS`, so a menu that
 * should not have offered the action cannot corrupt the table by being invoked
 * anyway.
 *
 * EVERY ROW IS ADJUSTED BY ONE RULE, the same one an HTML table obeys:
 *
 *   - a cell the new column falls STRICTLY INSIDE simply grows by one span, so a
 *     row deliberately left undivided stays undivided and still spans the whole
 *     value area;
 *   - a cell BOUNDARY at the insertion point gains a new, empty cell — which is
 *     what makes "Insert table column right" on a `| Label | Value |` table give
 *     every row a real second cell, aligned vertically through the table.
 *
 * Widths: the newcomer takes an equal share (100/(n+1)) and the incumbents are
 * scaled by n/(n+1) — a PROPORTIONAL shrink, so a 70/30 table becomes
 * 46.67/20/33.33 and not something arbitrary. Deterministic: the same table and
 * the same index always produce the same widths.
 */
export function insertTableColumn(columns, rows, at, newType) {
  const grid = valueColumns(columns);
  if (grid.length >= MAX_VALUE_COLUMNS) return { columns: grid, rows: rows || [] };

  const n = grid.length;
  const index = Math.max(0, Math.min(n, Math.floor(Number(at) || 0)));
  const share = 100 / (n + 1);
  const scaled = grid.map((c) => ({ ...c, widthPct: (c.widthPct * n) / (n + 1) }));
  const nextColumns = scaled.slice();
  nextColumns.splice(index, 0, makeColumn(share));
  const widths = normalizeColumnWidths(
    nextColumns.map((c) => c.widthPct),
    nextColumns.length
  );
  const finalColumns = nextColumns.map((c, i) => ({ ...c, widthPct: widths[i] }));

  const nextRows = (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || !row.id) return row;
    const cells = rowCells(row, n);
    const out = [];
    let inserted = false;
    for (const cell of cells) {
      const end = cell.start + cell.span;
      if (!inserted && index > cell.start && index < end) {
        // Strictly inside this cell: it simply covers the new column too.
        out.push({ ...cell, span: cell.span + 1 });
        inserted = true;
        continue;
      }
      if (!inserted && index === cell.start) {
        out.push(makeCell(newType, 1));
        inserted = true;
      }
      out.push({ ...cell });
    }
    if (!inserted) out.push(makeCell(newType, 1)); // the far right edge
    return withCells(row, recount(out), finalColumns.length);
  });

  return { columns: finalColumns, rows: nextRows };
}

/**
 * Remove one REAL column from the table's grid, and bring every row onto the
 * smaller grid.
 *
 * Returns `{ columns, rows, orphanedCellIds }`. A cell that SPANNED the removed
 * column simply shrinks and keeps everything; a cell that WAS the removed column
 * in that row disappears, and its id is reported in `orphanedCellIds` so the
 * caller can tell the user what will stop being shown before it happens.
 *
 * Nothing in storage is destroyed here: this returns a template definition, and
 * a note's answers, Section document, attachments and evidence keyed by an
 * orphaned cell id stay exactly where they are on that note's own instance. They
 * simply stop being rendered, which is what removing a column means.
 */
export function deleteTableColumn(columns, rows, columnId) {
  const grid = valueColumns(columns);
  const list = Array.isArray(rows) ? rows : [];
  if (grid.length <= 1) return { columns: grid, rows: list, orphanedCellIds: [] };
  const index = grid.findIndex((c) => c.id === columnId);
  if (index === -1) return { columns: grid, rows: list, orphanedCellIds: [] };

  const remaining = grid.filter((_, i) => i !== index);
  const widths = normalizeColumnWidths(
    remaining.map((c) => c.widthPct),
    remaining.length
  );
  const finalColumns = remaining.map((c, i) => ({ ...c, widthPct: widths[i] }));

  const orphanedCellIds = [];
  const nextRows = list.map((row) => {
    if (!row || !row.id) return row;
    const cells = rowCells(row, grid.length);
    const out = [];
    for (const cell of cells) {
      const covers = index >= cell.start && index < cell.start + cell.span;
      if (!covers) {
        out.push({ ...cell });
        continue;
      }
      if (cell.span > 1) {
        out.push({ ...cell, span: cell.span - 1 });
        continue;
      }
      orphanedCellIds.push(cell.id);
    }
    // `out` can never be empty: the grid had at least two columns (guarded
    // above), so a row's spans total at least two — removing one span-1 cell
    // always leaves another cell behind, and a lone cell spanning the whole grid
    // shrinks rather than disappearing.
    return withCells(row, recount(out), finalColumns.length);
  });

  return { columns: finalColumns, rows: nextRows, orphanedCellIds };
}

/**
 * Move the divider between grid column `dividerIndex` and the one after it, so
 * that the columns BEFORE the divider occupy `leftShare` percent of the value
 * area in total.
 *
 * Only the two columns either side of the divider change — every other column
 * keeps its exact width, which is what makes dragging one divider a local,
 * predictable edit rather than a rebalance of the whole table. Because the grid
 * is table-wide, the change applies to every row at once and no row's cells move.
 *
 * `leftShare` is a RATIO OF THE VALUE AREA, which is what the drag site measures
 * (a pointer position as a fraction of the row's own live rect). A ratio of two
 * visual lengths is scale-invariant, so document zoom cannot skew it — there is
 * no pixel constant in this calculation to be multiplied by the zoom factor.
 */
export function resizeColumnsAt(columns, dividerIndex, leftShare) {
  const grid = valueColumns(columns);
  const widths = grid.map((c) => c.widthPct);
  const i = Math.floor(Number(dividerIndex));
  if (!(i >= 0) || i >= widths.length - 1) return widths;

  const before = widths.slice(0, i).reduce((sum, v) => sum + v, 0);
  const pair = widths[i] + widths[i + 1];
  const requested = Number(leftShare);
  const target = Number.isFinite(requested) ? requested - before : widths[i];

  const left = Math.max(
    MIN_COLUMN_WIDTH_PCT,
    Math.min(pair - MIN_COLUMN_WIDTH_PCT, target)
  );
  const next = widths.slice();
  next[i] = left;
  next[i + 1] = pair - left;
  return enforceMinimum(next);
}

/** Apply a resized width list back onto the grid, for storage. */
export function withColumnWidths(columns, widths) {
  const grid = valueColumns(columns);
  const next = normalizeColumnWidths(widths, grid.length);
  return grid.map((c, i) => ({ ...c, widthPct: next[i] }));
}

/* ------------------------------------------------------------------------ */
/* ROW-LOCAL actions — splitting and un-splitting one row's cell             */
/* ------------------------------------------------------------------------ */

/** Recompute `start` after any structural change. Derived, never stored. */
function recount(cells) {
  let start = 0;
  return cells.map((cell) => {
    const next = { ...cell, start };
    start += cell.span;
    return next;
  });
}

/**
 * May this cell be split?
 *
 * Always, EXCEPT when it already occupies a single grid column and the grid is
 * at `MAX_VALUE_COLUMNS` — there would be no column to divide it into.
 */
export function canSplitCell(columns, cell) {
  if (!cell) return false;
  if (cell.span >= 2) return true;
  return valueColumns(columns).length < MAX_VALUE_COLUMNS;
}

/**
 * Divide ONE row's cell into two adjacent cells.
 *
 * Returns `{ columns, rows }`; the inputs are never mutated, and the table is
 * returned unchanged when the cell cannot be split.
 *
 * TWO CASES, ONE MODEL — and in both of them the original cell KEEPS ITS ID, so
 * everything a note has already put in it stays exactly where it was, and the
 * new sibling gets a fresh stable id of its own:
 *
 *   the cell already spans SEVERAL grid columns
 *       purely row-local. The cell's span is divided between it and its new
 *       sibling (the original keeps the larger half, so repeated splitting
 *       degrades predictably), and NOTHING else in the table changes: not the
 *       grid, not its widths, not one other row.
 *
 *   the cell spans exactly ONE grid column
 *       that column is divided in two: the grid gains a column, its width is
 *       halved between the two, and EVERY OTHER ROW'S covering cell absorbs the
 *       newcomer — so no other row's structure changes either. This is what lets
 *       a `| Label | Value |` template gain `| Date | Date | Time |` on one row
 *       without dividing every other row.
 */
export function splitCell(columns, rows, rowId, cellId, newType) {
  const grid = valueColumns(columns);
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find((r) => r && r.id === rowId);
  if (!row) return { columns: grid, rows: list };
  const cells = rowCells(row, grid.length);
  const cell = cells.find((c) => c.id === cellId);
  if (!cell || !canSplitCell(grid, cell)) return { columns: grid, rows: list };

  /* ---- row-local: the cell already covers more than one grid column ---- */
  if (cell.span >= 2) {
    const left = Math.ceil(cell.span / 2);
    const out = [];
    for (const c of cells) {
      if (c.id !== cell.id) {
        out.push({ ...c });
        continue;
      }
      out.push({ ...c, span: left });
      out.push(makeCell(newType, c.span - left));
    }
    const nextRows = list.map((r) =>
      r && r.id === rowId ? withCells(r, recount(out), grid.length) : r
    );
    return { columns: grid, rows: nextRows };
  }

  /* ---- the grid itself divides: one column becomes two ---- */
  const column = cell.start;
  const half = grid[column].widthPct / 2;
  const nextColumns = grid.map((c, i) => (i === column ? { ...c, widthPct: half } : c));
  nextColumns.splice(column + 1, 0, makeColumn(half));
  const widths = normalizeColumnWidths(
    nextColumns.map((c) => c.widthPct),
    nextColumns.length
  );
  const finalColumns = nextColumns.map((c, i) => ({ ...c, widthPct: widths[i] }));

  const nextRows = list.map((r) => {
    if (!r || !r.id) return r;
    const rCells = rowCells(r, grid.length);
    if (r.id === rowId) {
      const out = [];
      for (const c of rCells) {
        if (c.id !== cell.id) {
          out.push({ ...c });
          continue;
        }
        out.push({ ...c, span: 1 });
        out.push(makeCell(newType, 1));
      }
      return withCells(r, recount(out), finalColumns.length);
    }
    // Every OTHER row absorbs the new column into whichever cell already covers
    // the column being divided, so its structure is untouched.
    const covering = cellAtColumn(rCells, column);
    const out = rCells.map((c) =>
      covering && c.id === covering.id ? { ...c, span: c.span + 1 } : { ...c }
    );
    return withCells(r, recount(out), finalColumns.length);
  });

  return { columns: finalColumns, rows: nextRows };
}

/** May this cell be merged with its neighbour on `side`? */
export function canMergeCell(cells, cellId, side) {
  const list = Array.isArray(cells) ? cells : [];
  const index = list.findIndex((c) => c.id === cellId);
  if (index === -1) return false;
  return normalizeColumnSide(side) === COLUMN_SIDE.LEFT ? index > 0 : index < list.length - 1;
}

/**
 * Merge one cell with its neighbour — the operation that cleanly REVERSES a
 * split.
 *
 * Returns `{ rows, orphanedCellIds }`. The grid is untouched: merging changes
 * only which cells of this one row cover which columns, so no other row and no
 * column width moves.
 *
 * THE LEFT CELL SURVIVES, whichever side the action was invoked from. That is
 * what makes a merge the exact inverse of a split: splitting keeps the original
 * cell on the left, so merging back onto the left restores the original cell id
 * — and with it every answer, Section document, attachment and piece of evidence
 * a note keyed to it. The right cell's id is reported in `orphanedCellIds`;
 * nothing of its content is destroyed here, it simply stops being rendered.
 */
export function mergeCell(columns, rows, rowId, cellId, side) {
  const grid = valueColumns(columns);
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find((r) => r && r.id === rowId);
  if (!row) return { rows: list, orphanedCellIds: [] };

  const cells = rowCells(row, grid.length);
  if (!canMergeCell(cells, cellId, side)) return { rows: list, orphanedCellIds: [] };

  const index = cells.findIndex((c) => c.id === cellId);
  const leftIndex =
    normalizeColumnSide(side) === COLUMN_SIDE.LEFT ? index - 1 : index;
  const survivor = cells[leftIndex];
  const absorbed = cells[leftIndex + 1];

  const out = [];
  for (let i = 0; i < cells.length; i += 1) {
    if (i === leftIndex) {
      out.push({ ...survivor, span: survivor.span + absorbed.span });
      continue;
    }
    if (i === leftIndex + 1) continue;
    out.push({ ...cells[i] });
  }

  const nextRows = list.map((r) =>
    r && r.id === rowId ? withCells(r, recount(out), grid.length) : r
  );
  return { rows: nextRows, orphanedCellIds: [absorbed.id] };
}

/* ------------------------------------------------------------------------ */
/* FILLS — the individual cell / label override on the shared grid            */
/* ------------------------------------------------------------------------ */
//
// A fill override is stored on the SURFACE it paints and nowhere else:
//
//     row.labelFill      this row's LABEL cell
//     cell.fill          this VALUE cell
//
// Both are optional, both are `null` when absent, and `null` means "inherit the
// table's default" (src/lib/templateFill.js). Setting one changes exactly one
// surface; clearing one removes the key entirely, so the row returns to the
// bytes it had before it was ever recoloured.
//
// The FILL FOLLOWS THE CELL ID, which is what makes the A2 structural actions
// behave sensibly without a single line of fill-specific code in them: a split
// cell keeps its id and therefore its override, its new sibling is a `makeCell`
// with none, a merge keeps the surviving left cell's, and inserting or deleting
// a table column only ever changes a cell's SPAN.

/** This row's LABEL cell override, or `null` for "inherit the table default". */
export function rowLabelFill(row) {
  return normalizeFill(row && row.labelFill);
}

/**
 * Set (or clear, with `null`) ONE value cell's fill override.
 *
 * Returns the rows unchanged when the row or the cell does not exist, so a
 * stale selection can never corrupt the table. Only the addressed cell is
 * touched: every other cell of that row and every cell of every other row is
 * returned byte-identical, which is the whole point of the model.
 */
export function setCellFill(columns, rows, rowId, cellId, fill) {
  const grid = valueColumns(columns);
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find((r) => r && r.id === rowId);
  if (!row) return list;
  const cells = rowCells(row, grid.length);
  if (!cells.some((c) => c.id === cellId)) return list;
  const next = cells.map((c) =>
    c.id === cellId ? { ...c, fill: normalizeFill(fill) } : c
  );
  return list.map((r) => (r && r.id === rowId ? withCells(r, next, grid.length) : r));
}

/**
 * Set (or clear, with `null`) ONE row's LABEL cell fill override.
 *
 * The label column is a single template-wide track, so a label override is a
 * property of the ROW rather than of a grid cell — but it obeys the identical
 * rule: absent means inherit, and clearing removes the key.
 */
export function setRowLabelFill(rows, rowId, fill) {
  const list = Array.isArray(rows) ? rows : [];
  const stored = storedFill(fill);
  return list.map((r) => {
    if (!r || r.id !== rowId) return r;
    if (!stored) {
      if (r.labelFill === undefined) return r;
      const next = { ...r };
      delete next.labelFill;
      return next;
    }
    return { ...r, labelFill: stored };
  });
}

/* ------------------------------------------------------------------------ */
/* FIELD CONTROLS — giving ONE cell a typed control, and taking it back      */
/* ------------------------------------------------------------------------ */
//
// A cell's `type` is where it has always lived — on the row for an undivided
// row, on `row.cells[i]` for a divided one — so this writes through exactly the
// same `withCells` storage rule as every other cell change. An undivided cell
// therefore publishes `row.type` and no `cells` key at all, which is the shape
// every template published before columns existed already has.
//
// NOTHING A NOTE HAS STORED IS TOUCHED. This returns a template DEFINITION; a
// note's `answers`, `sectionDoc`, `attachments` and `evidence` stay on its own
// instance, keyed by the same unchanged cell id. What changes is how a note
// pinned to the NEW version renders that cell — which is why the Builder
// confirms first whenever a note has genuinely filled it in.

/**
 * Give ONE cell a typed field control, or take it back to a flexible Section.
 *
 * `type` is one of `FIELD_CONTROL_TYPES` to add a control, or the flexible
 * default to remove one. The rows are returned unchanged when the row, the cell
 * or the transition does not exist — so a stale menu can never corrupt a table.
 *
 * A Dropdown is created with ONE empty option so its editor opens ready to be
 * typed into; an empty option is dropped at publish time, so a Dropdown left
 * unconfigured publishes exactly no options rather than a blank one.
 *
 * Options are NEVER discarded when a control is removed: a cell that was a
 * Dropdown keeps its dormant option list (the long-standing `normalizeRow`
 * policy), so making it a Dropdown again restores exactly the options it had.
 */
export function setCellFieldControl(columns, rows, rowId, cellId, type) {
  const grid = valueColumns(columns);
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find((r) => r && r.id === rowId);
  if (!row) return list;
  const cells = rowCells(row, grid.length);
  const target = cells.find((c) => c.id === cellId);
  if (!target) return list;

  const next = normalizeType(type);
  const adding = isFieldControlType(next);
  if (adding ? !canAddFieldControl(target.type) : next !== DEFAULT_BUILDER_FIELD_TYPE) {
    return list;
  }
  if (!adding && !canRemoveFieldControl(target.type)) return list;

  const updated = cells.map((c) => {
    if (c.id !== cellId) return c;
    if (!adding) return { ...c, type: DEFAULT_BUILDER_FIELD_TYPE };
    const options =
      next === FIELD_TYPE_SELECT && c.options.length === 0 ? [makeOption("")] : c.options;
    return { ...c, type: next, options };
  });
  return list.map((r) => (r && r.id === rowId ? withCells(r, updated, grid.length) : r));
}

// Local literal rather than an import of FIELD_TYPE, so this module keeps its
// one narrow dependency on the field model (the four helpers above) and does
// not grow a second idea of what a type is. Locked equal by test.
const FIELD_TYPE_SELECT = "select";

/* ------------------------------------------------------------------------ */
/* Layout                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * The CSS grid track list for a row: the label column, then one track per GRID
 * column — identical for every row, which is exactly what makes a column run
 * vertically through the table.
 *
 * Value tracks are `fr` units proportional to their percentage, so they divide
 * whatever the value area actually is at any page size or zoom level; a
 * percentage track would be a share of the WHOLE row and would have to be
 * re-derived against `leftPct` at every call site. `minmax(0, …)` is what stops
 * a long unbroken word forcing a track wider than its share. A cell occupies the
 * combined width of the columns it spans simply by spanning their tracks.
 */
export function columnTemplate(labelWidth, columns) {
  const grid = valueColumns(columns);
  const tracks = grid
    .map((c) => `minmax(0, ${Number(c.widthPct) || 100}fr)`)
    .join(" ");
  return `${labelWidth} ${tracks}`;
}

/** The `grid-column` value for one cell. */
export function cellGridSpan(cell) {
  return `span ${Math.max(1, Math.floor(Number(cell && cell.span) || 1))}`;
}
