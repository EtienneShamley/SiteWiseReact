// src/lib/cloud/assetRemoteRead.test.js
//
// THE READ-THROUGH ENGINE (Production Readiness Phase 7.5), driven against
// the in-memory Firestore and Storage twins and a REAL IndexedDB
// (fake-indexeddb), so the whole path — index, metadata, object head,
// download, verification, cache write — is exercised end to end without
// Firebase.
//
// The properties under test, in the order they matter:
//
//   LOCAL FIRST          a local hit costs nothing and reaches nothing;
//   NOT LOSS             a reference whose cloud metadata does not exist yet
//                        is RECOVERABLE, because structured data syncs
//                        independently of bytes and a note can arrive before
//                        the photo it names;
//   NEVER TRUST A PATH   the object standing on the path is compared with
//                        what the workspace says the asset is, and the bytes
//                        are compared again after they arrive. A
//                        contradiction caches nothing;
//   NO CLOUD WRITES      a read never creates, tombstones or restores an
//                        asset document;
//   ISOLATION            a stopped reader writes nothing, anywhere.
import "fake-indexeddb/auto";
import fs from "fs";
import path from "path";
import { createAssetRemoteReader, entrySignature } from "./assetRemoteRead";
import { createMemoryAssetStore } from "./memoryAssetStore";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";
import { assetStorageMetadata, buildAssetDocument } from "./assetCloudModel";
import { assetDocumentPath } from "./assetPaths";
import { ASSET_READ_CODE, ASSET_READ_STATE } from "../assetReader";
import { ASSET_KIND_PDF_SOURCE, readLocalAsset } from "../localAssetCache";
import { getAsset, makeAssetRecord, saveAsset } from "../assetStorage";
import { REMOTE_ASSET_STATE, getRemoteAssetEntry, listRemoteAssetEntries, putRemoteAssetEntry } from "../assetRemoteIndex";
import { listPendingAssetUploads } from "../assetUploadQueue";
import { loadPdfBytes, removePdfBytes } from "../pdfStorage";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "../assetDbTestHarness";

installStructuredCloneShim();

const WID = "ws-aaaaaaa1-0000-4000-8000-aaaaaaaaaaaa";
const OTHER = "ws-bbbbbbb2-0000-4000-8000-bbbbbbbbbbbb";
const A1 = "asset-1111-4222-8333-444455556666";
const A2 = "asset-2222-4222-8333-444455556666";
const PDF1 = "src-3333-4222-8333-444455556666";

const IMAGE_BYTES = "REMOTE-IMAGE";
const PDF_BYTES = "%PDF-1.7";

function workspaceStore(uid = "alice") {
  const store = createMemoryWorkspaceStore();
  for (const wid of [WID, OTHER]) {
    store.seed(["workspaces", wid], { id: wid, ownerUid: uid, schemaVersion: 1 });
    store.seed(["workspaces", wid, "members", uid], { uid, role: "owner" });
  }
  store.setUser(uid);
  return store;
}

function imageFields(workspaceId = WID, id = A1, extra = {}) {
  const built = buildAssetDocument({
    workspaceId,
    id,
    assetKind: "editor-image",
    name: "remote.png",
    mimeType: "image/png",
    size: IMAGE_BYTES.length,
    createdAt: 1725000000000,
    metadata: { width: 4 },
    ...extra,
  });
  if (!built.ok) throw new Error(`fixture is not a valid asset document: ${built.reason}`);
  return built.fields;
}

function pdfFields(workspaceId = WID, id = PDF1) {
  const built = buildAssetDocument({
    workspaceId,
    id,
    assetKind: ASSET_KIND_PDF_SOURCE,
    name: "plans.pdf",
    mimeType: "application/pdf",
    size: PDF_BYTES.length,
    createdAt: 1725000000000,
    metadata: {},
  });
  if (!built.ok) throw new Error(`fixture is not a valid asset document: ${built.reason}`);
  return built.fields;
}

/** Place a document and its object, exactly as a finished upload leaves them. */
async function seedStoredAsset(store, assets, fields, text) {
  store.seed(assetDocumentPath(fields.workspaceId, fields.id), { ...fields, updatedAt: 1725000000001 });
  await assets.seed(fields.workspaceId, fields.id, testBlob(text, fields.mimeType), {
    contentType: fields.mimeType,
    metadata: assetStorageMetadata(fields),
  });
}

