// src/lib/assetGcSweep.test.js
//
// THE SWEEP HALF of cloud asset garbage collection (Production Readiness Phase
// 7.9B): the one destructive-direction write the product makes, and the four
// things that must be true before it is made — maturity, ownership, cadence,
// and a picture of the workspace re-established at the moment of the write.
//
// Most of what follows is an assertion that NOTHING happened: a first
// observation does not tombstone, a skewed clock does not tombstone, a member
// does not tombstone, a candidate referenced again a millisecond before the
// write does not tombstone. The few that do tombstone assert exactly one
// transition — `stored -> tombstoned` — and that no delete of any kind is
// reachable from this module at all.
import "fake-indexeddb/auto";
import fs from "fs";
import path from "path";
import {
  GC_SWEEP_PHASE,
  MIN_AGREEING_OBSERVATIONS,
  SWEEP_CADENCE_MS,
  SWEEP_GATE,
  UNREFERENCED_GRACE_MS,
  assetGcAttentionLine,
  assetGcStatusLine,
  evaluateSweepCadence,
  isAssetGcPaused,
  isMatureObservation,
  isWorkspaceOwner,
  planAssetGcSweep,
  runAssetGcSweep,
} from "./assetGcSweep";
import { GC_DEGRADED, GC_GATE, runAssetGcMarkPass } from "./assetGarbageCollection";
import { __resetAssetProtectionForTests, protectAsset } from "./assetProtection";
import { applyGcObservations, getGcObservation, readAssetGcRun, writeAssetGcRun } from "./assetGcLedger";
import { getRemoteAssetEntry, makeRemoteAssetEntry, putRemoteAssetEntry, REMOTE_ASSET_STATE } from "./assetRemoteIndex";
import { CLOUD_ASSET_STATE, buildAssetDocument, tombstoneAssetDocument } from "./cloud/assetCloudModel";
import { MEMBER_ROLE } from "./cloud/workspaceBootstrap";
import { deleteAssetDb, installStructuredCloneShim } from "./assetDbTestHarness";
import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  __resetDurableStorageForTests,
  scopedStorageKey,
} from "./durableStorage";

installStructuredCloneShim();

const WS = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";
const SCOPE = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS };

const HOUR = 60 * 60 * 1000;
/** A point in time far enough from zero that "48 hours ago" is still positive. */
const T0 = 1_000 * HOUR;

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

function seedScope(records, scope = SCOPE) {
  for (const [key, value] of Object.entries(records)) {
    window.localStorage.setItem(scopedStorageKey(key, scope), JSON.stringify(value));
  }
}

/** The store's SERVER-timestamp sentinel, resolved on write as a store does. */
const STAMP = Object.freeze({ __serverTimestamp: true });
const STAMPED_AT = 4242;

