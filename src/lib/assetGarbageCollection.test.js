// src/lib/assetGarbageCollection.test.js
//
// THE MARK HALF of cloud asset garbage collection (Production Readiness Phase
// 7.9A): what the protected set is made of, what the planner concludes about
// each of the workspace's cloud asset documents, and the ONE write that
// follows — resurrection.
//
// Nothing here tombstones and nothing here deletes, so every assertion about
// destruction is an assertion that it did NOT happen. The cloud boundary is
// injected (`defaultAssetGcDeps` has no default for it), so a tombstoned
// document, a document that changes under the pass, a refusal and a transient
// failure are all expressible as fixtures.
import "fake-indexeddb/auto";
import fs from "fs";
import path from "path";
import {
  GC_DEGRADED,
  GC_GATE,
  GC_RETRYABLE_GATES,
  GC_RETRY_BUDGET_PER_SESSION,
  addGcConnectivityListener,
  collectProtectedAssetIds,
  createGcRetryController,
  evaluateGcGates,
  isCleanBackfill,
  isGcRetrySettled,
  isRetryableGcSkip,
  planAssetGarbageCollection,
  runAssetGcMarkPass,
} from "./assetGarbageCollection";
import { __resetAssetProtectionForTests, protectAsset, protectedAssetIds } from "./assetProtection";
import { buildAssetDocument, tombstoneAssetDocument } from "./cloud/assetCloudModel";
import { ASSET_KIND_PDF_SOURCE } from "./localAssetCache";
import { REMOTE_ASSET_STATE, putRemoteAssetEntry } from "./assetRemoteIndex";
import { deleteAssetDb, installStructuredCloneShim } from "./assetDbTestHarness";
import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  __resetDurableStorageForTests,
  scopedStorageKey,
} from "./durableStorage";

installStructuredCloneShim();

const WS = "ws-11111111-1111-4111-8111-111111111111";
const SCOPE = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS };

const GOOD_FACTS = Object.freeze({
  configured: true,
  online: true,
  sessionMode: "online",
  hydration: { done: true, malformed: [] },
  outboxPending: 0,
  syncPending: 0,
  backfill: { phase: "done", clean: true },
  privacy: { phase: "done" },
});

function seedScope(records) {
  for (const [key, value] of Object.entries(records)) {
    window.localStorage.setItem(scopedStorageKey(key, SCOPE), JSON.stringify(value));
  }
}

/** One VALID cloud asset document, as the store hands it back. */
function storedDoc(id, extra = {}) {
  const built = buildAssetDocument({
    workspaceId: WS,
    id,
    assetKind: extra.assetKind || "editor-image",
    name: `${id}.png`,
    mimeType: extra.mimeType || "image/png",
    size: extra.size || 1024,
    createdAt: 1000,
    metadata: extra.metadata || {},
    sourceAssetId: extra.sourceAssetId,
  });
  if (!built.ok) throw new Error(`fixture is not a valid asset document: ${built.reason}`);
  return { id, fields: { ...built.fields, updatedAt: 2000 } };
}

function tombstonedDoc(id, extra = {}) {
  const doc = storedDoc(id, extra);
  return { id, fields: { ...tombstoneAssetDocument(doc.fields, 3000), updatedAt: 3000 } };
}

/**
 * A workspace store double with only the three methods the pass may use, so a
 * test cannot accidentally prove something through a method the pass does not
 * actually have.
 */
function fakeStore(docs, { onWrite = null, readFails = null, writeFails = null, afterIndex = null } = {}) {
  const byId = new Map(docs.map((d) => [d.id, { ...d.fields }]));
  const calls = [];
  const store = {
    calls,
    byId,
    readAssetIndex: async (workspaceId) => {
      calls.push({ op: "readAssetIndex", workspaceId });
      if (readFails === "index") throw Object.assign(new Error("nope"), { code: "unavailable" });
      const listed = { assets: Array.from(byId, ([id, fields]) => ({ id, fields })) };
      // Another device changing a document AFTER this listing and BEFORE the
      // write is the race the authoritative re-read exists for.
      if (afterIndex) afterIndex(store);
      return listed;
    },
    readAssetDocument: async (workspaceId, assetId) => {
      calls.push({ op: "readAssetDocument", workspaceId, assetId });
      if (readFails === "document") throw Object.assign(new Error("nope"), { code: "unavailable" });
      const fields = byId.get(assetId);
      return fields ? { exists: true, fields } : { exists: false, fields: null };
    },
    writeAssetDocument: async (workspaceId, assetId, fields) => {
      calls.push({ op: "writeAssetDocument", workspaceId, assetId, fields });
      if (writeFails) throw Object.assign(new Error("nope"), { code: writeFails });
      byId.set(assetId, { ...fields, updatedAt: 9000 });
      if (onWrite) onWrite(assetId, fields);
    },
  };
  return store;
}

/** The local halves of the boundary, as recording fakes. */
function localDeps({ assets = [], pending = [], observations = [] } = {}) {
  const applied = [];
  const runs = [];
  const indexed = [];
  return {
    applied,
    runs,
    indexed,
    listAssets: async () => assets,
    listPendingUploads: async () => pending,
    listObservations: async () => observations,
    applyObservations: async (workspaceId, changes) => {
      applied.push({ workspaceId, ...changes });
      return { created: changes.observe || [], carried: [], forgotten: changes.forget || [] };
    },
    recordRun: async (workspaceId, patch) => {
      runs.push({ workspaceId, ...patch });
    },
    noteRemoteIndex: async (entry) => {
      indexed.push(entry);
    },
  };
}

