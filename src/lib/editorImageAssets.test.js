// src/lib/editorImageAssets.test.js
//
// The persistence boundary for a Free-form image. These tests are the guarantee
// that stored note HTML can never contain image BYTES or a dead runtime URL —
// asserted on the exact attribute map the editor node serializes, so they hold
// without a browser or a running editor.

import {
  EDITOR_IMAGE_ASSET_ATTR,
  collectAssetIdsFromHtml,
  editorImageAttrsFromElement,
  editorImageAttrsToHTML,
  isBlobUrl,
  isPersistableImageSrc,
} from "./editorImageAssets";

const el = (attrs) => ({ getAttribute: (name) => (name in attrs ? attrs[name] : null) });

describe("serialization of an asset-backed image", () => {
  test("emits the reference and NEVER a src", () => {
    const out = editorImageAttrsToHTML({
      assetId: "asset-1",
      src: "blob:http://localhost/abc",
      alt: "site.jpg",
      width: 1600,
      height: 1200,
    });
    expect(out[EDITOR_IMAGE_ASSET_ATTR]).toBe("asset-1");
    expect(out.src).toBeUndefined();
    expect("src" in out).toBe(false);
  });

  test("carries only lightweight render hints", () => {
    const out = editorImageAttrsToHTML({
      assetId: "asset-1",
      alt: "site.jpg",
      title: "Site photo",
      width: 1600,
      height: 1200,
    });
    expect(Object.keys(out).sort()).toEqual(
      [EDITOR_IMAGE_ASSET_ATTR, "alt", "height", "title", "width"].sort()
    );
    expect(out.width).toBe("1600");
    expect(out.height).toBe("1200");
  });

  test("no serialized image can contain base64 bytes or a blob URL", () => {
    const cases = [
      { assetId: "a1", src: "data:image/png;base64,AAAA" },
      { assetId: "a1", src: "blob:http://localhost/x" },
      { src: "blob:http://localhost/x" },
    ];
    for (const attrs of cases) {
      const serialized = JSON.stringify(editorImageAttrsToHTML(attrs));
      expect(serialized).not.toContain("base64");
      expect(serialized).not.toContain("blob:");
    }
  });

  test("an empty or whitespace assetId is not a reference", () => {
    expect(editorImageAttrsToHTML({ assetId: "   ", src: "https://x/y.png" }).src).toBe(
      "https://x/y.png"
    );
    expect(
      EDITOR_IMAGE_ASSET_ATTR in editorImageAttrsToHTML({ assetId: "", src: "https://x/y.png" })
    ).toBe(false);
  });

  test("a non-positive dimension is dropped rather than emitted as 0", () => {
    const out = editorImageAttrsToHTML({ assetId: "a1", width: 0, height: -5 });
    expect("width" in out).toBe(false);
    expect("height" in out).toBe(false);
  });
});

describe("serialization of remote and legacy images", () => {
  test("a remote https image keeps its src unchanged", () => {
    const out = editorImageAttrsToHTML({ src: "https://example.com/a.png", alt: "a" });
    expect(out.src).toBe("https://example.com/a.png");
    expect(EDITOR_IMAGE_ASSET_ATTR in out).toBe(false);
  });

  test("a legacy data:image src is preserved, not destroyed", () => {
    // Existing notes contain these. Refusing to serialize one would delete a
    // user's image on the next save.
    const legacy = "data:image/png;base64,iVBORw0KGgo=";
    expect(editorImageAttrsToHTML({ src: legacy }).src).toBe(legacy);
  });

  test("a blob: src is dropped even with no assetId — it is already dead", () => {
    const out = editorImageAttrsToHTML({ src: "blob:http://localhost/gone" });
    expect("src" in out).toBe(false);
  });

  test("the two src predicates agree on what may be persisted", () => {
    expect(isBlobUrl("blob:http://x/y")).toBe(true);
    expect(isBlobUrl("BLOB:http://x/y")).toBe(true);
    expect(isBlobUrl("https://x/y")).toBe(false);
    expect(isPersistableImageSrc("blob:http://x/y")).toBe(false);
    expect(isPersistableImageSrc("https://x/y.png")).toBe(true);
    expect(isPersistableImageSrc("data:image/png;base64,AA")).toBe(true);
    expect(isPersistableImageSrc("")).toBe(false);
    expect(isPersistableImageSrc(null)).toBe(false);
  });
});

