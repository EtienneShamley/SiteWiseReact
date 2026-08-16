// src/lib/templateSectionDocSegments.test.js
//
// THE LAYOUT PROJECTION — a resolved Section body → the blocks a page is made
// of (Phase F3).
//
// Two guarantees dominate this suite:
//   - a body ADAPTED FROM STORED ITEMS projects back onto exactly those items,
//     so a note paginates where it always has and a Section can switch between
//     its static rendering and the legacy interactive one without the page
//     moving; and
//   - material the document cannot represent keeps a segment of its own, in its
//     own stored position, so nothing a note shows today disappears.
import {
  SECTION_SEGMENT_KIND,
  compatSegmentItemKind,
  sectionDocSegments,
} from "./templateSectionDocSegments";
import { SECTION_BODY_SOURCE, resolveSectionBody } from "./templateSectionBody";
import {
  SECTION_DOC_FORMAT,
  SECTION_DOC_NODE,
  sectionDocHtmlFromNodes,
} from "./templateSectionDoc";
import { SECTION_ITEM_KIND } from "./templateSectionContent";
import { MEDIA_LAYOUT_MODE, MEDIA_LAYOUT_SIDE } from "./editorMediaLayout";

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

/** The segments of one row's body, read through the canonical reader. */
const segmentsFor = (instance, over = {}) =>
  sectionDocSegments(
    resolveSectionBody({ instance, rowId: ROW, rowType: "text", ...over })
  );

const kinds = (segments) => segments.map((s) => s.kind);
const keys = (segments) => segments.map((s) => s.key);

/* ===================== ordered content → segments ===================== */

describe("a body adapted from stored items segments back onto those items", () => {
  const instance = {
    sectionContent: {
      [ROW]: [text("t1", "Before"), photo(), text("t2", "After"), file()],
    },
  };

  test("one segment per stored item, in stored order", () => {
    const segments = segmentsFor(instance);
    expect(kinds(segments)).toEqual([
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.IMAGE,
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.FILE,
    ]);
    expect(keys(segments)).toEqual(["t1", "item-photo", "t2", "item-file"]);
  });

  test("10. two independent adjacent TEXT items stay two segments", () => {
    // The adapter merges their runs into ONE document text node, because that
    // is what a stretch of prose between two media nodes is. The projection
    // puts the boundary back, so the two Quick Add captures keep the two blocks
    // — and the gap between them — the row has today.
    const body = resolveSectionBody({
      instance: { sectionContent: { [ROW]: [text("a", "One"), text("b", "Two")] } },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].type).toBe(SECTION_DOC_NODE.TEXT);

    const segments = sectionDocSegments(body);
    expect(kinds(segments)).toEqual([
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.TEXT,
    ]);
    expect(keys(segments)).toEqual(["a", "b"]);
    expect(sectionDocHtmlFromNodes([{ type: "text", blocks: segments[0].blocks }])).toBe(
      "<p>One</p>"
    );
    expect(sectionDocHtmlFromNodes([{ type: "text", blocks: segments[1].blocks }])).toBe(
      "<p>Two</p>"
    );
  });

  test("a multi-paragraph text item stays ONE segment holding all its paragraphs", () => {
    const segments = segmentsFor({
      sectionContent: {
        [ROW]: [text("t1", { format: "richtext/1", html: "<p>One</p><p>Two</p>" })],
      },
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].blocks).toHaveLength(2);
  });

  test("11. a healed split renders as the one paragraph the live product would have healed it to", () => {
    const segments = segmentsFor({
      sectionContent: {
        [ROW]: [
          text("a", "This morning "),
          { ...text("b", "and conditions"), continuesFrom: { itemId: "a", join: "inline" } },
        ],
      },
    });
    expect(segments).toHaveLength(1);
    expect(
      sectionDocHtmlFromNodes([{ type: "text", blocks: segments[0].blocks }])
    ).toBe("<p>This morning and conditions</p>");
  });

  test("every segment carries the stored item's own id, never a position", () => {
    const segments = segmentsFor(instance);
    for (const segment of segments) {
      expect(typeof segment.itemId).toBe("string");
      expect(segment.key).toBe(segment.itemId);
    }
  });

  test("segmenting the same stored body twice is identical (no clock, no ids minted)", () => {
    expect(segmentsFor(instance)).toEqual(segmentsFor(instance));
  });
});

/* ========================= a stored modern document =================== */