function storedDoc(id, extra = {}) {
  const built = buildAssetDocument({
    workspaceId: extra.workspaceId || WS,
    id,
    assetKind: extra.assetKind || "editor-image",
    name: `${id}.png`,
    mimeType: "image/png",
    size: 1024,
    createdAt: 1000,
    metadata: {},
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
 * A workspace store double with only the four methods the two stages may use.
 * `hooks.beforeDocumentRead` is the seam every "it changed under the pass"
 * test uses: another device's write, landing between the listing and the
 * authoritative re-read.
 */
function fakeStore(docs, { writeFails = null, readFails = null, beforeDocumentRead = null } = {}) {
  const byId = new Map(docs.map((d) => [d.id, { ...d.fields }]));
  const calls = [];
  const store = {
    calls,
    byId,
    workspaceId: WS,
    readAssetIndex: async (workspaceId) => {
      calls.push({ op: "readAssetIndex", workspaceId });
      if (readFails === "index") throw Object.assign(new Error("nope"), { code: "unavailable" });
      return { assets: Array.from(byId, ([id, fields]) => ({ id, fields })) };
    },
    readAssetDocument: async (workspaceId, assetId) => {
      if (beforeDocumentRead) beforeDocumentRead(store, assetId);
      calls.push({ op: "readAssetDocument", workspaceId, assetId });
      if (readFails === "document") throw Object.assign(new Error("nope"), { code: "unavailable" });
      const fields = byId.get(assetId);
      return fields ? { exists: true, fields } : { exists: false, fields: null };
    },
    writeAssetDocument: async (workspaceId, assetId, fields) => {
      calls.push({ op: "writeAssetDocument", workspaceId, assetId, fields });
      if (writeFails) throw Object.assign(new Error("nope"), { code: writeFails });
      const resolved = { ...fields, updatedAt: 9000 };
      if (resolved.tombstonedAt === STAMP) resolved.tombstonedAt = STAMPED_AT;
      byId.set(assetId, resolved);
    },
    timestamp: () => STAMP,
  };
  return store;
}

/** The cloud half of the boundary, as both stages receive it. */
function cloudDeps(store, extra = {}) {
  return {
    readAssetIndex: store.readAssetIndex,
    readAssetDocument: store.readAssetDocument,
    writeAssetDocument: store.writeAssetDocument,
    timestamp: store.timestamp,
    ...extra,
  };
}

/** `observations` agreeing passes, the first of them `agedMs` ago. */
async function seedObservation(workspaceId, assetId, { agedMs, observations = MIN_AGREEING_OBSERVATIONS, at = T0 }) {
  const first = at - agedMs;
  for (let i = 0; i < observations; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await applyGcObservations(workspaceId, { observe: [assetId] }, { now: () => (i === 0 ? first : at) });
  }
}

function sweep(options = {}) {
  return runAssetGcSweep({
    workspaceId: WS,
    facts: GOOD_FACTS,
    role: MEMBER_ROLE.OWNER,
    now: () => T0,
    ...options,
  });
}

beforeEach(async () => {
  window.localStorage.clear();
  __resetDurableStorageForTests();
  __resetAssetProtectionForTests();
  await deleteAssetDb();
  seedScope({ [DURABLE_KEYS.noteContent]: {} });
});

/* ------------------------------- the clocks ------------------------------- */

describe("maturity", () => {
  const at = T0;

  test("no observation at all is never mature", () => {
    expect(isMatureObservation(null, { now: at })).toBe(false);
    expect(isMatureObservation(undefined, { now: at })).toBe(false);
  });

  test("ONE observation is never mature, however old it is", () => {
    const old = { firstUnreferencedAt: at - 100 * HOUR, lastObservedAt: at, observations: 1 };
    expect(isMatureObservation(old, { now: at })).toBe(false);
  });

  test("TWO observations inside the 48 hours are never mature, however many there are", () => {
    const young = { firstUnreferencedAt: at - 47 * HOUR, lastObservedAt: at, observations: 2 };
    expect(isMatureObservation(young, { now: at })).toBe(false);
    expect(isMatureObservation({ ...young, observations: 40 }, { now: at })).toBe(false);
  });

  test("48 hours AND two agreeing passes is the rule, and nothing less is", () => {
    const mature = { firstUnreferencedAt: at - UNREFERENCED_GRACE_MS, lastObservedAt: at, observations: 2 };
    expect(isMatureObservation(mature, { now: at })).toBe(true);
    expect(isMatureObservation({ ...mature, observations: 1 }, { now: at })).toBe(false);
    expect(isMatureObservation({ ...mature, firstUnreferencedAt: at - 47.9 * HOUR }, { now: at })).toBe(false);
  });

  test("a FIRST-SEEN time in the future is a moved clock, never maturity", () => {
    const skewed = { firstUnreferencedAt: at + 10 * HOUR, lastObservedAt: at, observations: 5 };
    expect(isMatureObservation(skewed, { now: at })).toBe(false);
  });

  test("a missing or nonsense clock is not maturity either", () => {
    expect(isMatureObservation({ firstUnreferencedAt: 0, observations: 9 }, { now: at })).toBe(false);
    expect(isMatureObservation({ firstUnreferencedAt: NaN, observations: 9 }, { now: at })).toBe(false);
    expect(isMatureObservation({ firstUnreferencedAt: at - 100 * HOUR, observations: NaN }, { now: at })).toBe(false);
  });
});

describe("the ~24-hour cadence", () => {
  test("a workspace that has never been swept may be swept", () => {
    expect(evaluateSweepCadence({ run: null, now: T0 })).toEqual({ ok: true, reason: SWEEP_GATE.OK });
    expect(evaluateSweepCadence({ run: { workspaceId: WS }, now: T0 })).toEqual({ ok: true, reason: SWEEP_GATE.OK });
  });

  test("a successful sweep holds the workspace for ~24 hours and then releases it", () => {
    const run = { lastSweepAt: T0 - 23 * HOUR };
    expect(evaluateSweepCadence({ run, now: T0 })).toEqual({ ok: false, reason: SWEEP_GATE.CADENCE });
    expect(evaluateSweepCadence({ run: { lastSweepAt: T0 - SWEEP_CADENCE_MS }, now: T0 })).toEqual({
      ok: true,
      reason: SWEEP_GATE.OK,
    });
  });

  test("a lastSweepAt in the FUTURE blocks — the conservative reading of a moved clock", () => {
    expect(evaluateSweepCadence({ run: { lastSweepAt: T0 + HOUR }, now: T0 })).toEqual({
      ok: false,
      reason: SWEEP_GATE.CADENCE,
    });
  });
});

describe("ownership is a role, and only the owner's", () => {
  test("only the owner role passes the client policy", () => {
    expect(isWorkspaceOwner(MEMBER_ROLE.OWNER)).toBe(true);
    expect(isWorkspaceOwner(MEMBER_ROLE.MEMBER)).toBe(false);
    expect(isWorkspaceOwner(null)).toBe(false);
    expect(isWorkspaceOwner("Owner")).toBe(false);
  });
});

/* ------------------------------ pure planning ----------------------------- */

describe("planning a sweep writes nothing and concludes only from maturity", () => {
  const plan = Object.freeze({
    gate: { ok: true, reason: GC_GATE.OK },
    degraded: null,
    classes: { unreferencedStored: ["ripe-1", "green-1"] },
  });

  test("it splits candidates on the two-part rule", () => {
    const observations = [
      { workspaceId: WS, assetId: "ripe-1", firstUnreferencedAt: T0 - 60 * HOUR, observations: 3 },
      { workspaceId: WS, assetId: "green-1", firstUnreferencedAt: T0 - 60 * HOUR, observations: 1 },
    ];
    expect(planAssetGcSweep({ plan, observations, now: T0 })).toEqual({
      mature: ["ripe-1"],
      immature: ["green-1"],
    });
  });

  test("a candidate with no observation at all is immature, never mature", () => {
    expect(planAssetGcSweep({ plan, observations: [], now: T0 })).toEqual({
      mature: [],
      immature: ["ripe-1", "green-1"],
    });
  });

  test("a DEGRADED or refused plan matures nothing", () => {
    const observations = [{ workspaceId: WS, assetId: "ripe-1", firstUnreferencedAt: T0 - 60 * HOUR, observations: 3 }];
    expect(
      planAssetGcSweep({ plan: { ...plan, degraded: GC_DEGRADED.MALFORMED_ASSET_DOCUMENT }, observations, now: T0 })
    ).toEqual({ mature: [], immature: [] });
    expect(
      planAssetGcSweep({ plan: { ...plan, gate: { ok: false, reason: GC_GATE.OFFLINE } }, observations, now: T0 })
    ).toEqual({ mature: [], immature: [] });
  });
});

/* ------------------------- the grace period, end to end ------------------- */

describe("the 48-hour grace period", () => {
  test("the FIRST time an asset is seen unreferenced, nothing is tombstoned", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = cloudDeps(store);

    // One real mark pass: it creates the observation and writes nothing else.
    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps, now: () => T0 });
    const result = await sweep({ deps });

    expect(result.gate.ok).toBe(true);
    expect(result.tombstoned).toEqual([]);
    expect(result.immature).toEqual(["orphan-1"]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
    expect(store.byId.get("orphan-1").state).toBe(CLOUD_ASSET_STATE.STORED);
  });

  test("a SECOND agreeing pass inside the 48 hours still does not tombstone", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = cloudDeps(store);
    await seedObservation(WS, "orphan-1", { agedMs: 47 * HOUR, observations: 2 });

    const result = await sweep({ deps });
    expect(result.tombstoned).toEqual([]);
    expect(result.immature).toEqual(["orphan-1"]);
    expect(store.byId.get("orphan-1").state).toBe(CLOUD_ASSET_STATE.STORED);
  });

  test("48 hours with only ONE agreeing pass does not tombstone", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = cloudDeps(store);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 1 });

    const result = await sweep({ deps });
    expect(result.tombstoned).toEqual([]);
    expect(result.immature).toEqual(["orphan-1"]);
  });

  test("48 hours AND two agreeing passes tombstones — once, and only that", async () => {
    const store = fakeStore([storedDoc("orphan-1"), storedDoc("orphan-2")]);
    const deps = cloudDeps(store);
    await seedObservation(WS, "orphan-1", { agedMs: 49 * HOUR, observations: 2 });
    await seedObservation(WS, "orphan-2", { agedMs: 2 * HOUR, observations: 2 });

    const result = await sweep({ deps });

    expect(result.tombstoned).toEqual(["orphan-1"]);
    expect(result.immature).toEqual(["orphan-2"]);
    expect(result.swept).toBe(true);
    const written = store.byId.get("orphan-1");
    expect(written.state).toBe(CLOUD_ASSET_STATE.TOMBSTONED);
    // The tombstone clock is the STORE's, never this client's.
    expect(written.tombstonedAt).toBe(STAMPED_AT);
    // Its description is untouched: the object is immutable, so this is too.
    expect(written.size).toBe(1024);
    expect(written.assetKind).toBe("editor-image");
    expect(store.byId.get("orphan-2").state).toBe(CLOUD_ASSET_STATE.STORED);
    // Exactly one write, for exactly one asset.
    expect(store.calls.filter((c) => c.op === "writeAssetDocument")).toHaveLength(1);
  });

  test("firstUnreferencedAt never moves forward, so repeated passes cannot restart the clock", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = cloudDeps(store);

    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps, now: () => T0 });
    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps, now: () => T0 + HOUR });
    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps, now: () => T0 + 2 * HOUR });

    const row = await getGcObservation(WS, "orphan-1");
    expect(row.firstUnreferencedAt).toBe(T0);
    expect(row.observations).toBe(3);
    // Three agreeing passes in two hours still buy nothing: the elapsed time
    // is the other half of the rule.
    expect((await sweep({ deps, now: () => T0 + 2 * HOUR })).tombstoned).toEqual([]);
    // And the same three passes, read 48 hours later, do.
    expect((await sweep({ deps, now: () => T0 + UNREFERENCED_GRACE_MS })).tombstoned).toEqual(["orphan-1"]);
  });

  test("an asset referenced again has its observation cleared, and matures no further", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = cloudDeps(store);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 4 });

    // The reference reappears — an undo, a restored note, a second device.
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="orphan-1"></p>' } });
    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps, now: () => T0 });

    expect(await getGcObservation(WS, "orphan-1")).toBeNull();
    const result = await sweep({ deps });
    expect(result.tombstoned).toEqual([]);
    expect(result.candidates).toBe(0);
    expect(store.byId.get("orphan-1").state).toBe(CLOUD_ASSET_STATE.STORED);
  });

  test("an asset whose cloud document is gone has its observation cleared", async () => {
    const store = fakeStore([]);
    const deps = cloudDeps(store);
    await seedObservation(WS, "vanished-1", { agedMs: 72 * HOUR, observations: 4 });

    await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps, now: () => T0 });

    expect(await getGcObservation(WS, "vanished-1")).toBeNull();
    expect((await sweep({ deps })).tombstoned).toEqual([]);
  });

  test("a DEGRADED pass matures nothing and sweeps nothing", async () => {
    // One document in the listing does not validate, so the mark set may be
    // missing a rendition edge and every conclusion from it is partial.
    const store = fakeStore([storedDoc("orphan-1"), { id: "broken-1", fields: { nope: true } }]);
    const deps = cloudDeps(store);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 4 });

    const mark = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps, now: () => T0 });
    expect(mark.degraded).toBe(GC_DEGRADED.MALFORMED_ASSET_DOCUMENT);
    // The clock is paused, not reset: the standing observation survives.
    const row = await getGcObservation(WS, "orphan-1");
    expect(row.firstUnreferencedAt).toBe(T0 - 72 * HOUR);
    expect(row.observations).toBe(4);

    const result = await sweep({ deps });
    expect(result.gate).toEqual({ ok: false, reason: SWEEP_GATE.DEGRADED });
    expect(result.tombstoned).toEqual([]);
    expect(result.swept).toBe(false);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });
});

