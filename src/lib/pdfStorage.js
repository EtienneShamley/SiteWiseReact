// src/lib/pdfStorage.js
//
// Dedicated persistence module for the PDF editor, backed by the browser's
// native IndexedDB (no wrapper dependency).
//
// Canonical model (DB v2, extended additively by v3): PDFs are independent
// documents, so the stores are keyed by stable PDF identities — NOT by a note id:
//   - "pdfDocBytes":       { documentId, bytes: ArrayBuffer, name, updatedAt }
//                          keyed by the document's SOURCE id
//                          (`pdfSourceId(doc)`, src/lib/pdfDocuments.js): one
//                          immutable version of the file. A replaced file is
//                          stored under a NEW source id; the record field is
//                          still named `documentId` (it is the IndexedDB key
//                          path) and equals the document id for documents
//                          created before source ids existed.
//   - "pdfDocAnnotations": { documentId, items: Array, updatedAt }
//                          keyed by the DOCUMENT id — annotations belong to the
//                          document, and are reset when its file is replaced.
//                          Since DB v3 this is the LOCAL (pre-account) and
//                          legacy store: a save that names no workspace still
//                          lands here, exactly as before.
//   - "pdfWorkspaceAnnotations" (DB v3, Production Readiness Phase 7.7):
//                          { workspaceId, documentId, items, updatedAt,
//                            revision, cloudDirty }
//                          keyed by [workspaceId, documentId] — one account's
//                          annotations can never be formed into another's key,
//                          so no read, save or settle can cross workspaces (the
//                          same key discipline as src/lib/assetDb.js). `revision`
//                          counts local saves; `cloudDirty` says the cloud has
//                          not yet accepted THIS revision. Both are written in
//                          the same transaction as the items, so "saved
//                          locally" and "owed to the cloud" can never disagree —
//                          the outbox identity (localStorage) is written after,
//                          and src/lib/pdfAnnotationSync.js repairs a lost one
//                          from these flags.
//
// The v1 database keyed the same data by `noteId` in stores named "pdfBytes"
// and "annotations". Those legacy stores are preserved on upgrade so a one-time
// app-level migration (see src/lib/pdfMigration.js) can move existing data into
// the documentId-keyed stores. The legacy readers/removers below exist only for
// that migration.
//
// PDF bytes never touch localStorage — binary data belongs in IndexedDB.
// All functions return promises and REJECT on failure; callers are expected to
// surface errors visibly, not swallow them.

export const PDF_DB_NAME = "notewise-pdf-editor";
export const PDF_DB_VERSION = 3;
const DB_NAME = PDF_DB_NAME;
const DB_VERSION = PDF_DB_VERSION;

const STORE_BYTES = "pdfDocBytes";
const STORE_ANN = "pdfDocAnnotations";
export const PDF_WORKSPACE_ANNOTATIONS_STORE = "pdfWorkspaceAnnotations";
const STORE_WS_ANN = PDF_WORKSPACE_ANNOTATIONS_STORE;
export const PDF_WORKSPACE_ANNOTATION_KEY_PATH = ["workspaceId", "documentId"];

// v1 stores, kept for migration only.
const LEGACY_BYTES = "pdfBytes";
const LEGACY_ANN = "annotations";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v2 canonical stores, keyed by documentId.
      if (!db.objectStoreNames.contains(STORE_BYTES)) {
        db.createObjectStore(STORE_BYTES, { keyPath: "documentId" });
      }
      if (!db.objectStoreNames.contains(STORE_ANN)) {
        db.createObjectStore(STORE_ANN, { keyPath: "documentId" });
      }
      // v3 (Phase 7.7): workspace-owned annotations beside the v2 stores.
      // Additive only — nothing existing is read, rewritten or dropped.
      if (!db.objectStoreNames.contains(STORE_WS_ANN)) {
        db.createObjectStore(STORE_WS_ANN, { keyPath: PDF_WORKSPACE_ANNOTATION_KEY_PATH });
      }
      // Legacy v1 stores are intentionally NOT created on a fresh install and
      // NOT dropped on upgrade — if present (upgrade from v1) they hold data the
      // migration still needs to read.
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
      reject(req.error || new Error("Failed to open PDF storage database"));
    };
  });
  return dbPromise;
}