function deps(store, local, extra = {}) {
  return {
    ...local,
    readAssetIndex: store.readAssetIndex,
    readAssetDocument: store.readAssetDocument,
    writeAssetDocument: store.writeAssetDocument,
    ...extra,
  };
}

beforeEach(async () => {
  window.localStorage.clear();
  __resetDurableStorageForTests();
  __resetAssetProtectionForTests();
  await deleteAssetDb();
});

/* --------------------------------- gates ---------------------------------- */

describe("the gates", () => {
  test("a fully settled online session may run", () => {
    expect(evaluateGcGates({ workspaceId: WS, ...GOOD_FACTS })).toEqual({ ok: true, reason: GC_GATE.OK });
  });

  test.each([
    [GC_GATE.NO_WORKSPACE, { workspaceId: "../escape" }],
    [GC_GATE.NO_SESSION, { active: false }],
    [GC_GATE.UNCONFIGURED, { configured: false }],
    [GC_GATE.OFFLINE, { online: false }],
    [GC_GATE.OFFLINE, { sessionMode: "offline" }],
    [GC_GATE.HYDRATION_INCOMPLETE, { hydration: { done: false, malformed: [] } }],
    [GC_GATE.HYDRATION_MALFORMED, { hydration: { done: true, malformed: [{ collection: "noteContent", id: "n1" }] } }],
    [GC_GATE.OUTBOX_PENDING, { outboxPending: 1 }],
    [GC_GATE.OUTBOX_PENDING, { syncPending: 2 }],
    [GC_GATE.BACKFILL_INCOMPLETE, { backfill: { phase: "checking", clean: true } }],
    [GC_GATE.BACKFILL_INCOMPLETE, { backfill: { phase: "done", clean: false } }],
    [GC_GATE.PRIVACY_INCOMPLETE, { privacy: { phase: "running" } }],
    [GC_GATE.UPLOADS_PENDING, { uploadsPending: 3 }],
    [GC_GATE.CORRUPT_REFERENCES, { referenceStates: { [DURABLE_KEYS.noteContent]: "corrupt" } }],
    [GC_GATE.CORRUPT_REFERENCES, { referenceStates: { [DURABLE_KEYS.templateVersions]: "corrupt" } }],
  ])("refuses with %s", (reason, override) => {
    expect(evaluateGcGates({ workspaceId: WS, ...GOOD_FACTS, ...override })).toEqual({ ok: false, reason });
  });

  test("a MISSING reference record is not corruption — an empty workspace is a real state", () => {
    const states = { [DURABLE_KEYS.noteContent]: "missing", [DURABLE_KEYS.pdfDocs]: "ok" };
    expect(evaluateGcGates({ workspaceId: WS, ...GOOD_FACTS, referenceStates: states }).ok).toBe(true);
  });

  test("a backfill that could not settle something is not clean", () => {
    expect(isCleanBackfill(null)).toBe(false);
    expect(isCleanBackfill({ conflicts: [], refused: [], failed: [] })).toBe(true);
    expect(isCleanBackfill({ conflicts: [{ assetId: "a" }], refused: [], failed: [] })).toBe(false);
    expect(isCleanBackfill({ conflicts: [], refused: [{ assetId: "a" }], failed: [] })).toBe(false);
    expect(isCleanBackfill({ conflicts: [], refused: [], failed: [{ assetId: "a" }] })).toBe(false);
  });
});

describe("a refused gate concludes nothing", () => {
  test("the quarantined note store refuses PLANNING, and no observation is written", async () => {
    // A corrupt record is quarantined and then reads as EMPTY. Planning from
    // that would classify every asset in the workspace as garbage.
    window.localStorage.setItem(scopedStorageKey(DURABLE_KEYS.noteContent, SCOPE), "{not json");
    const store = fakeStore([storedDoc("orphan-1")]);
    const local = localDeps();
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });

    expect(result.gate).toEqual({ ok: false, reason: GC_GATE.CORRUPT_REFERENCES });
    expect(local.applied).toEqual([]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });

  test("malformed HYDRATION refuses before the store is even asked", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const local = localDeps();
    const result = await runAssetGcMarkPass({
      workspaceId: WS,
      facts: { ...GOOD_FACTS, hydration: { done: true, malformed: [{ collection: "noteContent", id: "n1" }] } },
      deps: deps(store, local),
    });
    expect(result.gate).toEqual({ ok: false, reason: GC_GATE.HYDRATION_MALFORMED });
    expect(store.calls).toEqual([]);
    expect(local.applied).toEqual([]);
  });

  test("an unreadable asset listing is a refusal, never an empty workspace", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([], { readFails: "index" });
    const local = localDeps({ observations: [{ workspaceId: WS, assetId: "old-1", firstUnreferencedAt: 1 }] });
    const plan = await planAssetGarbageCollection({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });
    expect(plan.gate).toEqual({ ok: false, reason: GC_GATE.LISTING_UNAVAILABLE });
    expect(plan.observations).toEqual({ observe: [], forget: [] });
  });

  test("uploads still owed refuse the pass — that work can still create references", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([storedDoc("in-flight-1")]);
    const local = localDeps({ pending: [{ workspaceId: WS, assetId: "in-flight-1", kind: "editor-image" }] });
    const plan = await planAssetGarbageCollection({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });
    expect(plan.gate).toEqual({ ok: false, reason: GC_GATE.UPLOADS_PENDING });
  });
});

/* ---------------------------- the protected set --------------------------- */

