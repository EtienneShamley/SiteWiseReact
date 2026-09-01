// src/lib/cloud/memoryWorkspaceStore.js
//
// An in-memory WORKSPACE STORE with the exact interface of
// src/lib/cloud/firestoreWorkspaceStore.js — the double every test and the
// rendered shell tests use, so Firebase is never loaded under Jest.
//
// It enforces the SAME authorization the Firestore Security Rules enforce
// (a caller may read/write only workspaces it is a member of; membership
// can only be created for oneself as the owner of a workspace one owns), so
// account-isolation tests exercise a real refusal, not a mock's absence of
// one. It is deliberately not a Firestore emulator: the rules themselves are
// tested against the real emulator (test/rules/).
//
// Failure injection: `failNext(kind, code)` makes the next commit / read /
// transaction reject with a Firestore-shaped `{ code }` error; `offline`
// makes commits hang (like the SDK does without a network) until
// `setOffline(false)`.
//
// ASSET METADATA (Production Readiness Phase 7): `readAssetIndex`,
// `readAssetDocument` and `deleteAssetDocument` mirror the Firestore store's
// operations over `workspaces/{wid}/assets/{assetId}` and are gated on
// membership like every other workspace read/write. They take the existing
// `read` / `commit` failure kinds. `readWorkspace` excludes the collection:
// asset metadata is not part of the workspace mirror the owner modules read,
// exactly as in the Firestore store. NOTE that `firestore.rules` does not
// admit the `assets` collection yet — the rules for it arrive with the asset
// cloud model — so these operations succeed here before they succeed against
// the real service.

import { MEMBER_ROLE } from "./workspaceBootstrap";
import { ASSET_COLLECTION, assetCollectionPath, assetDocumentPath } from "./assetPaths";

const TIMESTAMP = Object.freeze({ __serverTimestamp: true });

function firestoreError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function resolveTimestamps(data, now) {
  const out = {};
  for (const key of Object.keys(data || {})) {
    out[key] = data[key] === TIMESTAMP ? now : data[key];
  }
  return out;
}

