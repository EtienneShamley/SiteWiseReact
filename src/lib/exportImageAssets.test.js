// src/lib/exportImageAssets.test.js
//
// Export-time resolution of stored image references. The rules that matter:
// each asset is read exactly once per export however often it is referenced,
// the note itself is never modified, remote and legacy images pass through
// untouched, and a reference that cannot be produced FAILS the export rather
// than shipping a document with an image silently missing.
//
// The asset store and the Blob→data-URL conversion are injected, so no
// IndexedDB and no network are involved.

import {
  EXPORT_BLOB_URL_MESSAGE,
  EXPORT_MISSING_ASSET_MESSAGE,
  EXPORT_UNREADABLE_ASSET_MESSAGE,
  EXPORT_UNSUPPORTED_ASSET_MESSAGE,
  resolveExportImageHtml,
} from "./exportImageAssets";
import { ASSET_KIND_EDITOR_IMAGE, ASSET_KIND_NOTE_PHOTO } from "./assetStorage";
import { EDITOR_IMAGE_ASSET_ATTR } from "./editorImageAssets";

const imgRef = (id, extra = "") => `<img ${EDITOR_IMAGE_ASSET_ATTR}="${id}"${extra}>`;

function store(assets) {
  const reads = [];
  const loadAsset = (id) => {
    reads.push(id);
    return Promise.resolve(assets[id] || null);
  };
  return { reads, loadAsset };
}

const asset = (type, kind = ASSET_KIND_EDITOR_IMAGE) => ({
  kind,
  blob: { type, size: 10 },
});

const blobToDataUrl = (blob) => Promise.resolve(`data:${blob.type};base64,QUJD`);

describe("resolving asset-backed images", () => {
  test("embeds JPEG, PNG and WebP", async () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      const s = store({ a: asset(type) });
      const out = await resolveExportImageHtml(`<p>${imgRef("a")}</p>`, {
        loadAsset: s.loadAsset,
        blobToDataUrl,
      });
      expect(out).toContain(`src="data:${type};base64,QUJD"`);
      // The reference is meaningless outside this browser and is not exported.
      expect(out).not.toContain(EDITOR_IMAGE_ASSET_ATTR);
    }
  });

  test("resolves a repeated assetId exactly ONCE per export", async () => {
    const s = store({ a: asset("image/png"), b: asset("image/jpeg") });
    let conversions = 0;
    const out = await resolveExportImageHtml(
      `${imgRef("a")}${imgRef("b")}${imgRef("a")}${imgRef("a")}`,
      {
        loadAsset: s.loadAsset,
        blobToDataUrl: (blob) => {
          conversions += 1;
          return blobToDataUrl(blob);
        },
      }
    );
    expect(s.reads).toEqual(["a", "b"]);
    expect(conversions).toBe(2);
    // ...but every occurrence is still resolved in the output.
    expect(out.match(/data:image\/png/g)).toHaveLength(3);
  });

  test("keeps alt and dimension hints on the exported image", async () => {
    const s = store({ a: asset("image/jpeg") });
    const out = await resolveExportImageHtml(
      imgRef("a", ' alt="site.jpg" width="800" height="600"'),
      { loadAsset: s.loadAsset, blobToDataUrl }
    );
    expect(out).toContain('alt="site.jpg"');
    expect(out).toContain('width="800"');
  });

  test("the input note HTML is never mutated", async () => {
    const html = `<p>${imgRef("a")}</p>`;
    const snapshot = String(html);
    const s = store({ a: asset("image/png") });
    const out = await resolveExportImageHtml(html, {
      loadAsset: s.loadAsset,
      blobToDataUrl,
    });
    expect(html).toBe(snapshot);
    expect(html).not.toContain("data:");
    expect(out).not.toBe(html);
  });

  test("an export-time data URL never appears in the note's own HTML", async () => {
    // The resolved string is a separate value; nothing writes it back.
    const noteHtml = `<p>${imgRef("a")}</p>`;
    const s = store({ a: asset("image/png") });
    await resolveExportImageHtml(noteHtml, { loadAsset: s.loadAsset, blobToDataUrl });
    expect(noteHtml).toBe(`<p>${imgRef("a")}</p>`);
    expect(noteHtml).not.toContain("base64");
  });
});

describe("images this path does not own", () => {
  test("a remote https image is unchanged and never fetched", async () => {
    const s = store({});
    const html = '<p><img src="https://example.com/a.png" alt="remote"></p>';
    const out = await resolveExportImageHtml(html, {
      loadAsset: s.loadAsset,
      blobToDataUrl,
    });
    expect(out).toContain('src="https://example.com/a.png"');
    expect(s.reads).toEqual([]);
  });

  test("a valid legacy data:image is left exactly as it is", async () => {
    const legacy = "data:image/png;base64,iVBORw0KGgo=";
    const out = await resolveExportImageHtml(`<img src="${legacy}">`, {
      loadAsset: store({}).loadAsset,
      blobToDataUrl,
    });
    expect(out).toContain(legacy);
  });

  test("a note with no images is returned untouched", async () => {
    const html = "<p>Just text</p>";
    expect(
      await resolveExportImageHtml(html, { loadAsset: store({}).loadAsset })
    ).toBe(html);
  });

  test("empty input is tolerated", async () => {
    expect(await resolveExportImageHtml("")).toBe("");
    expect(await resolveExportImageHtml(null)).toBe("");
  });
});

