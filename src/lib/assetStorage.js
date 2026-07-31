// src/lib/assetStorage.js
//
// Reusable, native-IndexedDB asset storage for NoteWise template assets.
// This is the storage foundation the template logo uses today and that future
// photo / file / signature fields are intended to reuse — it stores the
// ORIGINAL Blob/File, never base64, and never places binary data in
// localStorage.
//
// The design deliberately mirrors src/lib/pdfStorage.js: native IndexedDB (no
// wrapper dependency), a versioned database + store, promise-based helpers that
// REJECT on open/read/write failure so callers can surface errors visibly, and
// pure record/validation helpers exported separately so they are unit-testable
// without a real IndexedDB (jsdom has none).

import { newId } from "./id";

const DB_NAME = "notewise-assets";
const DB_VERSION = 1;
const STORE = "assets";

// Logo upload constraints. SVG is intentionally excluded.
export const ALLOWED_LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB

// Note Photo-field constraints (evidence photos on a completed note).
export const ALLOWED_PHOTO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB

// Note File-field constraints. MIME types vary by OS/browser for Office and CSV
// files, so validation accepts a file when EITHER its MIME type or its
// extension is on the allowlist (see validateNoteFile).
export const ALLOWED_NOTE_FILE_MIME_TYPES = [
  "application/pdf",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel", // .xls (also reported for .csv on some systems)
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/csv",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
];
export const ALLOWED_NOTE_FILE_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".csv",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
];
export const MAX_NOTE_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

// Asset kinds for note-field evidence (photo/file attachments referenced from
// a NoteTemplateInstance — see src/lib/noteAttachments.js).
export const ASSET_KIND_NOTE_PHOTO = "note-photo";
export const ASSET_KIND_NOTE_FILE = "note-file";

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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
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

function txRequest(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        const req = run(store);
        if (req) {
          req.onsuccess = () => {
            result = req.result;
          };
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error("Asset storage transaction failed"));
        tx.onabort = () => reject(tx.error || new Error("Asset storage transaction aborted"));
      })
  );
}

/* ------------------------- pure, testable helpers ------------------------ */

// Builds an asset record. Pure (no IndexedDB) so its shape and id handling are
// unit-testable. `id` must be supplied by the caller: user uploads pass a fresh
// newId() (see createLogoAsset); the legacy migration passes a DETERMINISTIC id
// derived from the TemplateVersion so a retry can never create a duplicate
// asset.
export function makeAssetRecord({ id, kind, name, blob, metadata }) {
  if (!id) throw new Error("An asset id is required");
  if (!blob || typeof blob.size !== "number") {
    throw new Error("A Blob is required to store an asset");
  }
  if (blob.size === 0) throw new Error("Cannot store an empty asset");
  const now = Date.now();
  return {
    id,
    kind: kind || "asset",
    name: name || null,
    mimeType: blob.type || null,
    size: blob.size,
    blob,
    createdAt: now,
    updatedAt: now,
    metadata: metadata || {},
  };
}

// Validates a candidate logo File/Blob against the allowed types and size.
// Returns { ok: true } or { ok: false, error } — never throws — so the builder
// can show a clear message and preserve the previous logo.
export function validateLogoFile(file) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file was selected." };
  }
  if (file.size === 0) {
    return { ok: false, error: "That file is empty or unreadable." };
  }
  if (!ALLOWED_LOGO_MIME_TYPES.includes(file.type)) {
    return {
      ok: false,
      error: "Unsupported image type. Use a PNG, JPEG or WebP file.",
    };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return { ok: false, error: "That image is larger than the 5 MB limit." };
  }
  return { ok: true };
}

// Validates a candidate note-Photo File/Blob. Same contract as
// validateLogoFile: returns { ok: true } or { ok: false, error }, never throws.
export function validatePhotoFile(file) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file was selected." };
  }
  if (file.size === 0) {
    return { ok: false, error: "That file is empty or unreadable." };
  }
  if (!ALLOWED_PHOTO_MIME_TYPES.includes(file.type)) {
    return {
      ok: false,
      error: "Unsupported photo type. Use a PNG, JPEG or WebP image.",
    };
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: "That photo is larger than the 15 MB limit." };
  }
  return { ok: true };
}

