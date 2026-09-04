// src/lib/cloud/firebaseStorageAdapter.test.js
//
// The only module that imports `firebase/storage`, tested against a stand-in
// for the SDK: which reference each operation addresses, what it hands the
// SDK, what it hands back, and what it refuses. The SDK itself is mocked, so
// Firebase is never loaded under Jest (the shared app module is mocked for
// the same reason).
//
// What matters here is the boundary: the canonical object path, the bucket
// the adapter binds to, the emulator connection, the content-type rule,
// not-found handled as an answer rather than a crash, and every other
// failure surfacing with a code.

const mockEnsureFirebaseApp = jest.fn(() => ({ name: "notewise" }));
const mockSdk = {
  getStorage: jest.fn((app, bucketUrl) => ({ app, bucketUrl })),
  connectStorageEmulator: jest.fn(),
  ref: jest.fn((storage, path) => ({ storage, path })),
  getMetadata: jest.fn(),
  uploadBytes: jest.fn(),
  uploadBytesResumable: jest.fn(),
  getBlob: jest.fn(),
  deleteObject: jest.fn(),
};

jest.mock("../firebaseApp", () => ({
  FIREBASE_APP_NAME: "notewise",
  ensureFirebaseApp: (...args) => mockEnsureFirebaseApp(...args),
}));

jest.mock("firebase/storage", () => ({
  getStorage: (...args) => mockSdk.getStorage(...args),
  connectStorageEmulator: (...args) => mockSdk.connectStorageEmulator(...args),
  ref: (...args) => mockSdk.ref(...args),
  getMetadata: (...args) => mockSdk.getMetadata(...args),
  uploadBytes: (...args) => mockSdk.uploadBytes(...args),
  uploadBytesResumable: (...args) => mockSdk.uploadBytesResumable(...args),
  getBlob: (...args) => mockSdk.getBlob(...args),
  deleteObject: (...args) => mockSdk.deleteObject(...args),
}));

const fs = require("fs");
const path = require("path");
const { ASSET_STORAGE_ERROR, assetStorageError } = require("./assetPaths");
const { createFirebaseStorageAdapter } = require("./firebaseStorageAdapter");

const WID = "ws-aaaaaaa1-0000-4000-8000-aaaaaaaaaaaa";
const AID = "asset-1111-4222-8333-444455556666";
const OBJECT_PATH = `workspaces/${WID}/assets/${AID}`;

const CONFIG = Object.freeze({
  apiKey: "AIzaSy-not-a-real-key",
  authDomain: "notewise-test.firebaseapp.com",
  projectId: "notewise-test",
  appId: "1:123:web:abc",
  storageBucket: "notewise-test.appspot.com",
  storageEmulatorHost: null,
});

// CRA's Jest configuration resets mock implementations between tests
// (`resetMocks`), so the stand-ins are re-installed here rather than once.
beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureFirebaseApp.mockImplementation(() => ({ name: "notewise" }));
  mockSdk.getStorage.mockImplementation((app, bucketUrl) => ({ app, bucketUrl }));
  mockSdk.ref.mockImplementation((storage, path) => ({ storage, path }));
});