describe("a stored modern document segments on its media boundaries", () => {
  const html =
    `<p>Intro</p>` +
    `<img data-asset-id="${IMAGE_ID}" alt="site.jpg" width="800" height="600" data-width-pct="60">` +
    `<p>Between</p>` +
    `<div class="note-file-attachment" data-file-asset-id="${FILE_ID}" ` +
    `data-file-name="Report.pdf" data-file-type="application/pdf" data-file-size="2048">` +
    `<span class="note-file-attachment__name">Report.pdf</span>` +
    `<span class="note-file-attachment__meta">PDF · 2 KB</span></div>` +
    `<p>After</p>`;

  test("12. a block image is its own segment, text runs are theirs", () => {
    const segments = segmentsFor({ sectionDoc: { [ROW]: doc(html) } });
    expect(kinds(segments)).toEqual([
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.IMAGE,
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.FILE,
      SECTION_SEGMENT_KIND.TEXT,
    ]);
  });

  test("13. a stored width survives to the segment that renders it", () => {
    const segments = segmentsFor({ sectionDoc: { [ROW]: doc(html) } });
    const image = segments.find((s) => s.kind === SECTION_SEGMENT_KIND.IMAGE);
    expect(image.attrs.assetId).toBe(IMAGE_ID);
    expect(image.attrs.widthPct).toBe(60);
    expect(image.attrs.width).toBe(800);
    expect(image.attrs.height).toBe(600);
    expect(image.wrapped).toBe(false);
  });

  test("a document with no legacy items names none — its segments key by position", () => {
    const segments = segmentsFor({ sectionDoc: { [ROW]: doc(html) } });
    for (const segment of segments) {
      expect(segment.itemId).toBeNull();
      expect(segment.itemIndex).toBeNull();
      expect(segment.key).toBe(`seg-${segment.index}`);
    }
  });

  test("17. an asset-backed image carries its reference and never a src", () => {
    const segments = segmentsFor({ sectionDoc: { [ROW]: doc(html) } });
    const image = segments.find((s) => s.kind === SECTION_SEGMENT_KIND.IMAGE);
    expect(image.attrs.assetId).toBe(IMAGE_ID);
    expect(image.attrs.src).toBeNull();
  });

  test("19/20. a file segment carries name, type and size", () => {
    const segments = segmentsFor({ sectionDoc: { [ROW]: doc(html) } });
    const fileSeg = segments.find((s) => s.kind === SECTION_SEGMENT_KIND.FILE);
    expect(fileSeg.attrs).toEqual({
      assetId: FILE_ID,
      name: "Report.pdf",
      mimeType: "application/pdf",
      size: 2048,
    });
  });
});

/* ============================= wrapped media ========================== */

describe("14/15/44. a wrapped image and the text beside it are ONE segment", () => {
  const wrapHtml = (side) =>
    `<p>Lead in</p>` +
    `<img data-asset-id="${IMAGE_ID}" alt="site.jpg" width="800" height="600" ` +
    `data-width-pct="40" data-layout-mode="wrap" data-layout-side="${side}">` +
    `<p>Text that flows beside the picture</p>` +
    `<p>More of it</p>`;

  test.each([MEDIA_LAYOUT_SIDE.LEFT, MEDIA_LAYOUT_SIDE.RIGHT])(
    "a wrap-%s image fuses with the run that follows it",
    (side) => {
      const segments = segmentsFor({ sectionDoc: { [ROW]: doc(wrapHtml(side)) } });
      expect(kinds(segments)).toEqual([
        SECTION_SEGMENT_KIND.TEXT,
        SECTION_SEGMENT_KIND.IMAGE,
      ]);
      const image = segments[1];
      expect(image.wrapped).toBe(true);
      expect(image.attrs.layoutMode).toBe(MEDIA_LAYOUT_MODE.WRAP);
      expect(image.attrs.layoutSide).toBe(side);
      // Both paragraphs beside it travel with it — a float that is paginated
      // away from the text it wraps would reflow into something else.
      expect(image.blocks).toHaveLength(2);
    }
  );

  test("a wrapped image with nothing after it is simply its own segment", () => {
    const segments = segmentsFor({
      sectionDoc: {
        [ROW]: doc(
          `<img data-asset-id="${IMAGE_ID}" alt="a" data-layout-mode="wrap" data-layout-side="left">`
        ),
      },
    });
    expect(kinds(segments)).toEqual([SECTION_SEGMENT_KIND.IMAGE]);
    expect(segments[0].wrapped).toBe(true);
    expect(segments[0].blocks).toBeNull();
  });

  test("an adapted legacy photo is never wrapped — the item list could not express one", () => {
    const segments = segmentsFor({
      sectionContent: { [ROW]: [photo(), text("t", "After")] },
    });
    expect(segments[0].wrapped).toBe(false);
    expect(kinds(segments)).toEqual([
      SECTION_SEGMENT_KIND.IMAGE,
      SECTION_SEGMENT_KIND.TEXT,
    ]);
  });
});

/* ====================== compatibility (skipped) ======================= */

