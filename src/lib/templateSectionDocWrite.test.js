// src/lib/templateSectionDocWrite.test.js
//
// Phase F4 — WHAT MAY BECOME A MODERN SECTION DOCUMENT, AND WHAT IS WRITTEN.
//
// The pure half of the Section editor: which resolved bodies may be opened at
// all, the document each one opens with, and the stored map a first genuine
// edit produces. The component wiring that consumes these is asserted in
// templateSectionEditorWiring.test.js; the retained-editor lifecycle is in
// sectionEditorRegistry.test.js.
//
// The load-bearing suite here is LOSSLESS SAFETY: a Section carrying material
// the shared document cannot represent must never be able to become one, and
// nothing about such a row may be dropped, moved, truncated, re-minted or
// partially written to make an edit possible.

import {
  SECTION_BODY_SOURCE,
  SECTION_EDITOR_REFUSAL,
  canEditSectionBody,
  isPlainLegacyTextBody,
  resolveSectionBody,
  sectionBodyHtml,
  sectionEditorEligibility,
} from "./templateSectionBody";
import {
  SECTION_DOC_FORMAT,
  isSectionDocValue,
  makeSectionDocValue,
  parseSectionDocHtml,
  removeRowSectionDoc,
  sectionDocNodesForRow,
  sectionDocRowAssetIds,
  setRowSectionDoc,
} from "./templateSectionDoc";
import { SECTION_DOC_SKIP_REASON } from "./templateSectionDocAdapter";
import { isAnswerValue } from "./templateRichText";

const ROW = "row-1";

const text = (id, value) => ({ id, kind: "text", value });
const photo = ({ id = "p1", assetId = "asset-photo-1", widthPct = 60 } = {}) => ({
  id,
  kind: "photo",
  assetId,
  name: "site.jpg",
  mimeType: "image/jpeg",
  size: 1234,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct, alignment: "left" },
});
const file = ({ id = "f1", assetId = "asset-file-1" } = {}) => ({
  id,
  kind: "file",
  assetId,
  name: "report.pdf",
  mimeType: "application/pdf",
  size: 4321,
});

function bodyOf(instance, extra = {}) {
  return resolveSectionBody({ instance, rowId: ROW, rowType: "text", ...extra });
}

/* ============ 7-10. what a Section editor is initialized with ============ */

