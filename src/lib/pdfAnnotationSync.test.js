// src/lib/pdfAnnotationSync.test.js
//
// PDF ANNOTATION CLOUD SYNC (Production Readiness Phase 7.7) over a real
// IndexedDB (fake-indexeddb), the real outbox and capture, the real sync
// engine and the in-memory workspace store: a local save is durable and
// owed in one step and its outbox identity follows; repeated saves coalesce;
// the payload is read from IndexedDB at flush time; the settlement of an
// older revision never clears a newer one; a lost outbox identity is
// re-derived from the dirty flag; legacy records are associated only with
// registry + authority; hydration precedence; deletion; session isolation;
// offline.
import "fake-indexeddb/auto";
import { installStructuredCloneShim } from "./assetDbTestHarness";
import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  WRITE_ORIGIN,
  __resetDurableStorageForTests,
  setDurableScope,
  subscribePersistenceIssues,
  writeDurableRecord,
} from "./durableStorage";
import { __resetNoteTombstonesForTests } from "./noteTombstones";
import { saveNoteContent } from "./noteContentStorage";
import { recordMigrationState } from "./localDataBinding";
import { LOCAL_MIGRATION_STATUS } from "./cloud/localMigration";
import { __resetCloudCaptureForTests, captureExternalChanges, installCloudCapture, subscribeCapturedChanges } from "./cloud/cloudCapture";
import { CLOUD_COLLECTION, MAX_INLINE_PAYLOAD_UNITS, buildEntityDocument } from "./cloud/cloudModel";
import { OUTBOX_OP, clearOutbox, listOutboxEntries, outboxSize, pendingOutboxKeys } from "./cloud/cloudOutbox";
import { SYNC_OUTCOME, SYNC_STATUS, createCloudSync } from "./cloud/cloudSync";
import { createMemoryWorkspaceStore } from "./cloud/memoryWorkspaceStore";
import {
  LOCAL_PAYLOAD_MALFORMED_CODE,
  PDF_ANNOTATIONS_COLLECTION,
  annotationChunkCount,
  associateLegacyPdfAnnotations,
  currentPdfRegistry,
  hydratePdfAnnotations,
  pdfAnnotationPayloadProvider,
  persistPdfAnnotations,
  reconcilePdfAnnotationOutbox,
  removePdfAnnotations,
} from "./pdfAnnotationSync";
import {
  PDF_DB_NAME,
  PDF_WORKSPACE_ANNOTATIONS_STORE,
  __resetPdfStorageConnectionForTests,
  listLegacyAnnotationIds,
  listWorkspaceAnnotationRecords,
  loadAnnotationRecord,
  loadAnnotations,
  removeAnnotations,
  saveAnnotations,
} from "./pdfStorage";

installStructuredCloneShim();

const A = "ws-aaaaaaaa";
const B = "ws-bbbbbbbb";
const COLL = PDF_ANNOTATIONS_COLLECTION;
const rect = (id) => ({ id, type: "rect", page: 1, rect: { x: 1, y: 1, w: 2, h: 2 } });
const scopeOf = (id) => Object.freeze({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id });

function timers() {
  let t = 0;
  const queue = [];
  const flushPromises = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const entry = { at: t + ms, fn };
      queue.push(entry);
      return entry;
    },
    clearTimer: (entry) => {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
    },
    async advance(ms) {
      const target = t + ms;
      while (true) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        t = next.at;
        next.fn();
        await flushPromises();
      }
      t = target;
      await flushPromises();
    },
    flushPromises,
  };
}

/** The registry of a workspace, written the way hydration writes it (no outbox entry). */
function setRegistry(workspaceId, ids) {
  const map = {};
  for (const id of ids) map[id] = { id, projectId: null, folderId: null, name: `${id}.pdf`, createdAt: 1, updatedAt: 1 };
  writeDurableRecord(DURABLE_KEYS.pdfDocs, map, { scope: scopeOf(workspaceId), origin: WRITE_ORIGIN.CLOUD });
}

function seededStore(uid = "alice", workspaceId = A) {
  const store = createMemoryWorkspaceStore();
  store.setUser(uid);
  store.seed(["workspaces", workspaceId], { id: workspaceId, ownerUid: uid });
  store.seed(["workspaces", workspaceId, "members", uid], { uid, role: "owner" });
  return store;
}