function makeReader(store, assets, extra = {}) {
  return createAssetRemoteReader({ workspaceId: WID, assetStore: assets, workspaceStore: store, ...extra });
}

/**
 * A Blob's text. The in-memory store hands back the environment's own Blob,
 * and jsdom's has neither `text()` nor `arrayBuffer()`.
 */
function blobText(blob) {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

let store;
let assets;

beforeEach(async () => {
  await deleteAssetDb();
  await removePdfBytes(PDF1);
  store = workspaceStore();
  assets = createMemoryAssetStore({ workspaceStore: store });
});

/* --------------------------------- reads --------------------------------- */

describe("a successful cross-device read", () => {
  test("it downloads once, caches locally, and returns the stored record", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const reader = makeReader(store, assets);

    const result = await reader.read({ assetId: A1, kind: null });
    expect(result.state).toBe(ASSET_READ_STATE.READY);
    expect(await blobText(result.record.blob)).toBe(IMAGE_BYTES);
    expect(assets.calls.downloads).toHaveLength(1);

    const cached = await getAsset(A1);
    expect(cached).toMatchObject({
      kind: "editor-image",
      name: "remote.png",
      mimeType: "image/png",
      workspaceId: WID,
      createdAt: 1725000000000,
    });
    expect(cached.metadata).toEqual({ width: 4 });
  });

  test("a downloaded asset is NEVER queued for upload back to the account", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    await makeReader(store, assets).read({ assetId: A1 });
    expect(await listPendingAssetUploads(WID)).toEqual([]);
  });

  test("the read writes nothing to Firestore", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const before = store.calls.commits.length;
    await makeReader(store, assets).read({ assetId: A1 });
    expect(store.calls.commits.length).toBe(before);
  });

  test("the remote index learns the object is stored, and every remote read still re-reads it", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const reader = makeReader(store, assets);
    await reader.read({ assetId: A1 });
    expect(await getRemoteAssetEntry(WID, A1)).toMatchObject({
      state: REMOTE_ASSET_STATE.STORED,
      kind: "editor-image",
      mimeType: "image/png",
      size: IMAGE_BYTES.length,
    });

    // Remove the local copy but keep the index. The index does NOT license a
    // download: the second read costs exactly one more metadata read.
    const reads = store.calls.reads;
    await deleteRecordOnly(A1);
    await reader.read({ assetId: A1 });
    expect(store.calls.reads).toBe(reads + 1);
    expect(assets.calls.downloads).toHaveLength(2);
  });

  test("a pdf-source is routed to the PDF byte store, not the asset store", async () => {
    await seedStoredAsset(store, assets, pdfFields(), PDF_BYTES);
    const result = await makeReader(store, assets).read({ assetId: PDF1, kind: ASSET_KIND_PDF_SOURCE });
    expect(result.state).toBe(ASSET_READ_STATE.READY);
    expect(result.record.kind).toBe(ASSET_KIND_PDF_SOURCE);
    expect(result.record.bytes.byteLength).toBe(PDF_BYTES.length);
    expect((await loadPdfBytes(PDF1)).name).toBe("plans.pdf");
    expect(await getAsset(PDF1)).toBeNull();
    expect(await listPendingAssetUploads(WID)).toEqual([]);
  });

  test("the download start is announced exactly once, before the bytes move", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const onDownloadStart = jest.fn(() => {
      expect(assets.calls.downloads).toHaveLength(0);
    });
    await makeReader(store, assets).read({ assetId: A1, onDownloadStart });
    expect(onDownloadStart).toHaveBeenCalledTimes(1);
  });
});

/** Remove a cached asset record without touching the remote index. */
async function deleteRecordOnly(assetId) {
  const { assetDbTransaction, ASSET_STORE } = await import("../assetDb");
  await assetDbTransaction(ASSET_STORE, "readwrite", (stores) => stores[ASSET_STORE].delete(assetId));
}

