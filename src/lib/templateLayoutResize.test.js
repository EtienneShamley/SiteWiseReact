// src/lib/templateLayoutResize.test.js
//
// B1/A2 LAYOUT CORRECTION (2026-08-24): Builder walls derive from CELL SPANS,
// and deliberate manual resizing returns to the filled note — note-owned.
//
// Two defects from manual testing, both fixed at the model:
//
//   GHOST DIVIDER   the Builder drew one drag-wall per UNDERLYING GRID
//                   BOUNDARY on EVERY row (`grid.slice(0, -1)`), a second
//                   visual model of the table that drifted from the structure
//                   the moment a merge changed a row's cells without touching
//                   the grid (which is `mergeCell`'s documented contract —
//                   other rows may still expose the boundary). The note
//                   rendered correctly only because it has no drag walls at
//                   all. Walls now derive from the row's own cell boundaries —
//                   the same rule the painted border follows — so they cannot
//                   drift again.
//
//   DEAD/LOST RESIZE  A2 demoted `row.px` to count only with `pxExplicit`,
//                   but the note's drag wrote `px` WITHOUT the marker (and its
//                   commit returned early for master rows) — so dragging a
//                   template row in a filled note moved nothing and saved
//                   nothing. Deliberate note resizing now persists to
//                   `instance.rowHeights`, a NOTE-INSTANCE override that never
//                   touches the pinned TemplateVersion; the Builder's own drag
//                   additionally returns a row to AUTO when dragged back to
//                   its content floor.
//
// Pure-model tests run against the real functions; wiring facts are asserted
// on the source (docs/TESTING.md — no DOM testing library, jsdom has no
// layout). Appearance and drag feel stay on the manual checklist.

import fs from "fs";
import path from "path";
import {
  MIN_COLUMN_WIDTH_PCT,
  mergeCell,
  normalizeColumnWidths,
  resizeColumnsAt,
  rowCells,
  splitCell,
  valueColumns,
  COLUMN_SIDE,
} from "./templateColumns";
import {
  COMPACT_ROW_MIN_PX,
  CONTROL_ROW_MIN_PX,
  ATTACHMENT_HEAD_MIN_PX,
  explicitRowHeightPatch,
  rowDragMinPx,
  rowHeightDragPatch,
  rowMinHeightPx,
} from "./templateRowHeight";
import {
  NOTE_ROW_HEIGHT_MAX_PX,
  applyNoteRowHeights,
  noteRowHeightFor,
  normalizeNoteRowHeight,
  removeNoteRowHeight,
  setNoteRowHeight,
} from "./noteRowHeights";
import {
  NOTE_WIDTH_MATCH_TOLERANCE_PCT,
  normalizeNoteLayoutOverrides,
  noteColumnWidths,
  noteLeftPct,
  setNoteColumnWidths,
  setNoteLeftPct,
} from "./noteLayoutOverrides";
import { FIELD_TYPE, normalizeRow } from "./templateFields";
import { buildTemplateExportModel } from "./templateExportModel";

const SRC = path.join(__dirname, "..");
const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
const TABLE = read("components/template/ResizableTwoColTable.js");
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const BUILDER = read("components/template/TemplateBuilderDoc.js");
const EXPORT_MODEL = read("lib/templateExportModel.js");
const HEIGHTS_LIB = read("lib/noteRowHeights.js");

/* ---- shared fixtures ---- */

const gridOf = (widths) =>
  valueColumns(widths.map((w, i) => ({ id: `col-${i}`, widthPct: w })));

const textRow = (id, extra = {}) => ({ id, label: id, type: FIELD_TYPE.TEXT, ...extra });

/** The grid-divider indexes a row's walls sit on — the exact rule the renderer
 *  uses (`cell.start + cell.span - 1` for every cell but the last). */
function exposedBoundaries(row, grid) {
  const cells = rowCells(row, grid.length);
  return cells.slice(0, -1).map((c) => c.start + c.span - 1);
}

/* ====================================================================== */
/* 1-6. BUILDER STRUCTURE — walls from cell spans                         */
/* ====================================================================== */

