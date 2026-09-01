// src/lib/cloud/cloudOutbox.test.js
//
// The persisted per-workspace outbox: identities not values, latest change
// wins, settle only what was seen, survives an unreadable record.
import {
  OUTBOX_OP,
  clearOutbox,
  enqueueOutbox,
  hasOutboxEntry,
  listOutboxEntries,
  outboxSize,
  outboxStorageKey,
  pendingOutboxKeys,
  readOutbox,
  settleOutbox,
} from "./cloudOutbox";

function memStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    dump: () => Object.fromEntries(data),
  };
}

test("enqueue records identities with a stamp; a later change to the same entity replaces the entry", () => {
  const storage = memStorage();
  let t = 100;
  const now = () => t;
  enqueueOutbox("ws", [{ collection: "noteContent", id: "n1", op: OUTBOX_OP.UPSERT }], { storage, now });
  t = 200;
  enqueueOutbox("ws", [{ collection: "noteContent", id: "n1", op: OUTBOX_OP.DELETE, chunks: 2 }, { collection: "nodes", id: "p1" }], { storage, now });
  const entries = listOutboxEntries("ws", storage);
  expect(entries).toEqual([
    { collection: "noteContent", id: "n1", op: OUTBOX_OP.DELETE, at: 200, chunks: 2 },
    { collection: "nodes", id: "p1", op: OUTBOX_OP.UPSERT, at: 200, chunks: 0 },
  ]);
  expect(outboxSize("ws", storage)).toBe(2);
  expect(hasOutboxEntry("ws", "nodes", "p1", storage)).toBe(true);
  expect(pendingOutboxKeys("ws", storage)).toEqual(new Set(["noteContent/n1", "nodes/p1"]));
  // stored under the workspace's own key — another workspace sees nothing
  expect(outboxSize("other", storage)).toBe(0);
  expect(Object.keys(storage.dump())).toEqual([outboxStorageKey("ws")]);
});

test("settle removes only entries whose stamp is unchanged; an empty outbox removes its record", () => {
  const storage = memStorage();
  let t = 1;
  const now = () => t;
  enqueueOutbox("ws", [{ collection: "noteContent", id: "n1" }, { collection: "noteContent", id: "n2" }], { storage, now });
  const seen = listOutboxEntries("ws", storage);
  t = 2;
  enqueueOutbox("ws", [{ collection: "noteContent", id: "n2" }], { storage, now }); // re-queued mid-flight
  expect(settleOutbox("ws", seen, storage)).toBe(1);
  expect(listOutboxEntries("ws", storage)).toEqual([{ collection: "noteContent", id: "n2", op: OUTBOX_OP.UPSERT, at: 2, chunks: 0 }]);
  settleOutbox("ws", listOutboxEntries("ws", storage), storage);
  expect(storage.dump()).toEqual({});
});

test("an unreadable outbox record reads as empty and is replaced by the next enqueue; malformed entries are dropped", () => {
  const storage = memStorage({ [outboxStorageKey("ws")]: "{nope" });
  expect(readOutbox("ws", storage)).toEqual({ entries: {} });
  enqueueOutbox("ws", [{ collection: "nodes", id: "p1" }], { storage, now: () => 5 });
  expect(outboxSize("ws", storage)).toBe(1);
  storage.setItem(outboxStorageKey("ws"), JSON.stringify({ version: 1, entries: { "nodes/p1": { op: "upsert", at: 5 }, "": { op: "upsert" }, "nodes/": null } }));
  expect(listOutboxEntries("ws", storage)).toEqual([{ collection: "nodes", id: "p1", op: "upsert", at: 5, chunks: 0 }]);
  clearOutbox("ws", storage);
  expect(outboxSize("ws", storage)).toBe(0);
});

test("enqueue throws when storage refuses, so the caller can report it", () => {
  const storage = memStorage();
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  expect(() => enqueueOutbox("ws", [{ collection: "nodes", id: "p1" }], { storage })).toThrow("QuotaExceededError");
  expect(() => enqueueOutbox("ws", [], { storage: null })).toThrow();
});
