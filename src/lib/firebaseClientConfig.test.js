// src/lib/firebaseClientConfig.test.js
//
// The Firebase web configuration comes from the environment, completely or
// not at all (src/lib/firebaseClientConfig.js). No project's values are in
// the source.
import fs from "fs";
import path from "path";
import {
  FIREBASE_AUTH_EMULATOR_VARIABLE,
  FIREBASE_CLIENT_VARIABLES,
  resolveFirebaseClientConfig,
} from "./firebaseClientConfig";

const FULL = {
  apiKey: "AIzaSy-not-a-real-key",
  authDomain: "notewise-dev.firebaseapp.com",
  projectId: "notewise-dev",
  appId: "1:123:web:abc",
};

describe("resolveFirebaseClientConfig", () => {
  test("a complete set resolves, trimmed and frozen, with no emulator by default", () => {
    const result = resolveFirebaseClientConfig({ ...FULL, projectId: " notewise-dev " });
    expect(result).toEqual({ ok: true, config: { ...FULL, emulatorHost: null, firestoreEmulatorHost: null } });
    expect(Object.isFrozen(result.config)).toBe(true);
  });

  test("every missing or blank required value is named, by its environment variable", () => {
    expect(resolveFirebaseClientConfig({})).toEqual({
      ok: false,
      missing: [
        "REACT_APP_FIREBASE_API_KEY",
        "REACT_APP_FIREBASE_AUTH_DOMAIN",
        "REACT_APP_FIREBASE_PROJECT_ID",
        "REACT_APP_FIREBASE_APP_ID",
      ],
    });
    expect(resolveFirebaseClientConfig({ ...FULL, appId: "  " })).toEqual({ ok: false, missing: ["REACT_APP_FIREBASE_APP_ID"] });
    expect(resolveFirebaseClientConfig(undefined).ok).toBe(false);
  });

  test("the optional emulator host is carried when set", () => {
    expect(resolveFirebaseClientConfig({ ...FULL, emulatorHost: "127.0.0.1:9099" }).config.emulatorHost).toBe("127.0.0.1:9099");
    expect(FIREBASE_AUTH_EMULATOR_VARIABLE).toBe("REACT_APP_FIREBASE_AUTH_EMULATOR_HOST");
    expect(Object.values(FIREBASE_CLIENT_VARIABLES).every((v) => v.startsWith("REACT_APP_FIREBASE_"))).toBe(true);
  });
});

describe("no project configuration lives in the source", () => {
  test("the application never hard-codes a Firebase project or key", () => {
    const src = path.join(__dirname, "..");
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx|css|html)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) files.push(full);
      }
    };
    walk(src);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toMatch(/AIza[0-9A-Za-z_-]{30,}/);
      expect(text).not.toMatch(/\.firebaseapp\.com/);
      expect(text).not.toMatch(/"1:\d+:web:/);
    }
    expect(files.length).toBeGreaterThan(50);
  });

  test("only the three SDK modules import Firebase: the shared app, the auth adapter, the Firestore store", () => {
    const src = path.join(__dirname, "..");
    const importers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) {
          if (/from\s+["']firebase\//.test(fs.readFileSync(full, "utf8"))) importers.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    expect(importers).toEqual(["lib/cloud/firestoreWorkspaceStore.js", "lib/firebaseApp.js", "lib/firebaseAuthAdapter.js"]);
  });
});