describe("the protected set", () => {
  test("a durably referenced asset is referenced/stored and is never observed", async () => {
    seedScope({
      [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' },
    });
    const store = fakeStore([storedDoc("img-1"), storedDoc("orphan-1")]);
    const local = localDeps();
    const plan = await planAssetGarbageCollection({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });

    expect(plan.gate.ok).toBe(true);
    expect(plan.classes.referencedStored).toEqual(["img-1"]);
    expect(plan.classes.unreferencedStored).toEqual(["orphan-1"]);
    expect(plan.observations.observe).toEqual(["orphan-1"]);
  });

  test("a template version's logo and the CURRENT pdf source are protected; a superseded source is not", async () => {
    seedScope({
      [DURABLE_KEYS.templateVersions]: { "v-1": { id: "v-1", logoAssetId: "logo-1" } },
      [DURABLE_KEYS.pdfDocs]: { "doc-1": { id: "doc-1", sourceAssetId: "pdf-current" } },
    });
    const store = fakeStore([
      storedDoc("logo-1", { assetKind: "logo" }),
      storedDoc("pdf-current", { assetKind: ASSET_KIND_PDF_SOURCE, mimeType: "application/pdf" }),
      storedDoc("pdf-superseded", { assetKind: ASSET_KIND_PDF_SOURCE, mimeType: "application/pdf" }),
    ]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, localDeps()),
    });
    expect(plan.classes.referencedStored.sort()).toEqual(["logo-1", "pdf-current"]);
    expect(plan.classes.unreferencedStored).toEqual(["pdf-superseded"]);
  });

  test("a CLOUD-only rendition keeps its original alive on a device that never held either", async () => {
    // The note references the rendition. This browser has NO local asset
    // records at all, so the local listing cannot supply the rendition edge —
    // only the cloud document's own `sourceAssetId` can.
    seedScope({
      [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="rendition-1"></p>' },
    });
    const store = fakeStore([
      storedDoc("rendition-1", { sourceAssetId: "original-1" }),
      storedDoc("original-1"),
    ]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, localDeps({ assets: [] })),
    });
    expect(plan.classes.referencedStored.sort()).toEqual(["original-1", "rendition-1"]);
    expect(plan.classes.unreferencedStored).toEqual([]);
  });

  test("the cloud closure reaches a FIXED POINT through a chain of renditions", async () => {
    seedScope({
      [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="rendition-b"></p>' },
    });
    const store = fakeStore([
      storedDoc("rendition-b", { sourceAssetId: "rendition-a" }),
      storedDoc("rendition-a", { sourceAssetId: "original-1" }),
      storedDoc("original-1"),
      storedDoc("unrelated-1"),
    ]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, localDeps()),
    });
    expect(plan.classes.referencedStored.sort()).toEqual(["original-1", "rendition-a", "rendition-b"]);
    // An ORPHANED rendition keeps nothing alive; the closure is anchored to
    // references, not to the mere existence of an edge.
    expect(plan.classes.unreferencedStored).toEqual(["unrelated-1"]);
  });

  test("an asset this browser still owes the account is protected", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([storedDoc("owed-1")]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      // The gate refuses while uploads are owed, so this proves the protected
      // set itself rather than the gate: the queue is read for BOTH.
      deps: deps(store, localDeps({ pending: [{ workspaceId: WS, assetId: "owed-1", kind: "editor-image" }] })),
    });
    expect(plan.gate).toEqual({ ok: false, reason: GC_GATE.UPLOADS_PENDING });
    expect(plan.classes.unreferencedStored).toEqual([]);
  });
});

/* --------------------------- active draft assets -------------------------- */

describe("an unsaved draft asset", () => {
  test("that has FINISHED uploading and is still unsaved is not a candidate", async () => {
    // This is the case the upload queue cannot cover: the queue is empty, the
    // object is in the account, and no durable record names it yet.
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    protectAsset(WS, "draft-logo-1");
    const store = fakeStore([storedDoc("draft-logo-1", { assetKind: "logo" }), storedDoc("orphan-1")]);
    const local = localDeps();
    const plan = await planAssetGarbageCollection({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });

    expect(plan.gate.ok).toBe(true);
    expect(plan.classes.referencedStored).toEqual(["draft-logo-1"]);
    expect(plan.classes.unreferencedStored).toEqual(["orphan-1"]);
    expect(plan.observations.observe).toEqual(["orphan-1"]);
  });

  test("becomes an ordinary candidate once the protection is released and nothing names it", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const release = protectAsset(WS, "draft-logo-1");
    release();
    const store = fakeStore([storedDoc("draft-logo-1", { assetKind: "logo" })]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, localDeps()),
    });
    expect(plan.classes.unreferencedStored).toEqual(["draft-logo-1"]);
    expect(plan.observations.observe).toEqual(["draft-logo-1"]);
  });

  test("a published draft is protected by the version that references it, not by the register", async () => {
    seedScope({
      [DURABLE_KEYS.templateVersions]: { "v-1": { id: "v-1", logoAssetId: "draft-logo-1" } },
    });
    protectAsset(WS, "draft-logo-1")(); // what publishing does
    const store = fakeStore([storedDoc("draft-logo-1", { assetKind: "logo" })]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, localDeps()),
    });
    expect(plan.classes.referencedStored).toEqual(["draft-logo-1"]);
  });

  test("one workspace's draft never protects another workspace's asset", () => {
    protectAsset(WS, "draft-logo-1");
    expect(protectedAssetIds("ws-99999999-9999-4999-8999-999999999999").size).toBe(0);
    expect(protectedAssetIds(WS).has("draft-logo-1")).toBe(true);
  });

  test("another workspace's release cannot expose this workspace's draft to collection", async () => {
    // The same asset id, held in two workspaces. Releasing the OTHER one must
    // leave this workspace's draft protected — the isolation rule proved here
    // where it actually matters, at the collector's own conclusion.
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const other = "ws-99999999-9999-4999-8999-999999999999";
    protectAsset(WS, "draft-logo-1");
    const releaseOther = protectAsset(other, "draft-logo-1");
    releaseOther();

    const store = fakeStore([storedDoc("draft-logo-1", { assetKind: "logo" })]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, localDeps()),
    });
    expect(plan.classes.referencedStored).toEqual(["draft-logo-1"]);
    expect(plan.classes.unreferencedStored).toEqual([]);
  });
});

