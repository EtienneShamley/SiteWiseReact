// src/lib/templateSectionStaticRead.test.js
//
// PHASE F3 — THE UNIFIED STATIC READ PATH.
//
// An inactive flexible Template Section renders from the canonical body reader,
// through the static Section view, one document block per segment. This suite
// holds the two things that decision has to be true for:
//
//   1. PARITY. For every historical Section the document plan is the SAME plan
//      the item list produces — same order, same block ids, same heights, same
//      group, same head, same tail — so a row can switch between its static
//      rendering and the legacy interactive one without the page moving, and so
//      nothing about pagination changes for any existing note.
//
//   2. BOUNDARIES. F3 switches reading and NOTHING else: no document is
//      written, no Section editor exists, no Template writer, Refine and export
//      are untouched, and not one legacy interaction helper was removed.
//
// Component-level facts are source assertions. That is this project's
// convention for React files that import `@tiptap/core` — which no Jest test in
// this project can load at all (see sectionEditorExtensions.js and
// .claude/NOTEWISE_HANDOFF.md §30.5) — and ResizableTwoColTable reaches it
// through TemplateTextCell.
import fs from "fs";
import path from "path";
import {
  ROW_BLOCK_KIND,
  planRowBlocks,
  sectionSegmentMinHeight,
} from "./templateRowContent";
import { SECTION_SEGMENT_KIND, sectionDocSegments } from "./templateSectionDocSegments";
import { SECTION_BODY_SOURCE, isSectionDocumentBody, resolveSectionBody } from "./templateSectionBody";
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

