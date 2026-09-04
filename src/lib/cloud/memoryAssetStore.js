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
// THE STORAGE RULES (Phase 7.3). The real rules decide membership and
// ownership by reading FIRESTORE cross-service (storage.rules →
// `firestore.exists` / `firestore.get`). This double does the same thing
// against the in-memory WORKSPACE store when one is attached —
// `createMemoryAssetStore({ workspaceStore })` — reading the caller from
// `workspaceStore.getUser()` and the membership / owner documents it holds:
//   - get / upload need membership of the path's workspace;
//   - an upload must be 1 byte … 50 MB, carry a content type on the canonical
//     cloud list, and name its identity (assetId, workspaceId, assetKind) in
//     custom metadata matching the path (src/lib/cloud/assetCloudModel.js);
//   - DELETE is the workspace OWNER's alone (workspaces/{wid}.ownerUid), so
//     no test can rely on a delete the real rule denies;
//   - a signed-out caller gets `storage/unauthenticated`, any other refusal
//     `storage/unauthorized` — the SDK's own codes.
// WITHOUT a workspace store the double runs RULES-BYPASSED — the equivalent
// of the emulator's `withSecurityRulesDisabled` — for tests of the byte
// contract alone; the create-only rule and the path/type checks apply in
// both modes. The rules themselves are tested against the real emulators
// (test/rules/storage.rules.test.js).
//
// Failure injection: `failNext(operation, code)` makes the next
// exists/upload/download/delete reject with a Storage-shaped `{ code }`
// error. Test controls (`seed`, `dump`, `list`, `calls`) are not part of the
// production interface.

import { ASSET_STORAGE_ERROR, assetObjectPath, assetPrefix, assetStorageError } from "./assetPaths";
import { MAX_CLOUD_ASSET_BYTES, isCloudAssetKind, isCloudAssetMimeType } from "./assetCloudModel";

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
 * @param {{ bucket?: string, now?: () => number, workspaceStore?: object|null }} [options]
 *        `workspaceStore` — a memory workspace store (src/lib/cloud/
 *        memoryWorkspaceStore.js); when given, the Storage rules are enforced
 *        from its user and membership documents. Omitted = rules bypassed.
 */
export function createMemoryAssetStore({ bucket = "memory-bucket", now = () => Date.now(), workspaceStore = null } = {}) {
  // canonical object path → { bytes, size, contentType, metadata, createdAt }
  const objects = new Map();
  const failures = { exists: null, upload: null, download: null, delete: null };
  const calls = { exists: 0, uploads: [], downloads: [], deletes: [] };

  function take(operation) {
    const failure = failures[operation];
    failures[operation] = null;
    if (failure) throw assetStorageError(failure);
  }

  // storage.rules, evaluated against the attached workspace store: `get` and
  // `create` for a member, `delete` for the owner. Nothing when no store is
  // attached (rules bypassed).
  function authorize(operation, workspaceId) {
    if (!workspaceStore) return;
    const uid = workspaceStore.getUser();
    if (!uid) throw assetStorageError(ASSET_STORAGE_ERROR.UNAUTHENTICATED, "No signed-in user");
    if (operation === "delete") {
      const workspace = workspaceStore.get(["workspaces", workspaceId]);
      if (!workspace || workspace.ownerUid !== uid) {
        throw assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED, "Only the workspace owner may delete an asset object");
      }
      return;
    }
    if (!workspaceStore.get(["workspaces", workspaceId, "members", uid])) {
      throw assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED, "Not a member of this workspace");
    }
  }

  // The create rule's object invariants (size, content type, identity metadata).
  function authorizeCreate(workspaceId, assetId, size, contentType, metadata) {
    if (!workspaceStore) return;
    const refuse = (message) => {
      throw assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED, message);
    };
    if (!(size > 0) || size > MAX_CLOUD_ASSET_BYTES) refuse("An asset object must be 1 byte to 50 MB");
    if (contentType !== contentType.toLowerCase().trim() || !isCloudAssetMimeType(contentType)) {
      refuse("That content type is not accepted for a cloud asset");
    }
    const meta = metadata && typeof metadata === "object" ? metadata : null;
    if (!meta || meta.assetId !== assetId || meta.workspaceId !== workspaceId || !isCloudAssetKind(meta.assetKind)) {
      refuse("An asset object must name its own workspace, asset and kind");
    }
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
      authorize("get", workspaceId);
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
      authorize("create", workspaceId);
      if (objects.has(path)) {
        // The create-only rule's refusal: an object is never rewritten.
        throw assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED, "An asset object is immutable once written");
      }
      const bytes = await toBytes(data);
      const size = typeof data.size === "number" ? data.size : bytes.length;
      authorizeCreate(workspaceId, assetId, size, contentType, options.metadata);
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
      authorize("get", workspaceId);
      const record = objects.get(path);
      if (!record) throw assetStorageError(ASSET_STORAGE_ERROR.NOT_FOUND, `No such object: ${path}`);
      return new Blob([record.bytes], { type: record.contentType });
    },

    async deleteAsset(workspaceId, assetId) {
      const path = objectPath(workspaceId, assetId);
      take("delete");
      calls.deletes.push(path);
      authorize("delete", workspaceId);
      if (!objects.has(path)) return { deleted: false };
      objects.delete(path);
      return { deleted: true };
    },
  };
  return api;
}