describe("1-6. Builder walls derive from the row's own cell boundaries", () => {
  test("1. splitting a cell exposes the new boundary on THAT row immediately", () => {
    const grid = gridOf([100]);
    const rows = [textRow("r1"), textRow("r2")];
    const split = splitCell(grid, rows, "r1", "r1", FIELD_TYPE.TEXT);
    expect(split.columns).toHaveLength(2);
    expect(exposedBoundaries(split.rows[0], split.columns)).toEqual([0]);
  });

  test("2. merging removes that row's boundary immediately — even though the grid keeps its column", () => {
    const grid = gridOf([100]);
    const rows = [textRow("r1"), textRow("r2")];
    const split = splitCell(grid, rows, "r1", "r1", FIELD_TYPE.TEXT);
    const cells = rowCells(split.rows[0], split.columns.length);
    const merged = mergeCell(split.columns, split.rows, "r1", cells[1].id, COLUMN_SIDE.LEFT);
    // The grid deliberately keeps both columns (other rows may expose them)…
    expect(split.columns).toHaveLength(2);
    // …but the merged row exposes NO boundary, so it draws NO wall.
    expect(exposedBoundaries(merged.rows[0], split.columns)).toEqual([]);
  });

  test("3. a spanning cell hides the underlying grid boundaries it crosses", () => {
    const grid = gridOf([25, 25, 50]);
    const spanning = { ...textRow("rA"), cells: [{ id: "rA", span: 3 }] };
    expect(exposedBoundaries(spanning, grid)).toEqual([]);
    const partial = {
      ...textRow("rB"),
      cells: [
        { id: "rB", span: 1 },
        { id: "rB-2", span: 2 },
      ],
    };
    // One wall, at the exposed cell boundary — not at every grid boundary.
    expect(exposedBoundaries(partial, grid)).toEqual([0]);
  });

  test("4. a neighbouring divided row keeps its own boundary while the merged row shows none", () => {
    const grid = gridOf([100]);
    const rows = [textRow("r1"), textRow("r2")];
    const bothSplit = splitCell(
      ...(() => {
        const a = splitCell(grid, rows, "r1", "r1", FIELD_TYPE.TEXT);
        return [a.columns, a.rows, "r2", "r2", FIELD_TYPE.TEXT];
      })()
    );
    const r1Cells = rowCells(bothSplit.rows[0], bothSplit.columns.length);
    const merged = mergeCell(
      bothSplit.columns,
      bothSplit.rows,
      "r1",
      r1Cells[1].id,
      COLUMN_SIDE.LEFT
    );
    expect(exposedBoundaries(merged.rows[0], bothSplit.columns)).toEqual([]);
    expect(exposedBoundaries(merged.rows[1], bothSplit.columns)).not.toEqual([]);
  });

  test("5. the renderer states exactly this rule, and the drag still moves the SHARED grid divider", () => {
    const dividers = TABLE.slice(
      TABLE.indexOf("function renderCellDividers("),
      TABLE.indexOf("function renderFieldError(")
    );
    expect(dividers).toContain("function renderCellDividers(cells)");
    expect(dividers).toContain("const boundary = cell.start + cell.span - 1;");
    expect(dividers).toContain("onMouseDown={(e) => startCellDrag(boundary, e)}");
    expect(dividers).toContain("nudgeCellWidth(boundary, -1);");
    // Both render sites hand the row's own cells in.
    expect(TABLE).toContain("{renderCellDividers(cells)}");
    expect(TABLE).not.toContain("{renderCellDividers()}");
    // The drag itself is unchanged: shared grid, normalized widths, one commit.
    expect(TABLE).toContain("resizeColumnsAt(grid, cellDrag.dividerIndex, share)");
    expect(TABLE).toContain("onColumnWidthsCommit(lastColumnWidths.current)");
  });

  test("6. no second visual divider model exists — walls and borders read the same cells", () => {
    // The raw-grid iteration is gone from the renderer entirely.
    const dividers = TABLE.slice(
      TABLE.indexOf("function renderCellDividers("),
      TABLE.indexOf("function renderFieldError(")
    );
    expect(dividers).not.toContain("grid.slice(0, -1)");
    // The painted boundary is the adjacent-cell border, driven by the same
    // rendered cells — no stored divider list anywhere.
    const css = fs.readFileSync(
      path.join(SRC, "components/template/template.css"),
      "utf8"
    );
    expect(css).toContain(".twocol-cell-col + .twocol-cell-col {");
    expect(TABLE).not.toMatch(/dividerState|setDividers|dividerList/);
  });
});

/* ====================================================================== */
/* 7-11. BUILDER RESIZE                                                   */
/* ====================================================================== */

