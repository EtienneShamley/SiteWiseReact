// src/lib/cloud/assetUploadSync.test.js
//
// The upload engine (Production Readiness Phase 7.4), against a REAL
// IndexedDB (fake-indexeddb) for the local queue/index and the in-memory
// Storage + Firestore doubles for the cloud — the doubles that enforce the
// deployed rules (membership, create-only objects, owner-only deletion, the
// asset document state machine), so an "it settled" here is a settlement the
// service would also have permitted.
//
// The properties under test, in order of how much they matter:
//
//   ISOLATION     one workspace's engine never touches another's queue, and a
//                 stopped engine never writes again.
//   IDEMPOTENCE   every interruption between "the cloud has it" and "this
//                 browser knows" is recoverable without rewriting anything.
//   HONESTY       progress is real bytes; a conflict is reported, not papered
//                 over; a provider's own error text never reaches the user.

import "fake-indexeddb/auto";
import {
  ASSET_SYNC_CODE,
  ASSET_SYNC_OUTCOME,
  ASSET_SYNC_STATUS,
  CREATE_RACE_CODES,
  assetSyncFailureMessage,
  classifyAssetUploadError,
  createAssetUploadSync,
  defaultAssetUploadLocal,
  isPossibleCreateRace,
  signOutMessage,
} from "./assetUploadSync";
import { createMemoryAssetStore } from "./memoryAssetStore";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";
import { assetDocumentPath } from "./assetPaths";
import { buildAssetDocument } from "./assetCloudModel";
import { makeAssetRecord, getAsset, saveNewAsset } from "../assetStorage";
import { enqueueAssetUpload, getAssetUpload } from "../assetUploadQueue";
import { REMOTE_ASSET_STATE, getRemoteAssetEntry } from "../assetRemoteIndex";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "../assetDbTestHarness";

installStructuredCloneShim();

const UID = "uid-owner-1";
const OTHER_UID = "uid-owner-2";
const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";

let assetStore;
let workspaceStore;
let online;
let skew;
let timers;
let onlineListeners;

/** The clock every double and the engine share. */
const nowMs = () => Date.now() + skew;

function seedWorkspace(store, workspaceId, ownerUid) {
  store.seed(["workspaces", workspaceId], {
    id: workspaceId,
    name: "W",
    ownerUid,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  store.seed(["workspaces", workspaceId, "members", ownerUid], {
    uid: ownerUid,
    role: "owner",
    addedAt: 1,
    addedBy: ownerUid,
  });
}

beforeEach(async () => {
  await deleteAssetDb();
  online = true;
  // The engine reads the REAL clock, plus whatever a test has fast-forwarded.
  // A frozen clock would not do: queue entries are stamped by the atomic
  // creation from `Date.now()`, and an engine whose clock ran behind them
  // would correctly find nothing due — which is a fixture bug, not a finding.
  skew = 0;
  timers = [];
  onlineListeners = [];
  workspaceStore = createMemoryWorkspaceStore({ now: nowMs });
  workspaceStore.setUser(UID);
  seedWorkspace(workspaceStore, WS_A, UID);
  seedWorkspace(workspaceStore, WS_B, UID);
  assetStore = createMemoryAssetStore({ workspaceStore, now: nowMs });
});

/** An engine whose timers never fire on their own — every drain is explicit. */
function makeEngine(overrides = {}) {
  const { local: localOverrides, ...rest } = overrides;
  return createAssetUploadSync({
    workspaceId: WS_A,
    assetStore,
    workspaceStore,
    isOnline: () => online,
    now: nowMs,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
    addOnlineListener: (fn) => {
      onlineListeners.push(fn);
      return () => {};
    },
    local: {
      ...defaultAssetUploadLocal,
      // The PDF repair has its own suite; it is inert here unless a test asks
      // for it, so an engine test never depends on the PDF registry.
      reconcilePdfSources: async () => ({ enqueued: [], settled: [] }),
      currentPdfSources: () => [],
      ...(localOverrides || {}),
    },
    ...rest,
  });
}

/** Create a workspace-owned local asset AND its queue entry, atomically. */
async function createAsset({
  id,
  workspaceId = WS_A,
  kind = "editor-image",
  name = "photo.png",
  type = "image/png",
  body = "bytes",
} = {}) {
  const record = makeAssetRecord({ id, kind, name, blob: testBlob(body, type), workspaceId });
  await saveNewAsset(record);
  return record;
}

function documentFieldsFor(record, overrides = {}) {
  const built = buildAssetDocument({
    workspaceId: record.workspaceId,
    id: record.id,
    assetKind: record.kind,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt,
    metadata: record.metadata,
  });
  if (!built.ok) throw new Error(`test fixture is not a valid asset document: ${built.reason}`);
  return { ...built.fields, ...overrides };
}

function collectOutcomes(engine) {
  const seen = [];
  engine.subscribe((event) => {
    if (event.type === "outcome") seen.push(...event.results);
  });
  return seen;
}

/* ------------------------------- the happy path -------------------------- */

describe("one queued asset", () => {
  test("uploads, records metadata, updates the index and settles", async () => {
    const record = await createAsset({ id: "asset-one" });
    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);

    await engine.flush();

    expect(assetStore.list(WS_A)).toEqual(["asset-one"]);
    const doc = await workspaceStore.readAssetDocument(WS_A, "asset-one");
    expect(doc.exists).toBe(true);
    expect(doc.fields.assetKind).toBe("editor-image");
    expect(doc.fields.mimeType).toBe("image/png");
    expect(doc.fields.size).toBe(record.size);
    expect(doc.fields.state).toBe("stored");

    const index = await getRemoteAssetEntry(WS_A, "asset-one");
    expect(index.state).toBe(REMOTE_ASSET_STATE.STORED);
    expect(index.size).toBe(record.size);
    expect(await getAssetUpload(WS_A, "asset-one")).toBeNull();
    expect(outcomes).toEqual([
      { assetId: "asset-one", kind: "editor-image", outcome: ASSET_SYNC_OUTCOME.SYNCED, code: null },
    ]);
    expect(engine.getStatus().status).toBe(ASSET_SYNC_STATUS.IDLE);
  });

  test("keeps the local bytes after a successful upload", async () => {
    await createAsset({ id: "asset-keep" });
    await makeEngine().flush();
    const stored = await getAsset("asset-keep");
    expect(stored).not.toBeNull();
    expect(stored.blob.size).toBeGreaterThan(0);
  });

  test("writes the identity metadata the Storage create rule requires", async () => {
    await createAsset({ id: "asset-meta" });
    await makeEngine().flush();
    const head = await assetStore.objectMetadata(WS_A, "asset-meta");
    expect(head.metadata).toEqual({ assetId: "asset-meta", workspaceId: WS_A, assetKind: "editor-image" });
    expect(head.contentType).toBe("image/png");
  });
});

/* -------------------------------- ordering ------------------------------- */

describe("ordering and concurrency", () => {
  test("drains oldest first", async () => {
    const order = [];
    for (const [id, at] of [["third", 300], ["first", 100], ["second", 200]]) {
      const record = makeAssetRecord({
        id,
        kind: "editor-image",
        name: `${id}.png`,
        blob: testBlob(id, "image/png"),
        workspaceId: WS_A,
      });
      record.createdAt = at;
      await saveNewAsset(record);
    }
    const engine = makeEngine({
      concurrency: 1,
      local: {
        ...defaultAssetUploadLocal,
        reconcilePdfSources: async () => ({ enqueued: [], settled: [] }),
        currentPdfSources: () => [],
        readAsset: async (assetId, kind) => {
          order.push(assetId);
          return defaultAssetUploadLocal.readAsset(assetId, kind);
        },
      },
    });
    await engine.flush();
    expect(order).toEqual(["first", "second", "third"]);
  });

  test("start hands the PDF reconciler this engine's OWN workspace-store document reader — the cloud, not the local index, decides (2026-09-05)", async () => {
    const seen = [];
    const engine = makeEngine({
      local: {
        ...defaultAssetUploadLocal,
        currentPdfSources: () => [],
        reconcilePdfSources: async (workspaceId, options) => {
          seen.push({ workspaceId, reader: options && options.readCloudAssetDocument });
          return { enqueued: [], settled: [], conflicts: [] };
        },
      },
    });
    engine.start();
    await engine.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].workspaceId).toBe(WS_A);
    expect(typeof seen[0].reader).toBe("function");
    // and it really is this store's boundary: an absent document reads as absent here
    await expect(seen[0].reader(WS_A, "no-such-source")).resolves.toEqual({ exists: false, fields: null });
    engine.stop();
  });

  test("never runs more than the configured number of uploads at once", async () => {
    for (let i = 0; i < 6; i++) await createAsset({ id: `many-${i}` });
    let active = 0;
    let peak = 0;
    const real = assetStore.uploadAsset;
    assetStore.uploadAsset = async (...args) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        return await real(...args);
      } finally {
        active -= 1;
      }
    };
    await makeEngine({ concurrency: 2 }).flush();
    expect(peak).toBeLessThanOrEqual(2);
    expect(assetStore.list(WS_A)).toHaveLength(6);
  });
});

