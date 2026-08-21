// src/lib/templateColumnWiring.test.js
//
// TEMPLATE EDITOR A2 — how the table grid, the compact row height and the shared
// content width are WIRED: which surface owns which action, what the planner does
// with a divided row, what every export flavour renders, and what an existing
// template and a pinned historical note still do.
//
// Source-text assertions (see docs/TESTING.md) for structure jsdom cannot lay
// out; the real planners, export model and export builders for everything that
// can be executed.

import fs from "fs";
import path from "path";

import {
  COLUMN_SIDE,
  deleteTableColumn,
  insertTableColumn,
  mergeCell,
  splitCell,
  storedValueColumns,
  valueColumns,
  withColumnWidths,
} from "./templateColumns";
import { COMPACT_ROW_MIN_PX, CONTROL_ROW_MIN_PX } from "./templateRowHeight";
import { ROW_BLOCK_KIND, planRowBlocks } from "./templateRowContent";
import { FIELD_TYPE, normalizeRow, normalizeRows } from "./templateFields";
import { buildTemplateExportModel } from "./templateExportModel";
import {
  EXPORT_FLAVOR,
  buildTemplateExportBody,
  buildTemplateExportDocument,
  templateExportCss,
} from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import { fragmentRow } from "./templateExportPagination";
import { USABLE_WIDTH_MM } from "./templateExportCapture";
import { toRenderRow, normalizeCustomRow } from "./noteCustomRows";
import { PAGE_MARGIN_MM, PAGE_SIZE_MM } from "./pageGeometry";

const SRC = path.join(__dirname, "..");
const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
const rawRead = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const TABLE = read("components/template/ResizableTwoColTable.js");
const BUILDER = read("components/template/TemplateBuilderDoc.js");
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const MAIN = read("components/MainArea.js");
const MODEL = read("lib/templateModel.js");
const TEMPLATE_CSS = rawRead("components/template/template.css");
const PAGED_CSS = rawRead("components/template/pagedDocument.css");

/* ----------------------------- fixtures -------------------------------- */

const TEMPLATE = { id: "tpl-1", name: "Site Inspection" };

