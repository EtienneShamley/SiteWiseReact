// src/lib/assetUploadQueue.test.js
//
// The durable "what does this workspace still owe the cloud" store
// (Production Readiness Phase 7.2), against a REAL IndexedDB
// (fake-indexeddb). Two properties matter more than the CRUD:
//
//   ISOLATION   no operation can read, settle, count or clear another
//               workspace's entries — the key names the workspace, so there
//               is no argument that could reach across.
//   DURABILITY  what is owed survives the database being closed and reopened,
//               which is what a reload and a sign-out are.
import "fake-indexeddb/auto";
import {
  clearWorkspaceAssetUploads,
  settleAssetUploadAsStored,
  countPendingAssetUploads,
  enqueueAssetUpload,
  getAssetUpload,
  isQueueableWorkspaceId,
  listPendingAssetUploads,
  makeAssetUploadEntry,
  settleAssetUpload,
  updateAssetUploadAttempt,
} from "./assetUploadQueue";
import { REMOTE_ASSET_STATE, getRemoteAssetEntry } from "./assetRemoteIndex";
import { resetAssetDbConnection } from "./assetDb";
import { deleteAssetDb, installStructuredCloneShim } from "./assetDbTestHarness";

installStructuredCloneShim();

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";
const ASSET = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

beforeEach(async () => {
  await deleteAssetDb();
});

describe("makeAssetUploadEntry (pure)", () => {
  test("carries identity and retry metadata, and nothing else", () => {
    const entry = makeAssetUploadEntry({
      workspaceId: WS_A,
      assetId: ASSET,
      kind: "editor-image",
      at: 1700,
    });
    expect(entry).toEqual({
      workspaceId: WS_A,
      assetId: ASSET,
      kind: "editor-image",
      at: 1700,
      attempts: 0,
      nextAttemptAt: 1700,
      lastCode: null,
    });
  });

  test("never carries bytes", () => {
    const entry = makeAssetUploadEntry({ workspaceId: WS_A, assetId: ASSET });
    expect(entry.blob).toBeUndefined();
    expect(entry.bytes).toBeUndefined();
  });

  test("refuses a missing or path-shaped workspace or asset id", () => {
    expect(isQueueableWorkspaceId(WS_A)).toBe(true);
    expect(isQueueableWorkspaceId("../other")).toBe(false);
    expect(isQueueableWorkspaceId("")).toBe(false);
    expect(() => makeAssetUploadEntry({ workspaceId: "", assetId: ASSET })).toThrow(/workspace id/);
    expect(() => makeAssetUploadEntry({ workspaceId: "a/b", assetId: ASSET })).toThrow(/workspace id/);
    expect(() => makeAssetUploadEntry({ workspaceId: WS_A, assetId: "" })).toThrow(/asset id/);
    expect(() => makeAssetUploadEntry({ workspaceId: WS_A, assetId: "../x" })).toThrow(/asset id/);
  });
});

describe("enqueue / get / list / count", () => {
  test("an enqueued asset is pending for its workspace", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, kind: "note-photo", at: 10 });
    const entry = await getAssetUpload(WS_A, ASSET);
    expect(entry).toMatchObject({ workspaceId: WS_A, assetId: ASSET, kind: "note-photo", attempts: 0 });
    expect(await countPendingAssetUploads(WS_A)).toBe(1);
    expect(await listPendingAssetUploads(WS_A)).toHaveLength(1);
  });

  test("re-queueing the same asset replaces its entry rather than duplicating it", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, kind: "note-photo", at: 10 });
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, kind: "note-photo", at: 20 });
    expect(await countPendingAssetUploads(WS_A)).toBe(1);
    expect((await getAssetUpload(WS_A, ASSET)).at).toBe(20);
  });

  test("pending entries list oldest first", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "b-2222", kind: "logo", at: 300 });
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "a-1111", kind: "logo", at: 100 });
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "c-3333", kind: "logo", at: 200 });
    expect((await listPendingAssetUploads(WS_A)).map((e) => e.assetId)).toEqual([
      "a-1111",
      "c-3333",
      "b-2222",
    ]);
  });

  test("an absent entry is null, not an error", async () => {
    expect(await getAssetUpload(WS_A, ASSET)).toBeNull();
    expect(await countPendingAssetUploads(WS_A)).toBe(0);
    expect(await listPendingAssetUploads(WS_A)).toEqual([]);
  });
});

describe("attempt metadata and settling", () => {
  test("an attempt records its count, its next due time and the failure code", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, kind: "logo", at: 10 });
    const updated = await updateAssetUploadAttempt(WS_A, ASSET, {
      attempts: 2,
      nextAttemptAt: 5000,
      lastCode: "storage/retry-limit-exceeded",
    });
    expect(updated).toMatchObject({
      attempts: 2,
      nextAttemptAt: 5000,
      lastCode: "storage/retry-limit-exceeded",
    });
    expect(await getAssetUpload(WS_A, ASSET)).toMatchObject({ attempts: 2, nextAttemptAt: 5000 });
  });

  test("with no explicit count an attempt increments the stored one", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, at: 10 });
    await updateAssetUploadAttempt(WS_A, ASSET, {});
    await updateAssetUploadAttempt(WS_A, ASSET, {});
    expect((await getAssetUpload(WS_A, ASSET)).attempts).toBe(2);
  });

  test("a late attempt report cannot resurrect a settled entry", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, at: 10 });
    await settleAssetUpload(WS_A, ASSET);
    expect(await updateAssetUploadAttempt(WS_A, ASSET, { attempts: 9 })).toBeNull();
    expect(await getAssetUpload(WS_A, ASSET)).toBeNull();
    expect(await countPendingAssetUploads(WS_A)).toBe(0);
  });

  test("settling an entry that is already gone is success, not an error", async () => {
    await expect(settleAssetUpload(WS_A, ASSET)).resolves.toBeUndefined();
  });
});

