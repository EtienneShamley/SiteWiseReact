// test/rules/storage.rules.test.js
//
// Firebase Storage Security Rules, verified against the REAL `storage.rules`
// in the Storage emulator (@firebase/rules-unit-testing), with the REAL
// Firestore emulator beside it — the rules decide membership and ownership
// by reading Firestore cross-service (`firestore.exists` / `firestore.get`),
// and this suite is the proof that the paired emulators honour that. Run
// with `npm run test:rules` (= `firebase emulators:exec --only
// firestore,storage "node --test test/rules/…"`); CI runs it in the Validate
// stage with no Firebase project or credential (the emulators are local).
// The two rules files run SEQUENTIALLY (`--test-concurrency=1`): both suites
// seed and clear the same Firestore emulator, and in parallel they would wipe
// each other's workspaces mid-test.
//
// Deliberately Node's own test runner, not Jest, for the same reason as
// test/rules/firestore.rules.test.js: the rules-testing library and the
// Firebase SDK need the real Node realm's `fetch` and web streams.
//
// PHASE 7.3 CONTRACT (the deny-all of 7.1 re-targeted, not deleted — the
// unauthenticated and non-member cases stay refusals for good):
//   unauthenticated: no read, create or delete · member: read + create in
//   the own workspace, nothing in another's · non-member: nothing ·
//   objects: create-only (no overwrite), path segments validated, custom
//   metadata must match the path, kind allow-listed, 0 bytes and > 50 MB
//   refused, the canonical MIME list accepted and anything else refused ·
//   delete: the workspace OWNER only — an ordinary member, and the owner of
//   another workspace, cannot · listing not granted · other paths closed.
//
// `getBytes` is used for the read attempt because `getBlob` — the read path
// the application itself uses — is browser-only; both go through the same
// rules check.

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { assertFails, assertSucceeds, initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const { doc, setDoc } = require("firebase/firestore");
const { deleteObject, getBytes, getMetadata, listAll, ref, uploadBytes } = require("firebase/storage");

const PROJECT_ID = "notewise-rules-test";
const WID = "ws-alice";
const OTHER_WID = "ws-bob";
const ASSET_ID = "asset-1";
const ASSET_PATH = `workspaces/${WID}/assets/${ASSET_ID}`;
const BYTES = new Uint8Array([1, 2, 3, 4]);
const MAX_BYTES = 50 * 1024 * 1024;

// The canonical cloud MIME policy (src/lib/cloud/assetCloudModel.js). The
// Jest suite there asserts the rules file enumerates exactly this list; this
// suite proves each entry is ACCEPTED by the emulator and a sample of
// everything else refused.
const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/csv",
];
const DISALLOWED_MIME_TYPES = [
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/javascript",
  "application/octet-stream",
  "application/zip",
  "image/gif",
  "",
];

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

/**
 * Empties the bucket with the rules bypassed. `env.clearStorage()` is NOT
 * used: against firebase-tools 15 / rules-unit-testing 5 it returns without
 * removing anything (verified — an object seeded before the call is still
 * readable after it), which would leave every "create on this path" case
 * facing a leftover object and pass or fail for the wrong reason.
 */
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
});

const authed = (uid) => env.authenticatedContext(uid, { email_verified: true }).storage();
const anon = () => env.unauthenticatedContext().storage();

/** The custom metadata the create rule requires, matching the path by default. */
const meta = (overrides = {}) => ({
  customMetadata: { assetId: ASSET_ID, workspaceId: WID, assetKind: "editor-image", ...overrides },
});

/** Upload options: a content type plus (by default) matching custom metadata. */
const upload = (contentType = "image/jpeg", overrides = {}) => ({ contentType, ...meta(overrides) });

/**
 * Seeds a workspace owned by `ownerUid` in FIRESTORE with the rules bypassed
 * (the exact documents the bootstrap transaction writes), plus any extra
 * ordinary members — the membership the Storage rules read cross-service.
 */
async function seedWorkspace(ownerUid, wid, { members = [] } = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    const now = new Date();
    await setDoc(doc(f, "workspaces", wid), { id: wid, name: "Seeded", ownerUid, schemaVersion: 1, createdAt: now, updatedAt: now });
    await setDoc(doc(f, "workspaces", wid, "members", ownerUid), { uid: ownerUid, role: "owner", addedAt: now, addedBy: ownerUid });
    for (const uid of members) {
      await setDoc(doc(f, "workspaces", wid, "members", uid), { uid, role: "member", addedAt: now, addedBy: ownerUid });
    }
  });
}

