// src/lib/templateCellFill.test.js
//
// TEMPLATE EDITOR A3 — the STYLE OWNERSHIP MODEL end to end: who owns a fill,
// what inherits from what, what one edit is allowed to change, how the A2
// structural actions carry a fill, what every export flavour renders, and what
// an existing template and a pinned historical note still do.
//
// The real modules for everything executable (the fill model, the grid, the
// export model, all four export builders, the version store); source-text
// assertions only for the surfaces jsdom cannot lay out — see docs/TESTING.md.
//
// THE MODEL BEING ASSERTED
//
//     DOCUMENT   branding.page.background*        the paper
//         |
//     TABLE      branding.table.*Background*      the label / value defaults
//         |
//     ROW/CELL   row.labelFill, cell.fill         the individual override
//
// A cell is painted `own ?? default`, resolved at read time. Nothing copies a
// default into a cell, so changing a default moves every un-overridden surface
// and leaves every deliberate one exactly where the user put it.

import fs from "fs";
import path from "path";

import {
  COLUMN_SIDE,
  deleteTableColumn,
  insertTableColumn,
  mergeCell,
  rowCells,
  rowLabelFill,
  setCellFill,
  setRowLabelFill,
  splitCell,
  storedValueColumns,
  valueColumns,
  withColumnWidths,
} from "./templateColumns";
import { FIELD_TYPE, normalizeRow, normalizeRows } from "./templateFields";
import { compositeFill, fillCss, makeFill } from "./templateFill";
import {
  DEFAULT_BRANDING,
  brandingStyles,
  isDefaultPageFill,
  normalizeBranding,
  pageFill,
  pageSurfaceColor,
  tableContentFill,
  tableLabelFill,
} from "./templateBranding";
import { buildTemplateExportModel } from "./templateExportModel";
import {
  EXPORT_FLAVOR,
  buildTemplateExportBody,
  buildTemplateExportDocument,
} from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import { createTemplate, publishTemplateVersion, getVersion } from "./templateModel";

const SRC = path.join(__dirname, "..");
const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
const rawRead = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const TABLE = read("components/template/ResizableTwoColTable.js");
const BUILDER = read("components/template/TemplateBuilderDoc.js");
const RIBBON = read("components/template/TemplateEditorRibbon.js");
const PANEL = read("components/template/BrandingPanel.js");
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const TEMPLATE_CSS = rawRead("components/template/template.css");
const PAGED_CSS = rawRead("components/template/pagedDocument.css");

/* ------------------------------ fixtures -------------------------------- */

const TEMPLATE = { id: "tpl-1", name: "Site Inspection" };

const PALE_BLUE = { color: "#dbeafe", opacity: 100 };
const CREAM = "#fdf6e3";

