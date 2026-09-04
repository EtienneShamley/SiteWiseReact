// src/lib/assetReader.test.js
//
// THE READ BOUNDARY (Production Readiness Phase 7.2).
//
// Four properties, and none of them is about performance alone:
//
//   LOCAL FIRST      a local hit never reaches for anything else, so nothing
//                    a user already has on this device depends on a network;
//   NO REMOTE YET    with no loader injected — which is the whole product
//                    today — a local miss is simply a miss. This phase does
//                    not connect to Firebase Storage, and nothing here can
//                    imply that it does;
//   DEDUPLICATION    concurrent readers of one asset share one read, and the
//                    entry is released when it SETTLES so a Retry is a real
//                    retry rather than the cached failure;
//   ISOLATION        the key names the workspace, so one account's result can
//                    never be handed to a request made under another — and a
//                    record owned by another workspace does not resolve.
import "fake-indexeddb/auto";
import fs from "fs";
import path from "path";
import {
  ASSET_READ_STATE,
  assetReadKey,
  inFlightAssetReadCount,
  isAssetReadableInWorkspace,
  loadAsset,
  resetAssetReader,
  resolveReadWorkspaceId,
} from "./assetReader";
import { ASSET_KIND_PDF_SOURCE } from "./localAssetCache";
import { createEditorImageAsset, makeAssetRecord, saveAsset } from "./assetStorage";
import { removePdfBytes, savePdfBytes } from "./pdfStorage";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "./assetDbTestHarness";
import { DURABLE_SCOPE_KIND, setDurableScope } from "./durableStorage";

installStructuredCloneShim();

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";
const PDF_SOURCE_ID = "src-11111111-1111-4111-8111-111111111111";

function signInTo(workspaceId) {
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: workspaceId });
}
function signOut() {
  setDurableScope({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });
}

