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
const { doc, getDoc, setDoc, deleteDoc, runTransaction, serverTimestamp, writeBatch, collection, getDocs, query, where } = require("firebase/firestore");

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

// ---------------------------------------------------------------------------
// Asset metadata (Production Readiness Phase 7.3): workspaces/{wid}/assets/
// {assetId}. Field model: src/lib/cloud/assetCloudModel.js.
// ---------------------------------------------------------------------------

const ASSET = "asset-1";
const assetDoc = (wid, id, extra = {}) =>
  envelope(wid, "assets", id, {
    assetKind: "editor-image",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    size: 1234,
    createdAt: 1725000000000,
    metadata: { width: 640, height: 480 },
    state: "stored",
    ...extra,
  });

/** Seeds an asset document with the rules bypassed. */
async function seedAsset(wid, id, extra = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    await setDoc(doc(f, "workspaces", wid, "assets", id), { ...assetDoc(wid, id, extra), updatedAt: new Date() });
  });
}

/** Adds an ORDINARY (non-owner) member with the rules bypassed. */
async function seedMember(wid, uid) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const now = new Date();
    await setDoc(doc(ctx.firestore(), "workspaces", wid, "members", uid), { uid, role: "member", addedAt: now, addedBy: "alice" });
  });
}

describe("asset metadata documents", { concurrency: false }, () => {
  beforeEach(async () => {
    await seedWorkspace("alice", "ws-alice");
    await seedWorkspace("bob", "ws-bob");
    await seedMember("ws-alice", "mia"); // an ordinary member of alice's workspace
  });

  test("a member reads one document and the index; a non-member reads neither", async () => {
    await seedAsset("ws-alice", ASSET);
    for (const uid of ["alice", "mia"]) {
      const f = db(uid);
      const snap = await assertSucceeds(getDoc(doc(f, "workspaces", "ws-alice", "assets", ASSET)));
      assert.equal(snap.data().assetKind, "editor-image");
      assert.equal((await assertSucceeds(getDocs(collection(f, "workspaces", "ws-alice", "assets")))).size, 1);
    }
    await assertFails(getDoc(doc(db("bob"), "workspaces", "ws-alice", "assets", ASSET)));
    await assertFails(getDocs(collection(db("bob"), "workspaces", "ws-alice", "assets")));
    await assertFails(getDoc(doc(anon(), "workspaces", "ws-alice", "assets", ASSET)));
  });

  test("a valid create is allowed for every kind, with and without a source asset", async () => {
    const f = db("mia");
    await assertSucceeds(setDoc(doc(f, "workspaces", "ws-alice", "assets", ASSET), assetDoc("ws-alice", ASSET)));
    for (const kind of ["logo", "note-photo", "note-file", "editor-image", "editor-file", "pdf-source"]) {
      const id = `asset-${kind}`;
      await assertSucceeds(setDoc(doc(f, "workspaces", "ws-alice", "assets", id), assetDoc("ws-alice", id, { assetKind: kind, mimeType: kind === "pdf-source" ? "application/pdf" : "image/png" })));
    }
    await assertSucceeds(setDoc(doc(f, "workspaces", "ws-alice", "assets", "rendition-1"), assetDoc("ws-alice", "rendition-1", { sourceAssetId: ASSET, name: null, metadata: {} })));
    // The same document may be re-written unchanged (an idempotent upsert).
    await assertSucceeds(setDoc(doc(f, "workspaces", "ws-alice", "assets", ASSET), assetDoc("ws-alice", ASSET)));
  });

  test("a non-member cannot create, and a member cannot create in another workspace", async () => {
    await assertFails(setDoc(doc(db("bob"), "workspaces", "ws-alice", "assets", ASSET), assetDoc("ws-alice", ASSET)));
    await assertFails(setDoc(doc(db("alice"), "workspaces", "ws-bob", "assets", ASSET), assetDoc("ws-bob", ASSET)));
    await assertFails(setDoc(doc(anon(), "workspaces", "ws-alice", "assets", ASSET), assetDoc("ws-alice", ASSET)));
  });

  test("a spoofed workspace, id or collection kind is refused", async () => {
    const ref = doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET);
    await assertFails(setDoc(ref, assetDoc("ws-bob", ASSET)));
    await assertFails(setDoc(ref, assetDoc("ws-alice", "asset-other")));
    await assertFails(setDoc(ref, { ...assetDoc("ws-alice", ASSET), kind: "nodes" }));
    await assertFails(setDoc(ref, { ...assetDoc("ws-alice", ASSET), updatedAt: new Date(2020, 1, 1) }));
    // an id that is not a NoteWise id
    await assertFails(setDoc(doc(db("alice"), "workspaces", "ws-alice", "assets", ".hidden"), assetDoc("ws-alice", ".hidden")));
  });

  test("a bad kind, state, size, schema version, name, MIME type, metadata or source id is refused", async () => {
    const ref = doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET);
    const bad = [
      { assetKind: "avatar" },
      { assetKind: "asset" },
      { state: "tombstoned", tombstonedAt: serverTimestamp() }, // must be created stored
      { state: "pending" },
      { tombstonedAt: serverTimestamp() }, // a tombstone on a stored asset
      { size: 0 },
      { size: -1 },
      { size: 50 * 1024 * 1024 + 1 },
      { size: 12.5 },
      { size: "1234" },
      { schemaVersion: 2 },
      { schemaVersion: "1" },
      { name: "x".repeat(256) },
      { name: 42 },
      { mimeType: "image/svg+xml" },
      { mimeType: "text/html" },
      { mimeType: "application/octet-stream" },
      { mimeType: "" },
      { mimeType: null },
      { createdAt: 0 },
      { createdAt: "2026" },
      { metadata: "x" },
      { metadata: null },
      { metadata: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) },
      { sourceAssetId: ASSET }, // its own id
      { sourceAssetId: "../x" },
      { sourceAssetId: 7 },
      { ownerUid: "alice" }, // unknown field
      { downloadUrl: "https://example.test/x" },
    ];
    for (const extra of bad) {
      await assertFails(setDoc(ref, assetDoc("ws-alice", ASSET, extra)));
    }
    // a required field missing
    const { metadata: _m, ...noMetadata } = assetDoc("ws-alice", ASSET);
    await assertFails(setDoc(ref, noMetadata));
    const { name: _n, ...noName } = assetDoc("ws-alice", ASSET);
    await assertFails(setDoc(ref, noName));
    // exactly the ceiling is fine
    await assertSucceeds(setDoc(ref, assetDoc("ws-alice", ASSET, { size: 50 * 1024 * 1024 })));
  });

  test("identity and description are immutable on update", async () => {
    await seedAsset("ws-alice", ASSET);
    const ref = doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET);
    const mutations = [
      { assetKind: "logo" },
      { createdAt: 1725000000001 },
      { name: "renamed.jpg" },
      { mimeType: "image/png" },
      { size: 1235 },
      { metadata: { width: 1 } },
      { sourceAssetId: "asset-2" },
    ];
    for (const extra of mutations) {
      await assertFails(setDoc(ref, assetDoc("ws-alice", ASSET, extra)));
    }
    await assertFails(setDoc(ref, { name: "renamed.jpg", updatedAt: serverTimestamp() }, { merge: true }));
    await assertFails(setDoc(ref, { workspaceId: "ws-bob", updatedAt: serverTimestamp() }, { merge: true }));
    await assertFails(setDoc(ref, { schemaVersion: 2, updatedAt: serverTimestamp() }, { merge: true }));
    const snap = await getDoc(ref);
    assert.equal(snap.data().name, "photo.jpg");
  });

  test("stored → tombstoned with the server clock, then back to stored — by any member", async () => {
    await seedAsset("ws-alice", ASSET);
    const ref = doc(db("mia"), "workspaces", "ws-alice", "assets", ASSET);
    // a client clock is refused; the server's is required
    await assertFails(setDoc(ref, assetDoc("ws-alice", ASSET, { state: "tombstoned", tombstonedAt: new Date() })));
    await assertFails(setDoc(ref, assetDoc("ws-alice", ASSET, { state: "tombstoned" }))); // no clock at all
    await assertSucceeds(setDoc(ref, assetDoc("ws-alice", ASSET, { state: "tombstoned", tombstonedAt: serverTimestamp() })));
    const tombstoned = (await getDoc(ref)).data();
    assert.equal(tombstoned.state, "tombstoned");
    assert.ok(tombstoned.tombstonedAt);

    // a standing tombstone keeps its clock: refreshing it is refused, re-sending it is fine
    await assertFails(setDoc(ref, assetDoc("ws-alice", ASSET, { state: "tombstoned", tombstonedAt: serverTimestamp() })));
    await assertSucceeds(setDoc(ref, assetDoc("ws-alice", ASSET, { state: "tombstoned", tombstonedAt: tombstoned.tombstonedAt })));

    // resurrection drops the tombstone; keeping it while stored is refused
    await assertFails(setDoc(ref, assetDoc("ws-alice", ASSET, { state: "stored", tombstonedAt: tombstoned.tombstonedAt })));
    await assertSucceeds(setDoc(ref, assetDoc("ws-alice", ASSET)));
    assert.equal((await getDoc(ref)).data().state, "stored");
    assert.equal("tombstonedAt" in (await getDoc(ref)).data(), false);

    // a non-member cannot tombstone
    await assertFails(setDoc(doc(db("bob"), "workspaces", "ws-alice", "assets", ASSET), assetDoc("ws-alice", ASSET, { state: "tombstoned", tombstonedAt: serverTimestamp() })));
  });

  // Phase 7.10A: NoteWise V1 performs no physical cloud-asset deletion, so
  // the metadata document — the only handle the product has on an object —
  // is never destroyed from a client. `allow delete: if false`.
  test("delete: denied to EVERYBODY — the workspace owner included", async () => {
    await seedAsset("ws-alice", ASSET);
    await assertFails(deleteDoc(doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET))); // the owner
    await assertFails(deleteDoc(doc(db("mia"), "workspaces", "ws-alice", "assets", ASSET))); // an ordinary member
    await assertFails(deleteDoc(doc(db("bob"), "workspaces", "ws-alice", "assets", ASSET))); // another workspace's owner
    await assertFails(deleteDoc(doc(anon(), "workspaces", "ws-alice", "assets", ASSET))); // signed out
    // The document is untouched, and still deletable by nobody after a tombstone.
    assert.equal((await getDoc(doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET))).exists(), true);
    await assertSucceeds(
      setDoc(doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET), assetDoc("ws-alice", ASSET, { state: "tombstoned", tombstonedAt: serverTimestamp() }))
    );
    await assertFails(deleteDoc(doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET)));
    const standing = await getDoc(doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET));
    assert.equal(standing.exists(), true);
    assert.equal(standing.data().state, "tombstoned");
  });

  test("delete: denied inside a batch too, and the batch's other writes do not land", async () => {
    await seedAsset("ws-alice", ASSET);
    const f = db("alice");
    const batch = writeBatch(f);
    batch.set(doc(f, "workspaces", "ws-alice", "nodes", "p1"), { workspaceId: "ws-alice", id: "p1", kind: "nodes", schemaVersion: 1, nodeKind: "project", name: "P", updatedAt: serverTimestamp() });
    batch.delete(doc(f, "workspaces", "ws-alice", "assets", ASSET));
    await assertFails(batch.commit());
    assert.equal((await getDoc(doc(f, "workspaces", "ws-alice", "assets", ASSET))).exists(), true);
    assert.equal((await getDoc(doc(f, "workspaces", "ws-alice", "nodes", "p1"))).exists(), false);
  });

  test("an unrelated workspace can neither read, rewrite, tombstone nor delete this asset", async () => {
    await seedAsset("ws-alice", ASSET);
    const stranger = db("bob"); // owner of ws-bob, nothing in ws-alice
    const ref = doc(stranger, "workspaces", "ws-alice", "assets", ASSET);
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, assetDoc("ws-alice", ASSET)));
    await assertFails(setDoc(ref, assetDoc("ws-alice", ASSET, { state: "tombstoned", tombstonedAt: serverTimestamp() })));
    await assertFails(deleteDoc(ref));
    const snap = await getDoc(doc(db("alice"), "workspaces", "ws-alice", "assets", ASSET));
    assert.equal(snap.exists(), true);
    assert.equal(snap.data().state, "stored");
  });

  test("a batch mixing a valid asset write with a foreign one fails as a whole", async () => {
    const f = db("alice");
    const batch = writeBatch(f);
    batch.set(doc(f, "workspaces", "ws-alice", "assets", ASSET), assetDoc("ws-alice", ASSET));
    batch.set(doc(f, "workspaces", "ws-bob", "assets", ASSET), assetDoc("ws-bob", ASSET));
    await assertFails(batch.commit());
    assert.equal((await getDoc(doc(f, "workspaces", "ws-alice", "assets", ASSET))).exists(), false);
  });
});

