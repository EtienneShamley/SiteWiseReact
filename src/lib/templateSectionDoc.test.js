// src/lib/templateSectionDoc.test.js
//
// The modern Section document's stored value, its node model, and the two
// questions everything else asks of it: "is this authoritative?" and "does it
// reference this asset?".
//
// The rule that matters most here is that a bad value must never make a stored
// note unreadable: an unsupported format, a broken shape or a document this
// build cannot normalize is refused as an AUTHORITY, left exactly as it is in
// storage, and still protects every Blob it names.
import {
  SECTION_DOC_FORMAT,
  SECTION_DOC_NODE,
  isEmittableAssetId,
  isSectionDocValue,
  makeSectionDocValue,
  parseSectionDocHtml,
  sectionDocAssetIds,
  sectionDocFileAttrs,
  sectionDocForRow,
  sectionDocHtmlFromNodes,
  sectionDocHtmlReferencesAsset,
  sectionDocImageAttrs,
  sectionDocNodes,
  sectionDocNodesForRow,
  sectionDocReferencesAsset,
} from "./templateSectionDoc";
import { answerToModel } from "./templateRichText";

const IMAGE_ID = "img-asset-0001";
const FILE_ID = "file-asset-0001";

const textNode = (value) => ({
  type: SECTION_DOC_NODE.TEXT,
  blocks: answerToModel(value),
});

const imageHtml = (id = IMAGE_ID, extra = "") =>
  `<img data-asset-id="${id}"${extra}>`;
const fileHtml = (id = FILE_ID) =>
  `<div class="note-file-attachment" data-file-asset-id="${id}" data-file-name="Report.pdf" data-file-size="2048" data-file-type="application/pdf"></div>`;

const doc = (html) => ({ format: SECTION_DOC_FORMAT, html });

/* ========================= 1. the stored value ========================= */

describe("the stored value", () => {
  test("1. an exact sectiondoc/1 entry with string html is the supported shape", () => {
    expect(isSectionDocValue(doc("<p>Hello</p>"))).toBe(true);
    expect(SECTION_DOC_FORMAT).toBe("sectiondoc/1");
  });

  test("makeSectionDocValue is the only place the format string is minted", () => {
    expect(makeSectionDocValue("<p>x</p>")).toEqual({
      format: SECTION_DOC_FORMAT,
      html: "<p>x</p>",
    });
    expect(makeSectionDocValue("")).toEqual({ format: SECTION_DOC_FORMAT, html: "" });
    expect(makeSectionDocValue(null)).toBeNull();
    expect(makeSectionDocValue(42)).toBeNull();
  });

  test("3. an unsupported or future format is not the supported shape", () => {
    expect(isSectionDocValue({ format: "sectiondoc/2", html: "<p>x</p>" })).toBe(false);
    expect(isSectionDocValue({ format: "richtext/1", html: "<p>x</p>" })).toBe(false);
    expect(isSectionDocValue({ format: "SECTIONDOC/1", html: "<p>x</p>" })).toBe(false);
    expect(isSectionDocValue({ format: " sectiondoc/1", html: "<p>x</p>" })).toBe(false);
  });

  test("4. a malformed entry is not the supported shape", () => {
    expect(isSectionDocValue(null)).toBe(false);
    expect(isSectionDocValue("<p>x</p>")).toBe(false);
    expect(isSectionDocValue([])).toBe(false);
    expect(isSectionDocValue({ html: "<p>x</p>" })).toBe(false); // no format
    expect(isSectionDocValue(doc(undefined))).toBe(false); // missing html
    expect(isSectionDocValue({ format: SECTION_DOC_FORMAT, html: 12 })).toBe(false);
    expect(isSectionDocValue({ format: SECTION_DOC_FORMAT, html: null })).toBe(false);
    expect(isSectionDocValue({ format: SECTION_DOC_FORMAT, html: ["<p>x</p>"] })).toBe(false);
  });
});

/* ===================== serialization: nodes -> html ==================== */

