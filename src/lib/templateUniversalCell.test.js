// src/lib/templateUniversalCell.test.js
//
// TEMPLATE EDITOR A4 — THE UNIVERSAL CONTENT CELL.
//
// The Template Builder no longer asks what KIND a cell is. Every cell it makes
// is a flexible Section: one document holding prose, rich typography, images and
// file attachments interleaved in any order, on the shared NoteWise editor core
// and the existing asset system. Nothing about that content model is new — this
// phase removed the question, and proved the answer was already "all of it".
//
// What is asserted here:
//   1-2, 33   the type selector is GONE (removed, not hidden) and a new cell is
//             a flexible Section
//   3-9       text, multiline text, images, files and every mixture of them in
//             ONE cell, through the canonical body reader and segmenter
//   10-12     a non-image file becomes a FileAttachment, keeps its filename and
//             stays openable through the existing attachment semantics
//   13-16     A2 split and merge: both halves flexible, the original's content
//             preserved, the sibling empty, no silent loss on merge
//   17-18     Quick Add and Refine reach every CELL, not only a row's first
//   19-20     compact when empty, growing with content
//   21-25     Preview / HTML / PDF / DOCX / Markdown
//   26-32     every historical structured field still loads, and an unchanged
//             historical template still publishes no new version
//
// The real modules for everything executable; source-text assertions only for
// the component wiring jsdom cannot lay out (see docs/TESTING.md).

import fs from "fs";
import path from "path";

import {
  DEFAULT_BUILDER_FIELD_TYPE,
  FIELD_CONTROL_TYPES,
  FIELD_TYPE,
  canAddFieldControl,
  canRemoveFieldControl,
  fieldTypeLabel,
  isFieldControlType,
  isFlexibleCellType,
  normalizeRow,
  normalizeRows,
  normalizeType,
} from "./templateFields";
import {
  TOOLBAR_CONTROL_KEYS,
  toolbarControlsForEditor,
} from "./editorCapabilities";
import { makeNewRow } from "../templates/defaultTwoColDoc";
import {
  COLUMN_SIDE,
  mergeCell,
  rowCells,
  setCellFieldControl,
  splitCell,
} from "./templateColumns";
import {
  SECTION_BODY_SOURCE,
  SECTION_QUICK_ADD_ROUTE,
  resolveSectionBody,
  resolveSectionQuickAddRoute,
  sectionEditorEligibility,
} from "./templateSectionBody";
import {
  SECTION_SEGMENT_KIND,
  sectionDocSegments,
} from "./templateSectionDocSegments";
import {
  SECTION_DOC_NODE,
  makeSectionDocValue,
  sectionDocNodesForRow,
  sectionDocRowAssetIds,
} from "./templateSectionDoc";
import { COMPACT_ROW_MIN_PX, rowMinHeightPx } from "./templateRowHeight";
import { EXPORT_UNIT, buildTemplateExportModel } from "./templateExportModel";
import {
  EXPORT_FLAVOR,
  buildTemplateExportBody,
  buildTemplateExportDocument,
} from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import {
  NOTE_TEMPLATE_INSTANCES_KEY,
  cellsWithNoteContent,
  createTemplate,
  getVersion,
  publishTemplateVersion,
} from "./templateModel";

const SRC = path.join(__dirname, "..");
const raw = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (rel) => strip(raw(rel));

const TABLE = read("components/template/ResizableTwoColTable.js");
const TABLE_RAW = raw("components/template/ResizableTwoColTable.js");
const BUILDER = read("components/template/TemplateBuilderDoc.js");
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const FIELDS = read("lib/templateFields.js");
const TEMPLATE_CSS = raw("components/template/template.css");

/* ------------------------------ fixtures -------------------------------- */

const TEMPLATE = { id: "tpl-1", name: "Site Inspection" };
const PHOTO_ASSET = "asset-photo-1";
const FILE_ASSET = "asset-file-1";

const ASSETS = {
  logoDataUrl: null,
  photos: new Map([[PHOTO_ASSET, "data:image/jpeg;base64,AAAA"]]),
  files: new Map([
    [
      FILE_ASSET,
      { name: "Engineer-report.pdf", mimeType: "application/pdf", size: 4321 },
    ],
  ]),
};

const P = (text) => `<p>${text}</p>`;
const IMG = `<img data-asset-id="${PHOTO_ASSET}" alt="west-wall.jpg" width="800" height="600" data-width-pct="60">`;
const FILE =
  `<div class="note-file-attachment" data-file-asset-id="${FILE_ASSET}"` +
  ` data-file-name="Engineer-report.pdf" data-file-size="4321"` +
  ` data-file-type="application/pdf"></div>`;

/** The brief's own worked example: prose, a photo, more prose, a report. */
const MIXED_HTML =
  P("Damage was found on the western wall.") +
  IMG +
  P("See attached engineer report.") +
  FILE;

const flexibleRow = (id = "r-a", label = "Inspection evidence") => ({
  id,
  label,
  type: FIELD_TYPE.TEXT,
  px: 64,
  minPx: 48,
});

const instanceWith = (sectionDoc = {}, over = {}) => ({
  noteId: "note-1",
  templateId: "tpl-1",
  templateVersionId: "ver-1",
  answers: {},
  attachments: {},
  customRows: [],
  sectionDoc,
  ...over,
});

const docFor = (html) => makeSectionDocValue(html);

function bodyFor(html, row = flexibleRow()) {
  return resolveSectionBody({
    instance: instanceWith({ [row.id]: docFor(html) }),
    rowId: row.id,
    rowType: row.type,
  });
}

function makeVersion({ rows, columns = null }) {
  return {
    id: "ver-1",
    templateId: "tpl-1",
    createdAt: 1700000000000,
    leftPct: 20,
    valueColumns: columns,
    branding: null,
    rows,
  };
}

function build({ rows, columns = null, instance }) {
  return buildTemplateExportModel({
    noteId: "note-1",
    noteTitle: "Kingsway site visit",
    instance,
    template: TEMPLATE,
    version: makeVersion({ rows, columns }),
    assets: ASSETS,
  });
}

const kindsOf = (body) => sectionDocSegments(body).map((s) => s.kind);
const unitsOf = (model, cellId) => {
  for (const row of model.rows) {
    for (const cell of row.cells) if (cell.id === cellId) return cell.units;
  }
  return null;
};