/* ------------------------- observations across passes --------------------- */

describe("the observation ledger through the planner", () => {
  test("an unmarked STORED asset is observed on every pass, and the ledger carries one clock", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([storedDoc("orphan-1")]);

    const first = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, localDeps({ observations: [] })),
    });
    expect(first.observations.observe).toEqual(["orphan-1"]);
    expect(first.observations.forget).toEqual([]);

    // The second pass sees the row the first one created and asks for it to be
    // observed AGAIN — never forgotten — which is what lets the 48-hour clock
    // in src/lib/assetGcLedger.js accumulate.
    const second = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(
        store,
        localDeps({ observations: [{ workspaceId: WS, assetId: "orphan-1", firstUnreferencedAt: 1000 }] })
      ),
    });
    expect(second.observations.observe).toEqual(["orphan-1"]);
    expect(second.observations.forget).toEqual([]);
  });

  test("a stale observation is forgotten when the asset is referenced again", async () => {
    seedScope({
      [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' },
    });
    const store = fakeStore([storedDoc("img-1")]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(
        store,
        localDeps({ observations: [{ workspaceId: WS, assetId: "img-1", firstUnreferencedAt: 1000 }] })
      ),
    });
    expect(plan.observations.observe).toEqual([]);
    expect(plan.observations.forget).toEqual(["img-1"]);
  });

  test("a stale observation is forgotten when the cloud no longer describes the asset", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([]); // the document is gone
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(
        store,
        localDeps({ observations: [{ workspaceId: WS, assetId: "gone-1", firstUnreferencedAt: 1000 }] })
      ),
    });
    expect(plan.observations.forget).toEqual(["gone-1"]);
  });

  test("a TOMBSTONED unreferenced asset stops the pre-tombstone clock and is left for a later phase", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([tombstonedDoc("dead-1")]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(
        store,
        localDeps({ observations: [{ workspaceId: WS, assetId: "dead-1", firstUnreferencedAt: 1000 }] })
      ),
    });
    expect(plan.classes.unreferencedTombstoned).toEqual(["dead-1"]);
    expect(plan.observations.forget).toEqual(["dead-1"]);
    expect(plan.observations.observe).toEqual([]);
  });

  test("a MALFORMED document is reported, changes nothing, and pauses every clock", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([storedDoc("orphan-1"), { id: "broken-1", fields: { nonsense: true } }]);
    const plan = await planAssetGarbageCollection({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(
        store,
        localDeps({
          observations: [
            { workspaceId: WS, assetId: "broken-1", firstUnreferencedAt: 1000 },
            { workspaceId: WS, assetId: "orphan-1", firstUnreferencedAt: 1000 },
          ],
        })
      ),
    });
    expect(plan.degraded).toBe(GC_DEGRADED.MALFORMED_ASSET_DOCUMENT);
    expect(plan.classes.malformed).toEqual(["broken-1"]);
    expect(plan.listing.malformed).toEqual([{ id: "broken-1", reason: expect.any(String) }]);
    // Nothing is inferred from an unreadable document, and no clock advances
    // while one exists — its own `sourceAssetId` could have protected another
    // asset in this very listing.
    expect(plan.observations.observe).toEqual([]);
    expect(plan.observations.forget).toEqual([]);
  });
});

/* ------------------------------ resurrection ------------------------------ */

