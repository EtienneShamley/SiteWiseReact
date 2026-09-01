// src/lib/assetStorageIndexedDb.test.js
//
// INDEXEDDB / ASSETS (Phase 4 brief §20, cases 29–33): the REAL asset and
// PDF storage modules run against a real IndexedDB implementation
// (fake-indexeddb, dev-only) — the first executable coverage of the actual
// put/get/delete/list paths. The pre-existing assetStorage.test.js keeps
// proving the no-IndexedDB fallback in plain jsdom.
import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "buffer";
import { serialize, deserialize } from "v8";
import {
  ASSET_KIND_EDITOR_IMAGE,
  ASSET_KIND_NOTE_PHOTO,
  assetExists,
  createEditorImageAsset,
  deleteAsset,
  getAsset,
  listAssetIds,
  listAssets,
  makeAssetRecord,
  saveAsset,
} from "./assetStorage";
import {
  loadAnnotations,
  loadPdfBytes,
  removeAnnotations,
  removePdfBytes,
  removePdfDocumentData,
  saveAnnotations,
  savePdfBytes,
} from "./pdfStorage";
import { photoAnnotationMetadata, readPhotoAnnotation } from "./photoAnnotation";
import { liveAssetIds, noteAssetManifest } from "./assetReferences";

// fake-indexeddb clones every stored value with `structuredClone`, which the
// jsdom 16 test environment does not expose. This supplies one: V8's own
// serializer for plain data, with Blobs (not V8-serializable) carried across
// by reference — exactly what a browser does with the underlying bytes.
// jsdom's Blob is not a Node Blob, so the tests build Node Blobs, which have
// the same size/type surface the record builder reads.
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const blobs = {};
      const rest = {};
      for (const [k, v] of Object.entries(value)) {
        if (v instanceof NodeBlob) blobs[k] = v;
        else rest[k] = v;
      }
      return { ...deserialize(serialize(rest)), ...blobs };
    }
    return deserialize(serialize(value));
  };
}
function blob(text, type = "image/png") {
  return new NodeBlob([text], { type });
}

async function clearStore() {
  for (const id of await listAssetIds()) await deleteAsset(id);
}

beforeEach(async () => {
  await clearStore();
});

describe("29. the real module works against a real IndexedDB", () => {
  test("open → put → get → count → delete on the actual store", async () => {
    const rec = makeAssetRecord({ id: "a1", kind: "logo", name: "logo.png", blob: blob("PNG") });
    expect(await saveAsset(rec)).toBe("a1");
    expect(await assetExists("a1")).toBe(true);
    const back = await getAsset("a1");
    expect(back).toMatchObject({ id: "a1", kind: "logo", name: "logo.png", mimeType: "image/png", size: 3 });
    expect(back.blob.size).toBe(3);
    await deleteAsset("a1");
    expect(await assetExists("a1")).toBe(false);
    expect(await getAsset("a1")).toBeNull();
  });

  test("a put with the same id is an idempotent overwrite (the migration retry contract)", async () => {
    await saveAsset(makeAssetRecord({ id: "same", kind: "logo", blob: blob("v1") }));
    await saveAsset(makeAssetRecord({ id: "same", kind: "logo", blob: blob("v2!!") }));
    expect(await listAssetIds()).toEqual(["same"]);
    expect((await getAsset("same")).size).toBe(4);
  });

  test("rejects a record without an id and never stores an empty Blob", async () => {
    await expect(saveAsset({ kind: "logo" })).rejects.toThrow(/id/);
    expect(() => makeAssetRecord({ id: "x", kind: "logo", blob: blob("") })).toThrow(/empty/);
    expect(await listAssetIds()).toEqual([]);
  });
});

describe("30. asset create / read", () => {
  test("createEditorImageAsset persists a NEW uuid-keyed record whose resolved promise is the confirmation", async () => {
    const id = await createEditorImageAsset(blob("IMG", "image/webp"), {
      name: "site.webp",
      metadata: { width: 10, height: 5 },
    });
    expect(typeof id).toBe("string");
    const rec = await getAsset(id);
    expect(rec).toMatchObject({
      kind: ASSET_KIND_EDITOR_IMAGE,
      name: "site.webp",
      mimeType: "image/webp",
      metadata: { width: 10, height: 5 },
    });
    expect(typeof rec.createdAt).toBe("number");
  });

  test("reading an unknown or empty id resolves null without touching the store", async () => {
    expect(await getAsset("nope")).toBeNull();
    expect(await getAsset("")).toBeNull();
    expect(await assetExists(undefined)).toBe(false);
  });
});