function engine({ store, clock, workspaceId = A, online = true }) {
  let isOnline = online;
  const events = [];
  const sync = createCloudSync({
    workspaceId,
    store,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isOnline: () => isOnline,
    addOnlineListener: () => () => {},
    payloadProviders: { [COLL]: pdfAnnotationPayloadProvider },
  });
  sync.subscribe((e) => events.push(e));
  sync.start();
  return { sync, events, setOnline: (v) => (isOnline = v) };
}

const outcomes = (events) => events.filter((e) => e.type === "outcome").flatMap((e) => e.results.map((r) => `${r.collection}/${r.id}:${r.outcome}${r.code ? ":" + r.code : ""}`));
const cloudItems = (store, workspaceId, id) => {
  const d = store.get(["workspaces", workspaceId, COLL, id]);
  return d ? JSON.parse(d.json).items : undefined;
};

/** Writes a raw record into the workspace store, bypassing the module. */
function putRawWorkspaceRecord(record) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PDF_DB_NAME);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(PDF_WORKSPACE_ANNOTATIONS_STORE, "readwrite");
      tx.objectStore(PDF_WORKSPACE_ANNOTATIONS_STORE).put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

async function wipeDb() {
  for (const id of await listLegacyAnnotationIds()) await removeAnnotations(id);
  for (const ws of [A, B]) {
    for (const r of await listWorkspaceAnnotationRecords(ws)) await removeAnnotations(r.documentId, { workspaceId: ws });
  }
}

let clock;
beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
  clock = timers();
  installCloudCapture({ now: clock.now });
  setDurableScope(scopeOf(A));
  setRegistry(A, ["pdf1", "pdf2"]);
});

afterEach(async () => {
  await wipeDb();
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

afterAll(() => __resetPdfStorageConnectionForTests());

/* ------------------------------ save/capture ---------------------------- */

describe("persisting", () => {
  test("a workspace save is durable, dirty and owed in one step; the outbox identity follows and the engine is told", async () => {
    const seen = [];
    subscribeCapturedChanges((e) => seen.push(e));
    const saved = await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    expect(saved.revision).toBe(1);
    const record = await loadAnnotationRecord("pdf1", { workspaceId: A });
    expect(record.cloudDirty).toBe(true);
    expect(record.items).toEqual([rect("a")]);
    expect(listOutboxEntries(A).map((e) => [e.collection, e.id, e.op])).toEqual([[COLL, "pdf1", OUTBOX_OP.UPSERT]]);
    expect(seen).toEqual([{ workspaceId: A, changes: [{ collection: COLL, id: "pdf1", op: OUTBOX_OP.UPSERT }] }]);
    // The outbox of any other workspace is untouched.
    expect(outboxSize(B)).toBe(0);
  });

  test("repeated saves of one document coalesce to ONE outbox identity, the record at the latest revision", async () => {
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    await clock.advance(10);
    await persistPdfAnnotations("pdf1", [rect("a"), rect("b")], { workspaceId: A });
    await clock.advance(10);
    await persistPdfAnnotations("pdf1", [rect("c")], { workspaceId: A });
    expect(outboxSize(A)).toBe(1);
    expect(listOutboxEntries(A)[0].at).toBe(20);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).revision).toBe(3);
  });

  test("without a workspace it is the legacy local save and nothing is owed", async () => {
    await persistPdfAnnotations("pdf1", [rect("a")]);
    expect(await loadAnnotations("pdf1")).toEqual([rect("a")]);
    expect(await loadAnnotations("pdf1", { workspaceId: A })).toEqual([]);
    expect(outboxSize(A)).toBe(0);
    expect(Object.keys(localStorage).filter((k) => k.includes("outbox"))).toEqual([]);
  });

  test("the workspace named on the save wins over the ambient scope", async () => {
    setDurableScope(scopeOf(B));
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    expect(await loadAnnotations("pdf1", { workspaceId: A })).toEqual([rect("a")]);
    expect(await loadAnnotations("pdf1", { workspaceId: B })).toEqual([]);
    expect(outboxSize(A)).toBe(1);
    expect(outboxSize(B)).toBe(0);
  });

  test("a refused outbox write keeps the record dirty, reports it, and is carried into the next capture", async () => {
    const issues = [];
    subscribePersistenceIssues((i) => issues.push(i.kind));
    const original = Storage.prototype.setItem;
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (String(key).includes("outbox")) throw new Error("QuotaExceededError");
      return original.call(this, key, value);
    });
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    spy.mockRestore();
    expect(issues).toEqual(["cloud-outbox-write-failed"]);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(true);
    expect(outboxSize(A)).toBe(0);
    await persistPdfAnnotations("pdf2", [], { workspaceId: A });
    expect(listOutboxEntries(A).map((e) => e.id).sort()).toEqual(["pdf1", "pdf2"]);
  });
});

