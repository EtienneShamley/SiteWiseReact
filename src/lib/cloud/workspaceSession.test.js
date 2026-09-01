// src/lib/cloud/workspaceSession.test.js
//
// One workspace session end to end over the in-memory store: bootstrap →
// scope → replay → hydrate → ready; the offline start from a cached
// binding; no guessed workspace without one; the close that removes the
// mirror only when nothing is queued; account isolation across sessions.
import { DURABLE_KEYS, __resetDurableStorageForTests, getDurableScope, scopedStorageKey } from "../durableStorage";
import { getNoteContent, saveNoteContent } from "../noteContentStorage";
import { __resetNoteTombstonesForTests } from "../noteTombstones";
import { __resetCloudCaptureForTests } from "./cloudCapture";
import { buildEntityDocument } from "./cloudModel";
import { outboxSize } from "./cloudOutbox";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";
import { readWorkspaceBinding, writeWorkspaceBinding } from "./workspaceBindingCache";
import { SESSION_MODE, clearWorkspaceMirror, openWorkspaceSession } from "./workspaceSession";

const syncOptions = { isOnline: () => true, addOnlineListener: () => () => {}, setTimer: () => 0, clearTimer: () => {} };
const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t) };

function store(uid) {
  const s = createMemoryWorkspaceStore();
  s.setUser(uid);
  return s;
}

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
});

