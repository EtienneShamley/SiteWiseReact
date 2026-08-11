// src/lib/templateRowEvidence.test.js
//
// What a Template row renders once supporting evidence and ordered section
// content exist — and, just as importantly, what it still renders when neither
// does.
//
// The rules under test are the ones a render site must never re-derive:
//   - evidence renders because `evidence[rowId]` exists, NOT because the row's
//     current field type is one of the "evidence-capable" ones;
//   - a Photo/File field's primary attachments and a row's historical evidence
//     are two collections that are never merged;
//   - ordered `sectionContent[rowId]` is AUTHORITATIVE when present: it replaces
//     the row's legacy answer and its evidence, but never its typed value or
//     its primary attachments;
//   - stored order is preserved exactly;
//   - a row with neither collection produces exactly the block it always did.

import {
  ROW_BLOCK_KIND,
  ATTACHMENT_BLOCK_MIN_PX,
  SECTION_TEXT_BLOCK_MIN_PX,
  planRowBlocks,
  rowEvidenceItems,
  rowAttachmentItems,
  rowSectionItems,
  hasRowEvidence,
  hasRowSectionContent,
  sectionItemMinHeight,
  sectionReplacesRowAnswer,
} from "./templateRowEvidence";
import { resolveBlockHeight } from "./paginateBlocks";
import { FIELD_TYPE } from "./templateFields";
import { sectionItemsForRow } from "./templateSectionContent";

const photo = (id, assetId, over = {}) => ({
  id,
  assetId,
  kind: "photo",
  name: `${id}.jpg`,
  mimeType: "image/jpeg",
  size: 100,
  createdAt: 1,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct: 60, alignment: "left" },
  ...over,
});

const file = (id, assetId, over = {}) => ({
  id,
  assetId,
  kind: "file",
  name: `${id}.pdf`,
  mimeType: "application/pdf",
  size: 200,
  createdAt: 2,
  ...over,
});

const row = (over = {}) => ({
  id: "row-1",
  label: "Site Conditions",
  px: 120,
  minPx: 100,
  type: FIELD_TYPE.TEXT,
  options: [],
  ...over,
});

// Ordered section items. A text item's `value` is EXACTLY an existing answer
// value (a plain string or a tagged rich value) — never an extended shape.
const secText = (id, value = "") => ({ id, kind: "text", value });
const secPhoto = (id, assetId, over = {}) => photo(id, assetId, { ...over });
const secFile = (id, assetId, over = {}) => file(id, assetId, { ...over });

const kinds = (blocks) => blocks.map((b) => b.kind);
const names = (blocks) =>
  blocks.filter((b) => b.item).map((b) => b.item.norm.name);
// The ordered section blocks of a plan, described by item kind + id, which is
// what "renders in exactly the stored order" actually means.
const sectionIds = (blocks) =>
  blocks
    .filter((b) => b.kind === ROW_BLOCK_KIND.SECTION_ITEM)
    .map((b) => `${b.sectionItem.kind}:${b.sectionItem.id}`);

/* -------------------------------------------------------------------------- */
/* Evidence beneath an ordinary answer                                         */
/* -------------------------------------------------------------------------- */

