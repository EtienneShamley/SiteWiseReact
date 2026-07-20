// src/lib/pdfStorage.js
//
// Dedicated persistence module for the PDF editor, backed by the browser's
// native IndexedDB (no wrapper dependency). Two object stores, both keyed by
// note id:
//   - "pdfBytes":    { noteId, bytes: ArrayBuffer, name, updatedAt }
//   - "annotations": { noteId, items: Array, updatedAt }
//
// PDF bytes never touch localStorage — binary data belongs in IndexedDB.
// All functions return promises and REJECT on failure; callers are expected
// to surface errors visibly, not swallow them.

const DB_NAME = "notewise-pdf-editor";
const DB_VERSION = 1;
const STORE_PDF = "pdfBytes";
const STORE_ANN = "annotations";

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
      if (!db.objectStoreNames.contains(STORE_PDF)) {
        db.createObjectStore(STORE_PDF, { keyPath: "noteId" });
      }
      if (!db.objectStoreNames.contains(STORE_ANN)) {
        db.createObjectStore(STORE_ANN, { keyPath: "noteId" });
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
      reject(req.error || new Error("Failed to open PDF storage database"));
    };
  });
  return dbPromise;
}

function txRequest(storeName, mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
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

export function makePdfRecord(noteId, bytes, name) {
  if (!noteId) throw new Error("A note id is required to store a PDF");
  if (!bytes || typeof bytes.byteLength !== "number" || bytes.byteLength === 0) {
    throw new Error("Cannot store an empty PDF");
  }
  // Store a copied ArrayBuffer: callers may hand the same Uint8Array to
  // pdf.js, which transfers/detaches buffers when using workers.
  const copy =
    bytes instanceof Uint8Array
      ? bytes.slice(0).buffer
      : new Uint8Array(bytes.slice(0)).buffer;
  return { noteId, bytes: copy, name: name || null, updatedAt: Date.now() };
}

export function makeAnnotationRecord(noteId, items) {
  if (!noteId) throw new Error("A note id is required to store annotations");
  const list = Array.isArray(items) ? items : [];
  // JSON round-trip: guarantees the record is structured-cloneable and free
  // of live references (DOM nodes, functions) regardless of caller mistakes.
  return { noteId, items: JSON.parse(JSON.stringify(list)), updatedAt: Date.now() };
}

/* ------------------------------ public API ------------------------------- */

export async function savePdfBytes(noteId, bytes, name) {
  const record = makePdfRecord(noteId, bytes, name);
  await txRequest(STORE_PDF, "readwrite", (store) => store.put(record));
}

/** Resolves to { bytes: Uint8Array, name, updatedAt } or null when absent. */
export async function loadPdfBytes(noteId) {
  if (!noteId) return null;
  const rec = await txRequest(STORE_PDF, "readonly", (store) => store.get(noteId));
  if (!rec || !rec.bytes) return null;
  return { bytes: new Uint8Array(rec.bytes), name: rec.name || null, updatedAt: rec.updatedAt };
}

export async function saveAnnotations(noteId, items) {
  const record = makeAnnotationRecord(noteId, items);
  await txRequest(STORE_ANN, "readwrite", (store) => store.put(record));
}

/** Resolves to an array of annotation items (empty when absent). */
export async function loadAnnotations(noteId) {
  if (!noteId) return [];
  const rec = await txRequest(STORE_ANN, "readonly", (store) => store.get(noteId));
  return rec && Array.isArray(rec.items) ? rec.items : [];
}

/** Removes both the stored PDF bytes and annotations for a note. */
export async function removeNotePdfData(noteId) {
  if (!noteId) return;
  await txRequest(STORE_PDF, "readwrite", (store) => store.delete(noteId));
  await txRequest(STORE_ANN, "readwrite", (store) => store.delete(noteId));
}