describe("7-10. initialization: the document a Section opens with", () => {
  test("7. a VALID stored sectionDoc initializes the editor from itself", () => {
    const html = "<p>Modern body</p>";
    const body = bodyOf({ sectionDoc: { [ROW]: makeSectionDocValue(html) } });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(canEditSectionBody(body)).toBe(true);
    // Re-serializing the nodes it parsed to is byte-stable, so the editor opens
    // exactly the document that is stored.
    expect(sectionBodyHtml(body)).toBe(html);
    expect(parseSectionDocHtml(sectionBodyHtml(body))).toEqual(body.nodes);
  });

  test("8. legacy sectionContent initializes an ADAPTED document, in stored order", () => {
    const body = bodyOf({
      sectionContent: { [ROW]: [text("t1", "Before"), photo(), text("t2", "After"), file()] },
      answers: { [ROW]: "Frozen legacy answer" },
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(canEditSectionBody(body)).toBe(true);
    expect(body.nodes.map((n) => n.type)).toEqual(["text", "image", "text", "file"]);

    const html = sectionBodyHtml(body);
    expect(html).toContain("Before");
    expect(html).toContain("After");
    expect(html).toContain("asset-photo-1");
    expect(html).toContain("asset-file-1");
    // The frozen answer is NOT part of the document it opens with.
    expect(html).not.toContain("Frozen legacy answer");
    // What is parsed back is what was adapted — the editor and the static view
    // therefore open the same document.
    expect(parseSectionDocHtml(html)).toEqual(body.nodes);
  });

  test("9. a legacy ANSWER initializes an adapted document where it is supported", () => {
    const body = bodyOf({ answers: { [ROW]: "An older note's text" } });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(isPlainLegacyTextBody(body)).toBe(true);
    expect(canEditSectionBody(body)).toBe(true);
    expect(sectionBodyHtml(body)).toBe("<p>An older note's text</p>");
  });

  test("9. an EMPTY legacy answer still opens as one typeable empty paragraph", () => {
    const body = bodyOf({ answers: { [ROW]: "" } });
    expect(isPlainLegacyTextBody(body)).toBe(true);
    expect(canEditSectionBody(body)).toBe(true);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].type).toBe("text");
  });

  test("9. a legacy body carrying EVIDENCE is not opened — it keeps its own blocks", () => {
    // Carryable evidence would become document media, which is a change to the
    // READ path (those items render today as the row's own evidence blocks,
    // with their own display and removal controls). Such a row keeps the path
    // it has; its first edit still materialises `sectionContent`, and it
    // becomes a document Section from then on.
    const body = bodyOf({
      answers: { [ROW]: "Text" },
      evidence: { [ROW]: [photo({ id: "ev1" })] },
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(body.nodes.map((n) => n.type)).toEqual(["text", "image"]);
    expect(isPlainLegacyTextBody(body)).toBe(false);
  });

  test("a structured row's supplementary body is a document; its typed value never is", () => {
    const instance = {
      answers: { [ROW]: "42" },
      sectionContent: { [ROW]: [text("t1", "A note about the reading")] },
    };
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: "number" });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(canEditSectionBody(body)).toBe(true);
    expect(sectionBodyHtml(body)).toContain("A note about the reading");
    expect(sectionBodyHtml(body)).not.toContain("42");
  });

  test("a structured row with NOTHING supplementary has no editor at all", () => {
    const body = resolveSectionBody({
      instance: { answers: { [ROW]: "42" } },
      rowId: ROW,
      rowType: "number",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.EMPTY);
    expect(sectionEditorEligibility(body)).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.NO_BODY,
    });
    expect(sectionBodyHtml(body)).toBe("");
  });

  test("a legacy Photo/File PRIMARY row is never converted; only its supplement is", () => {
    const instance = {
      attachments: { [ROW]: [photo({ id: "primary", assetId: "asset-primary" })] },
      sectionContent: { [ROW]: [text("t1", "Supplementary note")] },
    };
    const body = resolveSectionBody({
      instance,
      rowId: ROW,
      rowType: "photo",
      isAttachmentField: true,
    });
    expect(canEditSectionBody(body)).toBe(true);
    const html = sectionBodyHtml(body);
    expect(html).toContain("Supplementary note");
    expect(html).not.toContain("asset-primary");
  });

  test("10. resolving and serializing a body writes NOTHING and mutates nothing", () => {
    const instance = {
      sectionDoc: {},
      sectionContent: { [ROW]: [text("t1", "A"), photo(), file()] },
      answers: { [ROW]: "Frozen" },
      evidence: { [ROW]: [photo({ id: "ev" })] },
    };
    const snapshot = JSON.parse(JSON.stringify(instance));
    const first = bodyOf(instance);
    const second = bodyOf(instance);
    sectionBodyHtml(first);
    sectionBodyHtml(second);
    expect(second).toEqual(first);
    expect(sectionBodyHtml(second)).toBe(sectionBodyHtml(first));
    expect(instance).toEqual(snapshot);
    expect(instance.sectionDoc).toEqual({});
  });
});

/* ================ 11-15. the first genuine modern write ================ */