describe("evidence renders beneath an ordinary row's answer", () => {
  test("a Text row with photo evidence emits the answer block then the photo", () => {
    const blocks = planRowBlocks({
      row: row(),
      isAttachmentField: false,
      evidence: { "row-1": [photo("p1", "a1")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.EVIDENCE]);
    // The answer is the head and the photo follows it — never the reverse.
    expect(blocks[0].id).toBe("row-1");
    expect(blocks[1].item.norm.name).toBe("p1.jpg");
  });

  test("a Text row with file evidence emits the answer block then the file card", () => {
    const blocks = planRowBlocks({
      row: row(),
      evidence: { "row-1": [file("f1", "a1")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.EVIDENCE]);
    expect(blocks[1].item.norm.kind).toBe("file");
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.file);
  });

  test("mixed evidence preserves STORED order — photos are never regrouped", () => {
    const blocks = planRowBlocks({
      row: row(),
      evidence: { "row-1": [photo("A", "a1"), file("B", "a2"), photo("C", "a3")] },
    });
    expect(names(blocks)).toEqual(["A.jpg", "B.pdf", "C.jpg"]);
  });

  test.each([
    FIELD_TYPE.NUMBER,
    FIELD_TYPE.DATE,
    FIELD_TYPE.TIME,
    FIELD_TYPE.CHECKBOX,
    FIELD_TYPE.YESNO,
    FIELD_TYPE.SELECT,
  ])("a %s row renders evidence beneath its primary control", (type) => {
    const blocks = planRowBlocks({
      row: row({ type }),
      isAttachmentField: false,
      evidence: { "row-1": [photo("p1", "a1")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.EVIDENCE]);
  });

  test("a note-specific custom row renders its own evidence", () => {
    const blocks = planRowBlocks({
      row: row({ id: "custom-9", isCustom: true }),
      evidence: { "custom-9": [file("f1", "a1")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.EVIDENCE]);
    expect(blocks[1].rowId).toBe("custom-9");
  });
});

/* -------------------------------------------------------------------------- */
/* A row with no evidence is untouched                                         */
/* -------------------------------------------------------------------------- */

describe("no evidence means nothing changes", () => {
  test("an ordinary row emits exactly one block, with no group and no keepWithNext", () => {
    const blocks = planRowBlocks({ row: row(), evidence: {} });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: ROW_BLOCK_KIND.ROW,
      id: "row-1",
      group: null,
      keepWithNext: false,
      minHeight: 120,
      splittable: false,
    });
  });

  test("a missing evidence key behaves exactly like an old note", () => {
    const withoutKey = planRowBlocks({ row: row(), evidence: {} });
    const undefinedMap = planRowBlocks({ row: row(), evidence: undefined });
    const nullMap = planRowBlocks({ row: row(), evidence: null });
    expect(undefinedMap).toEqual(withoutKey);
    expect(nullMap).toEqual(withoutKey);
  });

  test("an empty stored array produces no evidence blocks and no grouping", () => {
    const blocks = planRowBlocks({ row: row(), evidence: { "row-1": [] } });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].group).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Type-change precedence                                                      */
/* -------------------------------------------------------------------------- */

describe("evidence follows the stable row id, never the field type", () => {
  test("evidence captured while the row was Text still renders once it is a Photo field", () => {
    // Same row id; the pinned version now types it Photo, and it has its own
    // primary photo. The historical evidence must still appear, separately.
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("primary", "a-primary")] },
      evidence: { "row-1": [file("historical", "a-hist")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.EVIDENCE,
    ]);
    expect(names(blocks)).toEqual(["primary.jpg", "historical.pdf"]);
  });

  test("a File field with historical evidence behaves equivalently", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.FILE }),
      isAttachmentField: true,
      attachments: { "row-1": [file("primary", "a-primary")] },
      evidence: { "row-1": [photo("historical", "a-hist")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.EVIDENCE,
    ]);
  });

  test("the two collections are never merged into one list", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P1", "a1"), photo("P2", "a2")] },
      evidence: { "row-1": [photo("E1", "a3")] },
    });
    const primary = blocks.filter((b) => b.kind === ROW_BLOCK_KIND.ATTACHMENT);
    const supporting = blocks.filter((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE);
    expect(primary).toHaveLength(2);
    expect(supporting).toHaveLength(1);
    // Every primary block precedes every evidence block.
    const lastPrimary = blocks.findIndex((b) => b === primary[primary.length - 1]);
    const firstEvidence = blocks.findIndex((b) => b === supporting[0]);
    expect(lastPrimary).toBeLessThan(firstEvidence);
    // Block ids are namespaced apart, so they cannot share a measurement entry.
    expect(primary.every((b) => b.id.includes("::att-"))).toBe(true);
    expect(supporting.every((b) => b.id.includes("::ev-"))).toBe(true);
  });

  test("the disambiguating label appears ONLY when both collections are present", () => {
    const both = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P1", "a1")] },
      evidence: { "row-1": [photo("E1", "a2"), photo("E2", "a3")] },
    });
    const evidenceBlocks = both.filter((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE);
    expect(evidenceBlocks[0].showEvidenceLabel).toBe(true);
    // Only once, on the first item — not a heading per photo.
    expect(evidenceBlocks[1].showEvidenceLabel).toBe(false);

    // An ordinary row's evidence needs no label: there is nothing to confuse.
    const evidenceOnly = planRowBlocks({
      row: row(),
      evidence: { "row-1": [photo("E1", "a2")] },
    });
    expect(evidenceOnly[1].showEvidenceLabel).toBe(false);

    // An EMPTY Photo field with evidence also needs none.
    const emptyPrimary = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: {},
      evidence: { "row-1": [photo("E1", "a2")] },
    });
    expect(
      emptyPrimary.find((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE).showEvidenceLabel
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Orphan evidence and malformed data                                          */
/* -------------------------------------------------------------------------- */

describe("orphan and malformed evidence", () => {
  test("a row absent from the pinned version renders no orphan evidence", () => {
    // The caller only ever plans rows that exist in what the note is pinned to,
    // so evidence keyed by a vanished row id is simply never reached...
    const blocks = planRowBlocks({
      row: row({ id: "row-live" }),
      evidence: { "row-gone": [photo("ghost", "a1")] },
    });
    expect(blocks).toHaveLength(1);
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW]);
    // ...and reading it does not remove or rewrite it.
    expect(rowEvidenceItems({ "row-gone": [photo("ghost", "a1")] }, "row-gone")).toHaveLength(1);
  });

  test("malformed entries are filtered without crashing, and survivors keep raw indices", () => {
    const stored = [null, photo("good", "a1"), "data:image/png;base64,AAAA", 42, { nope: true }];
    const items = rowEvidenceItems({ "row-1": stored }, "row-1");
    expect(items).toHaveLength(1);
    expect(items[0].norm.name).toBe("good.jpg");
    // Removal addresses the RAW stored position, not the rendered position.
    expect(items[0].index).toBe(1);
  });

  test("a malformed evidence CONTAINER degrades to no evidence", () => {
    expect(rowEvidenceItems("nope", "row-1")).toEqual([]);
    expect(rowEvidenceItems([photo("p", "a")], "row-1")).toEqual([]);
    expect(rowEvidenceItems({ "row-1": "not-an-array" }, "row-1")).toEqual([]);
    expect(rowEvidenceItems({ "row-1": [photo("p", "a")] }, null)).toEqual([]);
    expect(hasRowEvidence(null, "row-1")).toBe(false);
    expect(planRowBlocks({ row: null })).toEqual([]);
  });

  test("a legacy base64 STRING is not valid evidence, but is still valid in attachments", () => {
    // Evidence postdates the reference model, so a string there is foreign data.
    expect(rowEvidenceItems({ "row-1": ["data:image/png;base64,AAAA"] }, "row-1")).toEqual([]);
    // The primary collection's legacy compatibility is untouched.
    const legacy = rowAttachmentItems({ "row-1": ["data:image/png;base64,AAAA"] }, "row-1");
    expect(legacy).toHaveLength(1);
    expect(typeof legacy[0].norm).toBe("string");
  });
});

/* -------------------------------------------------------------------------- */
/* Pagination grouping                                                         */
/* -------------------------------------------------------------------------- */

describe("pagination grouping", () => {
  test("an evidence-bearing row groups its blocks and keeps the answer with them", () => {
    const blocks = planRowBlocks({
      row: row(),
      evidence: { "row-1": [photo("p1", "a1"), photo("p2", "a2")] },
    });
    // One group, so the existing "Label — continued" context applies.
    expect(blocks.every((b) => b.group === "row-1")).toBe(true);
    expect(blocks[0].keepWithNext).toBe(true);
    // Evidence items are atomic: moved whole to the next page, never split.
    expect(blocks.slice(1).every((b) => b.splittable === false)).toBe(true);
    expect(blocks.slice(1).every((b) => b.keepWithNext === false)).toBe(true);
  });

  test("the answer block is never marked splittable — the editable row still grows", () => {
    const blocks = planRowBlocks({
      row: row(),
      evidence: { "row-1": [photo("p1", "a1")] },
    });
    expect(blocks[0].splittable).toBe(false);
  });

  test("an empty Photo field with only evidence still keeps its head with the evidence", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: {},
      evidence: { "row-1": [photo("E1", "a1")] },
    });
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ATTACHMENT_HEAD);
    expect(blocks[0].keepWithNext).toBe(true);
  });

  test("primary Photo/File field behaviour is unchanged when there is no evidence", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO, px: 56 }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P1", "a1")] },
      evidence: {},
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
    ]);
    expect(blocks[0]).toMatchObject({ group: "row-1", keepWithNext: true, minHeight: 56 });
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo);
    expect(blocks[1].id).toBe("row-1::att-P1");
  });

  test("evidence is ignored entirely when attachment rendering is off (Template Builder)", () => {
    // The Builder passes no note content; the caller withholds the evidence map
    // exactly as it withholds attachments.
    const blocks = planRowBlocks({ row: row(), isAttachmentField: false, evidence: null });
    expect(blocks).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Asset ids referenced by a row                                               */
/* -------------------------------------------------------------------------- */

describe("asset references reachable from a row's blocks", () => {
  test("both collections' asset ids are reachable, and a duplicate id is visible as such", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P1", "asset-1")] },
      evidence: { "row-1": [photo("E1", "asset-2"), photo("E2", "asset-1")] },
    });
    const assetIds = blocks.filter((b) => b.item).map((b) => b.item.norm.assetId);
    expect(assetIds).toEqual(["asset-1", "asset-2", "asset-1"]);
    // Deduplication is what a future single-read consumer would do; the render
    // path resolves per component through the existing shared hook/cache.
    expect(new Set(assetIds).size).toBe(2);
  });

  test("an item always carries the assetId its renderer resolves, never a blob", () => {
    const blocks = planRowBlocks({
      row: row(),
      evidence: { "row-1": [photo("E1", "asset-9")] },
    });
    const item = blocks[1].item.norm;
    expect(item.assetId).toBe("asset-9");
    expect(JSON.stringify(item)).not.toMatch(/data:|blob:/);
  });
});

