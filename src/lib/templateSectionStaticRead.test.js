// src/lib/templateSectionStaticRead.test.js
//
// PHASE F3 (+ G) — THE UNIFIED STATIC READ PATH.
//
// An inactive flexible Template Section renders from the canonical body reader,
// through the static Section view, one document block per segment. This suite
// holds the two things that decision has to be true for:
//
//   1. HISTORICAL READ COMPATIBILITY. For every historical Section the document
//      plan is the SAME plan the legacy item list always produced — same order,
//      same block ids, same heights, same group, same head, same tail — so
//      nothing about pagination changes for any existing note. Since Phase G
//      the legacy per-item plan itself no longer exists in production, so that
//      historical plan is stated here as a fixture ORACLE (`historicalLayout`)
//      rather than computed by code that was retired.
//
//   2. MODERN INTERACTION / BOUNDARIES. Reading writes nothing; the static view
//      constructs no editor; the ONLY interaction is the shared Section editor
//      (a static segment of an owned row presses through to it, a row it may
//      not own renders read-only); the static Section and the live one show
//      the same document; no Template writer exists outside the editor's own
//      update path; export reads through the same reader.
//
// Component-level facts are source assertions. That is this project's
// convention for React files that import `@tiptap/core` — which no Jest test in
// this project can load at all (see sectionEditorExtensions.js and
// .claude/NOTEWISE_HANDOFF.md §30.5) — and ResizableTwoColTable reaches it
// through TemplateSectionEditor.
import fs from "fs";
import path from "path";
import {
  ROW_BLOCK_KIND,
  planRowBlocks,
  sectionSegmentMinHeight,
} from "./templateRowContent";
import { SECTION_SEGMENT_KIND, sectionDocSegments } from "./templateSectionDocSegments";
import {
  SECTION_BODY_SOURCE,
  isLegacyMediaBody,
  isSectionDocumentBody,
  resolveSectionBody,
} from "./templateSectionBody";
import { SECTION_DOC_FORMAT } from "./templateSectionDoc";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const stripComments = (source) =>
  source.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

const TABLE = read("components/template/ResizableTwoColTable.js");
const TABLE_CODE = stripComments(TABLE);
const DOC_VIEW = read("components/template/TemplateSectionDocView.js");
const DOC_VIEW_CODE = stripComments(DOC_VIEW);
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const NOTE_DOC_CODE = stripComments(NOTE_DOC);
const TEMPLATE_CSS = read("components/template/template.css");
const EDITOR_CSS = read("components/editor/editor.css");

const IMAGE_ID = "img-asset-0001";
const FILE_ID = "file-asset-0001";
const LONG_FILE_ID = `note-att-${"a".repeat(40)}-${"b".repeat(40)}-1`;
const ROW = "row-1";

const doc = (html) => ({ format: SECTION_DOC_FORMAT, html });
const text = (id, value) => ({ id, kind: "text", value });
const photo = (over = {}) => ({
  id: "item-photo",
  kind: "photo",
  assetId: IMAGE_ID,
  name: "site.jpg",
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct: 60, alignment: "left" },
  ...over,
});
const file = (over = {}) => ({
  id: "item-file",
  kind: "file",
  assetId: FILE_ID,
  name: "Report.pdf",
  mimeType: "application/pdf",
  size: 2048,
  ...over,
});

const row = (over = {}) => ({ id: ROW, label: "Observations", px: 120, type: "text", ...over });

/**
 * The document plan of ONE row, from ONE stored instance — exactly what the
 * form hands the planner: the segments of the body the canonical reader
 * resolved. `historical` is the fixture ORACLE of the plan the legacy per-item
 * renderer produced for the same stored list (see `historicalLayout`).
 */
function bothPlans(instance, over = {}) {
  const body = resolveSectionBody({ instance, rowId: ROW, rowType: "text", ...over.body });
  const common = {
    row: row(over.row),
    isAttachmentField: !!over.isAttachmentField,
    attachments: instance.attachments || null,
    evidence: instance.evidence || null,
    sectionExtraHeight: instance.sectionExtraHeight || null,
  };
  const items = (instance.sectionContent && instance.sectionContent[ROW]) || [];
  return {
    body,
    historical: historicalLayout(items, {
      rowId: ROW,
      extraPx: (instance.sectionExtraHeight && instance.sectionExtraHeight[ROW]) || 0,
    }),
    document: planRowBlocks({ ...common, sectionSegments: sectionDocSegments(body) }),
  };
}

/**
 * HISTORICAL ORACLE — the layout the legacy per-item plan (`SECTION_ITEM`, one
 * block per stored `sectionContent` item; retired in Phase G) produced for one
 * row, restated as data so a historical note can be shown to paginate exactly
 * as it always did:
 *
 *   - the FIRST item is the row head and keeps the row's own block id;
 *   - every later item is `${rowId}::sec-${item.id}`;
 *   - a single item has no group and no keepWithNext; several share the row's
 *     group, the head keeps with the next, nothing else does;
 *   - text 24 / photo 60 / file 36 (a file the document cannot represent kept
 *     its 36 through the compatibility renderer), never splittable;
 *   - the trailing working space lands on the LAST item and nowhere else.
 */
