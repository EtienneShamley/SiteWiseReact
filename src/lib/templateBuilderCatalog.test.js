// Phase 9 — the Template Builder's SIMPLIFIED type catalog.
//
// The Builder defines the STRUCTURE of the document, and the normal row is a
// SECTION: a flexible document area that may later hold text, images and files
// in any order. Photo and File are no longer offered as new field types,
// because photos and files are CONTENT added while completing a note.
//
// The two questions this file keeps apart, because the whole change rests on
// them being different:
//
//   - which types a STORED row may validly carry (unchanged — `FIELD_TYPES`,
//     `normalizeType`), so every pinned TemplateVersion keeps working;
//   - which types the Builder OFFERS when creating one (`BUILDER_FIELD_TYPES`).
//
// Mixed pure / storage / source-text assertions. Source text is used for the
// component facts for the reason documented in docs/TESTING.md and used by
// templateBuilderStyling.test.js and templateQuickAddWiring.test.js: there is
// no DOM testing library in this project, so source text is what can prove a
// control is genuinely wired to the catalog, and that a removed choice is
// genuinely gone rather than merely hidden.

import fs from "fs";
import path from "path";

import {
  FIELD_TYPE,
  FIELD_TYPES,
  BUILDER_FIELD_TYPES,
  DEFAULT_BUILDER_FIELD_TYPE,
  builderFieldTypeOptions,
  normalizeType,
  normalizeRow,
  normalizeRows,
  normalizeOptions,
  isAttachmentFieldType,
} from "./templateFields";
import { defaultRows, makeNewRow } from "../templates/defaultTwoColDoc";
import { appendRow, insertRowAt } from "./templateRowOps";
import {
  createTemplate,
  getVersion,
  getCurrentVersion,
  publishTemplateVersion,
} from "./templateModel";
import {
  planRowBlocks,
  ROW_BLOCK_KIND,
  sectionReplacesRowAnswer,
} from "./templateRowEvidence";
import { sectionItemsForRow } from "./templateSectionContent";
import { appendSectionText } from "./templateSectionText";
import {
  NEW_SECTION_PHOTO_WIDTH_PCT,
  sectionPhotoInsertIndex,
  sectionListWithNewPhoto,
} from "./templateSectionImagePlacement";
import {
  clampImageWidthPct,
  IMAGE_MAX_WIDTH_PCT,
} from "./templateSectionImageResize";
import { imagePointerZone, IMAGE_MOVE_ZONE } from "./templateSectionImageMove";
import { sectionExtraHeightFor, setSectionExtraHeight } from "./templateSectionHeight";
import { isRefinableRowType, rowRefineTargetKey } from "./templateRowRefine";
import {
  resolveQuickAddTarget,
  canQuickAddText,
  quickAddCapture,
  QUICK_ADD_KIND,
} from "./quickAddTarget";
import { NOTE_VIEW } from "./noteViews";
import { buildTemplateExportModel, EXPORT_UNIT } from "./templateExportModel";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

const TABLE = "components/template/ResizableTwoColTable.js";
const BUILDER_DOC = "components/template/TemplateBuilderDoc.js";
const FIELDS = "lib/templateFields.js";
const SCAFFOLD = "templates/defaultTwoColDoc.js";

const catalogValues = () => BUILDER_FIELD_TYPES.map((t) => t.value);
const catalogLabels = () => BUILDER_FIELD_TYPES.map((t) => t.label);

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// The Builder's own publish step, reproduced from TemplateBuilderDoc's
// handleSubmitTemplate so the version-content tests exercise the real shape a
// saved template gets. Pinned against the component's source below, so this
// helper cannot drift away from it silently.
function builderDefinitionRows(rows) {
  return rows.map((r) => {
    const type = normalizeType(r.type);
    const base = {
      id: r.id,
      label: r.label,
      px: r.px,
      minPx: r.minPx ?? 48,
      type,
    };
    if (type === FIELD_TYPE.SELECT) {
      base.options = (r.options || [])
        .filter((o) => String(o.value ?? "").trim() !== "")
        .map((o) => ({ id: o.id, value: o.value }));
    }
    return base;
  });
}

beforeEach(() => {
  localStorage.clear();
});

/* ------------------------------------------------------------------ */
/* 1. The creation catalog                                             */
/* ------------------------------------------------------------------ */

