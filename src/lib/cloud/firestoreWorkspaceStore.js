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
//                                     (a transport seam only — denied by the
//                                     rules and called by nothing in V1)
//   listListenInMeetings(wid, uid)    the CALLER'S Listen In meeting HEADERS
//   readListenInMeeting(wid, sessionId, uid)
//                                     one of the caller's meetings: header +
//                                     transcript pages + summary, with their
//                                     chunks (8D.4)
//   close()
//
// LISTEN IN (Phase 8D.4). `listenInMeetings`, `listenInTranscripts` and
// `listenInSummaries` are ON-DEMAND collections (src/lib/cloud/cloudModel.js
// → ON_DEMAND_ENTITY_COLLECTIONS): `readWorkspace` never fetches them — a
// workspace with hundreds of meetings must not download every transcript at
// sign-in — and the two reads above fetch exactly one meeting, or the
// headers only. Their writes travel through `commitBatch` like every other
// entity. Nothing here carries audio: the collections hold text and state.
//
// EVERY LISTEN IN READ IS CONSTRAINED TO THE CALLER. The rules admit a
// Listen In document only to its `createdBy`, and Firestore admits a LIST
// only when the query itself proves it: both reads below therefore take the
// uid and put `where("createdBy", "==", uid)` in the query. Passing another
// user's uid does not widen anything — the rules would refuse the result.
//
// ASSET METADATA (Production Readiness Phase 7). `workspaces/{wid}/assets/
// {assetId}` is the Firestore record of an asset whose BYTES live in
// Firebase Storage at the same path (src/lib/cloud/firebaseStorageAdapter.js;
// the shared path convention is src/lib/cloud/assetPaths.js). The field
// model is src/lib/cloud/assetCloudModel.js; `firestore.rules` admits the
// collection since Phase 7.3 — members read, create and tombstone / restore
// a document, and NOBODY deletes one (Phase 7.10A: `allow delete: if false`,
// because NoteWise V1 performs no physical cloud-asset deletion). The reads
// are what reconciliation and the reference-driven sweep need; the write is
// the upload processor's and the lifecycle's; `deleteAssetDocument` has no
// caller in the product and is refused by the rules for every caller,
// including the workspace owner. Every
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
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  terminate,
  where,
  writeBatch,
} from "firebase/firestore";
import { ensureFirebaseApp } from "../firebaseApp";
import { CLOUD_COLLECTION, WORKSPACE_COLLECTIONS } from "./cloudModel";
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

  /** The chunk texts of one chunked document, in index order. */
  async function chunksOf(workspaceId, name, id, fields) {
    const chunks = [];
    if (!fields || fields.chunked !== true) return chunks;
    const chunkSnapshot = await getDocs(collectionRef(db, "workspaces", workspaceId, name, id, "chunks"));
    const byIndex = new Map();
    for (const c of chunkSnapshot.docs) {
      const data = c.data();
      byIndex.set(Number(data.index), data.text);
    }
    const count = Number(fields.chunkCount) || 0;
    for (let i = 0; i < count; i++) chunks.push(byIndex.get(i));
    return chunks;
  }

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

    /**
     * Remove one asset metadata document.
     *
     * A TRANSPORT SEAM with no product caller: `firestore.rules` denies this
     * delete to every client (Phase 7.10A), so it can only ever succeed
     * against a future, separately reviewed server-side retention design.
     */
    async deleteAssetDocument(workspaceId, assetId) {
      await deleteDoc(ref(assetDocumentPath(workspaceId, assetId)));
    },

    /** The caller's own Listen In meeting headers in one workspace (8D.4). */
    async listListenInMeetings(workspaceId, uid) {
      const snapshot = await getDocs(
        query(collectionRef(db, "workspaces", workspaceId, CLOUD_COLLECTION.LISTEN_IN_MEETINGS), where("createdBy", "==", uid))
      );
      return { meetings: snapshot.docs.map((d) => ({ id: d.id, fields: d.data() })) };
    },

    /**
     * One of the caller's Listen In meetings (Phase 8D.4): its header, its
     * transcript pages (selected by the hoisted `sessionId` and `createdBy`
     * fields) and its summary, each with its chunks.
     *
     * The page query is two equality filters, which Firestore serves from the
     * automatic single-field indexes — no composite index is needed, and
     * `firestore.indexes.json` stays empty.
     */
    async readListenInMeeting(workspaceId, sessionId, uid) {
      const headerSnapshot = await getDoc(ref(["workspaces", workspaceId, CLOUD_COLLECTION.LISTEN_IN_MEETINGS, sessionId]));
      const meeting = headerSnapshot.exists() ? { id: sessionId, fields: headerSnapshot.data() } : null;
      const pageSnapshot = await getDocs(
        query(
          collectionRef(db, "workspaces", workspaceId, CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS),
          where("sessionId", "==", sessionId),
          where("createdBy", "==", uid)
        )
      );
      const transcripts = [];
      for (const d of pageSnapshot.docs) {
        const fields = d.data();
        transcripts.push({ id: d.id, fields, chunks: await chunksOf(workspaceId, CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, d.id, fields) });
      }
      const summarySnapshot = await getDoc(ref(["workspaces", workspaceId, CLOUD_COLLECTION.LISTEN_IN_SUMMARIES, sessionId]));
      let summary = null;
      if (summarySnapshot.exists()) {
        const fields = summarySnapshot.data();
        summary = { id: sessionId, fields, chunks: await chunksOf(workspaceId, CLOUD_COLLECTION.LISTEN_IN_SUMMARIES, sessionId, fields) };
      }
      return { meeting, transcripts, summary };
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