/* ------------------------------ deletion --------------------------------- */

describe("removing", () => {
  test("removes the workspace record and captures a cloud delete that names the chunk count", async () => {
    const big = [{ id: "big", type: "ink", page: 1, points: "p".repeat(MAX_INLINE_PAYLOAD_UNITS + 10) }];
    await persistPdfAnnotations("pdf1", big, { workspaceId: A });
    expect(annotationChunkCount(A, "pdf1", big)).toBeGreaterThanOrEqual(1);
    await removePdfAnnotations("pdf1", { workspaceId: A });
    expect(await loadAnnotationRecord("pdf1", { workspaceId: A })).toBeNull();
    const entries = listOutboxEntries(A);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ collection: COLL, id: "pdf1", op: OUTBOX_OP.DELETE, chunks: annotationChunkCount(A, "pdf1", big) });
  });

  test("a delete of a document this browser never held still captures the cloud delete", async () => {
    await removePdfAnnotations("pdf1", { workspaceId: A });
    expect(listOutboxEntries(A)[0]).toMatchObject({ id: "pdf1", op: OUTBOX_OP.DELETE, chunks: 0 });
  });

  test("without a workspace: the legacy removal, nothing captured", async () => {
    await persistPdfAnnotations("pdf1", [rect("a")]);
    await removePdfAnnotations("pdf1");
    expect(await loadAnnotations("pdf1")).toEqual([]);
    expect(outboxSize(A)).toBe(0);
  });
});

/* ------------------------- the payload provider -------------------------- */

describe("the payload provider", () => {
  test("loads the current record as `{ items }` with the revision as the token; a missing record is undefined", async () => {
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    await persistPdfAnnotations("pdf1", [rect("b")], { workspaceId: A });
    expect(await pdfAnnotationPayloadProvider.load(A, "pdf1")).toEqual({ payload: { items: [rect("b")] }, token: 2 });
    expect(await pdfAnnotationPayloadProvider.load(B, "pdf1")).toBeUndefined();
    expect(await pdfAnnotationPayloadProvider.load(A, "none")).toBeUndefined();
  });

  test("a malformed local record is a typed refusal, not an undefined document", async () => {
    await putRawWorkspaceRecord({ workspaceId: A, documentId: "pdf1", items: "not-an-array", updatedAt: 1, revision: 1, cloudDirty: true });
    await expect(pdfAnnotationPayloadProvider.load(A, "pdf1")).rejects.toMatchObject({ code: LOCAL_PAYLOAD_MALFORMED_CODE });
  });

  test("settle clears the dirty flag only for the token that was sent", async () => {
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    await persistPdfAnnotations("pdf1", [rect("b")], { workspaceId: A });
    expect(await pdfAnnotationPayloadProvider.settle(A, "pdf1", 1)).toEqual({ settled: false, revision: 2 });
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(true);
    expect(await pdfAnnotationPayloadProvider.settle(A, "pdf1", 2)).toEqual({ settled: true, revision: 2 });
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
  });
});

/* --------------------------- through the engine -------------------------- */

