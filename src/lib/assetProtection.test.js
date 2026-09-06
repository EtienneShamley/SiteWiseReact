// src/lib/assetProtection.test.js
//
// THE PROTECTION IS BOUND TO ONE WORKSPACE AT BOTH ENDS (Production Readiness
// Phase 7.9A, workspace-isolation correction).
//
// The register is the only thing that stops the garbage-collection mark pass
// reading an unsaved Template Builder draft as garbage, so the question these
// cases answer is not "does it protect" but "can one workspace's release ever
// reach another workspace's protection". It must not — the Phase 7 identity
// model is workspace-scoped everywhere else (the asset record, the upload
// queue, the remote index, the GC ledger, both rules files), and the odds of
// an id collision are not the reason it holds.
import {
  __resetAssetProtectionForTests,
  protectAsset,
  protectedAssetIds,
} from "./assetProtection";
import { setDurableScope, __resetDurableStorageForTests, DURABLE_SCOPE_KIND } from "./durableStorage";

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";
const ASSET = "tpl-logo-11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  __resetAssetProtectionForTests();
  __resetDurableStorageForTests();
});

describe("two workspaces holding the same asset id", () => {
  test("are protected independently", () => {
    protectAsset(WS_A, ASSET);
    protectAsset(WS_B, ASSET);
    expect(protectedAssetIds(WS_A).has(ASSET)).toBe(true);
    expect(protectedAssetIds(WS_B).has(ASSET)).toBe(true);
  });

  test("releasing A leaves B protected", () => {
    const releaseA = protectAsset(WS_A, ASSET);
    protectAsset(WS_B, ASSET);

    releaseA();

    expect(protectedAssetIds(WS_A).has(ASSET)).toBe(false);
    expect(protectedAssetIds(WS_A).size).toBe(0);
    // The whole point of the correction: an id-only release would have taken
    // this one with it.
    expect(protectedAssetIds(WS_B).has(ASSET)).toBe(true);
  });

  test("releasing B leaves A protected — neither direction sweeps the other", () => {
    protectAsset(WS_A, ASSET);
    const releaseB = protectAsset(WS_B, ASSET);
    releaseB();
    expect(protectedAssetIds(WS_A).has(ASSET)).toBe(true);
    expect(protectedAssetIds(WS_B).size).toBe(0);
  });
});

describe("the release does not consult the ambient workspace", () => {
  test("switching the active workspace before releasing still releases the one it took", () => {
    setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS_A });
    const releaseA = protectAsset(WS_A, ASSET);
    protectAsset(WS_B, ASSET);

    // An account switch: the durable scope is now B's. A component unmounting
    // now, or an async publish/cancel completing now, runs its release here.
    setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS_B });
    releaseA();

    expect(protectedAssetIds(WS_A).size).toBe(0);
    expect(protectedAssetIds(WS_B).has(ASSET)).toBe(true);
  });

  test("releasing after the scope has left workspaces entirely still works", () => {
    setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS_A });
    const release = protectAsset(WS_A, ASSET);
    setDurableScope({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });
    release();
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });
});

describe("duplicate protection and release", () => {
  test("a handle releases at most once, and repeated release is harmless", () => {
    const release = protectAsset(WS_A, ASSET);
    release();
    release();
    release();
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });

  test("two holders of the same asset are counted; one releasing keeps the other's", () => {
    const first = protectAsset(WS_A, ASSET);
    const second = protectAsset(WS_A, ASSET);

    first();
    expect(protectedAssetIds(WS_A).has(ASSET)).toBe(true);
    // A stale extra call on the FIRST handle must not drop the second's hold.
    first();
    expect(protectedAssetIds(WS_A).has(ASSET)).toBe(true);

    second();
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });

  test("a release that runs after everything was reset does not throw or resurrect", () => {
    const release = protectAsset(WS_A, ASSET);
    __resetAssetProtectionForTests();
    expect(() => release()).not.toThrow();
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });
});

describe("what cannot be protected", () => {
  test("no workspace, or one that could never address an asset, protects nothing", () => {
    expect(protectAsset(null, ASSET)).toBeInstanceOf(Function);
    protectAsset(null, ASSET);
    protectAsset("", ASSET);
    protectAsset("../escape", ASSET);
    expect(protectedAssetIds(null).size).toBe(0);
    expect(protectedAssetIds("../escape").size).toBe(0);
  });

  test("an asset id that could never be a Storage path segment protects nothing", () => {
    protectAsset(WS_A, "../escape");
    protectAsset(WS_A, "");
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });

  test("the returned no-op release is still safe to call", () => {
    const release = protectAsset(null, ASSET);
    expect(() => release()).not.toThrow();
  });
});

describe("the register's own shape", () => {
  test("callers get a copy, so mutating the answer cannot alter the register", () => {
    protectAsset(WS_A, ASSET);
    const ids = protectedAssetIds(WS_A);
    ids.clear();
    expect(protectedAssetIds(WS_A).has(ASSET)).toBe(true);
  });

  test("nothing is persisted — a fresh register knows nothing", () => {
    protectAsset(WS_A, ASSET);
    __resetAssetProtectionForTests();
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });
});