/* ============ 1, 33. the type selector is GONE, not hidden ============== */

describe("1, 33. there is no field-type selector in the normal Builder path", () => {
  test("1. no creation catalog, no selector options helper, no change handler", () => {
    for (const gone of [
      "BUILDER_FIELD_TYPES",
      "LEGACY_BUILDER_FIELD_TYPES",
      "builderFieldTypeOptions",
    ]) {
      expect(FIELDS).not.toContain(gone);
    }
    expect(TABLE).not.toContain("builderFieldTypeOptions");
    expect(TABLE).not.toContain("handleTypeChange");
    expect(TABLE).not.toContain("renderFieldTypeEditor");
    expect(BUILDER).not.toContain("builderFieldTypeOptions");
  });

  test("33. it is REMOVED, not merely hidden with CSS", () => {
    // No "Field type" control, no select bound to a cell's type, and no CSS
    // rule anywhere that would have hidden one instead.
    expect(TABLE).not.toContain("Field type");
    expect(TABLE).not.toMatch(/<select[\s\S]{0,200}value=\{type\}/);
    expect(TEMPLATE_CSS).not.toMatch(/field-type/i);
  });

  test("2. an empty flexible cell states what it accepts, in one quiet line", () => {
    expect(TABLE_RAW).toContain(
      'export const FLEXIBLE_CELL_HINT = "Text, image or file…";'
    );
    const block = TABLE.slice(
      TABLE.indexOf("function renderBuilderCellStructure(row, cell)"),
      TABLE.indexOf("function cellView(row, cell)")
    );
    expect(block).toContain("if (isFlexibleCellType(type)) {");
    expect(block).toContain("{FLEXIBLE_CELL_HINT}");
    // ...and it is an affordance, not an editor: the flexible branch renders one
    // static line with no field and no handler, and it is hidden in print with
    // the rest of the Builder's chrome.
    const flexibleBranch = block.slice(
      block.indexOf("if (isFlexibleCellType(type)) {"),
      block.indexOf("const isAttachment =")
    );
    expect(flexibleBranch).not.toMatch(/onChange|<input|<textarea|<select/);
    expect(TEMPLATE_CSS).toMatch(/@media print[\s\S]*\.twocol-cell-hint/);
  });

  test("2. a new row, and every new structural cell, is a flexible Section", () => {
    expect(makeNewRow("Observations").type).toBe(DEFAULT_BUILDER_FIELD_TYPE);
    expect(isFlexibleCellType(makeNewRow("X").type)).toBe(true);
    // The A2 actions that MINT a cell are given the same default.
    expect(BUILDER).toContain("DEFAULT_BUILDER_FIELD_TYPE");
    const split = splitCell(null, [flexibleRow()], "r-a", "r-a", DEFAULT_BUILDER_FIELD_TYPE);
    for (const cell of rowCells(split.rows[0], split.columns.length)) {
      expect(isFlexibleCellType(cell.type)).toBe(true);
    }
  });
});

/* ============== 3-9. one cell, every kind of content, mixed ============= */

describe("3-9. a flexible cell holds text, images and files together", () => {
  test("3. plain text", () => {
    const body = bodyFor(P("Damage was found on the western wall."));
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(kindsOf(body)).toEqual([SECTION_SEGMENT_KIND.TEXT]);
    expect(sectionEditorEligibility(body).ok).toBe(true);
  });

  test("4. multiple paragraphs are ONE continuous run of prose", () => {
    const body = bodyFor(P("First.") + P("Second.") + P("Third."));
    // Consecutive text blocks are one text node — a run of prose, exactly what
    // the older model called a TextItem — so it paginates as one stretch.
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].type).toBe(SECTION_DOC_NODE.TEXT);
    expect(body.nodes[0].blocks).toHaveLength(3);
    expect(kindsOf(body)).toEqual([SECTION_SEGMENT_KIND.TEXT]);
  });

  test("5. an image, asset-backed and never a blob URL", () => {
    const body = bodyFor(IMG);
    expect(body.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.IMAGE]);
    expect(body.nodes[0].attrs.assetId).toBe(PHOTO_ASSET);
    expect(JSON.stringify(body.nodes)).not.toContain("blob:");
    expect(JSON.stringify(body.nodes)).not.toContain("data:");
  });

  test("6. a file attachment", () => {
    const body = bodyFor(FILE);
    expect(body.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.FILE]);
    expect(body.nodes[0].attrs.assetId).toBe(FILE_ASSET);
  });

  test("7. image + text coexist, in document order", () => {
    const body = bodyFor(P("Before") + IMG + P("After"));
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.TEXT,
    ]);
  });

  test("8. file + text coexist, in document order", () => {
    const body = bodyFor(P("Before") + FILE + P("After"));
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.FILE,
      SECTION_DOC_NODE.TEXT,
    ]);
  });

  test("9. the brief's own example: text, photo, text, report — in ONE cell", () => {
    const body = bodyFor(MIXED_HTML);
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.FILE,
    ]);
    expect(sectionEditorEligibility(body).ok).toBe(true);
    // Both assets are found by the ONE collector the deletion gate uses, so
    // neither can be reaped while this cell still references it.
    const ids = sectionDocRowAssetIds({ "r-a": docFor(MIXED_HTML) }, "r-a");
    expect([...ids].sort()).toEqual([FILE_ASSET, PHOTO_ASSET].sort());
  });

  test("the shared editor core is the ONE content model — no Template copy", () => {
    const factory = read("components/template/sectionEditorFactory.js");
    expect(factory).toContain("sectionEditorExtensions");
    const extensions = read("components/editor/sectionEditorExtensions.js");
    expect(extensions).toContain("SECTION_FILE_ASSET_KINDS");
    // The Template surface defines no image or file NODE of its own.
    expect(TABLE).not.toMatch(/Node\.create|mergeAttributes/);
  });
});

/* ============ 10-12. a non-image file is an ATTACHMENT CARD ============= */