describe("the Builder creation catalog", () => {
  test("a new Template's default rows are Sections", () => {
    const rows = normalizeRows(defaultRows);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.type).toBe(FIELD_TYPE.TEXT);
      expect(row.type).toBe(DEFAULT_BUILDER_FIELD_TYPE);
    }
    // And "Section" is what that type is CALLED in the Builder.
    const entry = BUILDER_FIELD_TYPES.find((t) => t.value === FIELD_TYPE.TEXT);
    expect(entry.label).toBe("Section");
  });

  test("a newly added row defaults to Section", () => {
    const row = makeNewRow("Observations");
    expect(row.type).toBe(DEFAULT_BUILDER_FIELD_TYPE);
    expect(normalizeType(row.type)).toBe(FIELD_TYPE.TEXT);
    expect(isAttachmentFieldType(row.type)).toBe(false);
  });

  test("the default is the catalog's own first choice, so the two cannot drift", () => {
    expect(BUILDER_FIELD_TYPES[0].value).toBe(DEFAULT_BUILDER_FIELD_TYPE);
    expect(BUILDER_FIELD_TYPES[0].label).toBe("Section");
  });

  test("Section is offered in the normal type catalog", () => {
    expect(catalogLabels()).toContain("Section");
    expect(catalogValues()).toContain(FIELD_TYPE.TEXT);
  });

  test("there is no duplicate Text + Section choice", () => {
    expect(catalogLabels()).not.toContain("Text");
    // Exactly ONE entry resolves to the flexible stored type.
    const flexible = BUILDER_FIELD_TYPES.filter(
      (t) => normalizeType(t.value) === FIELD_TYPE.TEXT
    );
    expect(flexible).toHaveLength(1);
    // No two entries share a stored type at all.
    expect(new Set(catalogValues()).size).toBe(BUILDER_FIELD_TYPES.length);
  });

  test("Photo is NOT offered as a new field type", () => {
    expect(catalogValues()).not.toContain(FIELD_TYPE.PHOTO);
    expect(catalogLabels()).not.toContain("Photo");
    expect(builderFieldTypeOptions(FIELD_TYPE.TEXT).map((t) => t.value)).not.toContain(
      FIELD_TYPE.PHOTO
    );
  });

  test("File is NOT offered as a new field type", () => {
    expect(catalogValues()).not.toContain(FIELD_TYPE.FILE);
    expect(catalogLabels()).not.toContain("File");
    expect(builderFieldTypeOptions(FIELD_TYPE.TEXT).map((t) => t.value)).not.toContain(
      FIELD_TYPE.FILE
    );
  });

  test("no ordinary row's selector can create a Photo or File row", () => {
    for (const type of [
      FIELD_TYPE.TEXT,
      FIELD_TYPE.NUMBER,
      FIELD_TYPE.DATE,
      FIELD_TYPE.TIME,
      FIELD_TYPE.CHECKBOX,
      FIELD_TYPE.YESNO,
      FIELD_TYPE.SELECT,
      undefined,
      null,
      "multiline",
      "bogus",
    ]) {
      const values = builderFieldTypeOptions(normalizeType(type)).map((t) => t.value);
      expect(values).not.toContain(FIELD_TYPE.PHOTO);
      expect(values).not.toContain(FIELD_TYPE.FILE);
    }
  });

  test("Number is offered", () => expect(catalogValues()).toContain(FIELD_TYPE.NUMBER));
  test("Date is offered", () => expect(catalogValues()).toContain(FIELD_TYPE.DATE));
  test("Time is offered", () => expect(catalogValues()).toContain(FIELD_TYPE.TIME));
  test("Checkbox is offered", () =>
    expect(catalogValues()).toContain(FIELD_TYPE.CHECKBOX));
  test("Yes / No is offered", () => expect(catalogValues()).toContain(FIELD_TYPE.YESNO));
  test("Select is offered", () => expect(catalogValues()).toContain(FIELD_TYPE.SELECT));

  test("the catalog is exactly Section + the six structured types", () => {
    expect(catalogValues()).toEqual([
      FIELD_TYPE.TEXT,
      FIELD_TYPE.NUMBER,
      FIELD_TYPE.DATE,
      FIELD_TYPE.TIME,
      FIELD_TYPE.CHECKBOX,
      FIELD_TYPE.YESNO,
      FIELD_TYPE.SELECT,
    ]);
  });

  test("the Builder's selector reads the catalog, not the validity set", () => {
    const table = read(TABLE);
    expect(table).toContain("builderFieldTypeOptions(type).map(");
    expect(stripComments(table)).not.toMatch(/FIELD_TYPES\.map\(/);
    expect(table).toContain("builderFieldTypeOptions,");
  });
});

/* ------------------------------------------------------------------ */
/* 2. The persisted representation of a Section                        */
/* ------------------------------------------------------------------ */

