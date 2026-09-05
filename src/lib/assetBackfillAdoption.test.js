// src/lib/assetBackfillAdoption.test.js
//
// THE WRITE HALF of the legacy asset backfill (Production Readiness Phase
// 7.6), against a REAL IndexedDB (fake-indexeddb).
//
// The invariant the adoption transaction exists for, in both directions:
//
//   committed   the asset names this workspace AND its upload identity exists
//               (unless the account already holds it)
//   refused     NEITHER — the asset is still unscoped and nothing is queued
//
// Plus the two races a shared browser actually produces: the same workspace
// adopting twice (idempotent), and a DIFFERENT workspace having got there
// first (a refusal that overwrites nothing).

import "fake-indexeddb/auto";
import {
  ASSET_DB_NAME,
  ASSET_DB_VERSION,
  ASSET_REMOTE_INDEX_STORE,
  ASSET_STORE,
  ASSET_UPLOAD_QUEUE_STORE,
  assetDbTransaction,
  resetAssetDbConnection,
} from "./assetDb";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "./assetDbTestHarness";
import {
  ADOPTION_RESULT,
  BACKFILL_CONFLICT,
  adoptLegacyAssetIntoWorkspace,
  planAssetBackfill,
  runAssetBackfill,
} from "./assetBackfill";
import { getAsset, makeAssetRecord, saveAsset, saveNewAsset } from "./assetStorage";
import { getAssetUpload, listPendingAssetUploads } from "./assetUploadQueue";
import { REMOTE_ASSET_STATE, getRemoteAssetEntry, makeRemoteAssetEntry, putRemoteAssetEntry } from "./assetRemoteIndex";
import { buildAssetDocument, tombstoneAssetDocument } from "./cloud/assetCloudModel";
import { LOCAL_MIGRATION_STATUS } from "./cloud/localMigration";
import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  __resetDurableStorageForTests,
  scopedStorageKey,
} from "./durableStorage";

installStructuredCloneShim();

const WS = "ws-11111111-1111-4111-8111-111111111111";
const OTHER_WS = "ws-22222222-2222-4222-8222-222222222222";
const UID = "uid-a";
const SCOPE = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS };
const MIGRATED_HERE = { status: LOCAL_MIGRATION_STATUS.COMPLETED, workspaceId: WS };

function seedScope(records, scope = SCOPE) {
  for (const [key, value] of Object.entries(records)) {
    window.localStorage.setItem(scopedStorageKey(key, scope), JSON.stringify(value));
  }
}

/** A pre-Phase-7.2 record: no `workspaceId` field at all. */
async function seedLegacyAsset(id, { kind = "editor-image", text = "bytes", metadata } = {}) {
  const record = makeAssetRecord({ id, kind, name: `${id}.png`, blob: testBlob(text), metadata });
  delete record.workspaceId;
  await saveAsset(record);
  return record;
}

async function seedOwnedAsset(id, workspaceId, { kind = "editor-image", text = "bytes" } = {}) {
  await saveNewAsset(
    makeAssetRecord({ id, kind, name: `${id}.png`, blob: testBlob(text), workspaceId })
  );
}

/** `cloud` = the workspace's CURRENT documents, `wid|assetId` → `{ exists, fields }`; omitted = no boundary (unknown). */
const backfillDeps = ({
  reconcile = async () => ({ enqueued: [], settled: [] }),
  migration = MIGRATED_HERE,
  binding = null,
  cloud = null,
} = {}) => ({
  reconcilePdfSources: reconcile,
  readMigrationState: () => migration,
  readBinding: () => binding,
  localAssetSize: async () => 0,
  readCloudAssetDocument:
    cloud === null ? null : async (workspaceId, assetId) => cloud[`${workspaceId}|${assetId}`] || { exists: false, fields: null },
});

function storedDoc(id, { kind = "editor-image", mimeType = "image/png", size = 5 } = {}) {
  const built = buildAssetDocument({ workspaceId: WS, id, assetKind: kind, name: `${id}.png`, mimeType, size, createdAt: 1000 });
  if (!built.ok) throw new Error(`fixture does not validate: ${built.reason}`);
  return { exists: true, fields: built.fields };
}

async function blobText(blob) {
  if (typeof blob.text === "function") return blob.text();
  return Buffer.from(await blob.arrayBuffer()).toString("utf8");
}

beforeEach(async () => {
  await deleteAssetDb();
  window.localStorage.clear();
  __resetDurableStorageForTests();
});
afterEach(() => {
  __resetDurableStorageForTests();
  window.localStorage.clear();
});

