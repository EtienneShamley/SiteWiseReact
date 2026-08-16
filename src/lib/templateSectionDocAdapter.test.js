// src/lib/templateSectionDocAdapter.test.js
//
// Converting every legacy Section representation into ONE ordered document,
// without writing anything.
//
// The two rules under the most pressure here are opposites of each other:
// fragments of one image-induced split MUST heal back together, and two
// independently captured text items MUST NOT — however adjacent they are.
import {
  SECTION_DOC_SKIP_REASON,
  adaptLegacyBodyToNodes,
  adaptSectionItemsToNodes,
} from "./templateSectionDocAdapter";
import {
  SECTION_DOC_NODE,
  parseSectionDocHtml,
  sectionDocHtmlFromNodes,
} from "./templateSectionDoc";
import { SECTION_ITEM_KIND, SECTION_TEXT_JOIN } from "./templateSectionContent";
import { MEDIA_LAYOUT_MODE } from "./editorMediaLayout";

const IMAGE_ID = "img-asset-0001";
const FILE_ID = "file-asset-0001";
const PHOTO_ITEM_ID = "item-photo";
const FILE_ITEM_ID = "item-file";

const text = (id, value) => ({ id, kind: "text", value });
const photo = (over = {}) => ({
  id: PHOTO_ITEM_ID,
  kind: "photo",
  assetId: IMAGE_ID,
  name: "site.jpg",
  mimeType: "image/jpeg",
  size: 1024,
  createdAt: 111,
  intrinsicWidth: 1600,
  intrinsicHeight: 1200,
  display: { widthPct: 60, alignment: "left" },
  ...over,
});
const file = (over = {}) => ({
  id: FILE_ITEM_ID,
  kind: "file",
  assetId: FILE_ID,
  name: "Report.pdf",
  mimeType: "application/pdf",
  size: 2048,
  createdAt: 222,
  ...over,
});

const types = (nodes) => nodes.map((n) => n.type);
const html = (nodes) => sectionDocHtmlFromNodes(nodes);

/* ============================ order + shape =========================== */