describe("configuration", () => {
  test("without a bucket it refuses, naming the environment variable", () => {
    let caught = null;
    try {
      createFirebaseStorageAdapter({ ...CONFIG, storageBucket: null });
    } catch (error) {
      caught = error;
    }
    expect(caught.code).toBe("unconfigured");
    expect(caught.missing).toEqual(["REACT_APP_FIREBASE_STORAGE_BUCKET"]);
    expect(caught.reason).toBe("missing");
    expect(mockSdk.getStorage).not.toHaveBeenCalled();
    expect(mockEnsureFirebaseApp).not.toHaveBeenCalled();
  });

  test("a bucket value that is not a bucket name is refused, not passed to the SDK", () => {
    expect(() => createFirebaseStorageAdapter({ ...CONFIG, storageBucket: "gs://has a space/x" })).toThrow(
      /not configured/
    );
    expect(mockSdk.getStorage).not.toHaveBeenCalled();
  });

  test("it binds to the shared app and to the bucket explicitly, in gs:// form", () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    expect(mockEnsureFirebaseApp).toHaveBeenCalledWith(CONFIG);
    expect(mockSdk.getStorage).toHaveBeenCalledWith({ name: "notewise" }, "gs://notewise-test.appspot.com");
    expect(adapter.bucket).toBe("notewise-test.appspot.com");
    expect(mockSdk.connectStorageEmulator).not.toHaveBeenCalled();
  });

  test("a bucket copied out of the Console as gs://… resolves to the same bucket", () => {
    const adapter = createFirebaseStorageAdapter({ ...CONFIG, storageBucket: "gs://notewise-test.appspot.com/" });
    expect(adapter.bucket).toBe("notewise-test.appspot.com");
    expect(mockSdk.getStorage).toHaveBeenCalledWith(expect.anything(), "gs://notewise-test.appspot.com");
  });

  test("the optional emulator host connects the SDK, with 9199 as the default port", () => {
    createFirebaseStorageAdapter({ ...CONFIG, storageEmulatorHost: "127.0.0.1:9199" });
    expect(mockSdk.connectStorageEmulator).toHaveBeenCalledWith(expect.anything(), "127.0.0.1", 9199);

    mockSdk.connectStorageEmulator.mockClear();
    createFirebaseStorageAdapter({ ...CONFIG, storageEmulatorHost: "localhost" });
    expect(mockSdk.connectStorageEmulator).toHaveBeenCalledWith(expect.anything(), "localhost", 9199);
  });
});

describe("paths", () => {
  test("every operation addresses workspaces/{workspaceId}/assets/{assetId}", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    expect(adapter.objectPath(WID, AID)).toBe(OBJECT_PATH);

    mockSdk.getMetadata.mockResolvedValue({ size: 1 });
    mockSdk.uploadBytes.mockResolvedValue({ metadata: { size: 3, contentType: "image/png" } });
    mockSdk.getBlob.mockResolvedValue(new Blob(["x"]));
    mockSdk.deleteObject.mockResolvedValue(undefined);

    await adapter.objectExists(WID, AID);
    await adapter.uploadAsset(WID, AID, new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    await adapter.downloadAsset(WID, AID);
    await adapter.deleteAsset(WID, AID);

    expect(mockSdk.ref.mock.calls.map(([, path]) => path)).toEqual([
      OBJECT_PATH,
      OBJECT_PATH,
      OBJECT_PATH,
      OBJECT_PATH,
    ]);
  });

  test("an id that could escape the workspace never reaches the SDK", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    await expect(adapter.downloadAsset(WID, "../../other/asset")).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    await expect(adapter.uploadAsset("ws-a/b", AID, new Uint8Array([1]), { contentType: "image/png" })).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    expect(mockSdk.ref).not.toHaveBeenCalled();
    expect(mockSdk.uploadBytes).not.toHaveBeenCalled();
    expect(mockSdk.getBlob).not.toHaveBeenCalled();
  });
});

describe("objectExists", () => {
  test("true when the object has metadata, false when it is not there", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.getMetadata.mockResolvedValueOnce({ size: 12 });
    expect(await adapter.objectExists(WID, AID)).toBe(true);

    mockSdk.getMetadata.mockRejectedValueOnce(assetStorageError(ASSET_STORAGE_ERROR.NOT_FOUND));
    expect(await adapter.objectExists(WID, AID)).toBe(false);
  });

  test("any other failure is raised, not reported as absence", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.getMetadata.mockRejectedValueOnce(assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED));
    await expect(adapter.objectExists(WID, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
  });
});

describe("objectMetadata", () => {
  test("reports the object's own identity, type and size", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.getMetadata.mockResolvedValueOnce({
      size: 42,
      contentType: "image/png",
      customMetadata: { assetId: AID, workspaceId: WID, assetKind: "editor-image" },
    });
    expect(await adapter.objectMetadata(WID, AID)).toEqual({
      exists: true,
      path: OBJECT_PATH,
      size: 42,
      contentType: "image/png",
      metadata: { assetId: AID, workspaceId: WID, assetKind: "editor-image" },
    });
  });

  test("an object with no custom metadata reports an empty map, not undefined", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.getMetadata.mockResolvedValueOnce({ size: "7", contentType: "application/pdf" });
    const head = await adapter.objectMetadata(WID, AID);
    expect(head).toMatchObject({ exists: true, size: 7, metadata: {} });
  });

  test("absence is an answer, and every other failure is raised", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.getMetadata.mockRejectedValueOnce(assetStorageError(ASSET_STORAGE_ERROR.NOT_FOUND));
    expect(await adapter.objectMetadata(WID, AID)).toEqual({ exists: false, path: OBJECT_PATH });

    mockSdk.getMetadata.mockRejectedValueOnce(assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED));
    await expect(adapter.objectMetadata(WID, AID)).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.UNAUTHORIZED,
    });
  });

  test("it never mints a download URL", () => {
    const source = fs.readFileSync(path.join(__dirname, "firebaseStorageAdapter.js"), "utf8");
    expect(source).not.toMatch(/getDownloadURL/);
  });
});