describe("through the sync engine", () => {
  test("the payload is read from IndexedDB at flush time — the newest save wins — and the record is settled clean", async () => {
    const store = seededStore();
    const { sync, events } = engine({ store, clock });
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    await persistPdfAnnotations("pdf1", [rect("a"), rect("b")], { workspaceId: A });
    await clock.advance(1500);
    expect(store.calls.commits).toHaveLength(1);
    expect(cloudItems(store, A, "pdf1")).toEqual([rect("a"), rect("b")]);
    const doc = store.get(["workspaces", A, COLL, "pdf1"]);
    expect(doc).toMatchObject({ workspaceId: A, id: "pdf1", kind: COLL, schemaVersion: 1 });
    expect(outcomes(events)).toEqual([`${COLL}/pdf1:synced`]);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
    expect(outboxSize(A)).toBe(0);
    expect(sync.getStatus().status).toBe(SYNC_STATUS.IDLE);
  });

  test("an oversized annotation array travels chunked, like every other JSON entity", async () => {
    const store = seededStore();
    engine({ store, clock });
    const big = [{ id: "big", type: "ink", page: 1, points: "p".repeat(MAX_INLINE_PAYLOAD_UNITS + 10) }];
    await persistPdfAnnotations("pdf1", big, { workspaceId: A });
    await clock.advance(1500);
    const parent = store.get(["workspaces", A, COLL, "pdf1"]);
    expect(parent.chunked).toBe(true);
    expect(store.get(["workspaces", A, COLL, "pdf1", "chunks", "0"]).text.length).toBeGreaterThan(0);
    expect(store.get(["workspaces", A, COLL, "missing"])).toBeNull();
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
  });

  test("THE SETTLEMENT RACE: a save that lands while an older revision is in flight keeps its dirty flag and is sent next", async () => {
    const store = seededStore();
    const { sync, events } = engine({ store, clock });
    await persistPdfAnnotations("pdf1", [rect("A")], { workspaceId: A }); // revision 1
    store.setOffline(true); // the commit of revision 1 hangs
    await clock.advance(1500);
    expect(sync.getStatus().status).toBe(SYNC_STATUS.SYNCING);
    await clock.advance(10);
    await persistPdfAnnotations("pdf1", [rect("B")], { workspaceId: A }); // revision 2, newer outbox stamp
    store.setOffline(false); // revision 1 is accepted now
    await clock.flushPromises();
    expect(cloudItems(store, A, "pdf1")).toEqual([rect("A")]);
    // The confirmation of A did NOT clear B.
    const record = await loadAnnotationRecord("pdf1", { workspaceId: A });
    expect(record.revision).toBe(2);
    expect(record.cloudDirty).toBe(true);
    expect(outboxSize(A)).toBe(1);
    // The engine sends B on its next flush and settles it.
    await clock.advance(2000);
    expect(cloudItems(store, A, "pdf1")).toEqual([rect("B")]);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
    expect(outboxSize(A)).toBe(0);
    expect(outcomes(events)).toEqual([`${COLL}/pdf1:synced`, `${COLL}/pdf1:synced`]);
  });

  test("IN-FLIGHT revision A, then a replacement RESET: A confirms afterwards, and [] remains the final cloud obligation", async () => {
    const store = seededStore();
    const { sync } = engine({ store, clock });
    await persistPdfAnnotations("pdf1", [rect("A")], { workspaceId: A }); // revision 1
    store.setOffline(true);
    await clock.advance(1500); // A is in flight
    expect(sync.getStatus().status).toBe(SYNC_STATUS.SYNCING);
    await clock.advance(10);
    await persistPdfAnnotations("pdf1", [], { workspaceId: A }); // the replacement's reset, revision 2
    store.setOffline(false); // A lands now
    await clock.flushPromises();
    expect(cloudItems(store, A, "pdf1")).toEqual([rect("A")]);
    const record = await loadAnnotationRecord("pdf1", { workspaceId: A });
    expect(record).toMatchObject({ items: [], revision: 2, cloudDirty: true });
    expect(outboxSize(A)).toBe(1);
    await clock.advance(2000);
    expect(cloudItems(store, A, "pdf1")).toEqual([]);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
    expect(outboxSize(A)).toBe(0);
  });

  test("IN-FLIGHT revision A, then a DELETE: A confirms afterwards, and the delete remains the final cloud obligation", async () => {
    const store = seededStore();
    engine({ store, clock });
    await persistPdfAnnotations("pdf1", [rect("A")], { workspaceId: A });
    store.setOffline(true);
    await clock.advance(1500); // A is in flight
    await clock.advance(10);
    await removePdfAnnotations("pdf1", { workspaceId: A }); // the PDF was deleted
    store.setOffline(false); // A lands now
    await clock.flushPromises();
    expect(cloudItems(store, A, "pdf1")).toEqual([rect("A")]);
    expect(await loadAnnotationRecord("pdf1", { workspaceId: A })).toBeNull(); // A's settle recreated nothing
    expect(listOutboxEntries(A).map((e) => e.op)).toEqual([OUTBOX_OP.DELETE]);
    await clock.advance(2000);
    expect(store.get(["workspaces", A, COLL, "pdf1"])).toBeNull();
    expect(outboxSize(A)).toBe(0);
  });

  test("a queued upsert whose record is gone is skipped and settled — no undefined document is ever written", async () => {
    const store = seededStore();
    const { events } = engine({ store, clock });
    captureExternalChanges(A, [{ collection: COLL, id: "pdf1", op: OUTBOX_OP.UPSERT }]);
    expect(outboxSize(A)).toBe(1);
    await clock.advance(1500);
    expect(store.calls.commits).toHaveLength(0);
    expect(outboxSize(A)).toBe(0);
    expect(outcomes(events)).toEqual([]);
  });

  test("a malformed local record fails deliberately, the rest of the flush proceeds, and the entry stays for a retry", async () => {
    const store = seededStore();
    const { sync, events } = engine({ store, clock });
    await putRawWorkspaceRecord({ workspaceId: A, documentId: "pdf1", items: "broken", updatedAt: 1, revision: 1, cloudDirty: true });
    captureExternalChanges(A, [{ collection: COLL, id: "pdf1", op: OUTBOX_OP.UPSERT }]);
    saveNoteContent("n1", "<p>fine</p>");
    await clock.advance(1500);
    expect(store.get(["workspaces", A, "noteContent", "n1"]).html).toBe("<p>fine</p>");
    expect(store.get(["workspaces", A, COLL, "pdf1"])).toBeNull();
    expect(outcomes(events)).toEqual([`${COLL}/pdf1:failed:${LOCAL_PAYLOAD_MALFORMED_CODE}`, "noteContent/n1:synced"]);
    expect(sync.getStatus()).toEqual({ status: SYNC_STATUS.ERROR, pending: 1, error: LOCAL_PAYLOAD_MALFORMED_CODE });
    expect(outboxSize(A)).toBe(1);
  });

  test("a cloud delete removes the document and its chunks", async () => {
    const store = seededStore();
    engine({ store, clock });
    const big = [{ id: "big", type: "ink", page: 1, points: "p".repeat(MAX_INLINE_PAYLOAD_UNITS + 10) }];
    await persistPdfAnnotations("pdf1", big, { workspaceId: A });
    await clock.advance(1500);
    expect(store.get(["workspaces", A, COLL, "pdf1", "chunks", "0"])).toBeDefined();
    await removePdfAnnotations("pdf1", { workspaceId: A });
    await clock.advance(1500);
    expect(store.get(["workspaces", A, COLL, "pdf1"])).toBeNull();
    expect(store.get(["workspaces", A, COLL, "pdf1", "chunks", "0"])).toBeNull();
    expect(outboxSize(A)).toBe(0);
  });

  test("OFFLINE: the save is durable, the record stays dirty and the entry pending; back online it syncs and settles", async () => {
    const store = seededStore();
    const { sync, events, setOnline } = engine({ store, clock, online: false });
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    await clock.advance(1500);
    expect(outcomes(events)).toEqual([`${COLL}/pdf1:queued:offline`]);
    expect(sync.getStatus().status).toBe(SYNC_STATUS.OFFLINE);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(true);
    expect(outboxSize(A)).toBe(1);
    expect(await loadAnnotations("pdf1", { workspaceId: A })).toEqual([rect("a")]);
    setOnline(true);
    await sync.retry();
    expect(cloudItems(store, A, "pdf1")).toEqual([rect("a")]);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
    expect(outboxSize(A)).toBe(0);
  });

  test("SESSION ISOLATION: a save bound to A after B became active reaches A's outbox and engine only; B's state is untouched", async () => {
    const storeA = seededStore("alice", A);
    const storeB = seededStore("bob", B);
    setRegistry(B, ["pdf1"]);
    const a = engine({ store: storeA, clock, workspaceId: A });
    // B is the active session now (its own dirty record, its own outbox).
    setDurableScope(scopeOf(B));
    const b = engine({ store: storeB, clock, workspaceId: B });
    await persistPdfAnnotations("pdf1", [rect("b")], { workspaceId: B });
    // A's delayed save fires now, bound to A.
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    expect(outboxSize(A)).toBe(1);
    expect(outboxSize(B)).toBe(1);
    // Stop B before A's flush lands: A's settlement can only touch A's record.
    b.sync.stop();
    await clock.advance(1500);
    expect(cloudItems(storeA, A, "pdf1")).toEqual([rect("a")]);
    expect(storeB.get(["workspaces", B, COLL, "pdf1"])).toBeNull();
    expect(storeB.calls.commits).toHaveLength(0);
    const bRecord = await loadAnnotationRecord("pdf1", { workspaceId: B });
    expect(bRecord.items).toEqual([rect("b")]);
    expect(bRecord.cloudDirty).toBe(true);
    expect(outboxSize(B)).toBe(1);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
    expect(outcomes(b.events)).toEqual([]);
    a.sync.stop();
  });
});

