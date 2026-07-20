// src/lib/pdfStorage.js
//
// Dedicated persistence module for the PDF editor, backed by the browser's
// native IndexedDB (no wrapper dependency).
//
// Canonical model (DB v2): PDFs are independent documents, so both stores are
// keyed by a stable PDF `documentId` — NOT by a note id:
//   - "pdfDocBytes":       { documentId, bytes: ArrayBuffer, name, updatedAt }
//   - "pdfDocAnnotations": { documentId, items: Array, updatedAt }
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

const DB_NAME = "notewise-pdf-editor";
const DB_VERSION = 2;

const STORE_BYTES = "pdfDocBytes";
const STORE_ANN = "pdfDocAnnotations";

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

export async function saveAnnotations(documentId, items) {
  const record = makeAnnotationRecord(documentId, items);
  await txRequest(STORE_ANN, "readwrite", (store) => store.put(record));
}

/** Resolves to an array of annotation items (empty when absent). */
export async function loadAnnotations(documentId) {
  if (!documentId) return [];
  const rec = await txRequest(STORE_ANN, "readonly", (store) => store.get(documentId));
  return rec && Array.isArray(rec.items) ? rec.items : [];
}

/** Removes both the stored PDF bytes and annotations for a document. */
export async function removePdfDocumentData(documentId) {
  if (!documentId) return;
  await txRequest(STORE_BYTES, "readwrite", (store) => store.delete(documentId));
  await txRequest(STORE_ANN, "readwrite", (store) => store.delete(documentId));
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