describe("ordered section content becomes one ordered document", () => {
  test("text A, photo B, text C, file D convert in exactly that order", () => {
    const { nodes, skipped } = adaptSectionItemsToNodes([
      text("t1", "A"),
      photo(),
      text("t2", "C"),
      file(),
    ]);
    expect(types(nodes)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.FILE,
    ]);
    expect(skipped).toEqual([]);
    expect(html(nodes)).toBe(
      `<p>A</p><img data-asset-id="${IMAGE_ID}" alt="site.jpg" width="1600" height="1200" data-width-pct="60">` +
        `<p>C</p><div class="note-file-attachment" data-file-asset-id="${FILE_ID}" ` +
        `data-file-name="Report.pdf" data-file-size="2048" data-file-type="application/pdf"></div>`
    );
  });

  test("an adapted document and the same document read back from storage are identical", () => {
    const { nodes } = adaptSectionItemsToNodes([
      text("t1", "A"),
      photo(),
      text("t2", "C"),
      file(),
    ]);
    expect(parseSectionDocHtml(html(nodes))).toEqual(nodes);
  });

  test("adapting is idempotent and mutates nothing", () => {
    const items = [text("t1", "A"), photo(), text("t2", "C")];
    const snapshot = JSON.parse(JSON.stringify(items));
    const first = adaptSectionItemsToNodes(items);
    const second = adaptSectionItemsToNodes(items);
    expect(second).toEqual(first);
    expect(items).toEqual(snapshot);
  });

  test("a non-list, an empty list and unrenderable entries produce no document", () => {
    expect(adaptSectionItemsToNodes(null)).toEqual({
      nodes: [],
      sources: [],
      skipped: [],
    });
    expect(adaptSectionItemsToNodes([])).toEqual({
      nodes: [],
      sources: [],
      skipped: [],
    });
    // Invisible today (unknown kind, id-less text) => invisible in the document.
    const { nodes, skipped } = adaptSectionItemsToNodes([
      { id: "x", kind: "sketch", assetId: "a" },
      { kind: "text", value: "no id" },
      "legacy-base64-string",
    ]);
    expect(nodes).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

/* ================================ text ================================ */

describe("text conversion", () => {
  test("6. a plain TextItem adapts through the existing answer boundary", () => {
    const { nodes } = adaptSectionItemsToNodes([text("t1", "Line one\nLine two")]);
    expect(html(nodes)).toBe("<p>Line one</p><p>Line two</p>");
  });

  test("a legacy string that looks like markup stays literal characters", () => {
    const { nodes } = adaptSectionItemsToNodes([text("t1", "<b>Inspection failed</b>")]);
    expect(html(nodes)).toBe("<p>&lt;b&gt;Inspection failed&lt;/b&gt;</p>");
  });

  test("7. a rich TextItem keeps paragraphs, marks, lists, alignment and links", () => {
    const rich = {
      format: "richtext/1",
      html:
        '<p style="text-align: center"><strong>Bold</strong> <em>italic</em> ' +
        '<u>under</u> <s>strike</s> <a href="https://example.com">link</a></p>' +
        "<ul><li><p>One</p></li><li><p>Two</p></li></ul>",
    };
    const { nodes } = adaptSectionItemsToNodes([text("t1", rich)]);
    expect(html(nodes)).toBe(
      '<p style="text-align: center"><strong>Bold</strong> <em>italic</em> ' +
        // the href is normalized by the project's existing URL policy
        '<u>under</u> <s>strike</s> <a href="https://example.com/">link</a></p>' +
        "<ul><li><p>One</p></li><li><p>Two</p></li></ul>"
    );
  });

  test("an empty TextItem keeps its blank paragraph", () => {
    const { nodes } = adaptSectionItemsToNodes([text("t1", ""), photo()]);
    expect(types(nodes)).toEqual([SECTION_DOC_NODE.TEXT, SECTION_DOC_NODE.IMAGE]);
    expect(html(nodes).startsWith("<p></p>")).toBe(true);
  });

  test("8/9. independent TextItems stay independent blocks and are never joined", () => {
    // Two Quick Add sends. They carry no provenance, so their content must not
    // run together — they are separate paragraphs in one stretch of prose.
    const { nodes } = adaptSectionItemsToNodes([
      text("t1", "First capture"),
      text("t2", "Second capture"),
    ]);
    expect(types(nodes)).toEqual([SECTION_DOC_NODE.TEXT]);
    expect(nodes[0].blocks).toHaveLength(2);
    expect(html(nodes)).toBe("<p>First capture</p><p>Second capture</p>");
  });
});

/* ========================== split provenance ========================== */

describe("continuesFrom is compatibility-only and ends at the adapter", () => {
  test("10/11. an adjacent inline split heals, and the provenance is gone", () => {
    const { nodes } = adaptSectionItemsToNodes([
      text("t1", "The excavation started this morning "),
      {
        ...text("t2", "and conditions were wet."),
        continuesFrom: { itemId: "t1", join: SECTION_TEXT_JOIN.INLINE },
      },
    ]);
    expect(html(nodes)).toBe(
      "<p>The excavation started this morning and conditions were wet.</p>"
    );
    expect(JSON.stringify(nodes)).not.toContain("continuesFrom");
  });

  test("10. an adjacent BLOCK split heals while keeping the user's own boundary", () => {
    const { nodes } = adaptSectionItemsToNodes([
      text("t1", "Paragraph one"),
      {
        ...text("t2", "Paragraph two"),
        continuesFrom: { itemId: "t1", join: SECTION_TEXT_JOIN.BLOCK },
      },
    ]);
    expect(html(nodes)).toBe("<p>Paragraph one</p><p>Paragraph two</p>");
  });

  test("12. unrelated adjacent text never heals, even inline-looking text", () => {
    const { nodes } = adaptSectionItemsToNodes([
      text("t1", "The excavation started this morning "),
      text("t2", "and conditions were wet."),
    ]);
    expect(html(nodes)).toBe(
      "<p>The excavation started this morning </p><p>and conditions were wet.</p>"
    );
  });

  test("13. a split whose image is still between the halves does NOT heal", () => {
    const { nodes } = adaptSectionItemsToNodes([
      text("t1", "The excavation started this morning "),
      photo(),
      {
        ...text("t2", "and conditions were wet."),
        continuesFrom: { itemId: "t1", join: SECTION_TEXT_JOIN.INLINE },
      },
    ]);
    expect(types(nodes)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.TEXT,
    ]);
    expect(html(nodes)).toContain("<p>The excavation started this morning </p>");
    expect(html(nodes)).toContain("<p>and conditions were wet.</p>");
  });

  test("13. provenance naming an item that is not the left neighbour does not heal", () => {
    const { nodes } = adaptSectionItemsToNodes([
      text("t1", "One"),
      text("t2", "Two"),
      { ...text("t3", "Three"), continuesFrom: { itemId: "t1", join: "inline" } },
    ]);
    expect(html(nodes)).toBe("<p>One</p><p>Two</p><p>Three</p>");
  });

  test("healing happens in memory: the stored list is never rewritten", () => {
    const items = [
      text("t1", "Left "),
      { ...text("t2", "right"), continuesFrom: { itemId: "t1", join: "inline" } },
    ];
    const snapshot = JSON.parse(JSON.stringify(items));
    adaptSectionItemsToNodes(items);
    expect(items).toEqual(snapshot);
  });
});

/* =============================== photos =============================== */

describe("photo conversion", () => {
  test("14/15/16. assetId, intrinsic dimensions and widthPct are preserved", () => {
    const { nodes } = adaptSectionItemsToNodes([photo()]);
    expect(nodes[0].attrs).toEqual({
      assetId: IMAGE_ID,
      src: null,
      alt: "site.jpg",
      title: null,
      width: 1600,
      height: 1200,
      widthPct: 60,
      layoutMode: MEDIA_LAYOUT_MODE.BLOCK,
      layoutSide: null,
    });
  });

  test("17. a photo with no modern layout metadata becomes block with no side", () => {
    const { nodes } = adaptSectionItemsToNodes([
      photo({ display: { widthPct: 100, alignment: "right" } }),
    ]);
    expect(nodes[0].attrs.layoutMode).toBe(MEDIA_LAYOUT_MODE.BLOCK);
    expect(nodes[0].attrs.layoutSide).toBeNull();
    // alignment has no counterpart in the shared media vocabulary and is not
    // carried; the frozen legacy copy keeps it.
    expect(html(nodes)).not.toContain("alignment");
    expect(html(nodes)).not.toContain("data-layout");
  });

  test("a photo with no stored dimensions or width adapts without inventing any", () => {
    const { nodes } = adaptSectionItemsToNodes([
      { id: "p", kind: "photo", assetId: IMAGE_ID },
    ]);
    // normalizeAttachment supplies the model's own default width (60).
    expect(nodes[0].attrs.width).toBeNull();
    expect(nodes[0].attrs.height).toBeNull();
    expect(nodes[0].attrs.widthPct).toBe(60);
  });

  test("18. no Blob operation and no new asset id occur during conversion", () => {
    // The document names the asset that already exists: the only id in the
    // output is the one that was in the input.
    const { nodes } = adaptSectionItemsToNodes([photo()]);
    expect(nodes[0].attrs.assetId).toBe(IMAGE_ID);
    expect(html(nodes).match(/data-asset-id/g)).toHaveLength(1);
    // The adapter reaches no storage at all — asserted at the module boundary in
    // templateSectionDocNeutrality.test.js.
  });

  test("a photo whose asset id could not survive an attribute is reported, not dropped silently", () => {
    const { nodes, skipped } = adaptSectionItemsToNodes([photo({ assetId: 'bad"id' })]);
    expect(nodes).toEqual([]);
    expect(skipped).toEqual([
      {
        reason: SECTION_DOC_SKIP_REASON.IMAGE,
        index: 0,
        id: PHOTO_ITEM_ID,
        kind: SECTION_ITEM_KIND.PHOTO,
        entry: expect.any(Object),
      },
    ]);
  });
});

/* ================================ files =============================== */

describe("file conversion", () => {
  test("19/20/21. the shared FileAttachment representation carries id, name, type and size", () => {
    const { nodes } = adaptSectionItemsToNodes([file()]);
    expect(nodes[0].type).toBe(SECTION_DOC_NODE.FILE);
    expect(nodes[0].attrs).toEqual({
      assetId: FILE_ID,
      name: "Report.pdf",
      mimeType: "application/pdf",
      size: 2048,
    });
    expect(html(nodes)).toBe(
      `<div class="note-file-attachment" data-file-asset-id="${FILE_ID}" ` +
        `data-file-name="Report.pdf" data-file-size="2048" data-file-type="application/pdf"></div>`
    );
  });

  test("a MIME type the shared node does not accept is not asserted in the document", () => {
    // A Template File field accepts images; the shared node's type list does
    // not. The reference, name and size survive — the asset itself remains the
    // authority on its type at runtime.
    const { nodes } = adaptSectionItemsToNodes([
      file({ name: "scan.png", mimeType: "image/png" }),
    ]);
    expect(nodes[0].attrs).toEqual({
      assetId: FILE_ID,
      name: "scan.png",
      mimeType: null,
      size: 2048,
    });
  });

  test("a file reference the shared serializer refuses is reported, not dropped silently", () => {
    const { nodes, skipped } = adaptSectionItemsToNodes([file({ assetId: "short" })]);
    expect(nodes).toEqual([]);
    expect(skipped).toEqual([
      {
        reason: SECTION_DOC_SKIP_REASON.FILE,
        index: 0,
        id: FILE_ITEM_ID,
        kind: SECTION_ITEM_KIND.FILE,
        entry: expect.any(Object),
      },
    ]);
  });
});

/* ========================= legacy answer sources ====================== */

describe("legacy sources", () => {
  test("22. an answers-only row adapts to its text", () => {
    const { nodes, skipped } = adaptLegacyBodyToNodes({ answer: "Existing answer" });
    expect(html(nodes)).toBe("<p>Existing answer</p>");
    expect(skipped).toEqual([]);
  });

  test("an empty answer still yields the typeable empty paragraph", () => {
    expect(html(adaptLegacyBodyToNodes({ answer: "" }).nodes)).toBe("<p></p>");
    expect(html(adaptLegacyBodyToNodes({}).nodes)).toBe("<p></p>");
  });

  test("23. answer + carryable evidence adapts to text followed by media, in order", () => {
    const { nodes, skipped } = adaptLegacyBodyToNodes({
      answer: "Answer text",
      evidence: [photo(), file()],
    });
    expect(types(nodes)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.FILE,
    ]);
    expect(skipped).toEqual([]);
  });

  test("24. evidence-only adapts with no answer when the answer is not part of the body", () => {
    const { nodes } = adaptLegacyBodyToNodes({
      answer: "42",
      evidence: [photo()],
      includeAnswer: false,
    });
    expect(types(nodes)).toEqual([SECTION_DOC_NODE.IMAGE]);
    expect(html(nodes)).not.toContain("42");
  });

  test("evidence that renders today but cannot be carried is reported, never lost", () => {
    const { nodes, skipped } = adaptLegacyBodyToNodes({
      answer: "A",
      evidence: [
        "data:image/png;base64,AAAA",
        { id: "e1", assetId: "ev-asset-0001" }, // no kind: the legacy path shows it
        photo(),
      ],
    });
    expect(types(nodes)).toEqual([SECTION_DOC_NODE.TEXT, SECTION_DOC_NODE.IMAGE]);
    expect(skipped.map((s) => s.reason)).toEqual([
      SECTION_DOC_SKIP_REASON.LEGACY_EVIDENCE,
      SECTION_DOC_SKIP_REASON.LEGACY_EVIDENCE,
    ]);
    expect(skipped.map((s) => s.index)).toEqual([0, 1]);
  });

  test("an evidence entry that renders nowhere is not reported as lost content", () => {
    const { nodes, skipped } = adaptLegacyBodyToNodes({
      answer: "A",
      evidence: [{ id: "e", kind: "photo" }, null, 7],
    });
    expect(types(nodes)).toEqual([SECTION_DOC_NODE.TEXT]);
    expect(skipped).toEqual([]);
  });

  test("adapting legacy sources mutates nothing", () => {
    const evidence = [photo(), file()];
    const snapshot = JSON.parse(JSON.stringify(evidence));
    adaptLegacyBodyToNodes({ answer: "A", evidence });
    expect(evidence).toEqual(snapshot);
  });
});