describe("recoverable states — never presented as loss", () => {
  test("no cloud metadata at all is PENDING, not missing", async () => {
    const result = await makeReader(store, assets).read({ assetId: A1 });
    expect(result).toEqual({
      state: ASSET_READ_STATE.PENDING,
      record: null,
      code: ASSET_READ_CODE.NOT_YET_UPLOADED,
    });
    expect(assets.calls.downloads).toHaveLength(0);
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.MISSING);
  });

  test("stored metadata with NO object is PENDING, and caches nothing", async () => {
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });
    const result = await makeReader(store, assets).read({ assetId: A1 });
    expect(result).toMatchObject({
      state: ASSET_READ_STATE.PENDING,
      code: ASSET_READ_CODE.REMOTE_OBJECT_MISSING,
    });
    expect(await getAsset(A1)).toBeNull();
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.MISSING);
  });

  test("a TOMBSTONED asset is recoverable: no download, no cloud write, no resurrection", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    store.seed(assetDocumentPath(WID, A1), {
      ...imageFields(),
      state: "tombstoned",
      tombstonedAt: 1725000000002,
      updatedAt: 1725000000002,
    });
    const commits = store.calls.commits.length;

    const result = await makeReader(store, assets).read({ assetId: A1 });
    expect(result).toMatchObject({
      state: ASSET_READ_STATE.PENDING,
      code: ASSET_READ_CODE.TOMBSTONED,
    });
    expect(assets.calls.downloads).toHaveLength(0);
    expect(store.calls.commits.length).toBe(commits);
    expect(await getAsset(A1)).toBeNull();
    // The local index records the truth — tombstoned is not "missing".
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.TOMBSTONED);
    // And the document itself is untouched.
    expect((await store.readAssetDocument(WID, A1)).fields.state).toBe("tombstoned");
  });

  test("a stale TOMBSTONED index entry does not refuse an asset the workspace has restored", async () => {
    // The mirror of the stale-`stored` hazard, and the reason the index is
    // never consulted for lifecycle: this browser last saw a tombstone, the
    // collector has since restored the document, and the read must succeed.
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    await putRemoteAssetEntry({
      workspaceId: WID,
      assetId: A1,
      kind: "editor-image",
      mimeType: "image/png",
      size: IMAGE_BYTES.length,
      state: REMOTE_ASSET_STATE.TOMBSTONED,
    });
    const result = await makeReader(store, assets).read({ assetId: A1 });
    expect(result.state).toBe(ASSET_READ_STATE.READY);
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.STORED);
  });

  test("a transient cloud failure is OFFLINE, not an error and not a loss", async () => {
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });
    store.failNext("read", "unavailable");
    expect(await makeReader(store, assets).read({ assetId: A1, refresh: true })).toEqual({
      state: ASSET_READ_STATE.OFFLINE,
      record: null,
      code: ASSET_READ_CODE.OFFLINE,
    });
  });

  test("a Storage read that never reached the network is OFFLINE", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    assets.failNext("download", "storage/retry-limit-exceeded");
    expect((await makeReader(store, assets).read({ assetId: A1 })).state).toBe(
      ASSET_READ_STATE.OFFLINE
    );
    expect(await getAsset(A1)).toBeNull();
  });

  test("a refused read is an ERROR the user cannot wait out", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    store.setUser("mallory");
    expect(await makeReader(store, assets).read({ assetId: A1, refresh: true })).toMatchObject({
      state: ASSET_READ_STATE.ERROR,
      code: ASSET_READ_CODE.UNAUTHORIZED,
    });
  });
});