/** Places an object with the rules bypassed, so reads and deletes face a real object. */
async function seedObject(objectPath = ASSET_PATH, options = upload()) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), objectPath), BYTES, options);
  });
}

describe("storage.rules — the file", { concurrency: false }, () => {
  test("it is a version-2 Storage rules file that decides membership and ownership in Firestore", () => {
    const rules = fs.readFileSync(path.join(__dirname, "..", "..", "storage.rules"), "utf8");
    const code = rules.replace(/\/\/.*$/gm, "");
    assert.match(code, /rules_version = '2'/);
    assert.match(code, /service firebase\.storage/);
    assert.match(code, /match \/workspaces\/\{workspaceId\}\/assets\/\{assetId\}/);
    assert.match(code, /firestore\.exists\(memberPath\(wid, request\.auth\.uid\)\)/);
    assert.match(code, /firestore\.exists\(workspacePath\(wid\)\)/);
    assert.match(code, /firestore\.get\(workspacePath\(wid\)\)\.data\.ownerUid == request\.auth\.uid/);
    assert.match(code, /allow update: if false;/);
    assert.match(code, /allow list: if false;/);
    assert.match(code, /allow delete: if isOwner\(workspaceId\)/);
    assert.match(code, /match \/\{allPaths=\*\*\} \{\s*allow read, write: if false;\s*\}/);
    // No rule grants anything to a mere member of nothing — `if true` never appears.
    assert.doesNotMatch(code, /if\s+true/);
  });
});

describe("storage.rules — cross-service membership (the firestore.exists proof)", { concurrency: false }, () => {
  test("with NO membership document in Firestore, a signed-in user gets nothing — even on a path that names them", async () => {
    await seedObject();
    const storage = authed("alice");
    await assertFails(getBytes(ref(storage, ASSET_PATH)));
    await assertFails(uploadBytes(ref(storage, `workspaces/${WID}/assets/asset-2`), BYTES, upload("image/jpeg", { assetId: "asset-2" })));
    await assertFails(deleteObject(ref(storage, ASSET_PATH)));
  });

  test("the SAME user is admitted the moment the Firestore membership exists — the rule reads Firestore", async () => {
    await seedObject();
    await seedWorkspace("alice", WID);
    const storage = authed("alice");
    await assertSucceeds(getBytes(ref(storage, ASSET_PATH)));
    await assertSucceeds(uploadBytes(ref(storage, `workspaces/${WID}/assets/asset-2`), BYTES, upload("image/jpeg", { assetId: "asset-2" })));
  });

  test("ownership too: the owner recorded on workspaces/{wid} may delete, and nobody else", async () => {
    await seedWorkspace("alice", WID, { members: ["bob"] });
    await seedObject();
    await assertFails(deleteObject(ref(authed("bob"), ASSET_PATH)));
    await assertSucceeds(deleteObject(ref(authed("alice"), ASSET_PATH)));
    await assert.rejects(getMetadata(ref(authed("alice"), ASSET_PATH)), { code: "storage/object-not-found" }); // gone
  });
});

describe("storage.rules — unauthenticated", { concurrency: false }, () => {
  test("no read, list, create or delete", async () => {
    await seedWorkspace("alice", WID);
    await seedObject();
    const storage = anon();
    await assertFails(getBytes(ref(storage, ASSET_PATH)));
    await assertFails(getMetadata(ref(storage, ASSET_PATH)));
    await assertFails(listAll(ref(storage, `workspaces/${WID}/assets`)));
    await assertFails(uploadBytes(ref(storage, `workspaces/${WID}/assets/asset-2`), BYTES, upload("image/jpeg", { assetId: "asset-2" })));
    await assertFails(deleteObject(ref(storage, ASSET_PATH)));
  });
});

