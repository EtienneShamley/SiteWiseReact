// src/lib/localAssetCache.test.js
//
// WHERE THE BYTES ARE (Production Readiness Phase 7.2). NoteWise keeps binary
// data in two IndexedDB databases for good reasons, and this module is the
// only place that has to know which. What matters:
//
//   - a general asset comes back as the STORED RECORD, unchanged, so every
//     reader's own kind and MIME policy still reads exactly what it read
//     before;
//   - PDF source bytes come from `pdfDocBytes`, keyed by SOURCE id, and are
//     never copied into the asset store;
//   - the `kind` argument routes and cannot be used to reach the wrong store's
//     object under the same id.
import "fake-indexeddb/auto";
import {
  ASSET_KIND_PDF_SOURCE,
  GENERAL_ASSET_KINDS,
  isPdfSourceKind,
  localAssetExists,
  localAssetSize,
  readLocalAsset,
  writeDownloadedAsset,
} from "./localAssetCache";
import {
  ASSET_KIND_EDITOR_FILE,
  ASSET_KIND_EDITOR_IMAGE,
  ASSET_KIND_NOTE_FILE,
  ASSET_KIND_NOTE_PHOTO,
  DOWNLOADED_ASSET_REASON,
  createEditorImageAsset,
  getAsset,
  listAssetIds,
  makeAssetRecord,
  saveAsset,
} from "./assetStorage";
import { listPendingAssetUploads } from "./assetUploadQueue";
import { loadPdfBytes, removePdfBytes, savePdfBytes } from "./pdfStorage";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "./assetDbTestHarness";
import { DURABLE_SCOPE_KIND, setDurableScope } from "./durableStorage";

installStructuredCloneShim();

const PDF_SOURCE_ID = "src-11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  await deleteAssetDb();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });
  await removePdfBytes(PDF_SOURCE_ID);
});

describe("the kind vocabulary", () => {
  test("every general asset kind the product creates is a general kind", () => {
    expect(GENERAL_ASSET_KINDS).toEqual(
      expect.arrayContaining([
        "logo",
        ASSET_KIND_NOTE_PHOTO,
        ASSET_KIND_NOTE_FILE,
        ASSET_KIND_EDITOR_IMAGE,
        ASSET_KIND_EDITOR_FILE,
      ])
    );
    expect(GENERAL_ASSET_KINDS).not.toContain(ASSET_KIND_PDF_SOURCE);
  });

  test("only `pdf-source` routes to the PDF store", () => {
    expect(isPdfSourceKind(ASSET_KIND_PDF_SOURCE)).toBe(true);
    for (const kind of [...GENERAL_ASSET_KINDS, null, undefined, "asset"]) {
      expect(isPdfSourceKind(kind)).toBe(false);
    }
  });
});

describe("general asset kinds route to the asset store", () => {
  test("the stored record comes back unchanged, bytes and all", async () => {
    const id = await createEditorImageAsset(testBlob("IMAGEBYTES", "image/png"), { name: "i.png" });
    const asset = await readLocalAsset(id, { kind: ASSET_KIND_EDITOR_IMAGE });
    expect(asset).toMatchObject({
      id,
      kind: ASSET_KIND_EDITOR_IMAGE,
      name: "i.png",
      mimeType: "image/png",
    });
    expect(await asset.blob.text()).toBe("IMAGEBYTES");
  });

  test("no kind at all still reads the general store — the caller checks the kind", async () => {
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    // The record's OWN kind is what a surface's policy is decided from, and it
    // is returned untouched for that purpose.
    expect((await readLocalAsset(id)).kind).toBe(ASSET_KIND_EDITOR_IMAGE);
  });

  test("a missing asset is null, and so is a missing id", async () => {
    expect(await readLocalAsset("no-such-asset")).toBeNull();
    expect(await readLocalAsset(null)).toBeNull();
    expect(await readLocalAsset("")).toBeNull();
  });

  test("a legacy unscoped record is readable exactly as it always was", async () => {
    await saveAsset(
      makeAssetRecord({ id: "legacy-1", kind: "logo", name: "old.png", blob: testBlob("OLD") })
    );
    const asset = await readLocalAsset("legacy-1", { kind: "logo" });
    expect(asset).toMatchObject({ id: "legacy-1", kind: "logo", name: "old.png" });
    expect(asset.workspaceId).toBeNull();
    expect(await asset.blob.text()).toBe("OLD");
  });

  test("existence is answered without reading the bytes", async () => {
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    expect(await localAssetExists(id)).toBe(true);
    expect(await localAssetExists("no-such-asset")).toBe(false);
    expect(await localAssetExists(null)).toBe(false);
  });

  test("localAssetSize reports the stored size without opening the Blob (7.6)", async () => {
    const id = await createEditorImageAsset(testBlob("twelve bytes"));
    expect(await localAssetSize(id)).toBe(12);
    expect(await localAssetSize("no-such-asset")).toBe(0);
    expect(await localAssetSize(null)).toBe(0);
  });
});