describe("nothing contradictory is ever cached", () => {
  test("a malformed cloud document is an ERROR, reported and excluded", async () => {
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), size: -3, updatedAt: 1 });
    const onMalformed = jest.fn();
    const result = await makeReader(store, assets, { onMalformed }).read({ assetId: A1 });
    expect(result).toMatchObject({
      state: ASSET_READ_STATE.ERROR,
      code: ASSET_READ_CODE.MALFORMED_CLOUD_RECORD,
    });
    expect(onMalformed).toHaveBeenCalledWith({ collection: "assets", id: A1, reason: "bad-size" });
    // Never recorded as knowledge, never repaired.
    expect(await getRemoteAssetEntry(WID, A1)).toBeNull();
    expect(assets.calls.downloads).toHaveLength(0);
  });

  test("an object whose identity metadata names a different asset is a CONFLICT", async () => {
    const fields = imageFields();
    store.seed(assetDocumentPath(WID, A1), { ...fields, updatedAt: 1 });
    await assets.seed(WID, A1, testBlob(IMAGE_BYTES, "image/png"), {
      contentType: "image/png",
      metadata: { assetId: A2, workspaceId: WID, assetKind: "editor-image" },
    });
    expect(await makeReader(store, assets).read({ assetId: A1 })).toMatchObject({
      state: ASSET_READ_STATE.CONFLICT,
      code: ASSET_READ_CODE.IDENTITY_CONFLICT,
    });
    expect(assets.calls.downloads).toHaveLength(0);
    expect(await getAsset(A1)).toBeNull();
  });

  test("an object of a different size than the document describes is a CONFLICT", async () => {
    const fields = imageFields();
    store.seed(assetDocumentPath(WID, A1), { ...fields, updatedAt: 1 });
    await assets.seed(WID, A1, testBlob("SHORT", "image/png"), {
      contentType: "image/png",
      metadata: assetStorageMetadata(fields),
    });
    expect((await makeReader(store, assets).read({ assetId: A1 })).code).toBe(
      ASSET_READ_CODE.IDENTITY_CONFLICT
    );
    expect(assets.calls.downloads).toHaveLength(0);
  });

  test("an object whose content type contradicts the document is a CONFLICT", async () => {
    const fields = imageFields();
    store.seed(assetDocumentPath(WID, A1), { ...fields, updatedAt: 1 });
    await assets.seed(WID, A1, testBlob(IMAGE_BYTES, "image/jpeg"), {
      contentType: "image/jpeg",
      metadata: assetStorageMetadata(fields),
    });
    expect((await makeReader(store, assets).read({ assetId: A1 })).code).toBe(
      ASSET_READ_CODE.IDENTITY_CONFLICT
    );
  });

  test("bytes that arrive the wrong LENGTH are a conflict and are not cached", async () => {
    // The head agrees with the document; the object hands back fewer bytes.
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const reader = createAssetRemoteReader({
      workspaceId: WID,
      workspaceStore: store,
      assetStore: {
        ...assets,
        downloadAsset: async () => testBlob("SHORT", "image/png"),
      },
    });
    expect(await reader.read({ assetId: A1 })).toMatchObject({
      state: ASSET_READ_STATE.CONFLICT,
      code: ASSET_READ_CODE.CONTENT_CONFLICT,
    });
    expect(await getAsset(A1)).toBeNull();
  });

  test("bytes whose MIME contradicts the canonical metadata are a conflict", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const reader = createAssetRemoteReader({
      workspaceId: WID,
      workspaceStore: store,
      assetStore: {
        ...assets,
        downloadAsset: async () => testBlob(IMAGE_BYTES, "text/html"),
      },
    });
    expect(await reader.read({ assetId: A1 })).toMatchObject({
      state: ASSET_READ_STATE.CONFLICT,
      code: ASSET_READ_CODE.CONTENT_CONFLICT,
    });
    expect(await getAsset(A1)).toBeNull();
  });

  test("a pdf-source document may not satisfy a general read, or the reverse", async () => {
    await seedStoredAsset(store, assets, pdfFields(), PDF_BYTES);
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const reader = makeReader(store, assets);
    expect((await reader.read({ assetId: PDF1, kind: null })).code).toBe(
      ASSET_READ_CODE.IDENTITY_CONFLICT
    );
    expect((await reader.read({ assetId: A1, kind: ASSET_KIND_PDF_SOURCE })).code).toBe(
      ASSET_READ_CODE.IDENTITY_CONFLICT
    );
    expect(assets.calls.downloads).toHaveLength(0);
  });

  test("a local record ANOTHER workspace owns is never overwritten by a download", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    await saveAsset(
      makeAssetRecord({
        id: A1,
        kind: "editor-image",
        blob: testBlob(IMAGE_BYTES, "image/png"),
        workspaceId: OTHER,
      })
    );
    expect(await makeReader(store, assets).read({ assetId: A1 })).toMatchObject({
      state: ASSET_READ_STATE.CONFLICT,
      code: ASSET_READ_CODE.LOCAL_CONFLICT,
    });
    expect((await getAsset(A1)).workspaceId).toBe(OTHER);
  });
});

