// test/rules/assetRemoteReadLifecycle.test.js
//
// The READ-THROUGH LIFECYCLE end to end against the REAL paired emulators
// (Production Readiness Phase 7.5) — the mirror of assetUploadLifecycle:
//
//   a fresh device holding only the workspace's structured data →
//   the asset metadata INDEX (hydration) → one metadata document →
//   the Storage object's own metadata → its bytes
//
// performed exactly as src/lib/cloud/assetRemoteRead.js performs it, and
// proved to be a sequence the DEPLOYED rules permit for a member and refuse
// for everybody else.
//
// The two things only the real service can settle, and which a double cannot:
//
//   1. HYDRATION IS A COLLECTION QUERY. `firestore.rules` grants `read` on
//      `workspaces/{wid}/assets/{assetId}`, and hydration issues a LIST over
//      that collection. `read` covers `list` only if the rule genuinely
//      admits the query; if it did not, hydration would fail in production
//      while every in-memory test passed.
//   2. THE BYTES COME BACK WITHOUT A DOWNLOAD URL. `getBytes` is the
//      authenticated SDK read the adapter makes; no URL is minted here, and
//      the Storage rules refuse a LIST of the object prefix, so an asset can
//      only ever be reached by naming it.
//
// WHY THE READER ITSELF IS NOT IMPORTED HERE: the same reason as
// assetUploadLifecycle — `test/rules` runs as CommonJS under Node's own test
// runner, and the application source is ES modules with no build step in this
// context. The reader's ORCHESTRATION (index shortcut, validation, conflict
// refusal, in-flight dedupe, session isolation, cache write) is proved in Jest
// against the in-memory doubles (src/lib/cloud/assetRemoteRead.test.js). What
// is proved HERE is that the service and its rules accept the sequence.
//
// Run with `npm run test:rules`.

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { assertFails, assertSucceeds, initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const { collection, doc, getDoc, getDocs, setDoc, serverTimestamp } = require("firebase/firestore");
const { deleteObject, getBytes, getMetadata, listAll, ref, uploadBytes } = require("firebase/storage");

const PROJECT_ID = "notewise-rules-test";
const OWNER = "alice";
const MEMBER = "bob";
const OUTSIDER = "mallory";
const WID = "ws-read";
const OTHER_WID = "ws-elsewhere-read";
const ASSET_ID = "asset-read-1";
const TOMB_ID = "asset-read-2";

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6, 5]);
const CONTENT_TYPE = "image/png";
const ASSET_KIND = "editor-image";
const CREATED_AT = 1756000000000;

let env;

before(async () => {
  const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  const [stHost, stPort] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199").split(":");
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8"),
      host: fsHost,
      port: Number(fsPort),
    },
    storage: {
      rules: fs.readFileSync(path.join(__dirname, "..", "..", "storage.rules"), "utf8"),
      host: stHost,
      port: Number(stPort),
    },
  });
});

after(async () => {
  await env.cleanup();
});

/** Empties the bucket with the rules bypassed — see storage.rules.test.js. */
async function emptyBucket() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const storage = ctx.storage();
    async function remove(prefix) {
      const listing = await listAll(prefix);
      await Promise.all(listing.items.map((item) => deleteObject(item)));
      await Promise.all(listing.prefixes.map((child) => remove(child)));
    }
    await remove(ref(storage, ""));
  });
}

async function seedWorkspace(ownerUid, wid, { members = [] } = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    const now = new Date();
    await setDoc(doc(f, "workspaces", wid), {
      id: wid,
      name: "Seeded",
      ownerUid,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(f, "workspaces", wid, "members", ownerUid), {
      uid: ownerUid,
      role: "owner",
      addedAt: now,
      addedBy: ownerUid,
    });
    for (const uid of members) {
      await setDoc(doc(f, "workspaces", wid, "members", uid), {
        uid,
        role: "member",
        addedAt: now,
        addedBy: ownerUid,
      });
    }
  });
}

/** The metadata document fields (buildAssetDocument, stored state). */
function assetDocument(wid = WID, assetId = ASSET_ID, overrides = {}) {
  return {
    workspaceId: wid,
    id: assetId,
    kind: "assets",
    schemaVersion: 1,
    assetKind: ASSET_KIND,
    name: "site-photo.png",
    mimeType: CONTENT_TYPE,
    size: BYTES.byteLength,
    createdAt: CREATED_AT,
    metadata: {},
    state: "stored",
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

/**
 * Place one asset the way a FINISHED UPLOAD FROM ANOTHER DEVICE leaves it:
 * the object, then the document. Rules-bypassed, because the point of this
 * suite is the READ.
 */
async function seedStoredAsset({ wid = WID, assetId = ASSET_ID, tombstoned = false } = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), `workspaces/${wid}/assets/${assetId}`), BYTES, {
      contentType: CONTENT_TYPE,
      customMetadata: { assetId, workspaceId: wid, assetKind: ASSET_KIND },
    });
    await setDoc(
      doc(ctx.firestore(), "workspaces", wid, "assets", assetId),
      tombstoned
        ? assetDocument(wid, assetId, { state: "tombstoned", tombstonedAt: new Date() })
        : assetDocument(wid, assetId)
    );
  });
}