describe("upload progress", () => {
  function resumableTask(snapshots, final) {
    const task = {
      snapshot: final,
      on(_event, onProgress, onError, onComplete) {
        for (const snapshot of snapshots) onProgress(snapshot);
        onComplete();
      },
    };
    return task;
  }

  test("without a listener it stays the single-request upload it has always been", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.uploadBytes.mockResolvedValue({ metadata: { size: 3, contentType: "image/png" } });
    await adapter.uploadAsset(WID, AID, new Blob(["abc"], { type: "image/png" }));
    expect(mockSdk.uploadBytesResumable).not.toHaveBeenCalled();
  });

  test("with a listener it uses the resumable upload and forwards the SDK's OWN counters", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.uploadBytesResumable.mockImplementation(() =>
      resumableTask(
        [
          { bytesTransferred: 0, totalBytes: 300 },
          { bytesTransferred: 120, totalBytes: 300 },
          { bytesTransferred: 300, totalBytes: 300 },
        ],
        { metadata: { size: 300, contentType: "application/pdf" } }
      )
    );
    const seen = [];
    const result = await adapter.uploadAsset(WID, AID, new Blob(["x"], { type: "application/pdf" }), {
      onProgress: (p) => seen.push(p),
    });

    expect(mockSdk.uploadBytes).not.toHaveBeenCalled();
    expect(seen).toEqual([
      { bytesTransferred: 0, totalBytes: 300 },
      { bytesTransferred: 120, totalBytes: 300 },
      { bytesTransferred: 300, totalBytes: 300 },
    ]);
    expect(result).toEqual({ path: OBJECT_PATH, size: 300, contentType: "application/pdf" });
  });

  test("a tiny file simply completes — no percentage is invented", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.uploadBytesResumable.mockImplementation(() =>
      resumableTask([{ bytesTransferred: 4, totalBytes: 4 }], { metadata: { size: 4, contentType: "text/plain" } })
    );
    const seen = [];
    await adapter.uploadAsset(WID, AID, new Blob(["abcd"], { type: "text/plain" }), {
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toEqual([{ bytesTransferred: 4, totalBytes: 4 }]);
  });

  test("a listener that throws never breaks the upload", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.uploadBytesResumable.mockImplementation(() =>
      resumableTask([{ bytesTransferred: 1, totalBytes: 2 }], { metadata: { size: 2, contentType: "text/plain" } })
    );
    const result = await adapter.uploadAsset(WID, AID, new Blob(["ab"], { type: "text/plain" }), {
      onProgress: () => {
        throw new Error("listener exploded");
      },
    });
    expect(result.size).toBe(2);
  });

  test("a resumable upload that fails surfaces its code", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.uploadBytesResumable.mockImplementation(() => ({
      snapshot: null,
      on(_event, _onProgress, onError) {
        onError(assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED));
      },
    }));
    await expect(
      adapter.uploadAsset(WID, AID, new Blob(["x"], { type: "text/plain" }), { onProgress: () => {} })
    ).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
  });
});