/* --------------------------- authority and races -------------------------- */

describe("every fact is re-established immediately before the write", () => {
  async function ripe(store, id = "orphan-1") {
    await seedObservation(WS, id, { agedMs: 72 * HOUR, observations: 3 });
    return cloudDeps(store);
  }

  test("the AUTHORITATIVE document read is the operation immediately before the write", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = await ripe(store);
    await sweep({ deps });

    const index = store.calls.findIndex((c) => c.op === "writeAssetDocument");
    expect(index).toBeGreaterThan(0);
    expect(store.calls[index - 1]).toMatchObject({ op: "readAssetDocument", assetId: "orphan-1" });
  });

  test("a DURABLE reference that appears between the plan and the write stops the tombstone", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = await ripe(store);
    let restored = false;
    const result = await sweep({
      deps: {
        ...deps,
        // The recomputation the sweep makes for THIS candidate — the user's
        // undo lands a moment before it.
        protectedSet: async (options) => {
          if (!restored) {
            restored = true;
            seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="orphan-1"></p>' } });
          }
          const { collectProtectedAssetIds } = require("./assetGarbageCollection");
          return collectProtectedAssetIds(options);
        },
      },
    });

    expect(result.tombstoned).toEqual([]);
    expect(result.protectedAgain).toEqual(["orphan-1"]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
    expect(store.byId.get("orphan-1").state).toBe(CLOUD_ASSET_STATE.STORED);
  });

  test("a DRAFT protection taken between the plan and the write stops the tombstone", async () => {
    const store = fakeStore([storedDoc("logo-1")]);
    await seedObservation(WS, "logo-1", { agedMs: 72 * HOUR, observations: 3 });
    let held = false;
    const result = await sweep({
      deps: {
        ...cloudDeps(store),
        protectedSet: async (options) => {
          if (!held) {
            held = true;
            protectAsset(WS, "logo-1");
          }
          const { collectProtectedAssetIds } = require("./assetGarbageCollection");
          return collectProtectedAssetIds(options);
        },
      },
    });

    expect(result.protectedAgain).toEqual(["logo-1"]);
    expect(store.byId.get("logo-1").state).toBe(CLOUD_ASSET_STATE.STORED);
  });

  test("a cloud state that changed under the pass stops the tombstone, and nothing is overwritten", async () => {
    const store = fakeStore([storedDoc("orphan-1")], {
      // Another device tombstoned it between the listing and the re-read.
      beforeDocumentRead: (s, assetId) => {
        if (assetId === "orphan-1" && s.byId.get(assetId).state === CLOUD_ASSET_STATE.STORED) {
          s.byId.set(assetId, tombstonedDoc(assetId).fields);
        }
      },
    });
    const deps = await ripe(store);

    const result = await sweep({ deps });
    expect(result.tombstoned).toEqual([]);
    expect(result.changed).toEqual(["orphan-1"]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
    // The other device's tombstone clock is untouched.
    expect(store.byId.get("orphan-1").tombstonedAt).toBe(3000);
  });

  test("a document that vanished under the pass is reported, never fabricated", async () => {
    const store = fakeStore([storedDoc("orphan-1")], {
      beforeDocumentRead: (s, assetId) => s.byId.delete(assetId),
    });
    const deps = await ripe(store);

    const result = await sweep({ deps });
    expect(result.absent).toEqual(["orphan-1"]);
    expect(result.tombstoned).toEqual([]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });

  test("a document that stopped validating under the pass is never overwritten", async () => {
    const store = fakeStore([storedDoc("orphan-1")], {
      beforeDocumentRead: (s, assetId) => s.byId.set(assetId, { broken: true }),
    });
    const deps = await ripe(store);

    const result = await sweep({ deps });
    expect(result.malformed).toEqual(["orphan-1"]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });

  test("an observation cleared under the pass stops the tombstone", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = await ripe(store);
    const result = await sweep({
      deps: {
        ...deps,
        // A concurrent mark pass forgot the observation between the plan and
        // the write: the clock has restarted and this asset is not mature.
        readObservation: async () => null,
      },
    });
    expect(result.immature).toEqual(["orphan-1"]);
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });

  test("a session that ends mid-pass stops the remaining writes", async () => {
    const store = fakeStore([storedDoc("orphan-1"), storedDoc("orphan-2"), storedDoc("orphan-3")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });
    await seedObservation(WS, "orphan-2", { agedMs: 72 * HOUR, observations: 3 });
    await seedObservation(WS, "orphan-3", { agedMs: 72 * HOUR, observations: 3 });
    let live = true;

    const result = await sweep({
      deps: {
        ...cloudDeps(store),
        writeAssetDocument: async (workspaceId, assetId, fields) => {
          await store.writeAssetDocument(workspaceId, assetId, fields);
          live = false; // signed out, or another account opened
        },
      },
      isActive: () => live,
    });

    expect(result.stopped).toBe(true);
    expect(result.tombstoned).toHaveLength(1);
    expect(store.calls.filter((c) => c.op === "writeAssetDocument")).toHaveLength(1);
    // A stopped sweep is not a completed one: the cadence token is unspent.
    expect(result.swept).toBe(false);
    expect(await readAssetGcRun(WS)).toBeNull();
  });

  test("the LOCAL remote index is never the authority, in either direction", async () => {
    // The index says the opposite of the cloud about both assets. The
    // conclusion must come from the listing and the document alone.
    await putRemoteAssetEntry(
      makeRemoteAssetEntry({ workspaceId: WS, assetId: "orphan-1", state: REMOTE_ASSET_STATE.TOMBSTONED })
    );
    await putRemoteAssetEntry(
      makeRemoteAssetEntry({ workspaceId: WS, assetId: "already-1", state: REMOTE_ASSET_STATE.STORED })
    );
    const store = fakeStore([storedDoc("orphan-1"), tombstonedDoc("already-1")]);
    const deps = await ripe(store);
    await seedObservation(WS, "already-1", { agedMs: 72 * HOUR, observations: 3 });

    const result = await sweep({ deps });

    // orphan-1 is `stored` in the cloud and is swept; already-1 is already
    // tombstoned and is not a candidate at all.
    expect(result.tombstoned).toEqual(["orphan-1"]);
    expect(store.byId.get("already-1").tombstonedAt).toBe(3000);
    // And the index is CORRECTED from the confirmed write, never consulted.
    expect((await getRemoteAssetEntry(WS, "orphan-1")).state).toBe(REMOTE_ASSET_STATE.TOMBSTONED);
  });

  test("a confirmed write forgets the pre-tombstone observation", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    const deps = await ripe(store);
    await sweep({ deps });
    expect(await getGcObservation(WS, "orphan-1")).toBeNull();
  });

  test("a transient write failure keeps the observation and leaves the asset stored", async () => {
    const store = fakeStore([storedDoc("orphan-1")], { writeFails: "unavailable" });
    const deps = await ripe(store);

    const result = await sweep({ deps });
    expect(result.failed).toEqual(["orphan-1"]);
    expect(result.tombstoned).toEqual([]);
    expect(store.byId.get("orphan-1").state).toBe(CLOUD_ASSET_STATE.STORED);
    expect(await getGcObservation(WS, "orphan-1")).not.toBeNull();
  });
});