/* ------------------------------- isolation ------------------------------- */

describe("isolation", () => {
  test("an engine never processes another workspace's queue", async () => {
    await createAsset({ id: "a-owned", workspaceId: WS_A });
    await createAsset({ id: "b-owned", workspaceId: WS_B });

    await makeEngine().flush();

    expect(assetStore.list(WS_A)).toEqual(["a-owned"]);
    expect(assetStore.list(WS_B)).toEqual([]);
    expect(await getAssetUpload(WS_B, "b-owned")).not.toBeNull();
    expect(await getRemoteAssetEntry(WS_B, "b-owned")).toBeNull();
  });

  test("an entry naming a different workspace is discarded before it is processed", async () => {
    await createAsset({ id: "cross", workspaceId: WS_A });
    const engine = makeEngine({
      local: {
        ...defaultAssetUploadLocal,
        reconcilePdfSources: async () => ({ enqueued: [], settled: [] }),
        // A hand-built row the compound key range could not actually produce —
        // the second barrier behind that key range.
        listPending: async () => [
          { workspaceId: WS_B, assetId: "cross", kind: "editor-image", at: 1, attempts: 0, nextAttemptAt: 0 },
        ],
      },
    });
    const outcomes = collectOutcomes(engine);
    await engine.flush();
    expect(outcomes).toEqual([]);
    expect(engine.getStatus()).toMatchObject({ status: ASSET_SYNC_STATUS.IDLE, pending: 0 });
    expect(assetStore.list(WS_B)).toEqual([]);
    expect(assetStore.calls.uploads).toEqual([]);
  });

  test("a record owned by another workspace is never uploaded under this one", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "foreign", kind: "editor-image" });
    const record = makeAssetRecord({
      id: "foreign",
      kind: "editor-image",
      name: "x.png",
      blob: testBlob("x", "image/png"),
      workspaceId: WS_B,
    });
    await saveNewAsset(record);
    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();
    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.WORKSPACE_MISMATCH);
    expect(assetStore.list(WS_A)).toEqual([]);
  });

  test("a stopped engine performs no further local or cloud work", async () => {
    await createAsset({ id: "stopped-1" });
    const engine = makeEngine();
    engine.stop();
    await engine.flush();
    expect(assetStore.list(WS_A)).toEqual([]);
    expect(await getAssetUpload(WS_A, "stopped-1")).not.toBeNull();
  });

  test("stopping mid-upload leaves the queue entry and writes no local sync state", async () => {
    await createAsset({ id: "mid-flight" });
    const engine = makeEngine();
    const real = assetStore.uploadAsset;
    assetStore.uploadAsset = async (...args) => {
      const result = await real(...args);
      engine.stop(); // the session closes exactly between cloud and local
      return result;
    };
    await engine.flush();
    expect(await getRemoteAssetEntry(WS_A, "mid-flight")).toBeNull();
    expect(await getAssetUpload(WS_A, "mid-flight")).not.toBeNull();
  });

  test("a stopped engine cannot be restarted", () => {
    const engine = makeEngine();
    engine.stop();
    expect(() => engine.start()).toThrow(/stopped/i);
  });
});

