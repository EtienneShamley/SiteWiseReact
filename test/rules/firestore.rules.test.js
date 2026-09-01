// test/rules/firestore.rules.test.js
//
// Firestore Security Rules, verified against the REAL `firestore.rules` in
// the Firestore emulator (@firebase/rules-unit-testing). Run with
// `npm run test:rules` (= `firebase emulators:exec --only firestore
// "node --test test/rules/"`); CI runs it in the Validate stage with no
// Firebase project or credential (the emulator is local).
//
// Deliberately Node's own test runner, not Jest: it runs in the real Node
// realm, where `fetch` and the web streams the rules-testing library and the
// Firestore SDK need already exist. Kept outside `src/` so the application's
// Jest run never picks it up.
//
// Cases (Phase 6 brief §31, 34–41 and §19–20):
//   unauthenticated denied · workspace member allowed · non-member denied ·
//   cross-workspace read/write denied · membership escalation denied ·
//   the valid bootstrap path allowed · arbitrary workspace-id spoofing fails ·
//   malformed ownership/envelope fields rejected · chunks · migrations.

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, deleteDoc, runTransaction, serverTimestamp, writeBatch, collection, getDocs } = require("firebase/firestore");

const PROJECT_ID = "notewise-rules-test";
let env;

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8"),
      host,
      port: Number(port),
    },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

const db = (uid) => env.authenticatedContext(uid, { email_verified: true }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

/** The exact bootstrap transaction the client runs (src/lib/cloud/workspaceBootstrap.js). */
async function bootstrap(firestore, uid, wid) {
  return runTransaction(firestore, async (tx) => {
    const now = serverTimestamp();
    tx.set(doc(firestore, "workspaces", wid), {
      id: wid,
      name: "My workspace",
      ownerUid: uid,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    tx.set(doc(firestore, "workspaces", wid, "members", uid), { uid, role: "owner", addedAt: now, addedBy: uid });
    tx.set(doc(firestore, "users", uid), { uid, defaultWorkspaceId: wid, createdAt: now, updatedAt: now });
  });
}

/** Seeds a workspace owned by `uid` with the rules bypassed. */
async function seedWorkspace(uid, wid) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    const now = new Date();
    await setDoc(doc(f, "workspaces", wid), { id: wid, name: "Seeded", ownerUid: uid, schemaVersion: 1, createdAt: now, updatedAt: now });
    await setDoc(doc(f, "workspaces", wid, "members", uid), { uid, role: "owner", addedAt: now, addedBy: uid });
    await setDoc(doc(f, "users", uid), { uid, defaultWorkspaceId: wid, createdAt: now, updatedAt: now });
  });
}

const envelope = (wid, kind, id, extra) => ({ workspaceId: wid, id, kind, schemaVersion: 1, updatedAt: serverTimestamp(), ...extra });