const context = (uid) => env.authenticatedContext(uid, { email_verified: true });

beforeEach(async () => {
  await env.clearFirestore();
  await emptyBucket();
  await seedWorkspace(OWNER, WID, { members: [MEMBER] });
  await seedWorkspace(OWNER, OTHER_WID);
});

/**
 * ONE pass of the reader's cloud lifecycle for a signed-in user, written the
 * way the reader writes it: the document, then the object's own metadata,
 * then the bytes. Returns the facts a device would cache locally.
 */
async function runReadPass(uid, { wid = WID, assetId = ASSET_ID } = {}) {
  const ctx = context(uid);
  const objectRef = ref(ctx.storage(), `workspaces/${wid}/assets/${assetId}`);

  // C — the workspace's own record of the asset.
  const snapshot = await getDoc(doc(ctx.firestore(), "workspaces", wid, "assets", assetId));
  assert.equal(snapshot.exists(), true, "the metadata document should be readable");
  const fields = snapshot.data();

  // D — what is actually standing on the path, compared with the record.
  const head = await getMetadata(objectRef);
  assert.equal(head.customMetadata.workspaceId, wid);
  assert.equal(head.customMetadata.assetId, assetId);
  assert.equal(head.customMetadata.assetKind, fields.assetKind);
  assert.equal(head.contentType, fields.mimeType);
  assert.equal(Number(head.size), Number(fields.size));

  // E — the bytes, through the authenticated SDK. No URL is minted.
  const buffer = await getBytes(objectRef);
  const bytes = new Uint8Array(buffer);
  assert.equal(bytes.byteLength, fields.size, "the bytes must be the length the record describes");

  return { fields, head, bytes };
}

describe("a fresh device reads an asset it does not hold", () => {
  test("the owner completes the whole pass and gets the exact bytes", async () => {
    await seedStoredAsset();
    const { fields, bytes } = await runReadPass(OWNER);
    assert.equal(fields.assetKind, ASSET_KIND);
    assert.deepEqual(Array.from(bytes), Array.from(BYTES));
  });

  test("an ordinary member completes the same pass — reading is not an owner privilege", async () => {
    await seedStoredAsset();
    const { bytes } = await runReadPass(MEMBER);
    assert.deepEqual(Array.from(bytes), Array.from(BYTES));
  });

  test("the read changes NOTHING in the cloud", async () => {
    await seedStoredAsset();
    // `withSecurityRulesDisabled` resolves to undefined, so what it observes
    // is captured rather than returned.
    let before = null;
    await env.withSecurityRulesDisabled(async (ctx) => {
      before = (await getDoc(doc(ctx.firestore(), "workspaces", WID, "assets", ASSET_ID))).data();
    });
    assert.ok(before, "the fixture should be readable before the pass");

    await runReadPass(MEMBER);

    let after = null;
    let head = null;
    await env.withSecurityRulesDisabled(async (ctx) => {
      after = (await getDoc(doc(ctx.firestore(), "workspaces", WID, "assets", ASSET_ID))).data();
      head = await getMetadata(ref(ctx.storage(), `workspaces/${WID}/assets/${ASSET_ID}`));
    });
    assert.deepEqual(after, before);
    // The object is still exactly one object, of exactly the same size.
    assert.equal(Number(head.size), BYTES.byteLength);
  });

  test("a repeated pass is idempotent — a device that re-reads changes nothing", async () => {
    await seedStoredAsset();
    const first = await runReadPass(MEMBER);
    const second = await runReadPass(MEMBER);
    assert.deepEqual(Array.from(second.bytes), Array.from(first.bytes));
    assert.equal(Number(second.head.size), Number(first.head.size));
  });

  test("a TOMBSTONED document is readable, so the reader can see the state it must respect", async () => {
    await seedStoredAsset({ assetId: TOMB_ID, tombstoned: true });
    const ctx = context(MEMBER);
    const snapshot = await assertSucceeds(
      getDoc(doc(ctx.firestore(), "workspaces", WID, "assets", TOMB_ID))
    );
    assert.equal(snapshot.data().state, "tombstoned");
  });

  test("the OBJECT survives its document's tombstone — why a cached 'stored' may not license a download", async () => {
    // The hazard the freshness rule closes, established against the real
    // service rather than assumed: another device tombstones the record, the
    // bytes remain fetchable for the whole grace window, and a device holding
    // a hydrated `stored` index entry would happily download them. Only a
    // CURRENT document read distinguishes the two.
    await seedStoredAsset();
    const ctx = context(MEMBER);
    const documentRef = doc(ctx.firestore(), "workspaces", WID, "assets", ASSET_ID);
    const objectRef = ref(ctx.storage(), `workspaces/${WID}/assets/${ASSET_ID}`);

    await assertSucceeds(
      setDoc(documentRef, assetDocument(WID, ASSET_ID, {
        state: "tombstoned",
        tombstonedAt: serverTimestamp(),
      }))
    );
    assert.equal((await getDoc(documentRef)).data().state, "tombstoned");

    // Still there, still readable — the object's lifecycle is the collector's,
    // not the tombstone's.
    const head = await assertSucceeds(getMetadata(objectRef));
    assert.equal(Number(head.size), BYTES.byteLength);
    const bytes = new Uint8Array(await getBytes(objectRef));
    assert.equal(bytes.byteLength, BYTES.byteLength);
  });
});