/* ------------------------------ idempotence ------------------------------ */

describe("an object that is already there", () => {
  async function seedMatchingObject(record) {
    await assetStore.seed(WS_A, record.id, record.blob, {
      contentType: record.mimeType,
      metadata: { assetId: record.id, workspaceId: WS_A, assetKind: record.kind },
    });
  }

  test("is not overwritten, and the metadata document is created", async () => {
    const record = await createAsset({ id: "already-there" });
    await seedMatchingObject(record);

    await makeEngine().flush();

    expect(assetStore.calls.uploads).toEqual([]);
    const doc = await workspaceStore.readAssetDocument(WS_A, "already-there");
    expect(doc.exists).toBe(true);
    expect(await getAssetUpload(WS_A, "already-there")).toBeNull();
  });

  test("with a matching metadata document, settles without writing anything", async () => {
    const record = await createAsset({ id: "fully-synced" });
    await seedMatchingObject(record);
    workspaceStore.seed(assetDocumentPath(WS_A, record.id), { ...documentFieldsFor(record), updatedAt: nowMs() });
    const commitsBefore = workspaceStore.calls.commits.length;

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(assetStore.calls.uploads).toEqual([]);
    expect(workspaceStore.calls.commits.length).toBe(commitsBefore);
    expect(outcomes[0].outcome).toBe(ASSET_SYNC_OUTCOME.SYNCED);
    expect((await getRemoteAssetEntry(WS_A, "fully-synced")).state).toBe(REMOTE_ASSET_STATE.STORED);
    expect(await getAssetUpload(WS_A, "fully-synced")).toBeNull();
  });

  test("a lost acknowledgement settles on the next attempt", async () => {
    // The previous attempt wrote BOTH cloud records and died before settling.
    const record = await createAsset({ id: "lost-ack" });
    await seedMatchingObject(record);
    workspaceStore.seed(assetDocumentPath(WS_A, record.id), { ...documentFieldsFor(record), updatedAt: nowMs() });

    await makeEngine().flush();

    expect(await getAssetUpload(WS_A, "lost-ack")).toBeNull();
    expect((await getRemoteAssetEntry(WS_A, "lost-ack")).state).toBe(REMOTE_ASSET_STATE.STORED);
    const stored = await getAsset("lost-ack");
    expect(stored).not.toBeNull();
  });

  test("a tombstoned matching document is restored, not rewritten wholesale", async () => {
    const record = await createAsset({ id: "resurrected" });
    await seedMatchingObject(record);
    workspaceStore.seed(assetDocumentPath(WS_A, record.id), {
      ...documentFieldsFor(record),
      state: "tombstoned",
      tombstonedAt: nowMs() - 1000,
      updatedAt: nowMs() - 1000,
    });

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    const doc = await workspaceStore.readAssetDocument(WS_A, "resurrected");
    expect(doc.fields.state).toBe("stored");
    expect(doc.fields.tombstonedAt).toBeUndefined();
    expect(doc.fields.size).toBe(record.size);
    expect(outcomes[0].outcome).toBe(ASSET_SYNC_OUTCOME.SYNCED);
    expect(await getAssetUpload(WS_A, "resurrected")).toBeNull();
  });
});

/* --------------------------- object identity conflict -------------------- */

describe("an object on the path that is NOT this asset", () => {
  async function runConflict(record, seeded) {
    await assetStore.seed(WS_A, record.id, seeded.data || record.blob, {
      contentType: seeded.contentType || record.mimeType,
      metadata: seeded.metadata || {
        assetId: record.id,
        workspaceId: WS_A,
        assetKind: record.kind,
      },
    });
    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();
    return outcomes;
  }

  test("a wrong assetKind is a permanent conflict", async () => {
    const record = await createAsset({ id: "conflict-kind" });
    const outcomes = await runConflict(record, {
      metadata: { assetId: record.id, workspaceId: WS_A, assetKind: "note-file" },
    });
    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.OBJECT_CONFLICT });
    expect(assetStore.calls.uploads).toEqual([]);
  });

  test("a wrong contentType is a permanent conflict", async () => {
    const record = await createAsset({ id: "conflict-type" });
    const outcomes = await runConflict(record, { contentType: "application/pdf" });
    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.OBJECT_CONFLICT);
    expect(assetStore.calls.uploads).toEqual([]);
  });

  test("a wrong size is a permanent conflict", async () => {
    const record = await createAsset({ id: "conflict-size", body: "small" });
    const outcomes = await runConflict(record, { data: testBlob("a much longer body", "image/png") });
    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.OBJECT_CONFLICT);
  });

  test("a mismatched custom workspaceId is a permanent conflict", async () => {
    const record = await createAsset({ id: "conflict-ws" });
    const outcomes = await runConflict(record, {
      metadata: { assetId: record.id, workspaceId: WS_B, assetKind: record.kind },
    });
    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.OBJECT_CONFLICT);
  });

  test("a mismatched custom assetId is a permanent conflict", async () => {
    const record = await createAsset({ id: "conflict-id" });
    const outcomes = await runConflict(record, {
      metadata: { assetId: "some-other-asset", workspaceId: WS_A, assetKind: record.kind },
    });
    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.OBJECT_CONFLICT);
  });

  test("an object with no custom metadata at all is a permanent conflict", async () => {
    const record = await createAsset({ id: "conflict-bare" });
    const outcomes = await runConflict(record, { metadata: {} });
    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.OBJECT_CONFLICT);
  });

  test("no Firestore metadata is created after an object conflict", async () => {
    const record = await createAsset({ id: "conflict-nodoc" });
    await runConflict(record, {
      metadata: { assetId: record.id, workspaceId: WS_A, assetKind: "note-file" },
    });
    const doc = await workspaceStore.readAssetDocument(WS_A, "conflict-nodoc");
    expect(doc.exists).toBe(false);
  });

  test("the conflict keeps the local bytes and the queue entry, paused", async () => {
    const record = await createAsset({ id: "conflict-keep" });
    await runConflict(record, { contentType: "text/plain" });
    expect(await getAsset("conflict-keep")).not.toBeNull();
    const entry = await getAssetUpload(WS_A, "conflict-keep");
    expect(entry.lastCode).toBe(ASSET_SYNC_CODE.OBJECT_CONFLICT);
    expect(entry.attempts).toBeGreaterThanOrEqual(5);
  });
});

