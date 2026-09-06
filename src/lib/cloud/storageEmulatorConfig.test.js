// src/lib/cloud/storageEmulatorConfig.test.js
//
// The repository's own Firebase configuration: the Storage emulator is wired
// up beside the Firestore one, the rules file the emulator loads is the
// membership-based one of Phase 7.3 (the deny-all of 7.1 re-targeted, not
// deleted — nothing is granted to a stranger, and nothing outside the asset
// namespace to anybody), and `npm run test:rules` runs BOTH rule suites
// against BOTH emulators, sequentially. These are facts a change can break
// silently — a rules file that is configured but never loaded, or a suite
// that stops running — so they are asserted here as well as exercised in
// test/rules/.
import fs from "fs";
import path from "path";

const root = path.join(__dirname, "..", "..", "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const firebaseJson = JSON.parse(read("firebase.json"));
const packageJson = JSON.parse(read("package.json"));

describe("firebase.json", () => {
  test("the Storage emulator runs on 9199 and the Firestore configuration is untouched", () => {
    expect(firebaseJson.emulators.storage).toEqual({ port: 9199 });
    expect(firebaseJson.emulators.firestore).toEqual({ port: 8080 });
    expect(firebaseJson.emulators.auth).toEqual({ port: 9099 });
    expect(firebaseJson.emulators.singleProjectMode).toBe(true);
  });

  test("storage.rules is the bucket's rules file, and firestore.rules still Firestore's", () => {
    expect(firebaseJson.storage).toEqual({ rules: "storage.rules" });
    expect(firebaseJson.firestore).toEqual({ rules: "firestore.rules", indexes: "firestore.indexes.json" });
    expect(fs.existsSync(path.join(root, "storage.rules"))).toBe(true);
  });
});

describe("storage.rules", () => {
  const rules = read("storage.rules");
  const code = rules.replace(/\/\/.*$/gm, "");

  test("it is a Storage rules file, version 2", () => {
    expect(code).toMatch(/rules_version = '2';/);
    expect(code).toMatch(/service firebase\.storage/);
  });

  test("Phase 7.3, narrowed by 7.10A: one namespace, membership from Firestore, create-only objects, NO deletion, everything else closed", () => {
    expect(code).toMatch(/match \/workspaces\/\{workspaceId\}\/assets\/\{assetId\}/);
    // Every grant is conditional on a Firestore membership look-up, and only
    // reading and creating are granted at all.
    const grants = code.match(/allow [a-z, ]+: if (?!false;)[^;]*;/g);
    expect(grants).toHaveLength(2);
    expect(grants[0]).toMatch(/^allow get: if isMember\(workspaceId\)/);
    expect(grants[1]).toMatch(/^allow create: if isMember\(workspaceId\)/);
    expect(grants[1]).toMatch(/resource == null/);
    expect(grants[1]).toMatch(/validNewObject\(workspaceId, assetId\)/);
    expect(code).toMatch(/allow update: if false;/);
    expect(code).toMatch(/allow list: if false;/);
    expect(code).toMatch(/allow delete: if false;/);
    expect(code).toMatch(/match \/\{allPaths=\*\*\} \{\s*allow read, write: if false;\s*\}/);
    expect(code).toMatch(/firestore\.exists\(memberPath\(wid, request\.auth\.uid\)\)/);
    // Phase 7.10A: NoteWise V1 performs no physical cloud-asset deletion, so
    // the file reads no ownership at all — there is no dormant owner check a
    // later edit could re-wire to a delete grant without noticing.
    expect(code).not.toMatch(/isOwner/);
    expect(code).not.toMatch(/ownerUid/);
    // Nothing is decided from a membership document's role field.
    expect(code).not.toMatch(/role/);
    // No download URL, no public read, no unconditional grant.
    expect(code).not.toMatch(/if\s+true/);
  });

  test("the create rule's object invariants: size, content type and identity metadata", () => {
    expect(code).toMatch(/request\.resource\.size > 0/);
    expect(code).toMatch(/request\.resource\.size <= 52428800/);
    expect(code).toMatch(/request\.resource\.contentType in assetMimeTypes\(\)/);
    expect(code).toMatch(/request\.resource\.metadata\.assetId == assetId/);
    expect(code).toMatch(/request\.resource\.metadata\.workspaceId == wid/);
    expect(code).toMatch(/request\.resource\.metadata\.assetKind in \['logo', 'note-photo', 'note-file', 'editor-image', 'editor-file', 'pdf-source'\]/);
  });
});

describe("firestore.rules — the asset metadata collection", () => {
  const code = read("firestore.rules").replace(/\/\/.*$/gm, "");
  /** The `match /assets/{assetId}` block alone, so a grant elsewhere cannot stand in for one here. */
  const assetsBlock = code.match(/match \/assets\/\{assetId\} \{[\s\S]*?\n {6}\}/)[0];

  test("assets are admitted additively, deletable by nobody, and pdfAnnotations joins the JSON collections", () => {
    expect(code).toMatch(/match \/assets\/\{assetId\} \{/);
    // Phase 7.10A: no client physically deletes an asset record in V1.
    expect(assetsBlock).toMatch(/allow delete: if false;/);
    expect(assetsBlock).not.toMatch(/isOwner/);
    // Members still read, create and move the document between its two states.
    expect(assetsBlock).toMatch(/allow read: if isMember\(wid\);/);
    expect(assetsBlock).toMatch(/allow create: if isMember\(wid\)/);
    expect(assetsBlock).toMatch(/allow update: if isMember\(wid\)/);
    expect(code).toMatch(/validEnvelope\('assets', assetId\)/);
    expect(code).toMatch(/request\.resource\.data\.state == 'stored'/);
    expect(code).toMatch(/next\.tombstonedAt == request\.time/);
    // pdfAnnotations is on every one of the six JSON-collection allow-lists.
    const lists = code.match(/jsonCollection in \[[^\]]*\]/g);
    expect(lists).toHaveLength(6);
    for (const list of lists) expect(list).toBe("jsonCollection in ['templates', 'templateVersions', 'templateInstances', 'pdfDocs', 'pdfAnnotations']");
    // The Phase 6 grants are untouched: members still read/write/delete entity documents.
    expect(code).toMatch(/match \/nodes\/\{id\} \{\s*allow read: if isMember\(wid\);/);
    expect(code).toMatch(/match \/members\/\{uid\} \{[\s\S]*?allow update, delete: if false;/);
  });
});

describe("npm run test:rules", () => {
  const script = packageJson.scripts["test:rules"];

  test("it starts both emulators", () => {
    expect(script).toContain("--only firestore,storage");
    expect(script).toContain("--project notewise-rules-test");
  });

  test("it runs the two files one after the other — both suites seed and clear the same Firestore emulator", () => {
    expect(script).toContain("node --test --test-concurrency=1 ");
  });

  test("it runs both rule suites, and the existing Firestore one still first", () => {
    expect(script).toContain("test/rules/firestore.rules.test.js");
    expect(script).toContain("test/rules/storage.rules.test.js");
    expect(fs.existsSync(path.join(root, "test/rules/storage.rules.test.js"))).toBe(true);
  });

  test("CI runs that one script — no separate emulator wiring to keep in step", () => {
    const pipeline = read("azure-pipelines.yml");
    expect(pipeline).toContain("npm run test:rules");
    expect(pipeline).not.toContain("emulators:exec");
  });
});
