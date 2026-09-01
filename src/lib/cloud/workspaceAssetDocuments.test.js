// src/lib/cloud/workspaceAssetDocuments.test.js
//
// The workspace store's ASSET METADATA operations — the reads a later
// phase's reconciliation and reference-driven sweep need, and the delete
// that sweep performs. Exercised against the in-memory store (the Firestore
// twin is not loadable under Jest); the Firestore adapter is checked for the
// same three operations over the same shared paths.
//
// The field model of an asset document is deliberately NOT asserted here:
// this phase adds the operations, not the model.
import fs from "fs";
import path from "path";
import { assetCollectionPath, assetDocumentPath } from "./assetPaths";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";

const WID = "ws-aaaaaaa1-0000-4000-8000-aaaaaaaaaaaa";
const OTHER = "ws-bbbbbbb2-0000-4000-8000-bbbbbbbbbbbb";
const A1 = "asset-1111-4222-8333-444455556666";
const A2 = "asset-2222-4222-8333-444455556666";

function storeWithWorkspace(uid = "alice") {
  const store = createMemoryWorkspaceStore();
  store.seed(["workspaces", WID], { id: WID, ownerUid: uid, schemaVersion: 1 });
  store.seed(["workspaces", WID, "members", uid], { uid, role: "owner" });
  store.setUser(uid);
  return store;
}

const seedAsset = (store, workspaceId, id, fields = {}) =>
  store.seed(assetDocumentPath(workspaceId, id), { workspaceId, id, kind: "assets", ...fields });

describe("asset metadata operations (memory workspace store)", () => {
  test("the index lists this workspace's asset documents, and only this workspace's", async () => {
    const store = storeWithWorkspace();
    seedAsset(store, WID, A1, { assetKind: "editor-image" });
    seedAsset(store, WID, A2, { assetKind: "pdf-source" });
    seedAsset(store, OTHER, A1, { assetKind: "editor-image" });

    const { assets } = await store.readAssetIndex(WID);
    expect(assets.map((a) => a.id).sort()).toEqual([A1, A2]);
    expect(assets.find((a) => a.id === A1).fields).toMatchObject({ workspaceId: WID, assetKind: "editor-image" });
  });

  test("one document reads back; an absent one is reported absent, not empty data", async () => {
    const store = storeWithWorkspace();
    seedAsset(store, WID, A1, { assetKind: "editor-image" });

    expect(await store.readAssetDocument(WID, A1)).toEqual({
      exists: true,
      fields: { workspaceId: WID, id: A1, kind: "assets", assetKind: "editor-image" },
    });
    expect(await store.readAssetDocument(WID, A2)).toEqual({ exists: false, fields: null });
  });

  test("a document deletes, and deleting what is already gone reports it", async () => {
    const store = storeWithWorkspace();
    seedAsset(store, WID, A1);

    expect(await store.deleteAssetDocument(WID, A1)).toEqual({ deleted: true });
    expect(await store.readAssetDocument(WID, A1)).toEqual({ exists: false, fields: null });
    expect(await store.deleteAssetDocument(WID, A1)).toEqual({ deleted: false });
    expect((await store.readAssetIndex(WID)).assets).toEqual([]);
  });

  test("a non-member is refused every asset operation, and nothing is deleted", async () => {
    const store = storeWithWorkspace("alice");
    seedAsset(store, WID, A1);
    store.setUser("mallory");

    await expect(store.readAssetIndex(WID)).rejects.toMatchObject({ code: "permission-denied" });
    await expect(store.readAssetDocument(WID, A1)).rejects.toMatchObject({ code: "permission-denied" });
    await expect(store.deleteAssetDocument(WID, A1)).rejects.toMatchObject({ code: "permission-denied" });

    store.setUser("alice");
    expect((await store.readAssetDocument(WID, A1)).exists).toBe(true);
  });

  test("with nobody signed in there is no asset access at all", async () => {
    const store = storeWithWorkspace();
    seedAsset(store, WID, A1);
    store.setUser(null);

    await expect(store.readAssetIndex(WID)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(store.readAssetDocument(WID, A1)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(store.deleteAssetDocument(WID, A1)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("an injected failure propagates rather than reading as an empty index", async () => {
    const store = storeWithWorkspace();
    seedAsset(store, WID, A1);

    store.failNext("read", "unavailable");
    await expect(store.readAssetIndex(WID)).rejects.toMatchObject({ code: "unavailable" });
    expect((await store.readAssetIndex(WID)).assets).toHaveLength(1);

    store.failNext("commit", "permission-denied");
    await expect(store.deleteAssetDocument(WID, A1)).rejects.toMatchObject({ code: "permission-denied" });
    expect((await store.readAssetDocument(WID, A1)).exists).toBe(true);
  });

  test("asset documents stay OUT of the workspace mirror the owner modules read", async () => {
    const store = storeWithWorkspace();
    seedAsset(store, WID, A1);
    store.seed(["workspaces", WID, "nodes", "n1"], { workspaceId: WID, id: "n1", kind: "nodes", nodeKind: "note" });

    const { documents } = await store.readWorkspace(WID);
    expect(documents.map((d) => d.collection)).toEqual(["nodes"]);
  });

  test("an invalid workspace or asset id is refused before any document is touched", async () => {
    const store = storeWithWorkspace();
    await expect(store.readAssetDocument(WID, "../escape")).rejects.toMatchObject({
      code: "storage/invalid-argument",
    });
    await expect(store.deleteAssetDocument("ws-a/b", A1)).rejects.toMatchObject({
      code: "storage/invalid-argument",
    });
  });
});

describe("the Firestore adapter carries the same operations", () => {
  const source = fs.readFileSync(path.join(__dirname, "firestoreWorkspaceStore.js"), "utf8");

  test("it implements readAssetIndex, readAssetDocument and deleteAssetDocument", () => {
    expect(source).toMatch(/async readAssetIndex\(workspaceId\)/);
    expect(source).toMatch(/async readAssetDocument\(workspaceId, assetId\)/);
    expect(source).toMatch(/async deleteAssetDocument\(workspaceId, assetId\)/);
  });

  test("it derives the paths from the shared convention, never from its own string", () => {
    expect(source).toMatch(/from "\.\/assetPaths"/);
    expect(source).toMatch(/assetCollectionPath\(workspaceId\)/);
    expect(source).toMatch(/assetDocumentPath\(workspaceId, assetId\)/);
    expect(source).not.toMatch(/"assets"/);
    // Both stores address the same place.
    expect(assetCollectionPath(WID)).toEqual(["workspaces", WID, "assets"]);
    expect(assetDocumentPath(WID, A1)).toEqual(["workspaces", WID, "assets", A1]);
  });

  test("the workspace read still covers only the entity collections", () => {
    expect(source).toMatch(/for \(const name of ENTITY_COLLECTIONS\)/);
  });
});