/* ------------------------- the immutable-create race --------------------- */

describe("two clients racing an immutable create", () => {
  /**
   * Makes the OTHER client win between this engine's head and its own write:
   * the object is placed on the path just before `uploadAsset` reaches the
   * store, so the store refuses the write exactly as the create-only rule
   * does — with a permission-shaped `storage/unauthorized`.
   */
  function otherClientWins({ data, contentType, metadata } = {}) {
    const real = assetStore.uploadAsset;
    let armed = true;
    assetStore.uploadAsset = async (wid, aid, payload, options) => {
      if (armed) {
        armed = false;
        await assetStore.seed(wid, aid, data || payload, {
          contentType: contentType || options.contentType,
          metadata: metadata || options.metadata,
        });
      }
      return real(wid, aid, payload, options);
    };
  }

  test("the loser re-reads the matching object and completes the lifecycle", async () => {
    const record = await createAsset({ id: "race-win" });
    otherClientWins();

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    // The refusal was a lost race, not a refusal of this account.
    expect(outcomes).toEqual([
      { assetId: "race-win", kind: "editor-image", outcome: ASSET_SYNC_OUTCOME.SYNCED, code: null },
    ]);
    // Nothing was uploaded by this engine — the winner's object stands.
    expect(assetStore.calls.uploads).toEqual([]);
    const head = await assetStore.objectMetadata(WS_A, "race-win");
    expect(head.size).toBe(record.size);
    expect(head.metadata).toEqual({ assetId: record.id, workspaceId: WS_A, assetKind: record.kind });
    // And the lifecycle finished: document, index, settled queue.
    expect((await workspaceStore.readAssetDocument(WS_A, "race-win")).exists).toBe(true);
    expect((await getRemoteAssetEntry(WS_A, "race-win")).state).toBe(REMOTE_ASSET_STATE.STORED);
    expect(await getAssetUpload(WS_A, "race-win")).toBeNull();
    expect(engine.getStatus()).toMatchObject({ status: ASSET_SYNC_STATUS.IDLE, failed: 0 });
  });

  test("the loser's bytes never overwrite the winner's object", async () => {
    await createAsset({ id: "race-bytes", body: "mine" });
    otherClientWins({ data: testBlob("theirs", "image/png") });

    await makeEngine().flush();

    // Same identity (size and type match), different bytes: the winner's.
    const blob = await assetStore.downloadAsset(WS_A, "race-bytes");
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(Buffer.from(reader.result).toString("utf8"));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    expect(text).toBe("theirs");
    expect(assetStore.calls.uploads).toEqual([]);
  });

  test("a race whose winner is a DIFFERENT asset is a permanent object conflict", async () => {
    const record = await createAsset({ id: "race-conflict" });
    otherClientWins({
      metadata: { assetId: record.id, workspaceId: WS_A, assetKind: "note-file" },
    });

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.OBJECT_CONFLICT });
    expect((await workspaceStore.readAssetDocument(WS_A, "race-conflict")).exists).toBe(false);
    expect(await getRemoteAssetEntry(WS_A, "race-conflict")).toBeNull();
    expect(await getAsset("race-conflict")).not.toBeNull();
    const entry = await getAssetUpload(WS_A, "race-conflict");
    expect(entry.lastCode).toBe(ASSET_SYNC_CODE.OBJECT_CONFLICT);
    expect(entry.attempts).toBeGreaterThanOrEqual(5);
  });

  test("a refusal with NO object on the path stays permanently unauthorized", async () => {
    await createAsset({ id: "really-denied" });
    assetStore.failNext("upload", "storage/unauthorized");

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.FAILED, code: "storage/unauthorized" });
    expect(assetStore.list(WS_A)).toEqual([]);
    expect((await workspaceStore.readAssetDocument(WS_A, "really-denied")).exists).toBe(false);
    const entry = await getAssetUpload(WS_A, "really-denied");
    expect(entry.lastCode).toBe("storage/unauthorized");
    expect(entry.attempts).toBeGreaterThanOrEqual(5);
    expect(engine.getStatus()).toMatchObject({ status: ASSET_SYNC_STATUS.FAILED, failed: 1 });
  });

  test("a failed re-read leaves the original refusal standing", async () => {
    await createAsset({ id: "reread-fails" });
    const real = assetStore.uploadAsset;
    assetStore.uploadAsset = async (wid, aid, payload, options) => {
      await assetStore.seed(wid, aid, payload, {
        contentType: options.contentType,
        metadata: options.metadata,
      });
      // The confirming read cannot be made.
      assetStore.failNext("exists", "storage/retry-limit-exceeded");
      return real(wid, aid, payload, options);
    };

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    // Nothing was learned about the path, so the refusal is NOT softened.
    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.FAILED, code: "storage/unauthorized" });
    expect((await workspaceStore.readAssetDocument(WS_A, "reread-fails")).exists).toBe(false);
  });

  test("the metadata document is written once, and a winner's document is not rewritten", async () => {
    const record = await createAsset({ id: "race-doc" });
    // The winner completed BOTH cloud steps before we lost the race.
    otherClientWins();
    workspaceStore.seed(assetDocumentPath(WS_A, record.id), { ...documentFieldsFor(record), updatedAt: nowMs() });
    const commitsBefore = workspaceStore.calls.commits.length;

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(outcomes[0].outcome).toBe(ASSET_SYNC_OUTCOME.SYNCED);
    expect(workspaceStore.calls.commits.length).toBe(commitsBefore);
    const index = workspaceStore.listWorkspaceDocs(WS_A, "assets");
    expect(Object.keys(index)).toEqual(["race-doc"]);
    expect(index["race-doc"].size).toBe(record.size);
  });

  test("a race recovery does NOT count as an attempt against the entry", async () => {
    await createAsset({ id: "race-attempts" });
    otherClientWins();
    await makeEngine().flush();
    // Settled, so there is no entry left to carry an attempt count at all.
    expect(await getAssetUpload(WS_A, "race-attempts")).toBeNull();
  });

  test("only a permission-shaped refusal triggers the re-read", async () => {
    await createAsset({ id: "not-a-race" });
    assetStore.failNext("upload", "storage/quota-exceeded");
    const engine = makeEngine();
    const before = assetStore.calls.exists;
    await engine.flush();
    // One head at step D, and no second read: a quota failure cannot be a race.
    expect(assetStore.calls.exists).toBe(before + 1);
    expect((await getAssetUpload(WS_A, "not-a-race")).lastCode).toBe("storage/quota-exceeded");
  });

  test("a transient refusal is not treated as a race either — it simply retries", async () => {
    await createAsset({ id: "transient-not-race" });
    assetStore.failNext("upload", "storage/retry-limit-exceeded");
    const engine = makeEngine();
    const before = assetStore.calls.exists;
    await engine.flush();
    expect(assetStore.calls.exists).toBe(before + 1);
    const entry = await getAssetUpload(WS_A, "transient-not-race");
    expect(entry.attempts).toBe(1);
    expect(entry.lastCode).toBe("storage/retry-limit-exceeded");
  });

  test("the race vocabulary is narrow and deliberate", () => {
    expect(CREATE_RACE_CODES).toEqual(["storage/unauthorized"]);
    expect(isPossibleCreateRace({ code: "storage/unauthorized" })).toBe(true);
    for (const code of [
      "storage/unauthenticated",
      "storage/quota-exceeded",
      "storage/invalid-argument",
      "storage/retry-limit-exceeded",
      "storage/object-not-found",
      "storage/unknown",
      "permission-denied",
    ]) {
      expect(isPossibleCreateRace({ code })).toBe(false);
    }
    expect(isPossibleCreateRace(null)).toBe(false);
    expect(isPossibleCreateRace(new Error("no code"))).toBe(false);
  });
});

