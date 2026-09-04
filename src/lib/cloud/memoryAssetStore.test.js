// src/lib/cloud/memoryAssetStore.test.js
//
// The in-memory asset store: the double later phases will build the upload
// queue, the download path and the sweep against. What is asserted here is
// the CONTRACT those phases may rely on — workspace isolation, create /
// read / delete semantics, immutability of a written object, and a
// deterministic way to make an operation fail.
import { ASSET_STORAGE_ERROR } from "./assetPaths";
import { createMemoryAssetStore } from "./memoryAssetStore";

const WID_A = "ws-aaaaaaa1-0000-4000-8000-aaaaaaaaaaaa";
const WID_B = "ws-bbbbbbb2-0000-4000-8000-bbbbbbbbbbbb";
const AID = "asset-1111-4222-8333-444455556666";

const bytes = (...values) => new Uint8Array(values);
const blobOf = (data, type) => new Blob([data], { type });

/** jsdom's Blob has no arrayBuffer() on this runtime — read it the long way. */
function textOf(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Buffer.from(reader.result).toString("utf8"));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe("createMemoryAssetStore", () => {
  test("an uploaded object reads back byte-for-byte, with its content type", async () => {
    const store = createMemoryAssetStore();
    const result = await store.uploadAsset(WID_A, AID, blobOf("hello", "text/plain"));
    expect(result).toEqual({ path: `workspaces/${WID_A}/assets/${AID}`, size: 5, contentType: "text/plain" });

    const read = await store.downloadAsset(WID_A, AID);
    expect(read.type).toBe("text/plain");
    expect(await textOf(read)).toBe("hello");
    expect(await store.objectExists(WID_A, AID)).toBe(true);
  });

  test("raw bytes upload too, and the caller's explicit type wins over the Blob's", async () => {
    const store = createMemoryAssetStore();
    await store.uploadAsset(WID_A, AID, bytes(1, 2, 3), { contentType: "application/pdf" });
    expect(store.dump()[`workspaces/${WID_A}/assets/${AID}`]).toEqual({
      size: 3,
      contentType: "application/pdf",
      metadata: {},
    });
    const other = createMemoryAssetStore();
    await other.uploadAsset(WID_A, AID, blobOf("x", "image/png"), { contentType: "image/jpeg" });
    expect((await other.downloadAsset(WID_A, AID)).type).toBe("image/jpeg");
  });

  test("workspaces are isolated: the same asset id in two workspaces is two objects", async () => {
    const store = createMemoryAssetStore();
    await store.uploadAsset(WID_A, AID, blobOf("from A", "text/plain"));
    await store.uploadAsset(WID_B, AID, blobOf("from B", "text/plain"));

    expect(await textOf(await store.downloadAsset(WID_A, AID))).toBe("from A");
    expect(await textOf(await store.downloadAsset(WID_B, AID))).toBe("from B");
    expect(store.list(WID_A)).toEqual([AID]);
    expect(store.list(WID_B)).toEqual([AID]);

    // Deleting one workspace's copy leaves the other untouched.
    expect(await store.deleteAsset(WID_A, AID)).toEqual({ deleted: true });
    expect(await store.objectExists(WID_A, AID)).toBe(false);
    expect(await store.objectExists(WID_B, AID)).toBe(true);
  });

  test("an object of another workspace is never reachable by asking for it here", async () => {
    const store = createMemoryAssetStore();
    await store.uploadAsset(WID_B, AID, blobOf("secret", "text/plain"));
    await expect(store.downloadAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.NOT_FOUND });
    expect(await store.objectExists(WID_A, AID)).toBe(false);
    expect(store.list(WID_A)).toEqual([]);
  });

  test("objects are create-only: a second upload is refused, and the bytes stand", async () => {
    const store = createMemoryAssetStore();
    await store.uploadAsset(WID_A, AID, blobOf("original", "text/plain"));
    await expect(store.uploadAsset(WID_A, AID, blobOf("replacement", "text/plain"))).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.UNAUTHORIZED,
    });
    expect(await textOf(await store.downloadAsset(WID_A, AID))).toBe("original");
    expect(store.calls.uploads).toHaveLength(1);
  });

  test("reading and deleting what is not there: not-found, and a second delete is not an error", async () => {
    const store = createMemoryAssetStore();
    expect(await store.objectExists(WID_A, AID)).toBe(false);
    await expect(store.downloadAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.NOT_FOUND });
    expect(await store.deleteAsset(WID_A, AID)).toEqual({ deleted: false });

    await store.uploadAsset(WID_A, AID, blobOf("x", "text/plain"));
    expect(await store.deleteAsset(WID_A, AID)).toEqual({ deleted: true });
    expect(await store.deleteAsset(WID_A, AID)).toEqual({ deleted: false });
  });

  test("an upload with no bytes or no content type is refused", async () => {
    const store = createMemoryAssetStore();
    await expect(store.uploadAsset(WID_A, AID, blobOf("", "text/plain"))).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    await expect(store.uploadAsset(WID_A, AID, null)).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    await expect(store.uploadAsset(WID_A, AID, blobOf("x", ""))).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    expect(store.dump()).toEqual({});
  });

  test("an invalid workspace or asset id is refused before anything is stored", async () => {
    const store = createMemoryAssetStore();
    await expect(store.uploadAsset(WID_A, "../escape", bytes(1), { contentType: "text/plain" })).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    await expect(store.downloadAsset("../other", AID)).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    expect(store.dump()).toEqual({});
  });

  test("failNext makes exactly the next operation fail, with the code asked for", async () => {
    const store = createMemoryAssetStore();
    store.failNext("upload", ASSET_STORAGE_ERROR.RETRY_LIMIT_EXCEEDED);
    await expect(store.uploadAsset(WID_A, AID, blobOf("x", "text/plain"))).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.RETRY_LIMIT_EXCEEDED,
    });
    expect(store.dump()).toEqual({});
    // The retry goes through — the injection is one-shot.
    await store.uploadAsset(WID_A, AID, blobOf("x", "text/plain"));
    expect(await store.objectExists(WID_A, AID)).toBe(true);

    store.failNext("download", ASSET_STORAGE_ERROR.UNAUTHORIZED);
    await expect(store.downloadAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    expect(await textOf(await store.downloadAsset(WID_A, AID))).toBe("x");

    store.failNext("delete", ASSET_STORAGE_ERROR.UNAUTHORIZED);
    await expect(store.deleteAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    expect(await store.objectExists(WID_A, AID)).toBe(true);

    store.failNext("exists", ASSET_STORAGE_ERROR.UNAUTHENTICATED);
    await expect(store.objectExists(WID_A, AID)).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.UNAUTHENTICATED,
    });
    expect(() => store.failNext("teleport", "x")).toThrow(/Unknown asset-store operation/);
  });

  test("seed places an object without the upload rules, for read paths under test", async () => {
    const store = createMemoryAssetStore();
    const path = await store.seed(WID_A, AID, bytes(9, 9), { contentType: "image/png", metadata: { origin: "test" } });
    expect(path).toBe(`workspaces/${WID_A}/assets/${AID}`);
    expect(store.dump()[path]).toEqual({ size: 2, contentType: "image/png", metadata: { origin: "test" } });
    expect((await store.downloadAsset(WID_A, AID)).type).toBe("image/png");
  });

  test("it presents the same operations as the Firebase Storage adapter", () => {
    const store = createMemoryAssetStore({ bucket: "notewise-test.appspot.com" });
    expect(store.bucket).toBe("notewise-test.appspot.com");
    for (const method of ["objectPath", "objectExists", "uploadAsset", "downloadAsset", "deleteAsset"]) {
      expect(typeof store[method]).toBe("function");
    }
    expect(store.objectPath(WID_A, AID)).toBe(`workspaces/${WID_A}/assets/${AID}`);
  });
});