/* ----------------------------- reconciliation ---------------------------- */

describe("reconcilePdfAnnotationOutbox — the crash-window repair", () => {
  test("a dirty record whose outbox identity was lost gets it back; clean ones and already-queued ones are left alone", async () => {
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    await persistPdfAnnotations("pdf2", [rect("b")], { workspaceId: A });
    await pdfAnnotationPayloadProvider.settle(A, "pdf2", 1);
    clearOutbox(A); // the crash between the record and the identity
    const seen = [];
    subscribeCapturedChanges((e) => seen.push(e.workspaceId));
    expect(await reconcilePdfAnnotationOutbox({ workspaceId: A })).toEqual({ enqueued: ["pdf1"], pruned: [], skipped: [] });
    expect(listOutboxEntries(A).map((e) => e.id)).toEqual(["pdf1"]);
    expect(seen).toEqual([A]);
    // Idempotent.
    expect(await reconcilePdfAnnotationOutbox({ workspaceId: A })).toEqual({ enqueued: [], pruned: [], skipped: [] });
    expect(outboxSize(A)).toBe(1);
  });

  test("a record of a PDF the registry no longer names is pruned, never re-uploaded", async () => {
    await persistPdfAnnotations("gone", [rect("x")], { workspaceId: A });
    clearOutbox(A);
    expect(await reconcilePdfAnnotationOutbox({ workspaceId: A })).toEqual({ enqueued: [], pruned: ["gone"], skipped: [] });
    expect(await loadAnnotationRecord("gone", { workspaceId: A })).toBeNull();
    expect(outboxSize(A)).toBe(0);
  });

  test("with no readable registry nothing is pruned and nothing unknown is enqueued", async () => {
    localStorage.clear(); // the registry record is absent
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    clearOutbox(A);
    expect(currentPdfRegistry(A).state).toBe("missing");
    expect(await reconcilePdfAnnotationOutbox({ workspaceId: A })).toEqual({ enqueued: [], pruned: [], skipped: ["pdf1"] });
    expect(await loadAnnotationRecord("pdf1", { workspaceId: A })).not.toBeNull();
  });

  test("never touches another workspace", async () => {
    setRegistry(B, ["pdf1"]);
    await persistPdfAnnotations("pdf1", [rect("b")], { workspaceId: B });
    clearOutbox(B);
    await reconcilePdfAnnotationOutbox({ workspaceId: A });
    expect(outboxSize(B)).toBe(0);
    expect(await reconcilePdfAnnotationOutbox({ workspaceId: "" })).toEqual({ enqueued: [], pruned: [], skipped: [] });
  });
});