/* --------------------------- metadata conflict --------------------------- */

describe("a metadata document that contradicts the local asset", () => {
  test("is never overwritten, and the failure is permanent", async () => {
    const record = await createAsset({ id: "doc-conflict" });
    const foreign = {
      ...documentFieldsFor(record),
      assetKind: "note-file",
      mimeType: "application/pdf",
      size: 999,
      updatedAt: nowMs(),
    };
    workspaceStore.seed(assetDocumentPath(WS_A, record.id), foreign);

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.METADATA_CONFLICT });
    const doc = await workspaceStore.readAssetDocument(WS_A, "doc-conflict");
    expect(doc.fields.size).toBe(999);
    expect(doc.fields.assetKind).toBe("note-file");
    expect(await getRemoteAssetEntry(WS_A, "doc-conflict")).toBeNull();
    expect(await getAssetUpload(WS_A, "doc-conflict")).not.toBeNull();
  });

  test("a malformed cloud record is reported and never overwritten", async () => {
    const record = await createAsset({ id: "doc-malformed" });
    workspaceStore.seed(assetDocumentPath(WS_A, record.id), { nonsense: true });

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.MALFORMED_CLOUD_RECORD);
    expect(await workspaceStore.readAssetDocument(WS_A, "doc-malformed")).toMatchObject({
      fields: { nonsense: true },
    });
  });

  test("a name or creation time that drifted is NOT a conflict", async () => {
    const record = await createAsset({ id: "doc-drift" });
    workspaceStore.seed(assetDocumentPath(WS_A, record.id), {
      ...documentFieldsFor(record, { name: "renamed-on-another-device.png", createdAt: 12345 }),
      updatedAt: nowMs(),
    });

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(outcomes[0].outcome).toBe(ASSET_SYNC_OUTCOME.SYNCED);
    const doc = await workspaceStore.readAssetDocument(WS_A, "doc-drift");
    expect(doc.fields.name).toBe("renamed-on-another-device.png");
  });
});

/* ------------------------- partial cloud completion ---------------------- */

describe("Storage succeeded and Firestore did not", () => {
  test("the retry does not overwrite the object and completes the document", async () => {
    await createAsset({ id: "half-done" });
    workspaceStore.failNext("commit", "unavailable");

    const engine = makeEngine();
    const first = collectOutcomes(engine);
    await engine.flush();

    expect(assetStore.list(WS_A)).toEqual(["half-done"]);
    expect(first[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.QUEUED, code: "unavailable" });
    expect((await workspaceStore.readAssetDocument(WS_A, "half-done")).exists).toBe(false);
    expect(await getAssetUpload(WS_A, "half-done")).not.toBeNull();

    skew += 60_000;
    const second = makeEngine();
    const outcomes = collectOutcomes(second);
    await second.flush();

    expect(assetStore.calls.uploads).toHaveLength(1); // never uploaded twice
    expect(outcomes[0].outcome).toBe(ASSET_SYNC_OUTCOME.SYNCED);
    expect((await workspaceStore.readAssetDocument(WS_A, "half-done")).exists).toBe(true);
    expect(await getAssetUpload(WS_A, "half-done")).toBeNull();
  });
});

/* ------------------------------- atomicity ------------------------------- */

describe("the local settlement", () => {
  test("writes the index and removes the queue entry together", async () => {
    await createAsset({ id: "atomic-ok" });
    await makeEngine().flush();
    expect(await getRemoteAssetEntry(WS_A, "atomic-ok")).not.toBeNull();
    expect(await getAssetUpload(WS_A, "atomic-ok")).toBeNull();
  });

  test("leaves NEITHER behind when it cannot be written", async () => {
    await createAsset({ id: "atomic-fail" });
    const engine = makeEngine({
      local: {
        ...defaultAssetUploadLocal,
        reconcilePdfSources: async () => ({ enqueued: [], settled: [] }),
        settleStored: async () => {
          throw Object.assign(new Error("local storage refused"), { code: "unknown" });
        },
      },
    });
    await engine.flush();
    // The cloud has it; this browser does not yet know. That is the ONE
    // recoverable direction, and the next drain settles it.
    expect(await getRemoteAssetEntry(WS_A, "atomic-fail")).toBeNull();
    expect(await getAssetUpload(WS_A, "atomic-fail")).not.toBeNull();

    skew += 60_000;
    await makeEngine().flush();
    expect((await getRemoteAssetEntry(WS_A, "atomic-fail")).state).toBe(REMOTE_ASSET_STATE.STORED);
    expect(await getAssetUpload(WS_A, "atomic-fail")).toBeNull();
  });
});