describe("10-12. a non-image file becomes a FileAttachment, not content bytes", () => {
  const model = () =>
    build({
      rows: [flexibleRow()],
      instance: instanceWith({ "r-a": docFor(MIXED_HTML) }),
    });

  test("10. it exports as a FILE unit, never as a photo or a text blob", () => {
    const units = unitsOf(model(), "r-a");
    const types = units.map((u) => u.type);
    expect(types).toEqual([
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.PHOTO,
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.FILE,
    ]);
    const file = units.find((u) => u.type === EXPORT_UNIT.FILE);
    expect(file.type).not.toBe(EXPORT_UNIT.PHOTO);
    // No bytes anywhere: the card REPRESENTS the file, it never displays it.
    expect(JSON.stringify(file)).not.toMatch(/base64|blob:/);
  });

  test("11. the filename is retained end to end", () => {
    const file = unitsOf(model(), "r-a").find((u) => u.type === EXPORT_UNIT.FILE);
    expect(file.name).toBe("Engineer-report.pdf");
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(html).toContain("<strong>Engineer-report.pdf</strong>");
  });

  test("12. it stays an ordinary attachment: openable, downloadable, size and type kept", () => {
    // The live card is the SHARED FileAttachment NodeView — the same one the
    // Free-form note uses — so Open / Download are its behaviour, not a
    // Template reimplementation.
    const view = read("components/template/TemplateSectionDocView.js");
    expect(view).toContain("SECTION_FILE_ASSET_KINDS");
    expect(read("lib/safeAttachmentOpen.js")).toContain("safeDownloadFilename");
    // And the exported card carries what identifies the file, with an explicit
    // note that the binary itself is not in the document.
    const file = unitsOf(model(), "r-a").find((u) => u.type === EXPORT_UNIT.FILE);
    expect(file.meta).toMatch(/PDF|KB|4/i);
    expect(typeof file.note).toBe("string");
    expect(file.note.length).toBeGreaterThan(0);
  });
});

/* ================= 13-16. A2 split and merge, per cell ================== */

describe("13-16. every value cell of a divided row is a full flexible Section", () => {
  const dividedTable = () => {
    const rows = [flexibleRow("r-a", "Date information"), flexibleRow("r-b", "Notes")];
    return splitCell(null, rows, "r-a", "r-a", DEFAULT_BUILDER_FIELD_TYPE);
  };

  test("13. both halves are flexible, and both resolve their own Section body", () => {
    const { columns, rows } = dividedTable();
    const cells = rowCells(rows[0], columns.length);
    expect(cells).toHaveLength(2);
    for (const cell of cells) expect(isFlexibleCellType(cell.type)).toBe(true);

    const instance = instanceWith({
      [cells[0].id]: docFor(P("Left half") + IMG),
      [cells[1].id]: docFor(P("Right half") + FILE),
    });
    const left = resolveSectionBody({ instance, rowId: cells[0].id, rowType: cells[0].type });
    const right = resolveSectionBody({ instance, rowId: cells[1].id, rowType: cells[1].type });
    expect(left.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
    ]);
    expect(right.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.FILE,
    ]);
    expect(sectionEditorEligibility(left).ok).toBe(true);
    expect(sectionEditorEligibility(right).ok).toBe(true);
  });

  test("14. the ORIGINAL cell keeps its id, so its document and assets never move", () => {
    const instance = instanceWith({ "r-a": docFor(MIXED_HTML) });
    const { columns, rows } = dividedTable();
    const cells = rowCells(rows[0], columns.length);
    expect(cells[0].id).toBe("r-a");
    // The very same stored entry still resolves, unchanged, after the split.
    const body = resolveSectionBody({ instance, rowId: cells[0].id, rowType: cells[0].type });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.FILE,
    ]);
    expect([...sectionDocRowAssetIds(instance.sectionDoc, "r-a")].sort()).toEqual(
      [FILE_ASSET, PHOTO_ASSET].sort()
    );
  });

  test("15. the new sibling starts EMPTY", () => {
    const instance = instanceWith({ "r-a": docFor(MIXED_HTML) });
    const { columns, rows } = dividedTable();
    const sibling = rowCells(rows[0], columns.length)[1];
    expect(instance.sectionDoc[sibling.id]).toBeUndefined();
    expect(sectionDocNodesForRow(instance.sectionDoc, sibling.id)).toBeNull();
    const body = resolveSectionBody({ instance, rowId: sibling.id, rowType: sibling.type });
    // "Empty" is one empty run of prose — the place to start typing — and no
    // media of any kind. It carries nothing from the cell it was split off.
    const segments = sectionDocSegments(body);
    expect(segments.map((seg) => seg.kind)).toEqual([SECTION_SEGMENT_KIND.TEXT]);
    expect(JSON.stringify(segments)).not.toContain(PHOTO_ASSET);
    expect(JSON.stringify(segments)).not.toContain(FILE_ASSET);
    expect(JSON.stringify(segments)).not.toContain("western wall");
    // An empty cell is still openable — it just opens with nothing in it.
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.DOCUMENT);
  });

  test("16. merging keeps the LEFT cell and never silently loses the other's content", () => {
    localStorage.clear();
    const { columns, rows } = dividedTable();
    const cells = rowCells(rows[0], columns.length);
    const merged = mergeCell(columns, rows, "r-a", cells[1].id, COLUMN_SIDE.LEFT);
    // The surviving cell is the original, with everything it held.
    const survivors = rowCells(merged.rows[0], columns.length);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe("r-a");
    // The absorbed cell is REPORTED, not destroyed — the Builder's confirmation
    // is driven by whether a note has actually filled it in.
    expect(merged.orphanedCellIds).toEqual([cells[1].id]);
    expect(cellsWithNoteContent(merged.orphanedCellIds)).toEqual([]);

    localStorage.setItem(
      NOTE_TEMPLATE_INSTANCES_KEY,
      JSON.stringify({
        "note-1": instanceWith({ [cells[1].id]: docFor(P("Filled in")) }),
      })
    );
    expect(cellsWithNoteContent(merged.orphanedCellIds)).toEqual([cells[1].id]);
    expect(BUILDER).toContain("function confirmOrphanedCells(orphanedCellIds)");
    expect(BUILDER).toContain("if (!confirmOrphanedCells(next.orphanedCellIds)) return;");
    localStorage.clear();
  });
});

/* ============ 17-18. Quick Add and Refine reach every CELL ============== */