function txRequest(storeName, mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(storeName)) {
          // A missing legacy store simply means there is nothing to migrate.
          resolve(undefined);
          return;
        }
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        const req = run(store);
        if (req) {
          req.onsuccess = () => {
            result = req.result;
          };
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error("PDF storage transaction failed"));
        tx.onabort = () => reject(tx.error || new Error("PDF storage transaction aborted"));
      })
  );
}

/**
 * One transaction over several stores whose steps depend on what they read:
 * `run(stores)` issues the requests and returns a function that yields the
 * result once the transaction has COMPLETED (a read-then-write that must be
 * atomic — the revision bump, the settle, the adoption — lives here).
 */
function txRun(storeNames, mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        const stores = {};
        for (const name of storeNames) stores[name] = tx.objectStore(name);
        let finish = null;
        try {
          finish = run(stores);
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // already aborted
          }
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve(typeof finish === "function" ? finish() : undefined);
        tx.onerror = () => reject(tx.error || new Error("PDF storage transaction failed"));
        tx.onabort = () => reject(tx.error || new Error("PDF storage transaction aborted"));
      })
  );
}

/** Every workspace-owned annotation record of ONE workspace, and no other's. */
function workspaceAnnotationKeyRange(workspaceId) {
  return IDBKeyRange.bound([workspaceId], [workspaceId, []], false, true);
}

/** A workspace id usable as a key component: a non-empty string. The
 *  stricter Storage-path rule is the caller's (src/lib/assetUploadQueue.js). */
function isWorkspaceId(value) {
  return typeof value === "string" && value.length > 0;
}

/* ------------------------- pure record builders -------------------------- */
/* Exported separately so record shape and keying are unit-testable without  */
/* a real IndexedDB.                                                         */

export function makePdfRecord(documentId, bytes, name) {
  if (!documentId) throw new Error("A document id is required to store a PDF");
  if (!bytes || typeof bytes.byteLength !== "number" || bytes.byteLength === 0) {
    throw new Error("Cannot store an empty PDF");
  }
  // Store a copied ArrayBuffer: callers may hand the same Uint8Array to
  // pdf.js, which transfers/detaches buffers when using workers.
  const copy =
    bytes instanceof Uint8Array
      ? bytes.slice(0).buffer
      : new Uint8Array(bytes.slice(0)).buffer;
  return { documentId, bytes: copy, name: name || null, updatedAt: Date.now() };
}

export function makeAnnotationRecord(documentId, items) {
  if (!documentId) throw new Error("A document id is required to store annotations");
  const list = Array.isArray(items) ? items : [];
  // JSON round-trip: guarantees the record is structured-cloneable and free
  // of live references (DOM nodes, functions) regardless of caller mistakes.
  return { documentId, items: JSON.parse(JSON.stringify(list)), updatedAt: Date.now() };
}

/**
 * A WORKSPACE-owned annotation record (Phase 7.7). `revision` is the local
 * save count the caller read inside the same transaction; `cloudDirty` is
 * true for a local save (the cloud is owed this revision) and false for a
 * record the cloud itself provided.
 */
export function makeWorkspaceAnnotationRecord(workspaceId, documentId, items, { revision = 1, cloudDirty = true, updatedAt = Date.now() } = {}) {
  if (!isWorkspaceId(workspaceId)) throw new Error("A workspace id is required to store workspace annotations");
  const base = makeAnnotationRecord(documentId, items);
  return {
    workspaceId,
    documentId,
    items: base.items,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    revision: Number.isInteger(revision) && revision > 0 ? revision : 1,
    cloudDirty: cloudDirty !== false,
  };
}