describe("pdf-source routes to the PDF byte store", () => {
  beforeEach(async () => {
    await savePdfBytes(PDF_SOURCE_ID, new Uint8Array([37, 80, 68, 70]), "plans.pdf");
  });

  test("the bytes come back as a Uint8Array with the document's name", async () => {
    const rec = await readLocalAsset(PDF_SOURCE_ID, { kind: ASSET_KIND_PDF_SOURCE });
    expect(rec).toMatchObject({
      id: PDF_SOURCE_ID,
      kind: ASSET_KIND_PDF_SOURCE,
      name: "plans.pdf",
      mimeType: "application/pdf",
      size: 4,
    });
    expect(Array.from(rec.bytes)).toEqual([37, 80, 68, 70]);
  });

  test("the bytes are NOT duplicated into the asset store", async () => {
    expect(await listAssetIds()).not.toContain(PDF_SOURCE_ID);
    // …and the same id read as a general asset finds nothing, because nothing
    // was written there.
    expect(await readLocalAsset(PDF_SOURCE_ID)).toBeNull();
  });

  test("existence is answered from the PDF store", async () => {
    expect(await localAssetExists(PDF_SOURCE_ID, { kind: ASSET_KIND_PDF_SOURCE })).toBe(true);
    await removePdfBytes(PDF_SOURCE_ID);
    expect(await localAssetExists(PDF_SOURCE_ID, { kind: ASSET_KIND_PDF_SOURCE })).toBe(false);
  });

  test("localAssetSize routes to the PDF store too, and is 0 once the bytes are gone (7.6)", async () => {
    expect(await localAssetSize(PDF_SOURCE_ID, { kind: ASSET_KIND_PDF_SOURCE })).toBe(4);
    // The same id asked for as a GENERAL asset finds nothing: the kind routes.
    expect(await localAssetSize(PDF_SOURCE_ID)).toBe(0);
    await removePdfBytes(PDF_SOURCE_ID);
    expect(await localAssetSize(PDF_SOURCE_ID, { kind: ASSET_KIND_PDF_SOURCE })).toBe(0);
  });

  test("a missing PDF source is null, not an error", async () => {
    expect(await readLocalAsset("no-such-source", { kind: ASSET_KIND_PDF_SOURCE })).toBeNull();
  });
});

describe("kind mismatch cannot reach the wrong store's object", () => {
  test("a general asset id asked for as pdf-source resolves to nothing", async () => {
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    expect(await readLocalAsset(id, { kind: ASSET_KIND_PDF_SOURCE })).toBeNull();
    expect(await localAssetExists(id, { kind: ASSET_KIND_PDF_SOURCE })).toBe(false);
  });

  test("a PDF source id asked for as a general kind resolves to nothing", async () => {
    await savePdfBytes(PDF_SOURCE_ID, new Uint8Array([1, 2, 3]), "p.pdf");
    expect(await readLocalAsset(PDF_SOURCE_ID, { kind: ASSET_KIND_EDITOR_FILE })).toBeNull();
  });

  test("the record's own kind is preserved so a caller's policy still decides", async () => {
    // The card that opens Free-form attachments accepts `editor-file` and
    // refuses `note-file`; that decision is made from THIS value, never from a
    // name or an extension, and the cache does not launder it.
    await saveAsset(
      makeAssetRecord({
        id: "kind-1",
        kind: ASSET_KIND_NOTE_FILE,
        name: "invoice.pdf",
        blob: testBlob("PDF", "application/pdf"),
      })
    );
    const asset = await readLocalAsset("kind-1", { kind: ASSET_KIND_EDITOR_FILE });
    expect(asset.kind).toBe(ASSET_KIND_NOTE_FILE);
  });
});

/* ------------------------------------------------------------------------ *
 * Production Readiness Phase 7.5 — caching a DOWNLOADED asset
 * ------------------------------------------------------------------------ */

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";
const DOWNLOAD_ID = "dl-11111111-1111-4111-8111-111111111111";