describe("17-18. every cell is a destination, not only a row's first", () => {
  test("the note resolves bodies, editability and Quick Add PER CELL", () => {
    expect(NOTE_DOC).toContain("const cells = rowCells(row, valueColumns.length);");
    expect(NOTE_DOC).toContain("quickAdd[cell.id] = resolveSectionQuickAddRoute(body);");
    expect(NOTE_DOC).toContain("editable[cell.id] = {");
  });

  test("17-18. the presence gate is CELL-aware, so a split sibling can be used", () => {
    // This is the gate in front of activation, the Quick Add document target and
    // modern Refine. Asked of the row list alone it was false for every cell a
    // split or a column insertion created, which left those cells readable but
    // impossible to type into, capture into or refine.
    expect(NOTE_DOC).toContain("const cellIndex = useMemo(() => {");
    expect(NOTE_DOC).toContain("return cellIndexRef.current.has(rowId);");
    expect(NOTE_DOC).not.toMatch(
      /rowIsPresent[\s\S]{0,220}rowsRef\.current \|\| \[\]\)\.some/
    );
    for (const gate of [
      "const activateSectionEditor = useCallback(",
      "const sectionDocQuickAddTarget = useCallback(",
      "const modernSectionRefineEditor = useCallback(",
    ]) {
      const block = NOTE_DOC.slice(NOTE_DOC.indexOf(gate));
      expect(block.slice(0, 400)).toContain("rowIsPresent(rowId)");
    }
  });

  test("17. the Quick Add selection is not undone for a cell of a divided row", () => {
    expect(NOTE_DOC).toContain(
      "customRowIds.has(quickAddTargetRowId) || cellIndex.has(quickAddTargetRowId);"
    );
  });

  test("17. a cell names its own column, so the capture chip is never ambiguous", () => {
    expect(NOTE_DOC).toContain(
      'entry.count > 1 ? `${label || "Untitled field"} (column ${entry.index + 1})` : label,'
    );
    expect(NOTE_DOC).toContain("fieldType: normalizeType(entry.cell.type),");
  });

  test("18. Refine addresses a cell's prose through the same per-cell target", () => {
    expect(TABLE).toContain("rowModernRefineTarget(cellRow, null)");
    const body = bodyFor(MIXED_HTML);
    // Only the PROSE runs are refinable targets; the photo and the file are not.
    const text = sectionDocSegments(body).filter(
      (s) => s.kind === SECTION_SEGMENT_KIND.TEXT
    );
    expect(text).toHaveLength(2);
  });

  test("a flexible cell with nothing in it yet is still a Quick Add destination", () => {
    const body = resolveSectionBody({
      instance: instanceWith({}),
      rowId: "r-a",
      rowType: FIELD_TYPE.TEXT,
    });
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.DOCUMENT);
  });
});

/* ==================== 19-20. compact, and growing ======================= */

describe("19-20. an empty cell is compact; content is what makes a row grow", () => {
  test("19. an empty flexible row is the compact one-line floor", () => {
    const row = flexibleRow();
    expect(rowMinHeightPx({ row })).toBe(COMPACT_ROW_MIN_PX);
    // Its scaffold `px` reserves nothing — only a deliberately dragged height
    // does (A2), so removing the type editor genuinely made the Builder compact.
    expect(rowMinHeightPx({ row: { ...row, px: 400 } })).toBe(COMPACT_ROW_MIN_PX);
    expect(rowMinHeightPx({ row: { ...row, px: 400, pxExplicit: true } })).toBe(400);
  });

  test("19. the Builder's hint costs the row no height", () => {
    // 20px of line box inside the cell's 8px of vertical padding — inside the
    // 36px compact floor, so saying what the cell accepts adds nothing.
    expect(TEMPLATE_CSS).toMatch(/\.twocol-cell-hint \{[^}]*line-height: 20px/);
  });

  test("20. a cell holding an image and a file is CONTENT-DRIVEN, not reserved", () => {
    const model = build({
      rows: [flexibleRow()],
      instance: instanceWith({ "r-a": docFor(MIXED_HTML) }),
    });
    const row = model.rows[0];
    expect(row.contentDriven).toBe(true);
    // Content-driven means the exporter reserves NO fixed box: the row is as
    // tall as what is in it, and the image and file are real units in it.
    expect(row.units.map((u) => u.type)).toContain(EXPORT_UNIT.PHOTO);
    expect(row.units.map((u) => u.type)).toContain(EXPORT_UNIT.FILE);
  });
});

/* =============== 21-25. one model, every export flavour ================= */