// ---------------------------------------------------------------------------
// pdfAnnotations (Phase 7.3 seam, synced since Phase 7.7): joins the
// JSON-string collections. The product writes `{ items: [...] }` as the
// `json` string (chunked past the inline budget) and deletes the document —
// and its chunks — with the PDF, under the ordinary member delete policy of
// every JSON entity (NOT the owner-only policy of `assets`).
// ---------------------------------------------------------------------------

describe("pdfAnnotations documents", { concurrency: false }, () => {
  beforeEach(async () => {
    await seedWorkspace("alice", "ws-alice");
    await seedWorkspace("bob", "ws-bob");
  });

  test("a member writes, reads, chunks and deletes a valid JSON document", async () => {
    const f = db("alice");
    const ref = doc(f, "workspaces", "ws-alice", "pdfAnnotations", "pdf1");
    await assertSucceeds(setDoc(ref, envelope("ws-alice", "pdfAnnotations", "pdf1", { json: "{\"items\":[]}" })));
    assert.equal((await assertSucceeds(getDoc(ref))).data().kind, "pdfAnnotations");
    const batch = writeBatch(f);
    batch.set(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "big"), envelope("ws-alice", "pdfAnnotations", "big", { chunked: true, chunkCount: 1, payloadUnits: 2 }));
    batch.set(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "big", "chunks", "0"), { workspaceId: "ws-alice", id: "big", kind: "pdfAnnotations", index: 0, text: "{}", updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    await assertSucceeds(deleteDoc(ref));
  });

  test("cross-workspace access and an envelope mismatch are refused", async () => {
    await setDoc(doc(db("alice"), "workspaces", "ws-alice", "pdfAnnotations", "pdf1"), envelope("ws-alice", "pdfAnnotations", "pdf1", { json: "{}" }));
    const bob = db("bob");
    await assertFails(getDoc(doc(bob, "workspaces", "ws-alice", "pdfAnnotations", "pdf1")));
    await assertFails(setDoc(doc(bob, "workspaces", "ws-alice", "pdfAnnotations", "pdf2"), envelope("ws-alice", "pdfAnnotations", "pdf2", { json: "{}" })));
    await assertFails(deleteDoc(doc(bob, "workspaces", "ws-alice", "pdfAnnotations", "pdf1")));
    const ref = doc(db("alice"), "workspaces", "ws-alice", "pdfAnnotations", "pdf1");
    await assertFails(setDoc(ref, envelope("ws-bob", "pdfAnnotations", "pdf1", { json: "{}" })));
    await assertFails(setDoc(ref, envelope("ws-alice", "pdfDocs", "pdf1", { json: "{}" })));
    await assertFails(setDoc(ref, envelope("ws-alice", "pdfAnnotations", "other", { json: "{}" })));
    await assertFails(setDoc(ref, envelope("ws-alice", "pdfAnnotations", "pdf1", { json: 42 })));
    await assertFails(setDoc(ref, envelope("ws-alice", "pdfAnnotations", "pdf1", { json: "{}", items: [] })));
  });

  test("7.7: an unauthenticated caller can neither read, write nor delete", async () => {
    await setDoc(doc(db("alice"), "workspaces", "ws-alice", "pdfAnnotations", "pdf1"), envelope("ws-alice", "pdfAnnotations", "pdf1", { json: "{\"items\":[]}" }));
    const a = anon();
    await assertFails(getDoc(doc(a, "workspaces", "ws-alice", "pdfAnnotations", "pdf1")));
    await assertFails(setDoc(doc(a, "workspaces", "ws-alice", "pdfAnnotations", "pdf9"), envelope("ws-alice", "pdfAnnotations", "pdf9", { json: "{}" })));
    await assertFails(deleteDoc(doc(a, "workspaces", "ws-alice", "pdfAnnotations", "pdf1")));
    await assertFails(getDoc(doc(a, "workspaces", "ws-alice", "pdfAnnotations", "pdf1", "chunks", "0")));
  });

  test("7.7: an ORDINARY member may delete the document and its chunks — the JSON-entity policy, unlike assets", async () => {
    await seedMember("ws-alice", "carol");
    const f = db("alice");
    const batch = writeBatch(f);
    batch.set(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "big"), envelope("ws-alice", "pdfAnnotations", "big", { chunked: true, chunkCount: 2, payloadUnits: 4 }));
    batch.set(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "big", "chunks", "0"), { workspaceId: "ws-alice", id: "big", kind: "pdfAnnotations", index: 0, text: "{\"i", updatedAt: serverTimestamp() });
    batch.set(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "big", "chunks", "1"), { workspaceId: "ws-alice", id: "big", kind: "pdfAnnotations", index: 1, text: "\":1}", updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    const carol = db("carol");
    // The member reads it (and its chunks) …
    assert.equal((await assertSucceeds(getDoc(doc(carol, "workspaces", "ws-alice", "pdfAnnotations", "big")))).data().chunkCount, 2);
    // … writes a newer version …
    await assertSucceeds(setDoc(doc(carol, "workspaces", "ws-alice", "pdfAnnotations", "pdf2"), envelope("ws-alice", "pdfAnnotations", "pdf2", { json: "{\"items\":[]}" })));
    // … and deletes the document with its chunks in one batch, as the engine does.
    const del = writeBatch(carol);
    del.delete(doc(carol, "workspaces", "ws-alice", "pdfAnnotations", "big"));
    del.delete(doc(carol, "workspaces", "ws-alice", "pdfAnnotations", "big", "chunks", "0"));
    del.delete(doc(carol, "workspaces", "ws-alice", "pdfAnnotations", "big", "chunks", "1"));
    await assertSucceeds(del.commit());
    assert.equal((await getDoc(doc(db("alice"), "workspaces", "ws-alice", "pdfAnnotations", "big"))).exists(), false);
    // Nobody outside the workspace may, even with a valid envelope.
    await assertFails(deleteDoc(doc(db("bob"), "workspaces", "ws-alice", "pdfAnnotations", "pdf2")));
  });

  test("7.7: the chunk cap and the chunk envelope hold for annotation documents", async () => {
    const f = db("alice");
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "huge"), envelope("ws-alice", "pdfAnnotations", "huge", { chunked: true, chunkCount: 65, payloadUnits: 1 })));
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "huge"), envelope("ws-alice", "pdfAnnotations", "huge", { chunked: true, chunkCount: 0, payloadUnits: 1 })));
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "pdf1", "chunks", "0"), { workspaceId: "ws-alice", id: "other", kind: "pdfAnnotations", index: 0, text: "{}", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "pdf1", "chunks", "0"), { workspaceId: "ws-alice", id: "pdf1", kind: "pdfDocs", index: 0, text: "{}", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(f, "workspaces", "ws-alice", "pdfAnnotations", "pdf1", "chunks", "0"), { workspaceId: "ws-alice", id: "pdf1", kind: "pdfAnnotations", index: 0, text: 5, updatedAt: serverTimestamp() }));
  });
});