describe("resurrection", () => {
  function referencedTombstoned() {
    seedScope({
      [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' },
    });
    return fakeStore([tombstonedDoc("img-1")]);
  }

  test("a referenced, tombstoned asset is restored to `stored` with no bytes and no new id", async () => {
    const store = referencedTombstoned();
    const local = localDeps();
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });

    expect(result.resurrected).toEqual(["img-1"]);
    const write = store.calls.find((c) => c.op === "writeAssetDocument");
    expect(write.assetId).toBe("img-1");
    expect(write.fields.state).toBe("stored");
    // The tombstone is dropped and NOTHING else changes: same id, same size,
    // same createdAt. The immutable Storage object is reused as it is.
    expect(write.fields).not.toHaveProperty("tombstonedAt");
    expect(write.fields.id).toBe("img-1");
    expect(write.fields.size).toBe(1024);
    expect(write.fields.createdAt).toBe(1000);
    // `updatedAt` is the store's own server stamp, never carried forward.
    expect(write.fields).not.toHaveProperty("updatedAt");
  });

  test("needs no local bytes: the local asset listing is empty throughout", async () => {
    const store = referencedTombstoned();
    const local = localDeps({ assets: [], pending: [] });
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });
    expect(result.resurrected).toEqual(["img-1"]);
  });

  test("performs an AUTHORITATIVE re-read immediately before the write", async () => {
    const store = referencedTombstoned();
    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, localDeps()) });
    const ops = store.calls.map((c) => c.op);
    const write = ops.indexOf("writeAssetDocument");
    expect(ops[write - 1]).toBe("readAssetDocument");
    expect(store.calls[write - 1].assetId).toBe("img-1");
  });

  test("does NOT write when the document changed under it between the listing and the write", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    // The listing says tombstoned; another device restores it before the write.
    const store = fakeStore([tombstonedDoc("img-1")], {
      afterIndex: (s) => s.byId.set("img-1", storedDoc("img-1").fields),
    });
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, localDeps()) });
    expect(result.alreadyStored).toEqual(["img-1"]);
    expect(result.resurrected).toEqual([]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });

  test("is idempotent: a second pass finds it stored and writes nothing", async () => {
    const store = referencedTombstoned();
    const first = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, localDeps()) });
    const second = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, localDeps()) });
    expect(first.resurrected).toEqual(["img-1"]);
    expect(second.resurrected).toEqual([]);
    expect(second.alreadyStored).toEqual([]);
    // The second pass does not even consider it: the listing now says stored.
    expect(second.counts.referenced).toBe(1);
    expect(store.calls.filter((c) => c.op === "writeAssetDocument")).toHaveLength(1);
  });

  test("a document that vanished is reported absent, never fabricated", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const store = fakeStore([tombstonedDoc("img-1")], {
      afterIndex: (s) => s.byId.delete("img-1"),
    });
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, localDeps()) });
    expect(result.absent).toEqual(["img-1"]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });

  test("a document that no longer validates is never overwritten", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const store = fakeStore([tombstonedDoc("img-1")], {
      afterIndex: (s) => s.byId.set("img-1", { nonsense: true }),
    });
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, localDeps()) });
    expect(result.malformed).toEqual(["img-1"]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });

  test("a refusal is permanent and a transient failure is not, and neither throws", async () => {
    const refused = await runAssetGcMarkPass({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(fakeStore([tombstonedDoc("img-1")], { writeFails: "permission-denied" }), localDeps()),
    });
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const again = await runAssetGcMarkPass({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(fakeStore([tombstonedDoc("img-1")], { writeFails: "permission-denied" }), localDeps()),
    });
    expect(refused.refused.concat(again.refused)).toContain("img-1");

    const failed = await runAssetGcMarkPass({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(fakeStore([tombstonedDoc("img-1")], { writeFails: "unavailable" }), localDeps()),
    });
    expect(failed.failed).toEqual(["img-1"]);
  });

  test("ANY member may perform it — nothing here consults an owner role", async () => {
    // The Security Rules permit `tombstoned -> stored` for any member and
    // reserve deletion for the owner. The pass therefore takes no role fact at
    // all, which is what this asserts: a full set of facts has no `role` in it.
    expect(Object.keys(GOOD_FACTS)).not.toContain("role");
    const store = referencedTombstoned();
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, localDeps()) });
    expect(result.resurrected).toEqual(["img-1"]);
  });

  test("refreshes the local index only AFTER the write it confirmed", async () => {
    const store = referencedTombstoned();
    const local = localDeps();
    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });
    expect(local.indexed).toHaveLength(1);
    expect(local.indexed[0]).toMatchObject({
      workspaceId: WS,
      assetId: "img-1",
      state: REMOTE_ASSET_STATE.STORED,
    });
  });

  test("does not touch the index when the write was refused", async () => {
    const local = localDeps();
    await runAssetGcMarkPass({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(fakeStore([tombstonedDoc("img-1")], { writeFails: "permission-denied" }), local),
    });
    expect(local.indexed).toEqual([]);
  });
});

/* --------------------------- session / workspace -------------------------- */

describe("the session guard", () => {
  test("a pass that starts after the session closed writes nothing", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const store = fakeStore([tombstonedDoc("img-1")]);
    const local = localDeps();
    const result = await runAssetGcMarkPass({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, local),
      isActive: () => false,
    });
    expect(result.stopped).toBe(true);
    expect(result.gate).toEqual({ ok: false, reason: GC_GATE.NO_SESSION });
    expect(store.calls).toEqual([]);
    expect(local.applied).toEqual([]);
  });

  test("a workspace change MID-PASS stops it between assets and writes nothing further", async () => {
    seedScope({
      [DURABLE_KEYS.noteContent]: {
        "note-1": '<p><img data-asset-id="img-1"><img data-asset-id="img-2"></p>',
      },
    });
    const store = fakeStore([tombstonedDoc("img-1"), tombstonedDoc("img-2")]);
    const local = localDeps();
    let live = true;
    const result = await runAssetGcMarkPass({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, {
        ...local,
        // The session closes the moment the first restoration lands.
        noteRemoteIndex: async (entry) => {
          local.indexed.push(entry);
          live = false;
        },
      }),
      isActive: () => live,
    });
    expect(result.stopped).toBe(true);
    expect(result.resurrected).toEqual(["img-1"]);
    expect(store.calls.filter((c) => c.op === "writeAssetDocument")).toHaveLength(1);
    // And the ledger — a local write of the closing session — is not touched.
    expect(local.applied).toEqual([]);
  });

  test("a workspace id that could never address an asset does nothing at all", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const result = await runAssetGcMarkPass({ workspaceId: "../escape", facts: GOOD_FACTS, deps: deps(store, localDeps()) });
    expect(result.gate).toEqual({ ok: false, reason: GC_GATE.NO_WORKSPACE });
    expect(store.calls).toEqual([]);
  });
});

/* --------------------------- the index is not truth ----------------------- */

describe("assetRemoteIndex is never cloud authority", () => {
  test("the module never imports a way to READ the index", () => {
    const source = fs.readFileSync(path.join(__dirname, "assetGarbageCollection.js"), "utf8");
    const importLine = source.match(/import \{[^}]*\} from "\.\/assetRemoteIndex";/);
    expect(importLine).not.toBeNull();
    expect(importLine[0]).not.toMatch(/getRemoteAssetEntry|listRemoteAssetEntries/);
    expect(source).not.toMatch(/getRemoteAssetEntry|listRemoteAssetEntries/);
  });

  test("a local index entry contradicting the cloud changes no conclusion", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    // The index claims the referenced asset is stored (so nothing to restore)
    // and that the orphan is tombstoned (so nothing to observe). Both are lies.
    await putRemoteAssetEntry({ workspaceId: WS, assetId: "img-1", state: REMOTE_ASSET_STATE.STORED });
    await putRemoteAssetEntry({ workspaceId: WS, assetId: "orphan-1", state: REMOTE_ASSET_STATE.TOMBSTONED });

    const store = fakeStore([tombstonedDoc("img-1"), storedDoc("orphan-1")]);
    const local = localDeps();
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });

    // Both conclusions come from the workspace store, not the cache.
    expect(result.resurrected).toEqual(["img-1"]);
    expect(local.applied[0].observe).toEqual(["orphan-1"]);
  });
});