/* ------------------------------- hydration -------------------------------- */

describe("index hydration", () => {
  test("valid documents populate the index as stored or tombstoned, with no downloads", async () => {
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });
    store.seed(assetDocumentPath(WID, A2), {
      ...imageFields(WID, A2),
      state: "tombstoned",
      tombstonedAt: 2,
      updatedAt: 2,
    });

    const result = await makeReader(store, assets).hydrateIndex();
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ stored: 1, tombstoned: 1, removed: 0 });
    const entries = await listRemoteAssetEntries(WID);
    expect(entries.map((e) => [e.assetId, e.state]).sort()).toEqual([
      [A1, REMOTE_ASSET_STATE.STORED],
      [A2, REMOTE_ASSET_STATE.TOMBSTONED],
    ]);
    expect(entries.find((e) => e.assetId === A1)).toMatchObject({
      kind: "editor-image",
      mimeType: "image/png",
      size: IMAGE_BYTES.length,
    });
    expect(assets.calls.downloads).toHaveLength(0);
    expect(assets.calls.exists).toBe(0);
  });

  test("a malformed document is excluded and reported, and never overwrites what is known", async () => {
    await putRemoteAssetEntry({
      workspaceId: WID,
      assetId: A2,
      kind: "editor-image",
      mimeType: "image/png",
      size: 12,
      state: REMOTE_ASSET_STATE.STORED,
    });
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });
    store.seed(assetDocumentPath(WID, A2), { ...imageFields(WID, A2), mimeType: "text/html", updatedAt: 1 });

    const onMalformed = jest.fn();
    const result = await makeReader(store, assets, { onMalformed }).hydrateIndex();
    expect(result.malformed).toEqual([{ collection: "assets", id: A2, reason: "bad-mime-type" }]);
    expect(onMalformed).toHaveBeenCalledTimes(1);
    expect(result.counts).toEqual({ stored: 1, tombstoned: 0, removed: 0 });
    // Excluded, not repaired and not swept.
    expect((await getRemoteAssetEntry(WID, A2)).state).toBe(REMOTE_ASSET_STATE.STORED);
  });

  test("an entry the workspace no longer describes is removed", async () => {
    await putRemoteAssetEntry({
      workspaceId: WID,
      assetId: A2,
      kind: "editor-image",
      state: REMOTE_ASSET_STATE.STORED,
    });
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });

    const result = await makeReader(store, assets).hydrateIndex();
    expect(result.counts.removed).toBe(1);
    expect(await getRemoteAssetEntry(WID, A2)).toBeNull();
    expect(await getRemoteAssetEntry(WID, A1)).not.toBeNull();
  });

  test("another workspace's index is never read or touched", async () => {
    await putRemoteAssetEntry({
      workspaceId: OTHER,
      assetId: A1,
      kind: "editor-image",
      state: REMOTE_ASSET_STATE.STORED,
    });
    store.seed(assetDocumentPath(OTHER, A2), { ...imageFields(OTHER, A2), updatedAt: 1 });

    await makeReader(store, assets).hydrateIndex();
    expect((await listRemoteAssetEntries(OTHER)).map((e) => e.assetId)).toEqual([A1]);
    expect(await getRemoteAssetEntry(WID, A2)).toBeNull();
  });

  test("a failed index read reports itself and destroys no local knowledge", async () => {
    await putRemoteAssetEntry({
      workspaceId: WID,
      assetId: A1,
      kind: "editor-image",
      state: REMOTE_ASSET_STATE.STORED,
    });
    store.failNext("read", "unavailable");
    const result = await makeReader(store, assets).hydrateIndex();
    expect(result).toMatchObject({ ok: false, code: ASSET_READ_CODE.OFFLINE });
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.STORED);
  });
});

/* ---------------------------- session isolation --------------------------- */