describe("parsing an image back out of stored HTML", () => {
  test("an asset reference survives a serialize -> parse round trip", () => {
    const attrs = { assetId: "asset-9", alt: "photo.jpg", width: 800, height: 600 };
    const serialized = editorImageAttrsToHTML(attrs);
    const parsed = editorImageAttrsFromElement(el(serialized));
    expect(parsed.assetId).toBe("asset-9");
    expect(parsed.alt).toBe("photo.jpg");
    expect(parsed.width).toBe(800);
    expect(parsed.height).toBe(600);
    expect(parsed.src).toBeNull();
  });

  test("an asset-backed image ignores any src it happens to carry", () => {
    const parsed = editorImageAttrsFromElement(
      el({ [EDITOR_IMAGE_ASSET_ATTR]: "a1", src: "https://example.com/x.png" })
    );
    expect(parsed.assetId).toBe("a1");
    expect(parsed.src).toBeNull();
  });

  test("a blob: src stored by an older build is dropped on the way IN", () => {
    const parsed = editorImageAttrsFromElement(el({ src: "blob:http://x/dead" }));
    expect(parsed.src).toBeNull();
    expect(parsed.assetId).toBeNull();
  });

  test("a legacy base64 image still parses, so existing notes keep it", () => {
    const legacy = "data:image/jpeg;base64,/9j/4AAQ";
    const parsed = editorImageAttrsFromElement(el({ src: legacy }));
    expect(parsed.src).toBe(legacy);
  });

  test("a remote image still parses", () => {
    const parsed = editorImageAttrsFromElement(el({ src: "http://example.com/a.png" }));
    expect(parsed.src).toBe("http://example.com/a.png");
  });
});

describe("presentation attributes (shared media core)", () => {
  test("a stored width and wrap layout serialize as the three data attributes", () => {
    const out = editorImageAttrsToHTML({
      assetId: "a1",
      widthPct: 45,
      layoutMode: "wrap",
      layoutSide: "right",
    });
    expect(out["data-width-pct"]).toBe("45");
    expect(out["data-layout-mode"]).toBe("wrap");
    expect(out["data-layout-side"]).toBe("right");
  });

  test("DEFAULTS ARE NEVER EMITTED — a legacy image serializes exactly as before", () => {
    const out = editorImageAttrsToHTML({
      assetId: "a1",
      alt: "site.jpg",
      width: 1600,
      height: 1200,
    });
    expect(Object.keys(out).sort()).toEqual(
      [EDITOR_IMAGE_ASSET_ATTR, "alt", "height", "width"].sort()
    );
    // Explicit defaults are just as silent as absent values.
    const explicit = editorImageAttrsToHTML({
      assetId: "a1",
      widthPct: null,
      layoutMode: "block",
      layoutSide: null,
    });
    expect("data-width-pct" in explicit).toBe(false);
    expect("data-layout-mode" in explicit).toBe(false);
    expect("data-layout-side" in explicit).toBe(false);
  });

  test("an invalid width or an incomplete wrap degrades and is not emitted", () => {
    expect("data-width-pct" in editorImageAttrsToHTML({ assetId: "a", widthPct: "abc" })).toBe(
      false
    );
    // Wrap without a usable side is block, so no layout attributes at all.
    const out = editorImageAttrsToHTML({ assetId: "a", layoutMode: "wrap", layoutSide: "middle" });
    expect("data-layout-mode" in out).toBe(false);
    expect("data-layout-side" in out).toBe(false);
    // An out-of-range number is clamped, not dropped: the user chose a width.
    expect(editorImageAttrsToHTML({ assetId: "a", widthPct: 500 })["data-width-pct"]).toBe("100");
  });

  test("presentation attributes ride on remote images too — the model is not asset-only", () => {
    const out = editorImageAttrsToHTML({
      src: "https://example.com/a.png",
      widthPct: 60,
      layoutMode: "wrap",
      layoutSide: "left",
    });
    expect(out.src).toBe("https://example.com/a.png");
    expect(out["data-width-pct"]).toBe("60");
    expect(out["data-layout-mode"]).toBe("wrap");
  });

  test("parsing validates in: invalid stored values degrade to the defaults", () => {
    const parsed = editorImageAttrsFromElement(
      el({
        [EDITOR_IMAGE_ASSET_ATTR]: "a1",
        "data-width-pct": "banana",
        "data-layout-mode": "hologram",
        "data-layout-side": "left",
      })
    );
    expect(parsed.widthPct).toBeNull();
    expect(parsed.layoutMode).toBe("block");
    expect(parsed.layoutSide).toBeNull();
  });

  test("a legacy element without the attributes parses to the legacy defaults", () => {
    const parsed = editorImageAttrsFromElement(el({ [EDITOR_IMAGE_ASSET_ATTR]: "a1" }));
    expect(parsed.widthPct).toBeNull();
    expect(parsed.layoutMode).toBe("block");
    expect(parsed.layoutSide).toBeNull();
  });

  test("a full presentation round trip survives serialize -> parse", () => {
    const serialized = editorImageAttrsToHTML({
      assetId: "a1",
      widthPct: 38,
      layoutMode: "wrap",
      layoutSide: "left",
    });
    const parsed = editorImageAttrsFromElement(el(serialized));
    expect(parsed.widthPct).toBe(38);
    expect(parsed.layoutMode).toBe("wrap");
    expect(parsed.layoutSide).toBe("left");
  });

  test("a wrap whose stored side is missing parses as block AS ONE UNIT", () => {
    const parsed = editorImageAttrsFromElement(
      el({ [EDITOR_IMAGE_ASSET_ATTR]: "a1", "data-layout-mode": "wrap" })
    );
    expect(parsed.layoutMode).toBe("block");
    expect(parsed.layoutSide).toBeNull();
  });
});