describe("storage.rules — workspace member", { concurrency: false }, () => {
  beforeEach(async () => {
    await seedWorkspace("alice", WID, { members: ["bob"] });
    await seedWorkspace("carol", OTHER_WID);
  });

  test("reads the own workspace's object (bytes and metadata)", async () => {
    await seedObject();
    for (const uid of ["alice", "bob"]) {
      const storage = authed(uid);
      const bytes = await assertSucceeds(getBytes(ref(storage, ASSET_PATH)));
      assert.deepEqual(new Uint8Array(bytes), BYTES);
      const metadata = await assertSucceeds(getMetadata(ref(storage, ASSET_PATH)));
      assert.equal(metadata.contentType, "image/jpeg");
    }
  });

  test("creates an object in the own workspace — an ordinary member as much as the owner", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await assert.rejects(getMetadata(ref(ctx.storage(), ASSET_PATH)), { code: "storage/object-not-found" }); // the bucket is empty
    });
    await assertSucceeds(uploadBytes(ref(authed("bob"), ASSET_PATH), BYTES, upload()));
    await assertSucceeds(
      uploadBytes(ref(authed("alice"), `workspaces/${WID}/assets/asset-2`), BYTES, upload("application/pdf", { assetId: "asset-2", assetKind: "pdf-source" }))
    );
    const metadata = await getMetadata(ref(authed("alice"), ASSET_PATH));
    assert.equal(metadata.customMetadata.assetId, ASSET_ID);
    assert.equal(metadata.customMetadata.workspaceId, WID);
    assert.equal(metadata.customMetadata.assetKind, "editor-image");
  });

  test("cannot create in another workspace, even with that workspace named in the metadata", async () => {
    const storage = authed("alice");
    const foreign = `workspaces/${OTHER_WID}/assets/${ASSET_ID}`;
    await assertFails(uploadBytes(ref(storage, foreign), BYTES, upload("image/jpeg", { workspaceId: OTHER_WID })));
    await assertFails(uploadBytes(ref(storage, foreign), BYTES, upload()));
  });

  test("cannot list the workspace's asset prefix — the index lives in Firestore", async () => {
    await seedObject();
    await assertFails(listAll(ref(authed("alice"), `workspaces/${WID}/assets`)));
    await assertFails(listAll(ref(authed("alice"), `workspaces/${WID}`)));
    await assertFails(listAll(ref(authed("alice"), "")));
  });
});

describe("storage.rules — non-member", { concurrency: false }, () => {
  beforeEach(async () => {
    await seedWorkspace("alice", WID);
    await seedWorkspace("carol", OTHER_WID);
  });

  test("no read, create or delete of another workspace's assets", async () => {
    await seedObject();
    for (const uid of ["carol", "mallory"]) {
      const storage = authed(uid);
      await assertFails(getBytes(ref(storage, ASSET_PATH)));
      await assertFails(getMetadata(ref(storage, ASSET_PATH)));
      await assertFails(uploadBytes(ref(storage, `workspaces/${WID}/assets/asset-2`), BYTES, upload("image/jpeg", { assetId: "asset-2" })));
      await assertFails(deleteObject(ref(storage, ASSET_PATH)));
    }
    // The object is untouched.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const metadata = await getMetadata(ref(ctx.storage(), ASSET_PATH));
      assert.equal(Number(metadata.size), BYTES.length);
    });
  });
});