/* ------------------------------ public API ------------------------------- */

export async function savePdfBytes(documentId, bytes, name) {
  const record = makePdfRecord(documentId, bytes, name);
  await txRequest(STORE_BYTES, "readwrite", (store) => store.put(record));
}

/** Resolves to { bytes: Uint8Array, name, updatedAt } or null when absent. */
export async function loadPdfBytes(documentId) {
  if (!documentId) return null;
  const rec = await txRequest(STORE_BYTES, "readonly", (store) => store.get(documentId));
  if (!rec || !rec.bytes) return null;
  return { bytes: new Uint8Array(rec.bytes), name: rec.name || null, updatedAt: rec.updatedAt };
}

/**
 * The byte length of one stored PDF source, or 0 when this browser does not
 * hold it. It exists so a caller that only needs the SIZE — the legacy asset
 * backfill's migration summary (src/lib/assetBackfill.js) — does not have to
 * take the defensive `Uint8Array` copy `loadPdfBytes` owes every reader that
 * hands its bytes to pdf.js.
 */
export async function pdfSourceByteLength(sourceId) {
  if (!sourceId) return 0;
  const rec = await txRequest(STORE_BYTES, "readonly", (store) => store.get(sourceId));
  return rec && rec.bytes && typeof rec.bytes.byteLength === "number" ? rec.bytes.byteLength : 0;
}

/**
 * Saves a document's annotations.
 *
 * Without a workspace: the legacy/local record, exactly as before Phase 7.7.
 * With `workspaceId`: the WORKSPACE record, in one transaction that reads the
 * current revision, bumps it and marks the record cloud-dirty — so the moment
 * this resolves, the annotations are durable AND the fact that the cloud is
 * owed them is durable with them. The workspace is an explicit argument, never
 * the ambient durable scope: a save scheduled under one session must land
 * under that session's workspace even if it runs after a switch.
 *
 * Resolves `{ workspaceId, documentId, revision, updatedAt }` (`revision`
 * null for the legacy record).
 */
export async function saveAnnotations(documentId, items, { workspaceId = null } = {}) {
  if (!isWorkspaceId(workspaceId)) {
    const record = makeAnnotationRecord(documentId, items);
    await txRequest(STORE_ANN, "readwrite", (store) => store.put(record));
    return { workspaceId: null, documentId, revision: null, updatedAt: record.updatedAt };
  }
  if (!documentId) throw new Error("A document id is required to store annotations");
  return txRun([STORE_WS_ANN], "readwrite", (stores) => {
    const store = stores[STORE_WS_ANN];
    const read = store.get([workspaceId, documentId]);
    let written = null;
    read.onsuccess = () => {
      const existing = read.result;
      const revision = (existing && Number.isInteger(existing.revision) ? existing.revision : 0) + 1;
      written = makeWorkspaceAnnotationRecord(workspaceId, documentId, items, { revision, cloudDirty: true });
      store.put(written);
    };
    return () => ({ workspaceId, documentId, revision: written.revision, updatedAt: written.updatedAt });
  });
}

/**
 * Resolves to an array of annotation items (empty when absent). With a
 * workspace, ONLY that workspace's record answers — a legacy record or another
 * workspace's record for the same document id is never returned.
 */
export async function loadAnnotations(documentId, { workspaceId = null } = {}) {
  if (!documentId) return [];
  const rec = await loadAnnotationRecord(documentId, { workspaceId });
  return rec && Array.isArray(rec.items) ? rec.items : [];
}

/** The full stored record (legacy or workspace, per `workspaceId`) or null. */
export async function loadAnnotationRecord(documentId, { workspaceId = null } = {}) {
  if (!documentId) return null;
  if (!isWorkspaceId(workspaceId)) {
    const rec = await txRequest(STORE_ANN, "readonly", (store) => store.get(documentId));
    return rec || null;
  }
  const rec = await txRequest(STORE_WS_ANN, "readonly", (store) => store.get([workspaceId, documentId]));
  return rec || null;
}

