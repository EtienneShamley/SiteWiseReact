// src/lib/cloud/memoryAssetStore.js
//
// An in-memory ASSET STORE with the exact interface of
// src/lib/cloud/firebaseStorageAdapter.js — the double every test uses, so
// `firebase/storage` is never loaded under Jest.
//
// What it reproduces faithfully:
//   - the ONE path convention (src/lib/cloud/assetPaths.js), so an object
//     written for one workspace is invisible to every other workspace and an
//     invalid id is refused here exactly as it is there;
//   - create-only objects: an upload onto an existing path is refused with
//     `storage/unauthorized`, the refusal the immutable-object rule produces,
//     so an upload queue that retries a completed upload has to treat "it is
//     already there" as success rather than overwriting bytes;
//   - `deleteAsset` reporting `{ deleted: false }` for an object that is
//     already gone;
//   - the content-type rule: the caller's explicit type or the Blob's own,
//     never a filename.
//
// What it deliberately does NOT reproduce: the Storage Security Rules. They
// are deny-all in Phase 7.1 and are tested against the real emulator
// (test/rules/storage.rules.test.js); the membership-based rules arrive in
// Phase 7.3, and this double will enforce their equivalent then — the way
// src/lib/cloud/memoryWorkspaceStore.js enforces the Firestore rules today.
// Until then a test that needs a refusal injects one with `failNext`.
//
// Failure injection: `failNext(operation, code)` makes the next
// exists/upload/download/delete reject with a Storage-shaped `{ code }`
// error. Test controls (`seed`, `dump`, `list`, `calls`) are not part of the
// production interface.

import { ASSET_STORAGE_ERROR, assetObjectPath, assetPrefix, assetStorageError } from "./assetPaths";

const OPERATIONS = ["exists", "upload", "download", "delete"];

async function toBytes(data) {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (data && typeof data.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer());
  if (typeof FileReader !== "undefined" && typeof Blob !== "undefined" && data instanceof Blob) {
    const buffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read the asset"));
      reader.readAsArrayBuffer(data);
    });
    return new Uint8Array(buffer);
  }
  throw assetStorageError(ASSET_STORAGE_ERROR.INVALID_ARGUMENT, "Unsupported asset payload");
}

function contentTypeOf(data, contentType) {
  const explicit = typeof contentType === "string" ? contentType.trim() : "";
  if (explicit) return explicit;
  return data && typeof data.type === "string" ? data.type.trim() : "";
}

/**
 * @param {{ bucket?: string, now?: () => number }} [options]
 */
export function createMemoryAssetStore({ bucket = "memory-bucket", now = () => Date.now() } = {}) {
  // canonical object path → { bytes, size, contentType, metadata, createdAt }
  const objects = new Map();
  const failures = { exists: null, upload: null, download: null, delete: null };
  const calls = { exists: 0, uploads: [], downloads: [], deletes: [] };

  function take(operation) {
    const failure = failures[operation];
    failures[operation] = null;
    if (failure) throw assetStorageError(failure);
  }

  const objectPath = (workspaceId, assetId) => assetObjectPath(workspaceId, assetId);

  const api = {
    /** Test control ------------------------------------------------------ */
    failNext(operation, code) {
      if (!OPERATIONS.includes(operation)) throw new Error(`Unknown asset-store operation: ${operation}`);
      failures[operation] = code || ASSET_STORAGE_ERROR.UNKNOWN;
    },
    calls,
    /** Every stored object, as `path → { size, contentType, metadata }`. */
    dump() {
      const out = {};
      for (const [path, record] of objects) {
        out[path] = { size: record.size, contentType: record.contentType, metadata: { ...record.metadata } };
      }
      return out;
    },
    /** The asset ids stored for ONE workspace (a test assertion, not an API). */
    list(workspaceId) {
      const prefix = `${assetPrefix(workspaceId)}/`;
      const ids = [];
      for (const path of objects.keys()) {
        if (path.startsWith(prefix)) ids.push(path.slice(prefix.length));
      }
      return ids.sort();
    },
    /** Place an object without going through the upload rules. */
    async seed(workspaceId, assetId, data, { contentType = "application/octet-stream", metadata = {} } = {}) {
      const path = objectPath(workspaceId, assetId);
      const bytes = await toBytes(data);
      objects.set(path, {
        bytes,
        size: typeof data.size === "number" ? data.size : bytes.length,
        contentType,
        metadata: { ...metadata },
        createdAt: now(),
      });
      return path;
    },

    /** Store interface --------------------------------------------------- */
    bucket,
    objectPath,

    async objectExists(workspaceId, assetId) {
      const path = objectPath(workspaceId, assetId);
      take("exists");
      calls.exists += 1;
      return objects.has(path);
    },

    async uploadAsset(workspaceId, assetId, data, options = {}) {
      const path = objectPath(workspaceId, assetId);
      take("upload");
      if (!data || (typeof data.size === "number" && data.size === 0)) {
        throw assetStorageError(ASSET_STORAGE_ERROR.INVALID_ARGUMENT, "An asset needs bytes to upload");
      }
      const contentType = contentTypeOf(data, options.contentType);
      if (!contentType) {
        throw assetStorageError(ASSET_STORAGE_ERROR.INVALID_ARGUMENT, "An asset upload needs a content type");
      }
      if (objects.has(path)) {
        // The create-only rule's refusal: an object is never rewritten.
        throw assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED, "An asset object is immutable once written");
      }
      const bytes = await toBytes(data);
      const size = typeof data.size === "number" ? data.size : bytes.length;
      objects.set(path, {
        bytes,
        size,
        contentType,
        metadata: { ...(options.metadata || {}) },
        createdAt: now(),
      });
      calls.uploads.push({ path, size, contentType });
      return { path, size, contentType };
    },

    async downloadAsset(workspaceId, assetId) {
      const path = objectPath(workspaceId, assetId);
      take("download");
      calls.downloads.push(path);
      const record = objects.get(path);
      if (!record) throw assetStorageError(ASSET_STORAGE_ERROR.NOT_FOUND, `No such object: ${path}`);
      return new Blob([record.bytes], { type: record.contentType });
    },

    async deleteAsset(workspaceId, assetId) {
      const path = objectPath(workspaceId, assetId);
      take("delete");
      calls.deletes.push(path);
      if (!objects.has(path)) return { deleted: false };
      objects.delete(path);
      return { deleted: true };
    },
  };
  return api;
}