describe("storage.rules — object invariants", { concurrency: false }, () => {
  beforeEach(async () => {
    await seedWorkspace("alice", WID);
  });

  test("an existing object is never overwritten — not with the same bytes, not by the owner", async () => {
    await seedObject();
    const storage = authed("alice");
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, upload()));
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), new Uint8Array([9, 9]), upload("image/png")));
    const bytes = await getBytes(ref(storage, ASSET_PATH));
    assert.deepEqual(new Uint8Array(bytes), BYTES);
  });

  test("a malformed asset id is refused", async () => {
    const storage = authed("alice");
    for (const bad of [".hidden", "-leading-dash", "with space", "a".repeat(201), "__proto__"]) {
      await assertFails(uploadBytes(ref(storage, `workspaces/${WID}/assets/${bad}`), BYTES, upload("image/jpeg", { assetId: bad })));
    }
  });

  test("custom metadata must name the path's own workspace and asset", async () => {
    const storage = authed("alice");
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, upload("image/jpeg", { assetId: "asset-other" })));
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, upload("image/jpeg", { workspaceId: OTHER_WID })));
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, { contentType: "image/jpeg" })); // none at all
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, { contentType: "image/jpeg", customMetadata: { assetId: ASSET_ID, workspaceId: WID } })); // no kind
  });

  test("the asset kind must be one the product knows", async () => {
    const storage = authed("alice");
    for (const bad of ["asset", "avatar", "PDF-SOURCE", "", "nodes"]) {
      await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, upload("image/jpeg", { assetKind: bad })));
    }
    for (const kind of ["logo", "note-photo", "note-file", "editor-image", "editor-file", "pdf-source"]) {
      const id = `asset-${kind}`;
      await assertSucceeds(uploadBytes(ref(storage, `workspaces/${WID}/assets/${id}`), BYTES, upload("image/jpeg", { assetId: id, assetKind: kind })));
    }
  });

  test("a zero-byte object is refused", async () => {
    await assertFails(uploadBytes(ref(authed("alice"), ASSET_PATH), new Uint8Array(0), upload()));
  });

  test("an object over 50 MB is refused; one exactly at the ceiling is accepted", { timeout: 120000 }, async () => {
    const storage = authed("alice");
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), new Uint8Array(MAX_BYTES + 1), upload("application/pdf", { assetKind: "pdf-source" })));
    await assertSucceeds(
      uploadBytes(ref(storage, `workspaces/${WID}/assets/asset-max`), new Uint8Array(MAX_BYTES), upload("application/pdf", { assetId: "asset-max", assetKind: "pdf-source" }))
    );
  });

  test("every content type on the canonical list is accepted", async () => {
    const storage = authed("alice");
    for (let i = 0; i < ALLOWED_MIME_TYPES.length; i++) {
      const id = `asset-mime-${i}`;
      await assertSucceeds(uploadBytes(ref(storage, `workspaces/${WID}/assets/${id}`), BYTES, upload(ALLOWED_MIME_TYPES[i], { assetId: id, assetKind: "note-file" })));
    }
  });

  test("a content type off the list is refused — scriptable, generic, and unknown types alike", async () => {
    const storage = authed("alice");
    for (const bad of DISALLOWED_MIME_TYPES) {
      await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, upload(bad)));
    }
    // A parameterised type is not on the list either: the client normalises first.
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, upload("text/plain; charset=utf-8", { assetKind: "note-file" })));
  });
});

describe("storage.rules — deletion is owner-authorised", { concurrency: false }, () => {
  beforeEach(async () => {
    await seedWorkspace("alice", WID, { members: ["bob"] });
    await seedWorkspace("carol", OTHER_WID);
    await seedObject();
  });

  test("the workspace owner deletes", async () => {
    await assertSucceeds(deleteObject(ref(authed("alice"), ASSET_PATH)));
    await assert.rejects(getMetadata(ref(authed("alice"), ASSET_PATH)), { code: "storage/object-not-found" });
  });

  test("an ordinary member of the same workspace cannot delete, though they can read", async () => {
    await assertSucceeds(getBytes(ref(authed("bob"), ASSET_PATH)));
    await assertFails(deleteObject(ref(authed("bob"), ASSET_PATH)));
  });

  test("the owner of ANOTHER workspace cannot delete here", async () => {
    await assertFails(deleteObject(ref(authed("carol"), ASSET_PATH)));
    await env.withSecurityRulesDisabled(async (ctx) => {
      assert.equal(Number((await getMetadata(ref(ctx.storage(), ASSET_PATH))).size), BYTES.length);
    });
  });

  test("an owner membership document alone does not make an owner — workspaces/{wid}.ownerUid decides", async () => {
    // A forged/stale owner-role membership for mallory, with the workspace still alice's.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const now = new Date();
      await setDoc(doc(ctx.firestore(), "workspaces", WID, "members", "mallory"), { uid: "mallory", role: "owner", addedAt: now, addedBy: "mallory" });
    });
    await assertSucceeds(getBytes(ref(authed("mallory"), ASSET_PATH))); // a member, so may read
    await assertFails(deleteObject(ref(authed("mallory"), ASSET_PATH))); // not the owner
  });
});

describe("storage.rules — everything outside the namespace", { concurrency: false }, () => {
  test("other paths are closed to members and strangers alike", async () => {
    await seedWorkspace("alice", WID);
    await seedObject("public/anything.txt", { contentType: "text/plain" });
    const storage = authed("alice");
    await assertFails(getBytes(ref(storage, "public/anything.txt")));
    await assertFails(uploadBytes(ref(storage, "public/anything.txt"), BYTES, { contentType: "text/plain" }));
    await assertFails(uploadBytes(ref(storage, "anything-at-the-root"), BYTES, { contentType: "text/plain" }));
    await assertFails(uploadBytes(ref(storage, `workspaces/${WID}/other/${ASSET_ID}`), BYTES, upload()));
    await assertFails(uploadBytes(ref(storage, `workspaces/${WID}/assets/${ASSET_ID}/nested`), BYTES, upload()));
    await assertFails(listAll(ref(storage, "")));
  });
});
