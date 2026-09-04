// src/lib/cloud/firebaseStorageAdapter.js
//
// The ONLY module in the application that imports `firebase/storage`.
//
// It is the Firebase Storage implementation of the ASSET STORE interface the
// cloud layer is written against (the in-memory twin, used by every test, is
// src/lib/cloud/memoryAssetStore.js):
//
//   bucket                                          the resolved bucket name
//   objectPath(workspaceId, assetId)                the canonical object path
//   objectExists(workspaceId, assetId)              → boolean
//   objectMetadata(workspaceId, assetId)            → { exists, path, size,
//                                                       contentType, metadata }
//   uploadAsset(workspaceId, assetId, data, opts)   → { path, size, contentType }
//   downloadAsset(workspaceId, assetId)             → Blob
//   deleteAsset(workspaceId, assetId)               → { deleted: boolean }
//
// Locations come from src/lib/cloud/assetPaths.js — `workspaces/{wid}/assets/
// {assetId}` — and both segments are validated there, so no caller can
// address an object outside the workspace it named.
//
// DECISIONS THIS FILE ENCODES (Production Readiness Phase 7):
//
//   - Reads are AUTHENTICATED SDK reads (`getBlob`). A download URL is never
//     minted, stored or used as the read model: a URL is a bearer token that
//     outlives the session and the membership that justified it.
//   - The content type is taken from the caller's explicit type or the
//     Blob's own type — never from a filename or extension. An upload with
//     neither is refused rather than stored as an unknown type.
//   - The adapter does not decide WHEN to upload, retry or dedupe (that is
//     the upload engine's job, Phase 7.4) and does not enforce object
//     immutability (that is the Storage rules' job, Phase 7.3). It performs
//     one operation per call and reports success or the SDK's own error.
//   - `objectMetadata` exists because "the object is already there" is not
//     enough to conclude an upload succeeded earlier (Phase 7.4): the engine
//     has to see that the object standing on the path IS the asset it was
//     about to write — its recorded identity, type and size — before it
//     treats the upload as done. It returns what the service holds, and
//     judges nothing.
//   - Progress is REAL or absent. With an `onProgress` callback the upload
//     runs as a RESUMABLE upload and forwards the SDK's own
//     `bytesTransferred` / `totalBytes`; without one it stays the single
//     `uploadBytes` request it has always been. No percentage is ever
//     synthesised, and a small file that completes in one chunk simply
//     reports its completion.
//   - `deleteAsset` reports `{ deleted: false }` for an object that is
//     already gone — a garbage collector that runs twice is not an error —
//     and lets every other failure propagate.
//
// Errors carry the Firebase Storage `code` (`storage/object-not-found`,
// `storage/unauthorized`, …); see ASSET_STORAGE_ERROR in assetPaths.js. A
// failure with no code of its own is wrapped as `storage/unknown` with the
// original error as `cause`, so nothing fails silently or anonymously.

import {
  connectStorageEmulator,
  deleteObject,
  getBlob,
  getMetadata,
  getStorage,
  ref as storageRef,
  uploadBytes,
  uploadBytesResumable,
} from "firebase/storage";
import { ensureFirebaseApp } from "../firebaseApp";
import { resolveFirebaseStorageConfig } from "../firebaseClientConfig";
import { ASSET_STORAGE_ERROR, assetObjectPath, assetStorageError, isAssetNotFound } from "./assetPaths";

const DEFAULT_EMULATOR_PORT = 9199;

function normalizeError(error) {
  if (error && typeof error.code === "string" && error.code.startsWith("storage/")) return error;
  const wrapped = assetStorageError(
    ASSET_STORAGE_ERROR.UNKNOWN,
    (error && error.message) || "Firebase Storage operation failed"
  );
  wrapped.cause = error;
  return wrapped;
}

/**
 * The content type of an upload, from the caller's explicit type or the
 * Blob's own — never from a name. Returns "" when neither is usable.
 */
function resolveContentType(data, contentType) {
  const explicit = typeof contentType === "string" ? contentType.trim() : "";
  if (explicit) return explicit;
  const own = data && typeof data.type === "string" ? data.type.trim() : "";
  return own;
}

/**
 * One RESUMABLE upload, reporting the SDK's own byte counters as they arrive.
 * Resolves with the same `{ metadata }` shape `uploadBytes` resolves with, so
 * the caller above is written once for both paths.
 */
function uploadWithProgress(ref, data, metadata, onProgress) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref, data, metadata);
    task.on(
      "state_changed",
      (snapshot) => {
        try {
          onProgress({
            bytesTransferred: snapshot.bytesTransferred,
            totalBytes: snapshot.totalBytes,
          });
        } catch {
          // A progress listener must never break an upload in flight.
        }
      },
      (error) => reject(error),
      () => resolve(task.snapshot)
    );
  });
}