/* -------------------------------- ownership ------------------------------- */

describe("only the workspace owner tombstones", () => {
  test("the owner sweeps", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });
    const result = await sweep({ deps: cloudDeps(store), role: MEMBER_ROLE.OWNER });
    expect(result.owner).toBe(true);
    expect(result.tombstoned).toEqual(["orphan-1"]);
  });

  test("a MEMBER never tombstones, and reads nothing to find that out", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });

    const result = await sweep({ deps: cloudDeps(store), role: MEMBER_ROLE.MEMBER });

    expect(result.gate).toEqual({ ok: false, reason: SWEEP_GATE.NOT_OWNER });
    expect(result.owner).toBe(false);
    expect(result.tombstoned).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(store.byId.get("orphan-1").state).toBe(CLOUD_ASSET_STATE.STORED);
    // And it costs the workspace nothing: the next owner session may sweep.
    expect(await readAssetGcRun(WS)).toBeNull();
  });

  test("a member session with no role at all still never tombstones", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });
    expect((await sweep({ deps: cloudDeps(store), role: null })).gate.reason).toBe(SWEEP_GATE.NOT_OWNER);
  });

  test("a MEMBER can still RESURRECT — restoring is safe and stays open to every member", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: { "note-1": '<p><img data-asset-id="img-1"></p>' } });
    const store = fakeStore([tombstonedDoc("img-1")]);
    const deps = cloudDeps(store);

    // The mark pass takes no role at all: this is the member's session.
    const mark = await runAssetGcMarkPass({ workspaceId: WS, facts: GOOD_FACTS, deps, now: () => T0 });
    expect(mark.resurrected).toEqual(["img-1"]);
    expect(store.byId.get("img-1").state).toBe(CLOUD_ASSET_STATE.STORED);

    const result = await sweep({ deps, role: MEMBER_ROLE.MEMBER });
    expect(result.gate.reason).toBe(SWEEP_GATE.NOT_OWNER);
  });

  test("a service REFUSAL is authoritative: the sweep stops there and does not loop", async () => {
    const store = fakeStore([storedDoc("orphan-1"), storedDoc("orphan-2")], { writeFails: "permission-denied" });
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });
    await seedObservation(WS, "orphan-2", { agedMs: 72 * HOUR, observations: 3 });

    const result = await sweep({ deps: cloudDeps(store) });

    expect(result.gate).toEqual({ ok: false, reason: SWEEP_GATE.REFUSED });
    expect(result.refused).toHaveLength(1);
    // ONE attempt, not one per candidate.
    expect(store.calls.filter((c) => c.op === "writeAssetDocument")).toHaveLength(1);
    expect(result.swept).toBe(false);
    // Its observation survives, so a session that IS allowed still has the
    // accumulated grace to act on.
    expect(await getGcObservation(WS, "orphan-1")).not.toBeNull();
    expect(await readAssetGcRun(WS)).toBeNull();
  });
});