describe("hydration reads the metadata index, and only metadata", () => {
  test("a member may LIST the workspace's asset collection", async () => {
    await seedStoredAsset();
    await seedStoredAsset({ assetId: TOMB_ID, tombstoned: true });
    const ctx = context(MEMBER);
    const snapshot = await assertSucceeds(
      getDocs(collection(ctx.firestore(), "workspaces", WID, "assets"))
    );
    assert.deepEqual(
      snapshot.docs.map((d) => d.id).sort(),
      [ASSET_ID, TOMB_ID].sort(),
      "hydration must see every asset document of its own workspace"
    );
  });

  test("hydration cannot reach another workspace's index", async () => {
    await seedStoredAsset({ wid: OTHER_WID });
    const ctx = context(MEMBER);
    await assertFails(getDocs(collection(ctx.firestore(), "workspaces", OTHER_WID, "assets")));
  });

  test("an outsider may not list the index at all", async () => {
    await seedStoredAsset();
    const ctx = context(OUTSIDER);
    await assertFails(getDocs(collection(ctx.firestore(), "workspaces", WID, "assets")));
  });

  test("the Storage object prefix may NEVER be listed, by anyone", async () => {
    await seedStoredAsset();
    // Bytes are reachable only by naming an asset. A listable prefix would
    // turn one leaked membership into an enumeration of every file.
    await assertFails(listAll(ref(context(MEMBER).storage(), `workspaces/${WID}/assets`)));
    await assertFails(listAll(ref(context(OWNER).storage(), `workspaces/${WID}/assets`)));
  });
});

describe("nobody outside the workspace can read anything", () => {
  test("an outsider is refused the document, the object head and the bytes", async () => {
    await seedStoredAsset();
    const ctx = context(OUTSIDER);
    const objectRef = ref(ctx.storage(), `workspaces/${WID}/assets/${ASSET_ID}`);
    await assertFails(getDoc(doc(ctx.firestore(), "workspaces", WID, "assets", ASSET_ID)));
    await assertFails(getMetadata(objectRef));
    await assertFails(getBytes(objectRef));
  });

  test("a member of one workspace is refused another workspace's asset", async () => {
    await seedStoredAsset({ wid: OTHER_WID });
    const ctx = context(MEMBER);
    const objectRef = ref(ctx.storage(), `workspaces/${OTHER_WID}/assets/${ASSET_ID}`);
    await assertFails(getDoc(doc(ctx.firestore(), "workspaces", OTHER_WID, "assets", ASSET_ID)));
    await assertFails(getMetadata(objectRef));
    await assertFails(getBytes(objectRef));
  });

  test("a signed-out caller gets nothing", async () => {
    await seedStoredAsset();
    const ctx = env.unauthenticatedContext();
    await assertFails(getDoc(doc(ctx.firestore(), "workspaces", WID, "assets", ASSET_ID)));
    await assertFails(getBytes(ref(ctx.storage(), `workspaces/${WID}/assets/${ASSET_ID}`)));
  });
});

describe("a read is a read", () => {
  test("reading does not let a member rewrite the object it just fetched", async () => {
    await seedStoredAsset();
    await runReadPass(MEMBER);
    const ctx = context(MEMBER);
    // The object is create-only: having read it grants nothing further.
    await assertFails(
      uploadBytes(ref(ctx.storage(), `workspaces/${WID}/assets/${ASSET_ID}`), BYTES, {
        contentType: CONTENT_TYPE,
        customMetadata: { assetId: ASSET_ID, workspaceId: WID, assetKind: ASSET_KIND },
      })
    );
  });

  test("reading does not let an ordinary member delete the object or its document", async () => {
    await seedStoredAsset();
    await runReadPass(MEMBER);
    const ctx = context(MEMBER);
    await assertFails(deleteObject(ref(ctx.storage(), `workspaces/${WID}/assets/${ASSET_ID}`)));
  });
});