describe("uploadAsset", () => {
  test("it writes the bytes with an explicit content type and reports what was stored", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.uploadBytes.mockResolvedValue({ metadata: { size: 5, contentType: "image/jpeg" } });
    const blob = new Blob(["hello"], { type: "image/jpeg" });

    const result = await adapter.uploadAsset(WID, AID, blob, { metadata: { assetKind: "editor-image" } });

    expect(mockSdk.uploadBytes).toHaveBeenCalledWith({ storage: expect.anything(), path: OBJECT_PATH }, blob, {
      contentType: "image/jpeg",
      customMetadata: { assetKind: "editor-image" },
    });
    expect(result).toEqual({ path: OBJECT_PATH, size: 5, contentType: "image/jpeg" });
  });

  test("the caller's content type wins over the Blob's, and neither may be absent", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.uploadBytes.mockResolvedValue({ metadata: { size: 1, contentType: "application/pdf" } });
    await adapter.uploadAsset(WID, AID, new Blob(["x"], { type: "image/png" }), { contentType: "application/pdf" });
    expect(mockSdk.uploadBytes.mock.calls[0][2]).toEqual({ contentType: "application/pdf" });

    await expect(adapter.uploadAsset(WID, AID, new Blob(["x"]))).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    await expect(adapter.uploadAsset(WID, AID, new Blob([], { type: "image/png" }))).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    await expect(adapter.uploadAsset(WID, AID, null, { contentType: "image/png" })).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.INVALID_ARGUMENT,
    });
    expect(mockSdk.uploadBytes).toHaveBeenCalledTimes(1);
  });

  test("a refused upload surfaces its code; a code-less failure becomes storage/unknown with its cause", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.uploadBytes.mockRejectedValueOnce(assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED));
    await expect(
      adapter.uploadAsset(WID, AID, new Blob(["x"], { type: "image/png" }))
    ).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });

    const network = new TypeError("Failed to fetch");
    mockSdk.uploadBytes.mockRejectedValueOnce(network);
    await expect(adapter.uploadAsset(WID, AID, new Blob(["x"], { type: "image/png" }))).rejects.toMatchObject({
      code: ASSET_STORAGE_ERROR.UNKNOWN,
      message: "Failed to fetch",
      cause: network,
    });
  });
});

describe("downloadAsset", () => {
  test("it reads through the authenticated SDK and returns the Blob", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    const blob = new Blob(["bytes"], { type: "application/pdf" });
    mockSdk.getBlob.mockResolvedValueOnce(blob);
    expect(await adapter.downloadAsset(WID, AID)).toBe(blob);
    expect(mockSdk.getBlob).toHaveBeenCalledWith({ storage: expect.anything(), path: OBJECT_PATH });
  });

  test("a missing object rejects with storage/object-not-found", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.getBlob.mockRejectedValueOnce(assetStorageError(ASSET_STORAGE_ERROR.NOT_FOUND));
    await expect(adapter.downloadAsset(WID, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.NOT_FOUND });
  });

  test("no download URL is ever minted — the adapter has no such operation", () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    expect(Object.keys(adapter).sort()).toEqual([
      "bucket",
      "deleteAsset",
      "downloadAsset",
      "objectExists",
      "objectMetadata",
      "objectPath",
      "uploadAsset",
    ]);
    expect(Object.isFrozen(adapter)).toBe(true);
  });
});

describe("deleteAsset", () => {
  test("it deletes, and reports an object that was already gone without failing", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.deleteObject.mockResolvedValueOnce(undefined);
    expect(await adapter.deleteAsset(WID, AID)).toEqual({ deleted: true });

    mockSdk.deleteObject.mockRejectedValueOnce(assetStorageError(ASSET_STORAGE_ERROR.NOT_FOUND));
    expect(await adapter.deleteAsset(WID, AID)).toEqual({ deleted: false });
  });

  test("a refused delete is raised, never swallowed", async () => {
    const adapter = createFirebaseStorageAdapter(CONFIG);
    mockSdk.deleteObject.mockRejectedValueOnce(assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED));
    await expect(adapter.deleteAsset(WID, AID)).rejects.toMatchObject({ code: ASSET_STORAGE_ERROR.UNAUTHORIZED });
  });
});

describe("the shared Firebase app", () => {
  // The app module itself imports `firebase/app` and is mocked above, so its
  // one Phase 7 change is asserted from source: the bucket becomes part of
  // the app options when the environment supplies one, and is left out
  // entirely when it does not (an app initialised by the auth adapter before
  // any bucket exists must be unchanged).
  const source = fs.readFileSync(path.join(__dirname, "..", "firebaseApp.js"), "utf8");

  test("it carries storageBucket into initializeApp, only when configured", () => {
    expect(source).toMatch(/\.\.\.\(config\.storageBucket \? \{ storageBucket: config\.storageBucket \} : \{\}\)/);
    expect(source).toMatch(/apiKey: config\.apiKey/);
    expect(source).toMatch(/initializeApp\(/);
    // Still one app, still one name.
    expect(source.match(/initializeApp\(/g)).toHaveLength(1);
    expect(source).toMatch(/FIREBASE_APP_NAME = "notewise"/);
  });
});