describe("21-25. mixed content travels through the canonical export model", () => {
  const model = () =>
    build({
      rows: [flexibleRow()],
      instance: instanceWith({ "r-a": docFor(MIXED_HTML) }),
    });

  test("22. HTML carries the prose, the photo and the file card, in order", () => {
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    const order = [
      html.indexOf("Damage was found on the western wall."),
      html.indexOf("<img"),
      html.indexOf("See attached engineer report."),
      html.indexOf("Engineer-report.pdf"),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('class="nw-tpl-file"');
  });

  test("21. Document Preview is the same document, from the same builders", () => {
    const doc = buildTemplateExportDocument(model(), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(doc).toContain("Engineer-report.pdf");
    expect(doc).toContain("data:image/jpeg;base64,AAAA");
    // Preview generates through exactly these entry points.
    const preview = read("components/editor/DocumentPreview.js");
    expect(preview).toMatch(/templateExport|buildTemplate|runTemplate/);
  });

  test("23. PDF carries the same units", () => {
    const pdf = buildTemplateExportBody(model(), { flavor: EXPORT_FLAVOR.PDF });
    expect(pdf).toContain("Engineer-report.pdf");
    expect(pdf).toContain("<img");
  });

  test("24. DOCX carries the prose, the image and the file card", () => {
    const docx = buildTemplateExportBody(model(), { flavor: EXPORT_FLAVOR.DOCX });
    expect(docx).toContain("Engineer-report.pdf");
    expect(docx).toContain("<img");
    expect(docx).toContain("Damage was found on the western wall.");
  });

  test("25. Markdown degrades deterministically and loses nothing identifiable", () => {
    const md = buildTemplateExportMarkdown(model());
    expect(md).toContain("Damage was found on the western wall.");
    expect(md).toContain("See attached engineer report.");
    expect(md).toContain("Engineer-report.pdf");
    // No HTML, no data URL, no style: portable Markdown only.
    expect(md).not.toContain("<img");
    expect(md).not.toContain("data:image");
    expect(md).not.toContain("class=");
  });

  test("no renderer parses raw editor HTML for itself", () => {
    // Every flavour is handed the canonical UNITS; the stored document is
    // parsed once, by the one reader.
    for (const rel of [
      "lib/templateExportHtml.js",
      "lib/templateExportMarkdown.js",
    ]) {
      expect(read(rel)).not.toContain("sectionDoc[");
      expect(read(rel)).not.toContain("parseSectionDocHtml");
    }
  });
});

/* ============= 26-32. historical structured fields still work =========== */

describe("26-32. every historical field type still loads and behaves", () => {
  const historical = [
    ["26", FIELD_TYPE.TEXT, "Notes", "Text"],
    ["27", FIELD_TYPE.NUMBER, "Reading", "Number"],
    ["28", FIELD_TYPE.DATE, "Visit date", "Date"],
    ["29", FIELD_TYPE.TIME, "Arrival", "Time"],
    ["30", FIELD_TYPE.YESNO, "Access granted", "Yes / No"],
    ["31", FIELD_TYPE.SELECT, "Status", "Dropdown"],
    ["31b", FIELD_TYPE.CHECKBOX, "PPE worn", "Checkbox"],
  ];

  test.each(historical)("%s. a stored %s field loads with its type intact", (_n, type) => {
    const row = normalizeRow({ id: `r-${type}`, label: "L", type, px: 90 }, 0);
    expect(row.type).toBe(type);
    expect(normalizeType(row.type)).toBe(type);
    expect(row.px).toBe(90);
  });

  test.each(historical)(
    "%s. a %s field is NOT flexible and names itself in the Builder",
    (_n, type, _label, display) => {
      expect(isFlexibleCellType(type)).toBe(type === FIELD_TYPE.TEXT);
      expect(fieldTypeLabel(type)).toBe(display);
    }
  );

  test("27-31. a structured cell still renders its own typed control", () => {
    // The note-mode answer control is untouched by A4 — the type it switches on
    // is the STORED one, and nothing can create a new one.
    const control = TABLE.slice(
      TABLE.indexOf("function renderAnswerControl(row)"),
      TABLE.indexOf("function renderBuilderCellStructure(row, cell)")
    );
    for (const t of ["NUMBER", "DATE", "TIME", "CHECKBOX", "YESNO", "SELECT"]) {
      expect(control).toContain(`FIELD_TYPE.${t}`);
    }
  });

  test("27-31. a cell with a control NAMES it, and is still not a type selector", () => {
    const block = TABLE.slice(
      TABLE.indexOf("function renderBuilderCellStructure(row, cell)"),
      TABLE.indexOf("function cellView(row, cell)")
    );
    expect(block).toContain("{fieldTypeLabel(type)} field");
    // A typed control is a first VALUE, not a closed container, and the badge
    // says so — the cell still takes text, images and files beneath it.
    expect(block).toContain("text, images and files can still be added beneath it");
    // A Dropdown keeps its OPTIONS editable — they are template structure — but
    // the TYPE is never a control in the cell.
    expect(block).toContain("type === FIELD_TYPE.SELECT && (");
    expect(block).toContain("Dropdown options");
    expect(block).not.toMatch(/<select/);
  });

  test("26-31. a structured cell still holds supplementary flexible content", () => {
    // A structured field is not a closed container: it keeps its typed value and
    // may carry a Section document beneath it, exactly as before A4.
    const body = resolveSectionBody({
      instance: instanceWith({ "r-d": docFor(P("Measured after the rain.") + IMG) }),
      rowId: "r-d",
      rowType: FIELD_TYPE.NUMBER,
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    const model = build({
      rows: [{ id: "r-d", label: "Reading", type: FIELD_TYPE.NUMBER, px: 64, minPx: 48 }],
      instance: instanceWith(
        { "r-d": docFor(P("Measured after the rain.") + IMG) },
        { answers: { "r-d": "42" } }
      ),
    });
    const units = unitsOf(model, "r-d").map((u) => u.type);
    // The typed value stays FIRST and fixed; the document follows it.
    expect(units[0]).toBe(EXPORT_UNIT.VALUE);
    expect(units).toContain(EXPORT_UNIT.PHOTO);
  });

  test("32. an unchanged historical template still publishes NO new version", () => {
    localStorage.clear();
    const rows = [
      { id: "h-text", label: "Notes", type: "text", px: 120, minPx: 100 },
      { id: "h-num", label: "Reading", type: "number", px: 64, minPx: 48 },
      { id: "h-date", label: "Visit date", type: "date", px: 64, minPx: 48 },
      { id: "h-time", label: "Arrival", type: "time", px: 64, minPx: 48 },
      { id: "h-yn", label: "Access", type: "yesno", px: 64, minPx: 48 },
      {
        id: "h-sel",
        label: "Status",
        type: "select",
        px: 64,
        minPx: 48,
        options: [{ id: "o1", value: "Open" }],
      },
      { id: "h-photo", label: "Site photos", type: "photo", px: 220, minPx: 100 },
    ];
    const tpl = createTemplate("Legacy", { leftPct: 18, rows });
    const v1 = tpl.currentVersionId;
    const stored = getVersion(v1).rows;

    // Exactly what the Builder computes for an untouched draft, after A4.
    const again = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      valueColumns: null,
      logoAssetId: null,
      logoSrc: null,
      branding: getVersion(v1).branding,
      rows: stored,
    });
    expect(again.id).toBe(v1);
    // Nothing was converted on the way through, either.
    expect(normalizeRows(getVersion(v1).rows).map((r) => r.type)).toEqual([
      "text",
      "number",
      "date",
      "time",
      "yesno",
      "select",
      "photo",
    ]);
    localStorage.clear();
  });

  test("32. a historical note keyed to those fields still renders and exports", () => {
    const rows = [
      { id: "h-num", label: "Reading", type: "number", px: 64, minPx: 48 },
      {
        id: "h-sel",
        label: "Status",
        type: "select",
        px: 64,
        minPx: 48,
        options: [{ id: "o1", value: "Open" }],
      },
    ];
    const model = build({
      rows,
      instance: instanceWith({}, { answers: { "h-num": "42", "h-sel": "o1" } }),
    });
    const html = buildTemplateExportBody(model, { flavor: EXPORT_FLAVOR.STANDALONE });
    expect(html).toContain("42");
    expect(html).toContain("Open");
    expect(html).not.toContain("o1");
  });
});

/* ======================================================================== */
/* A4 CORRECTION (2026-08-22) — DELIBERATE FIELD CONTROLS                    */
/*                                                                          */
/* Removing the per-row type dropdown removed the permanent QUESTION, not    */
/* structured fields. A template author may still give ONE cell a typed      */
/* control, from that cell's own ⋯ menu — a contextual action, never a       */
/* selector on every row and never an inspector.                             */
/* ======================================================================== */

describe("A4c 1-3. the action is contextual, and the default is untouched", () => {
  test("1. there is still no permanent Field Type dropdown", () => {
    expect(TABLE).not.toContain("Field type");
    expect(TABLE).not.toMatch(/<select[\s\S]{0,200}value=\{type\}/);
    expect(FIELDS).not.toContain("builderFieldTypeOptions");
    // The in-cell structure block renders no select of any kind.
    const block = TABLE.slice(
      TABLE.indexOf("function renderBuilderCellStructure(row, cell)"),
      TABLE.indexOf("function cellView(row, cell)")
    );
    expect(block).not.toMatch(/<select/);
  });

  test("2. a new row and a new split sibling are still flexible Sections", () => {
    expect(makeNewRow("X").type).toBe(DEFAULT_BUILDER_FIELD_TYPE);
    const split = splitCell(null, [flexibleRow()], "r-a", "r-a", DEFAULT_BUILDER_FIELD_TYPE);
    for (const cell of rowCells(split.rows[0], split.columns.length)) {
      expect(isFlexibleCellType(cell.type)).toBe(true);
      expect(canAddFieldControl(cell.type)).toBe(true);
    }
  });

  test("3. the contextual action lives on the CELL's own ⋯ menu", () => {
    const menu = TABLE.slice(
      TABLE.indexOf("function rowMenuOptions("),
      TABLE.indexOf("function renderRowActions(")
    );
    expect(menu).toContain("if (onAddFieldControl && canAddFieldControl(cell.type)) {");
    expect(menu).toContain("for (const control of FIELD_CONTROL_TYPES) {");
    expect(menu).toContain("label: `${control.label} field`");
    expect(menu).toContain("if (onRemoveFieldControl && canRemoveFieldControl(cell.type)) {");
    expect(menu).toContain('label: "Remove field control"');
    // Grouped like every other scope in this menu, and offered by the Builder
    // alone — a completed note may never change template structure.
    expect(menu.indexOf('rowActionsMode !== "builder"')).toBeLessThan(
      menu.indexOf("canAddFieldControl(cell.type)")
    );
    expect(NOTE_DOC).not.toContain("onAddFieldControl");
    expect(NOTE_DOC).not.toContain("onRemoveFieldControl");
    expect(BUILDER).toContain("onAddFieldControl={addFieldControl}");
    expect(BUILDER).toContain("onRemoveFieldControl={removeFieldControl}");
  });

  test("3. it is an action list, not a re-introduced inspector or dropdown", () => {
    // Five directly-invokable entries and one way back — no submenu to hover
    // through, no panel, no permanent control.
    expect(FIELD_CONTROL_TYPES.map((t) => t.label)).toEqual([
      "Number",
      "Date",
      "Time",
      "Yes / No",
      "Dropdown",
    ]);
    expect(BUILDER).not.toMatch(/FieldInspector|TypePanel/);
  });
});

describe("A4c 4-9. creating each control, and what is NOT offered", () => {
  const create = (type, rows = [flexibleRow()]) =>
    setCellFieldControl(null, rows, "r-a", "r-a", type);

  test.each([
    ["4", FIELD_TYPE.NUMBER],
    ["5", FIELD_TYPE.DATE],
    ["6", FIELD_TYPE.TIME],
    ["7", FIELD_TYPE.YESNO],
    ["8", FIELD_TYPE.SELECT],
  ])("%s. a flexible cell can be given a %s control", (_n, type) => {
    const rows = create(type);
    // An UNDIVIDED cell stores its type on the row and no `cells` key at all —
    // the exact shape every template published before columns existed has.
    expect(rows[0].type).toBe(type);
    expect(rows[0].cells).toBeUndefined();
    expect(rowCells(rows[0], 1)[0].type).toBe(type);
    expect(isFieldControlType(type)).toBe(true);
    expect(canAddFieldControl(rows[0].type)).toBe(false); // already has one
    expect(canRemoveFieldControl(rows[0].type)).toBe(true);
  });

  test("8. a Dropdown opens ready to configure, and publishes no blank option", () => {
    const rows = create(FIELD_TYPE.SELECT);
    const options = rowCells(rows[0], 1)[0].options;
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe("");
    expect(typeof options[0].id).toBe("string");
    // The Builder drops an empty option at publish time (unchanged rule).
    expect(BUILDER).toContain('.filter((o) => String(o.value ?? "").trim() !== "")');
  });

  test("9. Photo and File are NOT offered, and cannot be created", () => {
    expect(FIELD_CONTROL_TYPES.map((t) => t.value)).not.toContain(FIELD_TYPE.PHOTO);
    expect(FIELD_CONTROL_TYPES.map((t) => t.value)).not.toContain(FIELD_TYPE.FILE);
    expect(isFieldControlType(FIELD_TYPE.PHOTO)).toBe(false);
    expect(isFieldControlType(FIELD_TYPE.FILE)).toBe(false);
    // ...and the writer refuses them even if invoked directly.
    for (const type of [FIELD_TYPE.PHOTO, FIELD_TYPE.FILE]) {
      const rows = [flexibleRow()];
      expect(setCellFieldControl(null, rows, "r-a", "r-a", type)).toBe(rows);
    }
    expect(FIELDS).not.toContain("Photo (legacy)");
  });

  test("9. Checkbox is not CREATABLE, but stays a valid stored type", () => {
    // Yes/No and Checkbox are the same question under two names.
    expect(FIELD_CONTROL_TYPES.map((t) => t.value)).not.toContain(FIELD_TYPE.CHECKBOX);
    expect(normalizeType("checkbox")).toBe(FIELD_TYPE.CHECKBOX);
    expect(normalizeRow({ id: "c", label: "PPE", type: "checkbox" }, 0).type).toBe(
      FIELD_TYPE.CHECKBOX
    );
    // A historical Checkbox can still be returned to a flexible cell.
    expect(canRemoveFieldControl(FIELD_TYPE.CHECKBOX)).toBe(true);
  });

  test("a Photo/File cell offers no removal — its attachments render only for it", () => {
    expect(canRemoveFieldControl(FIELD_TYPE.PHOTO)).toBe(false);
    expect(canRemoveFieldControl(FIELD_TYPE.FILE)).toBe(false);
    const rows = [{ ...flexibleRow(), type: FIELD_TYPE.PHOTO }];
    expect(setCellFieldControl(null, rows, "r-a", "r-a", FIELD_TYPE.TEXT)).toBe(rows);
  });

  test("a stale menu cannot corrupt the table", () => {
    const rows = [flexibleRow()];
    expect(setCellFieldControl(null, rows, "nope", "nope", FIELD_TYPE.DATE)).toBe(rows);
    expect(setCellFieldControl(null, rows, "r-a", "not-a-cell", FIELD_TYPE.DATE)).toBe(rows);
  });
});

describe("A4c 10-11. conversion never silently loses content", () => {
  const filled = () => instanceWith({ "r-a": docFor(MIXED_HTML) });

  test("10. a cell given a control KEEPS its text, images and files", () => {
    const rows = setCellFieldControl(null, [flexibleRow()], "r-a", "r-a", FIELD_TYPE.NUMBER);
    // Nothing on the note was touched — the same stored document, same cell id.
    const body = resolveSectionBody({
      instance: filled(),
      rowId: "r-a",
      rowType: rows[0].type,
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.FILE,
    ]);
  });

  test("10. it exports as typed value FIRST, then the whole Section beneath it", () => {
    const rows = setCellFieldControl(null, [flexibleRow()], "r-a", "r-a", FIELD_TYPE.NUMBER);
    const model = build({
      rows,
      instance: instanceWith({ "r-a": docFor(MIXED_HTML) }, { answers: { "r-a": "42" } }),
    });
    const units = unitsOf(model, "r-a").map((u) => u.type);
    expect(units[0]).toBe(EXPORT_UNIT.VALUE);
    expect(units).toContain(EXPORT_UNIT.PHOTO);
    expect(units).toContain(EXPORT_UNIT.FILE);
    const html = buildTemplateExportBody(model, { flavor: EXPORT_FLAVOR.STANDALONE });
    expect(html).toContain("42");
    expect(html).toContain("Engineer-report.pdf");
    expect(html).toContain("Damage was found on the western wall.");
  });

  test("11. the round trip is exact: add a control, remove it, nothing changed", () => {
    const start = [flexibleRow()];
    const added = setCellFieldControl(null, start, "r-a", "r-a", FIELD_TYPE.DATE);
    const back = setCellFieldControl(null, added, "r-a", "r-a", DEFAULT_BUILDER_FIELD_TYPE);
    expect(back[0].type).toBe(DEFAULT_BUILDER_FIELD_TYPE);
    expect(back[0].cells).toBeUndefined();
    expect(isFlexibleCellType(back[0].type)).toBe(true);
  });

  test("11. removing a Dropdown keeps its options, so re-adding restores them", () => {
    let rows = setCellFieldControl(null, [flexibleRow()], "r-a", "r-a", FIELD_TYPE.SELECT);
    rows = rows.map((r) => ({ ...r, options: [{ id: "o1", value: "Open" }] }));
    rows = setCellFieldControl(null, rows, "r-a", "r-a", DEFAULT_BUILDER_FIELD_TYPE);
    expect(rows[0].type).toBe(DEFAULT_BUILDER_FIELD_TYPE);
    expect(rows[0].options).toEqual([{ id: "o1", value: "Open" }]);
    rows = setCellFieldControl(null, rows, "r-a", "r-a", FIELD_TYPE.SELECT);
    expect(rowCells(rows[0], 1)[0].options).toEqual([{ id: "o1", value: "Open" }]);
  });

  test("11. a filled cell asks first, in BOTH directions, and says nothing is deleted", () => {
    const confirm = BUILDER.slice(
      BUILDER.indexOf("function confirmFieldControlChange(cellId, what)"),
      BUILDER.indexOf("const addFieldControl = useCallback(")
    );
    // The same gate A2 uses for removing structure: ask only when a note has
    // genuinely filled this cell in.
    expect(confirm).toContain("if (cellsWithNoteContent([cellId]).length === 0) return true;");
    expect(confirm).toContain("Nothing is deleted");
    expect(BUILDER).toContain("if (\n        !confirmFieldControlChange(");
    const add = BUILDER.slice(
      BUILDER.indexOf("const addFieldControl = useCallback("),
      BUILDER.indexOf("const removeFieldControl = useCallback(")
    );
    expect(add).toContain("confirmFieldControlChange(");
    expect(add).toContain("with its text, images and files kept beneath it");
    const remove = BUILDER.slice(BUILDER.indexOf("const removeFieldControl = useCallback("));
    expect(remove.slice(0, 700)).toContain("confirmFieldControlChange(");
  });

  test("11. the confirmation is driven by real note content, not by guesswork", () => {
    localStorage.clear();
    expect(cellsWithNoteContent(["r-a"])).toEqual([]);
    localStorage.setItem(
      NOTE_TEMPLATE_INSTANCES_KEY,
      JSON.stringify({ "note-1": instanceWith({ "r-a": docFor(P("Filled in")) }) })
    );
    expect(cellsWithNoteContent(["r-a"])).toEqual(["r-a"]);
    localStorage.clear();
  });
});

describe("A4c 12-13. split cells and the note", () => {
  test("12. each half of a split row takes its own control, independently", () => {
    const split = splitCell(
      null,
      [flexibleRow("r-a", "Date information")],
      "r-a",
      "r-a",
      DEFAULT_BUILDER_FIELD_TYPE
    );
    const [left, right] = rowCells(split.rows[0], split.columns.length);
    let rows = setCellFieldControl(split.columns, split.rows, "r-a", left.id, FIELD_TYPE.DATE);
    rows = setCellFieldControl(split.columns, rows, "r-a", right.id, FIELD_TYPE.TIME);
    const cells = rowCells(rows[0], split.columns.length);
    expect(cells.map((c) => c.type)).toEqual([FIELD_TYPE.DATE, FIELD_TYPE.TIME]);
    // The grid is untouched, and each cell keeps its own id.
    expect(cells[0].id).toBe(left.id);
    expect(cells[1].id).toBe(right.id);
    // ...and one of them can go back to flexible without disturbing the other.
    const back = setCellFieldControl(
      split.columns,
      rows,
      "r-a",
      right.id,
      DEFAULT_BUILDER_FIELD_TYPE
    );
    expect(rowCells(back[0], split.columns.length).map((c) => c.type)).toEqual([
      FIELD_TYPE.DATE,
      DEFAULT_BUILDER_FIELD_TYPE,
    ]);
  });

  test("13. a note renders a newly created control from the CELL's own type", () => {
    // The note's answer control switches on the cell view's type, which is the
    // stored one — so a control created today renders exactly like a historical
    // one, through the same untouched branch.
    expect(TABLE).toContain("function cellView(row, cell)");
    expect(TABLE).toContain("id: cell.id, type: cell.type, options: cell.options");
    const control = TABLE.slice(
      TABLE.indexOf("function renderAnswerControl(row)"),
      TABLE.indexOf("function renderBuilderCellStructure(row, cell)")
    );
    for (const t of ["NUMBER", "DATE", "TIME", "CHECKBOX", "YESNO", "SELECT"]) {
      expect(control).toContain(`FIELD_TYPE.${t}`);
    }
    // And it exports through the same structured path.
    const rows = setCellFieldControl(null, [flexibleRow()], "r-a", "r-a", FIELD_TYPE.DATE);
    const model = build({
      rows,
      instance: instanceWith({}, { answers: { "r-a": "2026-08-22" } }),
    });
    expect(unitsOf(model, "r-a")[0]).toEqual({
      type: EXPORT_UNIT.VALUE,
      text: "2026-08-22",
    });
  });

  test("15. a template nobody has touched still publishes no new version", () => {
    localStorage.clear();
    const tpl = createTemplate("Legacy", {
      leftPct: 18,
      rows: [
        { id: "h-text", label: "Notes", type: "text", px: 120, minPx: 100 },
        { id: "h-date", label: "Visit date", type: "date", px: 64, minPx: 48 },
      ],
    });
    const v1 = tpl.currentVersionId;
    const again = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      valueColumns: null,
      logoAssetId: null,
      logoSrc: null,
      branding: getVersion(v1).branding,
      rows: getVersion(v1).rows,
    });
    expect(again.id).toBe(v1);
    localStorage.clear();
  });
});

