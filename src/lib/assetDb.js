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
//   src/lib/listenIn/listenInStore.js
//                                the `listenInSessions` and `listenInChunks`
//                                stores — a Listen In capture session and its
//                                sealed audio/transcript chunks (Phase 8D.1)
//
// LISTEN IN IS NOT AN ASSET. Its two stores live in this database because a
// browser allows one version of one database at a time and this module is the
// project's single opener — not because Listen In participates in the asset
// lifecycle. Nothing in the asset layer reads them: no upload queue, no remote
// index, no garbage collection, no Security Rules and no Firebase path. Listen
// In audio is LOCAL AND TEMPORARY, and whether it is written at all is gated
// by src/lib/listenIn/listenInPolicy.js.
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
//   v4  everything above    unchanged, for the same reason
//       listenInSessions    keyPath ["workspaceId", "sessionId"]
//       listenInChunks      keyPath ["workspaceId", "sessionId", "seq"]
//   v5  everything above    unchanged, for the same reason
//       the two listenIn stores are RECREATED with the authenticated uid as
//       their first key segment (see below). This is the one non-additive
//       step in this schema's history, and it was safe for exactly one
//       reason: throughout v4's existence, writing to those stores was
//       refused by src/lib/listenIn/listenInPolicy.js, so a v4 database
//       cannot hold a single Listen In record. An empty store is recreated,
//       not migrated. Durable capture was approved at v5 (2026-09-12); any
//       change from here on is a real migration.
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
export const ASSET_DB_VERSION = 5;

export const ASSET_STORE = "assets";
export const ASSET_UPLOAD_QUEUE_STORE = "assetUploadQueue";
export const ASSET_REMOTE_INDEX_STORE = "assetRemoteIndex";
export const ASSET_GC_OBSERVATION_STORE = "assetGcObservations";
export const ASSET_GC_RUN_STORE = "assetGcRuns";
// Listen In (Phase 8D.1). Named here because this module owns the schema;
// everything that reads or writes them lives in src/lib/listenIn/.
export const LISTEN_IN_SESSION_STORE = "listenInSessions";
export const LISTEN_IN_CHUNK_STORE = "listenInChunks";

/** The compound key path every workspace-and-asset store uses. */
export const WORKSPACE_ASSET_KEY_PATH = ["workspaceId", "assetId"];
/**
 * A Listen In session, keyed by the SIGNED-IN USER and then the workspace.
 *
 * The uid comes first because IndexedDB is scoped to the ORIGIN, not to a
 * Firebase account: two people can sign into NoteWise in the same browser
 * profile, and they may even share a workspace. A workspace-only key would
 * therefore put one person's retained meeting audio inside the other's key
 * range — reachable by enumeration, recovery, retry and delete alike. Putting
 * the uid in the key makes the user boundary STRUCTURAL: a record cannot be
 * addressed at all without naming the account that owns it, exactly as the
 * asset layer does for workspaces.
 */
export const LISTEN_IN_SESSION_KEY_PATH = ["uid", "workspaceId", "sessionId"];
/** One chunk of one session. The seq LAST, so a session's chunks are one
 *  contiguous, correctly ordered key range (IndexedDB sorts arrays
 *  element-wise, and a number sorts before a string or an array). */
export const LISTEN_IN_CHUNK_KEY_PATH = ["uid", "workspaceId", "sessionId", "seq"];

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
      // Listen In. Creating the stores writes nothing: they are empty until a
      // capture session is recorded into them, and what may be recorded is
      // decided by src/lib/listenIn/listenInPolicy.js, not here.
      //
      // A v4 database has these two stores with a workspace-only key path,
      // which IndexedDB cannot alter in place. They are dropped and remade
      // with the identity key path rather than migrated, because the policy
      // refused every write for the whole of v4 and they cannot contain a
      // record. Nothing else in this upgrade removes anything, and nothing
      // here touches an asset store.
      for (const [name, keyPath] of [
        [LISTEN_IN_SESSION_STORE, LISTEN_IN_SESSION_KEY_PATH],
        [LISTEN_IN_CHUNK_STORE, LISTEN_IN_CHUNK_KEY_PATH],
      ]) {
        const existing = db.objectStoreNames.contains(name);
        if (existing) {
          const store = req.transaction.objectStore(name);
          if (String(store.keyPath) === String(keyPath)) continue;
          db.deleteObjectStore(name);
        }
        db.createObjectStore(name, { keyPath });
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
 * Every Listen In row belonging to ONE ACCOUNT in ONE WORKSPACE, and nothing
 * else — the same prefix argument as above, with the identity in front.
 */
export function listenInOwnerKeyRange(uid, workspaceId) {
  return IDBKeyRange.bound([uid, workspaceId], [uid, workspaceId, []], false, true);
}

/**
 * Every row of ONE Listen In session, and nothing else. Naming the session
 * without naming its owner is not possible: the uid is part of the bound.
 */
export function listenInSessionKeyRange(uid, workspaceId, sessionId) {
  return IDBKeyRange.bound(
    [uid, workspaceId, sessionId],
    [uid, workspaceId, sessionId, []],
    false,
    true
  );
}

/**
 * Forget the cached connection so the next call reopens the database.
 * Needed after a test deletes or closes it; production drops the handle on
 * `versionchange` above.
 */
export function resetAssetDbConnection() {
  dbPromise = null;
}
