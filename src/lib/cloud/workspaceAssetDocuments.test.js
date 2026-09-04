// src/lib/cloud/workspaceAssetDocuments.test.js
//
// The workspace store's ASSET METADATA operations — the reads a later
// phase's reconciliation and reference-driven sweep need, the write the
// upload processor and the lifecycle perform, and the delete that sweep
// performs. Exercised against the in-memory store (the Firestore twin is not
// loadable under Jest); the Firestore adapter is checked for the same four
// operations over the same shared paths.
//
// Since Phase 7.3 the memory store enforces the asset rules of
// firestore.rules: a written document is validated against the field model
// (src/lib/cloud/assetCloudModel.js), the state machine is respected, a
// fresh tombstone needs the store's own timestamp, and DELETE is the
// workspace owner's alone.
import fs from "fs";
import path from "path";
import { assetCollectionPath, assetDocumentPath } from "./assetPaths";
import { buildAssetDocument, restoreAssetDocument, tombstoneAssetDocument } from "./assetCloudModel";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";

const WID = "ws-aaaaaaa1-0000-4000-8000-aaaaaaaaaaaa";
const OTHER = "ws-bbbbbbb2-0000-4000-8000-bbbbbbbbbbbb";
const A1 = "asset-1111-4222-8333-444455556666";
const A2 = "asset-2222-4222-8333-444455556666";

function storeWithWorkspace(uid = "alice", { members = [] } = {}) {
  const store = createMemoryWorkspaceStore();
  store.seed(["workspaces", WID], { id: WID, ownerUid: uid, schemaVersion: 1 });
  store.seed(["workspaces", WID, "members", uid], { uid, role: "owner" });
  for (const member of members) store.seed(["workspaces", WID, "members", member], { uid: member, role: "member" });
  store.setUser(uid);
  return store;
}

/** A valid stored document for the memory store to accept. */
const validAsset = (workspaceId, id, extra = {}) =>
  buildAssetDocument({ workspaceId, id, assetKind: "editor-image", name: "photo.jpg", mimeType: "image/jpeg", size: 1234, createdAt: 1725000000000, metadata: { width: 1 }, ...extra }).fields;

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