afterEach(() => {
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

test("6/7. a first sign-in creates the workspace, scopes storage to it, hydrates, and caches the binding; a repeat resolves the same one", async () => {
  const s = store("alice");
  const session = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(session.mode).toBe(SESSION_MODE.ONLINE);
  expect(session.workspace.created).toBe(true);
  expect(session.workspace.role).toBe("owner");
  expect(session.workspace.id).toMatch(/^ws-/);
  expect(getDurableScope()).toEqual({ kind: "workspace", id: session.workspace.id });
  expect(session.hydration.done).toBe(true);
  expect(readWorkspaceBinding("alice").workspaceId).toBe(session.workspace.id);
  await session.close();

  const again = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(again.workspace.id).toBe(session.workspace.id);
  expect(again.workspace.created).toBe(false);
  await again.close();
});

test("edits in a session reach the account and come back on the next session; the mirror is removed at close once synced", async () => {
  const s = store("alice");
  const first = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  saveNoteContent("n1", "<p>field note</p>");
  await first.sync.flush();
  const wid = first.workspace.id;
  expect(s.get(["workspaces", wid, "noteContent", "n1"]).html).toBe("<p>field note</p>");
  await first.close();
  expect(localStorage.getItem(scopedStorageKey(DURABLE_KEYS.noteContent, { kind: "workspace", id: wid }))).toBeNull();

  const second = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(getNoteContent("n1")).toBe("<p>field note</p>");
  await second.close();
});

test("31/32/33. two accounts on one browser resolve their own workspaces and never see each other's data", async () => {
  const s = createMemoryWorkspaceStore();
  s.setUser("alice");
  const a = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  saveNoteContent("a1", "<p>Alice's</p>");
  await a.sync.flush();
  await a.close();

  s.setUser("bob");
  const b = await openWorkspaceSession({ uid: "bob", store: s, syncOptions, ...timers });
  expect(b.workspace.id).not.toBe(a.workspace.id);
  expect(getNoteContent("a1")).toBeNull();
  saveNoteContent("b1", "<p>Bob's</p>");
  await b.sync.flush();
  expect(Object.keys(s.listWorkspaceDocs(b.workspace.id, "noteContent"))).toEqual(["b1"]);
  expect(Object.keys(s.listWorkspaceDocs(a.workspace.id, "noteContent"))).toEqual(["a1"]);
  await b.close();

  s.setUser("alice");
  const a2 = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(a2.workspace.id).toBe(a.workspace.id);
  expect(getNoteContent("a1")).toBe("<p>Alice's</p>");
  expect(getNoteContent("b1")).toBeNull();
  await a2.close();
});

test("an offline start opens from this browser's mirror when a cached binding exists, and never guesses without one", async () => {
  const s = store("alice");
  const online = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  const wid = online.workspace.id;
  saveNoteContent("n1", "<p>keep me</p>");
  // sign out while the write is still queued → the mirror is kept
  await online.close();
  expect(outboxSize(wid)).toBe(1);
  expect(localStorage.getItem(scopedStorageKey(DURABLE_KEYS.noteContent, { kind: "workspace", id: wid }))).toContain("keep me");

  s.failNext("transaction", "unavailable");
  const offline = await openWorkspaceSession({ uid: "alice", store: s, syncOptions: { ...syncOptions, isOnline: () => false }, ...timers });
  expect(offline.mode).toBe(SESSION_MODE.OFFLINE);
  expect(offline.workspace.id).toBe(wid);
  expect(getNoteContent("n1")).toBe("<p>keep me</p>");
  expect(offline.hydration.done).toBe(false);
  await offline.close();

  // no binding for a uid that never resolved here → the error propagates
  const fresh = store("carol");
  fresh.failNext("transaction", "unavailable");
  await expect(openWorkspaceSession({ uid: "carol", store: fresh, syncOptions, ...timers })).rejects.toMatchObject({ code: "unavailable" });
  expect(readWorkspaceBinding("carol")).toBeNull();
  // and a NON-network error never falls back to the cache
  writeWorkspaceBinding("dave", { workspaceId: "ws-cached", role: "owner" });
  const denied = store("dave");
  denied.failNext("transaction", "permission-denied");
  await expect(openWorkspaceSession({ uid: "dave", store: denied, syncOptions, ...timers })).rejects.toMatchObject({ code: "permission-denied" });
});

test("replay before hydrate: queued offline edits are pushed first, then the cloud state (with the local edit kept) is mirrored", async () => {
  const s = store("alice");
  const first = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  const wid = first.workspace.id;
  const built = buildEntityDocument({ workspaceId: wid, collection: "noteContent", id: "cloud-only", payload: { html: "<p>from another device</p>" } });
  s.seed(["workspaces", wid, "noteContent", "cloud-only"], built.fields);
  s.setOffline(true);
  saveNoteContent("n1", "<p>offline</p>");
  const pending = first.sync.flush();
  s.setOffline(false);
  await pending;
  await first.close();

  // simulate: the write had not been accepted (queue it again by hand)
  const { enqueueOutbox } = require("./cloudOutbox");
  localStorage.setItem(scopedStorageKey(DURABLE_KEYS.noteContent, { kind: "workspace", id: wid }), JSON.stringify({ n1: "<p>offline v2</p>" }));
  enqueueOutbox(wid, [{ collection: "noteContent", id: "n1" }]);
  const second = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(getNoteContent("n1")).toBe("<p>offline v2</p>");
  expect(getNoteContent("cloud-only")).toBe("<p>from another device</p>");
  expect(s.get(["workspaces", wid, "noteContent", "n1"]).html).toBe("<p>offline v2</p>");
  expect(outboxSize(wid)).toBe(0);
  await second.close();
});

test("clearWorkspaceMirror removes only that workspace's keys", () => {
  localStorage.setItem(scopedStorageKey(DURABLE_KEYS.tree, { kind: "workspace", id: "w1" }), "{}");
  localStorage.setItem(scopedStorageKey(DURABLE_KEYS.tree, { kind: "workspace", id: "w2" }), "{}");
  localStorage.setItem(DURABLE_KEYS.tree, "{}");
  clearWorkspaceMirror("w1");
  expect(localStorage.getItem(scopedStorageKey(DURABLE_KEYS.tree, { kind: "workspace", id: "w1" }))).toBeNull();
  expect(localStorage.getItem(scopedStorageKey(DURABLE_KEYS.tree, { kind: "workspace", id: "w2" }))).toBe("{}");
  expect(localStorage.getItem(DURABLE_KEYS.tree)).toBe("{}");
});