/* --------------------------------- the run -------------------------------- */

describe("the pass as a whole", () => {
  test("records what it did, and never claims a sweep", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const store = fakeStore([tombstonedDoc("img-1"), storedDoc("orphan-1")]);
    const local = localDeps();
    const result = await runAssetGcMarkPass({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, local),
      now: () => 5000,
    });

    expect(result.ranAt).toBe(5000);
    expect(result.counts).toEqual({ assets: 2, referenced: 1, unreferenced: 1, tombstoned: 1 });
    expect(local.runs).toEqual([
      {
        workspaceId: WS,
        lastMarkPassGate: GC_GATE.OK,
        lastMarkPassDegraded: null,
        lastMarkPassCounts: { assets: 2, referenced: 1, unreferenced: 1, tombstoned: 1 },
        lastResurrectedCount: 1,
        lastUnreferencedCount: 1,
      },
    ]);
    expect(local.runs[0]).not.toHaveProperty("lastSweepAt");
  });

  test("an unreferenced STORED asset is observed and NOT modified", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([storedDoc("orphan-1")]);
    const local = localDeps();
    const result = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });

    expect(local.applied).toEqual([{ workspaceId: WS, observe: ["orphan-1"], forget: [] }]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
    expect(store.byId.get("orphan-1").state).toBe("stored");
    expect(result.resurrected).toEqual([]);
  });

  test("a referenced STORED asset is a complete no-op", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const store = fakeStore([storedDoc("img-1")]);
    const local = localDeps();
    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });
    expect(store.calls.filter((c) => c.op !== "readAssetIndex")).toEqual([]);
    expect(local.applied).toEqual([{ workspaceId: WS, observe: [], forget: [] }]);
  });

  test("a ledger write that fails costs one pass of grace, not a wrong conclusion", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} });
    const store = fakeStore([storedDoc("orphan-1")]);
    const local = localDeps();
    const result = await runAssetGcMarkPass({
      workspaceId: WS,
      facts: GOOD_FACTS,
      deps: deps(store, { ...local, applyObservations: async () => { throw new Error("quota"); } }),
    });
    expect(result.gate.ok).toBe(true);
    expect(result.observations).toEqual({ created: [], carried: [], forgotten: [] });
  });
});

/* -------------------- the protected set, as one function ------------------ */

describe("collectProtectedAssetIds is the ONE definition of protected (7.9B)", () => {
  test("it unions the durable references, the cloud rendition edges, the queue and the drafts", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const release = protectAsset(WS, "draft-1");
    const result = await collectProtectedAssetIds({
      workspaceId: WS,
      derivedFrom: [{ id: "img-1", sourceAssetId: "original-1" }],
      deps: {
        listAssets: async () => [],
        listPendingUploads: async () => [{ workspaceId: WS, assetId: "queued-1", kind: "editor-image" }],
      },
    });

    expect(result.marked.has("img-1")).toBe(true);
    // The cloud's own rendition edge keeps an original this device has never
    // downloaded alive.
    expect(result.marked.has("original-1")).toBe(true);
    expect(result.marked.has("queued-1")).toBe(true);
    expect(result.marked.has("draft-1")).toBe(true);
    expect(result.marked.has("orphan-1")).toBe(false);
    // The two facts the caller needs to re-check a gate with.
    expect(result.uploadsPending).toBe(1);
    expect(result.states[DURABLE_KEYS.noteContent]).toBe("ok");
    release();
  });

  test("it reports a QUARANTINED reference record rather than an empty workspace", async () => {
    window.localStorage.setItem(scopedStorageKey(DURABLE_KEYS.noteContent, SCOPE), "{not json");
    const result = await collectProtectedAssetIds({
      workspaceId: WS,
      deps: { listAssets: async () => [], listPendingUploads: async () => [] },
    });
    expect(result.states[DURABLE_KEYS.noteContent]).toBe("corrupt");
  });

  test("the planner's own marked set is exactly what it returns", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const store = fakeStore([storedDoc("img-1"), storedDoc("orphan-1")]);
    const local = localDeps();
    const plan = await planAssetGarbageCollection({ workspaceId: WS, facts: GOOD_FACTS, deps: deps(store, local) });
    const direct = await collectProtectedAssetIds({
      workspaceId: WS,
      derivedFrom: plan.derivedFrom,
      deps: deps(store, local),
    });
    expect(new Set(plan.marked)).toEqual(direct.marked);
  });
});

/* --------------------------- the ONE re-attempt --------------------------- */