describe("7-11. Builder resize — explicit template minimum, auto at the floor", () => {
  test("7. a drag above the floor stamps an explicit Template minimum", () => {
    expect(rowHeightDragPatch(200, COMPACT_ROW_MIN_PX)).toEqual({
      px: 200,
      pxExplicit: true,
    });
    expect(BUILDER).toContain("rowHeightDragPatch(px, floor)");
    expect(BUILDER).toContain(
      "const floor = rowDragMinPx({ row: r, cells: rowCells(r, valueColumns.length) });"
    );
  });

  test("8. dragged back to the content floor, the row returns to AUTO — no stored deliberate height", () => {
    expect(rowHeightDragPatch(COMPACT_ROW_MIN_PX, COMPACT_ROW_MIN_PX)).toEqual({
      px: COMPACT_ROW_MIN_PX,
      pxExplicit: false,
    });
    expect(rowHeightDragPatch(10, COMPACT_ROW_MIN_PX).pxExplicit).toBe(false);
    // A control row's floor is its own, taller one.
    expect(rowHeightDragPatch(CONTROL_ROW_MIN_PX, CONTROL_ROW_MIN_PX).pxExplicit).toBe(false);
    expect(rowHeightDragPatch(CONTROL_ROW_MIN_PX + 1, CONTROL_ROW_MIN_PX).pxExplicit).toBe(
      true
    );
    // Without the marker the stored px reserves nothing.
    expect(
      rowMinHeightPx({ row: { type: FIELD_TYPE.TEXT, px: COMPACT_ROW_MIN_PX, pxExplicit: false } })
    ).toBe(COMPACT_ROW_MIN_PX);
  });

  test("9-10. the vertical drag changes the SHARED grid and stays normalized above the minimum", () => {
    const grid = gridOf([50, 50]);
    const widths = resizeColumnsAt(grid, 0, 30);
    expect(widths.reduce((s, w) => s + w, 0)).toBeCloseTo(100, 5);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH_PCT);
    // A drag past the minimum clamps rather than producing an unusable column.
    const clamped = resizeColumnsAt(grid, 0, 1);
    expect(Math.min(...clamped)).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH_PCT);
    expect(normalizeColumnWidths(clamped, 2).reduce((s, w) => s + w, 0)).toBeCloseTo(100, 5);
  });

  test("11. an explicit height survives publish and reopen", () => {
    // Publish writes the marker only when it is genuinely set…
    expect(BUILDER).toContain("if (r.pxExplicit === true) base.pxExplicit = true;");
    // …and read-time normalization carries it back without inventing it.
    expect(normalizeRow({ id: "r", px: 200, pxExplicit: true }, 0).pxExplicit).toBe(true);
    expect(normalizeRow({ id: "r", px: 200 }, 0).pxExplicit).toBeUndefined();
  });
});

/* ====================================================================== */
/* 12-21. NOTE INSTANCE — per-note height overrides                       */
/* ====================================================================== */

