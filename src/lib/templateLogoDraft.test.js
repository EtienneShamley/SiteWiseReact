// src/lib/templateLogoDraft.test.js
//
// ONE SNAPSHOT, BOTH SIDES OF THE AWAIT (Production Readiness Phase 7.9A,
// race correction).
//
// The draft-logo sequence has an await in the middle, and everything worth
// proving about it is about what happens on the far side of that await when
// the world has moved on: the active workspace changed, or the builder that
// asked for the asset is gone. The create is a controllable promise here, so
// each of those is expressed exactly — "the scope flips WHILE the create is
// pending", not "shortly after".
import "fake-indexeddb/auto";
import { LOGO_DRAFT_RESULT, createLogoDraft } from "./templateLogoDraft";
import { __resetAssetProtectionForTests, protectedAssetIds } from "./assetProtection";
import { activeAssetWorkspaceId, createLogoAsset, getAsset } from "./assetStorage";
import { getAssetUpload } from "./assetUploadQueue";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "./assetDbTestHarness";
import { DURABLE_SCOPE_KIND, __resetDurableStorageForTests, setDurableScope } from "./durableStorage";
import { PRIVACY_METHOD, privacyNormalizationMark } from "./imagePrivacy";

installStructuredCloneShim();

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";
const ASSET = "tpl-logo-11111111-1111-4111-8111-111111111111";

function signInTo(workspaceId) {
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: workspaceId });
}

/** A create whose resolution the test controls, recording what it was given. */
function deferredCreate() {
  let resolve;
  let reject;
  const pending = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const calls = [];
  const createAsset = (file, options) => {
    calls.push({ file, workspaceId: options && options.workspaceId });
    return pending;
  };
  return { createAsset, calls, resolve, reject };
}

const passThroughNormalize = async (blob) => ({
  blob,
  width: 10,
  height: 10,
  mimeType: blob.type,
  processed: false,
  privacy: privacyNormalizationMark(PRIVACY_METHOD.VERIFIED_CLEAN),
});

const logoFile = () => Object.assign(testBlob("LOGO", "image/png"), { name: "logo.png" });

beforeEach(async () => {
  __resetAssetProtectionForTests();
  __resetDurableStorageForTests();
  await deleteAssetDb();
});

/* -------------------------- the snapshot invariant ------------------------ */

describe("creation and protection use ONE workspace snapshot", () => {
  test("the scope flipping to B while the create is pending binds nothing to B", async () => {
    signInTo(WS_A);
    const create = deferredCreate();
    const registered = [];

    // What the Builder does: read the scope once, before anything async.
    const workspaceId = activeAssetWorkspaceId();
    const run = createLogoDraft(logoFile(), {
      workspaceId,
      createAsset: create.createAsset,
      register: (id, release) => registered.push({ id, release }),
    });

    // The account switches while the file is still being prepared.
    signInTo(WS_B);
    expect(activeAssetWorkspaceId()).toBe(WS_B);
    create.resolve(ASSET);
    const result = await run;

    expect(result.status).toBe(LOGO_DRAFT_RESULT.CREATED);
    // The creation boundary was handed A — the same value the protection got.
    expect(create.calls).toEqual([{ file: expect.anything(), workspaceId: WS_A }]);
    expect(protectedAssetIds(WS_A).has(ASSET)).toBe(true);
    expect(protectedAssetIds(WS_B).size).toBe(0);
    expect(registered).toEqual([{ id: ASSET, release: expect.any(Function) }]);

    // And the release, run in B's session, releases A's protection.
    registered[0].release();
    expect(protectedAssetIds(WS_A).size).toBe(0);
    expect(protectedAssetIds(WS_B).size).toBe(0);
  });

  test("against the REAL creation boundary, the record is tagged with the snapshot, not the scope at write time", async () => {
    signInTo(WS_A);
    const workspaceId = activeAssetWorkspaceId();
    // The normaliser is the await inside `createLogoAsset`; the switch lands
    // while it is running, BEFORE the record is built and written.
    const normalize = async (blob) => {
      signInTo(WS_B);
      return passThroughNormalize(blob);
    };
    const result = await createLogoDraft(logoFile(), {
      workspaceId,
      createAsset: (file, options) => createLogoAsset(file, { ...options, normalize }),
    });

    expect(result.status).toBe(LOGO_DRAFT_RESULT.CREATED);
    expect(activeAssetWorkspaceId()).toBe(WS_B);
    const record = await getAsset(result.assetId);
    expect(record.workspaceId).toBe(WS_A);
    // The upload identity is owed by A as well — not by the workspace that
    // happened to be active when the transaction ran.
    expect(await getAssetUpload(WS_A, result.assetId)).not.toBeNull();
    expect(await getAssetUpload(WS_B, result.assetId)).toBeNull();
    expect(protectedAssetIds(WS_A).has(result.assetId)).toBe(true);
    expect(protectedAssetIds(WS_B).size).toBe(0);
  });

  test("a null snapshot makes a local-only asset and protects nothing, whatever the scope becomes", async () => {
    const create = deferredCreate();
    const run = createLogoDraft(logoFile(), { workspaceId: null, createAsset: create.createAsset });
    signInTo(WS_B);
    create.resolve(ASSET);
    const result = await run;
    expect(result.status).toBe(LOGO_DRAFT_RESULT.CREATED);
    expect(create.calls[0].workspaceId).toBeNull();
    expect(protectedAssetIds(WS_B).size).toBe(0);
    expect(() => result.release()).not.toThrow();
  });
});