describe("the event-driven re-attempt (7.9B)", () => {
  test("only the gates a live session can clear are retryable", () => {
    expect(GC_RETRYABLE_GATES).toEqual([GC_GATE.OFFLINE, GC_GATE.OUTBOX_PENDING, GC_GATE.UPLOADS_PENDING]);
    for (const reason of GC_RETRYABLE_GATES) expect(isRetryableGcSkip(reason)).toBe(true);
  });

  test("nothing else is — a permanent or unreadable condition is not retried at all", () => {
    for (const reason of [
      GC_GATE.OK,
      GC_GATE.NO_WORKSPACE,
      GC_GATE.UNCONFIGURED,
      GC_GATE.NO_SESSION,
      GC_GATE.HYDRATION_INCOMPLETE,
      GC_GATE.HYDRATION_MALFORMED,
      GC_GATE.CORRUPT_REFERENCES,
      GC_GATE.BACKFILL_INCOMPLETE,
      GC_GATE.PRIVACY_INCOMPLETE,
      GC_GATE.LISTING_UNAVAILABLE,
      "cadence",
      "not-owner",
      "degraded",
      null,
      undefined,
    ]) {
      expect(isRetryableGcSkip(reason)).toBe(false);
    }
  });

  test("ELIGIBLE means every retryable gate is clear AT ONCE, never one of them", () => {
    expect(isGcRetrySettled({ online: true, syncPending: 0, uploadsPending: 0 })).toBe(true);
    expect(isGcRetrySettled({})).toBe(true);
    // Each of these is a state a gate has cleared in — and none of them is
    // eligible, which is what stops a premature pass mid-sequence.
    expect(isGcRetrySettled({ online: true, syncPending: 1, uploadsPending: 0 })).toBe(false);
    expect(isGcRetrySettled({ online: true, syncPending: 0, uploadsPending: 3 })).toBe(false);
    expect(isGcRetrySettled({ online: false, syncPending: 0, uploadsPending: 0 })).toBe(false);
  });
});

/* ---------------------- the re-attempt state machine ---------------------- */

describe("the GC retry controller (7.9B)", () => {
  /** A controller with a recording `onRetry`, seeded from one session's facts. */
  function controllerWith(seed = {}) {
    const fired = [];
    const controller = createGcRetryController({ ...seed, onRetry: () => fired.push(controller.snapshot()) });
    return { controller, fired };
  }

  /** The initial pass of a session, skipping for `reason`. */
  function initialPass(controller, reason) {
    controller.passStarted();
    controller.passSettled({ skipped: reason });
  }

  test("1. OFFLINE with both engines idle: the online event ALONE causes one retry", () => {
    // The case neither engine can report: they publish on their own work
    // changing, and an idle engine has no work.
    const { controller, fired } = controllerWith({ online: false, syncPending: 0, uploadsPending: 0 });
    initialPass(controller, GC_GATE.OFFLINE);
    expect(fired).toHaveLength(0);
    expect(controller.snapshot().armed).toBe(true);

    controller.observe({ online: true });
    expect(fired).toHaveLength(1);
    // The attempt disarmed itself.
    expect(controller.snapshot().armed).toBe(false);
  });

  test("2. offline -> online while the OUTBOX is still pending: no premature retry", () => {
    const { controller, fired } = controllerWith({ online: false, syncPending: 2, uploadsPending: 1 });
    initialPass(controller, GC_GATE.OFFLINE);

    controller.observe({ online: true });
    expect(fired).toEqual([]);
    // Still armed, still waiting: connectivity is one gate of three.
    expect(controller.snapshot()).toMatchObject({ armed: true, eligible: false });
  });

  test("3. the outbox settles while UPLOADS are still pending: no premature retry", () => {
    const { controller, fired } = controllerWith({ online: false, syncPending: 2, uploadsPending: 1 });
    initialPass(controller, GC_GATE.OFFLINE);
    controller.observe({ online: true });
    controller.observe({ syncPending: 0 });

    expect(fired).toEqual([]);
    expect(controller.snapshot()).toMatchObject({ armed: true, eligible: false });
  });

  test("4. the uploads then settle: EXACTLY ONE retry, at the end of the sequence", () => {
    const { controller, fired } = controllerWith({ online: false, syncPending: 2, uploadsPending: 1 });
    initialPass(controller, GC_GATE.OFFLINE);
    controller.observe({ online: true });
    controller.observe({ syncPending: 0 });
    expect(fired).toEqual([]);

    controller.observe({ uploadsPending: 0 });
    expect(fired).toHaveLength(1);
    // THREE gates cleared in sequence cost ONE retry, not three — which is
    // why a session bound can never stand between a workspace and its first
    // safe moment.
    expect(controller.snapshot().retries).toBe(1);
    expect(controller.snapshot().armed).toBe(false);
  });

  test("5. duplicate sync, upload and connectivity events while eligible: no duplicate passes", () => {
    const { controller, fired } = controllerWith({ online: false, syncPending: 1, uploadsPending: 1 });
    initialPass(controller, GC_GATE.OFFLINE);
    controller.observe({ online: true });
    controller.observe({ syncPending: 0 });
    controller.observe({ uploadsPending: 0 });
    expect(fired).toHaveLength(1);

    // The retried pass is running, and everything reports itself again.
    controller.passStarted();
    for (let i = 0; i < 20; i += 1) {
      controller.observe({ syncPending: 0 });
      controller.observe({ uploadsPending: 0 });
      controller.observe({ online: true });
    }
    expect(fired).toHaveLength(1);

    // It settles, still transient, and re-arms — but there has been no NEW
    // transition, so the same events still start nothing.
    controller.passSettled({ skipped: GC_GATE.UPLOADS_PENDING });
    expect(controller.snapshot().armed).toBe(true);
    for (let i = 0; i < 20; i += 1) {
      controller.observe({ uploadsPending: 0 });
      controller.observe({ online: true });
    }
    expect(fired).toHaveLength(1);

    // A GENUINELY new transition does run it again: work appeared and finished.
    controller.observe({ uploadsPending: 4 });
    controller.observe({ uploadsPending: 0 });
    expect(fired).toHaveLength(2);
  });

  test("a transition that lands WHILE the pass is running is not lost", () => {
    // The real race: the pass takes a network round trip, and the engine
    // finishing is exactly what it was waiting for.
    const { controller, fired } = controllerWith({ online: true, syncPending: 0, uploadsPending: 3 });
    controller.passStarted();
    controller.observe({ uploadsPending: 0 }); // the uploads finish mid-pass
    expect(fired).toEqual([]);
    controller.passSettled({ skipped: GC_GATE.UPLOADS_PENDING });
    expect(fired).toHaveLength(1);
  });

  test("6. a session that closed before the event cannot retry", () => {
    const { controller, fired } = controllerWith({ online: false });
    initialPass(controller, GC_GATE.OFFLINE);
    controller.close();

    controller.observe({ online: true });
    controller.observe({ syncPending: 0 });
    controller.passSettled({ skipped: GC_GATE.OFFLINE });
    expect(fired).toEqual([]);
    expect(controller.snapshot()).toMatchObject({ closed: true, armed: false });
  });

  test("7. a SUCCESSFUL pass disarms, so later eligibility events start nothing", () => {
    const { controller, fired } = controllerWith({ online: false });
    initialPass(controller, GC_GATE.OFFLINE);
    controller.observe({ online: true });
    expect(fired).toHaveLength(1);

    // The retried pass runs and its gate is OK — the sweep either swept or
    // was held by its own ~24-hour cadence, and neither is a waiting state.
    controller.passStarted();
    controller.passSettled({ skipped: null });
    expect(controller.snapshot().armed).toBe(false);
    controller.observe({ online: false });
    controller.observe({ online: true });
    controller.observe({ uploadsPending: 2 });
    controller.observe({ uploadsPending: 0 });
    expect(fired).toHaveLength(1);
  });

  test("a cadence or non-owner skip is not a waiting state and never arms", () => {
    for (const reason of ["cadence", "not-owner", "degraded", GC_GATE.CORRUPT_REFERENCES]) {
      const { controller, fired } = controllerWith({ online: false });
      initialPass(controller, reason);
      controller.observe({ online: true });
      expect(fired).toEqual([]);
      expect(controller.snapshot().armed).toBe(false);
    }
  });

  test("the budget is a circuit breaker, not the lifecycle control", () => {
    expect(GC_RETRY_BUDGET_PER_SESSION).toBeGreaterThanOrEqual(5);
    const { controller, fired } = controllerWith({ online: true, budget: 2 });
    // Each cycle needs a REAL unsafe -> safe transition, which is why a
    // flapping session is what this bounds and a settling one is not.
    for (let i = 0; i < 6; i += 1) {
      controller.passStarted();
      controller.passSettled({ skipped: GC_GATE.UPLOADS_PENDING });
      controller.observe({ uploadsPending: 1 });
      controller.observe({ uploadsPending: 0 });
    }
    expect(fired).toHaveLength(2);
  });

  test("consecutive THROWN passes trip the breaker and end re-attempts for the session", () => {
    const { controller, fired } = controllerWith({ online: true, errorLimit: 2 });
    controller.passStarted();
    controller.passSettled({ errored: true });
    expect(controller.snapshot().tripped).toBe(false);
    controller.passStarted();
    controller.passSettled({ errored: true });
    expect(controller.snapshot().tripped).toBe(true);

    controller.observe({ uploadsPending: 1 });
    controller.observe({ uploadsPending: 0 });
    expect(fired).toEqual([]);
  });

  test("a pass that throws once and then skips retryably still recovers", () => {
    const { controller, fired } = controllerWith({ online: true });
    controller.passStarted();
    controller.passSettled({ errored: true });
    controller.passStarted();
    controller.passSettled({ skipped: GC_GATE.UPLOADS_PENDING });
    expect(controller.snapshot().tripped).toBe(false);
    controller.observe({ uploadsPending: 2 });
    controller.observe({ uploadsPending: 0 });
    expect(fired).toHaveLength(1);
  });
});

