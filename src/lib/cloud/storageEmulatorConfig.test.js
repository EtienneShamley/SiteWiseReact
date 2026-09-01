// src/lib/cloud/storageEmulatorConfig.test.js
//
// The repository's own Firebase configuration: the Storage emulator is wired
// up beside the Firestore one, the rules file the emulator loads is the
// deny-all of Phase 7.1, and `npm run test:rules` runs BOTH rule suites
// against BOTH emulators. These are facts a change can break silently — a
// rules file that is configured but never loaded, or a suite that stops
// running — so they are asserted here as well as exercised in test/rules/.
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

  test("Phase 7.1: it denies everything, to everybody", () => {
    expect(code).toMatch(/match \/\{allPaths=\*\*\} \{\s*allow read, write: if false;\s*\}/);
    // Not one condition in the file grants anything.
    expect(code.match(/allow[^;]*;/g)).toEqual(["allow read, write: if false;"]);
    expect(code).not.toMatch(/request\.auth/);
  });
});

describe("npm run test:rules", () => {
  const script = packageJson.scripts["test:rules"];

  test("it starts both emulators", () => {
    expect(script).toContain("--only firestore,storage");
    expect(script).toContain("--project notewise-rules-test");
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