/* -------------------------------- progress ------------------------------- */

describe("progress", () => {
  test("reports the real bytes the store transferred", async () => {
    const record = await createAsset({ id: "progress-one", body: "0123456789" });
    const engine = makeEngine();
    const seen = [];
    engine.subscribe((event) => {
      if (event.type === "status" && event.status === ASSET_SYNC_STATUS.UPLOADING) {
        seen.push({ total: event.bytesTotal, done: event.bytesDone, active: event.active });
      }
    });
    await engine.flush();
    const withBytes = seen.filter((s) => s.done > 0);
    expect(withBytes.length).toBeGreaterThan(0);
    for (const s of withBytes) {
      expect(s.done).toBeLessThanOrEqual(s.total);
      expect(s.total).toBe(record.size);
      expect(s.done).toBe(record.size);
    }
  });

  test("aggregates several files rather than reporting one", async () => {
    await createAsset({ id: "agg-1", body: "aaaa" });
    await createAsset({ id: "agg-2", body: "bbbbbbbb" });
    const engine = makeEngine({ concurrency: 2 });
    let maxTotal = 0;
    engine.subscribe((event) => {
      if (event.type === "status") maxTotal = Math.max(maxTotal, Number(event.bytesTotal) || 0);
    });
    await engine.flush();
    expect(maxTotal).toBe(12);
  });

  test("never reports more done than total, and invents nothing for a tiny file", async () => {
    await createAsset({ id: "tiny", body: "x" });
    const engine = makeEngine();
    const samples = [];
    engine.subscribe((event) => {
      if (event.type === "status") samples.push([event.bytesDone, event.bytesTotal]);
    });
    await engine.flush();
    for (const [done, total] of samples) expect(done).toBeLessThanOrEqual(total);
    // No fractional or interpolated value ever appears.
    for (const [done] of samples) expect(Number.isInteger(done)).toBe(true);
  });

  test("resets to nothing once the queue is empty", async () => {
    await createAsset({ id: "reset-progress" });
    const engine = makeEngine();
    await engine.flush();
    expect(engine.getStatus()).toMatchObject({ bytesTotal: 0, bytesDone: 0, active: 0, pending: 0 });
  });
});

/* --------------------------- failure and retry --------------------------- */

describe("retry", () => {
  test("a transient failure keeps the entry and schedules a backoff", async () => {
    await createAsset({ id: "transient" });
    assetStore.failNext("upload", "storage/retry-limit-exceeded");

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.QUEUED, code: "storage/retry-limit-exceeded" });
    const entry = await getAssetUpload(WS_A, "transient");
    expect(entry.attempts).toBe(1);
    expect(entry.nextAttemptAt).toBeGreaterThan(nowMs());
    expect(engine.getStatus().status).toBe(ASSET_SYNC_STATUS.WAITING);
    expect(timers.length).toBeGreaterThan(0);
  });

  test("offline waits: nothing is attempted and the entry is untouched", async () => {
    await createAsset({ id: "offline-one" });
    online = false;

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(assetStore.calls.uploads).toEqual([]);
    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.QUEUED, code: ASSET_SYNC_CODE.OFFLINE });
    expect(engine.getStatus().status).toBe(ASSET_SYNC_STATUS.OFFLINE);
    const entry = await getAssetUpload(WS_A, "offline-one");
    expect(entry.attempts).toBe(0);

    online = true;
    await engine.flush();
    expect(assetStore.list(WS_A)).toEqual(["offline-one"]);
  });

  test("an entry inside its backoff window is not attempted again", async () => {
    await createAsset({ id: "waiting" });
    assetStore.failNext("upload", "storage/retry-limit-exceeded");
    const engine = makeEngine();
    await engine.flush();
    const uploads = assetStore.calls.uploads.length;

    await engine.flush(); // still inside the backoff
    expect(assetStore.calls.uploads.length).toBe(uploads);
    expect(engine.getStatus().status).toBe(ASSET_SYNC_STATUS.WAITING);
  });

  test("a permanent failure exhausts the budget in one attempt — no hot loop", async () => {
    await createAsset({ id: "denied" });
    assetStore.failNext("upload", "storage/unauthorized");

    const engine = makeEngine();
    await engine.flush();
    const entry = await getAssetUpload(WS_A, "denied");
    expect(entry.attempts).toBeGreaterThanOrEqual(5);
    expect(entry.lastCode).toBe("storage/unauthorized");
    expect(engine.getStatus()).toMatchObject({ status: ASSET_SYNC_STATUS.FAILED, failed: 1 });

    const before = assetStore.calls.uploads.length;
    await engine.flush();
    await engine.flush();
    expect(assetStore.calls.uploads.length).toBe(before);
  });

  test("repeated transient failures pause automatic retries at the threshold", async () => {
    await createAsset({ id: "gives-up" });
    const engine = makeEngine({ maxAutoAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      assetStore.failNext("upload", "storage/retry-limit-exceeded");
      skew += 10 * 60 * 1000;
      await engine.flush();
    }
    expect((await getAssetUpload(WS_A, "gives-up")).attempts).toBe(3);
    expect(engine.getStatus()).toMatchObject({ status: ASSET_SYNC_STATUS.FAILED, failed: 1 });

    const before = assetStore.calls.uploads.length;
    skew += 10 * 60 * 1000;
    await engine.flush();
    expect(assetStore.calls.uploads.length).toBe(before);
  });

  test("Retry Now resets the gate and processes only this workspace", async () => {
    await createAsset({ id: "retry-me" });
    await createAsset({ id: "other-ws", workspaceId: WS_B });
    assetStore.failNext("upload", "storage/unauthorized");
    const engine = makeEngine();
    await engine.flush();
    expect(engine.getStatus().failed).toBe(1);

    await engine.retryNow();

    expect(assetStore.list(WS_A)).toEqual(["retry-me"]);
    expect(assetStore.list(WS_B)).toEqual([]);
    expect(await getAssetUpload(WS_A, "retry-me")).toBeNull();
    expect(await getAssetUpload(WS_B, "other-ws")).not.toBeNull();
    expect(engine.getStatus().status).toBe(ASSET_SYNC_STATUS.IDLE);
  });

  test("Retry Now alters neither the bytes nor the asset identity", async () => {
    const record = await createAsset({ id: "retry-identity" });
    assetStore.failNext("upload", "storage/unauthorized");
    const engine = makeEngine();
    await engine.flush();
    await engine.retryNow();
    const head = await assetStore.objectMetadata(WS_A, "retry-identity");
    expect(head.size).toBe(record.size);
    expect(head.contentType).toBe(record.mimeType);
    expect(head.metadata).toEqual({ assetId: record.id, workspaceId: WS_A, assetKind: record.kind });
    const local = await getAsset("retry-identity");
    expect(local.size).toBe(record.size);
  });

  test("the online event drains what is waiting", async () => {
    await createAsset({ id: "back-online" });
    online = false;
    const engine = makeEngine();
    engine.start();
    await Promise.resolve();
    await engine.flush();
    expect(assetStore.list(WS_A)).toEqual([]);

    online = true;
    expect(onlineListeners).toHaveLength(1);
    onlineListeners[0]();
    await engine.flush();
    expect(assetStore.list(WS_A)).toEqual(["back-online"]);
    engine.stop();
  });
});

