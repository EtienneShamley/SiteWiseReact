// src/lib/editorImageUrlImport.test.js
//
// IMAGE BY WEB ADDRESS, ON BOTH SURFACES (Production Readiness Phase 7.8).
//
// Before this phase a Template Section IMPORTED the address into an
// asset-backed image while a Free-form note persisted the remote `src`
// verbatim. A stored remote src is not a NoteWise image: it is a promise that
// somebody else's server will still be serving that picture, it leaks the
// reader's IP and referrer to that server every time the note is opened, it
// cannot be exported, read offline, annotated or synced, and the bytes never
// pass through the privacy pipeline at all. So a NEW insertion now goes
// through the SAME import on both surfaces.
//
// What this suite pins:
//
//   ONE IMPLEMENTATION      both surfaces reach the same fetch + validate +
//                           normalise + store + insert sequence. There is no
//                           second URL-import path to drift.
//   CONTENT DECIDES         the scheme is refused from the PARSED URL, and
//                           what came back is judged by its own bytes and
//                           type — never by the ".png" in the address.
//   NOTHING ON FAILURE      a refused import creates no asset, no queue entry
//                           and no node, and says why.
//   HISTORY IS UNTOUCHED    a note that already contains a remote-src image
//                           still serializes it exactly as it did. Existing
//                           content is not rewritten, and nothing fetches it.

import { insertLocalImageAsset } from "./editorImageInsert";
import {
  IMAGE_URL_IMPORT_MESSAGE,
  fetchImageFromUrl,
  imageNameFromUrl,
  importImageFromUrl,
} from "./editorImageUrlImport";
import { editorImageAttrsFromElement, editorImageAttrsToHTML } from "./editorImageAssets";
import { UNSAFE_IMAGE_URL_MESSAGE } from "./editorUrlSafety";
import { IMAGE_UNSUPPORTED_MESSAGE } from "./imageProcessing";
import { PRIVACY_METHOD, PRIVACY_NORMALIZATION_KEY, isPrivacyNormalized, privacyNormalizationMark } from "./imagePrivacy";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const pngBlob = () => new Blob([PNG_BYTES], { type: "image/png" });

/** A fetch that returns one response body. */
function respondWith(blob, { contentLength = null, ok = true } = {}) {
  return async () => ({
    ok,
    headers: { get: (name) => (name === "content-length" ? contentLength : null) },
    blob: async () => blob,
  });
}

/* ------------------------------ the fetch -------------------------------- */

describe("what may be fetched at all", () => {
  test("only http and https — decided from the parsed URL, before any request", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:image/png;base64,AAA", "blob:x"]) {
      let called = false;
      const result = await fetchImageFromUrl(url, {
        fetchImpl: async () => {
          called = true;
          return { ok: true };
        },
      });
      expect(result).toEqual({ ok: false, error: UNSAFE_IMAGE_URL_MESSAGE });
      expect(called).toBe(false);
    }
  });

  test("a scheme hidden inside control characters is not rescued", async () => {
    const result = await fetchImageFromUrl("java\tscript:alert(1)", { fetchImpl: async () => ({ ok: true }) });
    expect(result.ok).toBe(false);
  });

  test("the request carries no credentials and no cache", async () => {
    let init = null;
    await fetchImageFromUrl("https://example.com/p.png", {
      fetchImpl: async (_href, options) => {
        init = options;
        return { ok: true, headers: { get: () => null }, blob: async () => pngBlob() };
      },
    });
    expect(init).toMatchObject({ mode: "cors", credentials: "omit", cache: "no-store" });
  });

  test("a valid https image comes back as a File named from the address", async () => {
    const result = await fetchImageFromUrl("https://example.com/site/photo.png", {
      fetchImpl: respondWith(pngBlob()),
    });
    expect(result.ok).toBe(true);
    expect(result.file.type).toBe("image/png");
    expect(result.file.name).toBe("photo.png");
    expect(imageNameFromUrl("https://example.com/")).toBe("image");
  });
});