/* --------------------------------- cadence -------------------------------- */

describe("at most one SUCCESSFUL sweep per workspace per ~24 hours", () => {
  test("a completed sweep records the workspace's own lastSweepAt", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });

    const result = await sweep({ deps: cloudDeps(store) });
    expect(result.swept).toBe(true);
    const run = await readAssetGcRun(WS);
    expect(run.lastSweepAt).toBe(T0);
    expect(run.workspaceId).toBe(WS);
  });

  test("a sweep with NOTHING to do still completes, and still holds the workspace", async () => {
    const store = fakeStore([]);
    const result = await sweep({ deps: cloudDeps(store) });
    expect(result.swept).toBe(true);
    expect((await readAssetGcRun(WS)).lastSweepAt).toBe(T0);
  });

  test("a second attempt inside the window skips without reading the cloud at all", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });
    await sweep({ deps: cloudDeps(store) });
    const before = store.calls.length;

    const second = await sweep({ deps: cloudDeps(store), now: () => T0 + 23 * HOUR });
    expect(second.gate).toEqual({ ok: false, reason: SWEEP_GATE.CADENCE });
    expect(store.calls).toHaveLength(before);
  });

  test("an attempt at or past the window proceeds", async () => {
    const store = fakeStore([storedDoc("orphan-1"), storedDoc("orphan-2")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });
    await sweep({ deps: cloudDeps(store) });
    await seedObservation(WS, "orphan-2", { agedMs: 72 * HOUR, observations: 3, at: T0 });

    const later = await sweep({ deps: cloudDeps(store), now: () => T0 + SWEEP_CADENCE_MS });
    expect(later.gate.ok).toBe(true);
    expect(later.tombstoned).toEqual(["orphan-2"]);
    expect((await readAssetGcRun(WS)).lastSweepAt).toBe(T0 + SWEEP_CADENCE_MS);
  });

  test("a GATED-OUT attempt spends nothing: the next settled session may still sweep", async () => {
    const store = fakeStore([storedDoc("orphan-1")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });

    const blocked = await sweep({
      deps: cloudDeps(store),
      facts: { ...GOOD_FACTS, outboxPending: 2 },
    });
    expect(blocked.gate).toEqual({ ok: false, reason: GC_GATE.OUTBOX_PENDING });
    expect(blocked.swept).toBe(false);
    expect(await readAssetGcRun(WS)).toBeNull();

    const settled = await sweep({ deps: cloudDeps(store) });
    expect(settled.tombstoned).toEqual(["orphan-1"]);
  });

  test.each([
    ["uploads still owed", { pending: [{ workspaceId: WS, assetId: "queued-1", kind: "editor-image" }] }],
    ["an unreadable listing", { readFails: "index" }],
  ])("%s consumes no cadence and writes nothing", async (_label, setup) => {
    const store = fakeStore([storedDoc("orphan-1")], setup.readFails ? { readFails: setup.readFails } : {});
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });

    const result = await sweep({
      deps: {
        ...cloudDeps(store),
        ...(setup.pending ? { listPendingUploads: async () => setup.pending } : {}),
      },
    });

    expect(result.gate.ok).toBe(false);
    expect(result.swept).toBe(false);
    expect(await readAssetGcRun(WS)).toBeNull();
    expect(store.calls.some((c) => c.op === "writeAssetDocument")).toBe(false);
  });

  test("one workspace's cadence never holds another's", async () => {
    seedScope({ [DURABLE_KEYS.noteContent]: {} }, { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS_B });
    const storeA = fakeStore([storedDoc("orphan-1")]);
    await seedObservation(WS, "orphan-1", { agedMs: 72 * HOUR, observations: 3 });
    await sweep({ deps: cloudDeps(storeA) });
    expect((await readAssetGcRun(WS)).lastSweepAt).toBe(T0);

    const storeB = fakeStore([storedDoc("orphan-b", { workspaceId: WS_B })]);
    storeB.workspaceId = WS_B;
    await seedObservation(WS_B, "orphan-b", { agedMs: 72 * HOUR, observations: 3 });

    const b = await sweep({ workspaceId: WS_B, deps: cloudDeps(storeB) });
    expect(b.gate.ok).toBe(true);
    expect(b.tombstoned).toEqual(["orphan-b"]);
    // And A's record is its own.
    expect((await readAssetGcRun(WS)).lastSweepAt).toBe(T0);
  });

  test("an existing run record's other fields survive the sweep's own stamp", async () => {
    await writeAssetGcRun(WS, { lastMarkPassGate: GC_GATE.OK, lastResurrectedCount: 4 }, { now: () => T0 - HOUR });
    const store = fakeStore([]);
    await sweep({ deps: cloudDeps(store) });
    const run = await readAssetGcRun(WS);
    expect(run.lastResurrectedCount).toBe(4);
    expect(run.lastSweepAt).toBe(T0);
  });
});

