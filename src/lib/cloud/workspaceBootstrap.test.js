// src/lib/cloud/workspaceBootstrap.test.js
//
// WORKSPACE BOOTSTRAP (Phase 6 brief §31, 1–5): one workspace per new user,
// the same one on every later sign-in, partial-state repair, two users get
// isolated workspaces, and the in-memory store's rules-equivalent refusals.
import { BOOTSTRAP_ERROR, MEMBER_ROLE, bootstrapWorkspace } from "./workspaceBootstrap";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";

function storeFor(uid) {
  const store = createMemoryWorkspaceStore({ now: () => 1000 });
  store.setUser(uid);
  return store;
}

test("1. a new authenticated user receives exactly one workspace, owned by them, with an owner membership", async () => {
  const store = storeFor("alice");
  const result = await bootstrapWorkspace(store, { uid: "alice", newWorkspaceId: () => "ws-a" });
  expect(result).toEqual({ workspaceId: "ws-a", role: MEMBER_ROLE.OWNER, created: true });
  expect(store.get(["workspaces", "ws-a"])).toMatchObject({ id: "ws-a", ownerUid: "alice", schemaVersion: 1, createdAt: 1000, updatedAt: 1000 });
  expect(store.get(["workspaces", "ws-a", "members", "alice"])).toEqual({ uid: "alice", role: "owner", addedAt: 1000, addedBy: "alice" });
  expect(store.get(["users", "alice"])).toEqual({ uid: "alice", defaultWorkspaceId: "ws-a", createdAt: 1000, updatedAt: 1000 });
  expect(store.calls.transactions).toBe(1);
});

test("2. a repeat bootstrap resolves the SAME workspace and writes nothing", async () => {
  const store = storeFor("alice");
  await bootstrapWorkspace(store, { uid: "alice", newWorkspaceId: () => "ws-a" });
  const snapshot = JSON.stringify(store.dump());
  const again = await bootstrapWorkspace(store, { uid: "alice", newWorkspaceId: () => "ws-SHOULD-NOT-BE-USED" });
  expect(again).toEqual({ workspaceId: "ws-a", role: MEMBER_ROLE.OWNER, created: false });
  expect(JSON.stringify(store.dump())).toBe(snapshot);
});

test("3. a partial bootstrap (workspace + pointer, no membership) is repaired; a foreign pointer is refused", async () => {
  const store = storeFor("alice");
  store.seed(["workspaces", "ws-p"], { id: "ws-p", ownerUid: "alice", name: "Partial" });
  store.seed(["users", "alice"], { uid: "alice", defaultWorkspaceId: "ws-p", createdAt: 1 });
  const repaired = await bootstrapWorkspace(store, { uid: "alice" });
  expect(repaired).toEqual({ workspaceId: "ws-p", role: MEMBER_ROLE.OWNER, created: false, repaired: true });
  expect(store.get(["workspaces", "ws-p", "members", "alice"]).role).toBe("owner");

  // a user record pointing at a workspace someone else owns is never claimed
  const mallory = storeFor("mallory");
  mallory.seed(["workspaces", "ws-a"], { id: "ws-a", ownerUid: "alice" });
  mallory.seed(["users", "mallory"], { uid: "mallory", defaultWorkspaceId: "ws-a" });
  await expect(bootstrapWorkspace(mallory, { uid: "mallory" })).rejects.toMatchObject({ code: BOOTSTRAP_ERROR.NOT_A_MEMBER });
  expect(mallory.get(["workspaces", "ws-a", "members", "mallory"])).toBeNull();
});

test("a transient failure leaves nothing half-created; the retry succeeds and resolves one workspace", async () => {
  const store = storeFor("alice");
  store.failNext("transaction", "unavailable");
  await expect(bootstrapWorkspace(store, { uid: "alice", newWorkspaceId: () => "ws-a" })).rejects.toMatchObject({ code: "unavailable" });
  expect(store.dump()).toEqual({});
  const result = await bootstrapWorkspace(store, { uid: "alice", newWorkspaceId: () => "ws-a" });
  expect(result.created).toBe(true);
});

test("a double invocation resolves the same workspace once the first has committed", async () => {
  const store = storeFor("alice");
  let n = 0;
  const first = bootstrapWorkspace(store, { uid: "alice", newWorkspaceId: () => `ws-${++n}` });
  const second = first.then(() => bootstrapWorkspace(store, { uid: "alice", newWorkspaceId: () => `ws-${++n}` }));
  const [a, b] = await Promise.all([first, second]);
  expect(a.workspaceId).toBe("ws-1");
  expect(b.workspaceId).toBe("ws-1");
  expect(b.created).toBe(false);
  expect(Object.keys(store.dump()).filter((k) => k.startsWith("workspaces/") && k.split("/").length === 2)).toEqual(["workspaces/ws-1"]);
});

test("4. two users receive isolated workspaces and cannot read each other's", async () => {
  const store = createMemoryWorkspaceStore();
  store.setUser("alice");
  const a = await bootstrapWorkspace(store, { uid: "alice", newWorkspaceId: () => "ws-a" });
  store.setUser("bob");
  const b = await bootstrapWorkspace(store, { uid: "bob", newWorkspaceId: () => "ws-b" });
  expect(a.workspaceId).not.toBe(b.workspaceId);
  await expect(store.readWorkspace("ws-a")).rejects.toMatchObject({ code: "permission-denied" });
  await expect(store.commitBatch("ws-a", [{ type: "set", path: ["nodes", "x"], fields: { workspaceId: "ws-a" } }])).rejects.toMatchObject({ code: "permission-denied" });
  await expect(store.readWorkspace("ws-b")).resolves.toEqual({ documents: [] });
});

test("the store refuses a bootstrap-shaped write that would escalate: self-membership in another's workspace", async () => {
  const store = storeFor("mallory");
  store.seed(["workspaces", "ws-a"], { id: "ws-a", ownerUid: "alice" });
  await expect(
    store.runTransaction(async (tx) => {
      tx.set(["workspaces", "ws-a", "members", "mallory"], { uid: "mallory", role: "owner", addedAt: 1, addedBy: "mallory" });
    })
  ).rejects.toMatchObject({ code: "permission-denied" });
  await expect(
    store.runTransaction(async (tx) => {
      tx.set(["workspaces", "ws-a"], { id: "ws-a", ownerUid: "mallory" });
    })
  ).rejects.toMatchObject({ code: "permission-denied" });
  await expect(bootstrapWorkspace(store, { uid: "" })).rejects.toMatchObject({ code: BOOTSTRAP_ERROR.BAD_USER_RECORD });
});

test("5. an unverified user still receives a workspace (Phase 5 policy: unverified may use the app, may not spend)", async () => {
  const store = storeFor("unverified-uid");
  const result = await bootstrapWorkspace(store, { uid: "unverified-uid", newWorkspaceId: () => "ws-u" });
  expect(result.created).toBe(true);
});