const baseRows = () => [
  { id: "r-a", label: "Project", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
  { id: "r-b", label: "Date", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
  { id: "r-c", label: "Notes", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
];

function makeVersion({ rows, columns = null, branding = null }) {
  return {
    id: "ver-1",
    templateId: "tpl-1",
    createdAt: 1700000000000,
    leftPct: 20,
    valueColumns: storedValueColumns(columns),
    branding,
    rows,
  };
}

function build({ rows, columns = null, branding = null }) {
  return buildTemplateExportModel({
    noteId: "note-1",
    noteTitle: "Kingsway site visit",
    instance: {
      noteId: "note-1",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      answers: {},
      attachments: {},
      customRows: [],
    },
    template: TEMPLATE,
    version: makeVersion({ rows, columns, branding }),
    assets: { logoDataUrl: null, photos: new Map(), files: new Map() },
  });
}

const html = (opts, flavor = EXPORT_FLAVOR.STANDALONE) =>
  buildTemplateExportBody(build(opts), { flavor });

/**
 * What a draft row actually PUBLISHES, by the Builder's own rule: the keys it
 * writes, and a fill only where one genuinely exists. Identity is asserted
 * against this rather than against the draft object, because the draft is
 * in-memory working state and storage is what must stay unchanged.
 */
function publishedRows(rows) {
  return rows.map((r) => {
    const base = { id: r.id, label: r.label, px: r.px, minPx: r.minPx ?? 48, type: r.type };
    if (r.pxExplicit === true) base.pxExplicit = true;
    if (r.labelFill) base.labelFill = r.labelFill;
    if (Array.isArray(r.cells)) {
      base.cells = rowCells(r, 1).map((cell) => {
        const out = { id: cell.id, span: cell.span, type: cell.type };
        if (cell.fill) out.fill = cell.fill;
        return out;
      });
    }
    return base;
  });
}

/** Every `<td>` of the exported document, in order. */
const cellsOf = (markup) => markup.match(/<td[^>]*>/g) || [];
const cellOf = (markup, index) => cellsOf(markup)[index];

/* ================== 2-3. ONE cell, and only that cell ==================== */

describe("2-3. changing a content cell colour affects only that cell", () => {
  test("2. the override is stored on the cell it paints, and nowhere else", () => {
    const rows = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    const touched = rows.find((r) => r.id === "r-b");
    expect(rowCells(touched, 1)[0].fill).toEqual(PALE_BLUE);
    // The other rows are returned BYTE-IDENTICAL — not merely equal.
    const before = baseRows();
    expect(rows[0]).toEqual(before[0]);
    expect(rows[2]).toEqual(before[2]);
    expect(JSON.stringify(rows[0])).toBe(JSON.stringify(before[0]));
    expect(JSON.stringify(rows[2])).toBe(JSON.stringify(before[2]));
  });

  test("3. the same grid column of every OTHER row is untouched", () => {
    // The defect this whole phase exists to fix: the only colour control used to
    // be `table.contentBackgroundColor`, one template-wide value that painted
    // every value cell — so "colour this cell" necessarily coloured the column.
    const rows = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    const markup = html({ rows });
    const tds = cellsOf(markup);
    // label, value | label, value | label, value
    expect(tds[3]).toContain("background-color: #dbeafe");
    expect(tds[1]).not.toContain("#dbeafe");
    expect(tds[5]).not.toContain("#dbeafe");
    expect(tds[1]).toBe(tds[5]); // the two un-overridden value cells are identical
  });

  test("the grid example from the brief renders as three DIFFERENT value cells", () => {
    const branding = {
      table: { labelBackgroundColor: "#e5e7eb", contentBackgroundColor: "#ffffff" },
    };
    const rows = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    const tds = cellsOf(html({ rows, branding }));
    expect(tds[0]).toContain("background-color: #e5e7eb"); // grey label
    expect(tds[1]).toContain("background-color: #ffffff"); // white value
    expect(tds[2]).toContain("background-color: #e5e7eb"); // grey label
    expect(tds[3]).toContain("background-color: #dbeafe"); // pale blue value
    expect(tds[4]).toContain("background-color: #e5e7eb"); // grey label
    expect(tds[5]).toContain("background-color: #ffffff"); // white value
  });

  test("a stale selection cannot corrupt the table", () => {
    const rows = baseRows();
    expect(setCellFill(null, rows, "nope", "nope", PALE_BLUE)).toBe(rows);
    expect(setCellFill(null, rows, "r-a", "not-a-cell", PALE_BLUE)).toBe(rows);
  });
});

/* ==================== 4-7. inheritance, defaults, reset ================== */

describe("4-7. the table default is INHERITED, never copied", () => {
  test("5. a cell with no override takes the table's value default", () => {
    const branding = { table: { contentBackgroundColor: "#f3f4f6" } };
    expect(cellOf(html({ rows: baseRows(), branding }), 1)).toContain(
      "background-color: #f3f4f6"
    );
    // Nothing was written onto the row to achieve it.
    expect(rowCells(baseRows()[0], 1)[0].fill).toBeNull();
  });

  test("4. the LABEL column has its own default, and its own per-row override", () => {
    const branding = { table: { labelBackgroundColor: "#e5e7eb" } };
    const rows = setRowLabelFill(baseRows(), "r-c", { color: "#111827", opacity: 100 });
    const tds = cellsOf(html({ rows, branding }));
    expect(tds[0]).toContain("background-color: #e5e7eb");
    expect(tds[2]).toContain("background-color: #e5e7eb");
    expect(tds[4]).toContain("background-color: #111827");
  });

  test("6. changing the DEFAULT moves un-overridden cells and leaves overrides alone", () => {
    // table default value fill = white; Cell A override = pale blue.
    const rows = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    const before = cellsOf(html({ rows }));
    expect(before[1]).toContain("background-color: #ffffff");
    expect(before[3]).toContain("background-color: #dbeafe");

    // Change the table default to cream. Cell A stays pale blue.
    const cream = { table: { contentBackgroundColor: CREAM } };
    const after = cellsOf(html({ rows, branding: cream }));
    expect(after[1]).toContain(`background-color: ${CREAM}`);
    expect(after[5]).toContain(`background-color: ${CREAM}`);
    expect(after[3]).toContain("background-color: #dbeafe");
    // And the stored row still holds only its own override.
    expect(JSON.stringify(rows)).not.toContain(CREAM);
  });

  test("7. Reset returns the cell to the inherited default — it stores null, not a copy", () => {
    const filled = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    const reset = setCellFill(null, filled, "r-b", "r-b", null);
    expect(rowCells(reset.find((r) => r.id === "r-b"), 1)[0].fill).toBeNull();
    // The row is back to the trivial shape: no `cells` key at all, which is
    // precisely what "one cell spanning everything, with no override" already
    // means — so it PUBLISHES the bytes it published before it was recoloured.
    expect(reset.find((r) => r.id === "r-b").cells).toBeUndefined();
    expect(publishedRows(reset)).toEqual(publishedRows(baseRows()));
    // And it now follows the default wherever the default goes.
    const cream = { table: { contentBackgroundColor: CREAM } };
    expect(cellOf(html({ rows: reset, branding: cream }), 3)).toContain(
      `background-color: ${CREAM}`
    );
  });

  test("7. resetting a LABEL override removes the key too", () => {
    const filled = setRowLabelFill(baseRows(), "r-a", PALE_BLUE);
    expect(filled[0].labelFill).toEqual(PALE_BLUE);
    const reset = setRowLabelFill(filled, "r-a", null);
    expect(JSON.stringify(reset)).toBe(JSON.stringify(baseRows()));
    expect(rowLabelFill(reset[0])).toBeNull();
  });

  test("a row is only STORED as divided once it genuinely differs from the default", () => {
    const filled = setCellFill(null, baseRows(), "r-a", "r-a", PALE_BLUE);
    // One cell, spanning everything, keyed by the row id — but carrying a fill,
    // so it can no longer be expressed by the absence of the key.
    expect(filled[0].cells).toEqual([
      { id: "r-a", span: 1, type: FIELD_TYPE.TEXT, options: [], fill: PALE_BLUE },
    ]);
    expect(setCellFill(null, filled, "r-a", "r-a", null)[0].cells).toBeUndefined();
  });
});

/* ================== 17-20. the A2 structural actions ===================== */

describe("17-20. a fill follows its CELL through every structural action", () => {
  test("17-18. a split keeps the original cell's style; the sibling inherits", () => {
    const filled = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    const { columns, rows } = splitCell(null, filled, "r-b", "r-b", FIELD_TYPE.TIME);
    const cells = rowCells(rows.find((r) => r.id === "r-b"), columns.length);
    expect(cells).toHaveLength(2);
    // 17. the original cell KEEPS its id AND its explicit override.
    expect(cells[0].id).toBe("r-b");
    expect(cells[0].fill).toEqual(PALE_BLUE);
    // 18. the NEW sibling inherits the default — an override is something a
    // user chose for one cell, not a property of the shape.
    expect(cells[1].id).not.toBe("r-b");
    expect(cells[1].fill).toBeNull();
    // Every OTHER row absorbed the new grid column without gaining a fill.
    for (const other of ["r-a", "r-c"]) {
      const cs = rowCells(rows.find((r) => r.id === other), columns.length);
      expect(cs).toHaveLength(1);
      expect(cs[0].fill).toBeNull();
    }
  });

  test("19. a merge keeps the SURVIVING left cell's style, from either side", () => {
    const split = splitCell(null, baseRows(), "r-b", "r-b", FIELD_TYPE.TIME);
    const [left, right] = rowCells(split.rows.find((r) => r.id === "r-b"), 2);
    let rows = setCellFill(split.columns, split.rows, "r-b", left.id, PALE_BLUE);
    rows = setCellFill(split.columns, rows, "r-b", right.id, { color: "#fee2e2", opacity: 100 });

    const fromRight = mergeCell(split.columns, rows, "r-b", right.id, COLUMN_SIDE.LEFT);
    const fromLeft = mergeCell(split.columns, rows, "r-b", left.id, COLUMN_SIDE.RIGHT);
    for (const result of [fromRight, fromLeft]) {
      const cells = rowCells(result.rows.find((r) => r.id === "r-b"), 2);
      expect(cells).toHaveLength(1);
      expect(cells[0].id).toBe(left.id);
      expect(cells[0].fill).toEqual(PALE_BLUE); // deterministic winner
    }
  });

  test("20. inserting a table column at a boundary corrupts no fill", () => {
    // Every row gains a real second cell (the boundary rule an HTML table
    // obeys). The EXISTING cell keeps its id and its override; the newcomer has
    // none, in every row.
    const filled = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    const next = insertTableColumn(null, filled, 1, FIELD_TYPE.TEXT);
    expect(next.columns).toHaveLength(2);
    for (const id of ["r-a", "r-b", "r-c"]) {
      const cells = rowCells(next.rows.find((r) => r.id === id), next.columns.length);
      expect(cells).toHaveLength(2);
      expect(cells[0].id).toBe(id);
      expect(cells[0].fill).toEqual(id === "r-b" ? PALE_BLUE : null);
      expect(cells[1].fill).toBeNull();
    }
  });

  test("20. a column inserted STRICTLY INSIDE a cell leaves its fill alone", () => {
    // A cell the new column falls inside simply grows by one span — it is the
    // same cell, so it is still the same fill.
    const wide = insertTableColumn(null, baseRows(), 1, FIELD_TYPE.TEXT);
    const filled = setCellFill(wide.columns, wide.rows, "r-a", "r-a", PALE_BLUE);
    const merged = mergeCell(wide.columns, filled, "r-a", "r-a", COLUMN_SIDE.RIGHT);
    const spanning = rowCells(merged.rows.find((r) => r.id === "r-a"), 2);
    expect(spanning).toHaveLength(1);
    expect(spanning[0].span).toBe(2);

    const next = insertTableColumn(wide.columns, merged.rows, 1, FIELD_TYPE.TEXT);
    const cells = rowCells(next.rows.find((r) => r.id === "r-a"), next.columns.length);
    expect(cells).toHaveLength(1);
    expect(cells[0].id).toBe("r-a");
    expect(cells[0].span).toBe(3);
    expect(cells[0].fill).toEqual(PALE_BLUE);
  });

  test("20. deleting a table column corrupts no fill", () => {
    const split = splitCell(null, baseRows(), "r-b", "r-b", FIELD_TYPE.TIME);
    const rows = setCellFill(split.columns, split.rows, "r-b", "r-b", PALE_BLUE);
    const next = deleteTableColumn(split.columns, rows, split.columns[1].id);
    const cells = rowCells(next.rows.find((r) => r.id === "r-b"), next.columns.length);
    expect(cells).toHaveLength(1);
    expect(cells[0].id).toBe("r-b");
    expect(cells[0].fill).toEqual(PALE_BLUE);
  });

  test("4. split cells are styled INDEPENDENTLY, each in its own <td>", () => {
    const split = splitCell(null, baseRows(), "r-b", "r-b", FIELD_TYPE.TIME);
    const [left, right] = rowCells(split.rows.find((r) => r.id === "r-b"), 2);
    let rows = setCellFill(split.columns, split.rows, "r-b", left.id, PALE_BLUE);
    rows = setCellFill(split.columns, rows, "r-b", right.id, { color: "#fee2e2", opacity: 100 });
    const columns = withColumnWidths(split.columns, [50, 50]);
    const tds = cellsOf(html({ rows, columns }));
    // row r-b: label, left value, right value
    expect(tds[3]).toContain("background-color: #dbeafe");
    expect(tds[4]).toContain("background-color: #fee2e2");
    // and the undivided rows either side still take the default.
    expect(tds[1]).toContain("background-color: #ffffff");
  });
});

/* ========================= 14-16. surfaces and precedence ================= */

describe("14-16. document, header and cell each own their own surface", () => {
  test("14. a page background colour is a version-level document surface", () => {
    expect(isDefaultPageFill(null)).toBe(true);
    expect(pageFill(null)).toEqual({ color: "#ffffff", opacity: 100 });
    const tinted = { page: { backgroundColor: CREAM, backgroundOpacity: 100 } };
    expect(isDefaultPageFill(tinted)).toBe(false);
    expect(pageSurfaceColor(tinted)).toBe(CREAM);
    expect(brandingStyles(tinted).table["--nw-tpl-page-bg"]).toBe(CREAM);
  });

  test("14. the page is flattened ONCE so every surface uses the same colour", () => {
    // The paper is the bottom layer: on screen it sits on the app's grey desk,
    // in the export on a white body, in Word not at all. Compositing it against
    // white here is what makes those three the same colour.
    const half = { page: { backgroundColor: "#000000", backgroundOpacity: 50 } };
    expect(pageSurfaceColor(half)).toBe("#808080");
    expect(brandingStyles(half).table["--nw-tpl-page-bg"]).toBe("#808080");
  });

  test("15-16. changing the page overwrites neither the header banner nor a cell fill", () => {
    const branding = normalizeBranding({
      header: { backgroundColor: "#1aa3c2" },
      table: { contentBackgroundColor: "#f3f4f6" },
      page: { backgroundColor: CREAM },
    });
    // Three independent surfaces, three independent values.
    expect(branding.header.backgroundColor).toBe("#1aa3c2");
    expect(brandingStyles(branding).banner.backgroundColor).toBe("#1aa3c2");
    expect(tableContentFill(branding).color).toBe("#f3f4f6");
    expect(pageSurfaceColor(branding)).toBe(CREAM);

    const rows = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    const markup = html({ rows, branding });
    // The page paints the page; the cell paints the cell.
    expect(markup).toContain(`<section class="nw-tpl-page" style="background-color: ${CREAM}">`);
    expect(cellOf(markup, 3)).toContain("background-color: #dbeafe");
    expect(cellOf(markup, 1)).toContain("background-color: #f3f4f6");
  });

  test("16. a CELL override outranks the table default, which outranks nothing else", () => {
    const branding = { table: { contentBackgroundColor: "#f3f4f6" } };
    const rows = setCellFill(null, baseRows(), "r-a", "r-a", PALE_BLUE);
    const tds = cellsOf(html({ rows, branding }));
    expect(tds[1]).toContain("#dbeafe"); // override wins
    expect(tds[3]).toContain("#f3f4f6"); // default elsewhere
  });
});

/* ============ 12-13. fill is not opacity, and fill is not text =========== */

describe("12-13. a fill paints a SURFACE and nothing else", () => {
  test("12. an exported cell carries a background COLOUR, never a CSS opacity", () => {
    const rows = setCellFill(null, baseRows(), "r-b", "r-b", { color: "#1aa3c2", opacity: 40 });
    const td = cellOf(html({ rows }), 3);
    expect(td).toContain("background-color: rgba(26, 163, 194, 0.4)");
    expect(td).not.toMatch(/[^-]opacity:/);
    expect(td).not.toContain("filter:");
  });

  test("13. text colour is a separate value a fill can never reach", () => {
    const branding = {
      table: {
        contentBackgroundColor: "#111827",
        contentBackgroundOpacity: 40,
        contentTextColor: "#ffffff",
        labelTextColor: "#f9fafb",
      },
    };
    const tds = cellsOf(html({ rows: baseRows(), branding }));
    expect(tds[1]).toContain("color: #ffffff");
    expect(tds[1]).toContain("background-color: rgba(17, 24, 39, 0.4)");
    expect(tds[0]).toContain("color: #f9fafb");
    // The fill model never produces a `color` declaration of its own.
    expect(fillCss(makeFill("#111827", 40))).toBe("rgba(17, 24, 39, 0.4)");
  });

  test("13. the ribbon's Cell group edits FILL; typography stays elsewhere", () => {
    const cellGroup = RIBBON.slice(RIBBON.indexOf("function FillControls("));
    expect(cellGroup).toContain('label="Fill"');
    expect(cellGroup).not.toMatch(/textColor|setColor|labelTextColor|contentTextColor/);
    // The text colours remain the Document branding panel's.
    expect(PANEL).toContain("labelTextColor");
    expect(PANEL).toContain("contentTextColor");
  });
});

/* ======================= 21. structured controls ========================= */

describe("21. a filled cell does not break a structured control", () => {
  test("the fill is on the CELL; the control keeps its own white field", () => {
    // Date/Time/Number/Select render a native input with its own light-locked
    // field treatment, deliberately not rebranded, so the picker button stays
    // visible and clickable against any cell colour a company picks.
    expect(TEMPLATE_CSS).toContain(
      "/* Structured inputs (number/date/time/select) keep their own white field with a"
    );
    expect(TABLE).toContain('type="date"');
    expect(TABLE).toContain('type="time"');
    // Nothing in the table applies a container opacity that could fade one.
    expect(TABLE).not.toMatch(/style=\{\{[^}]*\bopacity:/);
  });

  test("a structured row exports its typed value inside its filled cell", () => {
    const rows = [
      { id: "r-d", label: "Visit date", type: FIELD_TYPE.DATE, px: 64, minPx: 48 },
    ];
    const filled = setCellFill(null, rows, "r-d", "r-d", PALE_BLUE);
    const markup = buildTemplateExportBody(
      buildTemplateExportModel({
        noteId: "note-1",
        noteTitle: "N",
        instance: {
          noteId: "note-1",
          templateId: "tpl-1",
          templateVersionId: "ver-1",
          answers: { "r-d": "2026-08-21" },
          attachments: {},
          customRows: [],
        },
        template: TEMPLATE,
        version: makeVersion({ rows: filled }),
        assets: { logoDataUrl: null, photos: new Map(), files: new Map() },
      }),
      { flavor: EXPORT_FLAVOR.STANDALONE }
    );
    expect(cellOf(markup, 1)).toContain("background-color: #dbeafe");
    expect(markup).toContain("2026-08-21");
  });
});

/* =================== 22-28. one model, every surface ===================== */

describe("22-27. the SAME canonical model drives every surface", () => {
  const rows = () => setCellFill(null, baseRows(), "r-b", "r-b", { color: "#1aa3c2", opacity: 40 });
  const branding = { page: { backgroundColor: CREAM } };

  test("22. the live note renders the resolved fill inline, per cell", () => {
    // The note and the Builder are the same component, so this is the note's
    // rendering too — it simply never receives the Builder's selection props.
    expect(TABLE).toContain(
      "style={{ gridColumn: cellGridSpan(cell), ...fillStyle(cell.fill) }}"
    );
    expect(TABLE).toContain("style={fillStyle(rowLabelFill(row))}");
    expect(NOTE_DOC).not.toContain("onCellSelect");
    expect(NOTE_DOC).not.toContain("setCellFill");
  });

  test("22. exactly ONE painted layer sits under a cell, on screen as in export", () => {
    // `.twocol-row` must NOT paint a background: a translucent cell fill would
    // otherwise composite over a second, invisible row fill that no export
    // flavour can reproduce.
    const rowRule = TEMPLATE_CSS.slice(
      TEMPLATE_CSS.indexOf(".twocol-row {"),
      TEMPLATE_CSS.indexOf(".twocol-cell-left {")
    );
    expect(rowRule).not.toMatch(/background/);
    expect(TEMPLATE_CSS).toContain(".twocol-cell-left {\n  background: var(--nw-tpl-label-bg");
    expect(TEMPLATE_CSS).toContain(".twocol-cell-right {\n  background: var(--nw-tpl-content-bg");
  });

  test("22. the page surface is a branded custom property on the paper", () => {
    expect(PAGED_CSS).toContain("background: var(--nw-tpl-page-bg, #ffffff);");
    expect(TABLE).toContain("brandingStyles(safeBranding).table");
  });

  test("23-24. Preview and the standalone HTML are the same document", () => {
    // Document Preview generates through these very builders, so HTML == Preview
    // by construction; asserting the document proves both.
    const doc = buildTemplateExportDocument(build({ rows: rows(), branding }), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(doc).toContain(`<section class="nw-tpl-page" style="background-color: ${CREAM}">`);
    expect(doc).toContain("background-color: rgba(26, 163, 194, 0.4)");
  });

  test("25. the PDF carries the identical declarations", () => {
    const pdf = html({ rows: rows(), branding }, EXPORT_FLAVOR.PDF);
    expect(pdf).toContain(`<section class="nw-tpl-page" style="background-color: ${CREAM}">`);
    expect(cellOf(pdf, 3)).toContain("background-color: rgba(26, 163, 194, 0.4)");
  });

  test("26. DOCX FLATTENS the fill deterministically, over the page, over paper", () => {
    const docx = html({ rows: rows(), branding }, EXPORT_FLAVOR.DOCX);
    // Word's cell shading has no alpha channel: rather than dropping the
    // opacity, the fill is composited into the one opaque colour that looks the
    // same — over the page, which is why the page still reaches Word.
    const expected = compositeFill(makeFill("#1aa3c2", 40), CREAM);
    expect(cellOf(docx, 3)).toContain(`background-color: ${expected}`);
    expect(docx).not.toContain("rgba(");
    // ...and the page itself is honestly omitted rather than silently ignored.
    expect(docx).toContain('<section class="nw-tpl-page">');
  });

  test("26. an OPAQUE fill reaches Word as exactly the colour that was chosen", () => {
    const opaque = setCellFill(null, baseRows(), "r-b", "r-b", PALE_BLUE);
    expect(cellOf(html({ rows: opaque }, EXPORT_FLAVOR.DOCX), 3)).toContain(
      "background-color: #dbeafe"
    );
  });

  test("27. print keeps the branded surfaces instead of dropping them", () => {
    expect(TEMPLATE_CSS).toMatch(/@media print[\s\S]*print-color-adjust: exact/);
    expect(PAGED_CSS).toContain("print-color-adjust: exact;");
    // A Builder selection is an affordance and must never print.
    expect(TEMPLATE_CSS).toMatch(/\.twocol-cell--selected \{\s*outline: none !important;/);
  });

  test("28. Markdown degrades deterministically: visual styling is ignored", () => {
    const plain = buildTemplateExportMarkdown(build({ rows: baseRows() }));
    const styled = buildTemplateExportMarkdown(build({ rows: rows(), branding }));
    expect(styled).toBe(plain);
    expect(styled).not.toMatch(/#dbeafe|rgba|background/i);
  });
});

/* ==================== 1, 29-30. historical compatibility ================= */

describe("1, 29-30. an existing template is not changed by any of this", () => {
  test("1. a legacy version with no fill data renders exactly as it did", () => {
    const legacy = {
      table: {
        labelBackgroundColor: "#e5e7eb",
        labelTextColor: "#111111",
        contentBackgroundColor: "#ffffff",
        contentTextColor: "#111111",
        borderColor: "#d1d5db",
        borderWidthPx: 1,
      },
    };
    const b = normalizeBranding(legacy);
    // The opacities it never had default to fully opaque...
    expect(b.table.labelBackgroundOpacity).toBe(100);
    expect(b.table.contentBackgroundOpacity).toBe(100);
    // ...so the custom properties are the plain hex colours they always were.
    expect(brandingStyles(legacy).table).toMatchObject({
      "--nw-tpl-label-bg": "#e5e7eb",
      "--nw-tpl-content-bg": "#ffffff",
      "--nw-tpl-page-bg": "#ffffff",
    });
    expect(tableLabelFill(legacy)).toEqual({ color: "#e5e7eb", opacity: 100 });
  });

  test("1. a legacy template's exported markup is byte-identical", () => {
    const legacyBranding = { table: { labelBackgroundColor: "#e5e7eb" } };
    const markup = html({ rows: baseRows(), branding: legacyBranding });
    // No page attribute, no rgba, exactly the two <td>s per row it always had.
    expect(markup).toContain('<section class="nw-tpl-page">');
    expect(markup).not.toContain("rgba(");
    expect(markup).not.toContain("colspan");
    expect(cellOf(markup, 0)).toBe(
      '<td class="nw-tpl-label" style="background-color: #e5e7eb; color: #111111; border: 1px solid #d1d5db">'
    );
  });

  test("29. reading a stored row never adds a fill key to it", () => {
    const stored = { id: "r-x", label: "Old", type: "multiline", px: 120 };
    const normalized = normalizeRow(stored, 0);
    expect(normalized.labelFill).toBeUndefined();
    expect(normalized.cells).toBeUndefined();
    expect(rowCells(normalized, 1)[0].fill).toBeNull();
    // A stored labelFill IS carried through, raw.
    expect(normalizeRow({ ...stored, labelFill: PALE_BLUE }, 0).labelFill).toEqual(PALE_BLUE);
    // Garbage is not.
    expect(normalizeRow({ ...stored, labelFill: "#fff" }, 0).labelFill).toBeUndefined();
  });

  test("29. an unreadable stored override is not a fill — it inherits", () => {
    const hostile = normalizeRows([
      {
        id: "r-x",
        label: "Hostile",
        type: "text",
        cells: [{ id: "r-x", span: 1, type: "text", fill: { color: "url(evil)", opacity: 50 } }],
      },
    ]);
    expect(rowCells(hostile[0], 1)[0].fill).toBeNull();
    expect(cellOf(html({ rows: hostile }), 1)).toContain("background-color: #ffffff");
  });

  test("30. submitting an UNCHANGED template still publishes no new version", () => {
    localStorage.clear();
    const tpl = createTemplate("T", { leftPct: 18, rows: baseRows() });
    const v1 = tpl.currentVersionId;
    // Re-publish exactly what the Builder would compute for an untouched draft:
    // no page key, no fills, the branding normalized on both sides.
    const again = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      valueColumns: null,
      logoAssetId: null,
      logoSrc: null,
      branding: normalizeBranding(getVersion(v1).branding),
      rows: getVersion(v1).rows,
    });
    expect(again.id).toBe(v1);
  });

  test("30. a genuine fill change DOES publish, and only then", () => {
    localStorage.clear();
    const tpl = createTemplate("T", { leftPct: 18, rows: baseRows() });
    const v1 = tpl.currentVersionId;
    const v2 = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      valueColumns: null,
      logoAssetId: null,
      logoSrc: null,
      branding: normalizeBranding({ page: { backgroundColor: CREAM } }),
      rows: getVersion(v1).rows,
    });
    expect(v2.id).not.toBe(v1);
    expect(v2.branding.page).toEqual({ backgroundColor: CREAM, backgroundOpacity: 100 });
    // The old version is untouched — versions are immutable.
    expect(getVersion(v1).branding.page).toEqual(DEFAULT_BRANDING.page);
  });
});

/* ============================ 10. the ribbon ============================= */

describe("10. the ribbon shows ONE contextual group, and the Builder owns it", () => {
  test("Cell when a cell is selected, Page when nothing is", () => {
    const contextual = RIBBON.slice(RIBBON.indexOf("{cellSelection ? ("));
    expect(contextual).toContain('<Group title={cellSelection.kind === CELL_FILL_KIND.LABEL ? "Label cell" : "Cell"}>');
    expect(contextual).toContain('<Group title="Page">');
    expect(contextual).toContain('resetLabel="Use default"');
    expect(contextual).toContain('resetLabel="Reset"');
    // One group, never both — a single ternary, not two independent renders.
    expect(RIBBON.match(/<Group title="Page">/g)).toHaveLength(1);
  });

  test("the opacity field is the shared BOUNDED one, so alpha cannot be malformed", () => {
    const controls = RIBBON.slice(
      RIBBON.indexOf("function FillControls("),
      RIBBON.indexOf("export default function TemplateEditorRibbon")
    );
    expect(controls).toContain("<BoundedNumberInput");
    expect(controls).toContain("limits={FILL_OPACITY}");
    expect(controls).not.toContain('type="number"');
  });

  test('"Use default" stores null — never a copy of the current default', () => {
    expect(RIBBON).toContain("onReset={() => onCellFillChange(null)}");
    expect(BUILDER).toContain("const next = storedFill(fill);");
    expect(BUILDER).toContain("setRowLabelFill(prev, cellSelection.rowId, next)");
  });

  test("the two contextual selections are mutually exclusive", () => {
    expect(BUILDER).toContain("if (object) setCellSelection(null);");
    expect(BUILDER).toContain("if (selection) setHeaderSelection(null);");
    expect(BUILDER).toContain('if (!target.closest("[data-cell-selectable]")) setCellSelection(null);');
  });

  test("selection is Builder-only: a completed note has no selectable cell", () => {
    expect(TABLE).toContain('const cellSelectable = typeof onCellSelect === "function";');
    expect(TABLE).toContain("if (!cellSelectable) return null;");
    expect(BUILDER).toContain("onCellSelect={selectCell}");
  });

  test("publishing writes a fill only when the surface genuinely has one", () => {
    const submit = BUILDER.slice(BUILDER.indexOf("function handleSubmitTemplate"));
    expect(submit).toContain("const labelFill = storedFill(r.labelFill);");
    expect(submit).toContain("if (labelFill) base.labelFill = labelFill;");
    expect(submit).toContain("const fill = storedFill(cell.fill);");
    expect(submit).toContain("if (fill) out.fill = fill;");
  });
});