/** Removes the stored bytes of ONE source id (a document's current file, or a
 *  superseded one). Resolves when the transaction has completed. */
export async function removePdfBytes(sourceId) {
  if (!sourceId) return;
  await txRequest(STORE_BYTES, "readwrite", (store) => store.delete(sourceId));
}

/** Removes a document's stored annotations (the legacy record, or with a
 *  workspace, that workspace's record only). */
export async function removeAnnotations(documentId, { workspaceId = null } = {}) {
  if (!documentId) return;
  if (!isWorkspaceId(workspaceId)) {
    await txRequest(STORE_ANN, "readwrite", (store) => store.delete(documentId));
    return;
  }
  await txRequest(STORE_WS_ANN, "readwrite", (store) => store.delete([workspaceId, documentId]));
}

/* ------------------- workspace annotation sync state (7.7) --------------- */
/* The cloud-facing half of the workspace records. Every operation names its  */
/* workspace; none can read or write another's rows (the key forbids it).     */

/** Every annotation record ONE workspace holds: [{ workspaceId, documentId,
 *  items, updatedAt, revision, cloudDirty }]. */
export async function listWorkspaceAnnotationRecords(workspaceId) {
  if (!isWorkspaceId(workspaceId)) return [];
  const rows = await txRequest(STORE_WS_ANN, "readonly", (store) => store.getAll(workspaceAnnotationKeyRange(workspaceId)));
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.workspaceId === workspaceId && r.documentId);
}

/**
 * The cloud ACCEPTED `revision`: clears the dirty flag — but only if the
 * record still carries exactly that revision. A save that landed while the
 * upload was in flight has a higher revision and stays dirty; its own outbox
 * entry will send it. Resolves `{ settled, revision }` with the record's
 * current revision (null when it is gone).
 */
export async function settleWorkspaceAnnotations(workspaceId, documentId, revision) {
  if (!isWorkspaceId(workspaceId) || !documentId) return { settled: false, revision: null };
  return txRun([STORE_WS_ANN], "readwrite", (stores) => {
    const store = stores[STORE_WS_ANN];
    const read = store.get([workspaceId, documentId]);
    let outcome = { settled: false, revision: null };
    read.onsuccess = () => {
      const existing = read.result;
      if (!existing) return;
      outcome = { settled: false, revision: existing.revision };
      if (existing.revision !== revision || existing.cloudDirty === false) return;
      store.put({ ...existing, cloudDirty: false });
      outcome = { settled: true, revision: existing.revision };
    };
    return () => outcome;
  });
}

/**
 * The cloud's copy arrives (hydration). It is written CLEAN — unless the
 * workspace record is dirty, in which case the local edits win and nothing
 * is written: an unsynced change is never undone by an older cloud copy.
 * Resolves `{ applied, reason }`.
 */
export async function hydrateWorkspaceAnnotations(workspaceId, documentId, items) {
  if (!isWorkspaceId(workspaceId) || !documentId) return { applied: false, reason: "invalid" };
  return txRun([STORE_WS_ANN], "readwrite", (stores) => {
    const store = stores[STORE_WS_ANN];
    const read = store.get([workspaceId, documentId]);
    let outcome = { applied: false, reason: "unknown" };
    read.onsuccess = () => {
      const existing = read.result;
      if (existing && existing.cloudDirty !== false) {
        outcome = { applied: false, reason: "dirty" };
        return;
      }
      const revision = existing && Number.isInteger(existing.revision) ? existing.revision : 0;
      store.put(makeWorkspaceAnnotationRecord(workspaceId, documentId, items, { revision: Math.max(1, revision), cloudDirty: false }));
      outcome = { applied: true, reason: existing ? "refreshed" : "created" };
    };
    return () => outcome;
  });
}