describe("refusals — the export fails rather than omitting an image", () => {
  test("a blob: image source is rejected", async () => {
    await expect(
      resolveExportImageHtml('<img src="blob:http://localhost/dead">', {
        loadAsset: store({}).loadAsset,
        blobToDataUrl,
      })
    ).rejects.toThrow(EXPORT_BLOB_URL_MESSAGE);
  });

  test("a blob: source is rejected BEFORE any storage read happens", async () => {
    const s = store({ a: asset("image/png") });
    await expect(
      resolveExportImageHtml(`${imgRef("a")}<img src="blob:http://x/y">`, {
        loadAsset: s.loadAsset,
        blobToDataUrl,
      })
    ).rejects.toThrow(EXPORT_BLOB_URL_MESSAGE);
    expect(s.reads).toEqual([]);
  });

  test("a missing asset fails the export, and does not silently omit it", async () => {
    const s = store({});
    const promise = resolveExportImageHtml(imgRef("gone"), {
      loadAsset: s.loadAsset,
      blobToDataUrl,
    });
    await expect(promise).rejects.toThrow(EXPORT_MISSING_ASSET_MESSAGE);
    await expect(promise).rejects.toThrow(/unchanged/);
  });

  test("an asset with no blob is treated as missing", async () => {
    await expect(
      resolveExportImageHtml(imgRef("a"), {
        loadAsset: () => Promise.resolve({ kind: ASSET_KIND_EDITOR_IMAGE }),
        blobToDataUrl,
      })
    ).rejects.toThrow(EXPORT_MISSING_ASSET_MESSAGE);
  });

  test("a storage read that throws fails the export", async () => {
    await expect(
      resolveExportImageHtml(imgRef("a"), {
        loadAsset: () => Promise.reject(new Error("IndexedDB unavailable")),
        blobToDataUrl,
      })
    ).rejects.toThrow(EXPORT_UNREADABLE_ASSET_MESSAGE);
  });

  test("a conversion failure fails the export without leaking internal detail", async () => {
    const promise = resolveExportImageHtml(imgRef("a"), {
      loadAsset: () => Promise.resolve(asset("image/png")),
      blobToDataUrl: () => Promise.reject(new Error("EBADF internal reader state")),
    });
    await expect(promise).rejects.toThrow(EXPORT_UNREADABLE_ASSET_MESSAGE);
    // The user is shown our wording, never the underlying failure string.
    await expect(promise).rejects.not.toThrow(/EBADF/);
  });

  test("the MIME is decided from the stored Blob, not the reference", async () => {
    // A Blob whose own type is not an accepted image is refused even though the
    // note refers to it as an image.
    for (const type of ["image/svg+xml", "image/gif", "text/html", ""]) {
      await expect(
        resolveExportImageHtml(imgRef("a"), {
          loadAsset: () => Promise.resolve(asset(type)),
          blobToDataUrl,
        })
      ).rejects.toThrow(EXPORT_UNSUPPORTED_ASSET_MESSAGE);
    }
  });

  test("an asset of the wrong KIND is refused", async () => {
    // Free-form export must not reach into Template-form evidence.
    await expect(
      resolveExportImageHtml(imgRef("a"), {
        loadAsset: () => Promise.resolve(asset("image/png", ASSET_KIND_NOTE_PHOTO)),
        blobToDataUrl,
      })
    ).rejects.toThrow(EXPORT_UNSUPPORTED_ASSET_MESSAGE);
  });

  test("every refusal message says nothing was downloaded and nothing changed", async () => {
    for (const message of [
      EXPORT_BLOB_URL_MESSAGE,
      EXPORT_MISSING_ASSET_MESSAGE,
      EXPORT_UNREADABLE_ASSET_MESSAGE,
      EXPORT_UNSUPPORTED_ASSET_MESSAGE,
    ]) {
      expect(message).toMatch(/Nothing was downloaded/);
      expect(message).toMatch(/unchanged/);
    }
  });
});

describe("no network is involved", () => {
  test("resolution never calls fetch", async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(() => Promise.reject(new Error("no network in tests")));
    try {
      const s = store({ a: asset("image/jpeg") });
      await resolveExportImageHtml(
        `${imgRef("a")}<img src="https://example.com/remote.png">`,
        { loadAsset: s.loadAsset, blobToDataUrl }
      );
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = realFetch;
    }
  });
});