describe("11-15. the first genuine edit creates the document, and freezes the rest", () => {
  test("11/12. one row's document is written; every other collection is carried through", () => {
    const instance = {
      noteId: "note-1",
      answers: { [ROW]: "Frozen answer", other: "untouched" },
      attachments: { [ROW]: [] },
      evidence: { [ROW]: [photo({ id: "ev" })] },
      sectionContent: { [ROW]: [text("t1", "A"), photo()], "row-2": [text("t9", "B")] },
      sectionDoc: {},
    };
    const nextDoc = setRowSectionDoc(instance.sectionDoc, ROW, "<p>A edited</p><img data-asset-id=\"asset-photo-1\">");
    const next = { ...instance, sectionDoc: nextDoc };

    expect(isSectionDocValue(next.sectionDoc[ROW])).toBe(true);
    expect(next.sectionDoc[ROW].format).toBe(SECTION_DOC_FORMAT);
    // 15. Everything older is RETAINED, not cleared.
    expect(next.answers).toEqual(instance.answers);
    expect(next.evidence).toEqual(instance.evidence);
    expect(next.sectionContent).toEqual(instance.sectionContent);
    expect(next.sectionContent[ROW]).toBe(instance.sectionContent[ROW]);
    // …and no other row gained a document.
    expect(Object.keys(next.sectionDoc)).toEqual([ROW]);
  });

  test("the document becomes AUTHORITATIVE the moment it is valid", () => {
    const instance = {
      sectionContent: { [ROW]: [text("t1", "Old ordered text")] },
      answers: { [ROW]: "Older answer still" },
      sectionDoc: setRowSectionDoc({}, ROW, "<p>The modern body</p>"),
    };
    const body = bodyOf(instance);
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(sectionBodyHtml(body)).toBe("<p>The modern body</p>");
  });

  test("13/14. a write that changes nothing produces an identical map entry", () => {
    // The writer refuses when the serialization matches what is stored (that
    // comparison lives in NoteTemplateDoc and is asserted in the wiring suite);
    // the model's part is that the same html always mints the same value.
    const first = setRowSectionDoc({}, ROW, "<p>Same</p>");
    const second = setRowSectionDoc(first, ROW, "<p>Same</p>");
    expect(second[ROW]).toEqual(first[ROW]);
  });

  test("an unusable serialization writes NOTHING rather than a partial document", () => {
    const before = { [ROW]: makeSectionDocValue("<p>Good</p>") };
    expect(setRowSectionDoc(before, ROW, null)).toBe(before);
    expect(setRowSectionDoc(before, ROW, undefined)).toBe(before);
    expect(setRowSectionDoc(before, ROW, 42)).toBe(before);
    expect(setRowSectionDoc(before, "", "<p>x</p>")).toBe(before);
    expect(before[ROW].html).toBe("<p>Good</p>");
  });

  test("the format string is minted in one place, and is not an answer value", () => {
    const value = setRowSectionDoc({}, ROW, "<p>x</p>")[ROW];
    expect(value.format).toBe(SECTION_DOC_FORMAT);
    // The answer model must never accept it — the answer normalizer would drop
    // every image in it and `answerIdentity` would call an image-only change
    // unchanged.
    expect(isAnswerValue(value)).toBe(false);
  });

  test("no TemplateVersion, template id or version id is touched by a write", () => {
    const instance = {
      noteId: "note-1",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      sectionDoc: {},
    };
    const next = { ...instance, sectionDoc: setRowSectionDoc(instance.sectionDoc, ROW, "<p>x</p>") };
    expect(next.templateId).toBe("tpl-1");
    expect(next.templateVersionId).toBe("ver-1");
    expect(Object.keys(next).sort()).toEqual(
      ["noteId", "sectionDoc", "templateId", "templateVersionId"].sort()
    );
  });
});

/* ================== 16-19. LOSSLESS SAFETY (critical) ================== */