describe("collectAssetIdsFromHtml", () => {
  test("finds each distinct id once, in first-appearance order", () => {
    const html = `
      <p><img ${EDITOR_IMAGE_ASSET_ATTR}="a" alt="1"></p>
      <p><img ${EDITOR_IMAGE_ASSET_ATTR}="b" alt="2"></p>
      <p><img ${EDITOR_IMAGE_ASSET_ATTR}="a" alt="3"></p>
    `;
    expect(collectAssetIdsFromHtml(html)).toEqual(["a", "b"]);
  });

  test("ignores remote and legacy images", () => {
    const html =
      '<img src="https://x/y.png"><img src="data:image/png;base64,AA">';
    expect(collectAssetIdsFromHtml(html)).toEqual([]);
  });

  test("handles single quotes and tolerates empty input", () => {
    expect(collectAssetIdsFromHtml(`<img ${EDITOR_IMAGE_ASSET_ATTR}='z'>`)).toEqual(["z"]);
    expect(collectAssetIdsFromHtml("")).toEqual([]);
    expect(collectAssetIdsFromHtml(null)).toEqual([]);
  });
});

describe("P4. an annotated image's original-photo reference", () => {
  const {
    EDITOR_IMAGE_ANNOTATION_SOURCE_ATTR,
    annotationSourceIdFromAttrs,
    collectAnnotationSourceIdsFromHtml,
    collectAssetIdsFromHtml,
  } = require("./editorImageAssets");
  const el = (map) => ({ getAttribute: (n) => (n in map ? map[n] : null) });

  test("serializes beside the rendition reference and round-trips", () => {
    const out = editorImageAttrsToHTML({ assetId: "rend", annotationSourceId: "orig", alt: "Wall" });
    expect(out).toEqual({ "data-asset-id": "rend", [EDITOR_IMAGE_ANNOTATION_SOURCE_ATTR]: "orig", alt: "Wall" });
    expect(editorImageAttrsFromElement(el(out)).annotationSourceId).toBe("orig");
  });

  test("is never emitted for an image that has not been annotated, so legacy HTML is byte-identical", () => {
    expect(editorImageAttrsToHTML({ assetId: "a" })).toEqual({ "data-asset-id": "a" });
    expect(editorImageAttrsToHTML({ assetId: "a", annotationSourceId: null })).toEqual({ "data-asset-id": "a" });
    expect(editorImageAttrsFromElement(el({ "data-asset-id": "a" })).annotationSourceId).toBeNull();
  });

  test("never accompanies a remote or legacy src, and never names the image itself", () => {
    expect(editorImageAttrsToHTML({ src: "https://x/y.png", annotationSourceId: "orig" })).toEqual({ src: "https://x/y.png" });
    expect(annotationSourceIdFromAttrs({ assetId: "a", annotationSourceId: "a" })).toBeNull();
    expect(editorImageAttrsFromElement(el({ src: "https://x/y.png", [EDITOR_IMAGE_ANNOTATION_SOURCE_ATTR]: "orig" })).annotationSourceId).toBeNull();
  });

  test("the source collector is separate from the display collector", () => {
    const html = `<p>x</p><img data-asset-id="rend" ${EDITOR_IMAGE_ANNOTATION_SOURCE_ATTR}='orig'><img data-asset-id="plain">`;
    expect(collectAssetIdsFromHtml(html)).toEqual(["rend", "plain"]);
    expect(collectAnnotationSourceIdsFromHtml(html)).toEqual(["orig"]);
    expect(collectAnnotationSourceIdsFromHtml("")).toEqual([]);
  });
});