/** A promise whose settlement this test controls. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await deleteAssetDb();
  await removePdfBytes(PDF_SOURCE_ID);
  resetAssetReader();
  signOut();
});

afterEach(() => {
  resetAssetReader();
  signOut();
});

describe("the read-state vocabulary", () => {
  test("it names every state a reading surface may eventually report", () => {
    expect(ASSET_READ_STATE).toEqual({
      IDLE: "idle",
      LOADING: "loading",
      DOWNLOADING: "downloading",
      READY: "ready",
      MISSING: "missing",
      OFFLINE: "offline",
      ERROR: "error",
    });
  });

  test("the four states the product uses today keep their existing strings", () => {
    // useAssetObjectUrl has always returned these; renaming one would silently
    // change every placeholder that branches on them.
    expect([
      ASSET_READ_STATE.IDLE,
      ASSET_READ_STATE.LOADING,
      ASSET_READ_STATE.READY,
      ASSET_READ_STATE.MISSING,
      ASSET_READ_STATE.ERROR,
    ]).toEqual(["idle", "loading", "ready", "missing", "error"]);
  });
});

describe("local first, and no remote in this phase", () => {
  test("a local hit never calls the remote loader", async () => {
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    const remoteLoader = jest.fn();
    const asset = await loadAsset(id, { remoteLoader });
    expect(await asset.blob.text()).toBe("IMG");
    expect(remoteLoader).not.toHaveBeenCalled();
  });

  test("a local miss with NO loader injected is simply a miss", async () => {
    // The default production path in 7.2: nothing to fall back to, and no
    // pretence that a cloud copy is being fetched.
    expect(await loadAsset("no-such-asset")).toBeNull();
    expect(await loadAsset("no-such-asset", { kind: ASSET_KIND_PDF_SOURCE })).toBeNull();
    expect(await loadAsset(null)).toBeNull();
  });

  test("a local miss calls an injected loader exactly once, with the read's identity", async () => {
    const remoteLoader = jest.fn(async () => ({ id: "remote-1", kind: "logo", blob: testBlob("R") }));
    signInTo(WS_A);
    const asset = await loadAsset("remote-1", { kind: "logo", remoteLoader });
    expect(remoteLoader).toHaveBeenCalledTimes(1);
    expect(remoteLoader).toHaveBeenCalledWith({
      assetId: "remote-1",
      workspaceId: WS_A,
      kind: "logo",
    });
    expect(await asset.blob.text()).toBe("R");
  });

  test("a loader that finds nothing resolves to null, not undefined", async () => {
    expect(await loadAsset("gone", { remoteLoader: async () => undefined })).toBeNull();
  });

  test("neither module in the read path touches Firebase Storage", () => {
    for (const file of ["assetReader.js", "localAssetCache.js", "assetDb.js"]) {
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(source).not.toMatch(/firebase\/storage/);
      expect(source).not.toMatch(/firebaseStorageAdapter/);
      expect(source).not.toMatch(/getDownloadURL/);
    }
  });
});

describe("in-flight deduplication", () => {
  test("concurrent reads of one asset share a single resolution", async () => {
    const gate = deferred();
    const remoteLoader = jest.fn(() => gate.promise);
    const reads = [
      loadAsset("shared-1", { remoteLoader }),
      loadAsset("shared-1", { remoteLoader }),
      loadAsset("shared-1", { remoteLoader }),
    ];
    expect(inFlightAssetReadCount()).toBe(1);
    gate.resolve({ id: "shared-1", kind: "logo", blob: testBlob("ONCE") });
    const results = await Promise.all(reads);
    expect(remoteLoader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r && r.id === "shared-1")).toBe(true);
  });

  test("the entry is released once the read settles, so a later read is a real read", async () => {
    const remoteLoader = jest.fn(async () => ({ id: "a-1", kind: "logo", blob: testBlob("R") }));
    await loadAsset("a-1", { remoteLoader });
    expect(inFlightAssetReadCount()).toBe(0);
    await loadAsset("a-1", { remoteLoader });
    expect(remoteLoader).toHaveBeenCalledTimes(2);
  });

  test("a FAILED read clears its entry, so Retry can succeed", async () => {
    let attempt = 0;
    const remoteLoader = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network");
      return { id: "flaky-1", kind: "logo", blob: testBlob("SECOND") };
    });
    await expect(loadAsset("flaky-1", { remoteLoader })).rejects.toThrow("network");
    expect(inFlightAssetReadCount()).toBe(0);
    const retried = await loadAsset("flaky-1", { remoteLoader });
    expect(await retried.blob.text()).toBe("SECOND");
  });

  test("a read of a DIFFERENT kind is a different read", async () => {
    const gate = deferred();
    const remoteLoader = jest.fn(() => gate.promise);
    const asImage = loadAsset("same-id", { kind: "logo", remoteLoader });
    const asPdf = loadAsset("same-id", { kind: ASSET_KIND_PDF_SOURCE, remoteLoader });
    expect(inFlightAssetReadCount()).toBe(2);
    gate.resolve(null);
    await Promise.all([asImage, asPdf]);
    expect(remoteLoader).toHaveBeenCalledTimes(2);
  });
});

describe("workspace isolation", () => {
  test("the deduplication key names the workspace, the kind and the asset", () => {
    expect(assetReadKey("a-1", { workspaceId: WS_A, kind: "logo" })).not.toBe(
      assetReadKey("a-1", { workspaceId: WS_B, kind: "logo" })
    );
    expect(assetReadKey("a-1", { workspaceId: WS_A, kind: "logo" })).not.toBe(
      assetReadKey("a-1", { workspaceId: WS_A, kind: "note-photo" })
    );
    expect(assetReadKey("a-1", {})).toBe(assetReadKey("a-1", { workspaceId: null, kind: null }));
  });

  test("the same asset id in two workspaces does NOT share one read", async () => {
    const gate = deferred();
    const remoteLoader = jest.fn(() => gate.promise);
    const inA = loadAsset("same-id", { workspaceId: WS_A, remoteLoader });
    const inB = loadAsset("same-id", { workspaceId: WS_B, remoteLoader });
    // Two entries, not one: the key names the workspace.
    expect(inFlightAssetReadCount()).toBe(2);
    gate.resolve(null);
    await Promise.all([inA, inB]);
    expect(remoteLoader).toHaveBeenCalledTimes(2);
    expect(remoteLoader.mock.calls.map(([arg]) => arg.workspaceId)).toEqual([WS_A, WS_B]);
  });

  test("a record owned by another workspace does not resolve as a local hit", async () => {
    signInTo(WS_A);
    const id = await createEditorImageAsset(testBlob("A-ONLY", "image/png"), { name: "a.png" });
    // Signed in as a different account on the same browser.
    expect(await loadAsset(id, { workspaceId: WS_B })).toBeNull();
    // …and the request falls through to whatever that workspace's own store
    // holds, rather than being served the other account's bytes.
    const remoteLoader = jest.fn(async () => null);
    expect(await loadAsset(id, { workspaceId: WS_B, remoteLoader })).toBeNull();
    expect(remoteLoader).toHaveBeenCalledTimes(1);
    // The owning workspace still reads it.
    expect(await (await loadAsset(id, { workspaceId: WS_A })).blob.text()).toBe("A-ONLY");
  });

  test("an OWNED record is never an unrestricted read, whatever the request names", () => {
    // Stated from the record: no request shape widens it.
    const owned = { workspaceId: WS_A };
    expect(isAssetReadableInWorkspace(owned, WS_A)).toBe(true);
    for (const requested of [WS_B, null, undefined, "", 0, false]) {
      expect(isAssetReadableInWorkspace(owned, requested)).toBe(false);
    }
    // A legacy record has no owner and stays readable — the one deliberate
    // exemption, for Phase 7.6 migration compatibility.
    for (const requested of [WS_A, WS_B, null, undefined, ""]) {
      expect(isAssetReadableInWorkspace({ workspaceId: null }, requested)).toBe(true);
      expect(isAssetReadableInWorkspace({}, requested)).toBe(true);
    }
  });

  test("only a VALID workspace overrides the active scope — blanks fall back to it", () => {
    signInTo(WS_A);
    expect(resolveReadWorkspaceId(WS_B)).toBe(WS_B);
    for (const blank of [undefined, null, "", 0, false, "a/b", "../escape", 42]) {
      expect(resolveReadWorkspaceId(blank)).toBe(WS_A);
    }
    signOut();
    expect(resolveReadWorkspaceId(null)).toBeNull();
  });

  test("omitting or BLANKING the workspace cannot read another workspace's asset", async () => {
    // The asset is created under B, then read from a session signed in as A.
    signInTo(WS_B);
    const id = await createEditorImageAsset(testBlob("B-ONLY", "image/png"), { name: "b.png" });
    signInTo(WS_A);
    for (const options of [
      {},
      { workspaceId: null },
      { workspaceId: undefined },
      { workspaceId: "" },
      { workspaceId: 0 },
      { workspaceId: "../escape" },
    ]) {
      resetAssetReader();
      expect(await loadAsset(id, options)).toBeNull();
    }
    // …and the blanked request is still a normal read of A's OWN assets.
    const mine = await createEditorImageAsset(testBlob("A-OK", "image/png"), { name: "a.png" });
    expect(await (await loadAsset(mine, { workspaceId: null })).blob.text()).toBe("A-OK");
  });

  test("a blanked workspace does not share a read with a genuine local-scope read", async () => {
    signInTo(WS_A);
    // Both resolve to WS_A, so they are ONE read — not one scoped and one not.
    expect(assetReadKey("x", { workspaceId: resolveReadWorkspaceId(null) })).toBe(
      assetReadKey("x", { workspaceId: WS_A })
    );
  });

  test("signed out, an owned record does not resolve", async () => {
    signInTo(WS_A);
    const id = await createEditorImageAsset(testBlob("A-ONLY", "image/png"), { name: "a.png" });
    signOut();
    expect(await loadAsset(id)).toBeNull();
    expect(await loadAsset(id, { workspaceId: null })).toBeNull();
  });

  test("a LEGACY unscoped record stays readable in every scope", async () => {
    await saveAsset(makeAssetRecord({ id: "legacy-1", kind: "logo", blob: testBlob("OLD") }));
    expect(isAssetReadableInWorkspace({ workspaceId: null }, WS_A)).toBe(true);
    for (const workspaceId of [null, WS_A, WS_B]) {
      expect(await (await loadAsset("legacy-1", { workspaceId })).blob.text()).toBe("OLD");
    }
  });

  test("the workspace defaults to the active durable scope", async () => {
    signInTo(WS_A);
    const remoteLoader = jest.fn(async () => null);
    await loadAsset("scoped-1", { remoteLoader });
    expect(remoteLoader.mock.calls[0][0].workspaceId).toBe(WS_A);
    signOut();
    await loadAsset("scoped-2", { remoteLoader });
    expect(remoteLoader.mock.calls[1][0].workspaceId).toBeNull();
  });
});

describe("PDF source bytes", () => {
  beforeEach(async () => {
    await savePdfBytes(PDF_SOURCE_ID, new Uint8Array([37, 80, 68, 70]), "plans.pdf");
  });

  test("they are read through the same boundary, from the PDF store", async () => {
    const rec = await loadAsset(PDF_SOURCE_ID, { kind: ASSET_KIND_PDF_SOURCE });
    expect(rec).toMatchObject({ kind: ASSET_KIND_PDF_SOURCE, name: "plans.pdf" });
    expect(Array.from(rec.bytes)).toEqual([37, 80, 68, 70]);
  });

  test("each caller owns its own bytes, because pdf.js detaches the buffer it renders", async () => {
    // Two readers joined to one in-flight read must not share one buffer.
    const first = loadAsset(PDF_SOURCE_ID, { kind: ASSET_KIND_PDF_SOURCE });
    const second = loadAsset(PDF_SOURCE_ID, { kind: ASSET_KIND_PDF_SOURCE });
    expect(inFlightAssetReadCount()).toBe(1);
    const [a, b] = await Promise.all([first, second]);
    expect(a.bytes).not.toBe(b.bytes);
    expect(a.bytes.buffer).not.toBe(b.bytes.buffer);
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });
});