describe("12-21. Filled-note resize is a NOTE-INSTANCE override", () => {
  test("12. the note still exposes the row resize boundary, live through pendingHeights", () => {
    // One handler for every row — the master-row branch that silently wrote an
    // unmarked px into the version copy is gone.
    expect(NOTE_DOC).toContain(
      "const handleRowHeightChange = useCallback((rowId, px) => {\n    setPendingHeights((prev) => ({ ...prev, [rowId]: px }));\n  }, []);"
    );
    // The pending value carries the explicit marker, or the drag would be dead
    // under A2's px demotion.
    expect(NOTE_DOC).toContain("{ ...r, px: pendingHeights[r.id], pxExplicit: true }");
  });

  test("13. a note can make a row taller — the override renders through the shared floor rule", () => {
    const rows = [textRow("r1", { px: 120 })];
    const map = setNoteRowHeight({}, "r1", 300, COMPACT_ROW_MIN_PX);
    const [overridden] = applyNoteRowHeights(rows, map);
    expect(overridden).toEqual({ ...rows[0], px: 300, pxExplicit: true });
    expect(rowMinHeightPx({ row: overridden })).toBe(300);
  });

  test("14. dragged back to its default, the entry is REMOVED — auto, no residue", () => {
    const map = setNoteRowHeight({}, "r1", 300, COMPACT_ROW_MIN_PX);
    expect(setNoteRowHeight(map, "r1", COMPACT_ROW_MIN_PX, COMPACT_ROW_MIN_PX)).toEqual({});
    // Landing back on a template-explicit default removes it too.
    expect(setNoteRowHeight(map, "r1", 120, 120)).toEqual({});
    // …and a no-op removal returns the same reference.
    const empty = {};
    expect(setNoteRowHeight(empty, "r1", COMPACT_ROW_MIN_PX, COMPACT_ROW_MIN_PX)).toBe(empty);
  });

  test("15-17. content remains the hard floor — prose, controls, attachment heads", () => {
    // The live drag clamps at the content floor…
    expect(TABLE).toContain("const floor = rowDragMinPx({ row, cells, isAttachmentField });");
    expect(TABLE).toContain("const px = Math.max(rowDrag.minPx, (rowDrag.startH ?? 120) + dy);");
    // …and even a stored override below a floor cannot clip, because the
    // override is only ever a MINIMUM fed into max(content floor, minimum).
    const dateRow = { id: "d", type: FIELD_TYPE.DATE, px: 40, pxExplicit: true };
    expect(rowMinHeightPx({ row: dateRow })).toBe(CONTROL_ROW_MIN_PX);
    expect(rowMinHeightPx({ row: { px: 30, pxExplicit: true }, isAttachmentField: true })).toBe(
      ATTACHMENT_HEAD_MIN_PX
    );
    // The DOM applies it as min-height on a real box, so prose/images/files
    // grow the row past it rather than being clipped by it.
    expect(TABLE).toContain("minHeight: `${effectiveMin}px`,");
    expect(TABLE).not.toMatch(/style=\{\{[^}]*[^n]height: `\$\{effectiveMin\}px`/);
  });

  test("18. content growth overrides a smaller manual minimum", () => {
    // A 40px override on a Date row renders at the 48px control floor — the
    // larger of the two always wins, with no second rule anywhere.
    const [row] = applyNoteRowHeights(
      [{ id: "d", type: FIELD_TYPE.DATE }],
      { d: 40 }
    );
    expect(rowMinHeightPx({ row })).toBe(CONTROL_ROW_MIN_PX);
  });

  test("19. the override persists on the instance through the confirmed save", () => {
    expect(NOTE_DOC).toContain("rowHeights: nextMap,");
    expect(NOTE_DOC).toContain("saveInstanceConfirmed(nextInstance);");
    // Loaded back the same way sectionExtraHeight is: from the instance.
    expect(NOTE_DOC).toContain("const raw = instance?.rowHeights;");
    expect(NOTE_DOC).toContain("applyNoteRowHeights(orderedRows, storedRowHeights)");
  });

  test("20. no reverse write from note → Template exists", () => {
    // The note component can read versions but imports no writer for them.
    expect(NOTE_DOC).not.toMatch(/publishTemplateVersion|saveTemplate\b|saveVersion/);
    // The heights module itself touches no storage and no template record.
    expect(HEIGHTS_LIB).not.toMatch(/localStorage|templateModel|publish|version/i);
    // The master-row commit writes ONE key on the instance and nothing else.
    const commit = NOTE_DOC.slice(
      NOTE_DOC.indexOf("const handleRowHeightCommit"),
      NOTE_DOC.indexOf("const handleRowLabelChange")
    );
    expect(commit).toContain("setNoteRowHeight(");
    expect(commit).not.toMatch(/setRows\(/);
  });

  test("21. a second note does not inherit the first note's override", () => {
    // The store is a map on ONE note's instance; another note's instance simply
    // has no entry, so the overlay returns its rows by reference.
    const rows = [textRow("r1", { px: 120 })];
    expect(applyNoteRowHeights(rows, {})).toEqual(rows);
    expect(applyNoteRowHeights(rows, null)[0]).toBe(rows[0]);
    expect(noteRowHeightFor({ r1: 300 }, "r2")).toBe(0);
  });

  test("the map itself is defensive: caps, junk, and same-reference no-ops", () => {
    expect(normalizeNoteRowHeight(NOTE_ROW_HEIGHT_MAX_PX + 500)).toBe(NOTE_ROW_HEIGHT_MAX_PX);
    expect(normalizeNoteRowHeight("junk")).toBe(0);
    expect(normalizeNoteRowHeight(-5)).toBe(0);
    const map = { r1: 300 };
    expect(setNoteRowHeight(map, "", 200, 36)).toBe(map);
    expect(setNoteRowHeight(map, "r1", 300, 36)).toBe(map);
    expect(removeNoteRowHeight(map, "r2")).toBe(map);
    expect(removeNoteRowHeight(map, "r1")).toEqual({});
    // New instances seed the key empty, like sectionExtraHeight.
    expect(read("lib/templateModel.js")).toContain("rowHeights: {},");
  });
});

/* ====================================================================== */
/* 22-27. NOTE COLUMN WIDTHS — a note-instance presentation override      */
/* ====================================================================== */

describe("22-27. note width overrides — one grid, note-owned, template untouched", () => {
  const versionGrid = () => gridOf([50, 50]);

  test("22a. the note wires BOTH vertical dividers, live + commit-once", () => {
    const usage = NOTE_DOC.slice(NOTE_DOC.indexOf("<ResizableTwoColTable"));
    expect(usage).toContain("enableColumnDivider={true}");
    expect(usage).toContain("onLeftPctChange={handleLeftPctChange}");
    expect(usage).toContain("onLeftPctCommit={handleLeftPctCommit}");
    expect(usage).toContain("onColumnWidthsChange={handleColumnWidthsChange}");
    expect(usage).toContain("onColumnWidthsCommit={handleColumnWidthsCommit}");
    // Live drags land in pending state; ONE instance write happens on release.
    expect(NOTE_DOC).toContain("setPendingLeftPct(pct);");
    expect(NOTE_DOC).toContain("setPendingColumnWidths(widths);");
    expect(NOTE_DOC).toContain("persistLayoutOverrides(nextOverrides);");
  });

  test("22b. the label divider itself commits once per drag, and on each keyboard nudge", () => {
    expect(TABLE).toContain("onLeftPctCommit(lastLeftPctValue.current);");
    expect(TABLE).toContain("lastLeftPctValue.current = next;");
    expect(TABLE).toContain("if (onLeftPctCommit) onLeftPctCommit(next);");
  });

  test("22c. a note override changes only THIS note's numbers — the version values are the base", () => {
    const stored = setNoteLeftPct({}, 30, 20);
    expect(stored).toEqual({ leftPct: 30 });
    expect(noteLeftPct(stored, 20)).toBe(30);
    // No override → the template's own share, by reference semantics.
    expect(noteLeftPct({}, 20)).toBe(20);
    expect(noteLeftPct(normalizeNoteLayoutOverrides(null), 20)).toBe(20);
  });

  test("23. widths stay ONE shared grid — the override rides the version's columns, never a row's", () => {
    const grid = versionGrid();
    const stored = setNoteColumnWidths({}, grid, [30, 70]);
    const overridden = noteColumnWidths(grid, stored);
    expect(overridden.map((c) => c.id)).toEqual(grid.map((c) => c.id));
    expect(overridden.map((c) => c.widthPct)).toEqual([30, 70]);
    // A spanning row reads the SAME grid: spans are untouched by widths, so a
    // merged cell keeps spanning the resulting note-level columns and exposes
    // no wall (the span-aware rule from §1-6 applies unchanged).
    const spanning = { ...textRow("rA"), cells: [{ id: "rA", span: 2 }] };
    expect(exposedBoundaries(spanning, overridden)).toEqual([]);
    // There is no per-row width anywhere in the module.
    expect(read("lib/noteLayoutOverrides.js")).not.toMatch(/rowId|perRow/);
  });

  test("24. the override is normalized to 100% through the ONE shared width algorithm", () => {
    const grid = versionGrid();
    const stored = setNoteColumnWidths({}, grid, [1, 3]);
    const widths = noteColumnWidths(grid, stored).map((c) => c.widthPct);
    expect(widths.reduce((s, w) => s + w, 0)).toBeCloseTo(100, 5);
    expect(read("lib/noteLayoutOverrides.js")).toContain("normalizeColumnWidths");
  });

  test("25. minimum widths hold — 12% per column, 10–40% label share", () => {
    const grid = versionGrid();
    const stored = setNoteColumnWidths({}, grid, [1, 99]);
    for (const c of noteColumnWidths(grid, stored)) {
      expect(c.widthPct).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH_PCT);
    }
    expect(setNoteLeftPct({}, 90, 20)).toEqual({ leftPct: 40 });
    expect(setNoteLeftPct({}, 1, 20)).toEqual({ leftPct: 10 });
  });

  test("26. the TemplateVersion is untouched — the note stores presentation numbers only", () => {
    const grid = versionGrid();
    const before = JSON.parse(JSON.stringify(grid));
    setNoteColumnWidths({}, grid, [30, 70]);
    noteColumnWidths(grid, { columnWidths: { "col-0": 30, "col-1": 70 } });
    expect(grid).toEqual(before);
    // The note component writes overrides through the instance save alone.
    expect(NOTE_DOC).toContain("layoutOverrides: nextOverrides,");
    expect(NOTE_DOC).not.toMatch(/publishTemplateVersion|saveTemplate\b|saveVersion/);
    // And the module itself knows nothing that could write anywhere.
    expect(read("lib/noteLayoutOverrides.js")).not.toMatch(/localStorage|templateModel/);
  });

  test("27. a second note is unaffected, and structure stays version-derived", () => {
    const grid = versionGrid();
    // Another note's instance simply has no entry: same reference back.
    expect(noteColumnWidths(grid, {})).toBe(grid);
    expect(noteColumnWidths(grid, normalizeNoteLayoutOverrides(undefined))).toBe(grid);
    // Only widthPct can differ on an overridden column — id and order are the
    // version's own.
    const overridden = noteColumnWidths(grid, { columnWidths: { "col-0": 30, "col-1": 70 } });
    overridden.forEach((c, i) => {
      expect(c.id).toBe(grid[i].id);
    });
  });

  test("grid identity: a stale or junk override falls back to the template defaults", () => {
    const grid = versionGrid();
    // Wrong ids (a re-pinned note's old grid), extra ids, missing ids, junk
    // values — every one reads as "no override", never a corrupted layout.
    for (const bad of [
      { columnWidths: { "other-0": 30, "other-1": 70 } },
      { columnWidths: { "col-0": 30, "col-1": 40, "col-2": 30 } },
      { columnWidths: { "col-0": 60 } },
      { columnWidths: { "col-0": "junk", "col-1": 70 } },
      { columnWidths: { "col-0": -5, "col-1": 105 } },
      { columnWidths: [30, 70] },
    ]) {
      expect(noteColumnWidths(grid, normalizeNoteLayoutOverrides(bad))).toBe(grid);
    }
    // A junk leftPct reads as the template's share.
    expect(noteLeftPct(normalizeNoteLayoutOverrides({ leftPct: "junk" }), 20)).toBe(20);
  });

  test("reset: landing back on the template default REMOVES the override", () => {
    // Label share: exact integer match (the drag rounds to integers).
    const withLeft = setNoteLeftPct({}, 30, 20);
    expect(setNoteLeftPct(withLeft, 20, 20)).toEqual({});
    // Column widths: within the small deterministic tolerance.
    const grid = versionGrid();
    const withWidths = setNoteColumnWidths({}, grid, [30, 70]);
    expect(setNoteColumnWidths(withWidths, grid, [50, 50])).toEqual({});
    expect(
      setNoteColumnWidths(withWidths, grid, [
        50 + NOTE_WIDTH_MATCH_TOLERANCE_PCT / 2,
        50 - NOTE_WIDTH_MATCH_TOLERANCE_PCT / 2,
      ])
    ).toEqual({});
    // Same-reference no-ops in every direction, so nothing can loop a render
    // or spam a save.
    const empty = {};
    expect(setNoteLeftPct(empty, 20, 20)).toEqual({});
    expect(setNoteColumnWidths(withWidths, grid, [30, 70])).toEqual(withWidths);
    // Removing one key keeps the other.
    const both = setNoteColumnWidths(withLeft, grid, [30, 70]);
    expect(setNoteColumnWidths(both, grid, [50, 50])).toEqual({ leftPct: 30 });
    // New instances seed the key empty, like rowHeights.
    expect(read("lib/templateModel.js")).toContain("layoutOverrides: {},");
  });

  test("export: the note's widths reach the canonical model (Preview / HTML / PDF / DOCX)", () => {
    const version = {
      id: "ver-1",
      createdAt: 1,
      leftPct: 20,
      valueColumns: [
        { id: "col-a", widthPct: 50 },
        { id: "col-b", widthPct: 50 },
      ],
      rows: [{ id: "f-text", label: "Observations", type: FIELD_TYPE.TEXT, px: 120 }],
    };
    const instance = {
      noteId: "note-1",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      answers: {},
      attachments: {},
      customRows: [],
      layoutOverrides: { leftPct: 30, columnWidths: { "col-a": 30, "col-b": 70 } },
    };
    const model = buildTemplateExportModel({
      noteId: "note-1",
      noteTitle: "Note",
      instance,
      template: { id: "tpl-1", name: "T" },
      version,
      assets: { logoDataUrl: null, photos: new Map(), files: new Map() },
    });
    expect(model.layout.leftPct).toBe(30);
    expect(model.layout.valueColumns).toEqual([
      { id: "col-a", widthPct: 30 },
      { id: "col-b", widthPct: 70 },
    ]);
    // A stale override exports the template defaults instead.
    const stale = buildTemplateExportModel({
      noteId: "note-1",
      noteTitle: "Note",
      instance: {
        ...instance,
        layoutOverrides: { columnWidths: { "old-a": 30, "old-b": 70 } },
      },
      template: { id: "tpl-1", name: "T" },
      version,
      assets: { logoDataUrl: null, photos: new Map(), files: new Map() },
    });
    expect(stale.layout.valueColumns.map((c) => c.widthPct)).toEqual([50, 50]);
    expect(stale.layout.leftPct).toBe(20);
    // Every flavour reads layout from this one model: the shared HTML builder
    // emits the <colgroup> (HTML + PDF + DOCX input); Markdown's structural
    // degradation is already documented.
    expect(read("lib/templateExportHtml.js")).toContain("model.layout.valueColumns");
    expect(read("lib/templateExportHtml.js")).toContain("${ctx.leftPct}%");
  });
});

/* ====================================================================== */
/* 28-30. SPLIT / MERGE                                                   */
/* ====================================================================== */

describe("28-30. split/merge visual + safety behaviour", () => {
  test("28. a merged Builder row exposes no wall (the ghost is structural, not cosmetic)", () => {
    const grid = gridOf([100]);
    const rows = [textRow("r1")];
    const split = splitCell(grid, rows, "r1", "r1", FIELD_TYPE.TEXT);
    const cells = rowCells(split.rows[0], split.columns.length);
    const merged = mergeCell(split.columns, split.rows, "r1", cells[1].id, COLUMN_SIDE.LEFT);
    expect(exposedBoundaries(merged.rows[0], split.columns)).toEqual([]);
    // The surviving cell keeps the ORIGINAL id, so everything keyed to it stays.
    expect(rowCells(merged.rows[0], split.columns.length)[0].id).toBe("r1");
  });

  test("29. a split note row displays the correct walls through the same cells", () => {
    // The note renders the same component with the same cells; it draws the
    // painted border at cell boundaries and (having no divider handles) can
    // draw no ghost wall at all.
    const grid = gridOf([50, 50]);
    const divided = {
      ...textRow("r1"),
      cells: [
        { id: "r1", span: 1 },
        { id: "r1-b", span: 1 },
      ],
    };
    expect(rowCells(divided, grid.length)).toHaveLength(2);
    expect(TABLE).toContain('multi ? "twocol-cell-col" : ""');
  });

  test("30. merge confirmation / content safety is untouched", () => {
    expect(BUILDER).toContain("mergeCell(valueColumns, rows, rowId, cellId, side ?? COLUMN_SIDE.LEFT)");
    expect(read("lib/templateColumns.js")).toContain("orphanedCellIds: [absorbed.id]");
  });
});

/* ====================================================================== */
/* 31-35. EXPORT                                                          */
/* ====================================================================== */

describe("31-35. a note's deliberate layout reaches ITS exports", () => {
  const makeVersion = () => ({
    id: "ver-1",
    createdAt: 1,
    leftPct: 20,
    rows: [
      { id: "f-text", label: "Observations", type: FIELD_TYPE.TEXT, px: 120 },
      { id: "f-date", label: "Visit date", type: FIELD_TYPE.DATE, px: 60 },
    ],
  });
  const makeInstance = (rowHeights) => ({
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: {},
    attachments: {},
    customRows: [],
    ...(rowHeights ? { rowHeights } : {}),
  });
  const build = (rowHeights) =>
    buildTemplateExportModel({
      noteId: "note-1",
      noteTitle: "Note",
      instance: makeInstance(rowHeights),
      template: { id: "tpl-1", name: "T" },
      version: makeVersion(),
      assets: { logoDataUrl: null, photos: new Map(), files: new Map() },
    });

  test("31-33. the override reaches the export model, so Preview / HTML / PDF follow", () => {
    const model = build({ "f-text": 300 });
    expect(model.rows.find((r) => r.id === "f-text").preferredHeightPx).toBe(300);
    // A row the note never resized keeps content-driven sizing — the stored
    // scaffold px reserves nothing.
    expect(model.rows.find((r) => r.id === "f-date").preferredHeightPx).toBe(
      CONTROL_ROW_MIN_PX
    );
    // Preview and the HTML/PDF flavours all render from this one model; the
    // minimum box is applied from preferredHeightPx in the shared HTML builder.
    expect(read("lib/templateExportHtml.js")).toContain("fragment.preferredHeightPx");
    expect(EXPORT_MODEL).toContain("applyNoteRowHeights(");
  });

  test("31b. an override below the content floor exports at the floor — never a clipped box", () => {
    const model = build({ "f-date": 30 });
    expect(model.rows.find((r) => r.id === "f-date").preferredHeightPx).toBe(
      CONTROL_ROW_MIN_PX
    );
  });

  test("34. DOCX behaviour is deterministic: fixed minimum boxes are deliberately not represented", () => {
    // html-to-docx has no fixed-height equivalent — documented degradation, the
    // same for a template default and a note override, so nothing can clip.
    expect(fs.readFileSync(path.join(SRC, "lib/templateExportHtml.js"), "utf8")).toContain(
      "WORD (docx) GETS NOTHING"
    );
  });

  test("35. a note with no overrides builds an identical model — and resize affordances never export", () => {
    expect(build(undefined).rows.find((r) => r.id === "f-text").preferredHeightPx).toBe(
      COMPACT_ROW_MIN_PX
    );
    // The handles are UI chrome, hidden in print with the other affordances,
    // and the export model renders no component at all.
    const css = fs.readFileSync(path.join(SRC, "components/template/template.css"), "utf8");
    const print = css.slice(css.indexOf("@media print {"));
    expect(print).toContain(".twocol-col-handle,");
    expect(print).toContain(".twocol-resize-handle,");
    expect(EXPORT_MODEL).not.toMatch(/twocol-col-handle|twocol-resize-handle/);
  });
});

/* ====================================================================== */
/* 36-42. ZOOM / B1 REGRESSION                                            */
/* ====================================================================== */

describe("36-42. zoom safety and B1 behaviour are unchanged", () => {
  test("36-39. the wall geometry is percentages of the row's own box — zoom-invariant", () => {
    const dividers = TABLE.slice(
      TABLE.indexOf("function renderCellDividers("),
      TABLE.indexOf("function renderFieldError(")
    );
    expect(dividers).toContain("style={{ left: `${left}%` }}");
    expect(dividers).not.toMatch(/getBoundingClientRect|offsetWidth|zoomScale/);
    // The drag reads a RATIO of the live rect, the documented zoom-safe rule.
    expect(TABLE).toContain("const share = ((e.clientX - valueLeft) / valueWidth) * 100;");
  });

  test("40-41. the B1 action rail and the unobstructed native controls stand", () => {
    const css = fs.readFileSync(path.join(SRC, "components/template/template.css"), "utf8");
    expect(css).toContain(".twocol-actions-rail {");
    expect(strip(css)).toMatch(/\.twocol-actions-rail--margin \{[^}]*left: 100%;/);
    expect(css).not.toMatch(/-webkit-calendar-picker-indicator/);
    expect(strip(css)).toMatch(
      /\.twocol-row:hover,\s*\n\.twocol-row:focus-within \{[^}]*var\(--nw-tpl-layer-row-raised\)/
    );
  });

  test("42. compact auto-height remains the default — only a deliberate height reserves space", () => {
    expect(rowMinHeightPx({ row: textRow("r", { px: 120 }) })).toBe(COMPACT_ROW_MIN_PX);
    expect(rowMinHeightPx({ row: textRow("r", { px: 120, pxExplicit: true }) })).toBe(120);
    // And the drag floor stays the content floor, so compact is always reachable.
    expect(rowDragMinPx({ row: textRow("r", { px: 120, pxExplicit: true }) })).toBe(
      COMPACT_ROW_MIN_PX
    );
  });

  test("explicitRowHeightPatch keeps its original contract for callers that need it", () => {
    expect(explicitRowHeightPatch(200)).toEqual({ px: 200, pxExplicit: true });
  });
});