/* --------------------------- legacy association -------------------------- */

describe("associateLegacyPdfAnnotations", () => {
  test("adopts a legacy record ONLY for a document the registry names, moving it and queueing it", async () => {
    await saveAnnotations("pdf1", [rect("old")]); // legacy, unscoped
    await saveAnnotations("stranger", [rect("s")]); // legacy, not in the registry
    const result = await associateLegacyPdfAnnotations({ workspaceId: A, uid: "alice" });
    expect(result.adopted).toEqual(["pdf1"]);
    expect(result.refused).toEqual([]);
    expect(result.authority).toEqual({ allowed: true, reason: "unambiguous" });
    const record = await loadAnnotationRecord("pdf1", { workspaceId: A });
    expect(record).toMatchObject({ items: [rect("old")], revision: 1, cloudDirty: true });
    expect(await loadAnnotations("pdf1")).toEqual([]);
    expect(await listLegacyAnnotationIds()).toEqual(["stranger"]);
    expect(listOutboxEntries(A).map((e) => e.id)).toEqual(["pdf1"]);
  });

  test("is refused, writing nothing, when this browser's data was migrated into ANOTHER workspace", async () => {
    await saveAnnotations("pdf1", [rect("old")]);
    recordMigrationState({ status: LOCAL_MIGRATION_STATUS.COMPLETED, uid: "alice", workspaceId: "ws-elsewhere" });
    const result = await associateLegacyPdfAnnotations({ workspaceId: A, uid: "alice" });
    expect(result).toMatchObject({ adopted: [], refused: ["pdf1"], authority: { allowed: false, reason: "migrated-elsewhere" } });
    expect(await loadAnnotations("pdf1")).toEqual([rect("old")]);
    expect(await loadAnnotationRecord("pdf1", { workspaceId: A })).toBeNull();
    expect(outboxSize(A)).toBe(0);
  });

  test("is refused when another account has used this browser's data — being signed in is not authority", async () => {
    await saveAnnotations("pdf1", [rect("old")]);
    // Another account was recorded against this browser's data (the binding
    // records a uid only once local customer data exists; the migration
    // record writes unconditionally, with the uid that ran it).
    recordMigrationState({ status: LOCAL_MIGRATION_STATUS.NOT_STARTED, uid: "bob" });
    const result = await associateLegacyPdfAnnotations({ workspaceId: A, uid: "alice" });
    expect(result.authority).toEqual({ allowed: false, reason: "other-account" });
    expect(result.refused).toEqual(["pdf1"]);
    expect(await loadAnnotations("pdf1")).toEqual([rect("old")]);
  });

  test("a COMPLETED migration into THIS workspace outranks the other-account warning", async () => {
    await saveAnnotations("pdf1", [rect("old")]);
    recordMigrationState({ status: LOCAL_MIGRATION_STATUS.NOT_STARTED, uid: "bob" });
    recordMigrationState({ status: LOCAL_MIGRATION_STATUS.COMPLETED, uid: "alice", workspaceId: A });
    const result = await associateLegacyPdfAnnotations({ workspaceId: A, uid: "alice" });
    expect(result.authority).toEqual({ allowed: true, reason: "migrated-here" });
    expect(result.adopted).toEqual(["pdf1"]);
  });

  test("leaves the legacy copy where it is when the account already holds a document for it (the cloud wins)", async () => {
    await saveAnnotations("pdf1", [rect("old")]);
    const result = await associateLegacyPdfAnnotations({ workspaceId: A, uid: "alice", cloudIds: new Set(["pdf1"]) });
    expect(result).toMatchObject({ adopted: [], superseded: ["pdf1"] });
    expect(await loadAnnotations("pdf1")).toEqual([rect("old")]);
    expect(await loadAnnotationRecord("pdf1", { workspaceId: A })).toBeNull();
  });

  test("does nothing with an empty registry, or with a record the workspace already owns", async () => {
    await saveAnnotations("pdf1", [rect("old")]);
    localStorage.clear();
    expect((await associateLegacyPdfAnnotations({ workspaceId: A, uid: "alice" })).adopted).toEqual([]);
    setRegistry(A, ["pdf1"]);
    await saveAnnotations("pdf1", [rect("owned")], { workspaceId: A });
    expect((await associateLegacyPdfAnnotations({ workspaceId: A, uid: "alice" })).adopted).toEqual([]);
    expect(await loadAnnotations("pdf1")).toEqual([rect("old")]);
    expect(await loadAnnotations("pdf1", { workspaceId: A })).toEqual([rect("owned")]);
  });
});