describe("session and account isolation", () => {
  test("a reader stopped mid-download writes nothing and returns no record", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    let reader;
    const gatedStore = {
      ...assets,
      downloadAsset: async (...args) => {
        // The session closes while the bytes are in flight — the exact shape
        // of a sign-out or an account switch during a download.
        reader.stop();
        return assets.downloadAsset(...args);
      },
    };
    reader = createAssetRemoteReader({ workspaceId: WID, workspaceStore: store, assetStore: gatedStore });

    const result = await reader.read({ assetId: A1 });
    expect(result).toMatchObject({ record: null, code: ASSET_READ_CODE.NO_SESSION });
    expect(await getAsset(A1)).toBeNull();
    expect(await listPendingAssetUploads(WID)).toEqual([]);
  });

  test("a stopped reader refuses further reads outright", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const reader = makeReader(store, assets);
    reader.stop();
    expect(reader.isActive()).toBe(false);
    expect(await reader.read({ assetId: A1 })).toMatchObject({
      state: ASSET_READ_STATE.MISSING,
      code: ASSET_READ_CODE.NO_SESSION,
    });
    expect(assets.calls.exists).toBe(0);
  });

  test("a stopped reader hydrates nothing", async () => {
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });
    const reader = makeReader(store, assets);
    reader.stop();
    expect(await reader.hydrateIndex()).toMatchObject({ ok: false, code: ASSET_READ_CODE.NO_SESSION });
    expect(await listRemoteAssetEntries(WID)).toEqual([]);
  });

  test("the reader names ONE workspace for its whole life", async () => {
    const reader = makeReader(store, assets);
    expect(reader.workspaceId).toBe(WID);
    expect(Object.isFrozen(reader)).toBe(true);
  });
});

/* ------------------------------ unconfigured ------------------------------ */

describe("a build with no Storage bucket", () => {
  test("it reports unconfigured, makes no cloud call, and leaves local reads alone", async () => {
    const reader = createAssetRemoteReader({ workspaceId: WID, workspaceStore: store, assetStore: null });
    expect(reader.configured).toBe(false);
    expect(await reader.read({ assetId: A1 })).toEqual({
      state: ASSET_READ_STATE.MISSING,
      record: null,
      code: ASSET_READ_CODE.UNCONFIGURED,
    });
    expect(store.calls.reads).toBe(0);
    expect(assets.calls.exists).toBe(0);
  });

  test("it hydrates nothing rather than indexing objects it could never fetch", async () => {
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });
    const reader = createAssetRemoteReader({ workspaceId: WID, workspaceStore: store, assetStore: null });
    expect(await reader.hydrateIndex()).toMatchObject({
      ok: false,
      code: ASSET_READ_CODE.UNCONFIGURED,
    });
    expect(await listRemoteAssetEntries(WID)).toEqual([]);
    expect(store.calls.reads).toBe(0);
  });

  test("a local asset still reads exactly as it always has", async () => {
    await saveAsset(
      makeAssetRecord({ id: A1, kind: "editor-image", blob: testBlob("LOCAL", "image/png") })
    );
    expect(await (await readLocalAsset(A1)).blob.text()).toBe("LOCAL");
  });
});

/* -------------------------------- boundaries ------------------------------ */

