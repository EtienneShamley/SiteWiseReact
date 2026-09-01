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
  FIREBASE_FIRESTORE_EMULATOR_VARIABLE,
  FIREBASE_STORAGE_BUCKET_VARIABLE,
  FIREBASE_STORAGE_EMULATOR_VARIABLE,
  STORAGE_CONFIG_REASON,
  resolveFirebaseClientConfig,
  resolveFirebaseStorageConfig,
} from "./firebaseClientConfig";

const FULL = {
  apiKey: "AIzaSy-not-a-real-key",
  authDomain: "notewise-dev.firebaseapp.com",
  projectId: "notewise-dev",
  appId: "1:123:web:abc",
};

describe("resolveFirebaseClientConfig", () => {
  test("a complete set resolves, trimmed and frozen, with no bucket or emulator by default", () => {
    const result = resolveFirebaseClientConfig({ ...FULL, projectId: " notewise-dev " });
    expect(result).toEqual({
      ok: true,
      config: {
        ...FULL,
        storageBucket: null,
        emulatorHost: null,
        firestoreEmulatorHost: null,
        storageEmulatorHost: null,
      },
    });
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

  test("the optional emulator hosts are carried when set", () => {
    const config = resolveFirebaseClientConfig({
      ...FULL,
      emulatorHost: "127.0.0.1:9099",
      firestoreEmulatorHost: "127.0.0.1:8080",
      storageEmulatorHost: " 127.0.0.1:9199 ",
    }).config;
    expect(config.emulatorHost).toBe("127.0.0.1:9099");
    expect(config.firestoreEmulatorHost).toBe("127.0.0.1:8080");
    expect(config.storageEmulatorHost).toBe("127.0.0.1:9199");
    expect(FIREBASE_AUTH_EMULATOR_VARIABLE).toBe("REACT_APP_FIREBASE_AUTH_EMULATOR_HOST");
    expect(FIREBASE_FIRESTORE_EMULATOR_VARIABLE).toBe("REACT_APP_FIREBASE_FIRESTORE_EMULATOR_HOST");
    expect(FIREBASE_STORAGE_EMULATOR_VARIABLE).toBe("REACT_APP_FIREBASE_STORAGE_EMULATOR_HOST");
    expect(Object.values(FIREBASE_CLIENT_VARIABLES).every((v) => v.startsWith("REACT_APP_FIREBASE_"))).toBe(true);
  });

  test("the storage bucket is optional to the four required values, and normalised", () => {
    // Missing: the four required values still resolve — signing in and
    // structured data do not depend on a bucket.
    expect(resolveFirebaseClientConfig(FULL).ok).toBe(true);
    expect(resolveFirebaseClientConfig(FULL).config.storageBucket).toBeNull();
    expect(FIREBASE_STORAGE_BUCKET_VARIABLE).toBe("REACT_APP_FIREBASE_STORAGE_BUCKET");

    for (const raw of ["notewise-dev.appspot.com", " gs://notewise-dev.appspot.com ", "gs://notewise-dev.appspot.com/"]) {
      expect(resolveFirebaseClientConfig({ ...FULL, storageBucket: raw }).config.storageBucket).toBe(
        "notewise-dev.appspot.com"
      );
    }
  });
});

describe("resolveFirebaseStorageConfig", () => {
  test("a configured bucket resolves to the bucket and its gs:// URL, frozen", () => {
    const result = resolveFirebaseStorageConfig({ storageBucket: "notewise-dev.firebasestorage.app" });
    expect(result).toEqual({
      ok: true,
      config: {
        bucket: "notewise-dev.firebasestorage.app",
        bucketUrl: "gs://notewise-dev.firebasestorage.app",
        emulatorHost: null,
      },
    });
    expect(Object.isFrozen(result.config)).toBe(true);
  });

  test("the cloud asset store refuses to run without a bucket — it never degrades silently", () => {
    for (const values of [{}, { storageBucket: "" }, { storageBucket: "   " }, { storageBucket: null }, undefined]) {
      expect(resolveFirebaseStorageConfig(values)).toEqual({
        ok: false,
        missing: ["REACT_APP_FIREBASE_STORAGE_BUCKET"],
        reason: STORAGE_CONFIG_REASON.MISSING,
      });
    }
  });

  test("a value that is not a bucket name is a refusal, not a path to interpolate", () => {
    for (const bucket of ["gs://bucket/with/path", "has space", "-leading-dash", "trailing-dash-", "b", "a b.com"]) {
      const result = resolveFirebaseStorageConfig({ storageBucket: bucket });
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(["REACT_APP_FIREBASE_STORAGE_BUCKET"]);
    }
    expect(resolveFirebaseStorageConfig({ storageBucket: "has space" }).reason).toBe(STORAGE_CONFIG_REASON.MALFORMED);
    // A trailing slash is a copy-paste artefact, not a malformed bucket.
    expect(resolveFirebaseStorageConfig({ storageBucket: "notewise-dev.appspot.com/" }).config.bucket).toBe(
      "notewise-dev.appspot.com"
    );
  });

  test("the optional storage emulator host is carried through", () => {
    expect(
      resolveFirebaseStorageConfig({ storageBucket: "notewise-dev.appspot.com", storageEmulatorHost: "127.0.0.1:9199" })
        .config.emulatorHost
    ).toBe("127.0.0.1:9199");
    // It reads a client config as-is, so an unconfigured emulator stays null.
    const client = resolveFirebaseClientConfig({ ...FULL, storageBucket: "notewise-dev.appspot.com" }).config;
    expect(resolveFirebaseStorageConfig(client).config).toEqual({
      bucket: "notewise-dev.appspot.com",
      bucketUrl: "gs://notewise-dev.appspot.com",
      emulatorHost: null,
    });
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

  test("only the four SDK modules import Firebase: the shared app, the auth adapter, the Firestore store, the Storage adapter", () => {
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
    expect(importers.sort()).toEqual([
      "lib/cloud/firebaseStorageAdapter.js",
      "lib/cloud/firestoreWorkspaceStore.js",
      "lib/firebaseApp.js",
      "lib/firebaseAuthAdapter.js",
    ]);
  });
});
