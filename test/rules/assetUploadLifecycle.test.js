// test/rules/assetUploadLifecycle.test.js
//
// The UPLOAD LIFECYCLE end to end against the REAL paired emulators
// (Production Readiness Phase 7.4):
//
//   a queued asset → the Storage object → the Firestore metadata document →
//   the facts this browser then records locally as "stored"
//
// performed exactly as src/lib/cloud/assetUploadSync.js performs it — head
// the object, upload only when absent, read the metadata document, create it
// only when absent — and proved to be a sequence the DEPLOYED rules permit
// for a member and refuse for everybody else. It also replays the sequence,
// which is what a lost acknowledgement makes the engine do, and shows the
// replay changes nothing.
//
// WHY THE ENGINE ITSELF IS NOT IMPORTED HERE. `test/rules` runs under Node's
// own test runner as CommonJS (the rules-testing library and the Firebase SDK
// need the real Node realm's `fetch` and web streams, which is why Jest is not
// used); the application source is ES modules with no build step in this
// context, so `require`ing it is not possible. The engine's ORCHESTRATION —
// ordering, concurrency, retry, conflict handling, the atomic local
// settlement — is therefore proved in Jest against the in-memory doubles
// (src/lib/cloud/assetUploadSync.test.js), and what is proved HERE is the one
// thing a double cannot prove: that the service and its rules accept the
// sequence. The document shape below is duplicated from
// src/lib/cloud/assetCloudModel.js for the same reason the MIME list is
// duplicated in the other rules suites, and that module's Jest tests pin it.
//
// Run with `npm run test:rules`.

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { assertFails, assertSucceeds, initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, serverTimestamp } = require("firebase/firestore");
const { deleteObject, getBytes, getMetadata, listAll, ref, uploadBytes } = require("firebase/storage");

const PROJECT_ID = "notewise-rules-test";
const OWNER = "alice";
const MEMBER = "bob";
const OUTSIDER = "mallory";
const WID = "ws-upload";
const OTHER_WID = "ws-elsewhere";
const ASSET_ID = "asset-upload-1";
const ASSET_PATH = `workspaces/${WID}/assets/${ASSET_ID}`;

// The bytes of one small PNG-shaped asset. Content is irrelevant to the rules;
// the SIZE is not — it is part of the identity the engine compares.
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
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

beforeEach(async () => {
  await env.clearFirestore();
  await emptyBucket();
  await seedWorkspace(OWNER, WID, { members: [MEMBER] });
  await seedWorkspace(OWNER, OTHER_WID);
});

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

const context = (uid) => env.authenticatedContext(uid, { email_verified: true });

