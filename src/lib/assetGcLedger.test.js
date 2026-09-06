// src/lib/assetGcLedger.test.js
//
// THE CLOCK THAT MUST NOT RESTART (Production Readiness Phase 7.9A).
//
// The approved lifecycle gives a newly unreferenced cloud asset 48 hours
// before it may be tombstoned. That period is only real if the FIRST
// observation survives every later pass: an implementation that rewrote
// `firstUnreferencedAt` on each pass would keep the clock permanently at zero
// and the grace period would never expire — or, written the other way, a
// forgotten observation would restart it. Both are proved here against a real
// IndexedDB.
import "fake-indexeddb/auto";
import {
  applyGcObservations,
  clearWorkspaceGcObservations,
  deleteGcObservation,
  getGcObservation,
  listGcObservations,
  makeGcObservation,
  readAssetGcRun,
  writeAssetGcRun,
} from "./assetGcLedger";
import { deleteAssetDb, installStructuredCloneShim } from "./assetDbTestHarness";

installStructuredCloneShim();

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";

const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  await deleteAssetDb();
});

describe("one observation", () => {
  test("is created at the first pass and carries its own first-seen clock", async () => {
    const applied = await applyGcObservations(WS_A, { observe: ["asset-1"] }, { now: () => 1000 });
    expect(applied).toEqual({ created: ["asset-1"], carried: [], forgotten: [] });
    expect(await getGcObservation(WS_A, "asset-1")).toEqual({
      workspaceId: WS_A,
      assetId: "asset-1",
      firstUnreferencedAt: 1000,
      lastObservedAt: 1000,
      observations: 1,
    });
  });

  test("KEEPS its firstUnreferencedAt across repeated passes, and counts them", async () => {
    await applyGcObservations(WS_A, { observe: ["asset-1"] }, { now: () => 1000 });
    const second = await applyGcObservations(WS_A, { observe: ["asset-1"] }, { now: () => 1000 + 20 * HOUR });
    const third = await applyGcObservations(WS_A, { observe: ["asset-1"] }, { now: () => 1000 + 50 * HOUR });

    expect(second.carried).toEqual(["asset-1"]);
    expect(third.carried).toEqual(["asset-1"]);
    expect(second.created).toEqual([]);
    const row = await getGcObservation(WS_A, "asset-1");
    // The whole point: three passes, one clock, started at the first.
    expect(row.firstUnreferencedAt).toBe(1000);
    expect(row.lastObservedAt).toBe(1000 + 50 * HOUR);
    expect(row.observations).toBe(3);
  });

  test("is forgotten on request, and a later pass starts a NEW clock", async () => {
    await applyGcObservations(WS_A, { observe: ["asset-1"] }, { now: () => 1000 });
    const cleared = await applyGcObservations(WS_A, { forget: ["asset-1"] }, { now: () => 2000 });
    expect(cleared.forgotten).toEqual(["asset-1"]);
    expect(await getGcObservation(WS_A, "asset-1")).toBeNull();

    await applyGcObservations(WS_A, { observe: ["asset-1"] }, { now: () => 90 * HOUR });
    expect((await getGcObservation(WS_A, "asset-1")).firstUnreferencedAt).toBe(90 * HOUR);
    expect((await getGcObservation(WS_A, "asset-1")).observations).toBe(1);
  });

  test("observing wins over forgetting when a caller asks for both", async () => {
    await applyGcObservations(WS_A, { observe: ["asset-1"] }, { now: () => 1000 });
    const applied = await applyGcObservations(
      WS_A,
      { observe: ["asset-1"], forget: ["asset-1"] },
      { now: () => 5000 }
    );
    expect(applied.forgotten).toEqual([]);
    expect((await getGcObservation(WS_A, "asset-1")).firstUnreferencedAt).toBe(1000);
  });

  test("an id that could never be an asset path segment is skipped, not thrown on", async () => {
    const applied = await applyGcObservations(
      WS_A,
      { observe: ["../escape", "asset-1"], forget: ["also/bad"] },
      { now: () => 1000 }
    );
    expect(applied.created).toEqual(["asset-1"]);
    expect(await listGcObservations(WS_A)).toHaveLength(1);
  });
});