/* ========================================================================== */
/* ORDERED SECTION CONTENT                                                     */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* Absent / unusable section content falls back to the legacy path             */
/* -------------------------------------------------------------------------- */

describe("no usable section content changes nothing", () => {
  test("a row with no sectionContent plans EXACTLY the legacy blocks", () => {
    const legacy = planRowBlocks({ row: row() });
    expect(planRowBlocks({ row: row(), sectionContent: {} })).toEqual(legacy);
    expect(planRowBlocks({ row: row(), sectionContent: null })).toEqual(legacy);
    expect(planRowBlocks({ row: row(), sectionContent: undefined })).toEqual(legacy);
    // And that plan is still the single, ungrouped block it always was.
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      kind: ROW_BLOCK_KIND.ROW,
      id: "row-1",
      group: null,
      keepWithNext: false,
      minHeight: 120,
      splittable: false,
    });
  });

  test("an empty array, a malformed container and malformed-only items all fall back", () => {
    const legacy = planRowBlocks({ row: row() });
    // Every one of these normalizes to no items, so the legacy path is used.
    for (const map of [
      { "row-1": [] },
      { "row-1": "not-an-array" },
      "nope",
      [secText("t1", "x")],
      // A text item with no id, an unknown kind, a kind that only LOOKS right,
      // a photo with no assetId, a legacy base64 string, and plain junk.
      { "row-1": [{ kind: "text", value: "orphaned" }] },
      { "row-1": [{ id: "x", kind: "video", assetId: "a1" }] },
      { "row-1": [{ id: "x", kind: "Photo", assetId: "a1" }] },
      { "row-1": [{ id: "x", kind: " file", assetId: "a1" }] },
      { "row-1": [{ id: "x", kind: "photo" }] },
      { "row-1": ["data:image/png;base64,AAAA"] },
      { "row-1": [null, 42, { nope: true }] },
    ]) {
      expect(planRowBlocks({ row: row(), sectionContent: map })).toEqual(legacy);
    }
  });

  test("evidence-only behaviour is untouched when section content is absent", () => {
    const withEvidence = planRowBlocks({
      row: row(),
      evidence: { "row-1": [photo("E1", "a1"), file("E2", "a2")] },
    });
    expect(
      planRowBlocks({
        row: row(),
        evidence: { "row-1": [photo("E1", "a1"), file("E2", "a2")] },
        sectionContent: { "row-1": [] },
      })
    ).toEqual(withEvidence);
    expect(kinds(withEvidence)).toEqual([
      ROW_BLOCK_KIND.ROW,
      ROW_BLOCK_KIND.EVIDENCE,
      ROW_BLOCK_KIND.EVIDENCE,
    ]);
  });

  test("primary Photo/File rendering is untouched when section content is absent", () => {
    const legacy = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO, px: 56 }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P1", "a1"), photo("P2", "a2")] },
    });
    expect(
      planRowBlocks({
        row: row({ type: FIELD_TYPE.PHOTO, px: 56 }),
        isAttachmentField: true,
        attachments: { "row-1": [photo("P1", "a1"), photo("P2", "a2")] },
        sectionContent: {},
      })
    ).toEqual(legacy);
    expect(kinds(legacy)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.ATTACHMENT,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* One block per ordered item, in stored order                                 */
/* -------------------------------------------------------------------------- */

describe("ordered items render one block each, in stored order", () => {
  test("a single text item emits ONE section block", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("t1", "Ground was soft.")] },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.SECTION_ITEM);
    expect(blocks[0].sectionItem.value).toBe("Ground was soft.");
  });

  test("a single photo item emits ONE section block", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secPhoto("p1", "a1")] },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.SECTION_ITEM);
    expect(blocks[0].sectionItem.assetId).toBe("a1");
  });

  test("a single file item emits ONE section block", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secFile("f1", "a1")] },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sectionItem.kind).toBe("file");
    expect(blocks[0].sectionItem.assetId).toBe("a1");
  });

  test("text → photo → text → file renders in EXACTLY that order", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [
          secText("A", "first"),
          secPhoto("B", "a-b"),
          secText("C", "second"),
          secFile("D", "a-d"),
        ],
      },
    });
    // Not regrouped by kind: the stored interleaving is the document order.
    expect(sectionIds(blocks)).toEqual([
      "text:A",
      "photo:B",
      "text:C",
      "file:D",
    ]);
  });

  test("a malformed item between valid ones is skipped without reordering its neighbours", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [
          secText("A", "first"),
          { id: "bad", kind: "video", assetId: "a-x" },
          secPhoto("B", "a-b"),
          { kind: "text", value: "no id" },
          secText("C", "last"),
        ],
      },
    });
    expect(sectionIds(blocks)).toEqual(["text:A", "photo:B", "text:C"]);
  });

  test("the order is exactly what sectionItemsForRow returns — nothing re-derives it", () => {
    const stored = {
      "row-1": [secFile("D", "a-d"), secText("A", "x"), secPhoto("B", "a-b")],
    };
    const blocks = planRowBlocks({ row: row(), sectionContent: stored });
    const fromModel = sectionItemsForRow(stored, "row-1");
    expect(blocks.map((b) => b.sectionItem)).toEqual(fromModel);
    // The planner's own accessor is the same read model, not a second one.
    expect(rowSectionItems(stored, "row-1")).toEqual(fromModel);
    expect(hasRowSectionContent(stored, "row-1")).toBe(true);
    expect(hasRowSectionContent(stored, "row-gone")).toBe(false);
  });

  test("a legitimately EMPTY text item is still an authored item", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "before"), secText("B", ""), secText("C", "after")] },
    });
    expect(sectionIds(blocks)).toEqual(["text:A", "text:B", "text:C"]);
    expect(blocks[1].sectionItem.value).toBe("");
    // On its own it is the whole body — not an empty row falling back to legacy.
    const alone = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("only", "")] },
    });
    expect(alone).toHaveLength(1);
    expect(alone[0].kind).toBe(ROW_BLOCK_KIND.SECTION_ITEM);
  });
});