export function createMemoryWorkspaceStore({ now = () => Date.now() } = {}) {
  // path string "a/b/c/d" → data
  const docs = new Map();
  let currentUid = null;
  let offline = false;
  const failures = { commit: null, read: null, transaction: null };
  const calls = { commits: [], reads: 0, transactions: 0 };
  let pendingOffline = [];

  const pathOf = (segments) => segments.join("/");

  function isMember(workspaceId, uid) {
    const member = docs.get(pathOf(["workspaces", workspaceId, "members", uid]));
    return Boolean(member);
  }

  function assertAuthenticated() {
    if (!currentUid) throw firestoreError("unauthenticated", "no signed-in user");
  }

  function take(kind) {
    const failure = failures[kind];
    failures[kind] = null;
    if (failure) throw firestoreError(failure);
  }

  // Rules-equivalent checks for a transaction/batch write.
  function authorizeWrite(path, data, exists) {
    const [root, a, b, c] = path;
    if (root === "users") {
      if (a !== currentUid) throw firestoreError("permission-denied", "users: not self");
      if (data && data.uid !== currentUid) throw firestoreError("permission-denied", "users: uid mismatch");
      return;
    }
    if (root !== "workspaces") throw firestoreError("permission-denied", "unknown root");
    const workspaceId = a;
    if (path.length === 2) {
      if (!data) throw firestoreError("permission-denied", "workspace delete");
      if (exists) {
        const existing = docs.get(pathOf(path));
        if (existing.ownerUid !== currentUid || data.ownerUid !== existing.ownerUid) {
          throw firestoreError("permission-denied", "workspace update");
        }
      } else if (data.ownerUid !== currentUid || data.id !== workspaceId) {
        throw firestoreError("permission-denied", "workspace create");
      }
      return;
    }
    if (b === "members") {
      const uid = c;
      if (exists || !data) throw firestoreError("permission-denied", "member update/delete");
      const workspaceAfter = pendingWorkspace(workspaceId) || docs.get(pathOf(["workspaces", workspaceId]));
      if (uid !== currentUid || data.role !== MEMBER_ROLE.OWNER || !workspaceAfter || workspaceAfter.ownerUid !== currentUid) {
        throw firestoreError("permission-denied", "member create");
      }
      return;
    }
    if (!isMember(workspaceId, currentUid)) throw firestoreError("permission-denied", "not a member");
    if (data && data.workspaceId !== workspaceId) throw firestoreError("permission-denied", "workspaceId mismatch");
  }

  // Within a transaction, a workspace being created in the same transaction
  // counts (Firestore's getAfter). Tracked per transaction below.
  let txWrites = null;
  function pendingWorkspace(workspaceId) {
    if (!txWrites) return null;
    const write = txWrites.find((w) => pathOf(w.path) === pathOf(["workspaces", workspaceId]));
    return write ? write.data : null;
  }

  const api = {
    /** Test control ------------------------------------------------------ */
    setUser(uid) {
      currentUid = uid || null;
    },
    getUser: () => currentUid,
    setOffline(value) {
      offline = Boolean(value);
      if (!offline) {
        const queued = pendingOffline;
        pendingOffline = [];
        for (const run of queued) run();
      }
    },
    failNext(kind, code) {
      failures[kind] = code;
    },
    calls,
    dump: () => Object.fromEntries(docs),
    seed(path, data) {
      docs.set(pathOf(path), { ...data });
    },
    get: (path) => docs.get(pathOf(path)) || null,
    listWorkspaceDocs(workspaceId, collection) {
      const prefix = pathOf(["workspaces", workspaceId, collection]) + "/";
      const out = {};
      for (const [key, value] of docs) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) out[key.slice(prefix.length)] = value;
      }
      return out;
    },

    /** Store interface --------------------------------------------------- */
    timestamp: () => TIMESTAMP,

    async runTransaction(fn) {
      assertAuthenticated();
      take("transaction");
      calls.transactions += 1;
      txWrites = [];
      const tx = {
        async get(path) {
          const data = docs.get(pathOf(path));
          return data ? { exists: true, data: { ...data } } : { exists: false, data: null };
        },
        set(path, data) {
          txWrites.push({ path, data });
        },
      };
      try {
        const result = await fn(tx);
        for (const write of txWrites) authorizeWrite(write.path, write.data, docs.has(pathOf(write.path)));
        const stamp = now();
        for (const write of txWrites) docs.set(pathOf(write.path), resolveTimestamps(write.data, stamp));
        return result;
      } finally {
        txWrites = null;
      }
    },

    async readWorkspace(workspaceId) {
      assertAuthenticated();
      take("read");
      calls.reads += 1;
      if (!isMember(workspaceId, currentUid)) throw firestoreError("permission-denied", "not a member");
      const documents = [];
      const prefix = pathOf(["workspaces", workspaceId]) + "/";
      for (const [key, value] of docs) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length).split("/");
        if (rest.length !== 2) continue;
        const [collection, id] = rest;
        if (["members", "migrations", ASSET_COLLECTION].includes(collection)) continue;
        const chunks = [];
        if (value.chunked === true) {
          for (let i = 0; i < Number(value.chunkCount) || 0; i++) {
            const chunk = docs.get(pathOf(["workspaces", workspaceId, collection, id, "chunks", String(i)]));
            chunks.push(chunk ? chunk.text : undefined);
          }
        }
        documents.push({ collection, id, fields: { ...value }, chunks });
      }
      return { documents };
    },

    commitBatch(workspaceId, ops) {
      const run = () =>
        new Promise((resolve, reject) => {
          try {
            assertAuthenticated();
            take("commit");
            calls.commits.push(ops.map((op) => ({ type: op.type, path: op.path.join("/") })));
            // All-or-nothing: authorize everything first.
            for (const op of ops) {
              const full = ["workspaces", workspaceId, ...op.path];
              if (op.type === "set") authorizeWrite(full, op.fields, docs.has(pathOf(full)));
              else if (!isMember(workspaceId, currentUid)) throw firestoreError("permission-denied", "not a member");
            }
            const stamp = now();
            for (const op of ops) {
              const full = pathOf(["workspaces", workspaceId, ...op.path]);
              if (op.type === "set") docs.set(full, { ...resolveTimestamps(op.fields, stamp), updatedAt: stamp });
              else docs.delete(full);
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      if (offline) {
        return new Promise((resolve, reject) => {
          pendingOffline.push(() => run().then(resolve, reject));
        });
      }
      return run();
    },

    async readAssetIndex(workspaceId) {
      assertAuthenticated();
      take("read");
      calls.reads += 1;
      if (!isMember(workspaceId, currentUid)) throw firestoreError("permission-denied", "not a member");
      const prefix = pathOf(assetCollectionPath(workspaceId)) + "/";
      const assets = [];
      for (const [key, value] of docs) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        if (id.includes("/")) continue;
        assets.push({ id, fields: { ...value } });
      }
      return { assets };
    },

    async readAssetDocument(workspaceId, assetId) {
      assertAuthenticated();
      take("read");
      calls.reads += 1;
      if (!isMember(workspaceId, currentUid)) throw firestoreError("permission-denied", "not a member");
      const value = docs.get(pathOf(assetDocumentPath(workspaceId, assetId)));
      return value ? { exists: true, fields: { ...value } } : { exists: false, fields: null };
    },

    async deleteAssetDocument(workspaceId, assetId) {
      assertAuthenticated();
      take("commit");
      const path = pathOf(assetDocumentPath(workspaceId, assetId));
      calls.commits.push([{ type: "delete", path: `${ASSET_COLLECTION}/${assetId}` }]);
      if (!isMember(workspaceId, currentUid)) throw firestoreError("permission-denied", "not a member");
      const existed = docs.delete(path);
      return { deleted: existed };
    },

    async setDocument(path, data) {
      assertAuthenticated();
      authorizeWrite(path, data, docs.has(pathOf(path)));
      docs.set(pathOf(path), resolveTimestamps(data, now()));
    },

    async close() {},
  };
  return api;
}