describe("module boundaries", () => {
  test("the reader imports no Firebase SDK and mints no download URL", () => {
    const source = fs.readFileSync(path.join(__dirname, "assetRemoteRead.js"), "utf8");
    expect(source).not.toMatch(/from "firebase\//);
    expect(source).not.toMatch(/getDownloadURL/);
  });

  test("a reader cannot be created without a workspace", () => {
    expect(() => createAssetRemoteReader({})).toThrow(/workspace id is required/i);
  });
});

/* ------------------------------------------------------------------------ *
 * The index is a DISCOVERY CACHE, never authoritative lifecycle state
 * ------------------------------------------------------------------------ */

describe("cloud-metadata freshness before any download", () => {
  /**
   * The hazard shape: this session hydrated `A1` as `stored`, another device
   * has since changed it, and the Storage object physically survives the
   * change. Only a CURRENT document read can tell the difference.
   */
  async function withStaleStoredIndex() {
    await putRemoteAssetEntry({
      workspaceId: WID,
      assetId: A1,
      kind: "editor-image",
      name: "remote.png",
      mimeType: "image/png",
      size: IMAGE_BYTES.length,
      state: REMOTE_ASSET_STATE.STORED,
    });
  }

  test("1. index stored + document stored → the download proceeds", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    await withStaleStoredIndex();
    const reads = store.calls.reads;
    const result = await makeReader(store, assets).read({ assetId: A1 });
    expect(result.state).toBe(ASSET_READ_STATE.READY);
    // Exactly one document read, not zero.
    expect(store.calls.reads).toBe(reads + 1);
    expect(assets.calls.downloads).toHaveLength(1);
  });

  test("2. index stored + document TOMBSTONED → no download, recoverable state", async () => {
    // The object is still there — the tombstone window — which is precisely
    // why the stale entry would otherwise have been enough to fetch it.
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    store.seed(assetDocumentPath(WID, A1), {
      ...imageFields(),
      state: "tombstoned",
      tombstonedAt: 1725000000002,
      updatedAt: 1725000000002,
    });
    await withStaleStoredIndex();

    const result = await makeReader(store, assets).read({ assetId: A1 });
    expect(result).toMatchObject({
      state: ASSET_READ_STATE.PENDING,
      record: null,
      code: ASSET_READ_CODE.TOMBSTONED,
    });
    expect(assets.calls.downloads).toHaveLength(0);
    expect(assets.calls.exists).toBe(0);
    expect(await getAsset(A1)).toBeNull();
    // 6. the index is corrected from the current document.
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.TOMBSTONED);
  });

  test("3. index stored + document now ABSENT → no download, even though the object exists", async () => {
    await assets.seed(WID, A1, testBlob(IMAGE_BYTES, "image/png"), {
      contentType: "image/png",
      metadata: assetStorageMetadata(imageFields()),
    });
    await withStaleStoredIndex();

    const result = await makeReader(store, assets).read({ assetId: A1 });
    expect(result).toMatchObject({
      state: ASSET_READ_STATE.PENDING,
      record: null,
      code: ASSET_READ_CODE.NOT_YET_UPLOADED,
    });
    expect(assets.calls.downloads).toHaveLength(0);
    expect(await getAsset(A1)).toBeNull();
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.MISSING);
  });

  test("4. index stored + document now MALFORMED → error, quarantined, no download", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), size: -1, updatedAt: 1 });
    await withStaleStoredIndex();

    const onMalformed = jest.fn();
    const result = await makeReader(store, assets, { onMalformed }).read({ assetId: A1 });
    expect(result).toMatchObject({
      state: ASSET_READ_STATE.ERROR,
      code: ASSET_READ_CODE.MALFORMED_CLOUD_RECORD,
    });
    expect(onMalformed).toHaveBeenCalledWith({ collection: "assets", id: A1, reason: "bad-size" });
    expect(assets.calls.downloads).toHaveLength(0);
    // What could not be read never overwrites what was known.
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.STORED);
  });

  test("5. index stored + document identity now contradicts the request → conflict, no download", async () => {
    // The workspace now describes this id as a PDF source; the caller is
    // reading it as a general asset. The stale entry said `editor-image`.
    await seedStoredAsset(store, assets, pdfFields(WID, A1), PDF_BYTES);
    await withStaleStoredIndex();

    const result = await makeReader(store, assets).read({ assetId: A1, kind: null });
    expect(result).toMatchObject({
      state: ASSET_READ_STATE.CONFLICT,
      code: ASSET_READ_CODE.IDENTITY_CONFLICT,
    });
    expect(assets.calls.downloads).toHaveLength(0);
    expect(await getAsset(A1)).toBeNull();
  });

  test("6. a successful refresh rewrites the index from the current document", async () => {
    // The stale entry describes the asset wrongly; after the read the index
    // carries what the workspace actually says.
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    await putRemoteAssetEntry({
      workspaceId: WID,
      assetId: A1,
      kind: "editor-image",
      name: "an old name.png",
      mimeType: "image/png",
      size: 9999,
      state: REMOTE_ASSET_STATE.STORED,
    });
    await makeReader(store, assets).read({ assetId: A1 });
    expect(await getRemoteAssetEntry(WID, A1)).toMatchObject({
      state: REMOTE_ASSET_STATE.STORED,
      name: "remote.png",
      size: IMAGE_BYTES.length,
    });
  });

  test("a local HIT still costs no network at all", async () => {
    await seedStoredAsset(store, assets, imageFields(), IMAGE_BYTES);
    const reader = makeReader(store, assets);
    await reader.read({ assetId: A1 });
    const reads = store.calls.reads;
    const downloads = assets.calls.downloads.length;
    // The reader is only ever consulted on a local miss (assetReader), but
    // prove the cost directly: a second read of an asset now cached locally
    // never reaches this engine.
    expect(await readLocalAsset(A1)).not.toBeNull();
    expect(store.calls.reads).toBe(reads);
    expect(assets.calls.downloads).toHaveLength(downloads);
  });
});

