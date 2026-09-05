// src/lib/cloud/cloudSync.test.js
//
// The sync engine over the in-memory store: coalesced batches, per-entity
// outcomes ("synced" / "queued" / "failed"), offline queuing with retry,
// permission failures that stop retrying, malformed cloud records that are
// never overwritten, chunked payloads, and atomic deletes.
import { DURABLE_KEYS, DURABLE_SCOPE_KIND, __resetDurableStorageForTests, setDurableScope, writeDurableRecord, WRITE_ORIGIN } from "../durableStorage";
import { saveNoteContent, deleteNoteContent } from "../noteContentStorage";
import { saveTree } from "../treeStorage";
import { __resetNoteTombstonesForTests } from "../noteTombstones";
import { __resetCloudCaptureForTests, captureExternalChanges, installCloudCapture } from "./cloudCapture";
import { MAX_INLINE_PAYLOAD_UNITS } from "./cloudModel";
import { OUTBOX_OP, listOutboxEntries, outboxSize } from "./cloudOutbox";
import { SYNC_OUTCOME, SYNC_STATUS, classifySyncError, createCloudSync, syncFailureMessage } from "./cloudSync";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";

const WS = "ws-1";

function timers() {
  let t = 0;
  const queue = [];
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
  };
}

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup({ online = true, payloadProviders } = {}) {
  const store = createMemoryWorkspaceStore();
  store.setUser("alice");
  store.seed(["workspaces", WS], { id: WS, ownerUid: "alice" });
  store.seed(["workspaces", WS, "members", "alice"], { uid: "alice", role: "owner" });
  const clock = timers();
  let isOnline = online;
  const events = [];
  const sync = createCloudSync({
    workspaceId: WS,
    store,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isOnline: () => isOnline,
    addOnlineListener: () => () => {},
    commitTimeoutMs: 1000,
    ...(payloadProviders ? { payloadProviders } : {}),
  });
  sync.subscribe((e) => events.push(e));
  sync.start();
  return { store, clock, sync, events, setOnline: (v) => (isOnline = v) };
}

const outcomes = (events) => events.filter((e) => e.type === "outcome").flatMap((e) => e.results.map((r) => `${r.collection}/${r.id}:${r.outcome}`));

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
  installCloudCapture();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
});