/* -------------------------------------------------------------------------- */
/* Section content is authoritative — no duplicate legacy body                 */
/* -------------------------------------------------------------------------- */

describe("section content replaces the legacy body, never duplicates it", () => {
  test("a Text row with section content emits NO legacy answer block", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("t1", "authored")] },
    });
    expect(kinds(blocks)).not.toContain(ROW_BLOCK_KIND.ROW);
  });

  test("a Text row with section content emits NO evidence block", () => {
    const blocks = planRowBlocks({
      row: row(),
      evidence: { "row-1": [photo("E1", "a-ev"), file("E2", "a-ev2")] },
      sectionContent: { "row-1": [secText("t1", "authored"), secPhoto("p1", "a-p")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.SECTION_ITEM,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    // The evidence is not rendered — and reading it did not remove it.
    expect(rowEvidenceItems({ "row-1": [photo("E1", "a-ev")] }, "row-1")).toHaveLength(1);
  });

  test("a note-specific custom row uses its section content instead of its legacy answer", () => {
    const blocks = planRowBlocks({
      row: row({ id: "custom-9", isCustom: true }),
      evidence: { "custom-9": [photo("E1", "a-ev")] },
      sectionContent: { "custom-9": [secText("t1", "custom body"), secFile("f1", "a-f")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.SECTION_ITEM,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    expect(blocks.every((b) => b.rowId === "custom-9")).toBe(true);
    expect(blocks[0].isRowHead).toBe(true);
  });

  test("section content keyed to a row that is not on the page renders nothing, and is not mutated", () => {
    const stored = { "row-gone": [secText("t1", "ghost"), secPhoto("p1", "a1")] };
    const blocks = planRowBlocks({ row: row({ id: "row-live" }), sectionContent: stored });
    expect(blocks).toHaveLength(1);
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW]);
    // Same preservation rule as evidence: unreachable content stays in storage.
    expect(sectionItemsForRow(stored, "row-gone")).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Structured rows keep their typed value first                                */
/* -------------------------------------------------------------------------- */

describe("a structured row keeps its typed control above the ordered items", () => {
  test.each([
    FIELD_TYPE.NUMBER,
    FIELD_TYPE.DATE,
    FIELD_TYPE.TIME,
    FIELD_TYPE.CHECKBOX,
    FIELD_TYPE.YESNO,
    FIELD_TYPE.SELECT,
  ])("a %s row emits its ROW block, then the section items", (type) => {
    const blocks = planRowBlocks({
      row: row({ type }),
      sectionContent: { "row-1": [secText("t1", "note"), secPhoto("p1", "a1")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ROW,
      ROW_BLOCK_KIND.SECTION_ITEM,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    // The typed value is the head, and it is never orphaned from its content.
    expect(blocks[0].id).toBe("row-1");
    expect(blocks[0].keepWithNext).toBe(true);
    expect(blocks.slice(1).every((b) => b.isRowHead === false)).toBe(true);
  });

  test("a structured row with section content emits no evidence either", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.SELECT }),
      evidence: { "row-1": [photo("E1", "a-ev")] },
      sectionContent: { "row-1": [secText("t1", "note")] },
    });
    expect(kinds(blocks)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.SECTION_ITEM]);
  });
});

/* -------------------------------------------------------------------------- */
/* Legacy Photo/File rows keep their primary attachments first                 */
/* -------------------------------------------------------------------------- */

describe("a legacy Photo/File field keeps its primary attachments above the items", () => {
  test("a Photo field emits head + primary attachments, then the section items", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P1", "a1"), photo("P2", "a2")] },
      sectionContent: { "row-1": [secText("t1", "caption"), secFile("f1", "a3")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.SECTION_ITEM,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    expect(names(blocks)).toEqual(["P1.jpg", "P2.jpg"]);
    expect(sectionIds(blocks)).toEqual(["text:t1", "file:f1"]);
  });

  test("a File field behaves equivalently", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.FILE }),
      isAttachmentField: true,
      attachments: { "row-1": [file("P1", "a1")] },
      sectionContent: { "row-1": [secPhoto("p1", "a2")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
  });

  test("an EMPTY Photo field keeps its head with the first section item", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: {},
      sectionContent: { "row-1": [secText("t1", "only content")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    expect(blocks[0].keepWithNext).toBe(true);
    expect(blocks[0].attachmentCount).toBe(0);
  });

  test("a Photo/File field with section content emits no evidence either", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P1", "a1")] },
      evidence: { "row-1": [photo("E1", "a-ev")] },
      sectionContent: { "row-1": [secText("t1", "caption")] },
    });
    expect(kinds(blocks)).not.toContain(ROW_BLOCK_KIND.EVIDENCE);
    expect(blocks.filter((b) => b.kind === ROW_BLOCK_KIND.SECTION_ITEM)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Grouping, continuation and atomicity                                        */
/* -------------------------------------------------------------------------- */

describe("section pagination grouping", () => {
  test("ONE text item reproduces the simple single-row block STRUCTURE", () => {
    const legacy = planRowBlocks({ row: row() })[0];
    const single = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("t1", "body")] },
    })[0];
    // Same structure as the legacy Text row: no grouping, no continuation,
    // unsplittable — and the SAME block id, because the head item is the row
    // block. Holding that id steady is what lets a row materialise into a
    // section mid-keystroke without PagedDocument replacing (and so destroying)
    // the live editor.
    expect(single).toMatchObject({
      rowId: "row-1",
      group: null,
      keepWithNext: false,
      splittable: false,
      isRowHead: true,
    });
    expect(single.id).toBe(legacy.id);
    expect(single.id).toBe("row-1");
    // HEIGHT is the one thing that deliberately differs: a flexible section is
    // content-driven, so it does not inherit the legacy row height.
    expect(legacy.minHeight).toBe(120);
    expect(single.minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
  });

  test("multiple items share the row group and use continuation semantics", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [secText("A", "x"), secPhoto("B", "a-b"), secText("C", "y")],
      },
    });
    // One group, so the existing "Label — continued" context applies.
    expect(blocks.every((b) => b.group === "row-1")).toBe(true);
    // The head carries the row label and is never orphaned from its content.
    expect(blocks[0].isRowHead).toBe(true);
    expect(blocks[0].keepWithNext).toBe(true);
    // Its height comes from its own item kind — never from the legacy row
    // height, which would reserve a blank area above the photo below it.
    expect(blocks[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    // Everything after it is an ordinary continuation item — no label, no
    // "Supporting evidence" heading, nothing kept with the next block.
    expect(blocks.slice(1).every((b) => b.isRowHead === false)).toBe(true);
    expect(blocks.slice(1).every((b) => b.keepWithNext === false)).toBe(true);
    expect(blocks.every((b) => b.showEvidenceLabel === undefined)).toBe(true);
  });

  test("every ordered item is atomic — photo, file and text alike", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [secText("A", "x"), secPhoto("B", "a-b"), secFile("C", "a-c")],
      },
    });
    expect(blocks.every((b) => b.splittable === false)).toBe(true);
    // Continuation items are sized by what they hold, not by the row height.
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo);
    expect(blocks[2].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.file);
    const textAfterHead = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secPhoto("B", "a-b"), secText("A", "x")] },
    })[1];
    expect(textAfterHead.minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
  });

  test("block ids are namespaced apart from primary attachments and evidence", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      // Deliberately the same item id in both collections.
      attachments: { "row-1": [photo("X", "a1")] },
      sectionContent: { "row-1": [secPhoto("X", "a2")] },
    });
    const ids = blocks.map((b) => b.id);
    expect(ids).toEqual(["row-1", "row-1::att-X", "row-1::sec-X"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the planner states row identity only — it never carries selection state", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
    });
    // `activeTemplateRowId` stays the single selection authority: a plan says
    // which row a block belongs to and nothing about which row is selected or
    // which item is active.
    expect(blocks.every((b) => b.rowId === "row-1")).toBe(true);
    for (const b of blocks) {
      expect(b).not.toHaveProperty("active");
      expect(b).not.toHaveProperty("selected");
      expect(b).not.toHaveProperty("targetRowId");
      expect(b).not.toHaveProperty("itemId");
    }
  });

  test("section content is ignored entirely when note rendering is off (Template Builder)", () => {
    // The caller withholds the map exactly as it withholds attachments/evidence.
    const blocks = planRowBlocks({ row: row(), sectionContent: null });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ROW);
  });
});