/* ----------------------------- late completion ---------------------------- */

describe("the builder unmounting while the create is pending", () => {
  test("resolving later registers nothing, protects nothing, and drops the draft in its OWN workspace", async () => {
    signInTo(WS_A);
    const create = deferredCreate();
    const removed = [];
    const registered = [];
    let alive = true;

    const run = createLogoDraft(logoFile(), {
      workspaceId: WS_A,
      isAlive: () => alive,
      register: (id, release) => registered.push({ id, release }),
      createAsset: create.createAsset,
      removeAsset: async (id, options) => {
        removed.push({ id, workspaceId: options && options.workspaceId });
      },
      isReferenced: () => false,
    });

    // Unmount — and, for good measure, an account switch — before it resolves.
    alive = false;
    signInTo(WS_B);
    create.resolve(ASSET);
    const result = await run;

    expect(result.status).toBe(LOGO_DRAFT_RESULT.CANCELLED);
    expect(result.assetId).toBe(ASSET);
    expect(registered).toEqual([]);
    expect(protectedAssetIds(WS_A).size).toBe(0);
    expect(protectedAssetIds(WS_B).size).toBe(0);
    // Deleted through the snapshot workspace, so the queue entry is settled
    // where it was written — not inferred from B's session.
    expect(removed).toEqual([{ id: ASSET, workspaceId: WS_A }]);
  });

  test("a late draft that something already references is not deleted, and still not registered", async () => {
    const create = deferredCreate();
    const removed = [];
    const run = createLogoDraft(logoFile(), {
      workspaceId: WS_A,
      isAlive: () => false,
      createAsset: create.createAsset,
      removeAsset: async (id) => removed.push(id),
      isReferenced: (id) => id === ASSET,
    });
    create.resolve(ASSET);
    const result = await run;
    expect(result.status).toBe(LOGO_DRAFT_RESULT.CANCELLED);
    expect(removed).toEqual([]);
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });

  test("a delete that fails on the late path is swallowed, exactly as the cancel path swallows it", async () => {
    const create = deferredCreate();
    const run = createLogoDraft(logoFile(), {
      workspaceId: WS_A,
      isAlive: () => false,
      createAsset: create.createAsset,
      removeAsset: async () => {
        throw new Error("refused");
      },
      isReferenced: () => false,
    });
    create.resolve(ASSET);
    await expect(run).resolves.toMatchObject({ status: LOGO_DRAFT_RESULT.CANCELLED });
  });

  test("the liveness check and the register call are one synchronous step", async () => {
    const create = deferredCreate();
    const order = [];
    const run = createLogoDraft(logoFile(), {
      workspaceId: WS_A,
      isAlive: () => {
        order.push("alive?");
        return true;
      },
      register: () => order.push("register"),
      createAsset: create.createAsset,
    });
    create.resolve(ASSET);
    await run;
    // No await between the two: nothing can unmount in the gap.
    expect(order).toEqual(["alive?", "register"]);
  });
});

/* ------------------------------ ordinary paths ---------------------------- */

describe("ordinary creation", () => {
  test("protects the asset, hands the register its release, and that release releases exactly once", async () => {
    const registered = [];
    const result = await createLogoDraft(logoFile(), {
      workspaceId: WS_A,
      createAsset: async () => ASSET,
      register: (id, release) => registered.push({ id, release }),
    });
    expect(result).toEqual({ status: LOGO_DRAFT_RESULT.CREATED, assetId: ASSET, release: expect.any(Function) });
    expect(registered[0].release).toBe(result.release);
    expect(protectedAssetIds(WS_A).has(ASSET)).toBe(true);

    result.release();
    expect(protectedAssetIds(WS_A).size).toBe(0);
    // Idempotent: the Builder's publish, replace and unmount paths may each
    // reach a handle that was already released.
    result.release();
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });

  test("a creation that fails registers nothing and reports the message", async () => {
    const registered = [];
    const result = await createLogoDraft(logoFile(), {
      workspaceId: WS_A,
      createAsset: async () => {
        throw new Error("Please choose a PNG, JPEG or WebP image.");
      },
      register: (id, release) => registered.push({ id, release }),
    });
    expect(result).toEqual({
      status: LOGO_DRAFT_RESULT.FAILED,
      assetId: null,
      message: "Please choose a PNG, JPEG or WebP image.",
    });
    expect(registered).toEqual([]);
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });

  test("the real boundary end to end: created under the snapshot, protected, released", async () => {
    signInTo(WS_A);
    const result = await createLogoDraft(logoFile(), {
      workspaceId: activeAssetWorkspaceId(),
      createAsset: (file, options) => createLogoAsset(file, { ...options, normalize: passThroughNormalize }),
    });
    expect(result.status).toBe(LOGO_DRAFT_RESULT.CREATED);
    expect((await getAsset(result.assetId)).workspaceId).toBe(WS_A);
    expect(protectedAssetIds(WS_A).has(result.assetId)).toBe(true);
    result.release();
    expect(protectedAssetIds(WS_A).size).toBe(0);
  });
});