const HISTORICAL_ITEM_MIN_HEIGHT = { text: 24, photo: 60, file: 36 };
function historicalLayout(items, { rowId, extraPx = 0 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const many = list.length > 1;
  return list.map((item, index) => {
    const isRowHead = index === 0;
    const isSectionTail = index === list.length - 1;
    return {
      id: isRowHead ? rowId : `${rowId}::sec-${item.id}`,
      group: many ? rowId : null,
      keepWithNext: isRowHead && many,
      minHeight: HISTORICAL_ITEM_MIN_HEIGHT[item.kind] + (isSectionTail ? extraPx : 0),
      splittable: false,
      isRowHead,
      isSectionTail,
      sectionExtraPx: isSectionTail ? extraPx : 0,
    };
  });
}

/** Everything about a planned block that governs where it lands on a page. */
const layoutOf = (blocks) =>
  blocks.map((b) => ({
    id: b.id,
    group: b.group,
    keepWithNext: b.keepWithNext,
    minHeight: b.minHeight,
    splittable: b.splittable,
    isRowHead: !!b.isRowHead,
    isSectionTail: !!b.isSectionTail,
    sectionExtraPx: b.sectionExtraPx || 0,
  }));

/* ============ 46. static and legacy plan the SAME page ================ */

describe("46. HISTORICAL READ COMPATIBILITY: the document plan IS the plan the item list always produced", () => {
  const CASES = {
    "text only": [text("t1", "One paragraph")],
    "text, photo, text, file": [text("t1", "A"), photo(), text("t2", "B"), file()],
    "photo-headed section": [photo(), text("t1", "Caption below")],
    "file-headed section": [file(), text("t1", "Note")],
    "two independent text captures": [text("a", "First send"), text("b", "Second send")],
    "rich text with lists and links": [
      text("t1", {
        format: "richtext/1",
        html: '<ul><li><p><a href="https://example.com">Link</a></p></li></ul>',
      }),
    ],
    "an unrepresentable file between two paragraphs": [
      text("t1", "Before"),
      file({ id: "item-long", assetId: LONG_FILE_ID }),
      text("t2", "After"),
    ],
  };

  test.each(Object.keys(CASES))("%s plans exactly as its stored items always did", (name) => {
    const { historical, document } = bothPlans({ sectionContent: { [ROW]: CASES[name] } });
    expect(layoutOf(document)).toEqual(historical);
  });

  test.each(Object.keys(CASES))("%s: the trailing working space lands where it always did", (name) => {
    const { historical, document } = bothPlans({
      sectionContent: { [ROW]: CASES[name] },
      sectionExtraHeight: { [ROW]: 90 },
    });
    expect(layoutOf(document)).toEqual(historical);
  });

  test("G. every block is a SEGMENT block — the per-item plan no longer exists", () => {
    const { document } = bothPlans({
      sectionContent: { [ROW]: CASES["text, photo, text, file"] },
    });
    expect(document.map((b) => b.kind)).toEqual(
      Array(4).fill(ROW_BLOCK_KIND.SECTION_SEGMENT)
    );
    expect(ROW_BLOCK_KIND.SECTION_ITEM).toBeUndefined();
    // A raw `sectionContent` handed to the planner is no longer a plan of its
    // own: the row plans exactly as a row with no body does.
    const stray = planRowBlocks({
      row: row(),
      sectionContent: { [ROW]: CASES["text, photo, text, file"] },
    });
    expect(stray.map((b) => b.kind)).toEqual([ROW_BLOCK_KIND.ROW]);
  });

  test("every document block carries the segment its renderer needs, and no item", () => {
    const { document } = bothPlans({
      sectionContent: { [ROW]: CASES["text, photo, text, file"] },
    });
    for (const block of document) {
      expect(block.sectionSegment).toBeTruthy();
      expect(block.sectionItem).toBeUndefined();
      expect(block.item).toBeUndefined();
    }
  });

  test("47. a later item on a stored list shows up on the next read, with no migration", () => {
    const before = bothPlans({ sectionContent: { [ROW]: [text("t1", "A")] } });
    expect(before.document).toHaveLength(1);
    // A historical note whose list grew (the retired Quick Add append wrote
    // exactly this shape) reads as one more block — nothing else changes.
    const after = bothPlans({
      sectionContent: { [ROW]: [text("t1", "A"), photo(), text("t2", "Sent")] },
    });
    expect(after.document).toHaveLength(3);
    expect(layoutOf(after.document)).toEqual(after.historical);
  });
});

/* ==================== 38-45. pagination properties ==================== */

describe("38-45. what the document plan reserves on a page", () => {
  test("38/43. the head is content-driven — no legacy 120px row reserve returns", () => {
    const { document } = bothPlans({
      sectionContent: { [ROW]: [text("t1", "Short"), photo()] },
    });
    expect(document[0].minHeight).toBe(24);
    expect(document[0].minHeight).not.toBe(120);
  });

  test("39. the trailing working space lands on the LAST segment and nowhere else", () => {
    const { document } = bothPlans({
      sectionContent: { [ROW]: [text("t1", "A"), photo(), text("t2", "B")] },
      sectionExtraHeight: { [ROW]: 90 },
    });
    expect(document.map((b) => b.sectionExtraPx)).toEqual([0, 0, 90]);
    expect(document[2].isSectionTail).toBe(true);
    expect(document[2].minHeight).toBe(24 + 90);
  });

  test("41/42. an image and a file are atomic — neither is ever sliced", () => {
    const { document } = bothPlans({
      sectionContent: { [ROW]: [text("t1", "A"), photo(), file()] },
    });
    expect(document.map((b) => b.splittable)).toEqual([false, false, false]);
    expect(document[1].minHeight).toBe(60);
    expect(document[2].minHeight).toBe(36);
  });

  test("40. a section continues across a page at SEGMENT boundaries, in one group", () => {
    const { document } = bothPlans({
      sectionContent: { [ROW]: [text("t1", "A"), photo(), text("t2", "B")] },
    });
    // One group -> the existing continuation context ("Label — continued")
    // applies wherever the section resumes; the head is never orphaned.
    expect(document.every((b) => b.group === ROW)).toBe(true);
    expect(document[0].keepWithNext).toBe(true);
    expect(document.slice(1).every((b) => b.keepWithNext === false)).toBe(true);
  });

  test("44. a wrapped image and its text are ONE block, so the float can never be paginated away from what it wraps", () => {
    const body = resolveSectionBody({
      instance: {
        sectionDoc: {
          [ROW]: doc(
            `<img data-asset-id="${IMAGE_ID}" alt="a" data-width-pct="40" ` +
              `data-layout-mode="wrap" data-layout-side="left">` +
              `<p>Text beside it</p>`
          ),
        },
      },
      rowId: ROW,
      rowType: "text",
    });
    const blocks = planRowBlocks({
      row: row(),
      sectionSegments: sectionDocSegments(body),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].splittable).toBe(false);
    expect(blocks[0].sectionSegment.wrapped).toBe(true);
    expect(blocks[0].minHeight).toBe(60);
  });

  test("45. no block id is ever emitted twice — nothing can be measured or rendered twice", () => {
    const { document } = bothPlans({
      sectionContent: {
        [ROW]: [
          text("t1", "A"),
          file({ id: "item-long", assetId: LONG_FILE_ID }),
          text("t2", "B"),
          photo(),
        ],
      },
    });
    const ids = document.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a single-segment section is ONE block with no group and no keepWithNext", () => {
    const { document } = bothPlans({ sectionContent: { [ROW]: [text("t1", "Only")] } });
    expect(document).toHaveLength(1);
    expect(document[0].id).toBe(ROW);
    expect(document[0].group).toBeNull();
    expect(document[0].keepWithNext).toBe(false);
  });

  test("the height hint of every segment kind matches the item it replaces", () => {
    expect(sectionSegmentMinHeight({ kind: SECTION_SEGMENT_KIND.TEXT })).toBe(24);
    expect(sectionSegmentMinHeight({ kind: SECTION_SEGMENT_KIND.IMAGE })).toBe(60);
    expect(sectionSegmentMinHeight({ kind: SECTION_SEGMENT_KIND.FILE })).toBe(36);
    expect(
      sectionSegmentMinHeight({ kind: SECTION_SEGMENT_KIND.COMPAT, itemKind: "file" })
    ).toBe(36);
    expect(
      sectionSegmentMinHeight({ kind: SECTION_SEGMENT_KIND.COMPAT, itemKind: "photo" })
    ).toBe(60);
  });
});

/* ================= 27-33. structured, custom and legacy =============== */

describe("27-29. a structured row keeps its typed value first and separate", () => {
  const instance = {
    sectionContent: { [ROW]: [text("t1", "Supplementary note"), photo()] },
    answers: { [ROW]: "42" },
  };

  test("27/28. the typed control is block one; the document follows beneath it", () => {
    const { document } = bothPlans(instance, { row: { type: "number" }, body: { rowType: "number" } });
    expect(document[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(document[0].id).toBe(ROW);
    expect(document[0].minHeight).toBe(120);
    expect(document.slice(1).map((b) => b.kind)).toEqual([
      ROW_BLOCK_KIND.SECTION_SEGMENT,
      ROW_BLOCK_KIND.SECTION_SEGMENT,
    ]);
    expect(document.slice(1).every((b) => b.isRowHead === false)).toBe(true);
  });

  test("29. the typed answer is never document content, and no segment claims the row head", () => {
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: "number" });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(JSON.stringify(body.nodes)).not.toContain("42");
  });

  test("a structured row's trailing working space is not a flexible section's", () => {
    const { document } = bothPlans(
      { ...instance, sectionExtraHeight: { [ROW]: 90 } },
      { row: { type: "number" }, body: { rowType: "number" } }
    );
    expect(document.every((b) => (b.sectionExtraPx || 0) === 0)).toBe(true);
  });

  test("the supplementary body plans exactly as its stored items always did", () => {
    const { document } = bothPlans(instance, {
      row: { type: "number" },
      body: { rowType: "number" },
    });
    // The historical oracle for a body BENEATH a typed control: no segment is
    // the row head (the ROW block is), so every segment carries its own id, in
    // the row's group, none keeping with the next.
    expect(layoutOf(document.slice(1))).toEqual([
      { id: `${ROW}::sec-t1`, group: ROW, keepWithNext: false, minHeight: 24, splittable: false, isRowHead: false, isSectionTail: false, sectionExtraPx: 0 },
      { id: `${ROW}::sec-item-photo`, group: ROW, keepWithNext: false, minHeight: 60, splittable: false, isRowHead: false, isSectionTail: false, sectionExtraPx: 0 },
    ]);
  });
});

describe("30/31. a custom row reads through the same boundary, by its own id", () => {
  const CUSTOM = "custom-row-9";
  const instance = {
    customRows: [{ id: CUSTOM, templateId: "t", label: "Extra", answer: "Typed here" }],
    sectionContent: { [CUSTOM]: [text("c1", "Ordered body"), photo()] },
  };

  test("31. the lookup is the custom row's stable id — no separate architecture", () => {
    const body = resolveSectionBody({
      instance,
      rowId: CUSTOM,
      rowType: "text",
      isCustomRow: true,
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(sectionDocSegments(body).map((s) => s.key)).toEqual(["c1", "item-photo"]);
  });

  test("30. it plans exactly as a master Section does — and as its stored items always did", () => {
    const body = resolveSectionBody({
      instance,
      rowId: CUSTOM,
      rowType: "text",
      isCustomRow: true,
    });
    const customRow = { id: CUSTOM, label: "Extra", px: 120, type: "text", isCustom: true };
    const custom = layoutOf(
      planRowBlocks({ row: customRow, sectionSegments: sectionDocSegments(body) })
    );
    expect(custom).toEqual(historicalLayout(instance.sectionContent[CUSTOM], { rowId: CUSTOM }));
    // …which is the master Section's plan with the row id swapped, nothing else.
    const master = bothPlans({ sectionContent: { [ROW]: instance.sectionContent[CUSTOM] } });
    expect(custom).toEqual(
      layoutOf(master.document).map((b) => ({ ...b, id: b.id.replace(ROW, CUSTOM), group: b.group && CUSTOM }))
    );
  });
});

describe("32/33. legacy Photo/File primary rows stay compatibility rows", () => {
  const instance = {
    attachments: { [ROW]: [{ id: "att-1", kind: "photo", assetId: IMAGE_ID, name: "p.jpg" }] },
    sectionContent: { [ROW]: [text("t1", "Supplementary")] },
  };

  test("the primary attachment keeps its own head and its own block, above the document", () => {
    const { document } = bothPlans(instance, {
      isAttachmentField: true,
      row: { type: "photo" },
      body: { rowType: "photo", isAttachmentField: true },
    });
    expect(document.map((b) => b.kind)).toEqual([
      ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      ROW_BLOCK_KIND.ATTACHMENT,
      ROW_BLOCK_KIND.SECTION_SEGMENT,
    ]);
  });

  test("its primary attachment is never converted into document content", () => {
    const body = resolveSectionBody({
      instance,
      rowId: ROW,
      rowType: "photo",
      isAttachmentField: true,
    });
    expect(JSON.stringify(body.nodes)).not.toContain("att-1");
  });

  test("the supplement plans exactly as its stored items always did, after the primary blocks", () => {
    const { document } = bothPlans(instance, {
      isAttachmentField: true,
      row: { type: "photo" },
      body: { rowType: "photo", isAttachmentField: true },
    });
    expect(document[0].id).toBe(ROW);
    expect(document[1].id).toBe(`${ROW}::att-att-1`);
    expect(layoutOf(document.slice(2))).toEqual([
      { id: `${ROW}::sec-t1`, group: ROW, keepWithNext: false, minHeight: 24, splittable: false, isRowHead: false, isSectionTail: false, sectionExtraPx: 0 },
    ]);
  });
});

/* ============ 5/34-37. rows that have no document body yet ============ */

describe("5/34-37. a row still on its legacy answer/evidence: what the reader says, and what renders statically", () => {
  test("34. answer + evidence is a LEGACY body, not a document body — but it carries MEDIA", () => {
    const body = resolveSectionBody({
      instance: { answers: { [ROW]: "Old answer" }, evidence: { [ROW]: [photo()] } },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(isSectionDocumentBody(body)).toBe(false);
    // Since Phase G such a row renders statically as the SAME segments it
    // edits as, so its evidence appears exactly once and activation changes
    // nothing the user can see.
    expect(isLegacyMediaBody(body)).toBe(true);
    expect(sectionDocSegments(body).map((s) => s.kind)).toEqual([
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.IMAGE,
    ]);
  });

  test("35/36. evidence-only, and several evidence items, likewise", () => {
    for (const evidence of [[photo()], [photo(), file(), photo({ id: "p2" })]]) {
      const body = resolveSectionBody({
        instance: { evidence: { [ROW]: evidence } },
        rowId: ROW,
        rowType: "text",
      });
      expect(isSectionDocumentBody(body)).toBe(false);
      expect(isLegacyMediaBody(body)).toBe(true);
      // Every evidence item is a media segment, exactly once — and the document
      // BEGINS with the media. A Text row whose answer says nothing contributes
      // no paragraph here: manufacturing one to represent the absence of text
      // would put a blank line and a prompt above the picture (Phase G
      // correction). Ordering, ids and the frozen stored answer are untouched.
      const segments = sectionDocSegments(body);
      expect(segments.map((s) => s.kind)).toEqual(
        evidence.map((e) => (e.kind === "file" ? SECTION_SEGMENT_KIND.FILE : SECTION_SEGMENT_KIND.IMAGE))
      );
      expect(segments.filter((s) => s.kind === SECTION_SEGMENT_KIND.TEXT)).toHaveLength(0);
    }
  });

  test("G. a legacy body with media plans as document segments — its evidence is never rendered twice", () => {
    const instance = { answers: { [ROW]: "Old answer" }, evidence: { [ROW]: [photo()] } };
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
    const blocks = planRowBlocks({
      row: row(),
      evidence: instance.evidence,
      sectionSegments: sectionDocSegments(body),
    });
    expect(blocks.map((b) => b.kind)).toEqual([
      ROW_BLOCK_KIND.SECTION_SEGMENT,
      ROW_BLOCK_KIND.SECTION_SEGMENT,
    ]);
    expect(blocks.some((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE)).toBe(false);
    // `evidence[rowId]` itself is untouched — it stays in storage, frozen.
    expect(instance.evidence[ROW]).toEqual([photo()]);
  });

  test("5. a row with NO segments plans the blocks it always has — the legacy answer and its evidence", () => {
    // A refused row (unrepresentable material) has no segments and keeps its
    // compatibility plan: the ROW block and one EVIDENCE block per item.
    const blocks = planRowBlocks({
      row: row(),
      evidence: { [ROW]: [photo()] },
      sectionSegments: null,
    });
    expect(blocks.map((b) => b.kind)).toEqual([
      ROW_BLOCK_KIND.ROW,
      ROW_BLOCK_KIND.EVIDENCE,
    ]);
  });

  test("37. a sectionContent list of nothing renderable falls through, protecting the legacy display", () => {
    const body = resolveSectionBody({
      instance: {
        sectionContent: { [ROW]: [{ id: "x", kind: "sketch" }, "legacy-string"] },
        answers: { [ROW]: "Still visible" },
      },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(isSectionDocumentBody(body)).toBe(false);
    // Prose only: while inactive it keeps rendering as the row's own answer
    // box, at the row's designed height.
    expect(isLegacyMediaBody(body)).toBe(false);
  });

  test("document bodies AND legacy-with-media bodies are published for STATIC rendering; legacy prose is not", () => {
    // The one gate, stated once in NoteTemplateDoc: a body renders statically
    // as segments when the reader called it a document, or (Phase G) when it is
    // a legacy body carrying media. A legacy prose-only body keeps its answer
    // box. Every eligible body — all three — is editable.
    const memo = NOTE_DOC_CODE.slice(
      NOTE_DOC_CODE.indexOf("const sectionState = useMemo("),
      NOTE_DOC_CODE.indexOf("const sectionBodies = sectionState.bodies")
    );
    expect(memo).toContain("const isDocument = isSectionDocumentBody(body);");
    expect(memo).toContain("const legacyMedia = isLegacyMediaBody(body);");
    expect(memo).toContain("if (isDocument || legacyMedia) bodies[row.id] = body;");
    // A REFUSED document body still renders statically (its document plus its
    // compat segments); a refused legacy body keeps its legacy blocks.
    expect(memo).toContain("if (isDocument) bodies[row.id] = body;");
    expect(memo).toContain("editable[row.id] = {");
  });
});

/* ================= 48-50. reading writes nothing ====================== */

describe("48-50. rendering a note writes nothing at all", () => {
  test("48/49. resolving a body twice yields the same body and mutates no stored value", () => {
    const instance = {
      sectionDoc: {},
      sectionContent: { [ROW]: [text("t1", "A"), photo(), file()] },
      answers: { [ROW]: "Frozen" },
      evidence: { [ROW]: [photo({ id: "ev" })] },
    };
    const snapshot = JSON.parse(JSON.stringify(instance));
    const first = resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
    const second = resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
    sectionDocSegments(first);
    planRowBlocks({ row: row(), sectionSegments: sectionDocSegments(second) });
    expect(second).toEqual(first);
    expect(instance).toEqual(snapshot);
    expect(instance.sectionDoc).toEqual({});
  });

  test("48. no render path can create a document — the format is minted nowhere near it", () => {
    for (const source of [TABLE_CODE, DOC_VIEW_CODE, NOTE_DOC_CODE]) {
      expect(source).not.toContain("makeSectionDocValue");
      expect(source).not.toContain("sectiondoc/1");
    }
  });

  test("50. the body memo is a pure derivation: it saves nothing and schedules nothing", () => {
    const memo = NOTE_DOC_CODE.slice(
      NOTE_DOC_CODE.indexOf("const sectionState = useMemo("),
      NOTE_DOC_CODE.indexOf("const displaySectionExtraHeight")
    );
    expect(memo).toContain("resolveSectionBody");
    // It decides which Sections may be EDITED as well, and that decision is a
    // pure read too: it creates no editor and touches no registry.
    expect(memo).toContain("sectionEditorEligibility(body)");
    expect(memo).toContain("resolveSectionQuickAddRoute(body)");
    expect(memo).not.toContain("getOrCreate");
    expect(memo).not.toContain("createSectionEditor");
    for (const forbidden of [
      "saveInstanceConfirmed",
      "setInstance",
      "persistSectionContent",
      "useEffect",
      "localStorage",
    ]) {
      expect({ forbidden, hit: memo.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });
});

/* ============== 1/2/3. what the static Section view is ================ */

describe("1. the static view is a renderer and nothing else", () => {
  test("51. no editor, no ProseMirror, no NodeView, no transaction", () => {
    for (const forbidden of [
      "@tiptap",
      "new Editor",
      "useEditor",
      "EditorContent",
      "NodeView",
      "ReactNodeViewRenderer",
      "prosemirror",
      "contentEditable",
      "dispatch",
    ]) {
      expect({ forbidden, hit: DOC_VIEW_CODE.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });

  test("no selection chrome, no resize handle, no drag and no Remove", () => {
    for (const forbidden of [
      "onRemove",
      "onMoveStart",
      "onResizeWidth",
      "nw-media-corner",
      "nw-media--selected",
      "onPointerDown",
      "draggable",
    ]) {
      expect({ forbidden, hit: DOC_VIEW_CODE.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });

  test("stored content is never injected — no dangerouslySetInnerHTML anywhere in the read path", () => {
    for (const source of [DOC_VIEW_CODE, TABLE_CODE, NOTE_DOC_CODE]) {
      expect(source).not.toContain("dangerouslySetInnerHTML");
    }
    // Prose is React elements built from the validated model, exactly as an
    // inactive Template answer has always been.
    expect(DOC_VIEW_CODE).toContain("TemplateRichTextView");
  });
});

describe("2. images use the shared media presentation, with the page's own cap", () => {
  test("the shared presentation hook and the shared wrapper classes, not a second component", () => {
    expect(DOC_VIEW_CODE).toContain("useMediaImagePresentation");
    expect(DOC_VIEW_CODE).toContain("mediaImageWrapperClassNames");
    expect(DOC_VIEW_CODE).toContain("mediaWidthStyle");
    expect(DOC_VIEW_CODE).toContain('from "../editor/mediaImagePresentation"');
    // No second asset rule and no second object-URL policy.
    expect(DOC_VIEW_CODE).not.toContain("useAssetObjectUrl");
    expect(DOC_VIEW_CODE).not.toContain("createObjectURL");
    expect(DOC_VIEW_CODE).not.toContain("getAsset");
  });

  test("no interaction handler is passed, so the shared presentation renders a static image", () => {
    const call = DOC_VIEW_CODE.slice(
      DOC_VIEW_CODE.indexOf("useMediaImagePresentation({"),
      DOC_VIEW_CODE.indexOf("const ratio")
    );
    for (const handler of ["onImageClick", "onImagePointerDown", "onImageDragStart"]) {
      expect({ handler, hit: call.includes(handler) }).toEqual({ handler, hit: false });
    }
  });

  test("the one-page display cap is the EXISTING Template constant, never a new number", () => {
    expect(DOC_VIEW_CODE).toContain("PHOTO_MAX_HEIGHT_PX");
    expect(DOC_VIEW_CODE).toContain('from "./PhotoAttachment"');
    expect(DOC_VIEW_CODE).toContain("--nw-tpl-photo-max-h");
    expect(TEMPLATE_CSS).toContain("max-height: var(--nw-tpl-photo-max-h);");
  });

  test("the static root carries the shared media marker and NEVER .note-editor", () => {
    expect(DOC_VIEW_CODE).toContain("MEDIA_DOC_ROOT_CLASS");
    expect(DOC_VIEW_CODE).not.toContain("note-editor");
    // Which is what keeps the white Template paper on the LIGHT presentation in
    // both app themes: no `.dark .note-editor …` rule can ever match it.
    const leaking = EDITOR_CSS.split("\n").filter((line) => {
      const t = line.trim();
      return t.startsWith(".dark") && t.includes(".nw-doc-root");
    });
    expect(leaking).toEqual([]);
  });

  test("only the PRESENTATION rules are shared with the static root — never the interaction chrome", () => {
    for (const shared of [
      ".nw-doc-root .nw-media,",
      ".nw-doc-root .nw-media--block,",
      ".nw-doc-root .nw-media--wrap-left,",
      ".nw-doc-root .nw-media--wrap-right,",
      ".nw-doc-root .nw-media--sized > img,",
      ".nw-doc-root .note-image-node,",
      ".nw-doc-root .note-image-placeholder,",
      ".nw-doc-root .note-image-placeholder--missing,",
      ".nw-doc-root,\n.nw-editor-root {\n  display: flow-root;",
    ]) {
      expect({ shared, present: EDITOR_CSS.includes(shared) }).toEqual({
        shared,
        present: true,
      });
    }
    for (const chrome of [
      ".nw-doc-root .nw-media--selected",
      ".nw-doc-root .nw-media-corner",
      ".nw-doc-root .nw-media-controls",
      ".nw-doc-root .nw-media-btn",
      ".nw-doc-root .nw-media-drop-indicator",
      ".nw-doc-root .nw-media--dragging",
    ]) {
      expect({ chrome, present: EDITOR_CSS.includes(chrome) }).toEqual({
        chrome,
        present: false,
      });
    }
  });
});

describe("the row's prompt follows the same rule it always has", () => {
  test("the invitation to type belongs to the FIRST run of prose, wherever it is", () => {
    // A Section whose first content is an image has a picture as its head and
    // its prose below; without this it would offer no visible invitation at all
    // — which is exactly the rule the legacy per-item rendering applies.
    expect(TABLE_CODE).toContain("function isPromptSegment(row, segment)");
    expect(TABLE_CODE).toContain(
      "entry.segments.find((s) => s.kind === SECTION_SEGMENT_KIND.TEXT)"
    );
    // The legacy answer box (a prose-only legacy row) keeps the same prompt.
    expect(TABLE_CODE).toContain("Enter details for this field...");
    // Both the head and every later segment ask the same question.
    expect(TABLE_CODE).toContain("isPrompt: isPromptSegment(row, headSegment)");
    expect(TABLE_CODE).toContain("isPrompt: isPromptSegment(row, segment)");
  });

  test("an empty prose segment still keeps its blank line — only the placeholder is conditional", () => {
    const empty = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function isEmptySegmentText"),
      TABLE_CODE.indexOf("function renderSectionDocText")
    );
    expect(empty).toContain('block.type === "paragraph"');
    expect(empty).toContain('node.type === "break"');
  });
});

describe("3. files use the SHARED file card, read-only (Phase F4)", () => {
  test("no second file card is built — it is the editor's own card, unmodified", () => {
    // Phase F3 used the Template's own compact row because the ACTIVE Section
    // was still the legacy interaction and the two could not move together.
    // F4 moves both sides in one step: the live Section renders the shared
    // `fileAttachment` NodeView, so the static view must render the SAME card
    // or activating a Section would resize every file in it.
    expect(DOC_VIEW_CODE).toContain("useFileAttachmentCard");
    expect(DOC_VIEW_CODE).not.toContain("FileAttachmentRow");
    // No markup, no class list and no asset policy is restated here.
    expect(DOC_VIEW_CODE).not.toContain("note-file-attachment__");
    expect(DOC_VIEW_CODE).not.toContain("safeAttachmentOpen");
    expect(DOC_VIEW_CODE).not.toContain("getAsset");
  });

  test("21. it keeps its open/download behaviour, and offers no Remove", () => {
    const card = DOC_VIEW_CODE.slice(
      DOC_VIEW_CODE.indexOf("function SectionDocFile"),
      DOC_VIEW_CODE.indexOf("The body of ONE segment")
    );
    // The card's own Open/Preview/Download come from the shared hook; the one
    // difference from the NodeView is that no remover is supplied at all.
    expect(card).toContain("useFileAttachmentCard");
    expect(card).toContain("SECTION_FILE_ASSET_KINDS");
    expect(card).not.toContain("onRemove");
  });

  test("the shared card renders Remove only when a remover is supplied", () => {
    const shared = stripComments(read("components/editor/fileAttachmentPresentation.js"));
    expect(shared).toContain('typeof onRemove === "function" && (');
    // Nothing ProseMirror-specific leaked into the shared card.
    for (const forbidden of ["@tiptap", "NodeViewWrapper", "deleteNode", "getPos"]) {
      expect({ forbidden, hit: shared.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });
});

/* ============ 11/51-55. MODERN INTERACTION and boundaries ============ */

describe("51-55. MODERN INTERACTION: the shared editor is the only one, and everything else is untouched", () => {
  test("55/G. the legacy interaction helpers are gone; the READ boundary survives", () => {
    for (const file of [
      "components/template/TemplateRowEditor.js",
      "components/template/TemplateTextCell.js",
      "lib/templateSectionItemDrop.js",
      "lib/templateSectionItemDragSession.js",
      "lib/templateSectionTextPoint.js",
      "lib/templateSectionTextSplit.js",
      "lib/templateSectionLeadingText.js",
      "lib/templateSectionImagePlacement.js",
      "lib/templateSectionImageResize.js",
      "lib/templateSectionReorder.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: false,
      });
    }
    for (const file of [
      "components/template/PhotoAttachment.js",
      "components/template/FileAttachmentRow.js",
      "lib/templateSectionTextHeal.js",
      "components/template/TemplateSectionDocView.js",
      "components/template/TemplateSectionEditor.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: true,
      });
    }
  });

  test("11. a static segment of an OWNED row presses through to the shared editor", () => {
    // Prose: the same static textbox an inactive answer has always been.
    const prose = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function renderSectionDocText(row, segment"),
      TABLE_CODE.indexOf("function renderSectionDocMedia(row, segment)")
    );
    expect(prose).toContain('role="textbox"');
    expect(prose).toContain("activateSectionEditor(row, event);");
    expect(prose).toContain("onFocus={() => activateSectionEditor(row, null)}");
    // An IMAGE *and* a FILE segment are pressable too — a picture-only or
    // file-only Section has no prose box to press (Phase G correction). A press
    // on the file card's OWN controls is left alone.
    const media = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function renderSectionDocMedia(row, segment)"),
      TABLE_CODE.indexOf("function renderSectionDocSegmentBody(row, segment)")
    );
    expect(media).toContain("twocol-section-media--pressable");
    expect(media).toContain("segment.kind === SECTION_SEGMENT_KIND.IMAGE");
    expect(media).toContain("segment.kind === SECTION_SEGMENT_KIND.FILE");
    expect(media).toContain("if (pressIsOnMediaControl(event)) return;");
    expect(media).toContain("activateSectionEditor(row, event);");
    expect(TEMPLATE_CSS).toContain(".twocol-section-media--pressable {");
    expect(TEMPLATE_CSS).toContain(".twocol-section-media--card {");
    // The lead-in above a media-headed owned Section activates it as well.
    expect(TABLE_CODE).toContain("if (sectionEditorOwnsRow(row)) return renderSectionEditorLeadIn(row);");
    // The legacy per-item surfaces are not wired anywhere.
    for (const gone of [
      "renderSectionItemBody",
      "renderSectionSegment(row, sectionItem",
      "TemplateTextCell",
      "richText.onActivate",
      "onResizeSectionPhoto",
      "startItemDrag",
    ]) {
      expect({ gone, hit: TABLE_CODE.includes(gone) }).toEqual({ gone, hit: false });
    }
    // The static compat renderer still uses the read-only Photo presentation.
    expect(TABLE_CODE).toContain("<PhotoAttachment attachment={entry} readOnly />");
  });

  test("a row the editor may NOT own renders READ-ONLY, with no press handler", () => {
    const readOnly = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function renderSectionReadOnlyAnswer(row, value)"),
      TABLE_CODE.indexOf("function renderAnswerSlot(row, headSegment = null)")
    );
    expect(readOnly).toContain("twocol-rich twocol-rich--readonly");
    expect(readOnly).not.toContain('role="textbox"');
    expect(readOnly).not.toContain("onMouseDown");
    expect(readOnly).not.toContain("activateSectionEditor");
    expect(TEMPLATE_CSS).toContain(".twocol-rich--readonly {");
    // Its prose segments are plain boxes, and its answer control routes there.
    expect(TABLE_CODE).toContain('return <div className="twocol-rich">{body}</div>;');
    expect(TABLE_CODE).toContain("return renderSectionReadOnlyAnswer(row, value);");
    // A media-headed refused row gets no lead-in either.
    const slot = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function renderAnswerSlot(row, headSegment = null)"),
      TABLE_CODE.indexOf("function renderHeadMediaSlot(row, headSegment = null)")
    );
    expect(slot).toContain("if (sectionEditorOwnsRow(row)) return renderSectionEditorLeadIn(row);");
    expect(slot).toContain("return null;");
  });

  test("a Section that is being edited is NOT read statically — it is ONE editor segment", () => {
    const gate = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function sectionStaticSegments(row)"),
      TABLE_CODE.indexOf("function activateSectionEditor(row, event)")
    );
    expect(gate).toContain("if (isSectionEditorActive(row)) {");
    expect(gate).toContain("sectionEditorSegment({");
    expect(gate).toContain("minHeightPx: sectionEditor.editableRows[row.id].minHeightPx");
    expect(gate).toContain("return null");
    // STATIC ↔ LIVE PARITY: both open the SAME serialization of the SAME body.
    expect(NOTE_DOC_CODE).toContain("html: sectionBodyHtml(body)");
    expect(TABLE_CODE).toContain("sectionDocSegments(body)");
  });

  test("there is no legacy hand-back: every activation is the shared editor's, gated on ownership", () => {
    for (const gone of [
      "sectionCanHandBackToLegacy",
      "activateSectionTextSegment",
      "pendingCaretFor",
      "pendingSectionCaret",
      "isSectionCaretPending",
      "focusOnActivate=",
      "caretPoint=",
      "richText",
      "SECTION_BODY_SOURCE",
    ]) {
      expect({ gone, hit: TABLE_CODE.includes(gone) }).toEqual({ gone, hit: false });
    }
    const activation = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function activateSectionEditor(row, event)"),
      TABLE_CODE.indexOf("function renderSectionEditor(row)")
    );
    expect(activation).toContain("if (!sectionEditorOwnsRow(row)) return false;");
    expect(activation).toContain("sectionEditor.onActivate(row.id)");
    // Ownership is the parent's eligibility answer, never re-derived here.
    const owns = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function sectionEditorOwnsRow(row)"),
      TABLE_CODE.indexOf("function isSectionEditorActive(row)")
    );
    expect(owns).toContain("sectionEditor.editableRows[row.id]");
  });

  test("the caret the user pressed survives activation, stamped with its own editor identity", () => {
    // Activation re-plans the row onto ONE editor segment, so the component
    // that finally carries the editor is a different one from the static box
    // the user pressed. The point is stamped with the editor IDENTITY, so it
    // can only ever open the target it was aimed at.
    expect(TABLE_CODE).toContain("const sectionEditorCaret = useRef(null);");
    expect(TABLE_CODE).toContain(
      '{ mode: "point", left: event.clientX, top: event.clientY, identity }'
    );
    expect(TABLE_CODE).toContain('{ mode: "end", identity }');
    expect(TABLE_CODE).toContain("caretHintRef={sectionEditorCaret}");
    const editor = stripComments(read("components/template/TemplateSectionEditor.js"));
    expect(editor).toContain("if (hint.identity && hint.identity !== identity) return;");
    // Consumed once: the hint is cleared as it is read.
    expect(editor).toContain("if (caretHintRef) caretHintRef.current = null;");
  });

  test("52. no Template writer exists outside the editor's own update path", () => {
    // The legacy section writers are gone entirely…
    for (const file of [
      "lib/templateSectionAttachments.js",
      "lib/templateSectionText.js",
      "lib/templateSectionLeadingText.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: false,
      });
    }
    // …and the render layer writes nothing at all.
    for (const source of [TABLE_CODE, DOC_VIEW_CODE]) {
      for (const writer of [
        "appendSectionText",
        "appendSectionAttachment",
        "setRowSectionItems",
        "saveNoteTemplateInstance",
        "persistSectionDoc",
        "setRowSectionDoc",
        "saveInstanceConfirmed",
      ]) {
        expect({ writer, hit: source.includes(writer) }).toEqual({ writer, hit: false });
      }
    }
    // The form has ONE writer, called from the editor's update handler only.
    expect((NOTE_DOC_CODE.match(/persistSectionDoc\(rowId, html\)/g) || []).length).toBe(1);
    expect(NOTE_DOC_CODE).not.toContain("persistSectionContent");
  });

  test("18. Quick Add writes through the Section editor, routed two ways, never to sectionContent", () => {
    expect(NOTE_DOC_CODE).toContain("appendComposedAttachment");
    expect(NOTE_DOC_CODE).toContain("appendComposedText");
    expect(NOTE_DOC_CODE).toContain("const sectionDocQuickAddTarget = useCallback(");
    expect(NOTE_DOC_CODE).toContain("quickAdd[row.id] = resolveSectionQuickAddRoute(body);");
    expect(NOTE_DOC_CODE).toContain("SECTION_QUICK_ADD_ROUTE.REFUSE");
    expect(NOTE_DOC_CODE).not.toContain("SECTION_QUICK_ADD_ROUTE.LEGACY");
    expect(NOTE_DOC_CODE).not.toContain("appendSectionText");
    expect(NOTE_DOC_CODE).not.toContain("appendSectionAttachment");
  });

  test("53. Refine is the modern text-run Refine, addressed by run — the per-item Refine is gone", () => {
    expect(TABLE_CODE).toContain("function modernRefineTarget(row, segment)");
    expect(TABLE_CODE).toContain("sectionRefineTargetKey({ rowId: row.id, segmentIndex: runIndex })");
    for (const gone of ["sectionItemAcceptsAiRefine", "rowAcceptsAiRefine", "rowRefineTargetKey"]) {
      expect({ gone, hit: TABLE_CODE.includes(gone) }).toEqual({ gone, hit: false });
    }
    const refine = stripComments(read("lib/templateRowRefine.js"));
    // The status/message model stays surface-agnostic: it names no segment, no
    // body reader and no legacy target writer.
    expect(refine).not.toContain("segment");
    expect(refine).not.toContain("templateSectionBody");
    expect(refine).not.toContain("applySectionTextItemToInstance");
    expect(refine).not.toContain("applyRowAnswerToInstance");
  });

  test("54. export expands a DOCUMENT when a row has one, and the ordered list otherwise", () => {
    const exporter = stripComments(read("lib/templateExportModel.js"));
    // An edited Section must never export content that differs from what is
    // on screen. Since Phase F6b the exporter asks the SAME canonical body
    // reader the screen asks and projects the document through the SAME
    // segment projection (one wrap-group definition for screen and export);
    // an un-migrated row still takes the untouched ordered-list path.
    expect(exporter).toContain("sectionUnitsFor");
    expect(exporter).toContain("sectionDocUnitsFor");
    expect(exporter).toContain(
      "const hasDoc = body.source === SECTION_BODY_SOURCE.SECTION_DOC"
    );
    expect(exporter).toContain("resolveSectionBody");
    expect(exporter).toContain("sectionDocSegments");
    // It never re-derives validity or reaches for the raw document module's
    // row lookup: the shared reader decides, once.
    for (const forbidden of [
      "sectionDocNodesForRow",
      "isSectionDocValue",
      "parseSectionDocHtml",
    ]) {
      expect({ forbidden, hit: exporter.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });

  test("the Template Builder never renders note content, statically or otherwise", () => {
    // `sectionBodies` is note-mode only, exactly like attachments and evidence.
    const memo = TABLE_CODE.slice(
      TABLE_CODE.indexOf("const documentBodySegments = useMemo("),
      TABLE_CODE.indexOf("const sectionEditorCaret = useRef(null);")
    );
    expect(memo).toContain("!showRightEditor");
  });
});