/** The two plans of ONE row, from ONE stored instance. */
function bothPlans(instance, over = {}) {
  const body = resolveSectionBody({ instance, rowId: ROW, rowType: "text", ...over.body });
  const common = {
    row: row(over.row),
    isAttachmentField: !!over.isAttachmentField,
    attachments: instance.attachments || null,
    evidence: instance.evidence || null,
    sectionExtraHeight: instance.sectionExtraHeight || null,
  };
  return {
    body,
    legacy: planRowBlocks({ ...common, sectionContent: instance.sectionContent || null }),
    document: planRowBlocks({ ...common, sectionSegments: sectionDocSegments(body) }),
  };
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

describe("46. the document plan and the item plan are the same plan", () => {
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

  test.each(Object.keys(CASES))("%s plans identically either way", (name) => {
    const { legacy, document } = bothPlans({ sectionContent: { [ROW]: CASES[name] } });
    expect(layoutOf(document)).toEqual(layoutOf(legacy));
  });

  test("only the block KIND differs — the same positions, renamed for the renderer", () => {
    const { legacy, document } = bothPlans({
      sectionContent: { [ROW]: CASES["text, photo, text, file"] },
    });
    expect(legacy.map((b) => b.kind)).toEqual(Array(4).fill(ROW_BLOCK_KIND.SECTION_ITEM));
    expect(document.map((b) => b.kind)).toEqual(
      Array(4).fill(ROW_BLOCK_KIND.SECTION_SEGMENT)
    );
  });

  test("every document block carries the segment its renderer needs, and no item", () => {
    const { document } = bothPlans({
      sectionContent: { [ROW]: CASES["text, photo, text, file"] },
    });
    for (const block of document) {
      expect(block.sectionSegment).toBeTruthy();
      expect(block.sectionItem).toBeNull();
    }
  });

  test("47. a Quick Add write to sectionContent shows up on the next read, with no migration", () => {
    const before = bothPlans({ sectionContent: { [ROW]: [text("t1", "A")] } });
    expect(before.document).toHaveLength(1);
    // Exactly what appendSectionText/appendSectionAttachment persist: one more
    // item on the raw list. Nothing else changes anywhere.
    const after = bothPlans({
      sectionContent: { [ROW]: [text("t1", "A"), photo(), text("t2", "Sent")] },
    });
    expect(after.document).toHaveLength(3);
    expect(layoutOf(after.document)).toEqual(layoutOf(after.legacy));
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

  test("the plan is identical either way for a structured row too", () => {
    const { legacy, document } = bothPlans(instance, {
      row: { type: "number" },
      body: { rowType: "number" },
    });
    expect(layoutOf(document)).toEqual(layoutOf(legacy));
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

  test("30. it plans exactly as a master Section does", () => {
    const body = resolveSectionBody({
      instance,
      rowId: CUSTOM,
      rowType: "text",
      isCustomRow: true,
    });
    const customRow = { id: CUSTOM, label: "Extra", px: 120, type: "text", isCustom: true };
    expect(
      layoutOf(planRowBlocks({ row: customRow, sectionSegments: sectionDocSegments(body) }))
    ).toEqual(
      layoutOf(
        planRowBlocks({ row: customRow, sectionContent: instance.sectionContent })
      )
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

  test("the plan is identical either way", () => {
    const { legacy, document } = bothPlans(instance, {
      isAttachmentField: true,
      row: { type: "photo" },
      body: { rowType: "photo", isAttachmentField: true },
    });
    expect(layoutOf(document)).toEqual(layoutOf(legacy));
  });
});

/* ============ 5/34-37. rows that have no document body yet ============ */

describe("5/34-37. a row still on its legacy answer/evidence is not published as a document", () => {
  test("34. answer + evidence has no document body yet — it keeps its legacy plan", () => {
    const body = resolveSectionBody({
      instance: { answers: { [ROW]: "Old answer" }, evidence: { [ROW]: [photo()] } },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(isSectionDocumentBody(body)).toBe(false);
  });

  test("35/36. evidence-only, and several evidence items, likewise", () => {
    for (const evidence of [[photo()], [photo(), file(), photo({ id: "p2" })]]) {
      const body = resolveSectionBody({
        instance: { evidence: { [ROW]: evidence } },
        rowId: ROW,
        rowType: "text",
      });
      expect(isSectionDocumentBody(body)).toBe(false);
    }
  });

  test("5. such a row plans the blocks it always has — the legacy answer and its evidence", () => {
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
  });

  test("only document bodies are published to the render tree", () => {
    // The one gate, stated once: NoteTemplateDoc publishes a body only when the
    // reader called it a document.
    expect(NOTE_DOC_CODE).toContain("if (isSectionDocumentBody(body)) bodies[row.id] = body;");
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
      NOTE_DOC_CODE.indexOf("const sectionBodies = useMemo("),
      NOTE_DOC_CODE.indexOf("const displaySectionExtraHeight")
    );
    expect(memo).toContain("resolveSectionBody");
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
    const legacyRule = TABLE_CODE.slice(
      TABLE_CODE.indexOf("const isPromptItem"),
      TABLE_CODE.indexOf("const isPromptItem") + 160
    );
    expect(legacyRule).toContain("firstText");
    // Both the head and every later segment ask the same question.
    expect(TABLE_CODE).toContain("isPrompt: isPromptSegment(row, headSegment)");
    expect(TABLE_CODE).toContain("isPrompt: isPromptSegment(row, segment)");
  });

  test("an empty prose segment still keeps its blank line — only the placeholder is conditional", () => {
    const empty = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function isEmptySegmentText"),
      TABLE_CODE.indexOf("function activateSectionTextSegment")
    );
    expect(empty).toContain('block.type === "paragraph"');
    expect(empty).toContain('node.type === "break"');
  });
});

describe("3. files use the Template's existing card, read-only", () => {
  test("no second file card is built", () => {
    expect(DOC_VIEW_CODE).toContain("FileAttachmentRow");
    expect(DOC_VIEW_CODE).not.toContain("file-att-row");
    expect(DOC_VIEW_CODE).not.toContain("note-file-attachment");
  });

  test("21. it keeps its open/download behaviour, and offers no Remove", () => {
    const card = DOC_VIEW_CODE.slice(
      DOC_VIEW_CODE.indexOf("<FileAttachmentRow"),
      DOC_VIEW_CODE.indexOf("SECTION_SEGMENT_KIND.IMAGE")
    );
    expect(card).toContain("onError");
    expect(card).not.toContain("onRemove");
  });
});

/* ==================== 11/51-55. what F3 did NOT do ==================== */

describe("51-55. the legacy interaction still owns editing, and everything else is untouched", () => {
  test("55. not one interaction helper was removed", () => {
    for (const file of [
      "components/template/TemplateRowEditor.js",
      "components/template/TemplateTextCell.js",
      "components/template/PhotoAttachment.js",
      "components/template/FileAttachmentRow.js",
      "lib/templateSectionItemDrop.js",
      "lib/templateSectionItemDragSession.js",
      "lib/templateSectionTextPoint.js",
      "lib/templateSectionTextSplit.js",
      "lib/templateSectionTextHeal.js",
      "lib/templateSectionLeadingText.js",
      "lib/templateSectionImagePlacement.js",
      "lib/templateSectionImageResize.js",
      "lib/templateSectionReorder.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: true,
      });
    }
  });

  test("11. the legacy per-item rendering is still wired, and still reachable", () => {
    // The row hands itself back to it the moment the user presses its text.
    expect(TABLE_CODE).toContain("renderSectionItemBody");
    expect(TABLE_CODE).toContain("renderSectionSegment(row, sectionItem");
    expect(TABLE_CODE).toContain("TemplateTextCell");
    expect(TABLE_CODE).toContain("PhotoAttachment");
    expect(TABLE_CODE).toContain("richText.onActivate(row.id, item.id)");
    expect(TABLE_CODE).toContain("onResizeSectionPhoto");
    expect(TABLE_CODE).toContain("startItemDrag");
  });

  test("a Section that is being edited is NOT read statically", () => {
    const gate = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function sectionStaticSegments(row)"),
      TABLE_CODE.indexOf("function segmentLegacyItem")
    );
    expect(gate).toContain("richText.activeRowId === row.id");
    expect(gate).toContain("richText.leadingRowId === row.id");
    expect(gate).toContain("return null");
  });

  test("a MODERN document row cannot hand itself to the legacy interaction", () => {
    // The legacy plan renders stored ITEMS. A row whose body is a modern
    // document has none behind it, so handing it over would show a different
    // document — the frozen legacy answer, or nothing at all. Both the text
    // activation and the leading caret refuse it, from one predicate.
    expect(TABLE_CODE).toContain("editable: body.source === SECTION_BODY_SOURCE.SECTION_CONTENT");
    expect(TABLE_CODE).toContain("function sectionCanHandBackToLegacy(row)");
    const activation = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function activateSectionTextSegment"),
      TABLE_CODE.indexOf("function pendingCaretFor")
    );
    expect(activation).toContain("if (!sectionCanHandBackToLegacy(row)) return;");
    const slot = TABLE_CODE.slice(
      TABLE_CODE.indexOf("function renderAnswerSlot"),
      TABLE_CODE.indexOf("function renderHeadMediaSlot")
    );
    expect(slot).toContain("if (!sectionCanHandBackToLegacy(row)) return null;");
  });

  test("the caret the user pressed survives the hand-back, stamped with its own target", () => {
    // Activation re-plans the row onto the legacy blocks, so the cell that ends
    // up carrying the editor is a NEW instance. The point is matched on the
    // editor IDENTITY, so it can only ever open the target it was aimed at.
    expect(TABLE_CODE).toContain("pendingSectionCaret");
    expect(TABLE_CODE).toContain("pending.identity !== identity");
    expect(TABLE_CODE).toContain("focusOnActivate={isSectionCaretPending(identity)}");
    expect(TABLE_CODE).toContain("caretPoint={pendingCaretFor(identity)}");
    const cell = stripComments(read("components/template/TemplateTextCell.js"));
    expect(cell).toContain('caretPoint && typeof caretPoint.left === "number"');
    expect(cell).toContain('{ mode: "point", left: caretPoint.left, top: caretPoint.top, identity }');
  });

  test("52. no new Template writer exists — the section writers are untouched", () => {
    const writers = stripComments(read("lib/templateSectionAttachments.js"));
    expect(writers).toContain("appendSectionAttachment");
    for (const source of [TABLE_CODE, DOC_VIEW_CODE]) {
      for (const writer of [
        "appendSectionText",
        "appendSectionAttachment",
        "setRowSectionItems",
        "saveNoteTemplateInstance",
      ]) {
        expect({ writer, hit: source.includes(writer) }).toEqual({ writer, hit: false });
      }
    }
  });

  test("18. Quick Add still writes the ordered item list, through the paths it always has", () => {
    expect(NOTE_DOC_CODE).toContain("appendComposedAttachment");
    expect(NOTE_DOC_CODE).toContain("appendComposedText");
    expect(NOTE_DOC_CODE).toContain("persistSectionContent");
  });

  test("53. Refine is unchanged — still per stored TEXT ITEM, addressed by its own id", () => {
    expect(TABLE_CODE).toContain("sectionItemAcceptsAiRefine");
    expect(TABLE_CODE).toContain("rowRefineTargetKey");
    const refine = stripComments(read("lib/templateRowRefine.js"));
    expect(refine).not.toContain("segment");
    expect(refine).not.toContain("templateSectionBody");
    // A static prose segment offers the SAME per-item trigger, on the same item.
    expect(TABLE_CODE).toContain(
      "sectionItemAcceptsAiRefine(row, item)"
    );
  });

  test("54. export still expands the ordered item list — no document reaches it", () => {
    const exporter = stripComments(read("lib/templateExportModel.js"));
    expect(exporter).toContain("sectionUnitsFor");
    for (const forbidden of [
      "templateSectionBody",
      "templateSectionDocSegments",
      "resolveSectionBody",
      "sectionDocUnits",
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
      TABLE_CODE.indexOf("const pendingSectionCaret")
    );
    expect(memo).toContain("!showRightEditor");
  });
});
