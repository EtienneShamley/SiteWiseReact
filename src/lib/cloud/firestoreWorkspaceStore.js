// src/lib/cloud/firestoreWorkspaceStore.js
//
// The ONLY module in the application that imports `firebase/firestore`.
//
// It is the Firestore implementation of the workspace-store interface the
// cloud layer is written against (the in-memory twin is
// src/lib/cloud/memoryWorkspaceStore.js):
//
//   timestamp()                       a server-timestamp sentinel
//   runTransaction(fn)                fn({ get(path), set(path, data) })
//   readWorkspace(workspaceId)        every entity document + its chunks
//                                     (the mirror collections AND pdfAnnotations,
//                                     whose local copy is IndexedDB — Phase 7.7)
//   commitBatch(workspaceId, ops)     [{ type: "set"|"delete", path, fields }]
//   setDocument(path, data)
//   readAssetIndex(workspaceId)       every asset metadata document
//   readAssetDocument(wid, assetId)   one asset metadata document
//   writeAssetDocument(wid, assetId, fields)  create / rewrite one (server-stamped)
//   deleteAssetDocument(wid, assetId) remove one asset metadata document
//   close()
//
// ASSET METADATA (Production Readiness Phase 7). `workspaces/{wid}/assets/
// {assetId}` is the Firestore record of an asset whose BYTES live in
// Firebase Storage at the same path (src/lib/cloud/firebaseStorageAdapter.js;
// the shared path convention is src/lib/cloud/assetPaths.js). The field
// model is src/lib/cloud/assetCloudModel.js; `firestore.rules` admits the
// collection since Phase 7.3 — members read, create and tombstone / restore
// a document, and ONLY the workspace owner deletes one. The reads are what a
// later phase's reconciliation and the reference-driven sweep need; the
// write is the upload processor's and the lifecycle's; the delete is the
// sweep's, and it is refused by the rules for anybody but the owner. Every
// write here adds `updatedAt: serverTimestamp()` because the rules require
// it, and a tombstone's `tombstonedAt` must be `timestamp()` too (the rules
// refuse a client clock). `readWorkspace` does NOT include the collection —
// it is not part of the workspace mirror the owner modules read.
//
// CACHE DECISION (Production Readiness Phase 6). The SDK's persistent
// IndexedDB cache is deliberately NOT enabled: NoteWise keeps its own
// per-workspace mirror and outbox in the durable-storage boundary, which the
// synchronous owner modules read, which is namespaced by workspace so one
// account's data is never served to another on a shared browser, and which
// queues offline writes explicitly. The SDK runs with the memory cache, and
// `terminate()` on close drops anything it still holds for the session.
//
// Batches add `updatedAt: serverTimestamp()` to every set — the Security
// Rules require it — and paths are always rooted under the workspace so a
// caller cannot address another workspace by mistake.

import {
  collection as collectionRef,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  memoryLocalCache,
  runTransaction,
  serverTimestamp,
  setDoc,
  terminate,
  writeBatch,
} from "firebase/firestore";
import { ensureFirebaseApp } from "../firebaseApp";
import { WORKSPACE_COLLECTIONS } from "./cloudModel";
import { assetCollectionPath, assetDocumentPath } from "./assetPaths";

/**
 * @param {{ apiKey: string, authDomain: string, projectId: string, appId: string, firestoreEmulatorHost: string|null }} config
 */
export function createFirestoreWorkspaceStore(config) {
  const app = ensureFirebaseApp(config);
  const db = initializeFirestore(app, { localCache: memoryLocalCache() });
  if (config.firestoreEmulatorHost) {
    const [host, port] = String(config.firestoreEmulatorHost).split(":");
    connectFirestoreEmulator(db, host, Number(port) || 8080);
  }

  const ref = (path) => doc(db, ...path);

  return Object.freeze({
    timestamp: () => serverTimestamp(),

    runTransaction(fn) {
      return runTransaction(db, async (tx) => {
        const api = {
          async get(path) {
            const snapshot = await tx.get(ref(path));
            return snapshot.exists() ? { exists: true, data: snapshot.data() } : { exists: false, data: null };
          },
          set(path, data) {
            tx.set(ref(path), data);
          },
        };
        return fn(api);
      });
    },

    async readWorkspace(workspaceId) {
      const documents = [];
      for (const name of WORKSPACE_COLLECTIONS) {
        const snapshot = await getDocs(collectionRef(db, "workspaces", workspaceId, name));
        for (const d of snapshot.docs) {
          const fields = d.data();
          const chunks = [];
          if (fields && fields.chunked === true) {
            const chunkSnapshot = await getDocs(collectionRef(db, "workspaces", workspaceId, name, d.id, "chunks"));
            const byIndex = new Map();
            for (const c of chunkSnapshot.docs) {
              const data = c.data();
              byIndex.set(Number(data.index), data.text);
            }
            const count = Number(fields.chunkCount) || 0;
            for (let i = 0; i < count; i++) chunks.push(byIndex.get(i));
          }
          documents.push({ collection: name, id: d.id, fields, chunks });
        }
      }
      return { documents };
    },

    async commitBatch(workspaceId, ops) {
      const batch = writeBatch(db);
      for (const op of ops) {
        const target = ref(["workspaces", workspaceId, ...op.path]);
        if (op.type === "set") batch.set(target, { ...op.fields, updatedAt: serverTimestamp() });
        else batch.delete(target);
      }
      await batch.commit();
    },

    async setDocument(path, data) {
      await setDoc(ref(path), data);
    },

    /** Every asset metadata document of one workspace. */
    async readAssetIndex(workspaceId) {
      const snapshot = await getDocs(collectionRef(db, ...assetCollectionPath(workspaceId)));
      return { assets: snapshot.docs.map((d) => ({ id: d.id, fields: d.data() })) };
    },

    /** One asset metadata document. */
    async readAssetDocument(workspaceId, assetId) {
      const snapshot = await getDoc(ref(assetDocumentPath(workspaceId, assetId)));
      return snapshot.exists() ? { exists: true, fields: snapshot.data() } : { exists: false, fields: null };
    },

    /** Create or rewrite one asset metadata document, server-stamped. */
    async writeAssetDocument(workspaceId, assetId, fields) {
      await setDoc(ref(assetDocumentPath(workspaceId, assetId)), { ...fields, updatedAt: serverTimestamp() });
    },

    /** Remove one asset metadata document (the sweep's own write; owner-only by the rules). */
    async deleteAssetDocument(workspaceId, assetId) {
      await deleteDoc(ref(assetDocumentPath(workspaceId, assetId)));
    },

    async close() {
      try {
        await terminate(db);
      } catch {
        // already terminated
      }
    },
  });
}