// Extracts a lowercase ".ext" from a filename, or "" when there is none.
export function fileExtension(name) {
  if (typeof name !== "string") return "";
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx).toLowerCase();
}

// Validates a candidate note-File attachment. A file passes when its MIME type
// OR its extension is allowlisted — Office/CSV MIME types are inconsistent
// across platforms, so extension is an accepted fallback signal; anything
// matching neither is rejected.
export function validateNoteFile(file) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file was selected." };
  }
  if (file.size === 0) {
    return { ok: false, error: "That file is empty or unreadable." };
  }
  const mimeOk = ALLOWED_NOTE_FILE_MIME_TYPES.includes(file.type);
  const extOk = ALLOWED_NOTE_FILE_EXTENSIONS.includes(fileExtension(file.name));
  if (!mimeOk && !extOk) {
    return {
      ok: false,
      error:
        "Unsupported file type. Use PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, PNG, JPEG or WebP.",
    };
  }
  if (file.size > MAX_NOTE_FILE_BYTES) {
    return { ok: false, error: "That file is larger than the 20 MB limit." };
  }
  return { ok: true };
}

// Converts a data: URL (e.g. a legacy base64 logoSrc) into a Blob without
// fetch(). Returns null for anything that is not a valid, non-empty data URL,
// so the migration can safely skip non-migratable values.
export function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = !!match[2];
  const data = match[3] || "";
  try {
    let bytes;
    if (isBase64) {
      const binary = atob(data);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      const decoded = decodeURIComponent(data);
      bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    }
    if (bytes.length === 0) return null;
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

// True only for a valid, non-empty data:image/* URL — the exact class of legacy
// logo the migration should convert.
export function isMigratableLogoSrc(logoSrc) {
  return (
    typeof logoSrc === "string" &&
    /^data:image\//i.test(logoSrc) &&
    dataUrlToBlob(logoSrc) !== null
  );
}

/* ------------------------------ public API ------------------------------ */

export async function saveAsset(record) {
  if (!record || !record.id) throw new Error("Cannot save an asset without an id");
  await txRequest("readwrite", (store) => store.put(record));
  return record.id;
}

/** Resolves to the asset record ({ id, kind, ..., blob }) or null when absent. */
export async function getAsset(id) {
  if (!id) return null;
  const rec = await txRequest("readonly", (store) => store.get(id));
  return rec || null;
}

export async function deleteAsset(id) {
  if (!id) return;
  await txRequest("readwrite", (store) => store.delete(id));
}

export async function assetExists(id) {
  if (!id) return false;
  const count = await txRequest("readonly", (store) => store.count(id));
  return (count || 0) > 0;
}

// Creates and persists a NEW user-uploaded logo asset. Validates first; on
// invalid input it throws with a user-facing message and creates NO record, so
// the caller can preserve the previous logo. User uploads get a fresh UUID id.
export async function createLogoAsset(file) {
  const check = validateLogoFile(file);
  if (!check.ok) throw new Error(check.error);
  const record = makeAssetRecord({
    id: newId(),
    kind: "logo",
    name: file.name || null,
    blob: file,
  });
  await saveAsset(record);
  return record.id;
}

// Creates and persists a NEW note-Photo asset (validation is the caller's
// responsibility via validatePhotoFile so per-file errors can be collected for
// multi-select uploads). Resolves to the new asset id after the IndexedDB
// transaction completes — a resolved promise IS the write confirmation.
export async function createPhotoAsset(file, metadata) {
  const record = makeAssetRecord({
    id: newId(),
    kind: ASSET_KIND_NOTE_PHOTO,
    name: file.name || null,
    blob: file,
    metadata,
  });
  await saveAsset(record);
  return record.id;
}

// Creates and persists a NEW note-File asset. Same contract as createPhotoAsset.
export async function createNoteFileAsset(file, metadata) {
  const record = makeAssetRecord({
    id: newId(),
    kind: ASSET_KIND_NOTE_FILE,
    name: file.name || null,
    blob: file,
    metadata,
  });
  await saveAsset(record);
  return record.id;
}