describe("what the user is told", () => {
  test("the provider's own error text is never exposed", async () => {
    await createAsset({ id: "raw-error" });
    assetStore.failNext("upload", "storage/unauthorized");
    const engine = makeEngine();
    await engine.flush();
    const { error } = engine.getStatus();
    const message = assetSyncFailureMessage(error);
    expect(message).not.toMatch(/storage\//);
    expect(message).not.toMatch(/firebase/i);
    expect(message).toMatch(/not allowed to store files/i);
  });

  test("an unknown code still produces a sentence", () => {
    expect(assetSyncFailureMessage("something-nobody-mapped")).toMatch(/stay on this device/i);
  });

  test("classifies transient and permanent failures apart", () => {
    expect(classifyAssetUploadError({ code: "storage/retry-limit-exceeded" }).outcome).toBe(ASSET_SYNC_OUTCOME.QUEUED);
    expect(classifyAssetUploadError({ code: "unavailable" }).outcome).toBe(ASSET_SYNC_OUTCOME.QUEUED);
    expect(classifyAssetUploadError(Object.assign(new TypeError("failed to fetch"))).outcome).toBe(
      ASSET_SYNC_OUTCOME.QUEUED
    );
    expect(classifyAssetUploadError({ code: "storage/unauthorized" }).outcome).toBe(ASSET_SYNC_OUTCOME.FAILED);
    expect(classifyAssetUploadError({ code: "permission-denied" }).outcome).toBe(ASSET_SYNC_OUTCOME.FAILED);
    expect(classifyAssetUploadError({ code: "storage/quota-exceeded" }).outcome).toBe(ASSET_SYNC_OUTCOME.FAILED);
  });
});

/* ------------------------------ local records ---------------------------- */

describe("local records the cloud cannot take", () => {
  test("a missing local asset is an actionable failure, not a retry loop", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "ghost", kind: "editor-image" });
    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();
    expect(outcomes[0]).toMatchObject({ code: ASSET_SYNC_CODE.LOCAL_ASSET_MISSING });
    const entry = await getAssetUpload(WS_A, "ghost");
    expect(entry.attempts).toBeGreaterThanOrEqual(5);
  });

  test("an unmappable type stays local and reports why", async () => {
    const record = makeAssetRecord({
      id: "weird-file",
      kind: "editor-file",
      name: "backup.zip",
      blob: testBlob("PK", "application/zip"),
      workspaceId: WS_A,
    });
    await saveNewAsset(record);

    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();

    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.UNSUPPORTED_MIME });
    expect(assetStore.list(WS_A)).toEqual([]);
    expect(await getAsset("weird-file")).not.toBeNull();
  });

  test("a legacy record with no MIME type but an accepted extension uploads", async () => {
    const record = makeAssetRecord({
      id: "legacy-doc",
      kind: "note-file",
      name: "specification.docx",
      blob: testBlob("body", ""),
      workspaceId: WS_A,
    });
    await saveNewAsset(record);

    await makeEngine().flush();

    const head = await assetStore.objectMetadata(WS_A, "legacy-doc");
    expect(head.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    const doc = await workspaceStore.readAssetDocument(WS_A, "legacy-doc");
    expect(doc.fields.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  test("a record of an unknown kind is refused", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "odd-kind", kind: "mystery" });
    const record = makeAssetRecord({
      id: "odd-kind",
      kind: "mystery",
      name: "x.png",
      blob: testBlob("x", "image/png"),
      workspaceId: WS_A,
    });
    await saveNewAsset(record);
    const engine = makeEngine();
    const outcomes = collectOutcomes(engine);
    await engine.flush();
    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.MALFORMED_LOCAL_RECORD);
  });
});

/* ---------------------------- unconfigured build ------------------------- */

describe("with no Storage bucket", () => {
  test("reports `unconfigured`, uploads nothing and keeps the queue", async () => {
    await createAsset({ id: "no-bucket" });
    const engine = createAssetUploadSync({
      workspaceId: WS_A,
      assetStore: null,
      workspaceStore,
      now: nowMs,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
      addOnlineListener: () => () => {},
    });
    engine.start();
    await engine.flush();

    expect(engine.configured).toBe(false);
    expect(engine.getStatus().status).toBe(ASSET_SYNC_STATUS.UNCONFIGURED);
    expect(assetStore.list(WS_A)).toEqual([]);
    expect(await getAssetUpload(WS_A, "no-bucket")).not.toBeNull();
    expect(await getAsset("no-bucket")).not.toBeNull();
    engine.stop();
  });

  test("never claims an asset is in the account", async () => {
    await createAsset({ id: "no-bucket-2" });
    const engine = createAssetUploadSync({ workspaceId: WS_A, assetStore: null, workspaceStore });
    await engine.flush();
    expect(await getRemoteAssetEntry(WS_A, "no-bucket-2")).toBeNull();
    engine.stop();
  });
});