/* ------------------------------- adoption -------------------------------- */

describe("adoptLegacyAssetIntoWorkspace", () => {
  test("a legacy record gains the workspace and its queue identity, atomically, with byte-identical bytes and the same id", async () => {
    await seedLegacyAsset("a-1", { text: "the original bytes" });
    const before = await getAsset("a-1");

    const outcome = await adoptLegacyAssetIntoWorkspace("a-1", WS);
    expect(outcome).toMatchObject({ status: ADOPTION_RESULT.ADOPTED, assetId: "a-1", workspaceId: WS, queued: true });

    const after = await getAsset("a-1");
    expect(after.id).toBe("a-1");
    expect(after.workspaceId).toBe(WS);
    expect(after.kind).toBe(before.kind);
    expect(after.size).toBe(before.size);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(await blobText(after.blob)).toBe("the original bytes");

    const entry = await getAssetUpload(WS, "a-1");
    expect(entry).toMatchObject({ workspaceId: WS, assetId: "a-1", kind: "editor-image", attempts: 0 });
  });

  test("running it twice for the SAME workspace is idempotent — no rewrite, no second queue entry", async () => {
    await seedLegacyAsset("a-2");
    const first = await adoptLegacyAssetIntoWorkspace("a-2", WS);
    const stamped = await getAssetUpload(WS, "a-2");
    const second = await adoptLegacyAssetIntoWorkspace("a-2", WS, { at: (stamped.at || 0) + 5000 });

    expect(first.status).toBe(ADOPTION_RESULT.ADOPTED);
    expect(second).toMatchObject({ status: ADOPTION_RESULT.ALREADY_OWNED, queued: true });
    expect(await getAssetUpload(WS, "a-2")).toEqual(stamped);
    expect((await listPendingAssetUploads(WS)).length).toBe(1);
  });

  test("an asset another workspace adopted first is a refusal that changes nothing", async () => {
    await seedOwnedAsset("a-3", OTHER_WS);
    const outcome = await adoptLegacyAssetIntoWorkspace("a-3", WS);
    expect(outcome).toMatchObject({
      status: ADOPTION_RESULT.FOREIGN_WORKSPACE,
      owner: OTHER_WS,
      queued: false,
    });
    expect((await getAsset("a-3")).workspaceId).toBe(OTHER_WS);
    expect(await getAssetUpload(WS, "a-3")).toBeNull();
    expect(await getAssetUpload(OTHER_WS, "a-3")).not.toBeNull();
  });

  test("an asset that is no longer here adopts nothing and queues nothing", async () => {
    const outcome = await adoptLegacyAssetIntoWorkspace("never-existed", WS);
    expect(outcome.status).toBe(ADOPTION_RESULT.MISSING);
    expect(await getAssetUpload(WS, "never-existed")).toBeNull();
  });

  test("the caller's authoritative decision is honoured: `queue: false` adopts WITHOUT a queue identity", async () => {
    await seedLegacyAsset("a-4");
    const outcome = await adoptLegacyAssetIntoWorkspace("a-4", WS, { queue: false });
    expect(outcome).toMatchObject({ status: ADOPTION_RESULT.ADOPTED, queued: false, created: false });
    expect((await getAsset("a-4")).workspaceId).toBe(WS);
    expect(await getAssetUpload(WS, "a-4")).toBeNull();
  });

  test("the transaction consults NO cache of its own: a remote-index entry saying stored does not suppress the queue", async () => {
    await seedLegacyAsset("a-5");
    await putRemoteAssetEntry(
      makeRemoteAssetEntry({ workspaceId: WS, assetId: "a-5", kind: "editor-image", state: REMOTE_ASSET_STATE.STORED })
    );
    // Default (no decision passed) is the conservative answer.
    const outcome = await adoptLegacyAssetIntoWorkspace("a-5", WS);
    expect(outcome).toMatchObject({ status: ADOPTION_RESULT.ADOPTED, queued: true, created: true });
    expect(await getAssetUpload(WS, "a-5")).not.toBeNull();
    // …and the index entry itself is untouched (it is the engine's to settle).
    expect((await getRemoteAssetEntry(WS, "a-5")).state).toBe(REMOTE_ASSET_STATE.STORED);
  });

  test("`queue: false` never REMOVES an identity that already exists", async () => {
    await seedLegacyAsset("a-5b");
    await adoptLegacyAssetIntoWorkspace("a-5b", WS);
    const outcome = await adoptLegacyAssetIntoWorkspace("a-5b", WS, { queue: false });
    expect(outcome).toMatchObject({ status: ADOPTION_RESULT.ALREADY_OWNED, queued: true, created: false });
    expect(await getAssetUpload(WS, "a-5b")).not.toBeNull();
  });

  test("a refused transaction leaves the asset UNSCOPED and nothing queued", async () => {
    // A browser whose asset database predates the queue store: the ONE
    // transaction the adoption needs cannot even open, so neither half of the
    // pair can land. (The general roll-back of a half-completed multi-store
    // write is pinned in src/lib/assetWorkspaceCreation.test.js — it is the
    // same shared helper, src/lib/assetDb.js.)
    await deleteAssetDb();
    const legacyDb = await new Promise((resolve, reject) => {
      const req = indexedDB.open(ASSET_DB_NAME, ASSET_DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(ASSET_STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = legacyDb.transaction(ASSET_STORE, "readwrite");
      tx.objectStore(ASSET_STORE).put({ id: "a-6", kind: "editor-image", size: 5, blob: testBlob("bytes") });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    legacyDb.close();
    resetAssetDbConnection();

    await expect(adoptLegacyAssetIntoWorkspace("a-6", WS)).rejects.toThrow(/store/);
    const record = await getAsset("a-6");
    expect(record.workspaceId === undefined || record.workspaceId === null).toBe(true);
  });

  test("an invalid workspace id or asset id writes nothing", async () => {
    await seedLegacyAsset("a-7");
    expect((await adoptLegacyAssetIntoWorkspace("a-7", "not a workspace/id")).status).toBe(ADOPTION_RESULT.MISSING);
    const record = await getAsset("a-7");
    expect(record.workspaceId === undefined || record.workspaceId === null).toBe(true);
  });
});

/* -------------------------------- running -------------------------------- */

describe("runAssetBackfill", () => {
  test("it adopts exactly what this workspace's references name and leaves every other blob alone", async () => {
    seedScope({
      [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-image"><a data-file-asset-id="ref-file"></a>' },
      [DURABLE_KEYS.templateVersions]: { v1: { logoAssetId: "ref-logo" } },
    });
    await seedLegacyAsset("ref-image", { kind: "editor-image" });
    await seedLegacyAsset("ref-file", { kind: "editor-file" });
    await seedLegacyAsset("ref-logo", { kind: "logo" });
    await seedLegacyAsset("orphan", { kind: "editor-image" });

    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });
    expect(result.adopted.sort()).toEqual(["ref-file", "ref-image", "ref-logo"]);
    expect(result.queued.sort()).toEqual(["ref-file", "ref-image", "ref-logo"]);

    const orphan = await getAsset("orphan");
    expect(orphan.workspaceId === undefined || orphan.workspaceId === null).toBe(true);
    expect((await listPendingAssetUploads(WS)).map((e) => e.assetId).sort()).toEqual([
      "ref-file",
      "ref-image",
      "ref-logo",
    ]);
  });

  test("a second run converges: nothing is adopted twice and no duplicate queue entry appears", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-1">' } });
    await seedLegacyAsset("ref-1");
    const first = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });
    const second = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });

    expect(first.adopted).toEqual(["ref-1"]);
    expect(second.adopted).toEqual([]);
    // Revisited (an owned record is re-checked every pass), but nothing
    // rewritten and no second identity created.
    expect(second.alreadyOwned).toEqual(["ref-1"]);
    expect(second.queued).toEqual([]);
    expect((await listPendingAssetUploads(WS)).length).toBe(1);
  });

  test("a run interrupted halfway is repaired by the next one", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-a"><img data-asset-id="ref-b">' } });
    await seedLegacyAsset("ref-a");
    await seedLegacyAsset("ref-b");

    let adopted = 0;
    const counting = {
      ...backfillDeps(),
      adopt: async (assetId, workspaceId, options) => {
        adopted += 1;
        return adoptLegacyAssetIntoWorkspace(assetId, workspaceId, options);
      },
    };
    const halfway = await runAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: counting,
      isActive: () => adopted < 1,
    });
    expect(halfway.stopped).toBe(true);
    expect(halfway.adopted.length).toBe(1);

    const resumed = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });
    expect([...halfway.adopted, ...resumed.adopted].sort()).toEqual(["ref-a", "ref-b"]);
    expect((await listPendingAssetUploads(WS)).length).toBe(2);
  });

  test("a session that ended before the pass started adopts nothing", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-1">' } });
    await seedLegacyAsset("ref-1");
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps(), isActive: () => false });
    expect(result.stopped).toBe(true);
    expect(result.adopted).toEqual([]);
    const record = await getAsset("ref-1");
    expect(record.workspaceId === undefined || record.workspaceId === null).toBe(true);
  });

  test("a workspace's references never reach a SUCCESSOR workspace's assets", async () => {
    // The same reference set, read in the other workspace's scope: it holds
    // nothing, so nothing is adopted into it.
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-1">' } });
    await seedLegacyAsset("ref-1");
    const other = await runAssetBackfill({
      workspaceId: OTHER_WS,
      uid: "uid-b",
      deps: backfillDeps({ migration: { status: LOCAL_MIGRATION_STATUS.COMPLETED, workspaceId: OTHER_WS } }),
    });
    expect(other.adopted).toEqual([]);
    const record = await getAsset("ref-1");
    expect(record.workspaceId === undefined || record.workspaceId === null).toBe(true);
  });

  test("an ambiguous browser history refuses adoption and reports it; nothing is mutated", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-1">' } });
    await seedLegacyAsset("ref-1");
    const result = await runAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: backfillDeps({
        migration: { status: LOCAL_MIGRATION_STATUS.NOT_STARTED, workspaceId: null },
        binding: { uids: [UID, "uid-b"] },
      }),
    });
    expect(result.adopted).toEqual([]);
    expect(result.refused).toEqual([{ assetId: "ref-1", reason: BACKFILL_CONFLICT.AMBIGUOUS_BINDING }]);
    const record = await getAsset("ref-1");
    expect(record.workspaceId === undefined || record.workspaceId === null).toBe(true);
    expect(await getAssetUpload(WS, "ref-1")).toBeNull();
  });

  test("a confirmed structured migration into THIS workspace allows the same references to be adopted", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-1">' } });
    await seedLegacyAsset("ref-1");
    const result = await runAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: backfillDeps({ migration: MIGRATED_HERE, binding: { uids: [UID, "uid-b"] } }),
    });
    expect(result.adopted).toEqual(["ref-1"]);
  });

  test("an asset owned by another workspace is reported as a conflict and never touched", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="theirs">' } });
    await seedOwnedAsset("theirs", OTHER_WS);
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });
    expect(result.conflicts).toEqual([
      { assetId: "theirs", reason: BACKFILL_CONFLICT.FOREIGN_WORKSPACE, owner: OTHER_WS },
    ]);
    expect((await getAsset("theirs")).workspaceId).toBe(OTHER_WS);
  });

  test("an owned asset whose queue identity was lost is re-queued without being rewritten", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="mine">' } });
    await seedOwnedAsset("mine", WS);
    // Simulate the lost identity: the record stands, its queue row does not.
    await assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readwrite", (stores) =>
      stores[ASSET_UPLOAD_QUEUE_STORE].delete([WS, "mine"])
    );
    const before = await getAsset("mine");

    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });
    expect(result.alreadyOwned).toEqual(["mine"]);
    expect(result.queued).toEqual(["mine"]);
    const after = await getAsset("mine");
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.createdAt).toBe(before.createdAt);
  });

  test("the account's own copy — per its CURRENT document — is not queued again, and the plan says so", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="already">' } });
    await seedLegacyAsset("already");
    const d = backfillDeps({ cloud: { [`${WS}|already`]: storedDoc("already") } });
    const plan = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: d });
    expect(plan.general.stored).toEqual(["already"]);
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, plan, deps: d });
    expect(result.adopted).toEqual(["already"]);
    expect(result.queued).toEqual([]);
    expect(await listPendingAssetUploads(WS)).toEqual([]);
  });

  test("a stale remote index saying stored does not stop a queue identity when the document is absent (real stores)", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="stale">' } });
    await seedLegacyAsset("stale");
    await putRemoteAssetEntry(
      makeRemoteAssetEntry({ workspaceId: WS, assetId: "stale", kind: "editor-image", state: REMOTE_ASSET_STATE.STORED })
    );
    const d = backfillDeps({ cloud: { [`${WS}|stale`]: { exists: false, fields: null } } });
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: d });
    expect(result.queued).toEqual(["stale"]);
    expect((await listPendingAssetUploads(WS)).map((e) => e.assetId)).toEqual(["stale"]);
  });

  test("an owned asset from an earlier pass is repaired on rerun, and a third run adds no duplicate", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="mine">' } });
    // Pass one, cloud unreachable: adopted + queued conservatively.
    await seedLegacyAsset("mine");
    await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });
    // The engine settles it (queue row gone), then the document later vanishes.
    await assetDbTransaction(ASSET_UPLOAD_QUEUE_STORE, "readwrite", (stores) =>
      stores[ASSET_UPLOAD_QUEUE_STORE].delete([WS, "mine"])
    );
    const cloud = { [`${WS}|mine`]: { exists: false, fields: null } };
    const two = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps({ cloud }) });
    expect(two.alreadyOwned).toEqual(["mine"]);
    expect(two.queued).toEqual(["mine"]);
    const three = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps({ cloud }) });
    expect(three.queued).toEqual([]);
    expect((await listPendingAssetUploads(WS)).length).toBe(1);
  });

  test("a tombstoned CURRENT document queues the asset for the engine's approved restore; a matching stored one does not", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="t"><img data-asset-id="s">' } });
    await seedLegacyAsset("t");
    await seedLegacyAsset("s");
    const cloud = {
      [`${WS}|t`]: { exists: true, fields: tombstoneAssetDocument(storedDoc("t").fields, 2000) },
      [`${WS}|s`]: storedDoc("s"),
    };
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps({ cloud }) });
    expect(result.adopted.sort()).toEqual(["s", "t"]);
    expect(result.queued).toEqual(["t"]);
  });

  test("the queue it leaves behind is exactly what the upload engine drains next", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="drain-me">' } });
    await seedLegacyAsset("drain-me");
    await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });
    const pending = await listPendingAssetUploads(WS);
    expect(pending.map((e) => ({ assetId: e.assetId, kind: e.kind, attempts: e.attempts }))).toEqual([
      { assetId: "drain-me", kind: "editor-image", attempts: 0 },
    ]);
    // and the bytes the engine will read are still here, untouched
    expect(await blobText((await getAsset("drain-me")).blob)).toBe("bytes");
  });

  test("PDF sources go through the Phase 7.4 reconciler, over the registry's CURRENT sources only", async () => {
    seedScope({ [DURABLE_KEYS.pdfDocs]: { d1: { id: "d1", sourceAssetId: "pdf-current" } } });
    const calls = [];
    const result = await runAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: backfillDeps({
        reconcile: async (workspaceId, sources) => {
          calls.push({ workspaceId, sources });
          return { enqueued: ["pdf-current"], settled: [] };
        },
      }),
    });
    expect(calls).toEqual([{ workspaceId: WS, sources: ["pdf-current"] }]);
    expect(result.pdf).toEqual({ enqueued: ["pdf-current"], settled: [] });
  });

  test("a failing PDF reconciliation is reported, not thrown, and the general adoptions still stand", async () => {
    seedScope({
      [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-1">' },
      [DURABLE_KEYS.pdfDocs]: { d1: { id: "d1", sourceAssetId: "pdf-current" } },
    });
    await seedLegacyAsset("ref-1");
    const result = await runAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: backfillDeps({
        reconcile: async () => {
          throw new Error("IndexedDB refused");
        },
      }),
    });
    expect(result.adopted).toEqual(["ref-1"]);
    expect(result.failed).toEqual([{ assetId: null, code: "pdf-reconcile" }]);
  });

  test("an adoption that throws is reported and retried by the next run", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-1">' } });
    await seedLegacyAsset("ref-1");
    let attempts = 0;
    const flaky = {
      ...backfillDeps(),
      adopt: async (assetId, workspaceId, options) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("refused"), { name: "AbortError" });
        return adoptLegacyAssetIntoWorkspace(assetId, workspaceId, options);
      },
    };
    const first = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: flaky });
    expect(first.failed).toEqual([{ assetId: "ref-1", code: "AbortError" }]);
    const record = await getAsset("ref-1");
    expect(record.workspaceId === undefined || record.workspaceId === null).toBe(true);

    const second = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: flaky });
    expect(second.adopted).toEqual(["ref-1"]);
  });

  test("it writes only the asset and queue stores, never the remote index, and removes nothing", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="ref-1">' } });
    await seedLegacyAsset("ref-1");
    await seedLegacyAsset("orphan");
    await runAssetBackfill({ workspaceId: WS, uid: UID, deps: backfillDeps() });
    const ids = await assetDbTransaction(ASSET_STORE, "readonly", (stores) => stores[ASSET_STORE].getAllKeys());
    expect([...ids].sort()).toEqual(["orphan", "ref-1"]);
    const remote = await assetDbTransaction(ASSET_REMOTE_INDEX_STORE, "readonly", (stores) =>
      stores[ASSET_REMOTE_INDEX_STORE].getAll()
    );
    expect(remote).toEqual([]);
  });
});