describe("16-19. a Section may not become a document by losing anything", () => {
  const LONG_ID = `note-att-${"a".repeat(40)}-${"b".repeat(40)}-1`;

  test("16/17. an unrepresentable stored item REFUSES the whole migration", () => {
    // The shared file serializer will not carry this id, so the document would
    // be missing the user's file. Refusing is the only safe answer: the row
    // keeps rendering and editing exactly as it does today.
    const body = bodyOf({
      sectionContent: {
        [ROW]: [text("t1", "Before"), file({ id: "f1", assetId: LONG_ID }), text("t2", "After")],
      },
    });
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toBe(SECTION_DOC_SKIP_REASON.FILE);
    expect(sectionEditorEligibility(body)).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.UNREPRESENTABLE,
    });
    expect(canEditSectionBody(body)).toBe(false);
    // …and no document is offered at all, so none can be persisted.
    expect(sectionBodyHtml(body)).toBe("");
  });

  test("18. the historical id is preserved EXACTLY — never truncated or re-minted", () => {
    const stored = {
      sectionContent: { [ROW]: [file({ id: "f1", assetId: LONG_ID })] },
    };
    const snapshot = JSON.parse(JSON.stringify(stored));
    const body = bodyOf(stored);
    // It is reported with its own identity and its own stored entry, untouched.
    expect(body.skipped[0].id).toBe("f1");
    expect(body.skipped[0].index).toBe(0);
    expect(body.skipped[0].entry.assetId).toBe(LONG_ID);
    expect(stored).toEqual(snapshot);
  });

  test("16. an unrepresentable LEGACY EVIDENCE entry refuses the migration too", () => {
    const body = bodyOf({
      answers: { [ROW]: "Text" },
      // A legacy base64 string: it renders today through the tolerant evidence
      // path, and cannot enter a document.
      evidence: { [ROW]: ["data:image/png;base64,AAAA"] },
    });
    expect(body.skipped.map((s) => s.reason)).toEqual([
      SECTION_DOC_SKIP_REASON.LEGACY_EVIDENCE,
    ]);
    expect(sectionEditorEligibility(body).reason).toBe(
      SECTION_EDITOR_REFUSAL.UNREPRESENTABLE
    );
  });

  test("16. an image whose asset id could not survive an attribute refuses it as well", () => {
    const body = bodyOf({
      sectionContent: {
        [ROW]: [photo({ id: "p1", assetId: 'asset "quoted" id' }), text("t1", "After")],
      },
    });
    expect(body.skipped[0].reason).toBe(SECTION_DOC_SKIP_REASON.IMAGE);
    expect(canEditSectionBody(body)).toBe(false);
  });

  test("19. therefore no partial document exists: the whole body is representable or none is", () => {
    const clean = bodyOf({
      sectionContent: { [ROW]: [text("t1", "A"), photo(), text("t2", "B"), file()] },
    });
    expect(clean.skipped).toEqual([]);
    expect(canEditSectionBody(clean)).toBe(true);
    // Every stored item that renders is in the document.
    const html = sectionBodyHtml(clean);
    expect(html).toContain("A");
    expect(html).toContain("B");
    expect(html).toContain("asset-photo-1");
    expect(html).toContain("asset-file-1");
  });

  test("a document that CANNOT be safely normalized is refused as an authority AND as an editor", () => {
    // An image nested where the prose whitelist would drop it: rendering the
    // Section from it would silently lose the photograph.
    const instance = {
      sectionDoc: {
        [ROW]: { format: SECTION_DOC_FORMAT, html: '<p>Text <img data-asset-id="asset-x"></p>' },
      },
      answers: { [ROW]: "The older body, still shown" },
    };
    expect(sectionDocNodesForRow(instance.sectionDoc, ROW)).toBeNull();
    const body = bodyOf(instance);
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    // …and the raw value is left exactly as it is.
    expect(instance.sectionDoc[ROW].html).toContain("asset-x");
  });

  test("an empty resolved body is refused with its own reason", () => {
    expect(sectionEditorEligibility({ source: SECTION_BODY_SOURCE.SECTION_DOC, nodes: [], skipped: [] })).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.EMPTY_DOCUMENT,
    });
    expect(sectionEditorEligibility(null).reason).toBe(SECTION_EDITOR_REFUSAL.NO_BODY);
  });
});

