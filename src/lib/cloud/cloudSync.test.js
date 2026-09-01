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
import { __resetCloudCaptureForTests, installCloudCapture } from "./cloudCapture";
import { MAX_INLINE_PAYLOAD_UNITS } from "./cloudModel";
import { outboxSize } from "./cloudOutbox";
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

function setup({ online = true } = {}) {
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