/* -------------------------------- sign-out ------------------------------- */

describe("sign-out", () => {
  test("a completed upload finishes and nothing is left to say", async () => {
    await createAsset({ id: "signout-done" });
    const engine = makeEngine();
    const summary = await engine.drainForSignOut({ timeoutMs: 1000 });
    expect(summary).toEqual({ workspaceId: WS_A, remaining: 0, message: null });
    expect(assetStore.list(WS_A)).toEqual(["signout-done"]);
  });

  test("a timeout leaves the queue AND the local bytes intact, and says so", async () => {
    await createAsset({ id: "signout-slow-1" });
    await createAsset({ id: "signout-slow-2" });
    // The drain never resolves within the deadline.
    const engine = makeEngine({
      local: {
        ...defaultAssetUploadLocal,
        reconcilePdfSources: async () => ({ enqueued: [], settled: [] }),
        readAsset: () => new Promise(() => {}),
      },
      setTimer: (fn) => {
        const id = setTimeout(fn, 0);
        return id;
      },
      clearTimer: (t) => clearTimeout(t),
    });

    const summary = await engine.drainForSignOut({ timeoutMs: 0 });

    expect(summary.remaining).toBe(2);
    expect(summary.message).toBe("2 files will finish uploading next time you sign in on this device.");
    expect(await getAssetUpload(WS_A, "signout-slow-1")).not.toBeNull();
    expect(await getAsset("signout-slow-1")).not.toBeNull();
    engine.stop();
  });

  test("the next session of the same workspace resumes what was left", async () => {
    await createAsset({ id: "resumed" });
    online = false;
    const first = makeEngine();
    await first.drainForSignOut({ timeoutMs: 0 });
    first.stop();
    expect(await getAssetUpload(WS_A, "resumed")).not.toBeNull();

    online = true;
    const second = makeEngine();
    await second.flush();
    expect(assetStore.list(WS_A)).toEqual(["resumed"]);
    second.stop();
  });

  test("a different account's session never drains it", async () => {
    await createAsset({ id: "mine", workspaceId: WS_A });
    // Another account signs in on this browser: a different uid, a different
    // workspace, and no membership of WS_A.
    const otherStore = createMemoryWorkspaceStore({ now: nowMs });
    otherStore.setUser(OTHER_UID);
    seedWorkspace(otherStore, WS_B, OTHER_UID);
    const otherAssets = createMemoryAssetStore({ workspaceStore: otherStore, now: nowMs });
    const engine = createAssetUploadSync({
      workspaceId: WS_B,
      assetStore: otherAssets,
      workspaceStore: otherStore,
      now: nowMs,
      isOnline: () => true,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
      addOnlineListener: () => () => {},
      local: {
        ...defaultAssetUploadLocal,
        reconcilePdfSources: async () => ({ enqueued: [], settled: [] }),
      },
    });
    await engine.flush();
    expect(otherAssets.list(WS_A)).toEqual([]);
    expect(otherAssets.list(WS_B)).toEqual([]);
    expect(await getAssetUpload(WS_A, "mine")).not.toBeNull();
    engine.stop();
  });

  test("the sentence is singular for one file", () => {
    expect(signOutMessage(1)).toBe("1 file will finish uploading next time you sign in on this device.");
    expect(signOutMessage(0)).toBeNull();
  });
});

/* --------------------------------- status -------------------------------- */

describe("status", () => {
  test("counts what is pending, what needs attention and what is active", async () => {
    await createAsset({ id: "count-ok" });
    await createAsset({ id: "count-bad" });
    const engine = makeEngine({ concurrency: 1 });
    const real = assetStore.uploadAsset;
    assetStore.uploadAsset = async (workspaceId, assetId, ...rest) => {
      if (assetId === "count-bad") throw Object.assign(new Error("nope"), { code: "storage/unauthorized" });
      return real(workspaceId, assetId, ...rest);
    };
    await engine.flush();
    expect(engine.getStatus()).toMatchObject({
      status: ASSET_SYNC_STATUS.FAILED,
      pending: 1,
      failed: 1,
      active: 0,
    });
  });

  test("an empty queue is idle with nothing pending", async () => {
    const engine = makeEngine();
    await engine.flush();
    expect(engine.getStatus()).toMatchObject({ status: ASSET_SYNC_STATUS.IDLE, pending: 0, failed: 0 });
  });

  test("a listener that throws never breaks the engine", async () => {
    await createAsset({ id: "bad-listener" });
    const engine = makeEngine();
    engine.subscribe(() => {
      throw new Error("listener exploded");
    });
    await engine.flush();
    expect(assetStore.list(WS_A)).toEqual(["bad-listener"]);
  });

  test("unsubscribing stops delivery", async () => {
    await createAsset({ id: "unsub" });
    const engine = makeEngine();
    const seen = [];
    const off = engine.subscribe((event) => seen.push(event.type));
    off();
    await engine.flush();
    expect(seen).toEqual([]);
  });
});

/* --------------------------- PDF source obsolescence --------------------- */

describe("a queued PDF source whose file is gone", () => {
  test("is settled quietly when no current document names it", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "old-source", kind: "pdf-source" });
    const engine = makeEngine({ local: { currentPdfSources: () => ["a-different-source"] } });
    const outcomes = collectOutcomes(engine);
    await engine.flush();
    expect(outcomes[0]).toMatchObject({ outcome: ASSET_SYNC_OUTCOME.SYNCED, obsolete: true });
    expect(await getAssetUpload(WS_A, "old-source")).toBeNull();
    expect(await getRemoteAssetEntry(WS_A, "old-source")).toBeNull();
    expect(assetStore.list(WS_A)).toEqual([]);
  });

  test("is an actionable failure when a current document DOES name it", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "live-source", kind: "pdf-source" });
    const engine = makeEngine({ local: { currentPdfSources: () => ["live-source"] } });
    const outcomes = collectOutcomes(engine);
    await engine.flush();
    expect(outcomes[0].code).toBe(ASSET_SYNC_CODE.LOCAL_ASSET_MISSING);
  });
});