/* -------------------------------------------------------------------------- */
/* ONE ROW IS ONE SECTION — the group every block of a row shares              */
/* -------------------------------------------------------------------------- */

// A row's items are separate BLOCKS so that each can paginate (and later be
// reordered) on its own. `group` is what tells the renderer they are one
// section of the document rather than a stack of unlabelled rows: the layout
// engine derives `groupContinuesBelow` from it and the renderer composes them
// (see src/lib/paginateBlocks.js).
describe("one row is ONE logical section group", () => {
  const groupsOf = (blocks) => new Set(blocks.map((b) => b.group));

  test("text + image belong to one group", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
    });
    expect(blocks).toHaveLength(2);
    expect(groupsOf(blocks)).toEqual(new Set(["row-1"]));
  });

  test("text + image + text belong to one group", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [secText("A", "x"), secPhoto("B", "a-b"), secText("C", "y")],
      },
    });
    expect(blocks).toHaveLength(3);
    expect(groupsOf(blocks)).toEqual(new Set(["row-1"]));
    // Only the head carries the label; nothing after it repeats it.
    expect(blocks.filter((b) => b.isRowHead)).toHaveLength(1);
    expect(blocks[0].isRowHead).toBe(true);
  });

  test("a STRUCTURED row's supplementary items stay in that row's group", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.NUMBER }),
      sectionContent: { "row-1": [secPhoto("B", "a-b"), secText("C", "y")] },
    });
    // The typed control is still the row head, and the supplementary items are
    // part of the same section beneath it.
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(groupsOf(blocks)).toEqual(new Set(["row-1"]));
  });

  test("a legacy Photo/File field's supplementary items stay in that row's group", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P", "a-p")] },
      sectionContent: { "row-1": [secText("C", "y")] },
    });
    expect(kinds(blocks)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.SECTION_ITEM,
    ]);
    expect(groupsOf(blocks)).toEqual(new Set(["row-1"]));
  });

  test("a CUSTOM row's items stay in that custom row's group", () => {
    const blocks = planRowBlocks({
      row: row({ id: "custom-9", isCustom: true }),
      sectionContent: {
        "custom-9": [secText("A", "x"), secFile("B", "a-b")],
      },
    });
    expect(groupsOf(blocks)).toEqual(new Set(["custom-9"]));
    expect(blocks.every((b) => b.rowId === "custom-9")).toBe(true);
  });

  test("two different rows never share a group", () => {
    const a = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
    });
    const b = planRowBlocks({
      row: row({ id: "row-2" }),
      sectionContent: { "row-2": [secText("C", "y"), secPhoto("D", "a-d")] },
    });
    expect(groupsOf(a)).toEqual(new Set(["row-1"]));
    expect(groupsOf(b)).toEqual(new Set(["row-2"]));
  });

  test("removing the last attachment leaves NO group and no fake continuation", () => {
    // After an item-level Remove the row must collapse back to the plain
    // single-block shape — no leftover grouping, no continuation semantics and
    // no empty segment where the attachment used to be.
    const before = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
    });
    expect(before).toHaveLength(2);

    const after = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x")] },
    });
    expect(after).toHaveLength(1);
    expect(after[0].group).toBeNull();
    expect(after[0].keepWithNext).toBe(false);
    expect(after[0].id).toBe("row-1");
  });

  test("removing a middle attachment closes the gap and keeps the text around it", () => {
    const after = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x"), secText("C", "y")] },
    });
    expect(sectionIds(after)).toEqual(["text:A", "text:C"]);
    expect(new Set(after.map((b) => b.group))).toEqual(new Set(["row-1"]));
  });
});