// Listen In TEXT results (Phase 8D.4): workspaces/{wid}/listenInMeetings,
// listenInTranscripts and listenInSummaries. Never audio.
//
// CREATOR-ONLY is the property under test. A meeting is stored under its
// workspace but belongs to the person who recorded it: another member of the
// same workspace must not be able to list, read, update or delete it merely
// by being a member. Sharing is a separate, later design.
//
// The field lists, enums and caps are src/lib/cloud/listenInCloudModel.js's,
// asserted equal there; here the emulator proves the authorization.
describe("Listen In text documents (8D.4)", { concurrency: false }, () => {
  const SID = "6f1c2a3b-0000-4000-8000-000000000001";
  // `undefined` in `extra` REMOVES a field (a chunked parent carries no json).
  const withoutUndefined = (data) => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const meeting = (wid, uid, extra = {}) =>
    withoutUndefined(envelope(wid, "listenInMeetings", SID, {
      sessionId: SID,
      createdBy: uid,
      title: "Site walk",
      language: "en",
      startedAt: 1700000000000,
      stoppedAt: null,
      completedAt: null,
      capturedMs: 90000,
      legStartedAt: null,
      state: "finished",
      stopReason: "user",
      limitWarnedAt: null,
      source: null,
      captureSource: "media-recorder",
      platform: null,
      noteId: null,
      projectId: null,
      folderId: null,
      revision: 1,
      segmentCount: 3,
      transcribedThroughSeq: 2,
      pendingCount: 0,
      failedSeqs: [],
      transcriptPageCount: 1,
      transcriptPageSize: 60,
      summaryRevision: 2,
      summaryStatus: "ready",
      summaryFinal: true,
      summaryCoveredThroughSeq: 2,
      ...extra,
    }));
  const page = (wid, uid, n, extra = {}) =>
    withoutUndefined(envelope(wid, "listenInTranscripts", `${SID}:${n}`, {
      sessionId: SID,
      createdBy: uid,
      page: n,
      revision: 1,
      json: JSON.stringify({ schemaVersion: 1, sessionId: SID, createdBy: uid, page: n, pageSize: 60, revision: 1, segments: [] }),
      ...extra,
    }));
  const summary = (wid, uid, extra = {}) =>
    withoutUndefined(envelope(wid, "listenInSummaries", SID, {
      sessionId: SID,
      createdBy: uid,
      revision: 1,
      json: JSON.stringify({ schemaVersion: 1, sessionId: SID, createdBy: uid, revision: 1 }),
      ...extra,
    }));
  const mine = (f, uid) => query(f, where("createdBy", "==", uid));

  beforeEach(async () => {
    await seedWorkspace("alice", "ws-alice");
    await seedWorkspace("bob", "ws-bob");
    await env.withSecurityRulesDisabled(async (ctx) => {
      const f = ctx.firestore();
      // mia is an ORDINARY MEMBER of alice's workspace, and not the creator.
      await setDoc(doc(f, "workspaces", "ws-alice", "members", "mia"), { uid: "mia", role: "member", addedAt: new Date(), addedBy: "alice" });
    });
  });

  test("32. unauthenticated: no read, no write, no delete on any of the three", async () => {
    await setDoc(doc(db("alice"), "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice"));
    const a = anon();
    await assertFails(getDoc(doc(a, "workspaces", "ws-alice", "listenInMeetings", SID)));
    await assertFails(getDocs(collection(a, "workspaces", "ws-alice", "listenInMeetings")));
    await assertFails(getDocs(mine(collection(a, "workspaces", "ws-alice", "listenInMeetings"), "alice")));
    await assertFails(setDoc(doc(a, "workspaces", "ws-alice", "listenInMeetings", "x"), meeting("ws-alice", "nobody", { sessionId: "x", id: "x" })));
    await assertFails(setDoc(doc(a, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0)));
    await assertFails(setDoc(doc(a, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice")));
    await assertFails(deleteDoc(doc(a, "workspaces", "ws-alice", "listenInMeetings", SID)));
  });

  test("33/34. a non-member and another workspace's owner can neither read, write nor delete; a spoofed workspace is refused", async () => {
    const alice = db("alice");
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice")));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0)));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice")));
    const bob = db("bob"); // owns ws-bob, is not a member of ws-alice
    await assertFails(getDoc(doc(bob, "workspaces", "ws-alice", "listenInMeetings", SID)));
    await assertFails(getDoc(doc(bob, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`)));
    await assertFails(getDoc(doc(bob, "workspaces", "ws-alice", "listenInSummaries", SID)));
    await assertFails(getDocs(mine(collection(bob, "workspaces", "ws-alice", "listenInMeetings"), "bob")));
    await assertFails(setDoc(doc(bob, "workspaces", "ws-alice", "listenInMeetings", "m2"), meeting("ws-alice", "bob", { sessionId: "m2", id: "m2" })));
    await assertFails(setDoc(doc(bob, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice", { revision: 2 })));
    await assertFails(deleteDoc(doc(bob, "workspaces", "ws-alice", "listenInMeetings", SID)));
    await assertFails(deleteDoc(doc(bob, "workspaces", "ws-alice", "listenInSummaries", SID)));
    // cross-workspace: the envelope names another workspace, or the path does
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", "m3"), meeting("ws-bob", "alice", { sessionId: "m3", id: "m3" })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-bob", "listenInMeetings", "m3"), meeting("ws-bob", "alice", { sessionId: "m3", id: "m3" })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-bob", "listenInTranscripts", `${SID}:0`), page("ws-bob", "alice", 0)));
  });

  test("35. the CREATOR may create, read, update, chunk, list and delete all three", async () => {
    const alice = db("alice");
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice")));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0)));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice")));
    // an update at a HIGHER revision, and one at the SAME revision (an idempotent replay)
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice", { revision: 2 })));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice", { revision: 2 })));
    // chunked page + chunk, as the sync engine writes them in ONE batch: the
    // chunk rule reads the parent's author with getAfter, so the parent and
    // its chunks may be created together.
    const batch = writeBatch(alice);
    batch.set(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`), page("ws-alice", "alice", 1, { json: undefined, chunked: true, chunkCount: 1, payloadUnits: 2 }));
    batch.set(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "0"), { workspaceId: "ws-alice", id: `${SID}:1`, kind: "listenInTranscripts", index: 0, text: "{}", updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    const chunkedSummary = writeBatch(alice);
    chunkedSummary.set(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice", { json: undefined, chunked: true, chunkCount: 1, payloadUnits: 2, revision: 2 }));
    chunkedSummary.set(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID, "chunks", "0"), { workspaceId: "ws-alice", id: SID, kind: "listenInSummaries", index: 0, text: "{}", updatedAt: serverTimestamp() });
    await assertSucceeds(chunkedSummary.commit());
    // reads, including the chunk text
    assert.equal((await assertSucceeds(getDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID)))).data().createdBy, "alice");
    assert.equal((await assertSucceeds(getDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "0")))).data().text, "{}");
    // A LIST must constrain on createdBy — that is what makes the rule
    // provable to Firestore. The same query without it is refused even for
    // the creator, whose documents are the only ones there.
    assert.equal((await assertSucceeds(getDocs(mine(collection(alice, "workspaces", "ws-alice", "listenInMeetings"), "alice")))).size, 1);
    assert.equal((await assertSucceeds(getDocs(query(collection(alice, "workspaces", "ws-alice", "listenInTranscripts"), where("sessionId", "==", SID), where("createdBy", "==", "alice"))))).size, 2);
    await assertFails(getDocs(collection(alice, "workspaces", "ws-alice", "listenInMeetings")));
    // and the creator deletes all of it, chunks included, in one batch
    const del = writeBatch(alice);
    del.delete(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "0"));
    del.delete(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`));
    del.delete(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID));
    del.delete(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID));
    await assertSucceeds(del.commit());
    // Everything really is gone. Confirmed with the rules bypassed, because a
    // creator-only READ cannot admit a document that no longer exists: there
    // is no `resource.data.createdBy` to match, so even its author is refused
    // rather than told "not found". That is a deliberate consequence of the
    // rule and not a bug — a missing meeting is discovered by listing, not by
    // fetching an id and reading the answer.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const f = ctx.firestore();
      for (const path of [
        ["workspaces", "ws-alice", "listenInMeetings", SID],
        ["workspaces", "ws-alice", "listenInSummaries", SID],
        ["workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`],
        ["workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "0"],
      ]) {
        assert.equal((await getDoc(doc(f, ...path))).exists(), false);
      }
    });
    await assertFails(getDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID)));
    assert.equal((await assertSucceeds(getDocs(mine(collection(alice, "workspaces", "ws-alice", "listenInMeetings"), "alice")))).size, 0);
    // A delete of something that is not there is a harmless no-op, so a
    // discard of a meeting that never reached the account cannot leave a
    // permanently failing outbox entry.
    await assertSucceeds(deleteDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID)));
  });

  test("35b. THE SAME CREATOR ON ANOTHER DEVICE reads and updates the meeting; an ORDINARY MEMBER of the workspace cannot", async () => {
    const alice = db("alice");
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice")));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0)));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice")));
    const chunked = writeBatch(alice);
    chunked.set(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`), page("ws-alice", "alice", 1, { json: undefined, chunked: true, chunkCount: 1, payloadUnits: 2 }));
    chunked.set(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "0"), { workspaceId: "ws-alice", id: `${SID}:1`, kind: "listenInTranscripts", index: 0, text: "{}", updatedAt: serverTimestamp() });
    await assertSucceeds(chunked.commit());

    // ANOTHER DEVICE of the same account: a separate client context, same uid.
    const aliceElsewhere = env.authenticatedContext("alice", { email_verified: true }).firestore();
    assert.equal((await assertSucceeds(getDoc(doc(aliceElsewhere, "workspaces", "ws-alice", "listenInMeetings", SID)))).data().sessionId, SID);
    assert.equal((await assertSucceeds(getDocs(mine(collection(aliceElsewhere, "workspaces", "ws-alice", "listenInMeetings"), "alice")))).size, 1);
    assert.equal((await assertSucceeds(getDocs(query(collection(aliceElsewhere, "workspaces", "ws-alice", "listenInTranscripts"), where("sessionId", "==", SID), where("createdBy", "==", "alice"))))).size, 2);
    assert.equal((await assertSucceeds(getDoc(doc(aliceElsewhere, "workspaces", "ws-alice", "listenInSummaries", SID)))).data().sessionId, SID);
    assert.equal((await assertSucceeds(getDoc(doc(aliceElsewhere, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "0")))).data().text, "{}");
    await assertSucceeds(setDoc(doc(aliceElsewhere, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice", { revision: 3 })));

    // AN ORDINARY MEMBER of the same workspace: nothing at all.
    const mia = db("mia");
    assert.equal((await getDoc(doc(db("alice"), "workspaces", "ws-alice", "members", "mia"))).exists(), true);
    await assertFails(getDoc(doc(mia, "workspaces", "ws-alice", "listenInMeetings", SID)));
    await assertFails(getDoc(doc(mia, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`)));
    await assertFails(getDoc(doc(mia, "workspaces", "ws-alice", "listenInSummaries", SID)));
    await assertFails(getDoc(doc(mia, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "0")));
    await assertFails(getDocs(collection(mia, "workspaces", "ws-alice", "listenInMeetings")));
    // ...not even by asking only for the creator's documents
    await assertFails(getDocs(mine(collection(mia, "workspaces", "ws-alice", "listenInMeetings"), "alice")));
    // Their own constrained query is allowed and simply returns nothing.
    assert.equal((await assertSucceeds(getDocs(mine(collection(mia, "workspaces", "ws-alice", "listenInMeetings"), "mia")))).size, 0);
    // No update, under either author, at any revision.
    await assertFails(setDoc(doc(mia, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice", { revision: 9 })));
    await assertFails(setDoc(doc(mia, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "mia", { revision: 9 })));
    await assertFails(setDoc(doc(mia, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0, { revision: 9 })));
    await assertFails(setDoc(doc(mia, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice", { revision: 9 })));
    await assertFails(setDoc(doc(mia, "workspaces", "ws-alice", "listenInMeetings", SID), { title: "renamed", updatedAt: serverTimestamp() }, { merge: true }));
    // No delete, of a document or of a chunk.
    await assertFails(deleteDoc(doc(mia, "workspaces", "ws-alice", "listenInMeetings", SID)));
    await assertFails(deleteDoc(doc(mia, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`)));
    await assertFails(deleteDoc(doc(mia, "workspaces", "ws-alice", "listenInSummaries", SID)));
    await assertFails(deleteDoc(doc(mia, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "0")));
    // ...and cannot write a chunk under the creator's parent either.
    await assertFails(setDoc(doc(mia, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:1`, "chunks", "1"), { workspaceId: "ws-alice", id: `${SID}:1`, kind: "listenInTranscripts", index: 1, text: "{}", updatedAt: serverTimestamp() }));
    // A member may of course record their OWN meeting in the same workspace.
    const MIA_SID = "6f1c2a3b-0000-4000-8000-0000000000m2".replace("m2", "02");
    await assertSucceeds(setDoc(doc(mia, "workspaces", "ws-alice", "listenInMeetings", MIA_SID), { ...meeting("ws-alice", "mia", { sessionId: MIA_SID }), id: MIA_SID }));
    assert.equal((await assertSucceeds(getDocs(mine(collection(mia, "workspaces", "ws-alice", "listenInMeetings"), "mia")))).size, 1);
    // ...which alice in turn cannot read.
    await assertFails(getDoc(doc(db("alice"), "workspaces", "ws-alice", "listenInMeetings", MIA_SID)));
    // The creator's own documents are untouched by any of it.
    assert.equal((await getDoc(doc(db("alice"), "workspaces", "ws-alice", "listenInMeetings", SID))).data().revision, 3);
  });

  test("36. authorship: createdBy must be the caller on create and can never change; a stale revision is refused; the field lists are closed", async () => {
    const alice = db("alice");
    const mia = db("mia");
    // a member may not author a meeting as somebody else, in either direction
    await assertFails(setDoc(doc(mia, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice")));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "mia")));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "mia", 0)));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "mia")));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice")));
    // ...nor re-author it afterwards, directly or by merge, even as its author
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "mia", { revision: 2 })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), { createdBy: "mia", updatedAt: serverTimestamp() }, { merge: true }));
    // the revision never goes backwards, on any of the three
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice", { revision: 3 })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice", { revision: 2 })));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0, { revision: 5 })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0, { revision: 4 })));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0, { revision: 5 })));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice", { revision: 7 })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice", { revision: 6 })));
    // a page or summary cannot be moved to another meeting
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 0, { revision: 6, sessionId: "other" })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice", { revision: 8, sessionId: "other" })));
    // closed field lists and typed values
    const badMeetings = [
      { audio: "x" },
      { mimeType: "audio/webm" },
      { revision: 0 },
      { revision: "3" },
      { state: "idle" },
      { state: "deleted" },
      { stopReason: "boom" },
      { title: "x".repeat(201) },
      { language: "x".repeat(17) },
      { startedAt: 0 },
      { capturedMs: -1 },
      { failedSeqs: "1,2" },
      { failedSeqs: Array.from({ length: 1025 }, (_, i) => i) },
      { summaryStatus: "generating" },
      { summaryFinal: "yes" },
      { transcriptPageSize: 0 },
      { schemaVersion: "1" },
      { updatedAt: new Date(2020, 1, 1) },
    ];
    for (const extra of badMeetings) {
      await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), meeting("ws-alice", "alice", { revision: 9, ...extra })));
    }
    const { createdBy: _c, ...noAuthor } = meeting("ws-alice", "alice", { revision: 9 });
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), noAuthor));
    const { failedSeqs: _f, ...noCoverage } = meeting("ws-alice", "alice", { revision: 9 });
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", SID), noCoverage));
    // pages and summaries: the author is required there too
    const { createdBy: _pc, ...pageNoAuthor } = page("ws-alice", "alice", 2, { revision: 9 });
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:2`), pageNoAuthor));
    const { createdBy: _sc, ...summaryNoAuthor } = summary("ws-alice", "alice", { revision: 9 });
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summaryNoAuthor));
    // pages: id must be sessionId:page, page an int, json a string, no strays
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`), page("ws-alice", "alice", 1, { revision: 9, id: `${SID}:0` })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:2`), page("ws-alice", "alice", 2, { page: -1 })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:2`), page("ws-alice", "alice", 2, { json: 42 })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:2`), page("ws-alice", "alice", 2, { audio: "x" })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:2`), page("ws-alice", "alice", 2, { chunked: true, chunkCount: 65, payloadUnits: 1, json: undefined })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID), summary("ws-alice", "alice", { revision: 9, segments: [] })));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", "other"), summary("ws-alice", "alice", { revision: 9, id: "other" })));
    // a chunk that names the wrong parent or kind is refused
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInTranscripts", `${SID}:0`, "chunks", "0"), { workspaceId: "ws-alice", id: `${SID}:1`, kind: "listenInTranscripts", index: 0, text: "{}", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInSummaries", SID, "chunks", "0"), { workspaceId: "ws-alice", id: SID, kind: "pdfAnnotations", index: 0, text: "{}", updatedAt: serverTimestamp() }));
    // the generic JSON-collection rule does not admit these names either
    await assertFails(setDoc(doc(alice, "workspaces", "ws-alice", "listenInMeetings", "m9"), envelope("ws-alice", "listenInMeetings", "m9", { json: "{}" })));
  });

  test("the existing entities are unaffected: a note, an annotation and an asset document behave as before", async () => {
    const alice = db("alice");
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "noteContent", "n1"), envelope("ws-alice", "noteContent", "n1", { html: "<p>x</p>" })));
    await assertSucceeds(setDoc(doc(alice, "workspaces", "ws-alice", "pdfAnnotations", "pdf1"), envelope("ws-alice", "pdfAnnotations", "pdf1", { json: "{\"items\":[]}" })));
    // an ordinary member still reads and writes ordinary workspace entities —
    // creator-only is a Listen In rule, not a new workspace-wide policy
    const mia = db("mia");
    assert.equal((await assertSucceeds(getDoc(doc(mia, "workspaces", "ws-alice", "noteContent", "n1")))).data().html, "<p>x</p>");
    await assertSucceeds(setDoc(doc(mia, "workspaces", "ws-alice", "noteContent", "n2"), envelope("ws-alice", "noteContent", "n2", { html: "<p>mine</p>" })));
    assert.equal((await assertSucceeds(getDocs(collection(mia, "workspaces", "ws-alice", "noteContent")))).size, 2);
    await assertFails(setDoc(doc(db("bob"), "workspaces", "ws-alice", "noteContent", "n3"), envelope("ws-alice", "noteContent", "n3", { html: "" })));
    await assertFails(deleteDoc(doc(alice, "workspaces", "ws-alice", "assets", "asset-1")));
  });
});
