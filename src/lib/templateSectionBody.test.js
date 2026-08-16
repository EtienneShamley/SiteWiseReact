// src/lib/templateSectionBody.test.js
//
// THE AUTHORITY RULE — which stored representation a Section's body comes from,
// asked in the one place the whole product will ask it.
//
// Two guarantees dominate this suite:
//   - a malformed or unsupported modern document must NEVER make historical
//     Section content unreadable: it is ignored as an authority source and the
//     older representation renders exactly as it did before; and
//   - a structured row's typed value and a legacy Photo/File field's primary
//     attachments are never turned into document content.
import { SECTION_BODY_SOURCE, resolveSectionBody } from "./templateSectionBody";
import { SECTION_DOC_FORMAT, SECTION_DOC_NODE, sectionDocHtmlFromNodes } from "./templateSectionDoc";

const IMAGE_ID = "img-asset-0001";
const FILE_ID = "file-asset-0001";
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

const html = (body) => sectionDocHtmlFromNodes(body.nodes);
const types = (body) => body.nodes.map((n) => n.type);

/* ============================ the four steps ========================== */

describe("the authority rule", () => {
  const instance = {
    sectionDoc: { [ROW]: doc("<p>Modern document</p>") },
    sectionContent: { [ROW]: [text("t1", "Ordered content")] },
    answers: { [ROW]: "Legacy answer" },
    evidence: { [ROW]: [photo()] },
  };

  test("5. a valid modern document wins over every older representation", () => {
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(html(body)).toBe("<p>Modern document</p>");
    expect(body.skipped).toEqual([]);
  });

  test("2. with no modern document, ordered section content is authoritative", () => {
    const body = resolveSectionBody({
      instance: { ...instance, sectionDoc: {} },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(html(body)).toBe("<p>Ordered content</p>");
  });

  test("with neither, the legacy answer and its carryable evidence are authoritative", () => {
    const body = resolveSectionBody({
      instance: { ...instance, sectionDoc: {}, sectionContent: {} },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(types(body)).toEqual([SECTION_DOC_NODE.TEXT, SECTION_DOC_NODE.IMAGE]);
    expect(html(body)).toContain("<p>Legacy answer</p>");
  });

  test("ordered content outranks legacy evidence, so nothing is ever shown twice", () => {
    const body = resolveSectionBody({
      instance: { ...instance, sectionDoc: {} },
      rowId: ROW,
      rowType: "text",
    });
    expect(types(body)).toEqual([SECTION_DOC_NODE.TEXT]);
    expect(html(body)).not.toContain("data-asset-id");
  });

  test("an empty ordered list falls through to the legacy sources", () => {
    const body = resolveSectionBody({
      instance: {
        sectionContent: { [ROW]: [] },
        answers: { [ROW]: "Still here" },
      },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(html(body)).toBe("<p>Still here</p>");
  });

  test("an ordered list holding nothing renderable falls through too", () => {
    const body = resolveSectionBody({
      instance: {
        sectionContent: { [ROW]: [{ id: "x", kind: "sketch" }] },
        answers: { [ROW]: "Still here" },
      },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(html(body)).toBe("<p>Still here</p>");
  });

  test("resolving never mutates the instance", () => {
    const snapshot = JSON.parse(JSON.stringify(instance));
    resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
    resolveSectionBody({ instance, rowId: ROW, rowType: "number" });
    expect(instance).toEqual(snapshot);
  });

  test("a missing row id, a missing instance and a junk instance resolve to an empty body", () => {
    for (const args of [
      { instance, rowId: "", rowType: "text" },
      { instance, rowId: null, rowType: "text" },
      { instance: null, rowId: ROW, rowType: "number" },
      { instance: "junk", rowId: ROW, rowType: "select" },
      {},
    ]) {
      const body = resolveSectionBody(args);
      expect(body.source).toBe(SECTION_BODY_SOURCE.EMPTY);
      expect(body.nodes).toEqual([]);
    }
  });
});

/* ================== a bad document must not hide history ============== */

describe("11. a malformed or unsupported modern document falls back, never blanks the row", () => {
  const legacy = {
    sectionContent: { [ROW]: [text("t1", "Ordered content"), photo()] },
    answers: { [ROW]: "Legacy answer" },
  };

  const BROKEN = {
    "wrong format": { format: "sectiondoc/2", html: "<p>Future</p>" },
    "a legacy answer value pretending to be a document": {
      format: "richtext/1",
      html: "<p>Nope</p>",
    },
    "missing html": { format: SECTION_DOC_FORMAT },
    "non-string html": { format: SECTION_DOC_FORMAT, html: { html: "<p>x</p>" } },
    "null html": { format: SECTION_DOC_FORMAT, html: null },
    "empty html": { format: SECTION_DOC_FORMAT, html: "" },
    "no format at all": { html: "<p>Orphan</p>" },
    "not an object": "<p>Orphan</p>",
    "unsupported document content": { format: SECTION_DOC_FORMAT, html: "<script>x</script>" },
    "content whose media would be lost by normalization": {
      format: SECTION_DOC_FORMAT,
      html: `<p>Text <img data-asset-id="${IMAGE_ID}"> more</p>`,
    },
  };

  for (const [label, value] of Object.entries(BROKEN)) {
    test(`${label} → the ordered content still renders`, () => {
      const instance = { ...legacy, sectionDoc: { [ROW]: value } };
      const body = resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
      expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
      expect(html(body)).toContain("<p>Ordered content</p>");
      expect(html(body)).toContain(`data-asset-id="${IMAGE_ID}"`);
    });
  }

  test("a broken document falls all the way through to a legacy answer-only row", () => {
    const body = resolveSectionBody({
      instance: {
        sectionDoc: { [ROW]: { format: "sectiondoc/2", html: "<p>Future</p>" } },
        answers: { [ROW]: "Legacy answer" },
      },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(html(body)).toBe("<p>Legacy answer</p>");
  });

  test("reading a broken document does not repair, rewrite or delete it", () => {
    const broken = { format: "sectiondoc/2", html: "<p>Future</p>" };
    const instance = { ...legacy, sectionDoc: { [ROW]: broken } };
    const snapshot = JSON.parse(JSON.stringify(instance));
    resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
    expect(instance).toEqual(snapshot);
    expect(instance.sectionDoc[ROW]).toBe(broken);
  });

  test("one broken row never affects another row's body", () => {
    const instance = {
      sectionDoc: {
        [ROW]: { format: "sectiondoc/2", html: "<p>Future</p>" },
        "row-2": doc("<p>Fine</p>"),
      },
      answers: { [ROW]: "Legacy answer" },
    };
    expect(resolveSectionBody({ instance, rowId: ROW, rowType: "text" }).source).toBe(
      SECTION_BODY_SOURCE.LEGACY
    );
    expect(resolveSectionBody({ instance, rowId: "row-2", rowType: "text" }).source).toBe(
      SECTION_BODY_SOURCE.SECTION_DOC
    );
  });
});

/* ========================= row kinds ================================== */

describe("26/27. structured rows", () => {
  const structured = ["number", "date", "time", "checkbox", "yesno", "select"];

  test("26. a structured row's typed value is never document content", () => {
    for (const rowType of structured) {
      const body = resolveSectionBody({
        instance: { answers: { [ROW]: "42" } },
        rowId: ROW,
        rowType,
      });
      expect(body.source).toBe(SECTION_BODY_SOURCE.EMPTY);
      expect(body.nodes).toEqual([]);
    }
  });

  test("27. a structured row's supplementary content still adapts", () => {
    for (const rowType of structured) {
      const body = resolveSectionBody({
        instance: {
          answers: { [ROW]: "42" },
          sectionContent: { [ROW]: [text("t1", "Supplementary note"), file()] },
        },
        rowId: ROW,
        rowType,
      });
      expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
      expect(types(body)).toEqual([SECTION_DOC_NODE.TEXT, SECTION_DOC_NODE.FILE]);
      expect(html(body)).not.toContain("42");
    }
  });

  test("27. a structured row's supplementary evidence adapts without its typed value", () => {
    const body = resolveSectionBody({
      instance: { answers: { [ROW]: "42" }, evidence: { [ROW]: [photo()] } },
      rowId: ROW,
      rowType: "number",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(types(body)).toEqual([SECTION_DOC_NODE.IMAGE]);
    expect(html(body)).not.toContain("42");
  });

  test("a structured row may still hold a modern supplementary document", () => {
    const body = resolveSectionBody({
      instance: { answers: { [ROW]: "42" }, sectionDoc: { [ROW]: doc("<p>Note</p>") } },
      rowId: ROW,
      rowType: "date",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(html(body)).toBe("<p>Note</p>");
  });
});

describe("28. legacy Photo/File primary rows", () => {
  test("the primary attachments are never document content", () => {
    for (const rowType of ["photo", "file"]) {
      const body = resolveSectionBody({
        instance: {
          answers: { [ROW]: "not rendered on this row" },
          attachments: { [ROW]: [photo()] },
        },
        rowId: ROW,
        rowType,
        isAttachmentField: true,
      });
      expect(body.source).toBe(SECTION_BODY_SOURCE.EMPTY);
      expect(body.nodes).toEqual([]);
    }
  });

  test("their supplementary section content still adapts beneath the primary", () => {
    const body = resolveSectionBody({
      instance: {
        attachments: { [ROW]: [photo()] },
        sectionContent: { [ROW]: [text("t1", "Caption")] },
      },
      rowId: ROW,
      rowType: "photo",
      isAttachmentField: true,
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(html(body)).toBe("<p>Caption</p>");
  });

  test("a legacy Photo/File row rendered WITHOUT attachment rendering keeps the Section rule", () => {
    // The Template Builder renders no note content, so isAttachmentField is
    // false there — and the row is then treated as an ordinary Section.
    const body = resolveSectionBody({
      instance: { answers: { [ROW]: "Answer" } },
      rowId: ROW,
      rowType: "photo",
      isAttachmentField: false,
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(html(body)).toBe("<p>Answer</p>");
  });
});

describe("25. custom rows", () => {
  const CUSTOM = "custom-1";
  const instance = {
    answers: {},
    customRows: [
      { id: CUSTOM, templateId: "t", label: "Extra", type: "text", answer: "Custom answer" },
      { id: "other", templateId: "t", label: "Other", type: "text", answer: "Other answer" },
    ],
  };

  test("a custom row's own answer is its legacy body", () => {
    const body = resolveSectionBody({
      instance,
      rowId: CUSTOM,
      rowType: "text",
      isCustomRow: true,
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(html(body)).toBe("<p>Custom answer</p>");
  });

  test("a custom row's answer is read from the row, never from answers[rowId]", () => {
    const body = resolveSectionBody({
      instance: { ...instance, answers: { [CUSTOM]: "WRONG SOURCE" } },
      rowId: CUSTOM,
      rowType: "text",
      isCustomRow: true,
    });
    expect(html(body)).toBe("<p>Custom answer</p>");
  });

  test("a custom row's ordered content and modern document win in the same order", () => {
    const withItems = {
      ...instance,
      sectionContent: { [CUSTOM]: [text("t1", "Ordered"), photo()] },
    };
    expect(
      resolveSectionBody({ instance: withItems, rowId: CUSTOM, rowType: "text", isCustomRow: true })
        .source
    ).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);

    const withDoc = { ...withItems, sectionDoc: { [CUSTOM]: doc("<p>Modern</p>") } };
    const body = resolveSectionBody({
      instance: withDoc,
      rowId: CUSTOM,
      rowType: "text",
      isCustomRow: true,
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(html(body)).toBe("<p>Modern</p>");
  });

  test("a deleted custom row resolves to an empty body rather than another row's", () => {
    const body = resolveSectionBody({
      instance,
      rowId: "gone",
      rowType: "text",
      isCustomRow: true,
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(html(body)).toBe("<p></p>");
  });
});

describe("22. an ordinary Section row with nothing but an answer", () => {
  test("adapts to its text, and an untouched empty row is a typeable empty document", () => {
    expect(
      html(resolveSectionBody({ instance: { answers: { [ROW]: "Text" } }, rowId: ROW, rowType: "text" }))
    ).toBe("<p>Text</p>");
    expect(html(resolveSectionBody({ instance: {}, rowId: ROW, rowType: "text" }))).toBe("<p></p>");
    // A row whose type a newer version does not define is a Section too.
    expect(
      html(resolveSectionBody({ instance: { answers: { [ROW]: "T" } }, rowId: ROW }))
    ).toBe("<p>T</p>");
  });

  test("evidence that renders today but cannot be carried is reported, not lost", () => {
    const body = resolveSectionBody({
      instance: {
        answers: { [ROW]: "Answer" },
        evidence: { [ROW]: ["data:image/png;base64,AAAA", photo()] },
      },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(types(body)).toEqual([SECTION_DOC_NODE.TEXT, SECTION_DOC_NODE.IMAGE]);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].entry).toBe("data:image/png;base64,AAAA");
  });
});
