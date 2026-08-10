// Tests for the flexible-section ordered content model
// (src/lib/templateSectionContent.js).
//
// Phase 0 is the MODEL FOUNDATION only: a read-time normalizer and the asset
// reference helper that the deletion gate depends on. Nothing writes
// sectionContent yet, which is deliberate — the reference scan has to be in
// place BEFORE a writer exists, or removal cleanup could destroy a live asset.
//
// Pure module, so these tests need no DOM beyond the DOMParser the answer
// normalizer already uses (jsdom provides it).

import {
  SECTION_ITEM_KIND,
  isTextSectionItem,
  normalizeSectionContent,
  normalizeSectionItem,
  sectionContentReferencesAsset,
  sectionItemsForRow,
} from "./templateSectionContent";
import { normalizeAnswerValue } from "./templateRichText";
import { normalizeAttachment } from "./noteAttachments";

const textItem = (id, value = "") => ({ id, kind: "text", value });

const photoItem = (id, assetId, overrides = {}) => ({
  id,
  kind: "photo",
  assetId,
  name: "p.png",
  mimeType: "image/png",
  size: 120,
  createdAt: 7,
  intrinsicWidth: 800,
  intrinsicHeight: 400,
  display: { widthPct: 60, alignment: "left" },
  ...overrides,
});

const fileItem = (id, assetId, overrides = {}) => ({
  id,
  kind: "file",
  assetId,
  name: "d.pdf",
  mimeType: "application/pdf",
  size: 900,
  createdAt: 9,
  ...overrides,
});

/* ------------------------------------------------------------------------ */
/* Item kinds                                                                */
/* ------------------------------------------------------------------------ */