/* --------------------- 8. the connectivity source itself ------------------ */

describe("the connectivity listener (7.9B)", () => {
  test("the browser's own online/offline events drive it, and nothing polls", () => {
    const seen = [];
    const stop = addGcConnectivityListener((online) => seen.push(online));
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(seen).toEqual([false, true]);

    // And it is removable: an event after the session closed reaches nothing.
    stop();
    window.dispatchEvent(new Event("online"));
    expect(seen).toEqual([false, true]);
  });

  test("an OFFLINE session comes back through a real window event, end to end", () => {
    const fired = [];
    const controller = createGcRetryController({
      online: false,
      onRetry: () => fired.push(true),
    });
    const stop = addGcConnectivityListener((online) => controller.observe({ online }));
    controller.passStarted();
    controller.passSettled({ skipped: GC_GATE.OFFLINE });

    window.dispatchEvent(new Event("online"));
    expect(fired).toEqual([true]);
    stop();
  });

  test("nothing in the retry path uses a timer, an interval or a poll", () => {
    const SOURCE = fs.readFileSync(path.join(__dirname, "assetGarbageCollection.js"), "utf8");
    const SCOPE = fs.readFileSync(path.join(__dirname, "..", "context", "DataScopeContext.js"), "utf8");
    for (const source of [SOURCE, SCOPE]) {
      expect(source).not.toMatch(/setInterval/);
      expect(source).not.toMatch(/requestAnimationFrame/);
    }
    expect(SOURCE).not.toMatch(/setTimeout/);
    // The provider's one setTimeout is the Phase 6 deferred session close,
    // and it is not on the GC path.
    expect(SCOPE.match(/setTimeout/g)).toHaveLength(1);
    expect(SCOPE).toMatch(/setTimeout\(\(\) => \{\s*opened\.close\(\);\s*\}, 0\);/);
  });
});
