// src/lib/assetRemoteIndex.test.js
//
// The local index of what the cloud is known to hold (Production Readiness
// Phase 7.2). Nothing populates it from Firestore yet; what is proved here is
// the shape it will be populated into and the isolation it enforces — the
// same compound key the upload queue uses, so one account's index can never
// be read through another's.
import "fake-indexeddb/auto";
import {
  REMOTE_ASSET_STATE,
  clearWorkspaceRemoteAssets,
  deleteRemoteAssetEntry,
  getRemoteAssetEntry,
  listRemoteAssetEntries,
  makeRemoteAssetEntry,
  putRemoteAssetEntry,
} from "./assetRemoteIndex";
import { resetAssetDbConnection } from "./assetDb";
import { deleteAssetDb, installStructuredCloneShim } from "./assetDbTestHarness";

installStructuredCloneShim();

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";
const ASSET = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

beforeEach(async () => {
  await deleteAssetDb();
});

describe("makeRemoteAssetEntry (pure)", () => {
  test("records the metadata a later phase needs, with nulls for the unknown", () => {
    expect(
      makeRemoteAssetEntry({
        workspaceId: WS_A,
        assetId: ASSET,
        kind: "editor-image",
        name: "site.jpg",
        mimeType: "image/jpeg",
        size: 1234,
        sourceAssetId: "orig-1",
        state: REMOTE_ASSET_STATE.STORED,
        updatedAt: 99,
      })
    ).toEqual({
      workspaceId: WS_A,
      assetId: ASSET,
      kind: "editor-image",
      name: "site.jpg",
      mimeType: "image/jpeg",
      size: 1234,
      sourceAssetId: "orig-1",
      state: "stored",
      updatedAt: 99,
    });
  });

  test("an unrecorded field is null and an unknown state degrades to `unknown`", () => {
    const entry = makeRemoteAssetEntry({ workspaceId: WS_A, assetId: ASSET, state: "nonsense" });
    expect(entry).toMatchObject({
      kind: "asset",
      name: null,
      mimeType: null,
      size: null,
      sourceAssetId: null,
      state: REMOTE_ASSET_STATE.UNKNOWN,
    });
  });

  test("refuses an id that could escape its workspace", () => {
    expect(() => makeRemoteAssetEntry({ workspaceId: "../x", assetId: ASSET })).toThrow(/workspace id/);
    expect(() => makeRemoteAssetEntry({ workspaceId: WS_A, assetId: "a/b" })).toThrow(/asset id/);
  });
});

describe("put / get / list / delete", () => {
  test("an entry round-trips and can be replaced in place", async () => {
    await putRemoteAssetEntry({ workspaceId: WS_A, assetId: ASSET, kind: "logo", size: 10 });
    expect(await getRemoteAssetEntry(WS_A, ASSET)).toMatchObject({ kind: "logo", size: 10 });
    await putRemoteAssetEntry({
      workspaceId: WS_A,
      assetId: ASSET,
      kind: "logo",
      size: 10,
      state: REMOTE_ASSET_STATE.STORED,
    });
    expect(await listRemoteAssetEntries(WS_A)).toHaveLength(1);
    expect((await getRemoteAssetEntry(WS_A, ASSET)).state).toBe("stored");
  });

  test("listing returns only the named workspace's entries", async () => {
    await putRemoteAssetEntry({ workspaceId: WS_A, assetId: "a-1", kind: "logo" });
    await putRemoteAssetEntry({ workspaceId: WS_A, assetId: "a-2", kind: "logo" });
    await putRemoteAssetEntry({ workspaceId: WS_B, assetId: "b-1", kind: "logo" });
    expect((await listRemoteAssetEntries(WS_A)).map((e) => e.assetId).sort()).toEqual(["a-1", "a-2"]);
    expect((await listRemoteAssetEntries(WS_B)).map((e) => e.assetId)).toEqual(["b-1"]);
  });

  test("deleting an absent entry is not an error", async () => {
    await expect(deleteRemoteAssetEntry(WS_A, ASSET)).resolves.toBeUndefined();
  });

  test("what is known survives the database being reopened", async () => {
    await putRemoteAssetEntry({ workspaceId: WS_A, assetId: ASSET, kind: "note-file", size: 7 });
    resetAssetDbConnection();
    expect(await getRemoteAssetEntry(WS_A, ASSET)).toMatchObject({ kind: "note-file", size: 7 });
  });
});

describe("workspace isolation", () => {
  beforeEach(async () => {
    await putRemoteAssetEntry({ workspaceId: WS_A, assetId: ASSET, kind: "logo" });
  });

  test("workspace A's entry is invisible through workspace B", async () => {
    expect(await getRemoteAssetEntry(WS_B, ASSET)).toBeNull();
    expect(await listRemoteAssetEntries(WS_B)).toEqual([]);
  });

  test("workspace B cannot delete or clear workspace A's entries", async () => {
    await deleteRemoteAssetEntry(WS_B, ASSET);
    await clearWorkspaceRemoteAssets(WS_B);
    expect(await getRemoteAssetEntry(WS_A, ASSET)).not.toBeNull();
  });

  test("clearing a workspace removes its own entries and only those", async () => {
    await putRemoteAssetEntry({ workspaceId: WS_B, assetId: ASSET, kind: "logo" });
    await clearWorkspaceRemoteAssets(WS_A);
    expect(await listRemoteAssetEntries(WS_A)).toEqual([]);
    expect(await listRemoteAssetEntries(WS_B)).toHaveLength(1);
  });

  test("every operation refuses to run without a valid workspace", async () => {
    await expect(getRemoteAssetEntry(null, ASSET)).rejects.toThrow(/workspace id/);
    await expect(listRemoteAssetEntries("")).rejects.toThrow(/workspace id/);
    await expect(deleteRemoteAssetEntry("a/b", ASSET)).rejects.toThrow(/workspace id/);
    await expect(clearWorkspaceRemoteAssets(undefined)).rejects.toThrow(/workspace id/);
    await expect(putRemoteAssetEntry({ assetId: ASSET })).rejects.toThrow(/workspace id/);
  });
});

/* ------------------------------------------------------------------------ *
 * Production Readiness Phase 7.5 — tombstoned is its own answer
 * ------------------------------------------------------------------------ */

describe("the tombstoned state", () => {
  test("it is a state of its own, distinct from missing", () => {
    expect(REMOTE_ASSET_STATE.TOMBSTONED).toBe("tombstoned");
    expect(REMOTE_ASSET_STATE.TOMBSTONED).not.toBe(REMOTE_ASSET_STATE.MISSING);
    expect(Object.values(REMOTE_ASSET_STATE)).toEqual([
      "unknown",
      "pending",
      "stored",
      "missing",
      "tombstoned",
    ]);
  });

  test("an entry may record it, and reads back as itself", async () => {
    await putRemoteAssetEntry({
      workspaceId: WS_A,
      assetId: "a-1",
      kind: "editor-image",
      state: REMOTE_ASSET_STATE.TOMBSTONED,
    });
    expect((await getRemoteAssetEntry(WS_A, "a-1")).state).toBe(REMOTE_ASSET_STATE.TOMBSTONED);
  });
});