describe("31. asset enumeration", () => {
  test("lists metadata without Blobs, optionally by kind", async () => {
    await saveAsset(makeAssetRecord({ id: "l1", kind: "logo", blob: blob("L") }));
    await saveAsset(makeAssetRecord({ id: "p1", kind: ASSET_KIND_NOTE_PHOTO, blob: blob("P1") }));
    await saveAsset(makeAssetRecord({ id: "p2", kind: ASSET_KIND_NOTE_PHOTO, blob: blob("P22") }));

    const all = await listAssets();
    expect(all.map((a) => a.id).sort()).toEqual(["l1", "p1", "p2"]);
    expect(all.every((a) => !("blob" in a))).toBe(true);
    expect(all.find((a) => a.id === "p2").size).toBe(3);

    const photos = await listAssets({ kind: ASSET_KIND_NOTE_PHOTO });
    expect(photos.map((a) => a.id).sort()).toEqual(["p1", "p2"]);
    expect((await listAssetIds()).sort()).toEqual(["l1", "p1", "p2"]);
  });

  test("an empty store lists nothing", async () => {
    expect(await listAssets()).toEqual([]);
    expect(await listAssetIds()).toEqual([]);
  });
});

describe("32. deletion behaviour", () => {
  test("deleting one asset leaves the others; deleting an absent id is a harmless no-op", async () => {
    await saveAsset(makeAssetRecord({ id: "keep", kind: "logo", blob: blob("K") }));
    await saveAsset(makeAssetRecord({ id: "drop", kind: "logo", blob: blob("D") }));
    await deleteAsset("drop");
    await deleteAsset("drop");
    await deleteAsset("");
    expect(await listAssetIds()).toEqual(["keep"]);
  });

  test("PDF bytes and annotations are keyed by document id and removed together", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    await savePdfBytes("doc1", bytes, "Plan.pdf");
    await saveAnnotations("doc1", [{ id: "a", type: "rect", page: 1, rect: { x: 1, y: 1, w: 2, h: 2 } }]);
    await savePdfBytes("doc2", bytes, "Other.pdf");

    const loaded = await loadPdfBytes("doc1");
    expect(Array.from(loaded.bytes)).toEqual(Array.from(bytes));
    expect(loaded.name).toBe("Plan.pdf");
    expect(await loadAnnotations("doc1")).toHaveLength(1);

    await removePdfDocumentData("doc1");
    expect(await loadPdfBytes("doc1")).toBeNull();
    expect(await loadAnnotations("doc1")).toEqual([]);
    expect((await loadPdfBytes("doc2")).name).toBe("Other.pdf");
  });

  test("bytes keyed by a SOURCE id and annotations keyed by the DOCUMENT id are removed independently (Phase 7.0)", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    await savePdfBytes("src-old", bytes, "Plan.pdf");
    await savePdfBytes("src-new", bytes, "Plan-v2.pdf");
    await saveAnnotations("doc9", [{ id: "a", type: "rect", page: 1, rect: { x: 1, y: 1, w: 2, h: 2 } }]);

    await removePdfBytes("src-old");
    expect(await loadPdfBytes("src-old")).toBeNull();
    expect((await loadPdfBytes("src-new")).name).toBe("Plan-v2.pdf");
    expect(await loadAnnotations("doc9")).toHaveLength(1);

    await removeAnnotations("doc9");
    expect(await loadAnnotations("doc9")).toEqual([]);
    expect((await loadPdfBytes("src-new")).name).toBe("Plan-v2.pdf");
    await removePdfBytes("");
    await removeAnnotations(null);
  });
});

describe("33. the annotation rendition ↔ source relationship remains valid", () => {
  test("a rendition stored with its editable layer still resolves its ORIGINAL after unrelated deletions", async () => {
    const originalId = await createEditorImageAsset(blob("ORIGINAL", "image/jpeg"), { name: "photo.jpg" });
    const layer = photoAnnotationMetadata({
      sourceAssetId: originalId,
      items: [{ id: "r1", type: "rect", page: 1, rect: { x: 1, y: 1, w: 10, h: 10 } }],
      width: 100,
      height: 50,
    });
    const renditionId = await createEditorImageAsset(blob("FLATTENED", "image/jpeg"), {
      name: "photo.jpg",
      metadata: { annotation: layer },
    });
    const noise = await createEditorImageAsset(blob("NOISE"), {});
    await deleteAsset(noise);

    const rendition = await getAsset(renditionId);
    const stored = readPhotoAnnotation(rendition);
    expect(stored).not.toBeNull();
    expect(stored.sourceAssetId).toBe(originalId);
    expect(await assetExists(originalId)).toBe(true);
    expect((await getAsset(originalId)).blob.size).toBe("ORIGINAL".length);

    // The manifest of a note showing the rendition keeps BOTH alive: the
    // rendition by reference, the original as its annotation source.
    const html = `<img data-asset-id="${renditionId}" data-annotation-source-id="${originalId}">`;
    expect(noteAssetManifest({ html }).sort()).toEqual([originalId, renditionId].sort());
    const live = liveAssetIds({
      notes: [{ html }],
      renditionSources: (await listAssets({ kind: ASSET_KIND_EDITOR_IMAGE }))
        .map((a) => a.metadata?.annotation?.sourceAssetId)
        .filter(Boolean),
    });
    expect(live.has(originalId)).toBe(true);
    expect(live.has(renditionId)).toBe(true);
    expect(live.has(noise)).toBe(false);
  });
});