/* -------------------------------------------------------------------------- */
/* A FLEXIBLE SECTION IS CONTENT-DRIVEN                                        */
/* -------------------------------------------------------------------------- */

// The defect this pins: the head item inherited `row.px || 120`, so a short
// paragraph reserved the whole legacy row height and the photo beneath it began
// far below the text. `row.px` still governs every row whose body is its own
// answer control — that height is the one the user actually dragged.
describe("section height comes from the items, never from the legacy row height", () => {
  const heights = (blocks) => blocks.map((b) => b.minHeight);

  test("a legacy Text row with NO section content keeps its row height", () => {
    expect(planRowBlocks({ row: row() })[0].minHeight).toBe(120);
    expect(planRowBlocks({ row: row({ px: 300 }) })[0].minHeight).toBe(300);
    // And an empty/absent section map changes nothing.
    expect(
      planRowBlocks({ row: row({ px: 300 }), sectionContent: { "row-1": [] } })[0]
        .minHeight
    ).toBe(300);
  });

  test("an authoritative section TEXT item does not inherit row.px", () => {
    const blocks = planRowBlocks({
      row: row({ px: 300 }),
      sectionContent: { "row-1": [secText("A", "short")] },
    });
    expect(blocks[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    expect(blocks[0].minHeight).not.toBe(300);
  });

  test("short text + photo stacks with no legacy-height gap", () => {
    const blocks = planRowBlocks({
      row: row({ px: 300 }),
      sectionContent: { "row-1": [secText("A", "short"), secPhoto("B", "a-b")] },
    });
    expect(heights(blocks)).toEqual([
      SECTION_TEXT_BLOCK_MIN_PX,
      ATTACHMENT_BLOCK_MIN_PX.photo,
    ]);
  });

  test("text + file stacks naturally", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "short"), secFile("B", "a-b")] },
    });
    expect(heights(blocks)).toEqual([
      SECTION_TEXT_BLOCK_MIN_PX,
      ATTACHMENT_BLOCK_MIN_PX.file,
    ]);
  });

  test("text + photo + text stacks naturally", () => {
    const blocks = planRowBlocks({
      row: row({ px: 240 }),
      sectionContent: {
        "row-1": [secText("A", "x"), secPhoto("B", "a-b"), secText("C", "y")],
      },
    });
    expect(heights(blocks)).toEqual([
      SECTION_TEXT_BLOCK_MIN_PX,
      ATTACHMENT_BLOCK_MIN_PX.photo,
      SECTION_TEXT_BLOCK_MIN_PX,
    ]);
    // No block reserves the legacy row height anywhere in the section.
    expect(heights(blocks).some((h) => h === 240)).toBe(false);
  });

  test("an EMPTY text item keeps a compact usable editing minimum", () => {
    // Small enough not to be a blank band, large enough to remain a real click
    // target — and it is a MINIMUM, so the rendered editor line governs.
    const blocks = planRowBlocks({
      row: row({ px: 300 }),
      sectionContent: { "row-1": [secText("A", ""), secPhoto("B", "a-b")] },
    });
    expect(blocks[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    expect(SECTION_TEXT_BLOCK_MIN_PX).toBeGreaterThan(0);
    expect(SECTION_TEXT_BLOCK_MIN_PX).toBeLessThan(120);
  });

  test("the height is a MINIMUM, so long text can still grow", () => {
    // resolveBlockHeight takes max(preferred, measured): a hint never caps the
    // rendered height, so a pasted essay simply makes the block taller.
    const short = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x")] },
    })[0];
    const long = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x".repeat(5000))] },
    })[0];
    expect(short.minHeight).toBe(long.minHeight);
    expect(short.splittable).toBe(false);
    expect(resolveBlockHeight(long.minHeight, 900)).toBe(900);
  });

  test("every section item's height is decided by its own kind", () => {
    expect(sectionItemMinHeight(secText("A", "x"))).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    expect(sectionItemMinHeight(secPhoto("B", "a-b"))).toBe(
      ATTACHMENT_BLOCK_MIN_PX.photo
    );
    expect(sectionItemMinHeight(secFile("C", "a-c"))).toBe(
      ATTACHMENT_BLOCK_MIN_PX.file
    );
  });

  test("a STRUCTURED row keeps its real primary control height", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.DATE, px: 160 }),
      sectionContent: { "row-1": [secPhoto("B", "a-b")] },
    });
    // The typed control's own row is untouched…
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(blocks[0].minHeight).toBe(160);
    // …and the supplementary item that follows reserves nothing extra.
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo);
    expect(blocks).toHaveLength(2);
  });

  test("a legacy PHOTO field keeps its primary area and adds nothing artificial", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO, px: 200 }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P", "a-p")] },
      sectionContent: { "row-1": [secText("C", "note"), secPhoto("D", "a-d")] },
    });
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ATTACHMENT_HEAD);
    expect(blocks[0].minHeight).toBe(200);
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo);
    // Supplementary items follow the primary collection at their own sizes.
    expect(blocks[2].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    expect(blocks[3].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo);
  });

  test("a legacy FILE field behaves the same way", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.FILE, px: 90 }),
      isAttachmentField: true,
      attachments: { "row-1": [file("F", "a-f")] },
      sectionContent: { "row-1": [secText("C", "note")] },
    });
    expect(blocks[0].minHeight).toBe(90);
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.file);
    expect(blocks[2].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
  });

  test("a CUSTOM flexible row is content-driven too", () => {
    const blocks = planRowBlocks({
      row: row({ id: "custom-9", isCustom: true, px: 260 }),
      sectionContent: {
        "custom-9": [secText("A", "x"), secPhoto("B", "a-b")],
      },
    });
    expect(heights(blocks)).toEqual([
      SECTION_TEXT_BLOCK_MIN_PX,
      ATTACHMENT_BLOCK_MIN_PX.photo,
    ]);
  });

  test("removing an item removes its space entirely — nothing is reserved", () => {
    const before = planRowBlocks({
      row: row({ px: 300 }),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
    });
    const after = planRowBlocks({
      row: row({ px: 300 }),
      sectionContent: { "row-1": [secText("A", "x")] },
    });
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(1);
    // The section does not fall back to the legacy row height once the photo is
    // gone, so the content above simply closes up.
    expect(after[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
  });

  test("composition and continuation are unaffected by the height change", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [secText("A", "x"), secPhoto("B", "a-b"), secText("C", "y")],
      },
    });
    // Still one group (one visible section), still one head, still atomic.
    expect(new Set(blocks.map((b) => b.group))).toEqual(new Set(["row-1"]));
    expect(blocks.filter((b) => b.isRowHead)).toHaveLength(1);
    expect(blocks.every((b) => b.splittable === false)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* MANUAL SECTION HEIGHT — optional extra working space at the section's end   */
/* -------------------------------------------------------------------------- */

// A flexible section stays content-driven; the user may additionally drag extra
// blank working space onto its BOTTOM. That extra belongs to the LOGICAL
// section, so it attaches to the section's last block and to nothing else.
describe("a flexible section's optional extra working space", () => {
  const tail = (blocks) => blocks[blocks.length - 1];

  test("with no manual resize the section stays exactly content-driven", () => {
    const blocks = planRowBlocks({
      row: row({ px: 300 }),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
    });
    expect(blocks.map((b) => b.minHeight)).toEqual([
      SECTION_TEXT_BLOCK_MIN_PX,
      ATTACHMENT_BLOCK_MIN_PX.photo,
    ]);
    expect(blocks.every((b) => b.sectionExtraPx === 0)).toBe(true);
  });

  test("an absent, empty or malformed map is the same as no resize", () => {
    const items = { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] };
    for (const map of [undefined, null, {}, [], "nope"]) {
      const blocks = planRowBlocks({
        row: row({ px: 300 }),
        sectionContent: items,
        sectionExtraHeight: map,
      });
      expect(tail(blocks).minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo);
    }
  });

  test("the legacy row.px is NEVER treated as a section's extra space", () => {
    // Reinterpreting it would reserve blank space in every existing section at
    // once, which is exactly the defect that was fixed.
    const blocks = planRowBlocks({
      row: row({ px: 400, minPx: 380 }),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
      sectionExtraHeight: {},
    });
    expect(blocks.map((b) => b.minHeight)).toEqual([
      SECTION_TEXT_BLOCK_MIN_PX,
      ATTACHMENT_BLOCK_MIN_PX.photo,
    ]);
  });

  test("an explicit resize makes the section taller, at its END only", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [secText("A", "x"), secPhoto("B", "a-b"), secText("C", "y")],
      },
      sectionExtraHeight: { "row-1": 150 },
    });
    // The items keep their own content heights…
    expect(blocks[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo);
    // …and only the LAST block carries the extra.
    expect(blocks[2].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX + 150);
    expect(blocks.map((b) => b.sectionExtraPx)).toEqual([0, 0, 150]);
  });

  test("no extra height is ever added BETWEEN items", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [secText("A", "x"), secFile("B", "a-b"), secPhoto("C", "a-c")],
      },
      sectionExtraHeight: { "row-1": 200 },
    });
    expect(blocks.slice(0, -1).every((b) => b.sectionExtraPx === 0)).toBe(true);
    expect(blocks[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.file);
  });

  test("exactly ONE block is the section's tail", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [secText("A", "x"), secPhoto("B", "a-b"), secText("C", "y")],
      },
      sectionExtraHeight: { "row-1": 90 },
    });
    expect(blocks.filter((b) => b.isSectionTail)).toHaveLength(1);
    expect(tail(blocks).isSectionTail).toBe(true);
    expect(blocks[0].isSectionTail).toBe(false);
    expect(blocks[1].isSectionTail).toBe(false);
  });

  test("a single-item section is its own tail", () => {
    const blocks = planRowBlocks({
      row: row({ px: 300 }),
      sectionContent: { "row-1": [secText("A", "x")] },
      sectionExtraHeight: { "row-1": 60 },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isRowHead).toBe(true);
    expect(blocks[0].isSectionTail).toBe(true);
    expect(blocks[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX + 60);
  });

  test("the extra is added to a MINIMUM, so content can never be clipped", () => {
    // resolveBlockHeight takes max(preferred, measured): a taller measured block
    // always wins, whatever the extra is. Long text, a tall image and a file card
    // are all safe by the same rule.
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
      sectionExtraHeight: { "row-1": 100 },
    });
    const tailBlock = tail(blocks);
    expect(tailBlock.minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo + 100);
    expect(resolveBlockHeight(tailBlock.minHeight, 900)).toBe(900);
    expect(tailBlock.splittable).toBe(false);
  });

  test("a stored value is normalized, never trusted raw", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x")] },
      sectionExtraHeight: { "row-1": -500 },
    });
    expect(blocks[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
  });

  test("removing an item moves the tail and recalculates the natural minimum", () => {
    const before = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
      sectionExtraHeight: { "row-1": 120 },
    });
    expect(before[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo + 120);

    const after = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x")] },
      sectionExtraHeight: { "row-1": 120 },
    });
    // The text item is now the tail, sized by ITS OWN content plus the same
    // extra — the removed photo's height is not left reserved anywhere.
    expect(after).toHaveLength(1);
    expect(after[0].isSectionTail).toBe(true);
    expect(after[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX + 120);
  });

  test("adding an item moves the extra to the NEW end of the section", () => {
    const grown = planRowBlocks({
      row: row(),
      sectionContent: { "row-1": [secText("A", "x"), secPhoto("B", "a-b")] },
      sectionExtraHeight: { "row-1": 120 },
    });
    expect(grown[0].sectionExtraPx).toBe(0);
    expect(grown[1].sectionExtraPx).toBe(120);
  });

  test("a STRUCTURED row gets no section extra and keeps its own row height", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.DATE, px: 160 }),
      sectionContent: { "row-1": [secPhoto("B", "a-b")] },
      sectionExtraHeight: { "row-1": 200 },
    });
    expect(blocks[0].minHeight).toBe(160);
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo);
    expect(blocks.every((b) => !b.isSectionTail)).toBe(true);
  });

  test("a legacy Photo/File field gets no section extra either", () => {
    const blocks = planRowBlocks({
      row: row({ type: FIELD_TYPE.PHOTO, px: 200 }),
      isAttachmentField: true,
      attachments: { "row-1": [photo("P", "a-p")] },
      sectionContent: { "row-1": [secText("C", "note")] },
      sectionExtraHeight: { "row-1": 200 },
    });
    expect(blocks[0].minHeight).toBe(200);
    expect(blocks[2].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    expect(blocks.every((b) => !b.isSectionTail)).toBe(true);
  });

  test("a CUSTOM flexible row resizes like any other section", () => {
    const blocks = planRowBlocks({
      row: row({ id: "custom-9", isCustom: true, px: 260 }),
      sectionContent: { "custom-9": [secText("A", "x"), secPhoto("B", "a-b")] },
      sectionExtraHeight: { "custom-9": 75 },
    });
    expect(blocks[0].minHeight).toBe(SECTION_TEXT_BLOCK_MIN_PX);
    expect(blocks[1].minHeight).toBe(ATTACHMENT_BLOCK_MIN_PX.photo + 75);
    expect(blocks[1].isSectionTail).toBe(true);
  });

  test("a LEGACY row with no section content is completely unaffected", () => {
    const blocks = planRowBlocks({
      row: row({ px: 300 }),
      sectionExtraHeight: { "row-1": 500 },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(blocks[0].minHeight).toBe(300);
    expect(blocks[0].isSectionTail).toBeUndefined();
  });

  test("composition and grouping are unaffected by an extra", () => {
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: {
        "row-1": [secText("A", "x"), secPhoto("B", "a-b"), secText("C", "y")],
      },
      sectionExtraHeight: { "row-1": 150 },
    });
    expect(new Set(blocks.map((b) => b.group))).toEqual(new Set(["row-1"]));
    expect(blocks.filter((b) => b.isRowHead)).toHaveLength(1);
    expect(blocks[0].keepWithNext).toBe(true);
    expect(blocks.slice(1).every((b) => b.keepWithNext === false)).toBe(true);
  });

  test("the Template Builder never sees a section extra", () => {
    // Note content — including a note-specific height — is withheld exactly as
    // attachments, evidence and section content already are.
    const blocks = planRowBlocks({
      row: row(),
      sectionContent: null,
      sectionExtraHeight: null,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].minHeight).toBe(120);
  });
});