/* ==================== 20-23. one continuous document ==================== */

describe("20-23. the modern editing model is one document, with no split provenance", () => {
  test("20. two independent captures become two blocks of ONE document", () => {
    const body = bodyOf({
      sectionContent: { [ROW]: [text("t1", "First capture"), text("t2", "Second capture")] },
    });
    // One text node: a run of prose between two media nodes IS one stretch of
    // document — but the paragraph boundary between the captures survives.
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].blocks).toHaveLength(2);
    const html = sectionBodyHtml(body);
    expect(html).toBe("<p>First capture</p><p>Second capture</p>");
  });

  test("21. formatting, lists and links survive into the document unchanged", () => {
    const rich = {
      format: "richtext/1",
      html: '<p><strong>Bold</strong> and <em>italic</em></p><ul><li><p>One</p></li></ul><p><a href="https://example.com">link</a></p>',
    };
    const body = bodyOf({ sectionContent: { [ROW]: [text("t1", rich)] } });
    const html = sectionBodyHtml(body);
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<ul>");
    expect(html).toContain('href="https://example.com/"');
  });

  test("22. a capture's intended boundary is preserved on migration; media order is exact", () => {
    const body = bodyOf({
      sectionContent: {
        [ROW]: [text("t1", "Para one"), photo(), text("t2", "Para two"), file(), text("t3", "Para three")],
      },
    });
    expect(body.nodes.map((n) => n.type)).toEqual([
      "text",
      "image",
      "text",
      "file",
      "text",
    ]);
    const html = sectionBodyHtml(body);
    expect(html.indexOf("Para one")).toBeLessThan(html.indexOf("asset-photo-1"));
    expect(html.indexOf("asset-photo-1")).toBeLessThan(html.indexOf("Para two"));
    expect(html.indexOf("Para two")).toBeLessThan(html.indexOf("asset-file-1"));
    expect(html.indexOf("asset-file-1")).toBeLessThan(html.indexOf("Para three"));
  });

  test("23. `continuesFrom` never reaches the modern document", () => {
    const body = bodyOf({
      sectionContent: {
        [ROW]: [
          text("t1", "Left half"),
          { ...text("t2", "Right half"), continuesFrom: { itemId: "t1", mode: "inline" } },
        ],
      },
    });
    const html = sectionBodyHtml(body);
    expect(html).not.toContain("continuesFrom");
    expect(JSON.stringify(body.nodes)).not.toContain("continuesFrom");
  });
});

/* ====================== row deletion / asset safety ====================== */

describe("deleting a row prunes its document, and its assets become candidates", () => {
  test("the entry is removed and every other row's is carried through", () => {
    const map = {
      [ROW]: makeSectionDocValue("<p>A</p>"),
      "row-2": makeSectionDocValue("<p>B</p>"),
    };
    const next = removeRowSectionDoc(map, ROW);
    expect(Object.keys(next)).toEqual(["row-2"]);
    expect(next["row-2"]).toBe(map["row-2"]);
    // Nothing to remove is not a rewrite.
    expect(removeRowSectionDoc(next, ROW)).toBe(next);
    expect(removeRowSectionDoc(null, ROW)).toEqual({});
  });

  test("its asset ids are reported, de-duplicated, whatever the entry claims", () => {
    const html =
      '<p>A</p><img data-asset-id="asset-photo-1"><div class="note-file-attachment" data-file-asset-id="asset-file-1" data-file-name="r.pdf" data-file-size="1" data-file-type="application/pdf"></div><img data-asset-id="asset-photo-1">';
    const map = { [ROW]: { format: "sectiondoc/99", html } };
    const ids = sectionDocRowAssetIds(map, ROW);
    expect(ids.sort()).toEqual(["asset-file-1", "asset-photo-1"]);
    expect(sectionDocRowAssetIds(map, "nobody")).toEqual([]);
    expect(sectionDocRowAssetIds(null, ROW)).toEqual([]);
  });
});