describe("A4c 16-17. files stay canonical, and Attach file is the same pipeline", () => {
  test("16. there is ONE file write sequence, and the Section injects into it", () => {
    const policy = read("lib/templateSectionToolbarFile.js");
    // The Template's own validator and asset kind...
    expect(policy).toContain("validateNoteFile(file)");
    expect(policy).toContain("createNoteFileAsset(blob, options?.metadata)");
    // ...injected into the SHARED sequence, which it does not reimplement.
    expect(policy).not.toContain("insertFileAttachment");
    expect(policy).not.toContain("IndexedDB");
    expect(policy).not.toMatch(/await |async /);
    expect(read("lib/editorFileInsert.js")).toContain(
      "export async function insertFreeformFileAttachment("
    );
  });

  test("16. Quick Add and the toolbar share ONE Section file validator", () => {
    expect(NOTE_DOC).toContain(
      'import { validateSectionFile as validateSectionFileShared } from "../../lib/templateSectionToolbarFile";'
    );
    expect(NOTE_DOC).not.toContain("const check = validateNoteFile(file);");
  });

  test("17. Attach file is a derived toolbar capability, like the image picker", () => {
    expect(TOOLBAR_CONTROL_KEYS).toContain("fileAttach");
    const capabilities = read("lib/editorCapabilities.js");
    expect(capabilities).toContain('allow("fileAttach", hasNode(editor, "fileAttachment"));');
    // Present when the owning editor has the shared node, absent when it does not
    // — the header's TYPOGRAPHY vocabulary has no file node, so its ribbon omits
    // the control entirely rather than greying it out.
    const withFile = { schema: { nodes: { fileAttachment: {} }, marks: {} }, commands: {} };
    const withoutFile = { schema: { nodes: { paragraph: {} }, marks: {} }, commands: {} };
    expect(toolbarControlsForEditor(withFile).has("fileAttach")).toBe(true);
    expect(toolbarControlsForEditor(withoutFile).has("fileAttach")).toBe(false);
  });

  test("17. the control inserts through the shared pipeline with the surface's policy", () => {
    const controls = read("components/editor/FormattingControls.js");
    expect(controls).toContain('{show("fileAttach") && (');
    expect(controls).toContain('aria-label="Attach a file from this device"');
    expect(controls).toContain("<FaPaperclip />");
    expect(controls).toContain("insertFreeformFileAttachment(");
    expect(controls).toContain("filePolicy?.insertDeps || undefined");
    expect(controls).toContain("filePolicy?.validateFile || validateEditorFileAttachment");
    // No second upload/storage implementation anywhere in the toolbar.
    expect(controls).not.toContain("createNoteFileAsset");
    expect(controls).not.toContain("createEditorFileAsset");
  });

  test("17. the Template Section supplies its own policy while it owns the toolbar", () => {
    const main = read("components/MainArea.js");
    expect(main).toContain("const toolbarFilePolicy =");
    expect(main).toContain("SECTION_TOOLBAR_FILE_POLICY");
    expect(main).toContain("filePolicy={toolbarFilePolicy}");
    expect(read("components/EditorToolbar.js")).toContain("filePolicy={filePolicy}");
  });
});