/**
 * @param {{ apiKey: string, authDomain: string, projectId: string, appId: string,
 *           storageBucket: string|null, storageEmulatorHost: string|null }} config
 * @throws an `unconfigured` error naming REACT_APP_FIREBASE_STORAGE_BUCKET
 */
export function createFirebaseStorageAdapter(config) {
  const resolved = resolveFirebaseStorageConfig(config);
  if (!resolved.ok) {
    throw Object.assign(new Error("Firebase Storage is not configured"), {
      code: "unconfigured",
      missing: resolved.missing,
      reason: resolved.reason,
    });
  }
  const { bucket, bucketUrl, emulatorHost } = resolved.config;

  // The shared named app (src/lib/firebaseApp.js) — the same instance the
  // auth adapter and the Firestore store use, so Storage carries this user's
  // identity. The bucket is passed explicitly as well as through the app
  // options, so the adapter is correct whichever module initialised the app.
  const app = ensureFirebaseApp(config);
  const storage = getStorage(app, bucketUrl);

  if (emulatorHost) {
    const [host, port] = String(emulatorHost).split(":");
    connectStorageEmulator(storage, host, Number(port) || DEFAULT_EMULATOR_PORT);
  }

  const objectPath = (workspaceId, assetId) => assetObjectPath(workspaceId, assetId);
  const refFor = (workspaceId, assetId) => storageRef(storage, objectPath(workspaceId, assetId));

  return Object.freeze({
    bucket,
    objectPath,

    /** Whether the workspace's object for this asset exists. */
    async objectExists(workspaceId, assetId) {
      try {
        await getMetadata(refFor(workspaceId, assetId));
        return true;
      } catch (error) {
        if (isAssetNotFound(error)) return false;
        throw normalizeError(error);
      }
    },

    /**
     * What the service holds at this asset's path.
     *
     * `{ exists: false, path }` when there is no object; otherwise
     * `{ exists: true, path, size, contentType, metadata }`, where `metadata`
     * is the object's CUSTOM metadata (the identity the create rule required)
     * as a plain object — `{}` when the object carries none.
     */
    async objectMetadata(workspaceId, assetId) {
      const path = objectPath(workspaceId, assetId);
      try {
        const meta = await getMetadata(refFor(workspaceId, assetId));
        const size = typeof meta.size === "number" ? meta.size : Number(meta.size) || 0;
        return {
          exists: true,
          path,
          size,
          contentType: typeof meta.contentType === "string" ? meta.contentType : "",
          metadata: meta.customMetadata ? { ...meta.customMetadata } : {},
        };
      } catch (error) {
        if (isAssetNotFound(error)) return { exists: false, path };
        throw normalizeError(error);
      }
    },

    /**
     * Write the bytes of one asset.
     * @param {Blob|Uint8Array|ArrayBuffer} data
     * @param {{ contentType?: string, metadata?: Record<string,string>,
     *           onProgress?: (p: { bytesTransferred: number, totalBytes: number }) => void }} [options]
     *        `onProgress` receives the SDK's OWN counters from a resumable
     *        upload. It is never called with a value this adapter invented,
     *        and a listener that throws never breaks the upload.
     */
    async uploadAsset(workspaceId, assetId, data, options = {}) {
      const path = objectPath(workspaceId, assetId);
      if (!data || (typeof data.size === "number" && data.size === 0)) {
        throw assetStorageError(ASSET_STORAGE_ERROR.INVALID_ARGUMENT, "An asset needs bytes to upload");
      }
      const contentType = resolveContentType(data, options.contentType);
      if (!contentType) {
        throw assetStorageError(ASSET_STORAGE_ERROR.INVALID_ARGUMENT, "An asset upload needs a content type");
      }
      const metadata = {
        contentType,
        ...(options.metadata ? { customMetadata: options.metadata } : {}),
      };
      const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
      try {
        const result = onProgress
          ? await uploadWithProgress(refFor(workspaceId, assetId), data, metadata, onProgress)
          : await uploadBytes(refFor(workspaceId, assetId), data, metadata);
        const written = (result && result.metadata) || {};
        return {
          path,
          size: typeof written.size === "number" ? written.size : Number(written.size) || 0,
          contentType: written.contentType || contentType,
        };
      } catch (error) {
        throw normalizeError(error);
      }
    },

    /** The bytes of one asset, as a Blob. Throws `storage/object-not-found`. */
    async downloadAsset(workspaceId, assetId) {
      try {
        return await getBlob(refFor(workspaceId, assetId));
      } catch (error) {
        throw normalizeError(error);
      }
    },

    /** Remove one asset's object. `{ deleted: false }` when it was already gone. */
    async deleteAsset(workspaceId, assetId) {
      try {
        await deleteObject(refFor(workspaceId, assetId));
        return { deleted: true };
      } catch (error) {
        if (isAssetNotFound(error)) return { deleted: false };
        throw normalizeError(error);
      }
    },
  });
}
