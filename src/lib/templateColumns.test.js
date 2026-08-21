// src/lib/templateColumns.test.js
//
// THE TEMPLATE TABLE GRID (Template Editor A2). Pure — no React, no DOM, no
// storage. What a real table column does to every row, what splitting a cell
// does to one row, and what neither of them may ever do to an existing template.

import {
  COLUMN_SIDE,
  MAX_VALUE_COLUMNS,
  MIN_COLUMN_WIDTH_PCT,
  canDeleteTableColumn,
  canInsertTableColumn,
  canMergeCell,
  canSplitCell,
  cellAtColumn,
  cellGridSpan,
  columnTemplate,
  deleteTableColumn,
  insertTableColumn,
  makeCell,
  mergeCell,
  normalizeColumnWidths,
  resizeColumnsAt,
  rowCells,
  splitCell,
  storedValueColumns,
  valueColumnCount,
  valueColumns,
  withColumnWidths,
} from "./templateColumns";
import { FIELD_TYPE } from "./templateFields";

/* ------------------------------ fixtures -------------------------------- */

const legacyRows = () => [
  { id: "r1", label: "Project", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
  { id: "r2", label: "Date", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
  { id: "r3", label: "Notes", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
];

const sum = (list) => list.reduce((a, b) => a + b, 0);
const widthsOf = (columns) => valueColumns(columns).map((c) => c.widthPct);
const shapeOf = (columns, rows) =>
  rows.map((r) => rowCells(r, valueColumns(columns).length).map((c) => c.span));
const idsOf = (columns, row) =>
  rowCells(row, valueColumns(columns).length).map((c) => c.id);
const rowOf = (rows, id) => rows.find((r) => r.id === id);

/* ============ 1. a legacy two-column template is unchanged ============== */

describe("1. an existing template is a one-column grid with full-width cells", () => {
  test("an absent grid reads as ONE column at 100%", () => {
    expect(valueColumns(null)).toEqual([{ id: "col-0", widthPct: 100 }]);
    expect(valueColumnCount(undefined)).toBe(1);
    for (const bad of ["nope", 7, {}, []]) {
      expect(valueColumns(bad)).toHaveLength(1);
    }
  });

  test("a row with no `cells` is ONE cell spanning the grid, keyed by the row id", () => {
    const [cell] = rowCells(legacyRows()[0], 1);
    expect(cell).toMatchObject({ id: "r1", span: 1, start: 0, type: FIELD_TYPE.TEXT });
    // …and it still spans everything when the grid is wider.
    expect(rowCells(legacyRows()[0], 3)).toEqual([
      expect.objectContaining({ id: "r1", span: 3, start: 0 }),
    ]);
  });

  test("the default cell carries the ROW's own field type and options", () => {
    const row = { id: "r1", type: FIELD_TYPE.SELECT, options: [{ id: "o1", value: "Yes" }] };
    expect(rowCells(row, 2)[0]).toMatchObject({
      type: FIELD_TYPE.SELECT,
      options: [{ id: "o1", value: "Yes" }],
    });
  });

  test("reading NEVER writes and never adds a key", () => {
    const row = legacyRows()[0];
    const before = JSON.stringify(row);
    rowCells(row, 3);
    expect(JSON.stringify(row)).toBe(before);
    expect("cells" in row).toBe(false);
    // The default grid is stored as NOTHING, so an untouched template publishes
    // exactly the bytes it always did.
    expect(storedValueColumns(null)).toBeNull();
    expect(storedValueColumns(valueColumns(null))).toBeNull();
  });
});

/* ============ 2-4. TABLE-WIDE column insertion ========================= */

describe("2-4. inserting a real table column affects every row", () => {
  test("2/3. insert right, then left, gives EVERY row a real new cell", () => {
    const right = insertTableColumn(null, legacyRows(), 1, FIELD_TYPE.TEXT);
    expect(right.columns).toHaveLength(2);
    expect(shapeOf(right.columns, right.rows)).toEqual([[1, 1], [1, 1], [1, 1]]);

    const left = insertTableColumn(null, legacyRows(), 0, FIELD_TYPE.TEXT);
    expect(left.columns).toHaveLength(2);
    expect(shapeOf(left.columns, left.rows)).toEqual([[1, 1], [1, 1], [1, 1]]);
    // Inserting on the LEFT puts the new (empty) cell first and the row's own
    // content — which keeps the row id — second.
    expect(idsOf(left.columns, left.rows[0])[1]).toBe("r1");
    expect(idsOf(right.columns, right.rows[0])[0]).toBe("r1");
  });

  test("4. columns ALIGN: every row's cell boundaries land on the same grid", () => {
    // A table where one row is split and the others are not.
    const two = insertTableColumn(null, legacyRows(), 1);
    const split = splitCell(two.columns, two.rows, "r2", idsOf(two.columns, two.rows[1])[1]);
    expect(split.columns).toHaveLength(3);
    // Row 2 is divided into three; the others still cover the same three
    // columns with two cells, so every boundary is a real grid boundary.
    expect(shapeOf(split.columns, split.rows)).toEqual([[1, 2], [1, 1, 1], [1, 2]]);
    for (const row of split.rows) {
      const cells = rowCells(row, split.columns.length);
      expect(sum(cells.map((c) => c.span))).toBe(split.columns.length);
      expect(cells[0].start).toBe(0);
    }
  });

  test("a cell the new column falls INSIDE simply grows — the row stays undivided", () => {
    const two = insertTableColumn(null, legacyRows(), 1);
    // r1 is undivided (one cell spanning 2). Insert a column in the middle.
    const three = insertTableColumn(two.columns, two.rows, 1);
    expect(three.columns).toHaveLength(3);
    // Every row was `[1,1]`; the boundary at index 1 is a real boundary in each,
    // so each gains a cell.
    expect(shapeOf(three.columns, three.rows)).toEqual([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);

    // Now a genuinely undivided row: split r2 only, so r1 spans everything.
    const split = splitCell(two.columns, two.rows, "r2", idsOf(two.columns, two.rows[1])[0]);
    const merged = mergeCell(split.columns, split.rows, "r1", "r1", COLUMN_SIDE.RIGHT);
    const wide = rowOf(merged.rows, "r1");
    expect(rowCells(wide, split.columns.length).map((c) => c.span)).toEqual([3]);
    const more = insertTableColumn(split.columns, merged.rows, 1);
    // r1's single cell simply covers the new column too: still ONE cell.
    expect(rowCells(rowOf(more.rows, "r1"), 4).map((c) => c.span)).toEqual([4]);
  });

  test("existing cell ids, field types and dropdown options all survive", () => {
    const rows = [
      { id: "r1", type: FIELD_TYPE.SELECT, options: [{ id: "o1", value: "Yes" }] },
    ];
    const two = insertTableColumn(null, rows, 1, FIELD_TYPE.DATE);
    const cells = rowCells(two.rows[0], 2);
    expect(cells[0]).toMatchObject({
      id: "r1",
      type: FIELD_TYPE.SELECT,
      options: [{ id: "o1", value: "Yes" }],
    });
    expect(cells[1].type).toBe(FIELD_TYPE.DATE);
    expect(cells[1].id).not.toBe("r1");
    // The input row is never mutated.
    expect("cells" in rows[0]).toBe(false);
  });

  test("the column cap is enforced and the table is returned unchanged at it", () => {
    expect(MAX_VALUE_COLUMNS).toBe(4);
    let state = { columns: valueColumns(null), rows: legacyRows() };
    for (let i = 0; i < 10; i += 1) {
      state = insertTableColumn(state.columns, state.rows, state.columns.length);
    }
    expect(state.columns).toHaveLength(MAX_VALUE_COLUMNS);
    expect(canInsertTableColumn(state.columns)).toBe(false);
    const same = insertTableColumn(state.columns, state.rows, 1);
    expect(same.rows).toBe(state.rows);
  });
});

/* ============ 5-6. widths belong to the table ========================== */

describe("5-6. the grid owns the widths", () => {
  test("5. widths always sum to exactly 100", () => {
    let state = { columns: valueColumns(null), rows: legacyRows() };
    expect(sum(widthsOf(state.columns))).toBe(100);
    for (let i = 0; i < MAX_VALUE_COLUMNS - 1; i += 1) {
      state = insertTableColumn(state.columns, state.rows, state.columns.length);
      expect(sum(widthsOf(state.columns))).toBe(100);
    }
    const gone = deleteTableColumn(state.columns, state.rows, state.columns[1].id);
    expect(sum(widthsOf(gone.columns))).toBe(100);
  });

  test("insertion redistributes DETERMINISTICALLY and proportionally", () => {
    const two = insertTableColumn(null, legacyRows(), 1);
    const wide = withColumnWidths(two.columns, [70, 30]);
    const three = insertTableColumn(wide, two.rows, 2);
    // 70 and 30 shrink by 2/3; the newcomer takes an equal third.
    expect(widthsOf(three.columns)).toEqual([46.67, 20, 33.33]);
    expect(widthsOf(insertTableColumn(wide, two.rows, 2).columns)).toEqual(
      widthsOf(three.columns)
    );
  });

  test("no width is ever negative, NaN, zero or below the minimum", () => {
    const bad = normalizeColumnWidths([-40, 0, NaN, "x"], 4);
    expect(bad).toHaveLength(4);
    expect(sum(bad)).toBe(100);
    for (const w of bad) expect(w).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH_PCT);
    expect(normalizeColumnWidths([-1], 1)).toEqual([100]);
    // …including from a hand-edited stored grid.
    const stored = [{ id: "a", widthPct: -5 }, { id: "b", widthPct: 900 }, { id: "c" }];
    expect(sum(widthsOf(stored))).toBe(100);
    for (const w of widthsOf(stored)) {
      expect(w).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH_PCT);
    }
  });

  test("6. a resize moves the SHARED grid — every row realigns, none owns a width", () => {
    let state = insertTableColumn(null, legacyRows(), 1);
    state = insertTableColumn(state.columns, state.rows, 2);
    const columns = withColumnWidths(state.columns, [50, 25, 25]);
    const resized = resizeColumnsAt(columns, 0, 30);
    expect(resized).toEqual([30, 45, 25]); // only the pair either side moved
    expect(sum(resized)).toBe(100);
    // The rows are untouched by a resize — they carry spans, never widths.
    const applied = withColumnWidths(columns, resized);
    expect(shapeOf(applied, state.rows)).toEqual(shapeOf(columns, state.rows));
    for (const row of state.rows) {
      for (const cell of rowCells(row, 3)) {
        expect(cell.widthPct).toBeUndefined();
      }
    }
  });

  test("a resize clamps at the minimum on BOTH sides of the divider", () => {
    const columns = withColumnWidths(insertTableColumn(null, legacyRows(), 1).columns, [50, 50]);
    expect(resizeColumnsAt(columns, 0, -300)[0]).toBe(MIN_COLUMN_WIDTH_PCT);
    expect(resizeColumnsAt(columns, 0, 300)[1]).toBe(MIN_COLUMN_WIDTH_PCT);
    for (const target of [-300, 0, 5, 50, 95, 300]) {
      const out = resizeColumnsAt(columns, 0, target);
      expect(sum(out)).toBe(100);
      for (const w of out) expect(w).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH_PCT);
    }
  });

  test("23. a resize is a RATIO, so 75/100/125/150% zoom gives identical widths", () => {
    const columns = withColumnWidths(insertTableColumn(null, legacyRows(), 1).columns, [50, 50]);
    for (const zoom of [0.75, 1, 1.25, 1.5]) {
      const valueLeft = 100 * zoom;
      const valueWidth = 400 * zoom;
      const pointer = valueLeft + 0.3 * valueWidth;
      const share = ((pointer - valueLeft) / valueWidth) * 100;
      expect(resizeColumnsAt(columns, 0, share)).toEqual([30, 70]);
    }
  });

  test("a divider index outside the grid renormalizes and changes nothing", () => {
    const columns = withColumnWidths(insertTableColumn(null, legacyRows(), 1).columns, [60, 40]);
    expect(resizeColumnsAt(columns, 5, 10)).toEqual([60, 40]);
    expect(resizeColumnsAt(columns, -1, 10)).toEqual([60, 40]);
  });
});

/* ============ 7-9. ROW-LOCAL splitting ================================= */

describe("7-9. splitting one cell", () => {
  test("7/8. splitting a one-column cell divides the GRID and leaves other rows undivided", () => {
    // The product example: | Project | name | / | Date | Date | Time | / | Notes | … |
    const split = splitCell(null, legacyRows(), "r2", "r2");
    expect(split.columns).toHaveLength(2);
    expect(shapeOf(split.columns, split.rows)).toEqual([[2], [1, 1], [2]]);
    // The neighbouring rows still store NOTHING — one cell spanning everything
    // is exactly what an absent `cells` key means.
    expect("cells" in rowOf(split.rows, "r1")).toBe(false);
    expect("cells" in rowOf(split.rows, "r3")).toBe(false);
    expect(Array.isArray(rowOf(split.rows, "r2").cells)).toBe(true);
    // The divided column's width is halved between the two.
    expect(widthsOf(split.columns)).toEqual([50, 50]);
  });

  test("splitting a MULTI-column cell is purely row-local — the grid never moves", () => {
    const three = insertTableColumn(
      insertTableColumn(null, legacyRows(), 1).columns,
      insertTableColumn(null, legacyRows(), 1).rows,
      2
    );
    const merged = mergeCell(three.columns, three.rows, "r1", idsOf(three.columns, three.rows[0])[0], COLUMN_SIDE.RIGHT);
    const wide = rowOf(merged.rows, "r1");
    expect(rowCells(wide, 3).map((c) => c.span)).toEqual([2, 1]);

    const before = widthsOf(three.columns);
    const split = splitCell(three.columns, merged.rows, "r1", "r1");
    expect(split.columns).toHaveLength(3); // grid untouched
    expect(widthsOf(split.columns)).toEqual(before);
    expect(rowCells(rowOf(split.rows, "r1"), 3).map((c) => c.span)).toEqual([1, 1, 1]);
    // …and no other row changed at all.
    expect(rowOf(split.rows, "r2")).toBe(rowOf(merged.rows, "r2"));
  });

  test("9. repeated splitting keeps the spans total and stops at the cap", () => {
    let state = { columns: valueColumns(null), rows: legacyRows() };
    for (let i = 0; i < 6; i += 1) {
      const cells = rowCells(rowOf(state.rows, "r2"), state.columns.length);
      state = splitCell(state.columns, state.rows, "r2", cells[cells.length - 1].id);
      const spans = rowCells(rowOf(state.rows, "r2"), state.columns.length).map((c) => c.span);
      expect(sum(spans)).toBe(state.columns.length);
    }
    expect(state.columns).toHaveLength(MAX_VALUE_COLUMNS);
    // At the cap a one-column cell can no longer be split.
    const cells = rowCells(rowOf(state.rows, "r2"), state.columns.length);
    expect(canSplitCell(state.columns, cells[0])).toBe(false);
    expect(splitCell(state.columns, state.rows, "r2", cells[0].id).rows).toBe(state.rows);
  });

  test("a cell spanning several columns can always be split, cap or not", () => {
    let state = { columns: valueColumns(null), rows: legacyRows() };
    for (let i = 0; i < 3; i += 1) {
      state = insertTableColumn(state.columns, state.rows, state.columns.length);
    }
    const wide = rowCells(rowOf(state.rows, "r1"), 4);
    // Merge r1 back to one wide cell, then split it at the cap.
    let merged = state.rows;
    for (let i = wide.length - 1; i > 0; i -= 1) {
      merged = mergeCell(state.columns, merged, "r1", rowCells(rowOf(merged, "r1"), 4)[0].id, COLUMN_SIDE.RIGHT).rows;
    }
    const one = rowCells(rowOf(merged, "r1"), 4);
    expect(one.map((c) => c.span)).toEqual([4]);
    expect(canSplitCell(state.columns, one[0])).toBe(true);
    const split = splitCell(state.columns, merged, "r1", one[0].id);
    expect(rowCells(rowOf(split.rows, "r1"), 4).map((c) => c.span)).toEqual([2, 2]);
  });
});

/* ============ 10-12. ids, content and reversal ========================= */

describe("10-12. stable ids, content and merging back", () => {
  test("10/11. a split cell KEEPS its id; the new sibling gets a fresh one", () => {
    const split = splitCell(null, legacyRows(), "r2", "r2");
    const cells = rowCells(rowOf(split.rows, "r2"), 2);
    expect(cells[0].id).toBe("r2"); // the row's original content key
    expect(cells[1].id).toEqual(expect.any(String));
    expect(cells[1].id).not.toBe("r2");
    // Stable across reads.
    expect(rowCells(rowOf(split.rows, "r2"), 2).map((c) => c.id)).toEqual(
      cells.map((c) => c.id)
    );
    // Unique across the whole table.
    const all = split.rows.flatMap((r) => rowCells(r, 2).map((c) => c.id));
    expect(new Set(all).size).toBe(all.length);
  });

  test("12. merge REVERSES a split exactly — the original cell id is restored", () => {
    const rows = legacyRows();
    const split = splitCell(null, rows, "r2", "r2");
    const [left, right] = rowCells(rowOf(split.rows, "r2"), 2);
    const back = mergeCell(split.columns, split.rows, "r2", right.id, COLUMN_SIDE.LEFT);
    const cells = rowCells(rowOf(back.rows, "r2"), 2);
    expect(cells).toHaveLength(1);
    expect(cells[0].id).toBe(left.id); // === "r2"
    expect(cells[0].span).toBe(2);
    // Back to the trivial shape, so the row stores no `cells` key at all.
    expect("cells" in rowOf(back.rows, "r2")).toBe(false);
    // The cell that went away is REPORTED, never silently dropped.
    expect(back.orphanedCellIds).toEqual([right.id]);
  });

  test("merging from either side keeps the LEFT cell, so content never moves", () => {
    const split = splitCell(null, legacyRows(), "r2", "r2");
    const [left, right] = rowCells(rowOf(split.rows, "r2"), 2);
    const fromLeft = mergeCell(split.columns, split.rows, "r2", left.id, COLUMN_SIDE.RIGHT);
    const fromRight = mergeCell(split.columns, split.rows, "r2", right.id, COLUMN_SIDE.LEFT);
    expect(fromLeft.orphanedCellIds).toEqual([right.id]);
    expect(fromRight.orphanedCellIds).toEqual([right.id]);
    expect(rowCells(rowOf(fromLeft.rows, "r2"), 2)[0].id).toBe(left.id);
    expect(rowCells(rowOf(fromRight.rows, "r2"), 2)[0].id).toBe(left.id);
  });

  test("an end cell offers no merge on the side it has no neighbour", () => {
    const split = splitCell(null, legacyRows(), "r2", "r2");
    const cells = rowCells(rowOf(split.rows, "r2"), 2);
    expect(canMergeCell(cells, cells[0].id, COLUMN_SIDE.LEFT)).toBe(false);
    expect(canMergeCell(cells, cells[0].id, COLUMN_SIDE.RIGHT)).toBe(true);
    expect(canMergeCell(cells, cells[1].id, COLUMN_SIDE.LEFT)).toBe(true);
    expect(canMergeCell(cells, cells[1].id, COLUMN_SIDE.RIGHT)).toBe(false);
    expect(canMergeCell(cells, "nope", COLUMN_SIDE.LEFT)).toBe(false);
    // …and an impossible merge is a no-op that reports nothing lost.
    const noop = mergeCell(split.columns, split.rows, "r2", cells[0].id, COLUMN_SIDE.LEFT);
    expect(noop.rows).toBe(split.rows);
    expect(noop.orphanedCellIds).toEqual([]);
  });
});

/* ============ 13-14. deleting a table column safely ==================== */

describe("13-14. deleting a real table column", () => {
  test("13. the column goes from the grid AND from every row", () => {
    const three = insertTableColumn(
      insertTableColumn(null, legacyRows(), 1).columns,
      insertTableColumn(null, legacyRows(), 1).rows,
      2
    );
    const widths = withColumnWidths(three.columns, [50, 20, 30]);
    const gone = deleteTableColumn(widths, three.rows, widths[1].id);
    expect(gone.columns).toHaveLength(2);
    expect(shapeOf(gone.columns, gone.rows)).toEqual([[1, 1], [1, 1], [1, 1]]);
    // 50:30 keeps its ratio across the whole area.
    expect(widthsOf(gone.columns)).toEqual([62.5, 37.5]);
  });

  test("14. a cell that SPANNED the column shrinks and keeps everything", () => {
    const split = splitCell(null, legacyRows(), "r2", "r2"); // grid = 2
    // Insert INSIDE r1/r3's full-width cell — which is also a real boundary in
    // the divided r2 — so the undivided rows keep one cell and only r2 gains one.
    const three = insertTableColumn(split.columns, split.rows, 1);
    expect(shapeOf(three.columns, three.rows)).toEqual([[3], [1, 1, 1], [3]]);
    const gone = deleteTableColumn(three.columns, three.rows, three.columns[0].id);
    // r1/r3's single cell simply shrinks: nothing orphaned from them.
    expect(rowCells(rowOf(gone.rows, "r1"), 2).map((c) => c.span)).toEqual([2]);
    expect("cells" in rowOf(gone.rows, "r1")).toBe(false);
    // r2's first cell WAS that column, so it is reported.
    expect(gone.orphanedCellIds).toEqual(["r2"]);
  });

  test("the table's LAST column can never be deleted", () => {
    expect(canDeleteTableColumn(null)).toBe(false);
    const rows = legacyRows();
    const noop = deleteTableColumn(null, rows, "col-0");
    expect(noop.columns).toHaveLength(1);
    expect(noop.rows).toBe(rows);
    expect(noop.orphanedCellIds).toEqual([]);
  });

  test("an unknown column id is a no-op", () => {
    const two = insertTableColumn(null, legacyRows(), 1);
    const noop = deleteTableColumn(two.columns, two.rows, "not-a-column");
    expect(noop.rows).toBe(two.rows);
    expect(noop.orphanedCellIds).toEqual([]);
  });
});

/* ============ 25. the superseded per-row width model cannot return ====== */

describe("25. a row can never own a width again", () => {
  test("a stored per-row `widthPct` is IGNORED, not honoured", () => {
    // The shape the superseded A2 draft used. Reading it must not resurrect it.
    const row = {
      id: "r1",
      type: FIELD_TYPE.TEXT,
      cells: [
        { id: "r1", widthPct: 70 },
        { id: "c2", widthPct: 30 },
      ],
    };
    const cells = rowCells(row, 3);
    for (const cell of cells) expect(cell.widthPct).toBeUndefined();
    // A cell with no span reads as one column, and the last one reaches the
    // grid's edge — so the row still covers the value area exactly once.
    expect(cells.map((c) => c.span)).toEqual([1, 2]);
    expect(sum(cells.map((c) => c.span))).toBe(3);
  });

  test("nothing this module returns for storage ever carries a cell width", () => {
    const split = splitCell(null, legacyRows(), "r2", "r2");
    for (const row of split.rows) {
      for (const cell of row.cells || []) {
        expect("widthPct" in cell).toBe(false);
        expect(typeof cell.span).toBe("number");
      }
    }
    // Widths exist in exactly one place: the grid.
    for (const column of split.columns) {
      expect(typeof column.widthPct).toBe("number");
    }
  });

  test("a row whose stored spans overrun the grid is truncated, not trusted", () => {
    const row = {
      id: "r1",
      cells: [
        { id: "r1", span: 5 },
        { id: "c2", span: 5 },
      ],
    };
    const cells = rowCells(row, 2);
    expect(cells.map((c) => c.span)).toEqual([2]);
    expect(cells[0].id).toBe("r1");
  });
});

/* ============ layout + small helpers =================================== */

describe("the layout the grid produces", () => {
  test("every row gets the SAME track list — that is what makes a column vertical", () => {
    expect(columnTemplate("18%", null)).toBe("18% minmax(0, 100fr)");
    const two = withColumnWidths(insertTableColumn(null, legacyRows(), 1).columns, [60, 40]);
    expect(columnTemplate("18%", two)).toBe("18% minmax(0, 60fr) minmax(0, 40fr)");
  });

  test("a cell occupies the columns it spans, and holds no width of its own", () => {
    expect(cellGridSpan({ span: 1 })).toBe("span 1");
    expect(cellGridSpan({ span: 3 })).toBe("span 3");
    expect(cellGridSpan(null)).toBe("span 1");
    expect(cellGridSpan({ span: "x" })).toBe("span 1");
  });

  test("`cellAtColumn` finds the cell covering any grid index", () => {
    const cells = rowCells({ id: "r", cells: [{ id: "a", span: 1 }, { id: "b", span: 2 }] }, 3);
    expect(cellAtColumn(cells, 0).id).toBe("a");
    expect(cellAtColumn(cells, 1).id).toBe("b");
    expect(cellAtColumn(cells, 2).id).toBe("b");
  });

  test("`makeCell` is a minting site and normalizes what it is given", () => {
    const cell = makeCell("nonsense", 2);
    expect(cell).toMatchObject({ type: FIELD_TYPE.TEXT, span: 2 });
    expect(cell.id).toEqual(expect.any(String));
    expect(makeCell(FIELD_TYPE.TIME).span).toBe(1);
  });

  test("`storedValueColumns` writes the grid only when it is not the default", () => {
    expect(storedValueColumns(null)).toBeNull();
    const two = insertTableColumn(null, legacyRows(), 1).columns;
    const stored = storedValueColumns(two);
    expect(stored).toHaveLength(2);
    for (const column of stored) {
      expect(Object.keys(column).sort()).toEqual(["id", "widthPct"]);
    }
  });
});