describe("bootstrap", { concurrency: false }, () => {
  test("40. the valid bootstrap path is allowed and resolves membership", async () => {
    await assertSucceeds(bootstrap(db("alice"), "alice", "ws-alice"));
    const member = await getDoc(doc(db("alice"), "workspaces", "ws-alice", "members", "alice"));
    assert.equal(member.exists(), true);
    assert.equal(member.data().role, "owner");
    const user = await getDoc(doc(db("alice"), "users", "alice"));
    assert.equal(user.data().defaultWorkspaceId, "ws-alice");
  });

  test("34. unauthenticated: nothing at all", async () => {
    await seedWorkspace("alice", "ws-alice");
    await assertFails(getDoc(doc(anon(), "workspaces", "ws-alice")));
    await assertFails(getDoc(doc(anon(), "users", "alice")));
    await assertFails(setDoc(doc(anon(), "workspaces", "ws-x"), { id: "ws-x", name: "x", ownerUid: "nobody", schemaVersion: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(anon(), "workspaces", "ws-alice", "nodes", "n1"), envelope("ws-alice", "nodes", "n1", { nodeKind: "note", title: "x", parentId: null, order: 0 })));
  });

  test("39. membership escalation: a user cannot write themselves into an existing workspace", async () => {
    await seedWorkspace("alice", "ws-alice");
    const mallory = db("mallory");
    await assertFails(setDoc(doc(mallory, "workspaces", "ws-alice", "members", "mallory"), { uid: "mallory", role: "owner", addedAt: serverTimestamp(), addedBy: "mallory" }));
    await assertFails(setDoc(doc(mallory, "workspaces", "ws-alice", "members", "mallory"), { uid: "mallory", role: "member", addedAt: serverTimestamp(), addedBy: "alice" }));
    // ...nor by re-owning the workspace
    await assertFails(setDoc(doc(mallory, "workspaces", "ws-alice"), { id: "ws-alice", name: "Mine now", ownerUid: "mallory", schemaVersion: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    // ...nor by a transaction that rewrites the owner and adds a membership
    await assertFails(
      runTransaction(mallory, async (tx) => {
        tx.set(doc(mallory, "workspaces", "ws-alice"), { id: "ws-alice", name: "Mine", ownerUid: "mallory", schemaVersion: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(doc(mallory, "workspaces", "ws-alice", "members", "mallory"), { uid: "mallory", role: "owner", addedAt: serverTimestamp(), addedBy: "mallory" });
      })
    );
    // ...nor may the owner change the owner
    await assertFails(setDoc(doc(db("alice"), "workspaces", "ws-alice"), { id: "ws-alice", name: "x", ownerUid: "mallory", schemaVersion: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true }));
  });

  test("41. workspace-id spoofing: a user record cannot point at a workspace the user is not a member of", async () => {
    await seedWorkspace("alice", "ws-alice");
    const mallory = db("mallory");
    await assertFails(setDoc(doc(mallory, "users", "mallory"), { uid: "mallory", defaultWorkspaceId: "ws-alice", createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    // a workspace document may not be created with someone else as owner or a mismatched id
    await assertFails(setDoc(doc(mallory, "workspaces", "ws-m"), { id: "ws-m", name: "x", ownerUid: "alice", schemaVersion: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(mallory, "workspaces", "ws-m"), { id: "other", name: "x", ownerUid: "mallory", schemaVersion: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    // a member document for another uid, even in one's own new workspace
    await assertFails(
      runTransaction(mallory, async (tx) => {
        tx.set(doc(mallory, "workspaces", "ws-m2"), { id: "ws-m2", name: "x", ownerUid: "mallory", schemaVersion: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(doc(mallory, "workspaces", "ws-m2", "members", "alice"), { uid: "alice", role: "owner", addedAt: serverTimestamp(), addedBy: "mallory" });
      })
    );
  });

  test("a repaired owner membership is allowed; a user's own record is readable only by them", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const f = ctx.firestore();
      const now = new Date();
      await setDoc(doc(f, "workspaces", "ws-p"), { id: "ws-p", name: "Partial", ownerUid: "alice", schemaVersion: 1, createdAt: now, updatedAt: now });
      await setDoc(doc(f, "users", "alice"), { uid: "alice", defaultWorkspaceId: "ws-p", createdAt: now, updatedAt: now });
    });
    await assertSucceeds(setDoc(doc(db("alice"), "workspaces", "ws-p", "members", "alice"), { uid: "alice", role: "owner", addedAt: serverTimestamp(), addedBy: "alice" }));
    await assertFails(getDoc(doc(db("mallory"), "users", "alice")));
    await assertFails(deleteDoc(doc(db("alice"), "users", "alice")));
    await assertFails(deleteDoc(doc(db("alice"), "workspaces", "ws-p")));
    await assertFails(deleteDoc(doc(db("alice"), "workspaces", "ws-p", "members", "alice")));
  });
});

describe("entity documents", { concurrency: false }, () => {
  beforeEach(async () => {
    await seedWorkspace("alice", "ws-alice");
    await seedWorkspace("bob", "ws-bob");
  });

  test("35. a member may write and read every entity kind with a valid envelope", async () => {
    const f = db("alice");
    const batch = writeBatch(f);
    batch.set(doc(f, "workspaces", "ws-alice", "nodes", "p1"), envelope("ws-alice", "nodes", "p1", { nodeKind: "project", name: "Site A", parentId: null, order: 0 }));
    batch.set(doc(f, "workspaces", "ws-alice", "noteContent", "n1"), envelope("ws-alice", "noteContent", "n1", { html: "<p>Hi</p>" }));
    batch.set(doc(f, "workspaces", "ws-alice", "templates", "t1"), envelope("ws-alice", "templates", "t1", { json: "{\"id\":\"t1\"}" }));
    batch.set(doc(f, "workspaces", "ws-alice", "templateVersions", "v1"), envelope("ws-alice", "templateVersions", "v1", { json: "{}" }));
    batch.set(doc(f, "workspaces", "ws-alice", "templateInstances", "n1"), envelope("ws-alice", "templateInstances", "n1", { json: "{}" }));
    batch.set(doc(f, "workspaces", "ws-alice", "pdfDocs", "pdf1"), envelope("ws-alice", "pdfDocs", "pdf1", { json: "{}" }));
    batch.set(doc(f, "workspaces", "ws-alice", "notePdfRefs", "n1"), envelope("ws-alice", "notePdfRefs", "n1", { pdfId: "pdf1" }));
    batch.set(doc(f, "workspaces", "ws-alice", "settings", "templates"), envelope("ws-alice", "settings", "templates", { defaultTemplateId: "t1" }));
    await assertSucceeds(batch.commit());
    const read = await getDocs(collection(f, "workspaces", "ws-alice", "nodes"));
    assert.equal(read.size, 1);
    await assertSucceeds(deleteDoc(doc(f, "workspaces", "ws-alice", "nodes", "p1")));
    // the migration record
    await assertSucceeds(setDoc(doc(f, "workspaces", "ws-alice", "migrations", "src-1"), { workspaceId: "ws-alice", uid: "alice", sourceId: "src-1", status: "completed", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "migrations", "src-2"), { workspaceId: "ws-alice", uid: "bob", sourceId: "src-2", status: "completed", updatedAt: serverTimestamp() }));
  });

  test("36/37/38. a non-member can neither read nor write another workspace", async () => {
    await setDoc(doc(db("alice"), "workspaces", "ws-alice", "noteContent", "n1"), envelope("ws-alice", "noteContent", "n1", { html: "<p>secret</p>" }));
    const bob = db("bob");
    await assertFails(getDoc(doc(bob, "workspaces", "ws-alice", "noteContent", "n1")));
    await assertFails(getDocs(collection(bob, "workspaces", "ws-alice", "noteContent")));
    await assertFails(getDoc(doc(bob, "workspaces", "ws-alice")));
    await assertFails(getDoc(doc(bob, "workspaces", "ws-alice", "members", "alice")));
    await assertFails(setDoc(doc(bob, "workspaces", "ws-alice", "noteContent", "n2"), envelope("ws-alice", "noteContent", "n2", { html: "<p>x</p>" })));
    await assertFails(deleteDoc(doc(bob, "workspaces", "ws-alice", "noteContent", "n1")));
    // a batch mixing own and foreign workspace fails as a whole
    const batch = writeBatch(bob);
    batch.set(doc(bob, "workspaces", "ws-bob", "noteContent", "b1"), envelope("ws-bob", "noteContent", "b1", { html: "<p>b</p>" }));
    batch.set(doc(bob, "workspaces", "ws-alice", "noteContent", "n3"), envelope("ws-alice", "noteContent", "n3", { html: "<p>x</p>" }));
    await assertFails(batch.commit());
    assert.equal((await getDoc(doc(bob, "workspaces", "ws-bob", "noteContent", "b1"))).exists(), false);
  });

  test("malformed envelope / ownership fields are rejected", async () => {
    const f = db("alice");
    const ref = doc(f, "workspaces", "ws-alice", "noteContent", "n1");
    // wrong workspaceId (claims another workspace)
    await assertFails(setDoc(ref, envelope("ws-bob", "noteContent", "n1", { html: "<p>x</p>" })));
    // id mismatch
    await assertFails(setDoc(ref, envelope("ws-alice", "noteContent", "other", { html: "<p>x</p>" })));
    // kind mismatch
    await assertFails(setDoc(ref, envelope("ws-alice", "nodes", "n1", { html: "<p>x</p>" })));
    // client-supplied timestamp instead of the server's
    await assertFails(setDoc(ref, { ...envelope("ws-alice", "noteContent", "n1", { html: "<p>x</p>" }), updatedAt: new Date(2020, 1, 1) }));
    // unknown field
    await assertFails(setDoc(ref, envelope("ws-alice", "noteContent", "n1", { html: "<p>x</p>", ownerUid: "alice" })));
    // payload of the wrong type
    await assertFails(setDoc(ref, envelope("ws-alice", "noteContent", "n1", { html: 42 })));
    // a node with an invalid kind
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "nodes", "x"), envelope("ws-alice", "nodes", "x", { nodeKind: "workspace", name: "x", parentId: null, order: 0 })));
    // an unknown collection
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "secrets", "s"), envelope("ws-alice", "secrets", "s", { json: "{}" })));
  });

  test("chunked payloads: parent + chunks accepted, malformed chunk refused", async () => {
    const f = db("alice");
    const batch = writeBatch(f);
    batch.set(doc(f, "workspaces", "ws-alice", "noteContent", "big"), envelope("ws-alice", "noteContent", "big", { chunked: true, chunkCount: 2, payloadUnits: 10 }));
    batch.set(doc(f, "workspaces", "ws-alice", "noteContent", "big", "chunks", "0"), { workspaceId: "ws-alice", id: "big", kind: "noteContent", index: 0, text: "<p>he", updatedAt: serverTimestamp() });
    batch.set(doc(f, "workspaces", "ws-alice", "noteContent", "big", "chunks", "1"), { workspaceId: "ws-alice", id: "big", kind: "noteContent", index: 1, text: "llo</p>", updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "noteContent", "big", "chunks", "2"), { workspaceId: "ws-bob", id: "big", kind: "noteContent", index: 2, text: "x", updatedAt: serverTimestamp() }));
    await assertFails(getDoc(doc(db("bob"), "workspaces", "ws-alice", "noteContent", "big", "chunks", "0")));
    await assertSucceeds(deleteDoc(doc(f, "workspaces", "ws-alice", "noteContent", "big", "chunks", "0")));
  });
});