/* ------------------------------------------------------------------------ *
 * Hydration racing the upload engine
 * ------------------------------------------------------------------------ */

describe("hydration's stale sweep never destroys newer local knowledge", () => {
  test("an upload that settles WHILE hydration runs keeps its index entry", async () => {
    // Hydration and the upload engine start together. The Firestore snapshot
    // is taken first; the upload settles after it, writing a `stored` entry
    // for an asset that snapshot could not contain — and removing its queue
    // entry in the same transaction, so this entry is the only local record
    // that the asset is already in the account.
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });

    let settleDuringHydration = null;
    const racingStore = {
      ...store,
      readAssetIndex: async (wid) => {
        const listed = await store.readAssetIndex(wid);
        if (settleDuringHydration) await settleDuringHydration();
        return listed;
      },
    };

    settleDuringHydration = () =>
      putRemoteAssetEntry({
        workspaceId: WID,
        assetId: A2,
        kind: "editor-image",
        mimeType: "image/png",
        size: 12,
        state: REMOTE_ASSET_STATE.STORED,
      });

    const result = await makeReader(racingStore, assets).hydrateIndex();
    expect(result.ok).toBe(true);
    expect(result.counts.removed).toBe(0);
    expect((await getRemoteAssetEntry(WID, A2)).state).toBe(REMOTE_ASSET_STATE.STORED);
    expect((await getRemoteAssetEntry(WID, A1)).state).toBe(REMOTE_ASSET_STATE.STORED);
  });

  test("an entry UPDATED while hydration runs is also left alone", async () => {
    await putRemoteAssetEntry({
      workspaceId: WID,
      assetId: A2,
      kind: "editor-image",
      state: REMOTE_ASSET_STATE.PENDING,
      updatedAt: 1000,
    });
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });

    const racingStore = {
      ...store,
      readAssetIndex: async (wid) => {
        const listed = await store.readAssetIndex(wid);
        // The upload engine settles A2 after the snapshot was taken.
        await putRemoteAssetEntry({
          workspaceId: WID,
          assetId: A2,
          kind: "editor-image",
          state: REMOTE_ASSET_STATE.STORED,
          updatedAt: 2000,
        });
        return listed;
      },
    };

    const result = await makeReader(racingStore, assets).hydrateIndex();
    expect(result.counts.removed).toBe(0);
    expect((await getRemoteAssetEntry(WID, A2)).state).toBe(REMOTE_ASSET_STATE.STORED);
  });

  test("an entry that was already there and IS genuinely stale is still removed", async () => {
    // The guard is narrow: it protects concurrent writes, not obsolete ones.
    await putRemoteAssetEntry({
      workspaceId: WID,
      assetId: A2,
      kind: "editor-image",
      state: REMOTE_ASSET_STATE.STORED,
    });
    store.seed(assetDocumentPath(WID, A1), { ...imageFields(), updatedAt: 1 });

    const result = await makeReader(store, assets).hydrateIndex();
    expect(result.counts.removed).toBe(1);
    expect(await getRemoteAssetEntry(WID, A2)).toBeNull();
    expect(await getRemoteAssetEntry(WID, A1)).not.toBeNull();
  });

  test("entrySignature changes when either the state or the stamp changes", () => {
    const base = { state: REMOTE_ASSET_STATE.PENDING, updatedAt: 10 };
    expect(entrySignature(base)).toBe(entrySignature({ ...base }));
    expect(entrySignature(base)).not.toBe(entrySignature({ ...base, state: REMOTE_ASSET_STATE.STORED }));
    expect(entrySignature(base)).not.toBe(entrySignature({ ...base, updatedAt: 11 }));
    expect(entrySignature(null)).toBe("");
  });
});