describe("what is refused, and what it says", () => {
  test("an HTML response is not an image, whatever the address ended in", async () => {
    const html = new Blob(["<!doctype html><html>"], { type: "text/html" });
    const result = await fetchImageFromUrl("https://example.com/looks-like.png", {
      fetchImpl: respondWith(html),
    });
    expect(result).toEqual({ ok: false, error: IMAGE_URL_IMPORT_MESSAGE.NOT_IMAGE });
  });

  test("a CORS refusal or a dead network is explained, and points at Upload photo", async () => {
    const result = await fetchImageFromUrl("https://example.com/p.png", {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(result).toEqual({ ok: false, error: IMAGE_URL_IMPORT_MESSAGE.BLOCKED });
    expect(result.error).toMatch(/Upload photo/);
  });

  test("an error response is refused", async () => {
    const result = await fetchImageFromUrl("https://example.com/p.png", {
      fetchImpl: respondWith(pngBlob(), { ok: false }),
    });
    expect(result.ok).toBe(false);
  });

  test("an oversized image is refused by its declared length AND by its real size", async () => {
    const declared = await fetchImageFromUrl("https://example.com/p.png", {
      fetchImpl: respondWith(pngBlob(), { contentLength: String(50 * 1024 * 1024) }),
    });
    expect(declared).toEqual({ ok: false, error: IMAGE_URL_IMPORT_MESSAGE.TOO_LARGE });

    // A lying content-length does not help: the bytes themselves are measured.
    const measured = await fetchImageFromUrl("https://example.com/p.png", {
      fetchImpl: respondWith(pngBlob(), { contentLength: "10" }),
      maxBytes: 4,
    });
    expect(measured).toEqual({ ok: false, error: IMAGE_URL_IMPORT_MESSAGE.TOO_LARGE });
  });

  test("a download that never finishes is abandoned and explained", async () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    const result = await fetchImageFromUrl("https://example.com/p.png", {
      fetchImpl: async () => {
        throw aborted;
      },
    });
    expect(result).toEqual({ ok: false, error: IMAGE_URL_IMPORT_MESSAGE.TIMEOUT });
  });
});

/* ------------------------------- the import ------------------------------ */

describe("an imported address becomes an ordinary NoteWise image asset", () => {
  /** The shared write sequence, with every platform call injected. */
  function insertDeps({ normalizeResult, insertResult = { ok: true } } = {}) {
    const created = [];
    const inserted = [];
    const deleted = [];
    return {
      created,
      inserted,
      deleted,
      deps: {
        normalize: async (blob, options) => {
          created.push({ normalizedFrom: blob, options });
          return (
            normalizeResult || {
              blob: pngBlob(),
              width: 400,
              height: 300,
              mimeType: "image/png",
              processed: true,
              privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
            }
          );
        },
        createAsset: async (blob, options) => {
          created.push({ blob, options });
          return "asset-from-url";
        },
        removeAsset: async (id) => deleted.push(id),
        insertNode: (editor, attrs) => {
          inserted.push({ editor, attrs });
          return insertResult;
        },
      },
    };
  }

  test("the FREE-FORM default carries no surface policy — it uses the shared defaults", async () => {
    const seen = [];
    const result = await importImageFromUrl(
      { url: "https://example.com/p.png", editor: { id: "E" } },
      {
        fetchImage: async () => ({
          ok: true,
          file: new File([pngBlob()], "p.png", { type: "image/png" }),
          href: "https://example.com/p.png",
        }),
        insert: async (args, deps) => {
          seen.push({ args, deps });
          return { ok: true, assetId: "a1" };
        },
      }
    );
    expect(result).toEqual({ ok: true, assetId: "a1" });
    // Undefined deps IS the Free-form policy: `insertLocalImageAsset` falls
    // back to validateEditorImageFile / normalizeImageFile /
    // createEditorImageAsset — the same defaults the local picker gets.
    expect(seen[0].deps).toBeUndefined();
    expect(seen[0].args.sourceFile.name).toBe("p.png");
  });

  test("the stored bytes are PRIVACY-NORMALISED and the record says so", async () => {
    const harness = insertDeps();
    const file = new File([pngBlob()], "p.png", { type: "image/png" });

    const result = await insertLocalImageAsset(
      { sourceFile: file, editor: { id: "E" }, name: "p.png" },
      harness.deps
    );

    expect(result.ok).toBe(true);
    const write = harness.created.find((c) => c.options && c.options.metadata);
    expect(isPrivacyNormalized(write.options.metadata)).toBe(true);
    expect(write.options.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.REENCODED);
  });

  test("the node that lands in the document is an ASSET reference — never a remote src", async () => {
    const harness = insertDeps();
    await insertLocalImageAsset(
      { sourceFile: new File([pngBlob()], "p.png", { type: "image/png" }), editor: { id: "E" } },
      harness.deps
    );
    expect(harness.inserted[0].attrs).toMatchObject({ assetId: "asset-from-url", width: 400, height: 300 });
    expect(harness.inserted[0].attrs.src).toBeUndefined();
    // And what it serializes to carries no `src` at all.
    expect(editorImageAttrsToHTML(harness.inserted[0].attrs)).toEqual({
      "data-asset-id": "asset-from-url",
      alt: "p.png",
      width: "400",
      height: "300",
    });
  });

  test("a refused type creates NOTHING — no fetch result becomes an asset", async () => {
    const svg = new File([new Blob(["<svg/>"], { type: "image/svg+xml" })], "x.svg", {
      type: "image/svg+xml",
    });
    let inserted = false;
    const result = await importImageFromUrl(
      { url: "https://example.com/x.svg", editor: { id: "E" } },
      {
        fetchImage: async () => ({ ok: true, file: svg, href: "https://example.com/x.svg" }),
        insert: async () => {
          inserted = true;
          return { ok: true };
        },
      }
    );
    expect(result).toEqual({ ok: false, error: IMAGE_UNSUPPORTED_MESSAGE });
    expect(inserted).toBe(false);
  });

  test("a failed insertion deletes the bytes rather than leaving an orphan", async () => {
    const harness = insertDeps({ insertResult: { ok: false, error: "no room" } });
    const result = await insertLocalImageAsset(
      { sourceFile: new File([pngBlob()], "p.png", { type: "image/png" }), editor: { id: "E" } },
      harness.deps
    );
    expect(result.ok).toBe(false);
    expect(harness.deleted).toEqual(["asset-from-url"]);
  });

  test("a cancelled prompt is not a failure and does nothing", async () => {
    let touched = false;
    const insert = async () => {
      touched = true;
      return { ok: true };
    };
    expect(await importImageFromUrl({ url: null, editor: { id: "E" } }, { insert })).toEqual({
      ok: true,
      cancelled: true,
    });
    expect(await importImageFromUrl({ url: "   ", editor: { id: "E" } }, { insert })).toEqual({
      ok: true,
      cancelled: true,
    });
    expect(touched).toBe(false);
  });

  test("no editor, no import", async () => {
    expect(await importImageFromUrl({ url: "https://example.com/p.png" })).toEqual({ ok: false, error: null });
  });
});

/* ------------------------------- history --------------------------------- */

describe("images already in a note are not touched", () => {
  test("a historic remote-src image still round-trips exactly as it did", () => {
    const parsed = editorImageAttrsFromElement({
      getAttribute: (name) => (name === "src" ? "https://example.com/old.png" : null),
    });
    expect(parsed.src).toBe("https://example.com/old.png");
    expect(parsed.assetId).toBeNull();
    // Serialized back byte-identically: nothing rewrites it, and nothing
    // fetches it. A migration would reach out to third-party servers on the
    // user's behalf for content that may have changed or gone — deliberately
    // not this phase's work.
    expect(editorImageAttrsToHTML(parsed)).toEqual({ src: "https://example.com/old.png" });
  });

  test("a blob: URL is still dropped in both directions", () => {
    expect(editorImageAttrsToHTML({ src: "blob:https://app/x" })).toEqual({});
    expect(
      editorImageAttrsFromElement({ getAttribute: (n) => (n === "src" ? "blob:https://app/x" : null) }).src
    ).toBeNull();
  });
});
