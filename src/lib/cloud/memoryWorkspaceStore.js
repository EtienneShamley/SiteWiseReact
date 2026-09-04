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
// `readAssetDocument`, `writeAssetDocument` and `deleteAssetDocument` mirror
// the Firestore store's operations over `workspaces/{wid}/assets/{assetId}`
// and enforce what `firestore.rules` enforces there since Phase 7.3 (the
// field model is src/lib/cloud/assetCloudModel.js):
//   - reads and writes need membership, like every other workspace access;
//   - a written document must validate against its path identity, be
//     created `stored` without a tombstone, and on a rewrite change nothing
//     but state / tombstonedAt / updatedAt — stored → tombstoned only with
//     the store's own timestamp, tombstoned → stored dropping it, and a
//     standing tombstone keeping its clock;
//   - DELETION is the workspace OWNER's alone (workspaces/{wid}.ownerUid):
//     an ordinary member's delete is refused here exactly as the real rule
//     refuses it, so no test can rely on a delete the service would deny.
// They take the existing `read` / `commit` failure kinds. `readWorkspace`
// excludes the collection: asset metadata is not part of the workspace
// mirror the owner modules read, exactly as in the Firestore store.

import { MEMBER_ROLE } from "./workspaceBootstrap";
import { ASSET_COLLECTION, assetCollectionPath, assetDocumentPath } from "./assetPaths";
import { CLOUD_ASSET_STATE, validateAssetDocument, validateAssetTransition } from "./assetCloudModel";

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

  // The one enforceable owner: workspaces/{wid}.ownerUid (firestore.rules
  // `isOwner`). A membership document's role is never consulted for this.
  function isOwner(workspaceId, uid) {
    const workspace = docs.get(pathOf(["workspaces", workspaceId]));
    return Boolean(workspace) && workspace.ownerUid === uid;
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
    if (b === ASSET_COLLECTION && path.length === 4) authorizeAssetWrite(workspaceId, c, data, exists);
  }

  // The asset-document rules of firestore.rules (`match /assets/{assetId}`),
  // evaluated on the data as it will be STORED (timestamps resolved), plus the
  // one check that needs the raw write: a fresh tombstone must carry the
  // store's timestamp, never a client value.
  function authorizeAssetWrite(workspaceId, assetId, data, exists) {
    if (!data) throw firestoreError("permission-denied", "assets: delete is not a set");
    const resolved = resolveTimestamps(data, now());
    const check = validateAssetDocument({ workspaceId, id: assetId, fields: resolved });
    if (!check.ok) throw firestoreError("permission-denied", `assets: ${check.reason}`);
    if (!exists) {
      if (resolved.state !== CLOUD_ASSET_STATE.STORED || "tombstonedAt" in resolved) {
        throw firestoreError("permission-denied", "assets: create must be stored without a tombstone");
      }
      return;
    }
    const previous = docs.get(pathOf(assetDocumentPath(workspaceId, assetId)));
    const transition = validateAssetTransition(previous, resolved);
    if (!transition.ok) throw firestoreError("permission-denied", `assets: ${transition.reason}`);
    const tombstoning =
      resolved.state === CLOUD_ASSET_STATE.TOMBSTONED && previous.state !== CLOUD_ASSET_STATE.TOMBSTONED;
    if (tombstoning && data.tombstonedAt !== TIMESTAMP) {
      throw firestoreError("permission-denied", "assets: tombstonedAt must be the server timestamp");
    }
  }

  // A delete in the assets collection is the owner's alone; every other
  // entity delete is a member's.
  function authorizeDelete(workspaceId, relativePath) {
    if (!isMember(workspaceId, currentUid)) throw firestoreError("permission-denied", "not a member");
    if (relativePath[0] === ASSET_COLLECTION && relativePath.length === 2 && !isOwner(workspaceId, currentUid)) {
      throw firestoreError("permission-denied", "assets: delete is owner-only");
    }
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
              else authorizeDelete(workspaceId, op.path);
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

    async writeAssetDocument(workspaceId, assetId, fields) {
      assertAuthenticated();
      take("commit");
      const full = assetDocumentPath(workspaceId, assetId);
      calls.commits.push([{ type: "set", path: `${ASSET_COLLECTION}/${assetId}` }]);
      authorizeWrite(full, fields, docs.has(pathOf(full)));
      const stamp = now();
      docs.set(pathOf(full), { ...resolveTimestamps(fields, stamp), updatedAt: stamp });
    },

    async deleteAssetDocument(workspaceId, assetId) {
      assertAuthenticated();
      take("commit");
      const path = pathOf(assetDocumentPath(workspaceId, assetId));
      calls.commits.push([{ type: "delete", path: `${ASSET_COLLECTION}/${assetId}` }]);
      authorizeDelete(workspaceId, [ASSET_COLLECTION, assetId]);
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