const rowsFixture = () => [
  { id: "f-project", label: "Project", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
  { id: "f-date", label: "Date", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
  { id: "f-notes", label: "Notes", type: FIELD_TYPE.TEXT, px: 120, minPx: 100 },
];

/**
 * The product's own example table:
 *
 *   | Project | Project name              |
 *   | Date    | Date          | Time      |
 *   | Notes   | Inspection notes          |
 */
function splitTable() {
  const split = splitCell(null, rowsFixture(), "f-date", "f-date", FIELD_TYPE.TIME);
  return { columns: withColumnWidths(split.columns, [50, 50]), rows: split.rows };
}

function makeVersion({ rows, columns = null }) {
  return {
    id: "ver-1",
    templateId: "tpl-1",
    createdAt: 1700000000000,
    leftPct: 20,
    valueColumns: storedValueColumns(columns),
    branding: null,
    rows,
  };
}

function makeInstance(over = {}) {
  return {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: {},
    attachments: {},
    customRows: [],
    ...over,
  };
}

function build({ rows, columns = null, instance = makeInstance() }) {
  return buildTemplateExportModel({
    noteId: "note-1",
    noteTitle: "Kingsway site visit",
    instance,
    template: TEMPLATE,
    version: makeVersion({ rows, columns }),
    assets: { logoDataUrl: null, photos: new Map(), files: new Map() },
  });
}

const rowOf = (model, id) => model.rows.find((r) => r.id === id);

/* ============ 15-16. structure is the Builder's alone ================== */

describe("15-16. only the Template Builder may change the table's structure", () => {
  test("15. the Builder is given every structural callback", () => {
    for (const prop of [
      "onInsertTableColumn",
      "onDeleteTableColumn",
      "onColumnWidthsChange",
      "onColumnWidthsCommit",
      "onSplitCell",
      "onMergeCell",
    ]) {
      expect(BUILDER).toContain(prop);
    }
  });

  test("16. a normal note is given NONE of them and cannot mutate the grid", () => {
    for (const prop of [
      "onInsertTableColumn",
      "onDeleteTableColumn",
      "onColumnWidthsChange",
      "onColumnWidthsCommit",
      "onSplitCell",
      "onMergeCell",
    ]) {
      expect(NOTE_DOC).not.toContain(prop);
    }
    const usage = NOTE_DOC.slice(NOTE_DOC.indexOf("<ResizableTwoColTable"));
    expect(usage).toContain('rowActionsMode="note"');
    expect(usage).not.toMatch(/onInsertTableColumn|onDeleteTableColumn|onSplitCell|onMergeCell/);
    // The note READS the pinned version's grid and never writes one.
    expect(NOTE_DOC).toContain("setValueColumns(normalizeValueColumns(version.valueColumns));");
    expect(NOTE_DOC).not.toContain("storedValueColumns");
  });

  test("the menu returns before any structural entry is built, in note mode", () => {
    const menu = TABLE.slice(
      TABLE.indexOf("function rowMenuOptions("),
      TABLE.indexOf("function renderRowActions(")
    );
    expect(menu).toContain('if (rowActionsMode !== "builder") return options;');
    expect(menu.indexOf('rowActionsMode === "note" && row.isCustom')).toBeLessThan(
      menu.indexOf('rowActionsMode !== "builder"')
    );
  });

  test("the two kinds of action are NEVER both called \"insert column\"", () => {
    const menu = TABLE.slice(
      TABLE.indexOf("function rowMenuOptions("),
      TABLE.indexOf("function renderRowActions(")
    );
    // Row-local wording names the CELL; table-wide wording names the TABLE.
    expect(menu).toContain('label: "Split cell"');
    expect(menu).toContain('label: "Merge with cell on left"');
    expect(menu).toContain('label: "Merge with cell on right"');
    expect(menu).toContain('label: "Insert table column left"');
    expect(menu).toContain('label: "Insert table column right"');
    expect(menu).toContain("label: `Delete table column ${cell.start + 1}`");
    // No bare "Insert column" / "Delete column" anywhere.
    expect(menu).not.toMatch(/label: "Insert column/);
    expect(menu).not.toMatch(/label: `?Delete column/);
    // Grouped, so the scope of each is visible.
    expect(menu.match(/type: "separator"/g).length).toBeGreaterThanOrEqual(2);
  });

  test("only actions that make sense are offered — nothing is shown dead", () => {
    const menu = TABLE.slice(
      TABLE.indexOf("function rowMenuOptions("),
      TABLE.indexOf("function renderRowActions(")
    );
    expect(menu).toContain("if (onSplitCell && canSplitCell(grid, cell)) {");
    expect(menu).toContain("canMergeCell(cells, cell.id, COLUMN_SIDE.LEFT)");
    expect(menu).toContain("canMergeCell(cells, cell.id, COLUMN_SIDE.RIGHT)");
    expect(menu).toContain("if (onInsertTableColumn && canInsertTableColumn(grid)) {");
    expect(menu).toContain("if (onDeleteTableColumn && canDeleteTableColumn(grid)) {");
    for (const invented of ["Duplicate", "Sort", "Move column", "Freeze"]) {
      expect(menu).not.toContain(invented);
    }
  });

  test("publishing writes the grid and a row's cells only when they exist", () => {
    const submit = BUILDER.slice(BUILDER.indexOf("function handleSubmitTemplate"));
    expect(submit).toContain("valueColumns: storedValueColumns(valueColumns),");
    expect(submit).toContain("if (Array.isArray(r.cells)) {");
    expect(submit).toContain("const out = { id: cell.id, span: cell.span, type: cellType };");
    expect(submit).toContain("if (r.pxExplicit === true) base.pxExplicit = true;");
  });
});

/* ============ 14. no silent content destruction ======================== */

describe("14. structural removals never hide note content silently", () => {
  test("the model can say which cell ids a note has already filled in", () => {
    expect(MODEL).toContain("export function cellsWithNoteContent(cellIds) {");
    // Every collection a cell id can key into is checked.
    for (const collection of [
      "instance.answers",
      "instance.attachments",
      "instance.evidence",
      "instance.sectionContent",
      "instance.sectionDoc",
      "instance.sectionExtraHeight",
    ]) {
      expect(MODEL).toContain(collection);
    }
  });

  test("the Builder confirms ONLY when a removal would really hide something", () => {
    const guard = BUILDER.slice(
      BUILDER.indexOf("function confirmOrphanedCells"),
      BUILDER.indexOf("const insertTableColumnAt")
    );
    expect(guard).toContain("const filled = cellsWithNoteContent(orphanedCellIds);");
    expect(guard).toContain("if (filled.length === 0) return true;");
    expect(guard).toContain("window.confirm(");
    expect(guard).toContain("That content is not deleted, but it will no longer be shown");
    // Both destructive paths go through it, and neither commits before it.
    for (const action of ["deleteTableColumnById", "mergeCellInRow"]) {
      const body = BUILDER.slice(BUILDER.indexOf(`const ${action}`));
      const confirmAt = body.indexOf("confirmOrphanedCells");
      const setAt = body.indexOf("setRows(next.rows)");
      expect(confirmAt).toBeGreaterThan(-1);
      expect(confirmAt).toBeLessThan(setAt);
    }
  });

  test("the pure model REPORTS what a removal orphans rather than dropping it", () => {
    const { columns, rows } = splitTable();
    const cells = rows.find((r) => r.id === "f-date").cells;
    const merged = mergeCell(columns, rows, "f-date", cells[1].id, COLUMN_SIDE.LEFT);
    expect(merged.orphanedCellIds).toEqual([cells[1].id]);
    const gone = deleteTableColumn(columns, rows, columns[0].id);
    expect(gone.orphanedCellIds).toEqual(["f-date"]);
  });
});

/* ============ note-specific custom rows are untouched ================== */

describe("note-specific custom-row behaviour is unchanged", () => {
  test("a custom row is still a single full-width Text row", () => {
    const custom = normalizeCustomRow({
      id: "custom-1",
      templateId: "tpl-1",
      label: "Extra notes",
      answer: "hello",
      preferredHeight: 96,
    });
    const row = toRenderRow(custom);
    expect(row).toMatchObject({ id: "custom-1", type: FIELD_TYPE.TEXT, isCustom: true });
    expect("cells" in row).toBe(false);
    expect(row.pxExplicit).toBeUndefined();
  });

  test("21. a custom row's DRAGGED height is honoured; its default is not", () => {
    const fresh = toRenderRow(normalizeCustomRow({ id: "c1", preferredHeight: 96 }));
    expect(planRowBlocks({ row: fresh })[0].minHeight).toBe(COMPACT_ROW_MIN_PX);
    const dragged = toRenderRow(
      normalizeCustomRow({ id: "c1", preferredHeight: 220, heightExplicit: true })
    );
    expect(planRowBlocks({ row: dragged })[0].minHeight).toBe(220);
    expect(NOTE_DOC).toContain("heightExplicit: true,");
  });
});

/* ============ the block plan ========================================== */

describe("the block plan: an undivided row is untouched, a divided one is atomic", () => {
  test("an undivided row plans exactly the blocks it always did, at any grid width", () => {
    for (const count of [1, 2, 3, 4]) {
      const blocks = planRowBlocks({ row: rowsFixture()[0], valueColumnCount: count });
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        kind: ROW_BLOCK_KIND.ROW,
        id: "f-project",
        group: null,
        keepWithNext: false,
        splittable: false,
      });
    }
  });

  test("a divided row plans ONE atomic block and never a per-segment plan", () => {
    const { rows } = splitTable();
    const segments = [
      { key: "s0", kind: "text", blocks: [] },
      { key: "s1", kind: "image" },
    ];
    const divided = planRowBlocks({
      row: rows.find((r) => r.id === "f-date"),
      valueColumnCount: 2,
      sectionSegments: segments,
    });
    expect(divided).toHaveLength(1);
    expect(divided[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(divided[0].splittable).toBe(false);
    // An UNDIVIDED row on the same grid still plans per segment.
    expect(
      planRowBlocks({
        row: rows.find((r) => r.id === "f-project"),
        valueColumnCount: 2,
        sectionSegments: segments,
      }).length
    ).toBeGreaterThan(1);
  });

  test("22. a divided row's floor comes from its tallest cell", () => {
    const { rows } = splitTable(); // second cell is a Time control
    expect(
      planRowBlocks({
        row: rows.find((r) => r.id === "f-date"),
        valueColumnCount: 2,
      })[0].minHeight
    ).toBe(CONTROL_ROW_MIN_PX);
    expect(
      planRowBlocks({
        row: rows.find((r) => r.id === "f-project"),
        valueColumnCount: 2,
      })[0].minHeight
    ).toBe(COMPACT_ROW_MIN_PX);
  });

  test("a divided row is never treated as a compound Photo/File field", () => {
    const rows = [{ id: "f-photo", type: FIELD_TYPE.PHOTO }];
    const split = splitCell(null, rows, "f-photo", "f-photo");
    const blocks = planRowBlocks({
      row: split.rows[0],
      valueColumnCount: 2,
      isAttachmentField: true,
      attachments: { "f-photo": [] },
    });
    expect(blocks.every((b) => b.kind !== ROW_BLOCK_KIND.ATTACHMENT_HEAD)).toBe(true);
  });
});

/* ============ 17-20. exports ========================================== */

describe("17-20. every export flavour renders the same grid", () => {
  const model = () => {
    const { columns, rows } = splitTable();
    return build({
      rows,
      columns,
      instance: makeInstance({ answers: { "f-project": "Kingsway", "f-date": "2026-08-20" } }),
    });
  };

  test("the canonical model carries the grid and each cell's span", () => {
    const m = model();
    expect(m.layout.valueColumns).toEqual([
      expect.objectContaining({ widthPct: 50 }),
      expect.objectContaining({ widthPct: 50 }),
    ]);
    expect(rowOf(m, "f-project").cells.map((c) => c.span)).toEqual([2]);
    expect(rowOf(m, "f-date").cells.map((c) => c.span)).toEqual([1, 1]);
    // `units` is still cell one, never a separate copy.
    expect(rowOf(m, "f-date").cells[0].units).toBe(rowOf(m, "f-date").units);
    // A cell never carries a width.
    for (const row of m.rows) {
      for (const cell of row.cells) expect(cell.widthPct).toBeUndefined();
    }
  });

  test("an UNDIVIDED template still produces the model it always did", () => {
    const m = build({ rows: rowsFixture() });
    expect(m.layout.valueColumns).toHaveLength(1);
    expect(rowOf(m, "f-project").cells).toHaveLength(1);
    expect(rowOf(m, "f-project").cells[0].id).toBe("f-project");
    expect(rowOf(m, "f-project").cells[0].span).toBe(1);
  });

  test("17. HTML renders a real colgroup and real colspans", () => {
    const html = buildTemplateExportBody(model(), { flavor: EXPORT_FLAVOR.STANDALONE });
    // One <col> per REAL table column: label, then the value grid.
    expect(html).toContain(
      '<colgroup><col style="width: 20%" /><col style="width: 40%" /><col style="width: 40%" /></colgroup>'
    );
    // The undivided rows span both value columns; the divided one does not.
    expect(html).toContain('colspan="2"');
    expect(html).toContain("Kingsway");
    expect(html).toContain("2026-08-20");
    // No nested table anywhere — the outer table IS the table.
    expect(html).not.toContain("nw-tpl-cols");
  });

  test("an UNDIVIDED template's HTML is exactly what it always was", () => {
    const html = buildTemplateExportBody(build({ rows: rowsFixture() }), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(html).toContain('<colgroup><col style="width: 20%" /><col /></colgroup>');
    expect(html).toContain('<td class="nw-tpl-cell"');
    expect(html).not.toContain("colspan");
  });

  test("18. the PDF flavour uses the SAME calculated grid widths", () => {
    const html = buildTemplateExportBody(model(), { flavor: EXPORT_FLAVOR.PDF });
    expect(html).toContain('<col style="width: 40%" /><col style="width: 40%" />');
    expect(html).toContain('colspan="2"');
    // `table-layout: fixed` over that colgroup is what makes the widths real.
    expect(templateExportCss(EXPORT_FLAVOR.PDF)).toContain(
      ".nw-tpl-table { width: 100%; border-collapse: collapse; table-layout: fixed; }"
    );
  });

  test("19. the DOCX input expresses the same thing as ordinary colspan", () => {
    const html = buildTemplateExportBody(model(), { flavor: EXPORT_FLAVOR.DOCX });
    expect(html).toContain('colspan="2"');
    expect(html).not.toContain("nw-tpl-cols");
  });

  test("20. Markdown degrades deterministically and loses nothing", () => {
    const md = buildTemplateExportMarkdown(model());
    expect(md).toContain("### Project");
    expect(md).toContain("### Date");
    expect(md).toContain("#### Cell 1");
    expect(md).toContain("#### Cell 2");
    expect(md).toContain("Kingsway");
    expect(md).toContain("2026-08-20");
    expect(md).toBe(buildTemplateExportMarkdown(model()));
    // An undivided row carries no cell heading at all.
    expect(md.slice(md.indexOf("### Project"), md.indexOf("### Date"))).not.toContain(
      "#### Cell"
    );
  });

  test("a divided row is ATOMIC in the PDF page plan — never half-exported", () => {
    const m = model();
    expect(fragmentRow(rowOf(m, "f-date"), () => false).ok).toBe(false);
    expect(fragmentRow(rowOf(m, "f-project"), () => true).ok).toBe(true);
  });

  test("no renderer reinterprets raw state — every flavour reads the one model", () => {
    expect(read("lib/templateExportHtml.js")).not.toContain("instance.answers");
    expect(read("lib/templateExportMarkdown.js")).not.toContain("instance.");
    // The exporter derives its columns from the model's layout, not from a row.
    expect(read("lib/templateExportHtml.js")).toContain("model.layout?.valueColumns");
  });
});

/* ============ one content width, real print margins =================== */

describe("every surface agrees about the content width", () => {
  test("the exported document uses the SHARED usable width", () => {
    expect(templateExportCss(EXPORT_FLAVOR.STANDALONE)).toContain(
      `.nw-tpl-page { max-width: ${USABLE_WIDTH_MM}mm; margin: 0 auto; }`
    );
    for (const flavor of [
      EXPORT_FLAVOR.STANDALONE,
      EXPORT_FLAVOR.PDF,
      EXPORT_FLAVOR.DOCX,
    ]) {
      expect(templateExportCss(flavor)).not.toContain("820px");
    }
  });

  test("Document Preview is that same document, so it matches by construction", () => {
    const { columns, rows } = splitTable();
    const doc = buildTemplateExportDocument(build({ rows, columns }), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(doc).toContain(`.nw-tpl-page { max-width: ${USABLE_WIDTH_MM}mm;`);
    expect(doc).toContain('colspan="2"');
  });

  test("the app document's own content column is the same 170mm", () => {
    expect(USABLE_WIDTH_MM).toBe(
      PAGE_SIZE_MM.width - PAGE_MARGIN_MM.left - PAGE_MARGIN_MM.right
    );
    expect(PAGED_CSS).toContain("width: 170mm; /* usable width = 210 - 20 - 20 */");
    expect(TEMPLATE_CSS).not.toMatch(/\.twocol-row\s*\{[^}]*max-width/);
  });

  test("real print margins are untouched — only the DESK around the paper shrank", () => {
    expect(PAGE_MARGIN_MM).toEqual({ top: 20, right: 20, bottom: 20, left: 20 });
    expect(PAGED_CSS).toContain("@page {");
    expect(PAGED_CSS).toContain("margin: 20mm;");
    expect(PAGED_CSS).toMatch(/\.paged-doc\s*\{[\s\S]*?padding:\s*12px;/);
    expect(MAIN).toContain("overflow-auto px-2 py-3 sm:px-3 sm:py-4");
  });
});

/* ============ 24. historical templates and pinned notes ================ */

describe("24. an existing template and a pinned note are unaffected", () => {
  test("a historical row normalizes without gaining a key", () => {
    const normalized = normalizeRow(
      { id: "old", label: "Weather", px: 72, type: "multiline" },
      0
    );
    expect("cells" in normalized).toBe(false);
    expect("pxExplicit" in normalized).toBe(false);
    expect(normalized.type).toBe(FIELD_TYPE.TEXT);
  });

  test("a row that DOES carry cells keeps them through normalization", () => {
    const { rows } = splitTable();
    const row = rows.find((r) => r.id === "f-date");
    expect(normalizeRows([row])[0].cells).toEqual(row.cells);
  });

  test("the default grid stores as NOTHING, so Submit stays a no-op", () => {
    // What `publishTemplateVersion` compares: a legacy version has no key, and a
    // freshly-normalized default projects to the same `null`.
    expect(storedValueColumns(undefined)).toBeNull();
    expect(storedValueColumns(valueColumns(undefined))).toBeNull();
    expect(MODEL).toContain("valueColumns: storedValueColumns(current.valueColumns),");
    expect(MODEL).toContain("valueColumns: storedValueColumns(definition?.valueColumns),");
    // Untouched rows still store nothing, whatever the grid becomes.
    const widened = insertTableColumn(null, rowsFixture(), 1);
    const untouched = splitCell(null, rowsFixture(), "f-date", "f-date").rows;
    expect(widened.rows.every((r) => Array.isArray(r.cells))).toBe(true); // all gained a cell
    expect(untouched.filter((r) => Array.isArray(r.cells)).map((r) => r.id)).toEqual([
      "f-date",
    ]);
  });

  test("a historical note's answers still resolve — the first cell IS the row", () => {
    const { columns, rows } = splitTable();
    const model = build({
      rows,
      columns,
      instance: makeInstance({ answers: { "f-date": "recorded years ago" } }),
    });
    expect(JSON.stringify(rowOf(model, "f-date").units)).toContain("recorded years ago");
  });

  test("an existing template exports byte-for-byte as it did", () => {
    const once = buildTemplateExportBody(build({ rows: rowsFixture() }), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(once.match(/<td class="nw-tpl-cell"/g)).toHaveLength(3);
    expect(once).toBe(
      buildTemplateExportBody(build({ rows: rowsFixture() }), {
        flavor: EXPORT_FLAVOR.STANDALONE,
      })
    );
  });
});

/* ============ 23. zoom-safe drag, and the ⋯ menu contract ============== */

describe("23. the table-column resize is zoom-safe by construction", () => {
  test("the drag reads a RATIO of the row's own live rect — no pixel constant", () => {
    const drag = TABLE.slice(
      TABLE.indexOf("const onMouseMoveCell = useCallback("),
      TABLE.indexOf("const stopCellDrag = useCallback(")
    );
    expect(drag).toContain("const rect = cellDrag.el.getBoundingClientRect();");
    expect(drag).toContain("const share = ((e.clientX - valueLeft) / valueWidth) * 100;");
    expect(drag).not.toMatch(/PAGE_|USABLE_|mmToPx|zoomScale|documentZoom/);
  });

  test("the drag moves the SHARED grid, not the row it was dragged from", () => {
    expect(TABLE).toContain("resizeColumnsAt(grid, cellDrag.dividerIndex, share)");
    expect(TABLE).toContain("onColumnWidthsChange(widths)");
    // The Builder applies it to the grid state and to nothing else.
    expect(BUILDER).toContain("setValueColumns((prev) => withColumnWidths(prev, widths));");
    // Widths are percentages — the model never reads a pixel.
    expect(read("lib/templateColumns.js")).not.toMatch(
      /offsetWidth|clientWidth|getBoundingClientRect/
    );
  });

  test("a completed drag commits ONCE, exactly like the row-height drag", () => {
    expect(TABLE).toContain("onColumnWidthsCommit(lastColumnWidths.current)");
  });

  test("the dividers are the TABLE's, drawn on every row at the same shares", () => {
    const dividers = TABLE.slice(
      TABLE.indexOf("function renderCellDividers("),
      TABLE.indexOf("function renderFieldError(")
    );
    expect(dividers).toContain("grid.slice(0, -1).map((column, index)");
    expect(dividers).toContain("running += column.widthPct;");
    expect(dividers).toContain("tabIndex={0}");
    expect(dividers).toContain('role="separator"');
    expect(dividers).toContain('if (e.key === "ArrowLeft") {');
    expect(dividers).toContain(
      "if (!enableColumnDivider || !onColumnWidthsChange || grid.length < 2) {"
    );
  });

  test("every row is laid out against the SAME track list", () => {
    // One memo, used by the row block, the attachment head and the segment shell.
    expect(TABLE).toContain(
      "const gridTracks = useMemo(() => columnTemplate(leftWidth, grid), [leftWidth, grid]);"
    );
    expect(TABLE.match(/gridTemplateColumns: gridTracks/g)).toHaveLength(3);
    expect(TABLE).not.toContain("gridTemplateColumns: `${leftWidth} 1fr`");
    // A cell occupies the columns it spans and holds no width.
    expect(TABLE).toContain("style={{ gridColumn: cellGridSpan(cell) }}");
  });
});

describe("the ⋯ menu keeps its portal, keyboard and print contract", () => {
  test("it is still the shared ThreeDotMenu, portalled and light-locked", () => {
    const actions = TABLE.slice(
      TABLE.indexOf("function renderRowActions("),
      TABLE.indexOf("function renderSectionRefineStatus(")
    );
    expect(actions).toContain("<ThreeDotMenu");
    expect(actions).toContain('theme="light"');
    expect(actions).toContain('aria-haspopup="menu"');
    expect(actions).toContain("aria-expanded={open}");
    expect(read("components/ThreeDotMenu.js")).toContain("createPortal(menu, portalTarget)");
  });

  test("the trigger is keyed by CELL, so a structural action names one cell", () => {
    const actions = TABLE.slice(
      TABLE.indexOf("function renderRowActions("),
      TABLE.indexOf("function renderSectionRefineStatus(")
    );
    expect(actions).toContain("const key = `${row.id}::${cell.id}`;");
    expect(actions).toContain("anchorRef={menuAnchors.current.get(key) || null}");
  });

  test("an undivided row keeps ONE trigger, on the row, where it always was", () => {
    expect(TABLE).toContain(
      "{cells.length === 1 &&\n          renderRowActions(row, cells[0], 0, cells, headModernTarget)}"
    );
    expect(TABLE).toContain("{multi && renderRowActions(row, cell, index, cells, modernTarget)}");
  });

  test("the accent affordance and print hiding are unchanged", () => {
    expect(TEMPLATE_CSS).toContain(".twocol-row-actions {");
    expect(TEMPLATE_CSS).toContain(".twocol-cell-actions {");
    expect(TEMPLATE_CSS).toMatch(/@media print \{[\s\S]*?\.twocol-row-actions,/);
    expect(TEMPLATE_CSS).toMatch(/@media print \{[\s\S]*?\.twocol-col-handle,/);
  });
});
