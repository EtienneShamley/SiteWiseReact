// test/rules/storage.rules.test.js
//
// Firebase Storage Security Rules, verified against the REAL `storage.rules`
// in the Storage emulator (@firebase/rules-unit-testing). Run with
// `npm run test:rules` (= `firebase emulators:exec --only firestore,storage
// "node --test test/rules/…"`); CI runs it in the Validate stage with no
// Firebase project or credential (the emulator is local).
//
// Deliberately Node's own test runner, not Jest, for the same reason as
// test/rules/firestore.rules.test.js: the rules-testing library and the
// Firebase SDK need the real Node realm's `fetch` and web streams.
//
// PHASE 7.1 CONTRACT: the bucket is CLOSED. Every case below asserts a
// refusal — unauthenticated and authenticated, on the canonical asset path
// and on an arbitrary one, for reading, listing, writing, overwriting and
// deleting, whether or not the object already exists. When the
// membership-based rules replace the deny-all, these tests are re-targeted
// rather than deleted: the unauthenticated and non-member cases stay
// refusals for good.
//
// `getBytes` is used for the read attempt because `getBlob` — the read path
// the application itself uses — is browser-only; both go through the same
// rules check.

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { assertFails, initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const {
  deleteObject,
  getBytes,
  getMetadata,
  listAll,
  ref,
  uploadBytes,
} = require("firebase/storage");

const PROJECT_ID = "notewise-rules-test";
const ASSET_PATH = "workspaces/ws-alice/assets/asset-1";
const BYTES = new Uint8Array([1, 2, 3, 4]);
const TYPE = { contentType: "image/jpeg" };

let env;

before(async () => {
  const [host, port] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199").split(":");
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: {
      rules: fs.readFileSync(path.join(__dirname, "..", "..", "storage.rules"), "utf8"),
      host,
      port: Number(port),
    },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearStorage();
});

const authed = (uid) => env.authenticatedContext(uid, { email_verified: true }).storage();
const anon = () => env.unauthenticatedContext().storage();

/** Places an object with the rules bypassed, so reads face a real object. */
async function seedObject(objectPath = ASSET_PATH) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), objectPath), BYTES, TYPE);
  });
}

describe("storage.rules — Phase 7.1 deny-all", { concurrency: false }, () => {
  test("the rules file itself denies read and write outright", () => {
    const rules = fs.readFileSync(path.join(__dirname, "..", "..", "storage.rules"), "utf8");
    assert.match(rules, /rules_version = '2'/);
    assert.match(rules, /service firebase\.storage/);
    assert.match(rules, /allow read, write: if false;/);
    // No path is granted anything, to anybody, at this phase.
    assert.equal(/if\s+(?!false)/.test(rules.replace(/\/\/.*$/gm, "")), false);
  });

  test("unauthenticated: no read, list, write or delete", async () => {
    await seedObject();
    const storage = anon();
    await assertFails(getBytes(ref(storage, ASSET_PATH)));
    await assertFails(getMetadata(ref(storage, ASSET_PATH)));
    await assertFails(listAll(ref(storage, "workspaces/ws-alice/assets")));
    await assertFails(uploadBytes(ref(storage, "workspaces/ws-alice/assets/asset-2"), BYTES, TYPE));
    await assertFails(deleteObject(ref(storage, ASSET_PATH)));
  });

  test("authenticated: still no read, list, write or delete — of anyone's object", async () => {
    await seedObject();
    const storage = authed("alice");
    await assertFails(getBytes(ref(storage, ASSET_PATH)));
    await assertFails(getMetadata(ref(storage, ASSET_PATH)));
    await assertFails(listAll(ref(storage, "workspaces/ws-alice/assets")));
    await assertFails(uploadBytes(ref(storage, "workspaces/ws-alice/assets/asset-2"), BYTES, TYPE));
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, TYPE)); // overwrite
    await assertFails(deleteObject(ref(storage, ASSET_PATH)));
  });

  test("a second account cannot reach another workspace's assets either", async () => {
    await seedObject();
    const storage = authed("mallory");
    await assertFails(getBytes(ref(storage, ASSET_PATH)));
    await assertFails(uploadBytes(ref(storage, ASSET_PATH), BYTES, TYPE));
    await assertFails(deleteObject(ref(storage, ASSET_PATH)));
  });

  test("paths outside the asset convention are closed as well", async () => {
    await seedObject("public/anything.txt");
    const storage = authed("alice");
    await assertFails(getBytes(ref(storage, "public/anything.txt")));
    await assertFails(uploadBytes(ref(storage, "public/anything.txt"), BYTES, TYPE));
    await assertFails(uploadBytes(ref(storage, "anything-at-the-root"), BYTES, TYPE));
    await assertFails(listAll(ref(storage, "")));
  });

  test("the seeded object is genuinely there — the refusals are the rules, not an empty bucket", async () => {
    await seedObject();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const metadata = await getMetadata(ref(ctx.storage(), ASSET_PATH));
      assert.equal(metadata.contentType, "image/jpeg");
      assert.equal(Number(metadata.size), BYTES.length);
    });
  });
});