/* ------------------------------------------------------------------------ */
/* The shared authority predicate                                            */
/* ------------------------------------------------------------------------ */
//
// `sectionReplacesRowAnswer` is now a CROSS-MODULE contract: the planner above
// and the canonical export model (src/lib/templateExportModel.js) both decide
// "does the section own this row's body?" from it, so the exported document and
// the on-screen document can never disagree about which rows hand their whole
// body to `sectionContent`.

describe("sectionReplacesRowAnswer", () => {
  test("a Text row hands its body over", () => {
    expect(sectionReplacesRowAnswer(FIELD_TYPE.TEXT)).toBe(true);
  });

  test("a custom row — no stored type at all — is Text by definition", () => {
    expect(sectionReplacesRowAnswer(undefined)).toBe(true);
    expect(sectionReplacesRowAnswer(null)).toBe(true);
    expect(sectionReplacesRowAnswer("nonsense")).toBe(true);
  });

  test("every structured type keeps its own typed control first", () => {
    for (const type of [
      FIELD_TYPE.NUMBER,
      FIELD_TYPE.DATE,
      FIELD_TYPE.TIME,
      FIELD_TYPE.CHECKBOX,
      FIELD_TYPE.YESNO,
      FIELD_TYPE.SELECT,
    ]) {
      expect(sectionReplacesRowAnswer(type)).toBe(false);
    }
  });

  test("a legacy Photo/File field keeps its primary attachments first", () => {
    expect(sectionReplacesRowAnswer(FIELD_TYPE.PHOTO, true)).toBe(false);
    expect(sectionReplacesRowAnswer(FIELD_TYPE.FILE, true)).toBe(false);
  });
});