describe("section item kinds", () => {
  test("photo/file kinds ARE the existing attachment kinds, not a parallel set", () => {
    expect(SECTION_ITEM_KIND.PHOTO).toBe("photo");
    expect(SECTION_ITEM_KIND.FILE).toBe("file");
    expect(SECTION_ITEM_KIND.TEXT).toBe("text");
  });

  test("isTextSectionItem recognises only the text kind", () => {
    expect(isTextSectionItem(textItem("t1"))).toBe(true);
    expect(isTextSectionItem(photoItem("p1", "a1"))).toBe(false);
    expect(isTextSectionItem(fileItem("f1", "a1"))).toBe(false);
    expect(isTextSectionItem(null)).toBe(false);
    expect(isTextSectionItem("text")).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Text items                                                                */
/* ------------------------------------------------------------------------ */

describe("text items", () => {
  test("a plain-string answer is kept verbatim", () => {
    const item = normalizeSectionItem(textItem("t1", "Site conditions were dry."));
    expect(item).toEqual({
      id: "t1",
      kind: "text",
      value: "Site conditions were dry.",
    });
  });

  test("a legacy string that LOOKS like markup stays literal characters", () => {
    // The answer model is shape-discriminated; a string is never parsed as HTML.
    const item = normalizeSectionItem(textItem("t1", "<b>Inspection failed</b>"));
    expect(item.value).toBe("<b>Inspection failed</b>");
  });

  test("a richtext/1 answer is kept as a tagged rich value", () => {
    const raw = { format: "richtext/1", html: "<p><strong>Cracked</strong> beam</p>" };
    const item = normalizeSectionItem(textItem("t1", raw));
    expect(item.value).toEqual({
      format: "richtext/1",
      html: "<p><strong>Cracked</strong> beam</p>",
    });
  });

  test("text normalization reuses the existing answer semantics exactly", () => {
    // Rich markup carrying nothing a plain string cannot hold demotes to a
    // string; an unusable value becomes "". Both are normalizeAnswerValue's
    // rules, asserted here as REUSED rather than reimplemented.
    const cases = [
      "plain",
      { format: "richtext/1", html: "<p>just words</p>" },
      { format: "richtext/1", html: "<p><em>emphasis</em></p>" },
      { format: "nope", html: "<p>x</p>" },
      42,
      true,
      null,
    ];
    for (const value of cases) {
      const item = normalizeSectionItem(textItem("t1", value));
      expect(item.value).toEqual(normalizeAnswerValue(value));
    }
  });

  test("an empty text item is legitimate content and is KEPT", () => {
    expect(normalizeSectionItem(textItem("t1", ""))).toEqual({
      id: "t1",
      kind: "text",
      value: "",
    });
  });

  test("a text item with a missing or unusable id is SKIPPED, never given one", () => {
    // No positional/read-time id fallback: reordering would silently re-address
    // the item, and with it its editor identity and Refine backup.
    expect(normalizeSectionItem({ kind: "text", value: "x" })).toBeNull();
    expect(normalizeSectionItem({ id: "", kind: "text", value: "x" })).toBeNull();
    expect(normalizeSectionItem({ id: 7, kind: "text", value: "x" })).toBeNull();
    expect(normalizeSectionItem({ id: null, kind: "text", value: "x" })).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* Photo / file items                                                        */
/* ------------------------------------------------------------------------ */

describe("photo and file items", () => {
  test("a photo item normalizes exactly as the existing attachment reference does", () => {
    const raw = photoItem("p1", "asset-1");
    expect(normalizeSectionItem(raw)).toEqual(normalizeAttachment(raw));
  });

  test("a file item normalizes exactly as the existing attachment reference does", () => {
    const raw = fileItem("f1", "asset-2");
    expect(normalizeSectionItem(raw)).toEqual(normalizeAttachment(raw));
  });

  test("photo display metadata is clamped by the existing rules", () => {
    const item = normalizeSectionItem(
      photoItem("p1", "asset-1", { display: { widthPct: 9999, alignment: "sideways" } })
    );
    expect(item.display).toEqual({ widthPct: 100, alignment: "left" });
  });

  test("an item without an assetId is skipped", () => {
    expect(normalizeSectionItem({ id: "p1", kind: "photo" })).toBeNull();
    expect(normalizeSectionItem({ id: "f1", kind: "file", assetId: "" })).toBeNull();
  });

  test("a valid photo and a valid file still normalize normally", () => {
    const photo = normalizeSectionItem(photoItem("p1", "asset-1"));
    expect(photo.kind).toBe("photo");
    expect(photo.assetId).toBe("asset-1");
    expect(photo.display).toEqual({ widthPct: 60, alignment: "left" });

    const file = normalizeSectionItem(fileItem("f1", "asset-2"));
    expect(file.kind).toBe("file");
    expect(file.assetId).toBe("asset-2");
    // The file kind is never coerced to photo, and gets no display metadata.
    expect(file.display).toBeUndefined();
  });

  test("a legacy base64 STRING is not a valid section item", () => {
    expect(normalizeSectionItem("data:image/png;base64,AAAA")).toBeNull();
  });

  test("structurally unusable entries are skipped without throwing", () => {
    expect(normalizeSectionItem(null)).toBeNull();
    expect(normalizeSectionItem(undefined)).toBeNull();
    expect(normalizeSectionItem(42)).toBeNull();
    expect(normalizeSectionItem([])).toBeNull();
    expect(normalizeSectionItem([photoItem("p1", "a1")])).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* Explicit kind dispatch                                                    */
/* ------------------------------------------------------------------------ */
//
// `sectionContent` is a NEW discriminated union — "text" | "photo" | "file" —
// and has no history to be compatible with. It therefore does NOT inherit
// `normalizeAttachment`'s legacy fallback, where a missing or unrecognised kind
// becomes a photo. That fallback belongs to `attachments`, whose stored entries
// predate the kind field; reinterpreting a malformed or future section item as
// an image would render somebody's report content as something it is not.

describe("explicit kind dispatch (no photo fallback)", () => {
  test("a MISSING kind with a valid assetId is NOT rendered as a photo", () => {
    const entry = { id: "x1", assetId: "asset-3", name: "p.png", size: 10 };
    expect(normalizeSectionItem(entry)).toBeNull();
    // Contrast: the legacy attachments collection still does fall back to photo.
    expect(normalizeAttachment(entry).kind).toBe("photo");
  });

  test("an UNKNOWN kind with a valid assetId is skipped by normalization", () => {
    expect(normalizeSectionItem({ id: "x1", kind: "sticker", assetId: "asset-3" })).toBeNull();
    expect(normalizeSectionItem({ id: "x1", kind: "signature", assetId: "asset-4" })).toBeNull();
    expect(normalizeSectionItem({ id: "x1", kind: "", assetId: "asset-5" })).toBeNull();
    expect(normalizeSectionItem({ id: "x1", kind: null, assetId: "asset-6" })).toBeNull();
    expect(normalizeSectionItem({ id: "x1", kind: 7, assetId: "asset-7" })).toBeNull();
  });

  test("a kind that only LOOKS right is not accepted", () => {
    // Case and whitespace are not normalized away — the discriminator is exact.
    expect(normalizeSectionItem({ id: "x1", kind: "Photo", assetId: "a1" })).toBeNull();
    expect(normalizeSectionItem({ id: "x1", kind: " file", assetId: "a1" })).toBeNull();
    expect(normalizeSectionItem({ id: "t1", kind: "TEXT", value: "x" })).toBeNull();
  });

  test("a skipped unknown-kind item does not disturb the valid items around it", () => {
    const out = normalizeSectionContent({
      "row-a": [
        textItem("t1", "first"),
        { id: "x1", kind: "sticker", assetId: "asset-3" },
        { id: "x2", assetId: "asset-4" }, // missing kind
        photoItem("p1", "asset-1"),
        textItem("t2", "last"),
      ],
    });
    expect(out["row-a"].map((i) => [i.id, i.kind])).toEqual([
      ["t1", "text"],
      ["p1", "photo"],
      ["t2", "text"],
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* The container                                                             */
/* ------------------------------------------------------------------------ */

describe("normalizeSectionContent (container rules)", () => {
  test("a missing / non-object / array container normalizes to {}", () => {
    expect(normalizeSectionContent(undefined)).toEqual({});
    expect(normalizeSectionContent(null)).toEqual({});
    expect(normalizeSectionContent("nope")).toEqual({});
    expect(normalizeSectionContent(42)).toEqual({});
    expect(normalizeSectionContent([textItem("t1", "x")])).toEqual({});
  });

  test("an empty map stays empty", () => {
    expect(normalizeSectionContent({})).toEqual({});
  });

  test("rows are keyed by their stable row id", () => {
    const out = normalizeSectionContent({
      "row-a": [textItem("t1", "A")],
      "row-b": [textItem("t2", "B")],
    });
    expect(Object.keys(out).sort()).toEqual(["row-a", "row-b"]);
    expect(out["row-a"][0].value).toBe("A");
    expect(out["row-b"][0].value).toBe("B");
  });

  test("an empty row id is ignored", () => {
    const out = normalizeSectionContent({
      "": [textItem("t1", "A")],
      "row-a": [textItem("t2", "B")],
    });
    expect(Object.keys(out)).toEqual(["row-a"]);
  });

  test("a non-array per-row collection is dropped", () => {
    const out = normalizeSectionContent({
      "row-a": "not-an-array",
      "row-b": { nope: true },
      "row-c": [textItem("t1", "kept")],
    });
    expect(Object.keys(out)).toEqual(["row-c"]);
  });

  test("a row with no usable items is omitted, so the map stays clean", () => {
    const out = normalizeSectionContent({
      "row-a": [],
      "row-b": [null, { kind: "text", value: "no id" }],
      "row-c": [textItem("t1", "kept")],
    });
    expect(Object.keys(out)).toEqual(["row-c"]);
  });

  test("mixed text/photo/file order is preserved EXACTLY", () => {
    const out = normalizeSectionContent({
      "row-a": [
        textItem("t1", "Intro"),
        photoItem("p1", "asset-1"),
        textItem("t2", "Middle"),
        fileItem("f1", "asset-2"),
        photoItem("p2", "asset-3"),
      ],
    });
    expect(out["row-a"].map((i) => [i.id, i.kind])).toEqual([
      ["t1", "text"],
      ["p1", "photo"],
      ["t2", "text"],
      ["f1", "file"],
      ["p2", "photo"],
    ]);
  });

  test("photos are never regrouped ahead of text or files", () => {
    const out = normalizeSectionContent({
      "row-a": [fileItem("f1", "a1"), photoItem("p1", "a2"), textItem("t1", "x")],
    });
    expect(out["row-a"].map((i) => i.kind)).toEqual(["file", "photo", "text"]);
  });

  test("a malformed item is skipped WITHOUT shifting or corrupting the valid ones", () => {
    const out = normalizeSectionContent({
      "row-a": [
        textItem("t1", "first"),
        null,
        { id: "bad", kind: "photo" }, // no assetId
        { kind: "text", value: "no id" },
        photoItem("p1", "asset-1"),
        "data:image/png;base64,AAAA",
        textItem("t2", "last"),
      ],
    });
    expect(out["row-a"].map((i) => i.id)).toEqual(["t1", "p1", "t2"]);
    expect(out["row-a"][0].value).toBe("first");
    expect(out["row-a"][2].value).toBe("last");
  });

  test("a malformed row does not affect another row", () => {
    const out = normalizeSectionContent({
      "row-bad": [null, undefined, 42],
      "row-broken": "not-an-array",
      "row-good": [textItem("t1", "intact"), photoItem("p1", "asset-1")],
    });
    expect(Object.keys(out)).toEqual(["row-good"]);
    expect(out["row-good"].map((i) => i.id)).toEqual(["t1", "p1"]);
  });

  test("stored data is never mutated", () => {
    const stored = {
      "row-a": [textItem("t1", "x"), null, photoItem("p1", "asset-1")],
    };
    const snapshot = JSON.parse(JSON.stringify(stored));
    normalizeSectionContent(stored);
    expect(stored).toEqual(snapshot);
    // The malformed entry stays exactly where it is in storage.
    expect(stored["row-a"]).toHaveLength(3);
    expect(stored["row-a"][1]).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* Per-row read                                                              */
/* ------------------------------------------------------------------------ */

describe("sectionItemsForRow", () => {
  test("returns the row's items in stored order", () => {
    const map = { "row-a": [textItem("t1", "x"), photoItem("p1", "asset-1")] };
    expect(sectionItemsForRow(map, "row-a").map((i) => i.id)).toEqual(["t1", "p1"]);
  });

  test("always returns an array, never null", () => {
    expect(sectionItemsForRow(null, "row-a")).toEqual([]);
    expect(sectionItemsForRow({}, "row-a")).toEqual([]);
    expect(sectionItemsForRow({ "row-a": "x" }, "row-a")).toEqual([]);
    expect(sectionItemsForRow({ "row-a": [] }, "")).toEqual([]);
    expect(sectionItemsForRow([], "row-a")).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* Asset reference safety                                                    */
/* ------------------------------------------------------------------------ */

describe("sectionContentReferencesAsset", () => {
  test("a photo item's asset counts as referenced", () => {
    const map = { "row-a": [photoItem("p1", "asset-1")] };
    expect(sectionContentReferencesAsset(map, "asset-1")).toBe(true);
  });

  test("a file item's asset counts as referenced", () => {
    const map = { "row-a": [fileItem("f1", "asset-2")] };
    expect(sectionContentReferencesAsset(map, "asset-2")).toBe(true);
  });

  test("a text item NEVER counts as an asset reference", () => {
    // Even a corrupt record carrying an assetId beside kind:"text" — a text item
    // has no Blob, so it can never be what keeps one alive.
    const map = {
      "row-a": [{ id: "t1", kind: "text", value: "x", assetId: "asset-3" }],
    };
    expect(sectionContentReferencesAsset(map, "asset-3")).toBe(false);
  });

  test("an unreferenced asset returns false", () => {
    const map = { "row-a": [photoItem("p1", "asset-1"), fileItem("f1", "asset-2")] };
    expect(sectionContentReferencesAsset(map, "asset-unused")).toBe(false);
  });

  test("a falsy asset id is never referenced", () => {
    const map = { "row-a": [photoItem("p1", "asset-1")] };
    expect(sectionContentReferencesAsset(map, null)).toBe(false);
    expect(sectionContentReferencesAsset(map, "")).toBe(false);
    expect(sectionContentReferencesAsset(map, undefined)).toBe(false);
  });

  test("a missing / malformed container is tolerated", () => {
    expect(sectionContentReferencesAsset(undefined, "asset-1")).toBe(false);
    expect(sectionContentReferencesAsset(null, "asset-1")).toBe(false);
    expect(sectionContentReferencesAsset("nope", "asset-1")).toBe(false);
    expect(sectionContentReferencesAsset([], "asset-1")).toBe(false);
    expect(sectionContentReferencesAsset({ "row-a": "x" }, "asset-1")).toBe(false);
  });

  test("an UNKNOWN-kind entry is skipped by rendering but STILL protects its asset", () => {
    // The deliberate divergence: skipping an unrecognised item for RENDERING is
    // safe; treating it as unreferenced for DELETION is not, because the Blob
    // may still be live. One orphaned Blob beats destroying a user's evidence.
    const map = { "row-a": [{ id: "x1", kind: "sticker", assetId: "asset-9" }] };
    expect(normalizeSectionContent(map)).toEqual({});
    expect(sectionContentReferencesAsset(map, "asset-9")).toBe(true);
  });

  test("a MISSING-kind entry is skipped by rendering but STILL protects its asset", () => {
    const map = { "row-a": [{ id: "x1", assetId: "asset-10" }] };
    expect(normalizeSectionContent(map)).toEqual({});
    expect(sectionContentReferencesAsset(map, "asset-10")).toBe(true);
  });

  test("it errs toward STILL REFERENCED for a row the render path drops entirely", () => {
    const map = { "": [photoItem("p1", "asset-11")] };
    expect(normalizeSectionContent(map)).toEqual({});
    expect(sectionContentReferencesAsset(map, "asset-11")).toBe(true);
  });

  test("it scans every row, not just the first", () => {
    const map = {
      "row-a": [textItem("t1", "x")],
      "row-b": [null],
      "row-c": [photoItem("p1", "asset-deep")],
    };
    expect(sectionContentReferencesAsset(map, "asset-deep")).toBe(true);
  });
});