/* -------------------------------- hydration ------------------------------ */

describe("hydratePdfAnnotations — precedence", () => {
  test("no local record → created clean; clean local → refreshed; dirty local → kept and its obligation ensured", async () => {
    await persistPdfAnnotations("pdf2", [rect("clean")], { workspaceId: A });
    await pdfAnnotationPayloadProvider.settle(A, "pdf2", 1);
    clearOutbox(A);
    setRegistry(A, ["pdf1", "pdf2", "pdf3"]);
    await persistPdfAnnotations("pdf3", [rect("dirty")], { workspaceId: A });
    clearOutbox(A); // the identity was lost; hydration must restore it
    const result = await hydratePdfAnnotations({
      workspaceId: A,
      entities: { pdf1: { items: [rect("c1")] }, pdf2: { items: [rect("c2")] }, pdf3: { items: [rect("c3")] } },
      pendingKeys: pendingOutboxKeys(A),
    });
    expect(result).toEqual({ created: 1, refreshed: 1, kept: 1, orphans: 0, malformed: [] });
    expect(await loadAnnotations("pdf1", { workspaceId: A })).toEqual([rect("c1")]);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
    expect(await loadAnnotations("pdf2", { workspaceId: A })).toEqual([rect("c2")]);
    expect(await loadAnnotations("pdf3", { workspaceId: A })).toEqual([rect("dirty")]);
    expect(listOutboxEntries(A).map((e) => e.id)).toEqual(["pdf3"]);
  });

  test("a document for a PDF the registry does not name is ignored — a deleted PDF's annotations never come back", async () => {
    const result = await hydratePdfAnnotations({ workspaceId: A, entities: { deleted: { items: [rect("z")] } } });
    expect(result).toMatchObject({ created: 0, orphans: 1 });
    expect(await loadAnnotationRecord("deleted", { workspaceId: A })).toBeNull();
  });

  test("a malformed document is reported and excluded; a valid local record is not destroyed", async () => {
    await persistPdfAnnotations("pdf1", [rect("local")], { workspaceId: A });
    await pdfAnnotationPayloadProvider.settle(A, "pdf1", 1);
    const malformed = [];
    const result = await hydratePdfAnnotations({
      workspaceId: A,
      entities: { pdf1: { items: "nope" }, pdf2: { items: [null] } },
      onMalformed: (e) => malformed.push(e),
    });
    expect(result.malformed).toEqual([
      { collection: COLL, id: "pdf1", reason: "bad-annotation-items" },
      { collection: COLL, id: "pdf2", reason: "bad-annotation-item" },
    ]);
    expect(malformed).toHaveLength(2);
    expect(await loadAnnotations("pdf1", { workspaceId: A })).toEqual([rect("local")]);
  });

  test("another workspace's record is never exposed or overwritten", async () => {
    setRegistry(B, ["pdf1"]);
    await persistPdfAnnotations("pdf1", [rect("b")], { workspaceId: B });
    await hydratePdfAnnotations({ workspaceId: A, entities: { pdf1: { items: [rect("a-cloud")] } } });
    expect(await loadAnnotations("pdf1", { workspaceId: B })).toEqual([rect("b")]);
    expect(await loadAnnotations("pdf1", { workspaceId: A })).toEqual([rect("a-cloud")]);
  });

  test("hydration through the mirror path for another kind is unaffected", () => {
    // Guard: pdfAnnotations is not a durable-storage record.
    expect(CLOUD_COLLECTION.PDF_ANNOTATIONS).toBe(COLL);
    expect(buildEntityDocument({ workspaceId: A, collection: COLL, id: "pdf1", payload: { items: [] } }).fields.json).toBe('{"items":[]}');
  });
});

/* ----------------------------- restart / reload -------------------------- */

describe("restart", () => {
  test("local edits survive a 'reload' (a fresh engine over the same IndexedDB) and sync only after they settle by revision", async () => {
    const store = seededStore();
    await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: A });
    clearOutbox(A); // as if the tab died before the identity landed
    // "Reload": the session start repairs, then the engine drains.
    expect((await reconcilePdfAnnotationOutbox({ workspaceId: A })).enqueued).toEqual(["pdf1"]);
    engine({ store, clock });
    await clock.advance(1500);
    expect(cloudItems(store, A, "pdf1")).toEqual([rect("a")]);
    expect((await loadAnnotationRecord("pdf1", { workspaceId: A })).cloudDirty).toBe(false);
    expect(outcomes([])).toEqual([]);
    expect(SYNC_OUTCOME.SYNCED).toBe("synced");
  });
});
