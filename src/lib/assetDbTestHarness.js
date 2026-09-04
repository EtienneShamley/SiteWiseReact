// src/lib/assetDbTestHarness.js
//
// Shared helpers for the asset-layer suites that run against a REAL IndexedDB
// implementation (fake-indexeddb, dev-only). Not a test file itself; imported
// by src/lib/asset*.test.js and src/lib/localAssetCache.test.js.
//
// Two things every one of those suites needs and none of them should own:
//
//   1. `structuredClone`. fake-indexeddb clones every stored value with it,
//      and the jsdom 16 test environment does not expose one. This supplies
//      V8's serializer for plain data, carrying Blobs (not V8-serializable)
//      across by reference — which is what a browser does with the underlying
//      bytes. The same shim already lives inline in
//      src/lib/assetStorageIndexedDb.test.js; new suites share this copy
//      rather than making a fourth.
//
//   2. A way to build a database at SCHEMA v1 — the schema that exists in
//      every browser that has used NoteWise before Production Readiness Phase
//      7.2 — so the upgrade can be proved against real v1 data rather than
//      against an empty store.

import { Blob as NodeBlob } from "buffer";
import { deserialize, serialize } from "v8";
import { ASSET_DB_NAME, ASSET_STORE, resetAssetDbConnection } from "./assetDb";

/* global globalThis */ // the ES2020 global object; the CRA browser env predates it

/** Installs the structuredClone shim once per test process. */
export function installStructuredCloneShim() {
  if (typeof globalThis.structuredClone === "function") return;
  globalThis.structuredClone = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const blobs = {};
      const rest = {};
      for (const [k, v] of Object.entries(value)) {
        if (v instanceof NodeBlob) blobs[k] = v;
        else rest[k] = v;
      }
      return { ...deserialize(serialize(rest)), ...blobs };
    }
    return deserialize(serialize(value));
  };
}

/**
 * A Node Blob. jsdom's Blob is not one, and fake-indexeddb stores what it is
 * given; Node Blobs expose the same `size`/`type` surface the record builder
 * reads.
 */
export function testBlob(text, type = "image/png") {
  return new NodeBlob([text], { type });
}

/** Deletes the asset database and forgets the module's cached connection. */
export function deleteAssetDb() {
  resetAssetDbConnection();
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(ASSET_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error("Could not delete the asset database"));
    req.onblocked = () => resolve();
  });
}

/**
 * Creates the database at VERSION 1 — one `assets` store keyed by `id` and
 * nothing else — and writes `records` into it. This is exactly the shape a
 * pre-Phase-7.2 browser holds.
 */
export function seedV1AssetDb(records = []) {
  resetAssetDbConnection();
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ASSET_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        db.createObjectStore(ASSET_STORE, { keyPath: "id" });
      }
    };
    req.onerror = () => reject(req.error || new Error("Could not open the v1 asset database"));
    req.onsuccess = () => {
      const db = req.result;
      if (records.length === 0) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(ASSET_STORE, "readwrite");
      const store = tx.objectStore(ASSET_STORE);
      for (const record of records) store.put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("Could not seed the v1 asset database"));
      };
    };
  });
}

/** The names of the object stores the database currently has. */
export function assetDbStoreNames(version) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(ASSET_DB_NAME, version) : indexedDB.open(ASSET_DB_NAME);
    req.onerror = () => reject(req.error || new Error("Could not open the asset database"));
    req.onsuccess = () => {
      const db = req.result;
      const names = Array.from(db.objectStoreNames).sort();
      db.close();
      resolve(names);
    };
  });
}