describe("asset metadata writes and lifecycle (memory workspace store, the rules' equivalent)", () => {
  test("a member creates a valid stored document, server-stamped, and may re-write it unchanged", async () => {
    const store = storeWithWorkspace("alice", { members: ["mia"] });
    store.setUser("mia");
    await store.writeAssetDocument(WID, A1, validAsset(WID, A1));
    const { fields } = await store.readAssetDocument(WID, A1);
    expect(fields).toMatchObject({ workspaceId: WID, id: A1, kind: "assets", assetKind: "editor-image", state: "stored" });
    expect(typeof fields.updatedAt).toBe("number");
    await store.writeAssetDocument(WID, A1, validAsset(WID, A1)); // idempotent upsert
    expect(store.calls.commits.filter((c) => c[0].path === `assets/${A1}`)).toHaveLength(2);
  });

  test("a document that fails the field model is refused — spoofed identity, bad kind / state / size / MIME, unknown field", async () => {
    const store = storeWithWorkspace();
    const refused = async (fields) => {
      await expect(store.writeAssetDocument(WID, A1, fields)).rejects.toMatchObject({ code: "permission-denied" });
    };
    await refused({ ...validAsset(WID, A1), workspaceId: OTHER });
    await refused({ ...validAsset(WID, A1), id: A2 });
    await refused({ ...validAsset(WID, A1), kind: "nodes" });
    await refused({ ...validAsset(WID, A1), assetKind: "asset" });
    await refused({ ...validAsset(WID, A1), state: "tombstoned", tombstonedAt: store.timestamp() }); // created tombstoned
    await refused({ ...validAsset(WID, A1), size: 50 * 1024 * 1024 + 1 });
    await refused({ ...validAsset(WID, A1), mimeType: "image/svg+xml" });
    await refused({ ...validAsset(WID, A1), ownerUid: "alice" });
    await refused({ ...validAsset(WID, A1), schemaVersion: 2 });
    expect((await store.readAssetDocument(WID, A1)).exists).toBe(false);
    // the same refusals through a batch
    await expect(store.commitBatch(WID, [{ type: "set", path: ["assets", A1], fields: { ...validAsset(WID, A1), assetKind: "asset" } }])).rejects.toMatchObject({ code: "permission-denied" });
  });

  test("a non-member cannot write, and a member cannot write into another workspace", async () => {
    const store = storeWithWorkspace("alice");
    store.setUser("mallory");
    await expect(store.writeAssetDocument(WID, A1, validAsset(WID, A1))).rejects.toMatchObject({ code: "permission-denied" });
    store.setUser("alice");
    await expect(store.writeAssetDocument(OTHER, A1, validAsset(OTHER, A1))).rejects.toMatchObject({ code: "permission-denied" });
    store.setUser(null);
    await expect(store.writeAssetDocument(WID, A1, validAsset(WID, A1))).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("stored → tombstoned needs the store's timestamp; tombstoned → stored drops it; a standing tombstone keeps its clock", async () => {
    let clock = 1725000000000;
    const store = createMemoryWorkspaceStore({ now: () => clock });
    store.seed(["workspaces", WID], { id: WID, ownerUid: "alice", schemaVersion: 1 });
    store.seed(["workspaces", WID, "members", "alice"], { uid: "alice", role: "owner" });
    store.seed(["workspaces", WID, "members", "mia"], { uid: "mia", role: "member" });
    store.setUser("mia");
    await store.writeAssetDocument(WID, A1, validAsset(WID, A1));
    const stored = (await store.readAssetDocument(WID, A1)).fields;

    // a client clock is refused, and so is no clock at all
    await expect(store.writeAssetDocument(WID, A1, tombstoneAssetDocument(stored, Date.now()))).rejects.toMatchObject({ code: "permission-denied" });
    await expect(store.writeAssetDocument(WID, A1, { ...restoreAssetDocument(stored), state: "tombstoned" })).rejects.toMatchObject({ code: "permission-denied" });

    clock += 1000;
    await store.writeAssetDocument(WID, A1, tombstoneAssetDocument(stored, store.timestamp()));
    const tombstoned = (await store.readAssetDocument(WID, A1)).fields;
    expect(tombstoned).toMatchObject({ state: "tombstoned", tombstonedAt: 1725000001000, updatedAt: 1725000001000 });

    // refreshing the tombstone is refused; re-sending it unchanged is fine
    clock += 1000;
    await expect(store.writeAssetDocument(WID, A1, tombstoneAssetDocument(tombstoned, store.timestamp()))).rejects.toMatchObject({ code: "permission-denied" });
    await store.writeAssetDocument(WID, A1, tombstoneAssetDocument(tombstoned, tombstoned.tombstonedAt));
    expect((await store.readAssetDocument(WID, A1)).fields.tombstonedAt).toBe(1725000001000);

    // resurrection
    await expect(store.writeAssetDocument(WID, A1, { ...restoreAssetDocument(tombstoned), tombstonedAt: tombstoned.tombstonedAt })).rejects.toMatchObject({ code: "permission-denied" });
    await store.writeAssetDocument(WID, A1, restoreAssetDocument(tombstoned));
    const restored = (await store.readAssetDocument(WID, A1)).fields;
    expect(restored.state).toBe("stored");
    expect("tombstonedAt" in restored).toBe(false);
  });

  test("identity and description are immutable on a rewrite", async () => {
    const store = storeWithWorkspace();
    await store.writeAssetDocument(WID, A1, validAsset(WID, A1));
    for (const change of [{ assetKind: "logo" }, { name: "renamed.jpg" }, { mimeType: "image/png" }, { size: 1 }, { metadata: { width: 2 } }, { createdAt: 1 }, { sourceAssetId: A2 }]) {
      await expect(store.writeAssetDocument(WID, A1, validAsset(WID, A1, change))).rejects.toMatchObject({ code: "permission-denied" });
    }
    expect((await store.readAssetDocument(WID, A1)).fields.name).toBe("photo.jpg");
  });

  test("delete is the owner's alone — an ordinary member is refused, directly and through a batch", async () => {
    const store = storeWithWorkspace("alice", { members: ["mia"] });
    seedAsset(store, WID, A1);
    store.setUser("mia");
    await expect(store.deleteAssetDocument(WID, A1)).rejects.toMatchObject({ code: "permission-denied" });
    await expect(store.commitBatch(WID, [{ type: "delete", path: ["assets", A1] }])).rejects.toMatchObject({ code: "permission-denied" });
    expect((await store.readAssetDocument(WID, A1)).exists).toBe(true);
    // the member still deletes ordinary entities
    store.seed(["workspaces", WID, "nodes", "n1"], { workspaceId: WID, id: "n1", kind: "nodes", nodeKind: "note" });
    await store.commitBatch(WID, [{ type: "delete", path: ["nodes", "n1"] }]);
    expect(store.get(["workspaces", WID, "nodes", "n1"])).toBe(null);
    // and the owner deletes the asset document
    store.setUser("alice");
    expect(await store.deleteAssetDocument(WID, A1)).toEqual({ deleted: true });
  });

  test("the owner of another workspace is not this workspace's owner", async () => {
    const store = storeWithWorkspace("alice");
    store.seed(["workspaces", OTHER], { id: OTHER, ownerUid: "carol", schemaVersion: 1 });
    store.seed(["workspaces", OTHER, "members", "carol"], { uid: "carol", role: "owner" });
    seedAsset(store, WID, A1);
    store.setUser("carol");
    await expect(store.deleteAssetDocument(WID, A1)).rejects.toMatchObject({ code: "permission-denied" });
  });
});

describe("the Firestore adapter carries the same operations", () => {
  const source = fs.readFileSync(path.join(__dirname, "firestoreWorkspaceStore.js"), "utf8");

  test("it implements readAssetIndex, readAssetDocument, writeAssetDocument and deleteAssetDocument", () => {
    expect(source).toMatch(/async readAssetIndex\(workspaceId\)/);
    expect(source).toMatch(/async readAssetDocument\(workspaceId, assetId\)/);
    expect(source).toMatch(/async writeAssetDocument\(workspaceId, assetId, fields\)/);
    expect(source).toMatch(/async deleteAssetDocument\(workspaceId, assetId\)/);
    // the write is server-stamped, as the rules require
    expect(source).toMatch(/\{ \.\.\.fields, updatedAt: serverTimestamp\(\) \}/);
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