/** The Storage custom metadata the create rule requires (assetStorageMetadata). */
function storageMetadata(wid = WID, assetId = ASSET_ID, assetKind = ASSET_KIND) {
  return { assetId, workspaceId: wid, assetKind };
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
 * ONE pass of the engine's cloud lifecycle for a member, returning what it
 * would then record locally as `stored`. Deliberately written as the engine
 * writes it: head first, upload only when absent, read the document, create
 * only when absent.
 */
async function runUploadPass(uid, { wid = WID, assetId = ASSET_ID } = {}) {
  const ctx = context(uid);
  const objectRef = ref(ctx.storage(), `workspaces/${wid}/assets/${assetId}`);
  const documentRef = doc(ctx.firestore(), "workspaces", wid, "assets", assetId);

  // D — what is on the path.
  let head = null;
  try {
    head = await getMetadata(objectRef);
  } catch (error) {
    if (error.code !== "storage/object-not-found") throw error;
  }

  // E — the bytes, only when there is no object.
  let uploaded = false;
  if (!head) {
    await uploadBytes(objectRef, BYTES, {
      contentType: CONTENT_TYPE,
      customMetadata: storageMetadata(wid, assetId),
    });
    head = await getMetadata(objectRef);
    uploaded = true;
  }

  // F — the metadata document, only when there is none.
  const existing = await getDoc(documentRef);
  let wroteDocument = false;
  if (!existing.exists()) {
    await setDoc(documentRef, assetDocument(wid, assetId));
    wroteDocument = true;
  }
  const settled = await getDoc(documentRef);

  // G — the facts the remote index then records.
  return {
    uploaded,
    wroteDocument,
    head,
    remoteIndexEntry: {
      workspaceId: wid,
      assetId,
      kind: settled.data().assetKind,
      name: settled.data().name,
      mimeType: settled.data().mimeType,
      size: settled.data().size,
      state: "stored",
    },
  };
}

describe("a member's upload lifecycle", () => {
  test("queue item → Storage object → Firestore metadata → the facts settled locally", async () => {
    const result = await runUploadPass(MEMBER);

    assert.equal(result.uploaded, true);
    assert.equal(result.wroteDocument, true);
    assert.equal(result.head.contentType, CONTENT_TYPE);
    assert.equal(Number(result.head.size), BYTES.byteLength);
    assert.deepEqual(result.head.customMetadata, storageMetadata());

    // The object and the document describe the SAME asset — the identity the
    // engine compares on every later attempt.
    assert.deepEqual(result.remoteIndexEntry, {
      workspaceId: WID,
      assetId: ASSET_ID,
      kind: ASSET_KIND,
      name: "site-photo.png",
      mimeType: CONTENT_TYPE,
      size: BYTES.byteLength,
      state: "stored",
    });

    // The bytes are readable back through the authenticated SDK.
    const read = await getBytes(ref(context(MEMBER).storage(), ASSET_PATH));
    assert.deepEqual(new Uint8Array(read), BYTES);
  });

  test("the workspace OWNER can run exactly the same sequence", async () => {
    const result = await runUploadPass(OWNER);
    assert.equal(result.uploaded, true);
    assert.equal(result.wroteDocument, true);
  });
});

describe("replaying the lifecycle — a lost acknowledgement", () => {
  test("a second pass uploads nothing, writes nothing, and settles the same facts", async () => {
    const first = await runUploadPass(MEMBER);
    const second = await runUploadPass(MEMBER);

    assert.equal(second.uploaded, false, "the object must not be uploaded twice");
    assert.equal(second.wroteDocument, false, "a matching document must not be rewritten");
    assert.deepEqual(second.remoteIndexEntry, first.remoteIndexEntry);
    assert.equal(second.head.generation, first.head.generation, "the object was replaced");
  });

  test("an interrupted pass that stored the object but not the document is completed, not restarted", async () => {
    // The first attempt died between Storage and Firestore.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), ASSET_PATH), BYTES, {
        contentType: CONTENT_TYPE,
        customMetadata: storageMetadata(),
      });
    });

    const result = await runUploadPass(MEMBER);

    assert.equal(result.uploaded, false, "the existing object must be left alone");
    assert.equal(result.wroteDocument, true, "the missing document must be created");
    assert.equal(result.remoteIndexEntry.size, BYTES.byteLength);
  });

  test("the object is immutable: an overwrite is refused even by the member who wrote it", async () => {
    await runUploadPass(MEMBER);
    await assertFails(
      uploadBytes(ref(context(MEMBER).storage(), ASSET_PATH), new Uint8Array([9, 9, 9]), {
        contentType: CONTENT_TYPE,
        customMetadata: storageMetadata(),
      })
    );
    const read = await getBytes(ref(context(MEMBER).storage(), ASSET_PATH));
    assert.deepEqual(new Uint8Array(read), BYTES, "the original bytes must survive a refused overwrite");
  });

  test("a tombstoned asset that is referenced again is RESTORED, and nothing else changes", async () => {
    await runUploadPass(MEMBER);
    const documentRef = doc(context(MEMBER).firestore(), "workspaces", WID, "assets", ASSET_ID);

    await assertSucceeds(
      setDoc(documentRef, assetDocument(WID, ASSET_ID, { state: "tombstoned", tombstonedAt: serverTimestamp() }))
    );
    // The engine's one permitted rewrite: back to `stored`, tombstone dropped.
    await assertSucceeds(setDoc(documentRef, assetDocument()));

    const settled = await getDoc(documentRef);
    assert.equal(settled.data().state, "stored");
    assert.equal(settled.data().tombstonedAt, undefined);
    assert.equal(settled.data().size, BYTES.byteLength);
    assert.equal(settled.data().assetKind, ASSET_KIND);
  });

  test("the description is immutable: a rewrite that changes size or type is refused", async () => {
    await runUploadPass(MEMBER);
    const documentRef = doc(context(MEMBER).firestore(), "workspaces", WID, "assets", ASSET_ID);
    await assertFails(setDoc(documentRef, assetDocument(WID, ASSET_ID, { size: 999 })));
    await assertFails(setDoc(documentRef, assetDocument(WID, ASSET_ID, { mimeType: "application/pdf" })));
    await assertFails(setDoc(documentRef, assetDocument(WID, ASSET_ID, { assetKind: "note-file" })));
  });
});

