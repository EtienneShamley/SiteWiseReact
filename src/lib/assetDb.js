// src/lib/assetDb.js
//
// The ONE connection to the `notewise-assets` IndexedDB database, and the one
// transaction helper over it.
//
// It exists because three modules now share that database and a browser
// permits only one version of it at a time: an accidental second opener at a
// different version would block every reader forever. Extracting the opener is
// therefore a correctness requirement, not tidiness.
//
//   src/lib/assetStorage.js      the `assets` store — one record per stored
//                                Blob (the bytes of a logo, a photo, a note
//                                file, a Free-form image or attachment)
//   src/lib/assetUploadQueue.js  the `assetUploadQueue` store — WHICH of this
//                                browser's assets a workspace still owes the
//                                cloud (Production Readiness Phase 7.4 drains
//                                it; nothing uploads yet)
//   src/lib/assetRemoteIndex.js  the `assetRemoteIndex` store — what this
//                                browser knows the cloud to hold
//   src/lib/assetGcLedger.js     the `assetGcObservations` and `assetGcRuns`
//                                stores — when this browser FIRST observed a
//                                cloud asset to be unreferenced, and what the
//                                last garbage-collection mark pass did
//                                (Production Readiness Phase 7.9A)
//
// SCHEMA
//
//   v1  assets              keyPath "id"
//   v2  assets              unchanged — existing records are NOT rewritten,
//                           re-keyed or deleted by the upgrade
//       assetUploadQueue    keyPath ["workspaceId", "assetId"]
//       assetRemoteIndex    keyPath ["workspaceId", "assetId"]
//   v3  everything above    unchanged, for the same reason
//       assetGcObservations keyPath ["workspaceId", "assetId"]
//       assetGcRuns         keyPath "workspaceId"
//
// The workspace-scoped stores are keyed by the WORKSPACE AND the asset, in
// that order. That is what makes cross-account access structurally impossible
// rather than merely filtered: an entry cannot be addressed without naming the
// workspace it belongs to, and one workspace's entries occupy a contiguous key
// range (`workspaceAssetKeyRange`) that another workspace's range cannot
// overlap. `assetGcRuns` holds ONE record per workspace and is keyed by the
// workspace alone, for the same reason.
//
// Every helper returns a promise and REJECTS on failure — nothing here
// swallows an error or reports a write that did not land.

export const ASSET_DB_NAME = "notewise-assets";
export const ASSET_DB_VERSION = 3;

export const ASSET_STORE = "assets";
export const ASSET_UPLOAD_QUEUE_STORE = "assetUploadQueue";
export const ASSET_REMOTE_INDEX_STORE = "assetRemoteIndex";
export const ASSET_GC_OBSERVATION_STORE = "assetGcObservations";
export const ASSET_GC_RUN_STORE = "assetGcRuns";

/** The compound key path every workspace-and-asset store uses. */
export const WORKSPACE_ASSET_KEY_PATH = ["workspaceId", "assetId"];

let dbPromise = null;

export function openAssetDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser"));
      return;
    }
    const req = indexedDB.open(ASSET_DB_NAME, ASSET_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Purely ADDITIVE. A v1 database arrives here with its `assets` store
      // populated and a v2 one with its queue and index rows as well; both are
      // left exactly as they are, and only the stores that do not exist yet
      // are created. There is no version-by-version branching for the same
      // reason: every step of this schema has only ever ADDED stores, so
      // "create what is missing" is correct from any earlier version.
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        db.createObjectStore(ASSET_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ASSET_UPLOAD_QUEUE_STORE)) {
        db.createObjectStore(ASSET_UPLOAD_QUEUE_STORE, { keyPath: WORKSPACE_ASSET_KEY_PATH });
      }
      if (!db.objectStoreNames.contains(ASSET_REMOTE_INDEX_STORE)) {
        db.createObjectStore(ASSET_REMOTE_INDEX_STORE, { keyPath: WORKSPACE_ASSET_KEY_PATH });
      }
      if (!db.objectStoreNames.contains(ASSET_GC_OBSERVATION_STORE)) {
        db.createObjectStore(ASSET_GC_OBSERVATION_STORE, { keyPath: WORKSPACE_ASSET_KEY_PATH });
      }
      if (!db.objectStoreNames.contains(ASSET_GC_RUN_STORE)) {
        db.createObjectStore(ASSET_GC_RUN_STORE, { keyPath: "workspaceId" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab upgrades the schema, drop our handle so the next call
      // reopens cleanly instead of failing forever.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error("Failed to open asset storage database"));
    };
  });
  return dbPromise;
}

/**
 * Run ONE transaction over one or more stores.
 *
 * `run(stores, tx)` receives `{ [storeName]: IDBObjectStore }` and may:
 *   - return an IDBRequest, whose `result` becomes the resolution value; or
 *   - return a function, called at `oncomplete` for the resolution value; or
 *   - return nothing, resolving to `undefined`.
 *
 * A synchronous throw inside `run` — a non-cloneable value, a key that does
 * not match the store's key path — ABORTS the transaction rather than letting
 * the requests already made commit on their own. That is what makes a
 * multi-store write all-or-nothing in both directions: IndexedDB rolls back an
 * asynchronous failure itself, and this rolls back a synchronous one.
 */
export function assetDbTransaction(storeNames, mode, run) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return openAssetDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const missing = names.filter((name) => !db.objectStoreNames.contains(name));
        if (missing.length) {
          reject(new Error(`Asset storage is missing the ${missing.join(", ")} store`));
          return;
        }
        let tx;
        try {
          tx = db.transaction(names, mode);
        } catch (err) {
          reject(err || new Error("Could not start an asset storage transaction"));
          return;
        }
        let getResult = () => undefined;
        let failure = null;
        tx.oncomplete = () => (failure ? reject(failure) : resolve(getResult()));
        tx.onerror = () =>
          reject(failure || tx.error || new Error("Asset storage transaction failed"));
        tx.onabort = () =>
          reject(failure || tx.error || new Error("Asset storage transaction aborted"));
        const stores = {};
        for (const name of names) stores[name] = tx.objectStore(name);
        try {
          const outcome = run(stores, tx);
          if (typeof outcome === "function") {
            getResult = outcome;
          } else if (outcome && typeof outcome === "object" && "onsuccess" in outcome) {
            outcome.onsuccess = () => {
              const value = outcome.result;
              getResult = () => value;
            };
          }
        } catch (err) {
          failure = err instanceof Error ? err : new Error(String(err));
          try {
            tx.abort();
          } catch {
            // Already aborting; the handlers above still reject with `failure`.
          }
        }
      })
  );
}

/**
 * The key range covering EVERY entry of one workspace in a store keyed by
 * ["workspaceId", "assetId"], and nothing else.
 *
 * `[id]` sorts before `[id, <anything>]` (a shorter array is a prefix), and an
 * array sorts after every string, so `[id, []]` is an exclusive upper bound
 * past the workspace's last entry and before the next workspace's first.
 */
export function workspaceAssetKeyRange(workspaceId) {
  return IDBKeyRange.bound([workspaceId], [workspaceId, []], false, true);
}

/**
 * Forget the cached connection so the next call reopens the database.
 * Needed after a test deletes or closes it; production drops the handle on
 * `versionchange` above.
 */
export function resetAssetDbConnection() {
  dbPromise = null;
}