describe("serializing a document", () => {
  test("text, image and file nodes emit in order", () => {
    const html = sectionDocHtmlFromNodes([
      textNode("Before"),
      { type: SECTION_DOC_NODE.IMAGE, attrs: sectionDocImageAttrs({ assetId: IMAGE_ID }) },
      textNode("After"),
      {
        type: SECTION_DOC_NODE.FILE,
        attrs: sectionDocFileAttrs({
          assetId: FILE_ID,
          name: "Report.pdf",
          mimeType: "application/pdf",
          size: 2048,
        }),
      },
    ]);
    expect(html).toBe(
      `<p>Before</p><img data-asset-id="${IMAGE_ID}"><p>After</p>` +
        `<div class="note-file-attachment" data-file-asset-id="${FILE_ID}" data-file-name="Report.pdf" data-file-size="2048" data-file-type="application/pdf"></div>`
    );
  });

  test("an asset-backed image never serializes a src, and a blob: src is never written", () => {
    const html = sectionDocHtmlFromNodes([
      {
        type: SECTION_DOC_NODE.IMAGE,
        attrs: sectionDocImageAttrs({ assetId: IMAGE_ID, src: "blob:http://x/y" }),
      },
    ]);
    expect(html).toBe(`<img data-asset-id="${IMAGE_ID}">`);
    expect(sectionDocImageAttrs({ assetId: null, src: "blob:http://x/y" })).toBeNull();
  });

  test("an unusable node contributes nothing rather than half a node", () => {
    expect(sectionDocHtmlFromNodes([{ type: SECTION_DOC_NODE.IMAGE, attrs: {} }])).toBe("");
    expect(sectionDocHtmlFromNodes([{ type: SECTION_DOC_NODE.FILE, attrs: {} }])).toBe("");
    expect(sectionDocHtmlFromNodes(null)).toBe("");
    expect(sectionDocHtmlFromNodes([null, undefined, "x"])).toBe("");
  });

  test("attribute values are escaped, so stored html cannot be broken by content", () => {
    const html = sectionDocHtmlFromNodes([
      {
        type: SECTION_DOC_NODE.IMAGE,
        attrs: sectionDocImageAttrs({ assetId: IMAGE_ID, alt: 'A "quoted" <name> & more' }),
      },
    ]);
    expect(html).toBe(
      `<img data-asset-id="${IMAGE_ID}" alt="A &quot;quoted&quot; &lt;name&gt; &amp; more">`
    );
    // ...and it reads back as exactly the same text.
    expect(parseSectionDocHtml(html)[0].attrs.alt).toBe('A "quoted" <name> & more');
  });

  test("an asset id that could not survive an attribute is refused outright", () => {
    expect(isEmittableAssetId(IMAGE_ID)).toBe(true);
    expect(isEmittableAssetId('a"b')).toBe(false);
    expect(isEmittableAssetId("a b")).toBe(false);
    expect(isEmittableAssetId("a&b")).toBe(false);
    expect(isEmittableAssetId("")).toBe(false);
    expect(sectionDocImageAttrs({ assetId: 'bad"id' })).toBeNull();
  });
});

/* ====================== parsing: html -> nodes ========================= */

describe("parsing a stored document", () => {
  test("a run of prose between two media nodes is ONE text node", () => {
    const nodes = parseSectionDocHtml(
      `<p>One</p><p>Two</p>${imageHtml()}<p>Three</p>`
    );
    expect(nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.TEXT,
    ]);
    expect(nodes[0].blocks).toHaveLength(2);
    expect(nodes[2].blocks).toHaveLength(1);
  });

  test("5. a valid modern document normalizes to its nodes", () => {
    const nodes = sectionDocNodes(doc(`<p>A</p>${imageHtml()}${fileHtml()}`));
    expect(nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.FILE,
    ]);
    expect(nodes[1].attrs.assetId).toBe(IMAGE_ID);
    expect(nodes[2].attrs).toEqual({
      assetId: FILE_ID,
      name: "Report.pdf",
      mimeType: "application/pdf",
      size: 2048,
    });
  });

  test("prose outside the supported schema is rebuilt, not passed through", () => {
    const nodes = parseSectionDocHtml(
      '<p>Keep <strong>this</strong></p><script>alert(1)</script><h2>Heading</h2>'
    );
    expect(sectionDocHtmlFromNodes(nodes)).toBe("<p>Keep <strong>this</strong></p><p>Heading</p>");
  });

  test("an empty paragraph is a legitimate document", () => {
    const nodes = parseSectionDocHtml("<p></p>");
    expect(nodes).toHaveLength(1);
    expect(sectionDocHtmlFromNodes(nodes)).toBe("<p></p>");
  });

  test("a file element whose reference is unusable falls back to its readable text", () => {
    const nodes = parseSectionDocHtml(
      '<div class="note-file-attachment" data-file-asset-id="!!">Report.pdf</div>'
    );
    expect(nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.TEXT]);
    expect(sectionDocHtmlFromNodes(nodes)).toBe("<p>Report.pdf</p>");
  });

  test("a remote image survives; an image with nothing to render from does not", () => {
    const remote = parseSectionDocHtml('<img src="https://example.com/a.png">');
    expect(remote).toHaveLength(1);
    expect(remote[0].attrs.src).toBe("https://example.com/a.png");
    expect(parseSectionDocHtml("<img>")).toBeNull();
  });

  test("4. a document that cannot be safely normalized is refused as an authority", () => {
    expect(parseSectionDocHtml("")).toBeNull();
    expect(parseSectionDocHtml(null)).toBeNull();
    expect(parseSectionDocHtml(12)).toBeNull();
    expect(parseSectionDocHtml("<script>alert(1)</script>")).toBeNull();
    expect(parseSectionDocHtml("   ")).toBeNull();
  });

  test("normalization may never LOSE a media reference the html contains", () => {
    // An image nested inside a paragraph is dropped by the prose whitelist, so
    // the document would render without the user's photograph. Refused whole.
    expect(parseSectionDocHtml(`<p>Text ${imageHtml()} more</p>`)).toBeNull();
    expect(parseSectionDocHtml(`<p>Text</p><div>${fileHtml()}</div>`)).toBeNull();
    // The same references at the top level are represented, so they are fine.
    expect(parseSectionDocHtml(`<p>Text</p>${imageHtml()}${fileHtml()}`)).toHaveLength(3);
  });

  test("2/3/4. an absent, unsupported or malformed entry yields no nodes", () => {
    expect(sectionDocNodes(undefined)).toBeNull();
    expect(sectionDocNodes({ format: "sectiondoc/2", html: "<p>x</p>" })).toBeNull();
    expect(sectionDocNodes({ format: SECTION_DOC_FORMAT, html: null })).toBeNull();
    expect(sectionDocNodes(doc("<p>ok</p>"))).toHaveLength(1);
  });

  test("reading never mutates the stored value", () => {
    const stored = doc(`<p>A</p>${imageHtml()}`);
    const snapshot = JSON.parse(JSON.stringify(stored));
    sectionDocNodes(stored);
    sectionDocAssetIds(stored.html);
    sectionDocReferencesAsset({ r1: stored }, IMAGE_ID);
    expect(stored).toEqual(snapshot);
  });
});