describe("workspace isolation", () => {
  beforeEach(async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, kind: "logo", at: 10 });
  });

  test("workspace B cannot read, count or list workspace A's entry", async () => {
    expect(await getAssetUpload(WS_B, ASSET)).toBeNull();
    expect(await countPendingAssetUploads(WS_B)).toBe(0);
    expect(await listPendingAssetUploads(WS_B)).toEqual([]);
  });

  test("workspace B cannot settle workspace A's entry", async () => {
    await settleAssetUpload(WS_B, ASSET);
    expect(await getAssetUpload(WS_A, ASSET)).not.toBeNull();
  });

  test("workspace B cannot update workspace A's retry metadata", async () => {
    expect(await updateAssetUploadAttempt(WS_B, ASSET, { attempts: 7 })).toBeNull();
    expect((await getAssetUpload(WS_A, ASSET)).attempts).toBe(0);
  });

  test("clearing workspace B leaves workspace A's queue untouched", async () => {
    await enqueueAssetUpload({ workspaceId: WS_B, assetId: ASSET, kind: "logo", at: 11 });
    await clearWorkspaceAssetUploads(WS_B);
    expect(await countPendingAssetUploads(WS_B)).toBe(0);
    expect(await countPendingAssetUploads(WS_A)).toBe(1);
  });

  test("every operation refuses to run without a valid workspace", async () => {
    await expect(getAssetUpload(null, ASSET)).rejects.toThrow(/workspace id/);
    await expect(listPendingAssetUploads("")).rejects.toThrow(/workspace id/);
    await expect(countPendingAssetUploads("a/b")).rejects.toThrow(/workspace id/);
    await expect(settleAssetUpload(undefined, ASSET)).rejects.toThrow(/workspace id/);
    await expect(clearWorkspaceAssetUploads(null)).rejects.toThrow(/workspace id/);
    await expect(enqueueAssetUpload({ assetId: ASSET })).rejects.toThrow(/workspace id/);
  });
});

describe("durability", () => {
  test("what is owed survives the database being closed and reopened", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, kind: "editor-file", at: 42 });
    // What a reload (or a sign-out and back in) does: the handle is gone and
    // the next call opens the database again.
    resetAssetDbConnection();
    expect(await getAssetUpload(WS_A, ASSET)).toMatchObject({ assetId: ASSET, kind: "editor-file", at: 42 });
    expect(await countPendingAssetUploads(WS_A)).toBe(1);
  });
});

describe("settleAssetUploadAsStored — the end of one upload, atomically", () => {
  test("records what the cloud holds and stops owing it, together", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, kind: "editor-image" });

    const record = await settleAssetUploadAsStored({
      workspaceId: WS_A,
      assetId: ASSET,
      kind: "editor-image",
      name: "photo.png",
      mimeType: "image/png",
      size: 1234,
      at: 5000,
    });

    expect(record).toMatchObject({
      workspaceId: WS_A,
      assetId: ASSET,
      kind: "editor-image",
      name: "photo.png",
      mimeType: "image/png",
      size: 1234,
      state: REMOTE_ASSET_STATE.STORED,
      updatedAt: 5000,
    });
    expect(await getRemoteAssetEntry(WS_A, ASSET)).toMatchObject({ state: REMOTE_ASSET_STATE.STORED });
    expect(await getAssetUpload(WS_A, ASSET)).toBeNull();
  });

  test("settling something already settled is success, not an error", async () => {
    await settleAssetUploadAsStored({ workspaceId: WS_A, assetId: ASSET, kind: "pdf-source", size: 1 });
    await expect(
      settleAssetUploadAsStored({ workspaceId: WS_A, assetId: ASSET, kind: "pdf-source", size: 1 })
    ).resolves.toMatchObject({ state: REMOTE_ASSET_STATE.STORED });
  });

  test("a refused record leaves NEITHER store changed", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: ASSET, kind: "editor-image" });
    // The entry is built before the transaction opens, so an invalid identity
    // rejects without touching either store.
    await expect(settleAssetUploadAsStored({ workspaceId: WS_A, assetId: "../escape" })).rejects.toThrow();
    expect(await getAssetUpload(WS_A, ASSET)).not.toBeNull();
    expect(await getRemoteAssetEntry(WS_A, ASSET)).toBeNull();
  });

  test("it can never settle or index another workspace's asset", async () => {
    await enqueueAssetUpload({ workspaceId: WS_B, assetId: ASSET, kind: "editor-image" });
    await settleAssetUploadAsStored({ workspaceId: WS_A, assetId: ASSET, kind: "editor-image", size: 2 });
    expect(await getAssetUpload(WS_B, ASSET)).not.toBeNull();
    expect(await getRemoteAssetEntry(WS_B, ASSET)).toBeNull();
  });

  test("a valid workspace is required", async () => {
    await expect(settleAssetUploadAsStored({ workspaceId: "", assetId: ASSET })).rejects.toThrow(
      /valid workspace id/i
    );
  });
});