describe("with a workspace store attached — the Storage rules' equivalent", () => {
  const { createMemoryWorkspaceStore } = require("./memoryWorkspaceStore");

  function stores() {
    const workspaceStore = createMemoryWorkspaceStore();
    workspaceStore.seed(["workspaces", WID_A], { id: WID_A, ownerUid: "alice", schemaVersion: 1 });
    workspaceStore.seed(["workspaces", WID_A, "members", "alice"], { uid: "alice", role: "owner" });
    workspaceStore.seed(["workspaces", WID_A, "members", "bob"], { uid: "bob", role: "member" });
    workspaceStore.seed(["workspaces", WID_B], { id: WID_B, ownerUid: "carol", schemaVersion: 1 });
    workspaceStore.seed(["workspaces", WID_B, "members", "carol"], { uid: "carol", role: "owner" });
    const store = createMemoryAssetStore({ workspaceStore });
    return { store, workspaceStore };
  }

  const identity = (overrides = {}) => ({ metadata: { assetId: AID, workspaceId: WID_A, assetKind: "editor-image", ...overrides } });

  test("signed out: every operation is unauthenticated", async () => {
    const { store } = stores();
    await store.seed(WID_A, AID, bytes(1), { contentType: "image/png" });
    for (const op of [
      () => store.objectExists(WID_A, AID),
      () => store.downloadAsset(WID_A, AID),
      () => store.uploadAsset(WID_A, "asset-2222-4222-8333-444455556666", blobOf("x", "image/png"), identity({ assetId: "asset-2222-4222-8333-444455556666" })),
      () => store.deleteAsset(WID_A, AID),
    ]) {
      await expect(op()).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHENTICATED });
    }
    expect(store.list(WID_A)).toEqual([AID]);
  });

  test("a member reads and creates in the own workspace; a non-member and a cross-workspace caller get nothing", async () => {
    const { store, workspaceStore } = stores();
    workspaceStore.setUser("bob");
    await store.uploadAsset(WID_A, AID, blobOf("hello", "image/png"), identity());
    expect(await store.objectExists(WID_A, AID)).toBe(true);
    expect((await store.downloadAsset(WID_A, AID)).type).toBe("image/png");

    workspaceStore.setUser("carol"); // owner of B, stranger to A
    await expect(store.objectExists(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    await expect(store.downloadAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    await expect(store.uploadAsset(WID_A, "asset-2222-4222-8333-444455556666", blobOf("x", "image/png"), identity({ assetId: "asset-2222-4222-8333-444455556666" }))).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    await expect(store.deleteAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    // alice cannot create in carol's workspace either
    workspaceStore.setUser("alice");
    await expect(store.uploadAsset(WID_B, AID, blobOf("x", "image/png"), { metadata: { assetId: AID, workspaceId: WID_B, assetKind: "logo" } })).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    expect(store.list(WID_B)).toEqual([]);
  });

  test("the create rule's invariants: identity metadata, kind, content type, size", async () => {
    const { store, workspaceStore } = stores();
    workspaceStore.setUser("alice");
    const refused = async (data, options) => {
      await expect(store.uploadAsset(WID_A, AID, data, options)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
      expect(await store.objectExists(WID_A, AID)).toBe(false);
    };
    await refused(blobOf("x", "image/png")); // no metadata at all
    await refused(blobOf("x", "image/png"), identity({ assetId: "asset-2222-4222-8333-444455556666" }));
    await refused(blobOf("x", "image/png"), identity({ workspaceId: WID_B }));
    await refused(blobOf("x", "image/png"), identity({ assetKind: "asset" }));
    await refused(blobOf("x", "image/svg+xml"), identity());
    await refused(blobOf("x", "application/octet-stream"), identity());
    await refused(blobOf("x", "image/png"), { ...identity(), contentType: "Image/PNG" }); // not normalised (a Blob's own type already is)
    await refused({ size: 50 * 1024 * 1024 + 1, type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(0) }, identity({ assetKind: "pdf-source" }));
    // and then the same upload, well-formed, goes through
    await store.uploadAsset(WID_A, AID, blobOf("x", "image/png"), identity());
    expect(await store.objectExists(WID_A, AID)).toBe(true);
  });

  test("delete is the workspace owner's alone; an ordinary member and another workspace's owner are refused", async () => {
    const { store, workspaceStore } = stores();
    await store.seed(WID_A, AID, bytes(1), { contentType: "image/png" });
    workspaceStore.setUser("bob");
    await expect(store.deleteAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    workspaceStore.setUser("carol");
    await expect(store.deleteAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    expect(store.list(WID_A)).toEqual([AID]);
    workspaceStore.setUser("alice");
    expect(await store.deleteAsset(WID_A, AID)).toEqual({ deleted: true });
    expect(await store.deleteAsset(WID_A, AID)).toEqual({ deleted: false });
  });

  test("an owner-role membership document alone does not make an owner — the workspace's ownerUid decides", async () => {
    const { store, workspaceStore } = stores();
    workspaceStore.seed(["workspaces", WID_A, "members", "mallory"], { uid: "mallory", role: "owner" });
    await store.seed(WID_A, AID, bytes(1), { contentType: "image/png" });
    workspaceStore.setUser("mallory");
    expect(await store.objectExists(WID_A, AID)).toBe(true); // a member, so may read
    await expect(store.deleteAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
  });

  test("create-only still holds for a member, and a failure injection still wins", async () => {
    const { store, workspaceStore } = stores();
    workspaceStore.setUser("alice");
    await store.uploadAsset(WID_A, AID, blobOf("original", "text/plain"), identity({ assetKind: "note-file" }));
    await expect(store.uploadAsset(WID_A, AID, blobOf("replacement", "text/plain"), identity({ assetKind: "note-file" }))).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
    store.failNext("download", ASSET_STORAGE_ERROR.RETRY_LIMIT_EXCEEDED);
    await expect(store.downloadAsset(WID_A, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.RETRY_LIMIT_EXCEEDED });
    expect(await textOf(await store.downloadAsset(WID_A, AID))).toBe("original");
  });
});
