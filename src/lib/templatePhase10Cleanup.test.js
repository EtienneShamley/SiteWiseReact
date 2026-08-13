// src/lib/templatePhase10Cleanup.test.js
//
// PHASE 10 — legacy evidence cleanup and final architecture consolidation.
//
// This suite exists to pin the ONE thing a removal phase can get wrong: taking
// away the ability to read somebody's old note while taking away a write path
// nothing could reach. So it is deliberately split in two halves that pull in
// opposite directions —
//
//   LEGACY MUST STILL WORK   an old note's `evidence[rowId]` renders, keeps its
//                            stored order, survives malformed neighbours, and
//                            still protects its IndexedDB Blob from deletion.
//
//   NEW WRITES MUST NOT      no modern user path creates a new `evidence`
//                            entry, and the three Template registrations that
//                            used to (text -> `answers`, capture -> primary
//                            `attachments`, capture -> `evidence`) are gone.
//
// Behavioural facts are proved against the pure planner, the section writers
// and the REAL localStorage-backed asset gate. Component-level facts — "this
// handler no longer exists and nothing calls it" — are proved by source-text
// assertion, which is the established convention here because the project has
// no DOM testing library (docs/TESTING.md, and see templateQuickAddWiring.test.js).

import fs from "fs";
import path from "path";

import {
  ROW_BLOCK_KIND,
  planRowBlocks,
  rowEvidenceItems,
  hasRowEvidence,
} from "./templateRowContent";
import { FIELD_TYPE, builderFieldTypeOptions } from "./templateFields";
import {
  isAttachmentAssetReferenced,
  saveNoteTemplateInstanceOrThrow,
  getNoteTemplateInstance,
} from "./templateModel";
import {
  isRefineTargetKeyForRow,
  refineTargetKeysWithBackup,
  rowRefineTargetKey,
  clearRowRefineBackup,
} from "./templateRowRefine";
import { appendSectionText } from "./templateSectionText";
import { appendSectionAttachment } from "./templateSectionAttachments";
import {
  EXPORT_UNIT,
  buildTemplateExportModel,
  collectTemplateExportAssetRefs,
} from "./templateExportModel";

/* -------------------------------------------------------------------------- */
/* Source access                                                              */
/* -------------------------------------------------------------------------- */

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(SRC, relative));

// Comment prose necessarily describes what was removed and why; the checks
// below look at CODE only.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const mainAreaSource = read("components/MainArea.js");
const mainArea = withoutComments(mainAreaSource);
const templateDocSource = read("components/template/NoteTemplateDoc.js");
const templateDoc = withoutComments(templateDocSource);
const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
const photoAttachment = withoutComments(read("components/template/PhotoAttachment.js"));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ROW = "row-1";

const photoRef = (id, assetId, over = {}) => ({
  id,
  kind: "photo",
  assetId,
  name: `${id}.jpg`,
  mimeType: "image/jpeg",
  size: 120,
  createdAt: 7,
  intrinsicWidth: 800,
  intrinsicHeight: 400,
  display: { widthPct: 60, alignment: "left" },
  ...over,
});

const fileRef = (id, assetId, over = {}) => ({
  id,
  kind: "file",
  assetId,
  name: `${id}.pdf`,
  mimeType: "application/pdf",
  size: 900,
  createdAt: 8,
  ...over,
});

const textItem = (id, value) => ({ id, kind: "text", value });

const makeRow = (over = {}) => ({
  id: ROW,
  label: "Observations",
  px: 120,
  type: FIELD_TYPE.TEXT,
  ...over,
});

const kinds = (blocks) => blocks.map((b) => b.kind);

/* ========================================================================== */
/* 1. LEGACY READ — an old note still renders                                 */
/* ========================================================================== */