describe("a Section's persisted representation", () => {
  test("a Section persists as the EXISTING flexible text type — no new row type", () => {
    const section = BUILDER_FIELD_TYPES.find((t) => t.label === "Section");
    expect(section.value).toBe(FIELD_TYPE.TEXT);
    expect(section.value).toBe("text");
    // Every offered value is already a valid stored type: the catalog narrows
    // the validity set, it never extends it.
    const valid = new Set(FIELD_TYPES.map((t) => t.value));
    for (const value of catalogValues()) expect(valid.has(value)).toBe(true);
  });

  test("no new stored type value was introduced anywhere", () => {
    expect(FIELD_TYPES.map((t) => t.value)).toEqual([
      "text",
      "number",
      "date",
      "time",
      "checkbox",
      "yesno",
      "select",
      "photo",
      "file",
    ]);
    expect(normalizeType("section")).toBe(FIELD_TYPE.TEXT);
  });

  test("a Section row needs no fixed height and carries no 120px reserve", () => {
    const row = makeNewRow("Observations");
    // The Builder never asks for a height: the row simply starts at its own
    // preferred px, which is nowhere near the legacy 120 fallback.
    expect(row.px).toBeLessThan(120);
    // And once the section has content, `row.px` is not a floor at all.
    const items = [{ id: "t1", kind: "text", value: "Hello" }];
    const blocks = planRowBlocks({
      row: { ...row, px: 400 },
      sectionContent: { [row.id]: items },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.SECTION_ITEM);
    expect(blocks[0].minHeight).toBeLessThan(400);
    expect(blocks[0].minHeight).toBeLessThan(120);
  });

  test("saving a Section writes a plain structural row and seeds NO content", () => {
    const rows = [makeNewRow("Observations")];
    const tpl = createTemplate("T", { leftPct: 18, rows: builderDefinitionRows(rows) });
    const version = getVersion(tpl.currentVersionId);

    expect(version.rows).toHaveLength(1);
    const stored = version.rows[0];
    expect(stored.type).toBe(FIELD_TYPE.TEXT);
    expect(Object.keys(stored).sort()).toEqual(["id", "label", "minPx", "px", "type"]);

    // No runtime content of any kind is seeded onto the version.
    expect(stored.sectionContent).toBeUndefined();
    expect(stored.items).toBeUndefined();
    expect(stored.answers).toBeUndefined();
    expect(stored.attachments).toBeUndefined();
    expect(version.sectionContent).toBeUndefined();
    const serialized = JSON.stringify(version);
    expect(serialized).not.toContain("sectionContent");
    expect(serialized).not.toContain("sectionExtraHeight");
  });

  test("a saved Section creates no Photo or File placeholder", () => {
    const rows = [makeNewRow("Observations")];
    const tpl = createTemplate("T", { leftPct: 18, rows: builderDefinitionRows(rows) });
    // Scoped to the ROWS: the version's branding legitimately carries the
    // template LOGO's own placement, which is not row content.
    const serialized = JSON.stringify(getVersion(tpl.currentVersionId).rows);
    expect(serialized).not.toContain('"photo"');
    expect(serialized).not.toContain('"file"');
    expect(serialized).not.toContain("assetId");
    expect(serialized).not.toContain("widthPct");
    expect(serialized).not.toContain("display");
  });

  test("a Section's label persists, and so does row order", () => {
    let rows = [makeNewRow("Observations"), makeNewRow("Work Completed")];
    rows = appendRow(rows, makeNewRow("Next Steps"));
    rows = insertRowAt(rows, rows[1].id, "below", makeNewRow("Issues"));

    const tpl = createTemplate("T", { leftPct: 18, rows: builderDefinitionRows(rows) });
    const stored = getVersion(tpl.currentVersionId).rows;
    expect(stored.map((r) => r.label)).toEqual([
      "Observations",
      "Work Completed",
      "Issues",
      "Next Steps",
    ]);
    expect(stored.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    // Read-time normalization preserves both.
    expect(normalizeRows(stored).map((r) => r.label)).toEqual([
      "Observations",
      "Work Completed",
      "Issues",
      "Next Steps",
    ]);
  });

  test("the immutable-version workflow is unchanged: publishing never rewrites a version", () => {
    const first = [makeNewRow("Observations")];
    const tpl = createTemplate("T", { leftPct: 18, rows: builderDefinitionRows(first) });
    const v1Id = tpl.currentVersionId;
    const v1 = JSON.parse(JSON.stringify(getVersion(v1Id)));

    const second = appendRow(first, makeNewRow("Issues"));
    const v2 = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: builderDefinitionRows(second),
    });

    expect(v2.id).not.toBe(v1Id);
    expect(getVersion(v1Id)).toEqual(v1);
    expect(getCurrentVersion(tpl.id).id).toBe(v2.id);
    expect(v2.rows).toHaveLength(2);
  });

  test("the Builder still publishes rather than writing storage itself", () => {
    const doc = stripComments(read(BUILDER_DOC));
    expect(doc).toContain("publishTemplateVersion(templateId, definition)");
    expect(doc).not.toMatch(/saveTemplateVersions|getTemplateVersions/);
    // The definition it publishes is the structural row shape this file's
    // helper reproduces — id/label/px/minPx/type, plus options for a dropdown.
    expect(doc).toContain("minPx: r.minPx ?? 48");
    expect(doc).toContain("type,");
    expect(doc).toContain("if (type === FIELD_TYPE.SELECT)");
    expect(doc).not.toMatch(/sectionContent|sectionExtraHeight|assetId:/);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Structured types                                                 */
/* ------------------------------------------------------------------ */

describe("structured types are unchanged", () => {
  const structured = [
    FIELD_TYPE.NUMBER,
    FIELD_TYPE.DATE,
    FIELD_TYPE.TIME,
    FIELD_TYPE.CHECKBOX,
    FIELD_TYPE.YESNO,
    FIELD_TYPE.SELECT,
  ];

  test.each(structured)("%s survives normalization and publishing unchanged", (type) => {
    const row = { ...makeNewRow("Field"), type };
    expect(normalizeRow(row, 0).type).toBe(type);
    const tpl = createTemplate("T", {
      leftPct: 18,
      rows: builderDefinitionRows([row]),
    });
    expect(getVersion(tpl.currentVersionId).rows[0].type).toBe(type);
  });

  test.each(structured)("%s keeps its own primary control above section content", (type) => {
    const row = { ...makeNewRow("Field"), type };
    expect(sectionReplacesRowAnswer(type)).toBe(false);
    const blocks = planRowBlocks({
      row,
      sectionContent: {
        [row.id]: [{ id: "t1", kind: "text", value: "Supplementary" }],
      },
    });
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(blocks[1].kind).toBe(ROW_BLOCK_KIND.SECTION_ITEM);
  });

  test("Select option configuration is preserved end to end", () => {
    const row = {
      ...makeNewRow("Condition"),
      type: FIELD_TYPE.SELECT,
      options: [
        { id: "o1", value: "Good" },
        { id: "o2", value: "Fair" },
        { id: "o3", value: "   " }, // blank values are dropped, as before
        { id: "o4", value: "Poor" },
      ],
    };
    const tpl = createTemplate("T", { leftPct: 18, rows: builderDefinitionRows([row]) });
    const stored = getVersion(tpl.currentVersionId).rows[0];
    expect(stored.options).toEqual([
      { id: "o1", value: "Good" },
      { id: "o2", value: "Fair" },
      { id: "o4", value: "Poor" },
    ]);
    expect(normalizeOptions(stored.options).map((o) => o.value)).toEqual([
      "Good",
      "Fair",
      "Poor",
    ]);
  });

  test("a structured row does not restrict supplementary section content", () => {
    const row = { ...makeNewRow("Inspection Date"), type: FIELD_TYPE.DATE };
    const items = [
      { id: "t1", kind: "text", value: "Explanatory text" },
      {
        id: "p1",
        kind: "photo",
        assetId: "a1",
        name: "p.jpg",
        mimeType: "image/jpeg",
        size: 1,
        createdAt: 1,
        display: { widthPct: 100, alignment: "left" },
      },
    ];
    const blocks = planRowBlocks({ row, sectionContent: { [row.id]: items } });
    expect(blocks.map((b) => b.kind)).toEqual([
      ROW_BLOCK_KIND.ROW,
      ROW_BLOCK_KIND.SECTION_ITEM,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    // And Quick Add accepts every selected Template row regardless of type.
    const target = resolveQuickAddTarget({
      hasNote: true,
      view: NOTE_VIEW.TEMPLATE_FORM,
      rowId: row.id,
      rowFieldType: FIELD_TYPE.DATE,
    });
    expect(target.kind).toBe(QUICK_ADD_KIND.TEMPLATE_ROW);
    expect(canQuickAddText(target)).toBe(true);
    expect(quickAddCapture(target)).toEqual({ image: true, file: true, reason: null });
  });

  test("the Builder still renders the dropdown option editor", () => {
    const table = read(TABLE);
    expect(table).toContain("type === FIELD_TYPE.SELECT && (");
    expect(table).toContain("Dropdown options");
    expect(table).toContain("Add option");
    expect(table).toContain("handleOptionAdd(row)");
    expect(table).toContain("handleOptionRename(row, o.id, e.target.value)");
    expect(table).toContain("handleOptionDelete(row, o.id)");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Legacy Photo / File compatibility                                */
/* ------------------------------------------------------------------ */

describe("legacy Photo / File rows", () => {
  const legacyRows = () => [
    { id: "p1", label: "Site Photos", type: "photo", px: 220, minPx: 100 },
    { id: "f1", label: "Attachments", type: "file", px: 180, minPx: 90 },
    { id: "t1", label: "Notes", type: "text", px: 64, minPx: 48 },
  ];

  test("an existing legacy Photo row loads with its type intact", () => {
    const row = normalizeRow(legacyRows()[0], 0);
    expect(row.type).toBe(FIELD_TYPE.PHOTO);
    expect(row.id).toBe("p1");
    expect(row.label).toBe("Site Photos");
  });

  test("an existing legacy File row loads with its type intact", () => {
    const row = normalizeRow(legacyRows()[1], 1);
    expect(row.type).toBe(FIELD_TYPE.FILE);
    expect(row.id).toBe("f1");
  });

  test("a legacy Photo row is NOT auto-converted to a Section", () => {
    const loaded = normalizeRows(legacyRows());
    expect(loaded[0].type).toBe(FIELD_TYPE.PHOTO);
    // Its own selector still shows it, so nothing changes just by being opened.
    const values = builderFieldTypeOptions(loaded[0].type).map((t) => t.value);
    expect(values).toContain(FIELD_TYPE.PHOTO);
    expect(values).not.toContain(FIELD_TYPE.FILE);
    const entry = builderFieldTypeOptions(FIELD_TYPE.PHOTO).find(
      (t) => t.value === FIELD_TYPE.PHOTO
    );
    expect(entry.label).toBe("Photo (legacy)");
  });

  test("a legacy File row is NOT auto-converted to a Section", () => {
    const loaded = normalizeRows(legacyRows());
    expect(loaded[1].type).toBe(FIELD_TYPE.FILE);
    const values = builderFieldTypeOptions(loaded[1].type).map((t) => t.value);
    expect(values).toContain(FIELD_TYPE.FILE);
    expect(values).not.toContain(FIELD_TYPE.PHOTO);
    const entry = builderFieldTypeOptions(FIELD_TYPE.FILE).find(
      (t) => t.value === FIELD_TYPE.FILE
    );
    expect(entry.label).toBe("File (legacy)");
  });

  test("the legacy entry is added ONLY for the row that already has that type", () => {
    expect(builderFieldTypeOptions(FIELD_TYPE.TEXT)).toBe(BUILDER_FIELD_TYPES);
    expect(builderFieldTypeOptions(FIELD_TYPE.PHOTO)).toHaveLength(
      BUILDER_FIELD_TYPES.length + 1
    );
    expect(builderFieldTypeOptions(FIELD_TYPE.FILE)).toHaveLength(
      BUILDER_FIELD_TYPES.length + 1
    );
    // The shared catalog array itself is never mutated.
    expect(BUILDER_FIELD_TYPES).toHaveLength(7);
  });

  test("a legacy row's px is preserved on load and on re-publish", () => {
    const tpl = createTemplate("Old", { leftPct: 18, rows: legacyRows() });
    const loaded = normalizeRows(getVersion(tpl.currentVersionId).rows);
    expect(loaded.map((r) => r.px)).toEqual([220, 180, 64]);

    // Saving the template again (adding an unrelated Section) keeps them.
    const next = appendRow(loaded, makeNewRow("Observations"));
    const v2 = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: builderDefinitionRows(next),
    });
    expect(v2.rows.map((r) => r.px)).toEqual([220, 180, 64, 64]);
    expect(v2.rows.map((r) => r.type)).toEqual(["photo", "file", "text", "text"]);
  });

  test("the OLD version is not mutated when a new one is published", () => {
    const tpl = createTemplate("Old", { leftPct: 18, rows: legacyRows() });
    const v1Id = tpl.currentVersionId;
    const before = JSON.parse(JSON.stringify(getVersion(v1Id)));

    // Open in the Builder (read-time normalization) and publish a new version.
    const loaded = normalizeRows(getVersion(v1Id).rows);
    publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: builderDefinitionRows(appendRow(loaded, makeNewRow("Observations"))),
    });

    expect(getVersion(v1Id)).toEqual(before);
    expect(getVersion(v1Id).rows[0].type).toBe("photo");
    expect(getVersion(v1Id).rows[1].type).toBe("file");
  });

  test("legacy Photo/File rendering is unchanged: primary attachments first", () => {
    const row = { id: "p1", label: "Site Photos", type: "photo", px: 220 };
    const attachments = {
      p1: [
        {
          id: "a1",
          kind: "photo",
          assetId: "asset-1",
          name: "p.jpg",
          mimeType: "image/jpeg",
          size: 1,
          createdAt: 1,
          display: { widthPct: 60, alignment: "left" },
        },
      ],
    };
    const blocks = planRowBlocks({ row, isAttachmentField: true, attachments });
    expect(blocks.map((b) => b.kind)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
    ]);
    expect(sectionReplacesRowAnswer(FIELD_TYPE.PHOTO, true)).toBe(false);
    // The Builder's own Photo/File explanatory placeholder is still there for
    // a legacy row, so an old template reads the same as it did.
    expect(read(TABLE)).toContain("Photos can be added when completing this note.");
    expect(read(TABLE)).toContain("Files can be added when completing this note.");
  });

  test("a malformed or unknown legacy type does not break the Builder", () => {
    const rows = normalizeRows([
      { id: "x", label: "Odd", type: "sasquatch" },
      { id: "y", label: "Older", type: "multiline" },
      { id: "z", label: "Oldest" },
      { label: "No id" },
      null,
    ]);
    expect(rows.map((r) => r.type)).toEqual(["text", "text", "text", "text", "text"]);
    expect(rows[3].id).toBe("row-3");
    expect(rows[4].id).toBe("row-4");
    for (const row of rows) {
      // Every one of them resolves to a real, offerable catalog entry, so the
      // selector always has a matching option and never renders blank.
      const values = builderFieldTypeOptions(row.type).map((t) => t.value);
      expect(values).toContain(row.type);
    }
  });

  test("an old pinned version stays usable: its rows still plan and export", () => {
    const version = { id: "v1", rows: legacyRows(), branding: null, leftPct: 18 };
    const instance = {
      noteId: "n1",
      templateId: "t1",
      templateVersionId: "v1",
      answers: { t1: "Legacy answer" },
      attachments: {},
      customRows: [],
    };
    const model = buildTemplateExportModel({
      noteId: "n1",
      noteTitle: "Note",
      instance,
      template: { id: "t1", name: "Old" },
      version,
      assets: {},
    });
    expect(model).not.toBeNull();
    expect(model.rows.map((r) => r.label)).toEqual([
      "Site Photos",
      "Attachments",
      "Notes",
    ]);
    const notes = model.rows.find((r) => r.label === "Notes");
    expect(notes.units.some((u) => u.type === EXPORT_UNIT.BLOCK)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5. No Section sizing or image presets in the Builder                */
/* ------------------------------------------------------------------ */

describe("the Builder configures no Section size and no image size", () => {
  const builderSources = () => stripComments(read(TABLE) + read(BUILDER_DOC));

  test.each(["Small", "Normal", "Large", "Full Width", "Full width"])(
    "there is no %s section preset in the Builder",
    (preset) => {
      const source = builderSources();
      const hits = source.split("\n").filter((line) => line.includes(preset));
      expect(hits).toEqual([]);
    }
  );

  test("there is no image size preset anywhere in the Builder", () => {
    const source = builderSources();
    expect(source).not.toMatch(/sizePreset|SIZE_PRESET|widthPct:\s*\d/);
    // The Builder passes no photo display callback at all, so no size control
    // can be reached from it.
    const doc = read(BUILDER_DOC);
    expect(doc).not.toContain("onUpdateAttachmentDisplay");
    expect(doc).not.toContain("onUpdateEvidenceDisplay");
    expect(doc).not.toContain("onResizeSectionPhoto");
  });

  test("image width belongs to the note instance, never to the Template version", () => {
    expect(NEW_SECTION_PHOTO_WIDTH_PCT).toBe(100);
    expect(clampImageWidthPct(NEW_SECTION_PHOTO_WIDTH_PCT)).toBe(100);
    expect(IMAGE_MAX_WIDTH_PCT).toBe(100);
    expect(read(BUILDER_DOC)).not.toContain("widthPct");
    expect(read(FIELDS)).not.toContain("widthPct");
  });

  test("no Photo-specific or File-specific configuration exists for a NEW row", () => {
    const doc = read(BUILDER_DOC);
    expect(doc).not.toContain("FIELD_TYPE.PHOTO");
    expect(doc).not.toContain("FIELD_TYPE.FILE");
    expect(doc).not.toContain("enableRightEditor");
    expect(doc).not.toContain("attachments=");
    expect(doc).not.toContain("sectionContent=");
    // makeNewRow mints a structural row only — no attachment configuration.
    expect(Object.keys(makeNewRow("X")).sort()).toEqual([
      "id",
      "label",
      "minPx",
      "px",
      "type",
    ]);
  });

  test("the row-height handle is RETAINED — it sizes legacy and structured rows", () => {
    // It is not a Section concept: a section that owns its body is
    // content-driven and ignores `row.px` entirely (asserted above). The handle
    // still governs every row whose body is its own control, which is where the
    // user actually dragged it, so it is deliberately not removed.
    const table = read(TABLE);
    expect(table).toContain("twocol-resize-handle");
    expect(table).toContain("startRowDrag(row, e)");
    expect(table).toContain("Drag row borders to adjust height");
    expect(read(BUILDER_DOC)).toContain("onRowHeightChange={changeRowHeight}");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Runtime integration — one flexible path, not a second one        */
/* ------------------------------------------------------------------ */

describe("a new Section uses the EXISTING flexible runtime path", () => {
  const newSection = () => makeNewRow("Observations");

  test("a Section row is the flexible body owner the runtime already knows", () => {
    const row = newSection();
    expect(sectionReplacesRowAnswer(row.type)).toBe(true);
    expect(isRefinableRowType(row.type)).toBe(true);
  });

  test("section content materialises into a Section through the shared writer", () => {
    const row = newSection();
    const stored = { [row.id]: [] };
    const result = appendSectionText({
      rowId: row.id,
      value: "First paragraph.",
      materialisation: { answer: "", evidence: null },
      deps: {
        readSectionList: (id) => stored[id] || [],
        persist: (id, items) => {
          stored[id] = items;
        },
        onStructuralChange: () => {},
      },
    });
    expect(result.ok).toBe(true);
    const items = sectionItemsForRow(stored, row.id);
    expect(items.map((i) => i.kind)).toEqual(["text", "text"]);
    expect(items[items.length - 1].value).toBe("First paragraph.");

    // It renders through the ordinary section plan — one block per item.
    const blocks = planRowBlocks({ row, sectionContent: stored });
    expect(blocks.every((b) => b.kind === ROW_BLOCK_KIND.SECTION_ITEM)).toBe(true);
    expect(blocks[0].isRowHead).toBe(true);
    expect(blocks[0].id).toBe(row.id);
  });

  test("Quick Add can target a Section", () => {
    const row = newSection();
    const target = resolveQuickAddTarget({
      hasNote: true,
      view: NOTE_VIEW.TEMPLATE_FORM,
      rowId: row.id,
      rowLabel: row.label,
      rowFieldType: row.type,
    });
    expect(target.kind).toBe(QUICK_ADD_KIND.TEMPLATE_ROW);
    expect(target.rowId).toBe(row.id);
    expect(canQuickAddText(target)).toBe(true);
    expect(quickAddCapture(target).image).toBe(true);
    expect(quickAddCapture(target).file).toBe(true);
  });

  test("a new photo uses the existing default placement and 100% width", () => {
    const photo = {
      id: "p1",
      kind: "photo",
      assetId: "a1",
      name: "p.jpg",
      mimeType: "image/jpeg",
      size: 1,
      createdAt: 1,
      display: { widthPct: NEW_SECTION_PHOTO_WIDTH_PCT, alignment: "left" },
    };
    // No meaningful text yet -> top of the section.
    expect(sectionPhotoInsertIndex([])).toBe(0);
    expect(sectionPhotoInsertIndex([{ id: "t1", kind: "text", value: "" }])).toBe(0);
    // After the first meaningful paragraph otherwise.
    const withText = [
      { id: "t1", kind: "text", value: "Meaningful." },
      { id: "t2", kind: "text", value: "More." },
    ];
    expect(sectionPhotoInsertIndex(withText)).toBe(1);
    const placed = sectionListWithNewPhoto(withText, photo);
    expect(placed.map((i) => i.id)).toEqual(["t1", "p1", "t2"]);
    expect(placed[1].display.widthPct).toBe(100);
  });

  test("file insertion, image movement and image resizing are unchanged", () => {
    // File items are ordinary section items in the same list.
    const list = [
      { id: "t1", kind: "text", value: "A" },
      {
        id: "f1",
        kind: "file",
        assetId: "a2",
        name: "doc.pdf",
        mimeType: "application/pdf",
        size: 2,
        createdAt: 2,
      },
    ];
    const row = newSection();
    const blocks = planRowBlocks({ row, sectionContent: { [row.id]: list } });
    expect(blocks.map((b) => b.sectionItem.kind)).toEqual(["text", "file"]);

    // The move/resize gesture rules are the same module the runtime already
    // uses — nothing about them is per-row-type.
    const rect = { left: 0, top: 0, width: 200, height: 200 };
    expect(imagePointerZone({ rect, clientX: 100, clientY: 100 })).toBe(
      IMAGE_MOVE_ZONE.BODY
    );
    expect(imagePointerZone({ rect, clientX: 199, clientY: 199 })).toBe(
      IMAGE_MOVE_ZONE.CORNER
    );
    expect(clampImageWidthPct(140)).toBe(100);
  });

  test("Refine targets a section TEXT item, addressed by rowId + itemId", () => {
    const row = newSection();
    expect(rowRefineTargetKey({ rowId: row.id })).toBe(row.id);
    expect(rowRefineTargetKey({ rowId: row.id, itemId: "i1" })).toContain(row.id);
    expect(rowRefineTargetKey({ rowId: row.id, itemId: "i1" })).not.toBe(row.id);
  });

  test("ordered export recognises a Section and emits its items in order", () => {
    const row = newSection();
    const version = {
      id: "v1",
      leftPct: 18,
      branding: null,
      rows: builderDefinitionRows([row]),
    };
    const instance = {
      noteId: "n1",
      templateId: "t1",
      templateVersionId: "v1",
      answers: { [row.id]: "frozen legacy answer" },
      attachments: {},
      customRows: [],
      sectionContent: {
        [row.id]: [
          { id: "s1", kind: "text", value: "First." },
          {
            id: "s2",
            kind: "file",
            assetId: "a2",
            name: "doc.pdf",
            mimeType: "application/pdf",
            size: 2,
            createdAt: 2,
          },
          { id: "s3", kind: "text", value: "Second." },
        ],
      },
    };
    const model = buildTemplateExportModel({
      noteId: "n1",
      noteTitle: "Note",
      instance,
      template: { id: "t1", name: "T" },
      version,
      assets: {},
    });
    const units = model.rows[0].units;
    expect(units.map((u) => u.type)).toEqual([
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.FILE,
      EXPORT_UNIT.BLOCK,
    ]);
    // The frozen legacy answer is not exported as well.
    expect(JSON.stringify(units)).not.toContain("frozen legacy answer");
  });

  test("sectionExtraHeight stays note-instance state, never a Template value", () => {
    const row = newSection();
    const map = setSectionExtraHeight({}, row.id, 80);
    expect(sectionExtraHeightFor(map, row.id)).toBe(80);
    // Nothing in the Builder or the field catalog knows about it.
    expect(read(BUILDER_DOC)).not.toContain("sectionExtraHeight");
    expect(read(FIELDS)).not.toContain("sectionExtraHeight");
    expect(read(SCAFFOLD)).not.toContain("sectionExtraHeight:");
  });

  test("runtime content never reaches the TemplateVersion", () => {
    const rows = [makeNewRow("Observations")];
    const tpl = createTemplate("T", { leftPct: 18, rows: builderDefinitionRows(rows) });
    const before = JSON.parse(JSON.stringify(getVersion(tpl.currentVersionId)));

    // Everything a note does happens on its own instance object.
    const stored = { [rows[0].id]: [] };
    appendSectionText({
      rowId: rows[0].id,
      value: "Typed while completing the note.",
      materialisation: { answer: "", evidence: null },
      deps: {
        readSectionList: (id) => stored[id] || [],
        persist: (id, items) => {
          stored[id] = items;
        },
        onStructuralChange: () => {},
      },
    });
    expect(getVersion(tpl.currentVersionId)).toEqual(before);
  });

  test("there is no second runtime path for a Section", () => {
    const table = stripComments(read(TABLE));
    // "Section" is a NAME in the Builder, not a new stored type and not a new
    // branch: no FIELD_TYPE.SECTION exists, and the runtime still dispatches on
    // the one SECTION_ITEM block kind Phases 1-8 built.
    expect(table).not.toMatch(/FIELD_TYPE\.SECTION\b/);
    expect(stripComments(read(FIELDS))).not.toMatch(/SECTION:\s*["']section["']/);
    expect(FIELD_TYPE.SECTION).toBeUndefined();
    expect(table.match(/case ROW_BLOCK_KIND\.SECTION_ITEM:/g)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Nothing else moved                                               */
/* ------------------------------------------------------------------ */

describe("nothing outside the Builder catalog changed", () => {
  test("existing custom-row notes remain readable, with no migration", () => {
    // A custom row is a note-specific row; the Builder has no part in it and
    // this change adds no migration of any kind.
    const doc = stripComments(read(BUILDER_DOC));
    expect(doc).not.toContain("customRows");
    expect(doc).not.toMatch(/migrate/i);
    expect(stripComments(read(FIELDS))).not.toContain("customRows");
    // A custom row is always the flexible type, so it IS a Section already.
    expect(sectionReplacesRowAnswer(FIELD_TYPE.TEXT)).toBe(true);
  });

  test("no migration, no schema bump, no version rewrite was introduced", () => {
    const changed = [FIELDS, SCAFFOLD, TABLE, BUILDER_DOC].map(read).join("\n");
    expect(changed).not.toMatch(/migrateRows|migrateTemplate|schemaVersion/);
    expect(changed).not.toMatch(/localStorage\.setItem/);
  });

  test("Free-form behaviour, evidence and asset storage are untouched", () => {
    const changed = stripComments(
      [FIELDS, SCAFFOLD, BUILDER_DOC].map(read).join("\n")
    );
    // No evidence collection is read, written or cleaned up from here.
    expect(changed).not.toMatch(/evidence/i);
    expect(changed).not.toContain("NOTE_VIEW.FREEFORM");
    expect(changed).not.toContain("deleteAssetsFor");
    // The Builder's only asset concern is still the template LOGO, unchanged.
    expect(read(BUILDER_DOC)).toContain("createLogoAsset");
    expect(read(BUILDER_DOC)).toContain("isLogoAssetReferenced");
  });

  test("the validity set is still complete, so no stored row can be orphaned", () => {
    for (const t of FIELD_TYPES) expect(normalizeType(t.value)).toBe(t.value);
    expect(isAttachmentFieldType(FIELD_TYPE.PHOTO)).toBe(true);
    expect(isAttachmentFieldType(FIELD_TYPE.FILE)).toBe(true);
  });
});