describe("22-26. material the document cannot represent keeps its own segment", () => {
  // A historical migrated asset id longer than the shared file serializer's id
  // shape accepts. It renders today, so it must go on rendering.
  const instance = {
    sectionContent: {
      [ROW]: [
        text("t1", "Before"),
        file({ id: "item-long", assetId: LONG_FILE_ID }),
        text("t2", "After"),
      ],
    },
  };

  test("22/23. the reader reports it, and it becomes a compatibility segment", () => {
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].id).toBe("item-long");

    const segments = sectionDocSegments(body);
    expect(kinds(segments)).toEqual([
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.COMPAT,
      SECTION_SEGMENT_KIND.TEXT,
    ]);
  });

  test("25. it lands in its OWN stored position, between the text around it", () => {
    const segments = sectionDocSegments(
      resolveSectionBody({ instance, rowId: ROW, rowType: "text" })
    );
    expect(keys(segments)).toEqual(["t1", "item-long", "t2"]);
  });

  test("24. it appears exactly once — the document cannot also hold it", () => {
    const segments = sectionDocSegments(
      resolveSectionBody({ instance, rowId: ROW, rowType: "text" })
    );
    expect(segments.filter((s) => s.key === "item-long")).toHaveLength(1);
    expect(segments.filter((s) => s.kind === SECTION_SEGMENT_KIND.COMPAT)).toHaveLength(1);
  });

  test("it keeps enough identity to render through the compatibility renderer", () => {
    const segments = sectionDocSegments(
      resolveSectionBody({ instance, rowId: ROW, rowType: "text" })
    );
    const compat = segments.find((s) => s.kind === SECTION_SEGMENT_KIND.COMPAT);
    expect(compat.entry.assetId).toBe(LONG_FILE_ID);
    expect(compat.entry.name).toBe("Report.pdf");
    expect(compatSegmentItemKind(compat)).toBe(SECTION_ITEM_KIND.FILE);
  });

  test("an unrepresentable PHOTO is a photo-shaped compatibility segment", () => {
    const segments = segmentsFor({
      sectionContent: { [ROW]: [photo({ id: "bad", assetId: 'has"quote' })] },
    });
    expect(kinds(segments)).toEqual([SECTION_SEGMENT_KIND.COMPAT]);
    expect(compatSegmentItemKind(segments[0])).toBe(SECTION_ITEM_KIND.PHOTO);
  });

  test("26. an INVALID modern document does not hide it — the legacy body renders whole", () => {
    const body = resolveSectionBody({
      instance: { ...instance, sectionDoc: { [ROW]: { format: "sectiondoc/2", html: "<p>x</p>" } } },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(keys(sectionDocSegments(body))).toEqual(["t1", "item-long", "t2"]);
  });

  test("a VALID modern document still carries the frozen list's unrepresentable material", () => {
    // It can never duplicate: what the document can represent is IN it, and
    // what it cannot is by construction absent from it.
    const body = resolveSectionBody({
      instance: { ...instance, sectionDoc: { [ROW]: doc("<p>Modern</p>") } },
      rowId: ROW,
      rowType: "text",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(body.skipped).toHaveLength(1);
    const segments = sectionDocSegments(body);
    expect(kinds(segments)).toEqual([
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.COMPAT,
    ]);
    expect(segments.filter((s) => s.kind === SECTION_SEGMENT_KIND.COMPAT)).toHaveLength(1);
  });
});

/* ============================== robustness ============================ */

describe("the projection is defensive and pure", () => {
  test("no body, an empty body and a malformed body all produce no segments", () => {
    expect(sectionDocSegments()).toEqual([]);
    expect(sectionDocSegments({})).toEqual([]);
    expect(sectionDocSegments({ nodes: null, sources: null, skipped: null })).toEqual([]);
    expect(sectionDocSegments({ nodes: [null, 5, "x", { type: "unknown" }] })).toEqual([]);
  });

  test("provenance that does not account for a run leaves the run whole", () => {
    // A partial split would move prose into the wrong block, so it is refused.
    const segments = sectionDocSegments({
      nodes: [{ type: SECTION_DOC_NODE.TEXT, blocks: [1, 2, 3] }],
      sources: [[{ index: 0, id: "a", blocks: 1 }, { index: 1, id: "b", blocks: 1 }]],
      skipped: [],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].blocks).toEqual([1, 2, 3]);
    expect(segments[0].itemId).toBe("a");
  });

  test("segments are numbered in render order", () => {
    const segments = segmentsFor({
      sectionContent: { [ROW]: [text("t1", "A"), photo(), file()] },
    });
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  test("the input body is never mutated", () => {
    const body = resolveSectionBody({
      instance: { sectionContent: { [ROW]: [text("t1", "A"), photo()] } },
      rowId: ROW,
      rowType: "text",
    });
    const snapshot = JSON.parse(JSON.stringify(body));
    sectionDocSegments(body);
    expect(JSON.parse(JSON.stringify(body))).toEqual(snapshot);
  });
});