describe("legacy evidence still renders (read compatibility)", () => {
  test("1. an old TEXT row with an answer AND an evidence photo keeps both blocks", () => {
    const blocks = planRowBlocks({
      row: makeRow(),
      evidence: { [ROW]: [photoRef("e1", "a1")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.EVIDENCE]);
    // The answer control is still the row head, and it still keeps the photo
    // with it across a page boundary.
    expect(blocks[0].keepWithNext).toBe(true);
    expect(blocks[0].minHeight).toBe(120);
    expect(blocks[1].item.norm.assetId).toBe("a1");
  });

  test("2. an old row with an answer AND an evidence FILE keeps both blocks", () => {
    const blocks = planRowBlocks({
      row: makeRow(),
      evidence: { [ROW]: [fileRef("e1", "a-file")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.EVIDENCE]);
    expect(blocks[1].item.norm.kind).toBe("file");
  });

  test("3. an EVIDENCE-ONLY legacy row still renders its evidence", () => {
    const blocks = planRowBlocks({
      row: makeRow(),
      // No answer at all, and no section content.
      evidence: { [ROW]: [photoRef("e1", "a1")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.EVIDENCE]);
    // A row whose evidence is its only attachment content gets no heading.
    expect(blocks[1].showEvidenceLabel).toBe(false);
  });

  test("4. multiple legacy evidence items keep their STORED order", () => {
    const blocks = planRowBlocks({
      row: makeRow(),
      evidence: {
        [ROW]: [photoRef("e1", "a1"), fileRef("e2", "a2"), photoRef("e3", "a3")],
      },
    });
    const evidence = blocks.filter((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE);
    // Photos are never regrouped ahead of files.
    expect(evidence.map((b) => b.item.norm.assetId)).toEqual(["a1", "a2", "a3"]);
  });

  test("5. legacy evidence on a note-specific CUSTOM row renders the same way", () => {
    const blocks = planRowBlocks({
      row: makeRow({ id: "custom-9", isCustom: true, type: undefined }),
      evidence: { "custom-9": [photoRef("e1", "a1")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.EVIDENCE]);
  });

  test("6. malformed legacy evidence is skipped without crashing, and the good entries survive", () => {
    const evidence = {
      [ROW]: [
        null,
        "data:image/png;base64,AAAA", // a legacy base64 STRING is not evidence
        { nonsense: true },
        photoRef("e-good", "a-good"),
        42,
      ],
    };
    expect(() => planRowBlocks({ row: makeRow(), evidence })).not.toThrow();
    const blocks = planRowBlocks({ row: makeRow(), evidence });
    const rendered = blocks.filter((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].item.norm.assetId).toBe("a-good");
    // The malformed entries stay exactly where they are in storage.
    expect(evidence[ROW]).toHaveLength(5);

    // A malformed CONTAINER is tolerated too.
    expect(rowEvidenceItems(null, ROW)).toEqual([]);
    expect(rowEvidenceItems([], ROW)).toEqual([]);
    expect(rowEvidenceItems({ [ROW]: "nope" }, ROW)).toEqual([]);
    expect(hasRowEvidence({ [ROW]: [] }, ROW)).toBe(false);
  });

  test("7. legacy base64 compatibility is retained where it is currently supported", () => {
    // On a legacy PHOTO field, a raw base64 string in `attachments` is still an
    // attachment block — that is the collection the base64 history belongs to.
    const blocks = planRowBlocks({
      row: makeRow({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { [ROW]: ["data:image/png;base64,AAAA"] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
    ]);
    expect(blocks[1].id).toBe(`${ROW}::att-legacy-0`);

    // And a non-attachment row's migrated base64 strip is still rendered by the
    // table, from `attachments`, above the row's own control.
    expect(table).toMatch(/legacyItems\.length > 0/);
    expect(table).toMatch(/typeof item\.norm === "string"/);
  });
});

/* ========================================================================== */
/* 2. AUTHORITY — sectionContent wins, and nothing renders twice               */
/* ========================================================================== */

describe("section content authority is unchanged", () => {
  test("8. authoritative sectionContent suppresses the legacy answer AND the legacy evidence", () => {
    const blocks = planRowBlocks({
      row: makeRow(),
      evidence: { [ROW]: [photoRef("e1", "a-frozen")] },
      sectionContent: { [ROW]: [textItem("t1", "Live text")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.SECTION_ITEM]);
    expect(blocks.some((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE)).toBe(false);
    // The head item IS the row block: same id, so no editor is torn down.
    expect(blocks[0].id).toBe(ROW);
    expect(blocks[0].isRowHead).toBe(true);
  });

  test("9. a modern Text + Photo + File section plans one block per item, in order", () => {
    const blocks = planRowBlocks({
      row: makeRow(),
      sectionContent: {
        [ROW]: [
          textItem("t1", "Intro"),
          photoRef("p1", "a-p"),
          textItem("t2", "Middle"),
          fileRef("f1", "a-f"),
        ],
      },
    });
    expect(kinds(blocks)).toEqual(Array(4).fill(ROW_BLOCK_KIND.SECTION_ITEM));
    expect(blocks.map((b) => b.sectionItem.id)).toEqual(["t1", "p1", "t2", "f1"]);
    expect(blocks.every((b) => b.group === ROW)).toBe(true);
  });

  test("10. a STRUCTURED row keeps its typed control first, then the ordered items", () => {
    const blocks = planRowBlocks({
      row: makeRow({ type: FIELD_TYPE.DATE }),
      evidence: { [ROW]: [photoRef("e1", "a-frozen")] },
      sectionContent: { [ROW]: [textItem("t1", "Note about the date")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ROW,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    // Its own control keeps the row's stored height; the item does not.
    expect(blocks[0].minHeight).toBe(120);
    expect(blocks[1].isRowHead).toBe(false);
  });

  test("11. a legacy Photo/File row keeps its PRIMARY attachments first, then the ordered items", () => {
    const blocks = planRowBlocks({
      row: makeRow({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { [ROW]: [photoRef("primary", "a-primary")] },
      evidence: { [ROW]: [photoRef("e1", "a-frozen")] },
      sectionContent: { [ROW]: [photoRef("s1", "a-section")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    expect(blocks[1].item.norm.assetId).toBe("a-primary");
    expect(blocks[2].sectionItem.assetId).toBe("a-section");
  });
});

/* ========================================================================== */
/* 3. NEW WRITES — everything lands in sectionContent                          */
/* ========================================================================== */

describe("every modern write targets sectionContent", () => {
  const persistedOnce = () => {
    const calls = [];
    return {
      calls,
      deps: {
        readSectionList: () => [],
        persist: (rowId, items) => calls.push({ rowId, items }),
        onStructuralChange: () => {},
      },
    };
  };

  test("12+13. the Quick Add composer is the ONLY Template attachment destination", () => {
    // MainArea captures the destination once and delivers through the composer.
    expect(mainArea).toMatch(/compose\.appendAttachment\(rowId, \{/);
    expect(mainArea).toMatch(/compose\.appendText\(rowId, value\)/);
    // …and NoteTemplateDoc's composer routes both through the section writers.
    expect(templateDoc).toMatch(/appendAttachment:\s*appendComposedAttachment/);
    expect(templateDoc).toMatch(/appendText:\s*appendComposedText/);
    expect(templateDoc).toMatch(/await appendSectionAttachment\(\{/);
    expect(templateDoc).toMatch(/appendSectionText\(\{/);
  });

  test("14+15. the section attachment writer persists sectionContent and never touches evidence", async () => {
    const env = persistedOnce();
    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "file",
      file: { name: "d.pdf", type: "application/pdf", size: 10 },
      materialisation: null,
      deps: {
        ...env.deps,
        validateFile: () => ({ ok: true }),
        createAsset: async () => "asset-new",
        canDeleteAsset: () => false,
        deleteAsset: async () => {},
      },
    });
    expect(result.ok).toBe(true);
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0].rowId).toBe(ROW);
    expect(env.calls[0].items).toHaveLength(1);
    expect(env.calls[0].items[0].kind).toBe("file");

    // The writer's own source names no evidence collection at all.
    const writer = withoutComments(read("lib/templateSectionAttachments.js"));
    expect(writer).not.toMatch(/persistEvidence|rowEvidenceRef|instance\.evidence/);
  });

  test("16. text materialisation writes sectionContent, and READS the legacy answer/evidence only", () => {
    const carried = [];
    const outcome = appendSectionText({
      rowId: ROW,
      value: "A Quick Add sentence",
      materialisation: {
        answer: "Frozen legacy answer",
        evidence: [photoRef("e1", "a-frozen")],
      },
      deps: {
        readSectionList: () => [],
        persist: (rowId, items) => carried.push({ rowId, items }),
        onStructuralChange: () => {},
      },
    });
    expect(outcome.ok).toBe(true);
    expect(carried).toHaveLength(1);
    const items = carried[0].items;
    // [ legacy answer as a TextItem, the carried evidence, the new text ]
    expect(items.map((i) => i.kind)).toEqual(["text", "photo", "text"]);
    expect(items[0].value).toBe("Frozen legacy answer");
    // The evidence entry is copied VERBATIM — the same asset, not a new Blob.
    expect(items[1].assetId).toBe("a-frozen");
    expect(items[2].value).toBe("A Quick Add sentence");

    // The text writer has no answers channel and no evidence channel.
    const textWriter = withoutComments(read("lib/templateSectionText.js"));
    expect(textWriter).not.toMatch(/persistEvidence|answers\[/);
  });

  test("17. Refine writes ONE text item, addressed by rowId + itemId", () => {
    expect(rowRefineTargetKey({ rowId: ROW, itemId: "t7" })).toBe(`${ROW}::item::t7`);
    expect(rowRefineTargetKey({ rowId: ROW })).toBe(ROW);
    expect(templateDoc).toMatch(/applySectionTextItemToInstance/);
  });

  test("18. an image resize writes display only, through the section item id", () => {
    expect(table).toMatch(/onResizeSectionPhoto\(row\.id, item\.id, widthPct\)/);
    expect(templateDoc).toMatch(/setSectionPhotoDisplay\(\{/);
  });

  test("19. an image move writes section ORDER only", () => {
    expect(templateDoc).toMatch(/reorderSectionItem\(/);
    expect(templateDoc).toMatch(/moveSectionItemIntoText\(/);
  });

  test("20. NO modern user path can create a new evidence entry", () => {
    // The three removed registrations, by name.
    for (const removed of [
      "onRegisterTemplateEvidence",
      "onRegisterTemplateAttachments",
      "onRegisterTemplateInsert",
      "handleAddEvidence",
      "handleTemplateAttachmentCapture",
      "templateEvidenceRef",
      "templateAttachmentsRef",
      "templateInsertRef",
      "insertIntoRow",
    ]) {
      expect(mainAreaSource).not.toContain(removed);
      expect(templateDocSource).not.toContain(removed);
    }
    // `addAttachmentsInto` survives, but with exactly ONE caller: the legacy
    // Photo/File field's own upload control.
    const intoCalls = templateDoc.match(/addAttachmentsInto\(\{/g) || [];
    expect(intoCalls).toHaveLength(1);
    expect(templateDoc).toMatch(
      /handleAddAttachments = useCallback\([\s\S]{0,200}?collectionRef: rowAttachmentsRef/
    );
    // No writer anywhere assigns into an evidence map keyed by a row.
    expect(templateDoc).not.toMatch(/persistEvidence\(\{\s*\.\.\./);
  });
});

/* ========================================================================== */
/* 4. ASSET SAFETY — legacy evidence still protects its Blob                   */
/* ========================================================================== */

describe("asset reference safety across all three collections", () => {
  beforeEach(() => localStorage.clear());

  const save = (over = {}) =>
    saveNoteTemplateInstanceOrThrow({
      noteId: "note-1",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      answers: {},
      attachments: {},
      evidence: {},
      sectionContent: {},
      customRows: [],
      ...over,
    });

  test("21. an asset referenced ONLY by legacy evidence is protected", () => {
    save({ evidence: { [ROW]: [photoRef("e1", "a-legacy-only")] } });
    expect(isAttachmentAssetReferenced("a-legacy-only")).toBe(true);
    expect(isAttachmentAssetReferenced("a-nowhere")).toBe(false);
  });

  test("22. an asset referenced ONLY by sectionContent is protected", () => {
    save({ sectionContent: { [ROW]: [photoRef("s1", "a-section-only")] } });
    expect(isAttachmentAssetReferenced("a-section-only")).toBe(true);
  });

  test("23. a frozen evidence duplicate protects the asset until ALL references are gone", () => {
    const shared = photoRef("dup", "a-shared");
    save({
      evidence: { [ROW]: [shared] },
      sectionContent: { [ROW]: [textItem("t1", "x"), shared] },
    });
    expect(isAttachmentAssetReferenced("a-shared")).toBe(true);

    // The modern section item goes; the frozen legacy copy still names it.
    save({ evidence: { [ROW]: [shared] }, sectionContent: { [ROW]: [textItem("t1", "x")] } });
    expect(isAttachmentAssetReferenced("a-shared")).toBe(true);

    // Only when the legacy copy goes too is it deletable.
    save({ evidence: {}, sectionContent: { [ROW]: [textItem("t1", "x")] } });
    expect(isAttachmentAssetReferenced("a-shared")).toBe(false);
  });

  test("24. removing one row's content never makes ANOTHER row's shared asset deletable", () => {
    const shared = photoRef("p", "a-shared");
    save({
      sectionContent: { "row-a": [shared], "row-b": [{ ...shared, id: "p2" }] },
    });
    save({ sectionContent: { "row-b": [{ ...shared, id: "p2" }] } });
    expect(isAttachmentAssetReferenced("a-shared")).toBe(true);
  });

  test("25. the gate is conservative: an entry too malformed to render still protects its asset", () => {
    save({
      sectionContent: {
        [ROW]: [{ id: "x", kind: "future-kind", assetId: "a-unreadable" }],
      },
    });
    // Not renderable (unknown kind is skipped by the read model)…
    expect(planRowBlocks({ row: makeRow(), sectionContent: getNoteTemplateInstance("note-1").sectionContent }))
      .toEqual([expect.objectContaining({ kind: ROW_BLOCK_KIND.ROW })]);
    // …but still referenced, because one orphaned Blob beats a destroyed photo.
    expect(isAttachmentAssetReferenced("a-unreadable")).toBe(true);
  });

  test("the deletion gate still scans all three collections", () => {
    const model = withoutComments(read("lib/templateModel.js"));
    const gate = model.slice(
      model.indexOf("export function isAttachmentAssetReferenced"),
      model.indexOf("export function getNoteTemplateInstance")
    );
    expect(gate).toMatch(/instance\?\.attachments/);
    expect(gate).toMatch(/instance\?\.evidence/);
    expect(gate).toMatch(/instance\?\.sectionContent/);
  });
});

/* ========================================================================== */
/* 5. CUSTOM ROW DELETE                                                        */
/* ========================================================================== */

describe("custom row deletion removes all of that row's state", () => {
  const deleteRow = templateDoc.slice(
    templateDoc.indexOf("const handleDeleteRow = useCallback"),
    templateDoc.indexOf("const handleRowHeightChange = useCallback")
  );

  test("26+27+28. one confirmed save prunes sectionContent, sectionExtraHeight and legacy evidence", () => {
    expect(deleteRow).toMatch(/removeRowSectionContent\(/);
    expect(deleteRow).toMatch(/removeSectionExtraHeight\(/);
    expect(deleteRow).toMatch(/delete nextEvidence\[rowId\]/);
    expect(deleteRow).toMatch(/deleteCustomRow\(raw, rowId\)/);
    // All of it in a SINGLE instance write, so the record is never half-updated.
    expect(deleteRow.match(/saveInstanceConfirmed\(/g) || []).toHaveLength(1);
  });

  test("29. only that row's keys are touched — every other row is spread through untouched", () => {
    expect(deleteRow).toMatch(/const nextEvidence = \{ \.\.\.prevEvidence \}/);
    expect(deleteRow).not.toMatch(/setRowText\(\{\}\)|setRowAttachments\(\{\}\)/);
  });

  test("30. assets are considered only AFTER the save, de-duplicated, and still gated", () => {
    const afterSave = deleteRow.slice(deleteRow.indexOf("saveInstanceConfirmed("));
    expect(afterSave).toMatch(/const removedAssetIds = new Set\(removedSectionAssetIds\)/);
    expect(afterSave).toMatch(/if \(!canDeleteAttachmentAsset\(assetId\)\) continue;/);
  });

  test("it also drops the row's transient editor and refine state", () => {
    expect(deleteRow).toMatch(/isRefineTargetKeyForRow\(key, rowId\)/);
    expect(deleteRow).toMatch(/onClearRowRefineBackup\(noteId, key\)/);
    expect(deleteRow).toMatch(/clearMaterializedSection\(\)/);
    expect(deleteRow).toMatch(/setPendingSectionExtra\(/);
  });

  test("a row's target keys cover its own key AND every section text item's", () => {
    const itemKey = rowRefineTargetKey({ rowId: "custom-9", itemId: "t1" });
    expect(isRefineTargetKeyForRow("custom-9", "custom-9")).toBe(true);
    expect(isRefineTargetKeyForRow(itemKey, "custom-9")).toBe(true);
    // Never a different row that merely starts with the same characters.
    expect(isRefineTargetKeyForRow("custom-90", "custom-9")).toBe(false);
    expect(isRefineTargetKeyForRow("other::item::custom-9", "custom-9")).toBe(false);
    expect(isRefineTargetKeyForRow(null, "custom-9")).toBe(false);
    expect(isRefineTargetKeyForRow("custom-9", "")).toBe(false);

    // …and clearing them leaves the OTHER row's backup alone.
    const backups = {
      "note-1": {
        "custom-9": "row backup",
        [itemKey]: "item backup",
        "row-other": "untouched",
      },
    };
    let next = backups;
    for (const key of refineTargetKeysWithBackup(backups, "note-1")) {
      if (isRefineTargetKeyForRow(key, "custom-9")) {
        next = clearRowRefineBackup(next, "note-1", key);
      }
    }
    expect(refineTargetKeysWithBackup(next, "note-1")).toEqual(new Set(["row-other"]));
  });
});

/* ========================================================================== */
/* 6. CLEANUP — what went, and what deliberately stayed                        */
/* ========================================================================== */

describe("cleanup: dead paths removed, live compatibility kept", () => {
  test("31+32. the dead Template evidence writer is gone and nothing references it", () => {
    expect(templateDocSource).not.toContain("handleAddEvidence");
    // No file anywhere still imports or names the removed registrations.
    const all = fs
      .readdirSync(path.join(SRC, "components"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => read(path.join("components", f)))
      .concat(
        fs
          .readdirSync(path.join(SRC, "components", "template"))
          .filter((f) => f.endsWith(".js"))
          .map((f) => read(path.join("components", "template", f)))
      );
    for (const source of all) {
      expect(source).not.toContain("onRegisterTemplateEvidence");
      expect(source).not.toContain("onRegisterTemplateInsert");
      expect(source).not.toContain("onRegisterTemplateAttachments");
    }
  });

  test("33. no dead user-facing photo size preset path — the SECTION item has none", () => {
    // A section photo passes `readOnly`, so no preset, no alignment, no edge
    // handle is offered for it. It resizes by its corners instead.
    const sectionBody = table.slice(
      table.indexOf("function renderSectionItemBody"),
      table.indexOf("function renderSectionSegment")
    );
    expect(sectionBody).not.toMatch(/PHOTO_WIDTH_PRESETS|onChangeDisplay/);
    expect(sectionBody).toMatch(/readOnly/);
    expect(sectionBody).toMatch(/onResizeWidth=/);
  });

  test("33b. the presets are NOT dead: a legacy Photo/File primary and legacy evidence still reach them", () => {
    // Deliberate. Removing them would take size and alignment away from an old
    // note's own Photo field — a capability that has no replacement there,
    // because the corner-resize gesture belongs to section items only.
    expect(photoAttachment).toMatch(/\{!readOnly && PHOTO_WIDTH_PRESETS\.map/);
    expect(photoAttachment).toMatch(/\{!readOnly && PHOTO_ALIGNMENTS\.map/);
    const attachmentBody = table.slice(
      table.indexOf("function renderAttachmentBody"),
      table.indexOf("function renderSegmentShell")
    );
    // No `readOnly` is passed here, so the toolbar renders for legacy content.
    expect(attachmentBody).toMatch(/<PhotoAttachment/);
    expect(attachmentBody).not.toMatch(/readOnly/);
  });

  test("34. legacy compatibility helpers are still available where they are required", () => {
    // The planner still plans evidence blocks…
    expect(ROW_BLOCK_KIND.EVIDENCE).toBe("evidence");
    // …the table still renders them, with Remove and display still wired…
    expect(table).toMatch(/case ROW_BLOCK_KIND\.EVIDENCE:/);
    expect(table).toMatch(/function renderEvidenceSegment/);
    expect(table).toMatch(/onRemoveEvidence\(row\.id, item\.index\)/);
    expect(table).toMatch(/onUpdateEvidenceDisplay\(row\.id, item\.index, patch\)/);
    // …and NoteTemplateDoc still supplies both, plus the map itself.
    expect(templateDoc).toMatch(/evidence=\{rowEvidence\}/);
    expect(templateDoc).toMatch(/onRemoveEvidence=\{handleRemoveEvidence\}/);
    expect(templateDoc).toMatch(/onUpdateEvidenceDisplay=\{handleUpdateEvidenceDisplay\}/);
    // The materialisation carry-across still reads the legacy collections.
    expect(templateDoc).toMatch(/evidence: rowEvidenceRef\.current\?\.\[rowId\]/);
  });
});

/* ========================================================================== */
/* 7. RENAMES                                                                  */
/* ========================================================================== */

describe("renames are mechanical", () => {
  test("35+36. the row-content module moved and no old import remains", () => {
    expect(exists("lib/templateRowContent.js")).toBe(true);
    expect(exists("lib/templateRowContent.test.js")).toBe(true);
    expect(exists("lib/templateRowEvidence.js")).toBe(false);
    expect(exists("lib/templateRowEvidence.test.js")).toBe(false);
    expect(table).toMatch(/from "\.\.\/\.\.\/lib\/templateRowContent"/);
    expect(withoutComments(read("lib/templateExportModel.js"))).toMatch(
      /from "\.\/templateRowContent"/
    );
    // Its live exports are unchanged — the same names, same behaviour.
    expect(typeof planRowBlocks).toBe("function");
    expect(typeof rowEvidenceItems).toBe("function");
    expect(typeof hasRowEvidence).toBe("function");
  });

  test("37+38. the refine backup helper is named for what it holds, and behaves identically", () => {
    const refine = read("lib/templateRowRefine.js");
    expect(refine).toMatch(/export function refineTargetKeysWithBackup\(/);
    // Only the doc comment may still mention the old name, as history.
    expect(withoutComments(refine)).not.toContain("rowIdsWithBackup");
    expect(templateDocSource).not.toContain("rowIdsWithBackup");
    expect(templateDocSource).not.toContain("rowRefineRevertableIds");
    expect(table).toMatch(/refineRevertableTargetKeys/);

    const itemKey = rowRefineTargetKey({ rowId: ROW, itemId: "t1" });
    const backups = { "note-1": { [ROW]: "a", [itemKey]: "b" }, "note-2": { x: "c" } };
    expect(refineTargetKeysWithBackup(backups, "note-1")).toEqual(
      new Set([ROW, itemKey])
    );
    expect(refineTargetKeysWithBackup(backups, "note-3")).toEqual(new Set());
    expect(refineTargetKeysWithBackup(null, "note-1")).toEqual(new Set());
  });
});

/* ========================================================================== */
/* 8. BUILDER — unchanged by this phase                                        */
/* ========================================================================== */

describe("the Builder catalogue is untouched", () => {
  const values = (type) => builderFieldTypeOptions(type).map((o) => o.value);

  test("39+40. a new row offers Section + the six structured types, and no Photo/File", () => {
    expect(values(FIELD_TYPE.TEXT)).toEqual([
      FIELD_TYPE.TEXT,
      FIELD_TYPE.NUMBER,
      FIELD_TYPE.DATE,
      FIELD_TYPE.TIME,
      FIELD_TYPE.CHECKBOX,
      FIELD_TYPE.YESNO,
      FIELD_TYPE.SELECT,
    ]);
    expect(values(FIELD_TYPE.NUMBER)).not.toContain(FIELD_TYPE.PHOTO);
    expect(values(FIELD_TYPE.NUMBER)).not.toContain(FIELD_TYPE.FILE);
  });

  test("41. a row already stored as Photo/File keeps its own legacy entry", () => {
    expect(values(FIELD_TYPE.PHOTO)).toContain(FIELD_TYPE.PHOTO);
    expect(values(FIELD_TYPE.FILE)).toContain(FIELD_TYPE.FILE);
    // …and only its own: a legacy Photo row cannot become a File row.
    expect(values(FIELD_TYPE.PHOTO)).not.toContain(FIELD_TYPE.FILE);
  });
});

/* ========================================================================== */
/* 9. EXPORT — no new behaviour, and still no legacy evidence                   */
/* ========================================================================== */

describe("export is unchanged by this phase", () => {
  const version = {
    id: "ver-1",
    templateId: "tpl-1",
    createdAt: 1,
    leftPct: 20,
    rows: [{ id: ROW, label: "Observations", type: FIELD_TYPE.TEXT, px: 120 }],
  };
  const template = { id: "tpl-1", name: "T", currentVersionId: "ver-1" };

  const model = (instance, assets = {}) =>
    buildTemplateExportModel({
      noteId: "note-1",
      noteTitle: "N",
      instance,
      template,
      version,
      assets,
    });

  const instance = (over = {}) => ({
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: {},
    attachments: {},
    evidence: {},
    sectionContent: {},
    customRows: [],
    ...over,
  });

  test("42. ordered section units come out in stored order", () => {
    const out = model(
      instance({
        sectionContent: {
          [ROW]: [textItem("t1", "One"), photoRef("p1", "a-p"), textItem("t2", "Two")],
        },
      }),
      { photos: new Map([["a-p", { dataUrl: "data:image/jpeg;base64,AA" }]]) }
    );
    const types = out.rows[0].units.map((u) => u.type);
    expect(types).toEqual([EXPORT_UNIT.BLOCK, EXPORT_UNIT.PHOTO, EXPORT_UNIT.BLOCK]);
  });

  test("43. a resized image exports its stored width", () => {
    const out = model(
      instance({
        sectionContent: { [ROW]: [photoRef("p1", "a-p", { display: { widthPct: 42, alignment: "left" } })] },
      }),
      { photos: new Map([["a-p", { dataUrl: "data:image/jpeg;base64,AA" }]]) }
    );
    const photo = out.rows[0].units.find((u) => u.type === EXPORT_UNIT.PHOTO);
    expect(photo.widthPct).toBe(42);
  });

  test("44. sectionExtraHeight still exports as a SPACE unit at the end of the section", () => {
    const out = model(
      instance({
        sectionContent: { [ROW]: [textItem("t1", "One")] },
        sectionExtraHeight: { [ROW]: 90 },
      })
    );
    const units = out.rows[0].units;
    expect(units[units.length - 1]).toMatchObject({ type: EXPORT_UNIT.SPACE, heightPx: 90 });
  });

  test("45. legacy evidence is STILL not exported — no new behaviour was introduced", () => {
    const out = model(
      instance({
        answers: { [ROW]: "The answer" },
        evidence: { [ROW]: [photoRef("e1", "a-legacy")] },
      })
    );
    expect(out.rows[0].units.some((u) => u.type === EXPORT_UNIT.PHOTO)).toBe(false);
    expect(out.evidence.totalPhotos).toBe(0);

    // Neither the model nor the asset collector reads `instance.evidence`.
    const exportModel = withoutComments(read("lib/templateExportModel.js"));
    expect(exportModel).not.toMatch(/instance\.evidence|instance\?\.evidence/);

    const refs = collectTemplateExportAssetRefs({
      instance: instance({ evidence: { [ROW]: [photoRef("e1", "a-legacy")] } }),
      version,
    });
    expect(refs.photoAssetIds).not.toContain("a-legacy");
  });
});

/* ========================================================================== */
/* 10. NO MUTATION, NO MIGRATION                                               */
/* ========================================================================== */

describe("nothing is migrated and nothing is mutated", () => {
  beforeEach(() => localStorage.clear());

  test("46. reading an old note does not rewrite its TemplateVersion", () => {
    // The planner is pure and takes the row by value; it returns blocks only.
    const row = makeRow();
    const snapshot = JSON.parse(JSON.stringify(row));
    planRowBlocks({ row, evidence: { [ROW]: [photoRef("e1", "a1")] } });
    expect(row).toEqual(snapshot);
  });

  test("47. reading an old instance does not migrate it", () => {
    const stored = {
      noteId: "note-old",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      answers: { [ROW]: "Old answer" },
      attachments: {},
      evidence: { [ROW]: [photoRef("e1", "a1")] },
      customRows: [],
      // Deliberately NO sectionContent and NO sectionExtraHeight key.
    };
    saveNoteTemplateInstanceOrThrow(stored);

    const back = getNoteTemplateInstance("note-old");
    planRowBlocks({
      row: makeRow(),
      evidence: back.evidence,
      sectionContent: back.sectionContent,
    });

    const after = getNoteTemplateInstance("note-old");
    expect(after).toEqual(stored);
    expect("sectionContent" in after).toBe(false);
    expect(after.evidence[ROW]).toHaveLength(1);
  });

  test("48+49. no schema bump, and no automatic evidence deletion anywhere", () => {
    const model = read("lib/templateModel.js");
    expect(model).toMatch(/sitewise-note-template-instances-v1/);
    // Nothing in the Template component tree clears the whole evidence map.
    expect(templateDoc).not.toMatch(/evidence: \{\}/);
    expect(templateDoc).not.toMatch(/setRowEvidence\(\{\}\)/);
  });

  test("50. Free-form notes are unaffected", () => {
    // The Free-form insertion paths are untouched and still reachable through
    // their own composer; neither mentions a Template collection.
    const freeform = mainArea.slice(
      mainArea.indexOf("async function handleQuickAddComposerSend"),
      mainArea.indexOf("function handleInsertError")
    );
    expect(freeform).toMatch(/insertLocalImageAsset\(/);
    expect(freeform).toMatch(/insertFreeformFileAttachment\(/);
    expect(freeform).not.toMatch(/evidence|attachments\[/);
  });
});