describe("workspace isolation", () => {
  test("one workspace's observations are never read, written or cleared through another's", async () => {
    await applyGcObservations(WS_A, { observe: ["shared-id"] }, { now: () => 1000 });
    await applyGcObservations(WS_B, { observe: ["shared-id"] }, { now: () => 7000 });

    expect((await getGcObservation(WS_A, "shared-id")).firstUnreferencedAt).toBe(1000);
    expect((await getGcObservation(WS_B, "shared-id")).firstUnreferencedAt).toBe(7000);
    expect(await listGcObservations(WS_A)).toHaveLength(1);

    // Forgetting in A leaves B exactly as it was — the same asset id in two
    // accounts on one browser is two independent rows.
    await applyGcObservations(WS_A, { forget: ["shared-id"] }, { now: () => 8000 });
    expect(await getGcObservation(WS_A, "shared-id")).toBeNull();
    expect((await getGcObservation(WS_B, "shared-id")).firstUnreferencedAt).toBe(7000);

    await clearWorkspaceGcObservations(WS_B);
    expect(await listGcObservations(WS_B)).toEqual([]);
  });

  test("every operation refuses a workspace id that is not a valid asset segment", async () => {
    await expect(getGcObservation("../other", "asset-1")).rejects.toThrow(/valid workspace id/);
    await expect(listGcObservations("")).rejects.toThrow(/valid workspace id/);
    await expect(applyGcObservations(null, { observe: ["asset-1"] })).rejects.toThrow(/valid workspace id/);
  });
});

describe("the record builder", () => {
  test("defaults the observation count and the last-seen stamp to the first", () => {
    const row = makeGcObservation({ workspaceId: WS_A, assetId: "asset-1", firstUnreferencedAt: 42 });
    expect(row).toEqual({
      workspaceId: WS_A,
      assetId: "asset-1",
      firstUnreferencedAt: 42,
      lastObservedAt: 42,
      observations: 1,
    });
  });

  test("refuses to build a row that could not be addressed", () => {
    expect(() => makeGcObservation({ workspaceId: WS_A, assetId: "../escape" })).toThrow(/valid asset id/);
  });
});

describe("deleting one observation directly", () => {
  test("removes only that row, and removing nothing is not an error", async () => {
    await applyGcObservations(WS_A, { observe: ["asset-1", "asset-2"] }, { now: () => 1000 });
    await deleteGcObservation(WS_A, "asset-1");
    expect((await listGcObservations(WS_A)).map((r) => r.assetId)).toEqual(["asset-2"]);
    await expect(deleteGcObservation(WS_A, "asset-1")).resolves.toBeUndefined();
  });
});

describe("the run record", () => {
  test("is absent until a pass writes one, then merges rather than replaces", async () => {
    expect(await readAssetGcRun(WS_A)).toBeNull();
    await writeAssetGcRun(WS_A, { lastMarkPassGate: "ok", lastResurrectedCount: 2 }, { now: () => 1000 });
    expect(await readAssetGcRun(WS_A)).toEqual({
      workspaceId: WS_A,
      lastMarkPassGate: "ok",
      lastResurrectedCount: 2,
      lastMarkPassAt: 1000,
    });

    await writeAssetGcRun(WS_A, { lastMarkPassGate: "uploads-pending" }, { now: () => 2000 });
    const merged = await readAssetGcRun(WS_A);
    expect(merged.lastMarkPassGate).toBe("uploads-pending");
    // Not dropped by a later, narrower write — which is what lets Phase 7.9B
    // add its own cadence field to the same record.
    expect(merged.lastResurrectedCount).toBe(2);
    expect(merged.lastMarkPassAt).toBe(2000);
  });

  test("nothing in it claims a sweep has happened", async () => {
    await writeAssetGcRun(WS_A, { lastMarkPassGate: "ok" }, { now: () => 1000 });
    expect(await readAssetGcRun(WS_A)).not.toHaveProperty("lastSweepAt");
  });

  test("one workspace's run record is never another's", async () => {
    await writeAssetGcRun(WS_A, { lastMarkPassGate: "ok" }, { now: () => 1000 });
    expect(await readAssetGcRun(WS_B)).toBeNull();
  });
});