/* ---------------------------------- status -------------------------------- */

describe("what Settings says about it", () => {
  const done = (sweepResult, markResult = { gate: { ok: true, reason: GC_GATE.OK }, degraded: null }) => ({
    phase: GC_SWEEP_PHASE.DONE,
    result: markResult,
    sweep: sweepResult,
  });

  test("nothing at all is said while it is running, or before it has run", () => {
    expect(assetGcStatusLine(null)).toBe("");
    expect(assetGcStatusLine({ phase: GC_SWEEP_PHASE.IDLE, result: null, sweep: null })).toBe("");
    expect(assetGcStatusLine({ phase: GC_SWEEP_PHASE.RUNNING, result: null, sweep: null })).toBe("");
  });

  test("a healthy pass with nothing to do says nothing", () => {
    const status = done({ gate: { ok: true, reason: SWEEP_GATE.OK }, tombstoned: [], swept: true });
    expect(assetGcStatusLine(status)).toBe("");
    expect(assetGcAttentionLine(status)).toBe("");
    expect(isAssetGcPaused(status)).toBe(false);
  });

  test("what it DID say counts whole files, claims no deletion, and has no percentage", () => {
    const one = done({ gate: { ok: true, reason: SWEEP_GATE.OK }, tombstoned: ["a"], swept: true });
    const many = done({ gate: { ok: true, reason: SWEEP_GATE.OK }, tombstoned: ["a", "b", "c"], swept: true });

    // The reference universe is the whole workspace — notes, template
    // instances, retained template versions, the current PDF sources and the
    // rendition closure — so the sentence must not name only notes.
    expect(assetGcStatusLine(one)).toBe("1 file is no longer in use");
    expect(assetGcStatusLine(many)).toBe("3 files are no longer in use");
    expect(assetGcStatusLine(many)).not.toMatch(/your notes/);
    for (const line of [assetGcStatusLine(one), assetGcStatusLine(many), assetGcAttentionLine(one)]) {
      expect(line).not.toMatch(/delete|removed|erase|permanent/i);
      expect(line).not.toMatch(/%/);
    }
  });

  test("a workspace that could not be read in full says so, once, and not twice", () => {
    const degraded = done({ gate: { ok: false, reason: SWEEP_GATE.DEGRADED }, tombstoned: [], swept: false });
    expect(isAssetGcPaused(degraded)).toBe(true);
    expect(assetGcAttentionLine(degraded)).toBe(
      "Checking for unused files is paused until your workspace can be read in full."
    );
    // The status line stays quiet: one condition, one sentence.
    expect(assetGcStatusLine(degraded)).toBe("");

    const quarantined = {
      phase: GC_SWEEP_PHASE.SKIPPED,
      result: { gate: { ok: false, reason: GC_GATE.CORRUPT_REFERENCES }, degraded: null },
      sweep: null,
    };
    expect(assetGcAttentionLine(quarantined)).toMatch(/paused/);

    const malformedHydration = {
      phase: GC_SWEEP_PHASE.SKIPPED,
      result: { gate: { ok: false, reason: GC_GATE.HYDRATION_MALFORMED }, degraded: null },
      sweep: null,
    };
    expect(isAssetGcPaused(malformedHydration)).toBe(true);
  });

  test("unfinished LOCAL work is a waiting line, and offline or unconfigured is silence", () => {
    const waiting = {
      phase: GC_SWEEP_PHASE.SKIPPED,
      result: { gate: { ok: false, reason: GC_GATE.UPLOADS_PENDING }, degraded: null },
      sweep: null,
    };
    expect(assetGcStatusLine(waiting)).toBe("Unused files will be checked once everything has finished saving.");
    expect(assetGcAttentionLine(waiting)).toBe("");

    for (const reason of [GC_GATE.OFFLINE, GC_GATE.UNCONFIGURED, GC_GATE.NO_SESSION]) {
      const quiet = {
        phase: GC_SWEEP_PHASE.SKIPPED,
        result: { gate: { ok: false, reason }, degraded: null },
        sweep: null,
      };
      expect(assetGcStatusLine(quiet)).toBe("");
      expect(assetGcAttentionLine(quiet)).toBe("");
    }
  });

  test("a cadence skip and a non-owner skip are both silent — neither is news", () => {
    for (const reason of [SWEEP_GATE.CADENCE, SWEEP_GATE.NOT_OWNER]) {
      const status = done({ gate: { ok: false, reason }, tombstoned: [], swept: false });
      expect(assetGcStatusLine(status)).toBe("");
      expect(assetGcAttentionLine(status)).toBe("");
    }
  });

  test("a pass that threw says it will try again, and promises nothing else", () => {
    const line = assetGcStatusLine({ phase: GC_SWEEP_PHASE.ERROR, result: null, sweep: null });
    expect(line).toBe("Unused files could not be checked. NoteWise will try again next time you sign in.");
    expect(line).not.toMatch(/delete|%/i);
  });
});