/** The document ids that still have a LEGACY (unscoped) annotation record. */
export async function listLegacyAnnotationIds() {
  const keys = await txRequest(STORE_ANN, "readonly", (store) => store.getAllKeys());
  return (Array.isArray(keys) ? keys : []).filter((k) => typeof k === "string" && k);
}

/**
 * MOVES a legacy annotation record under a workspace, in one transaction over
 * both stores: the workspace record is created dirty (the cloud has never
 * seen it) and the legacy record is deleted — one copy, never two. Refused,
 * writing nothing, when there is no legacy record or the workspace already
 * owns one for this document (that record is the live one; the legacy copy is
 * left where it is rather than destroyed). Whether the caller MAY adopt is
 * decided before calling (src/lib/pdfAnnotationSync.js).
 * Resolves `{ adopted, reason }`.
 */
export async function adoptLegacyAnnotations(documentId, workspaceId) {
  if (!isWorkspaceId(workspaceId) || !documentId) return { adopted: false, reason: "invalid" };
  return txRun([STORE_ANN, STORE_WS_ANN], "readwrite", (stores) => {
    const legacy = stores[STORE_ANN];
    const owned = stores[STORE_WS_ANN];
    let outcome = { adopted: false, reason: "missing" };
    const readLegacy = legacy.get(documentId);
    readLegacy.onsuccess = () => {
      const record = readLegacy.result;
      if (!record) return;
      const readOwned = owned.get([workspaceId, documentId]);
      readOwned.onsuccess = () => {
        if (readOwned.result) {
          outcome = { adopted: false, reason: "already-owned" };
          return;
        }
        owned.put(
          makeWorkspaceAnnotationRecord(workspaceId, documentId, record.items, {
            revision: 1,
            cloudDirty: true,
            updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
          })
        );
        legacy.delete(documentId);
        outcome = { adopted: true, reason: null };
      };
    };
    return () => outcome;
  });
}

/** Removes both the stored PDF bytes and annotations of a document whose
 *  bytes are keyed by its own id (a pre-source-id document). Documents with
 *  a distinct source id remove the two records separately — see
 *  AppStateContext.deletePdf. */
export async function removePdfDocumentData(documentId) {
  if (!documentId) return;
  await removePdfBytes(documentId);
  await removeAnnotations(documentId);
}

/** Test-only: forget the cached connection so the next call reopens. */
export function __resetPdfStorageConnectionForTests() {
  if (dbPromise) {
    dbPromise.then((db) => db.close()).catch(() => {});
  }
  dbPromise = null;
}

/* --------------------------- legacy (v1) migration ----------------------- */
/* These read the note-keyed v1 stores so the one-time migration can move the  */
/* data into the documentId-keyed stores above. Not used by normal flows.      */

/** Returns all legacy note-keyed PDF byte records: [{ noteId, bytes, name }]. */
export async function listLegacyPdfRecords() {
  const rows = await txRequest(LEGACY_BYTES, "readonly", (store) => store.getAll());
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && r.noteId && r.bytes)
    .map((r) => ({
      noteId: r.noteId,
      bytes: new Uint8Array(r.bytes),
      name: r.name || null,
      updatedAt: r.updatedAt || Date.now(),
    }));
}

/** Returns legacy annotation items for a note id (empty when absent). */
export async function loadLegacyAnnotations(noteId) {
  if (!noteId) return [];
  const rec = await txRequest(LEGACY_ANN, "readonly", (store) => store.get(noteId));
  return rec && Array.isArray(rec.items) ? rec.items : [];
}

/** Removes a note's legacy byte + annotation records after it has been moved. */
export async function removeLegacyNoteRecord(noteId) {
  if (!noteId) return;
  await txRequest(LEGACY_BYTES, "readwrite", (store) => store.delete(noteId));
  await txRequest(LEGACY_ANN, "readwrite", (store) => store.delete(noteId));
}