describe("two clients racing the immutable create", () => {
  test("the loser's create is refused, and re-reading the path shows the winner's matching object", async () => {
    // Both clients head the path and find it empty.
    const winner = context(OWNER);
    const loser = context(MEMBER);
    const winnerRef = ref(winner.storage(), ASSET_PATH);
    const loserRef = ref(loser.storage(), ASSET_PATH);

    for (const objectRef of [winnerRef, loserRef]) {
      await assert.rejects(getMetadata(objectRef), (error) => error.code === "storage/object-not-found");
    }

    // The winner creates.
    await assertSucceeds(
      uploadBytes(winnerRef, BYTES, { contentType: CONTENT_TYPE, customMetadata: storageMetadata() })
    );

    // The loser's create is refused — and the refusal is PERMISSION-SHAPED,
    // indistinguishable by code from "you may not write here". This is the
    // whole reason the engine re-reads instead of trusting the code.
    const refusal = await uploadBytes(loserRef, BYTES, {
      contentType: CONTENT_TYPE,
      customMetadata: storageMetadata(),
    }).then(
      () => null,
      (error) => error
    );
    assert.ok(refusal, "the second create must be refused");
    assert.equal(refusal.code, "storage/unauthorized");

    // Re-reading the path tells the loser what actually happened: the object
    // is there, and it IS this asset.
    const head = await getMetadata(loserRef);
    assert.equal(head.contentType, CONTENT_TYPE);
    assert.equal(Number(head.size), BYTES.byteLength);
    assert.deepEqual(head.customMetadata, storageMetadata());

    // So the loser continues the lifecycle and describes the same asset.
    await assertSucceeds(setDoc(doc(loser.firestore(), "workspaces", WID, "assets", ASSET_ID), assetDocument()));
    const settled = await getDoc(doc(loser.firestore(), "workspaces", WID, "assets", ASSET_ID));
    assert.equal(settled.data().size, BYTES.byteLength);

    // The winner's bytes stand, unchanged.
    const read = await getBytes(winnerRef);
    assert.deepEqual(new Uint8Array(read), BYTES);
  });

  test("a genuine permission failure wears the same code but leaves NO object behind", async () => {
    // The distinguishing fact is the path, not the code: after a non-member's
    // refusal there is nothing on it, so the engine keeps the refusal.
    const stranger = context(OUTSIDER);
    const refusal = await uploadBytes(ref(stranger.storage(), ASSET_PATH), BYTES, {
      contentType: CONTENT_TYPE,
      customMetadata: storageMetadata(),
    }).then(
      () => null,
      (error) => error
    );
    assert.ok(refusal);
    assert.equal(refusal.code, "storage/unauthorized");

    await assert.rejects(
      getMetadata(ref(context(MEMBER).storage(), ASSET_PATH)),
      (error) => error.code === "storage/object-not-found"
    );
  });

  test("the losing client's second write is refused too — the object is never rewritten", async () => {
    await runUploadPass(OWNER);
    const loserRef = ref(context(MEMBER).storage(), ASSET_PATH);
    await assertFails(
      uploadBytes(loserRef, new Uint8Array([7, 7, 7, 7]), {
        contentType: CONTENT_TYPE,
        customMetadata: storageMetadata(),
      })
    );
    const head = await getMetadata(loserRef);
    assert.equal(Number(head.size), BYTES.byteLength);
    const read = await getBytes(loserRef);
    assert.deepEqual(new Uint8Array(read), BYTES);
  });
});

describe("the lifecycle is refused outside the membership that justifies it", () => {
  test("a non-member cannot head, upload or describe the asset", async () => {
    const ctx = context(OUTSIDER);
    await assertFails(getMetadata(ref(ctx.storage(), ASSET_PATH)));
    await assertFails(
      uploadBytes(ref(ctx.storage(), ASSET_PATH), BYTES, {
        contentType: CONTENT_TYPE,
        customMetadata: storageMetadata(),
      })
    );
    await assertFails(setDoc(doc(ctx.firestore(), "workspaces", WID, "assets", ASSET_ID), assetDocument()));
  });

  test("a member of ANOTHER workspace cannot run the sequence here", async () => {
    await seedWorkspace(OUTSIDER, "ws-mallory");
    const ctx = context(OUTSIDER);
    await assertFails(
      uploadBytes(ref(ctx.storage(), ASSET_PATH), BYTES, {
        contentType: CONTENT_TYPE,
        customMetadata: storageMetadata(),
      })
    );
  });

  test("an unauthenticated caller cannot run any of it", async () => {
    const anon = env.unauthenticatedContext();
    await assertFails(getMetadata(ref(anon.storage(), ASSET_PATH)));
    await assertFails(setDoc(doc(anon.firestore(), "workspaces", WID, "assets", ASSET_ID), assetDocument()));
  });

  test("an object whose identity metadata names another workspace is refused", async () => {
    await assertFails(
      uploadBytes(ref(context(MEMBER).storage(), ASSET_PATH), BYTES, {
        contentType: CONTENT_TYPE,
        customMetadata: storageMetadata(OTHER_WID),
      })
    );
  });

  test("a metadata document naming another workspace is refused", async () => {
    await assertFails(
      setDoc(
        doc(context(MEMBER).firestore(), "workspaces", WID, "assets", ASSET_ID),
        assetDocument(WID, ASSET_ID, { workspaceId: OTHER_WID })
      )
    );
  });
});