function download(overrides = {}) {
  const blob = overrides.blob || testBlob("REMOTE", "image/png");
  return {
    workspaceId: WS_A,
    assetId: DOWNLOAD_ID,
    assetKind: ASSET_KIND_EDITOR_IMAGE,
    blob,
    mimeType: "image/png",
    size: blob.size,
    name: "remote.png",
    metadata: { fromCloud: true },
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe("writeDownloadedAsset — a general asset", () => {
  test("it is stored as a WORKSPACE-OWNED record carrying the cloud's own facts", async () => {
    expect(await writeDownloadedAsset(download())).toEqual({ ok: true, reused: false });
    const stored = await getAsset(DOWNLOAD_ID);
    expect(stored).toMatchObject({
      id: DOWNLOAD_ID,
      kind: ASSET_KIND_EDITOR_IMAGE,
      name: "remote.png",
      mimeType: "image/png",
      workspaceId: WS_A,
      createdAt: 1700000000000,
      metadata: { fromCloud: true },
    });
    expect(await stored.blob.text()).toBe("REMOTE");
  });

  test("it NEVER enqueues an upload — the bytes came from the account", async () => {
    await writeDownloadedAsset(download());
    expect(await listPendingAssetUploads(WS_A)).toEqual([]);
  });

  test("it preserves the cloud identity chain of a derived asset", async () => {
    await writeDownloadedAsset(download({ sourceAssetId: "src-a" }));
    expect((await getAsset(DOWNLOAD_ID)).sourceAssetId).toBe("src-a");
  });

  test("the same asset arriving twice is idempotent and rewrites nothing", async () => {
    await writeDownloadedAsset(download());
    const first = await getAsset(DOWNLOAD_ID);
    expect(await writeDownloadedAsset(download({ name: "renamed.png" }))).toEqual({
      ok: true,
      reused: true,
    });
    const second = await getAsset(DOWNLOAD_ID);
    expect(second.name).toBe(first.name);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  test("it refuses to overwrite a record ANOTHER workspace owns", async () => {
    await saveAsset(
      makeAssetRecord({
        id: DOWNLOAD_ID,
        kind: ASSET_KIND_EDITOR_IMAGE,
        blob: testBlob("REMOTE", "image/png"),
        workspaceId: WS_B,
      })
    );
    expect(await writeDownloadedAsset(download())).toEqual({
      ok: false,
      reason: DOWNLOADED_ASSET_REASON.FOREIGN_WORKSPACE,
    });
    expect(await (await getAsset(DOWNLOAD_ID)).blob.text()).toBe("REMOTE");
    expect((await getAsset(DOWNLOAD_ID)).workspaceId).toBe(WS_B);
  });

  test("it refuses to replace a CONTRADICTING local record and changes nothing", async () => {
    await saveAsset(
      makeAssetRecord({
        id: DOWNLOAD_ID,
        kind: ASSET_KIND_NOTE_FILE,
        blob: testBlob("SOMETHING ELSE", "text/plain"),
        workspaceId: WS_A,
      })
    );
    expect(await writeDownloadedAsset(download())).toEqual({
      ok: false,
      reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT,
    });
    expect((await getAsset(DOWNLOAD_ID)).kind).toBe(ASSET_KIND_NOTE_FILE);
  });

  test("a matching LEGACY record is left untagged — re-tagging is the 7.6 migration", async () => {
    await saveAsset(
      makeAssetRecord({
        id: DOWNLOAD_ID,
        kind: ASSET_KIND_EDITOR_IMAGE,
        blob: testBlob("REMOTE", "image/png"),
      })
    );
    expect(await writeDownloadedAsset(download())).toEqual({ ok: true, reused: true });
    expect((await getAsset(DOWNLOAD_ID)).workspaceId).toBeNull();
  });

  test("bytes that contradict the size the workspace recorded are refused", async () => {
    expect(await writeDownloadedAsset(download({ size: 999 }))).toEqual({
      ok: false,
      reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT,
    });
    expect(await getAsset(DOWNLOAD_ID)).toBeNull();
  });

  test("an invalid workspace or asset id is refused rather than stored unowned", async () => {
    expect(await writeDownloadedAsset(download({ workspaceId: "not a workspace" }))).toEqual({
      ok: false,
      reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT,
    });
    expect(await writeDownloadedAsset(download({ assetId: "../escape" }))).toEqual({
      ok: false,
      reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT,
    });
    expect(await listAssetIds()).toEqual([]);
  });
});

describe("writeDownloadedAsset — pdf-source", () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);

  function pdfDownload(overrides = {}) {
    const blob = testBlob("%PDF-", "application/pdf");
    return download({
      assetId: PDF_SOURCE_ID,
      assetKind: ASSET_KIND_PDF_SOURCE,
      blob,
      mimeType: "application/pdf",
      size: blob.size,
      name: "plans.pdf",
      ...overrides,
    });
  }

  test("it is routed to the PDF byte store, never into the asset store", async () => {
    expect(await writeDownloadedAsset(pdfDownload())).toEqual({ ok: true, reused: false });
    const rec = await loadPdfBytes(PDF_SOURCE_ID);
    expect(rec.bytes.byteLength).toBe(5);
    expect(rec.name).toBe("plans.pdf");
    expect(await listAssetIds()).toEqual([]);
    expect(await listPendingAssetUploads(WS_A)).toEqual([]);
  });

  test("the same source already here is idempotent", async () => {
    await savePdfBytes(PDF_SOURCE_ID, bytes, "plans.pdf");
    expect(await writeDownloadedAsset(pdfDownload())).toEqual({ ok: true, reused: true });
  });

  test("a DIFFERENT file under the same immutable source id is refused", async () => {
    await savePdfBytes(PDF_SOURCE_ID, new Uint8Array([1, 2, 3]), "other.pdf");
    expect(await writeDownloadedAsset(pdfDownload())).toEqual({
      ok: false,
      reason: DOWNLOADED_ASSET_REASON.LOCAL_CONFLICT,
    });
    expect((await loadPdfBytes(PDF_SOURCE_ID)).name).toBe("other.pdf");
  });
});