describe("reading one row's entry", () => {
  const map = {
    good: doc("<p>Body</p>"),
    future: { format: "sectiondoc/2", html: "<p>Body</p>" },
    broken: { format: SECTION_DOC_FORMAT, html: 7 },
  };

  test("only a supported entry is returned, and a bad row never affects a good one", () => {
    expect(sectionDocForRow(map, "good")).toEqual(map.good);
    expect(sectionDocForRow(map, "future")).toBeNull();
    expect(sectionDocForRow(map, "broken")).toBeNull();
    expect(sectionDocForRow(map, "missing")).toBeNull();
    expect(sectionDocForRow(null, "good")).toBeNull();
    expect(sectionDocForRow([], "good")).toBeNull();
    expect(sectionDocForRow(map, "")).toBeNull();
    expect(sectionDocNodesForRow(map, "good")).toHaveLength(1);
    expect(sectionDocNodesForRow(map, "future")).toBeNull();
  });
});

/* ========================= asset references =========================== */

describe("asset references (the deletion gate's view)", () => {
  test("both reference kinds are collected through the canonical collectors", () => {
    const html = `<p>A</p>${imageHtml()}<p>B</p>${fileHtml()}`;
    expect(sectionDocAssetIds(html)).toEqual({
      imageIds: [IMAGE_ID],
      fileIds: [FILE_ID],
    });
    expect(sectionDocAssetIds("")).toEqual({ imageIds: [], fileIds: [] });
    expect(sectionDocAssetIds(null)).toEqual({ imageIds: [], fileIds: [] });
  });

  test("29/30. a document-only image or file protects its Blob", () => {
    const map = { r1: doc(`<p>A</p>${imageHtml()}${fileHtml()}`) };
    expect(sectionDocReferencesAsset(map, IMAGE_ID)).toBe(true);
    expect(sectionDocReferencesAsset(map, FILE_ID)).toBe(true);
    expect(sectionDocReferencesAsset(map, "some-other-asset")).toBe(false);
    expect(sectionDocReferencesAsset(map, "")).toBe(false);
    expect(sectionDocReferencesAsset(null, IMAGE_ID)).toBe(false);
  });

  test("an entry too malformed to render STILL protects its assets", () => {
    // Deliberately more tolerant than the read path: the cost of over-protecting
    // is one orphaned Blob; the cost of under-protecting is a destroyed photo.
    const future = { r1: { format: "sectiondoc/2", html: imageHtml() } };
    const noFormat = { r1: { html: fileHtml() } };
    const unrenderable = { r1: doc(`<p>Text ${imageHtml()}</p>`) };
    expect(sectionDocReferencesAsset(future, IMAGE_ID)).toBe(true);
    expect(sectionDocReferencesAsset(noFormat, FILE_ID)).toBe(true);
    expect(sectionDocReferencesAsset(unrenderable, IMAGE_ID)).toBe(true);
    // ...while none of those is authoritative for rendering.
    expect(sectionDocNodes(future.r1)).toBeNull();
    expect(sectionDocNodes(unrenderable.r1)).toBeNull();
  });

  test("a file id outside the shared id shape still protects its Blob", () => {
    // The canonical file collector filters by id shape — right for deciding what
    // may become a node, wrong for deciding whether a Blob may be destroyed.
    const odd = 'note-att-note1-field1-0-and-a-very-long-legacy-id-beyond-the-shared-shape-limit';
    const html = `<div class="note-file-attachment" data-file-asset-id="${odd}"></div>`;
    expect(sectionDocAssetIds(html).fileIds).toEqual([]);
    expect(sectionDocHtmlReferencesAsset(html, odd)).toBe(true);
    expect(sectionDocReferencesAsset({ r1: doc(html) }, odd)).toBe(true);
  });

  test("a non-object row, a null entry and a non-string html are skipped safely", () => {
    expect(
      sectionDocReferencesAsset(
        { a: null, b: "x", c: [], d: { format: SECTION_DOC_FORMAT, html: 5 } },
        IMAGE_ID
      )
    ).toBe(false);
  });
});