afterEach(() => {
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

test("45. a burst of local writes becomes one batch after the trailing delay; outcomes settle each entity", async () => {
  const { store, clock, sync, events } = setup();
  saveNoteContent("n1", "<p>a</p>");
  saveNoteContent("n1", "<p>ab</p>");
  saveNoteContent("n2", "<p>x</p>");
  expect(store.calls.commits).toHaveLength(0);
  await clock.advance(1499);
  expect(store.calls.commits).toHaveLength(0);
  await clock.advance(1);
  expect(store.calls.commits).toHaveLength(1);
  expect(store.calls.commits[0].map((op) => op.path)).toEqual(["noteContent/n1", "noteContent/n2"]);
  expect(store.get(["workspaces", WS, "noteContent", "n1"]).html).toBe("<p>ab</p>");
  expect(outcomes(events)).toEqual(["noteContent/n1:synced", "noteContent/n2:synced"]);
  expect(sync.getStatus()).toEqual({ status: SYNC_STATUS.IDLE, pending: 0, error: null });
  expect(outboxSize(WS)).toBe(0);
});

test("continuous editing still lands at the maximum wait", async () => {
  const { store, clock } = setup();
  for (let i = 0; i < 10; i++) {
    saveNoteContent("n1", `<p>${i}</p>`);
    await clock.advance(1000);
  }
  // 10 s of typing at 1 s intervals with a 1.5 s trailing delay and a 6 s max wait → 2 batches so far
  expect(store.calls.commits.length).toBeGreaterThanOrEqual(1);
  expect(store.calls.commits.length).toBeLessThanOrEqual(2);
  await clock.advance(2000);
  expect(store.get(["workspaces", WS, "noteContent", "n1"]).html).toBe("<p>9</p>");
});

test("46. an explicit flush writes now (navigation / sign-out)", async () => {
  const { store, sync } = setup();
  saveNoteContent("n1", "<p>now</p>");
  const result = await sync.flush();
  expect(result.ok).toBe(true);
  expect(store.get(["workspaces", WS, "noteContent", "n1"]).html).toBe("<p>now</p>");
});

test("44. offline: entries stay queued, the outcome is 'queued', a retry after reconnecting syncs them", async () => {
  const { store, clock, sync, events, setOnline } = setup({ online: false });
  saveNoteContent("n1", "<p>offline edit</p>");
  await clock.advance(1500);
  expect(store.calls.commits).toHaveLength(0);
  expect(outcomes(events)).toEqual(["noteContent/n1:queued"]);
  expect(sync.getStatus().status).toBe(SYNC_STATUS.OFFLINE);
  expect(sync.hasPending("noteContent", "n1")).toBe(true);
  setOnline(true);
  await clock.advance(2000); // first backoff step
  expect(outcomes(events)).toEqual(["noteContent/n1:queued", "noteContent/n1:synced"]);
  expect(sync.getStatus().status).toBe(SYNC_STATUS.IDLE);
});

test("a transient store failure (unavailable / timeout) queues and retries with backoff", async () => {
  const { store, clock, events, sync } = setup();
  store.failNext("commit", "unavailable");
  saveNoteContent("n1", "<p>a</p>");
  await clock.advance(1500);
  expect(outcomes(events)).toEqual(["noteContent/n1:queued"]);
  expect(sync.getStatus().status).toBe(SYNC_STATUS.OFFLINE);
  await clock.advance(2000);
  expect(outcomes(events)).toEqual(["noteContent/n1:queued", "noteContent/n1:synced"]);

  // a commit that never answers (the SDK offline) is treated as queued via the timeout
  store.setOffline(true);
  saveNoteContent("n1", "<p>b</p>");
  await clock.advance(1500 + 1000);
  expect(outcomes(events).slice(-1)).toEqual(["noteContent/n1:queued"]);
  store.setOffline(false);
  await flushPromises();
});

test("43. a permission failure is 'failed', reported, and not retried until the next change", async () => {
  const { store, clock, events, sync } = setup();
  store.failNext("commit", "permission-denied");
  saveNoteContent("n1", "<p>a</p>");
  await clock.advance(1500);
  expect(outcomes(events)).toEqual(["noteContent/n1:failed"]);
  expect(sync.getStatus()).toMatchObject({ status: SYNC_STATUS.ERROR, pending: 1, error: "permission-denied" });
  await clock.advance(60000);
  expect(store.calls.commits).toHaveLength(0); // the refused commit is not recorded; no retry happened
  // the next change retries, and the failure message is user-safe
  saveNoteContent("n1", "<p>b</p>");
  await clock.advance(1500);
  expect(store.calls.commits).toHaveLength(1);
  expect(outcomes(events)).toEqual(["noteContent/n1:failed", "noteContent/n1:synced"]);
  expect(syncFailureMessage("permission-denied")).not.toMatch(/firestore|exception/i);
  expect(classifySyncError({ code: "firestore/unavailable" })).toEqual({ outcome: SYNC_OUTCOME.QUEUED, code: "unavailable" });
  expect(classifySyncError(new TypeError("Failed to fetch"))).toEqual({ outcome: SYNC_OUTCOME.QUEUED, code: "network" });
  expect(classifySyncError({ code: "invalid-argument" })).toEqual({ outcome: SYNC_OUTCOME.FAILED, code: "invalid-argument" });
});

test("47. an entity the hydration quarantined is never overwritten with a local value", async () => {
  const { store, clock, events, sync } = setup();
  store.seed(["workspaces", WS, "noteContent", "bad"], { workspaceId: WS, id: "bad", kind: "noteContent", html: 42 });
  sync.markQuarantined("noteContent", "bad");
  saveNoteContent("bad", "<p>typed into an unreadable note</p>");
  saveNoteContent("ok", "<p>fine</p>");
  await clock.advance(1500);
  expect(outcomes(events).sort()).toEqual(["noteContent/bad:failed", "noteContent/ok:synced"]);
  expect(store.get(["workspaces", WS, "noteContent", "bad"]).html).toBe(42);
  expect(sync.hasPending("noteContent", "bad")).toBe(true);
});

test("48. a note deletion (node + content) travels in one batch — all or nothing", async () => {
  const { store, clock, sync } = setup();
  saveTree({ projectData: [], folderMap: {}, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [{ id: "n1", title: "A" }] });
  saveNoteContent("n1", "<p>a</p>");
  await sync.flush();
  expect(store.get(["workspaces", WS, "nodes", "n1"])).not.toBeNull();
  saveTree({ projectData: [], folderMap: {}, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] });
  deleteNoteContent("n1");
  store.failNext("commit", "unavailable");
  await clock.advance(1500);
  // 50. the failed delete left the cloud coherent: both documents still there
  expect(store.get(["workspaces", WS, "nodes", "n1"])).not.toBeNull();
  expect(store.get(["workspaces", WS, "noteContent", "n1"])).not.toBeNull();
  await clock.advance(2000);
  expect(store.get(["workspaces", WS, "nodes", "n1"])).toBeNull();
  expect(store.get(["workspaces", WS, "noteContent", "n1"])).toBeNull();
  expect(store.calls.commits[1].map((op) => `${op.type}:${op.path}`).sort()).toEqual(["delete:nodes/n1", "delete:noteContent/n1"]);
});

test("a chunked payload writes its parent and chunks and deletes them together", async () => {
  const { store, sync } = setup();
  const html = "<p>" + "z".repeat(MAX_INLINE_PAYLOAD_UNITS * 2) + "</p>";
  saveNoteContent("big", html);
  await sync.flush();
  expect(store.get(["workspaces", WS, "noteContent", "big"]).chunked).toBe(true);
  expect(store.get(["workspaces", WS, "noteContent", "big", "chunks", "0"]).text.length).toBeGreaterThan(0);
  const { documents } = await store.readWorkspace(WS);
  expect(documents.find((d) => d.id === "big").chunks.join("")).toBe(html);
  deleteNoteContent("big");
  await sync.flush();
  expect(store.get(["workspaces", WS, "noteContent", "big"])).toBeNull();
  expect(store.get(["workspaces", WS, "noteContent", "big", "chunks", "0"])).toBeNull();
});

test("19. an upsert whose entity vanished from the mirror is dropped, not written as empty", async () => {
  const { store, sync } = setup();
  saveNoteContent("n1", "<p>a</p>");
  writeDurableRecord(DURABLE_KEYS.noteContent, {}, { origin: WRITE_ORIGIN.CLOUD }); // mirror reset without a capture diff
  await sync.flush();
  expect(store.get(["workspaces", WS, "noteContent", "n1"])).toBeNull();
  expect(outboxSize(WS)).toBe(0);
});

test("a stopped engine schedules nothing and a concurrent flush shares one run", async () => {
  const { sync, store, clock } = setup();
  saveNoteContent("n1", "<p>a</p>");
  const a = sync.flush();
  const b = sync.flush();
  expect(a).toBe(b);
  await a;
  expect(store.calls.commits).toHaveLength(1);
  sync.stop();
  saveNoteContent("n2", "<p>b</p>");
  await clock.advance(10000);
  expect(store.calls.commits).toHaveLength(1);
});

/* ------------------- async payload providers (Phase 7.7) ------------------ */

describe("payload providers — an entity whose local copy is not in the mirror", () => {
  const PA = "pdfAnnotations";
  const queue = (id, op = OUTBOX_OP.UPSERT) => captureExternalChanges(WS, [{ collection: PA, id, op }]);

  function provider(records) {
    const settled = [];
    return {
      settled,
      provider: {
        load: async (workspaceId, id) => {
          const rec = records[id];
          if (rec === undefined) return undefined;
          if (rec instanceof Error) throw rec;
          return { payload: { items: rec.items }, token: rec.revision };
        },
        settle: async (workspaceId, id, token) => {
          settled.push(`${workspaceId}/${id}@${token}`);
        },
      },
    };
  }

  test("the payload is read asynchronously at flush time and the provider is settled with the token it sent", async () => {
    const records = { pdf1: { items: [{ id: "x" }], revision: 1 } };
    const { provider: p, settled } = provider(records);
    const { store, clock, events } = setup({ payloadProviders: { [PA]: p } });
    queue("pdf1");
    records.pdf1 = { items: [{ id: "x" }, { id: "y" }], revision: 2 }; // a later local save before the flush
    await clock.advance(1500);
    const doc = store.get(["workspaces", WS, PA, "pdf1"]);
    expect(JSON.parse(doc.json)).toEqual({ items: [{ id: "x" }, { id: "y" }] });
    expect(doc.kind).toBe(PA);
    expect(settled).toEqual([`${WS}/pdf1@2`]);
    expect(outcomes(events)).toEqual([`${PA}/pdf1:synced`]);
    expect(outboxSize(WS)).toBe(0);
  });

  test("mirror collections are planned exactly as before, in the same batch as provider-backed entries", async () => {
    const { provider: p } = provider({ pdf1: { items: [], revision: 1 } });
    const { store, clock, events } = setup({ payloadProviders: { [PA]: p } });
    saveNoteContent("n1", "<p>a</p>");
    queue("pdf1");
    await clock.advance(1500);
    expect(store.calls.commits).toHaveLength(1);
    expect(store.calls.commits[0].map((op) => op.path).sort()).toEqual(["noteContent/n1", `${PA}/pdf1`]);
    expect(outcomes(events).sort()).toEqual(["noteContent/n1:synced", `${PA}/pdf1:synced`]);
  });

  test("a provider that has no record for a queued upsert skips it: settled, nothing written", async () => {
    const { provider: p } = provider({});
    const { store, clock, events } = setup({ payloadProviders: { [PA]: p } });
    queue("pdf1");
    await clock.advance(1500);
    expect(store.calls.commits).toHaveLength(0);
    expect(outboxSize(WS)).toBe(0);
    expect(outcomes(events)).toEqual([]);
  });

  test("a rejected read fails only that entity, with its code; the rest of the flush lands; the entry stays for a retry", async () => {
    const { provider: p, settled } = provider({
      bad: Object.assign(new Error("unreadable"), { code: "local-payload-malformed" }),
      worse: new Error("no code"),
      good: { items: [{ id: "g" }], revision: 3 },
    });
    const { store, clock, events, sync } = setup({ payloadProviders: { [PA]: p } });
    queue("bad");
    queue("worse");
    queue("good");
    saveNoteContent("n1", "<p>a</p>");
    await clock.advance(1500);
    expect(store.get(["workspaces", WS, PA, "good"])).toBeTruthy();
    expect(store.get(["workspaces", WS, "noteContent", "n1"])).toBeTruthy();
    expect(store.get(["workspaces", WS, PA, "bad"])).toBeNull();
    expect(outcomes(events).sort()).toEqual(
      [`${PA}/bad:failed`, `${PA}/worse:failed`, `${PA}/good:synced`, "noteContent/n1:synced"].sort()
    );
    const codes = events.filter((e) => e.type === "outcome").flatMap((e) => e.results).filter((r) => r.outcome === "failed").map((r) => r.code).sort();
    expect(codes).toEqual(["local-payload-malformed", "local-payload-unreadable"]);
    expect(settled).toEqual([`${WS}/good@3`]);
    expect(listOutboxEntries(WS).map((e) => e.id).sort()).toEqual(["bad", "worse"]);
    expect(sync.getStatus()).toEqual({ status: SYNC_STATUS.ERROR, pending: 2, error: "local-payload-malformed" });
    // No automatic retry loop: nothing is armed until the next change or an explicit retry.
    expect(store.calls.commits).toHaveLength(1);
    await clock.advance(60000);
    expect(store.calls.commits).toHaveLength(1);
  });

  test("a delete of a provider-backed entity never asks the provider and removes the chunks it names", async () => {
    let loads = 0;
    const p = { load: async () => (loads += 1, undefined), settle: async () => {} };
    const { store, clock } = setup({ payloadProviders: { [PA]: p } });
    store.seed(["workspaces", WS, PA, "pdf1"], { workspaceId: WS, id: "pdf1", kind: PA, schemaVersion: 1, chunked: true, chunkCount: 2 });
    store.seed(["workspaces", WS, PA, "pdf1", "chunks", "0"], { text: "a" });
    store.seed(["workspaces", WS, PA, "pdf1", "chunks", "1"], { text: "b" });
    captureExternalChanges(WS, [{ collection: PA, id: "pdf1", op: OUTBOX_OP.DELETE, chunks: 2 }]);
    await clock.advance(1500);
    expect(loads).toBe(0);
    expect(store.get(["workspaces", WS, PA, "pdf1"])).toBeNull();
    expect(store.get(["workspaces", WS, PA, "pdf1", "chunks", "1"])).toBeNull();
  });

  test("batch limits still apply: two oversized provider payloads travel in two commits, each with its chunks", async () => {
    const huge = "h".repeat(1600000);
    const { provider: p, settled } = provider({ a: { items: [{ t: huge }], revision: 1 }, b: { items: [{ t: huge }], revision: 1 } });
    const { store, clock } = setup({ payloadProviders: { [PA]: p } });
    queue("a");
    queue("b");
    await clock.advance(1500);
    expect(store.calls.commits).toHaveLength(2);
    expect(store.get(["workspaces", WS, PA, "a"]).chunked).toBe(true);
    expect(store.get(["workspaces", WS, PA, "b"]).chunked).toBe(true);
    expect(settled.sort()).toEqual([`${WS}/a@1`, `${WS}/b@1`]);
    expect(outboxSize(WS)).toBe(0);
  });

  test("offline, provider-backed entries queue like every other and the provider is not consulted", async () => {
    let loads = 0;
    const p = { load: async () => (loads += 1, { payload: { items: [] }, token: 1 }), settle: async () => {} };
    const { clock, events, setOnline, sync } = setup({ online: false, payloadProviders: { [PA]: p } });
    queue("pdf1");
    await clock.advance(1500);
    expect(loads).toBe(0);
    expect(outcomes(events)).toEqual([`${PA}/pdf1:queued`]);
    setOnline(true);
    await sync.retry();
    expect(loads).toBe(1);
    expect(outboxSize(WS)).toBe(0);
  });

  test("a refused settle leaves the outbox settled and the engine idle (the owner's marker repairs it later)", async () => {
    const p = {
      load: async () => ({ payload: { items: [] }, token: 1 }),
      settle: async () => {
        throw new Error("settle refused");
      },
    };
    const { clock, events, sync } = setup({ payloadProviders: { [PA]: p } });
    queue("pdf1");
    await clock.advance(1500);
    expect(outcomes(events)).toEqual([`${PA}/pdf1:synced`]);
    expect(sync.getStatus().status).toBe(SYNC_STATUS.IDLE);
  });
});