/* ------------------------------- no deletion ------------------------------ */

describe("nothing in this phase can delete anything (source)", () => {
  /**
   * The module's CODE, with every comment removed. These modules say the word
   * "delete" repeatedly — explaining what they must never do — and a scan that
   * could not tell an explanation from a call would pass or fail for the wrong
   * reason.
   */
  const codeOnly = (file) =>
    fs
      .readFileSync(path.join(__dirname, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");

  const SWEEP_SOURCE = codeOnly("assetGcSweep.js");
  const MARK_SOURCE = codeOnly("assetGarbageCollection.js");

  test("no Storage object delete is reachable", () => {
    for (const source of [SWEEP_SOURCE, MARK_SOURCE]) {
      expect(source).not.toMatch(/firebaseStorageAdapter/);
      expect(source).not.toMatch(/deleteAsset\b/);
      expect(source).not.toMatch(/deleteObject/);
    }
  });

  test("no Firestore asset-document delete is reachable", () => {
    for (const source of [SWEEP_SOURCE, MARK_SOURCE]) {
      expect(source).not.toMatch(/deleteAssetDocument/);
      expect(source).not.toMatch(/firestoreWorkspaceStore/);
    }
  });

  test("no local asset cache removal is reachable", () => {
    // `deleteGcObservation` is the ledger row, not an asset, and is the only
    // delete of any kind in the module.
    expect(SWEEP_SOURCE).not.toMatch(/removeAsset|deleteLocalAsset|localAssetCache/);
    expect(new Set(SWEEP_SOURCE.match(/delete[A-Z]\w*/g))).toEqual(new Set(["deleteGcObservation"]));
  });

  test("the one cloud write the sweep makes is the model's own tombstone transition", () => {
    expect(SWEEP_SOURCE).toMatch(/tombstoneAssetDocument\(doc\.fields, d\.timestamp\(\)\)/);
    // Never a hand-built document, and never a client clock for the tombstone.
    expect(SWEEP_SOURCE).not.toMatch(/state: CLOUD_ASSET_STATE\.TOMBSTONED/);
    expect(SWEEP_SOURCE).not.toMatch(/tombstonedAt: Date\.now/);
  });

  test("there is no timer, no interval and no polling loop", () => {
    for (const source of [SWEEP_SOURCE, MARK_SOURCE]) {
      expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    }
  });
});
