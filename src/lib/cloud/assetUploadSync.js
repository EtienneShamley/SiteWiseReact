// src/lib/cloud/assetUploadSync.js
//
// The UPLOAD ENGINE of ONE workspace session: it drains that workspace's
// asset upload queue (src/lib/assetUploadQueue.js) into Firebase Storage and
// the workspace's Firestore asset metadata, and reports what actually
// happened (Production Readiness Phase 7.4).
//
// It is written against the SAME conventions as the entity sync engine
// (src/lib/cloud/cloudSync.js) — a start/stop lifecycle, a trailing retry
// with backoff, an `online` listener, `{ type: "status" }` /
// `{ type: "outcome" }` events, and outcomes named `synced` / `queued` /
// `failed` — because a second, differently-shaped sync system would be a
// second thing to reason about for no gain. What differs is what the work
// IS: bytes, an immutable object, a metadata document, and a local record of
// both that must not be allowed to contradict itself.
//
// ONE WORKSPACE, ONE SESSION. The workspace id is captured when the engine is
// created and is passed EXPLICITLY into every queue, index and cloud call.
// Nothing here reads the ambient durable scope inside asynchronous work: a
// session can close and another account can sign in while an upload is in
// flight, and an ambient owner would then aim the settlement at the NEW
// workspace's rows. `stop()` additionally makes every remaining local write a
// no-op, so a stale session cannot mutate the one that replaced it.
//
// THE LIFECYCLE OF ONE QUEUED ASSET
//
//   A. read the local asset through the local cache boundary, by the queue
//      entry's own workspace, asset and kind (src/lib/localAssetCache.js);
//   B. resolve the canonical CLOUD TRANSPORT type from the record
//      (src/lib/cloud/assetTransportMime.js) — legacy records accepted by
//      EXTENSION carry no usable MIME type and would otherwise be refused by
//      the Storage rule forever;
//   C. build the expected Storage custom metadata and Firestore document
//      through the cloud model (src/lib/cloud/assetCloudModel.js);
//   D. read what the service holds at the object path;
//   E. upload the immutable bytes only when there is no object;
//   F. ensure the Firestore metadata document exists and describes THIS
//      asset;
//   G. only once BOTH are confirmed, record `stored` in the remote index and
//      settle the queue entry — in ONE local transaction.
//
// IDEMPOTENCE / LOST ACKNOWLEDGEMENT. Every one of D–G can be interrupted:
// the tab closes, the network drops between the service committing a write
// and the answer arriving, the process is killed after the cloud succeeded
// and before the queue was settled. A retry must therefore be able to arrive
// at any of these and finish correctly WITHOUT rewriting anything:
//
//   an object is already there   its own recorded identity is compared with
//                                the asset about to be written — the path's
//                                workspace and asset, the custom metadata's
//                                workspace, asset and kind, the content type
//                                and the size. Matching, the upload is
//                                already done and is NOT repeated (the object
//                                is immutable and the rules refuse a rewrite
//                                anyway). Contradicting, this is not our
//                                object: a permanent CONFLICT, no overwrite,
//                                no metadata write, the local bytes kept.
//                                Byte-level comparison is deliberately not
//                                attempted — downloading every object to
//                                verify it would cost more than the upload.
//   a create is REFUSED          the check at D and the write at E cannot be
//                                one atomic operation, so two devices can both
//                                find the path empty and both try to create.
//                                The loser's write is refused by the
//                                create-only rule with the SAME
//                                permission-shaped code as a genuine "you may
//                                not write here", so the path is RE-READ: an
//                                object that is now there and matches means the
//                                race was lost, not the upload, and the
//                                lifecycle continues; one that contradicts is a
//                                conflict; no object at all leaves the original
//                                refusal exactly as it was classified — a real
//                                permission failure stays permanent. The
//                                upload is never retried and the object is
//                                never rewritten.
//   no metadata document         it is created
//   a matching metadata document nothing is written; it is already synced
//   a TOMBSTONED matching one    the already-approved restore transition
//                                (stored ← tombstoned) is used, because this
//                                asset is referenced again
//   a contradicting one          a permanent CONFLICT — a document describing
//                                a different asset is never overwritten
//
// FAILURE. Transient failures (offline, unavailable, timeouts, the SDK's own
// retry limit) keep the entry and retry with backoff. Actionable ones
// (unauthorized, quota, an unmappable type, a missing local file, a conflict)
// stop AUTOMATIC retries by exhausting the entry's attempt budget, so the
// engine never spins; the user is told and an explicit Retry Now resets the
// gate. Retry metadata lives in the fields the queue already has —
// `attempts`, `nextAttemptAt`, `lastCode` — and no raw provider error ever
// reaches the user.
//
// THE LOCAL BYTES ARE NEVER REMOVED HERE. A synced asset stays in this
// browser's cache; what may be evicted, and when, is a separate approved
// policy.

import { ASSET_STORAGE_ERROR } from "./assetPaths";
import {
  CLOUD_ASSET_STATE,
  assetStorageMetadata,
  buildAssetDocument,
  isCloudAssetKind,
  normalizeCloudMimeType,
  restoreAssetDocument,
  validateAssetDocument,
} from "./assetCloudModel";
import { resolveCloudTransportMime } from "./assetTransportMime";
import { ASSET_KIND_PDF_SOURCE, readLocalAsset } from "../localAssetCache";
import {
  listPendingAssetUploads,
  settleAssetUpload,
  settleAssetUploadAsStored,
  updateAssetUploadAttempt,
} from "../assetUploadQueue";
import { currentPdfSourceIds, reconcilePdfSourceUploads } from "../pdfSourceUploads";

/* ------------------------------ vocabulary ------------------------------- */

/**
 * What the engine is doing for the ACTIVE workspace.
 *
 *   UNCONFIGURED  this build has no Storage bucket, so nothing can be
 *                 uploaded. It is a distinct state, not "idle": the queue is
 *                 growing and the product must not imply the files are safe
 *                 in the account.
 *   IDLE          nothing is owed
 *   UPLOADING     bytes are moving right now
 *   OFFLINE       there is work and no connection
 *   WAITING       there is work, due later (a backoff)
 *   FAILED        something needs the user
 */
export const ASSET_SYNC_STATUS = Object.freeze({
  UNCONFIGURED: "unconfigured",
  IDLE: "idle",
  UPLOADING: "uploading",
  OFFLINE: "offline",
  WAITING: "waiting",
  FAILED: "failed",
});

export const ASSET_SYNC_OUTCOME = Object.freeze({
  SYNCED: "synced",
  QUEUED: "queued",
  FAILED: "failed",
});

/** The engine's own codes — the ones no provider produces. */
export const ASSET_SYNC_CODE = Object.freeze({
  LOCAL_ASSET_MISSING: "local-asset-missing",
  MALFORMED_LOCAL_RECORD: "malformed-local-record",
  UNSUPPORTED_MIME: "unsupported-mime",
  INVALID_METADATA: "invalid-metadata",
  WORKSPACE_MISMATCH: "workspace-mismatch",
  OBJECT_CONFLICT: "object-conflict",
  METADATA_CONFLICT: "metadata-conflict",
  MALFORMED_CLOUD_RECORD: "malformed-cloud-record",
  OFFLINE: "offline",
  UNCONFIGURED: "unconfigured",
});

export const DEFAULT_ASSET_UPLOAD_CONCURRENCY = 2;
export const DEFAULT_MAX_AUTO_ATTEMPTS = 5;
export const DEFAULT_SIGN_OUT_DRAIN_MS = 10000;
export const ASSET_RETRY_BACKOFF_MS = [2000, 5000, 15000, 45000, 120000];

// "Not now" rather than "not ever" — the Storage SDK's own transient codes and
// the Firestore ones the entity engine already treats this way.
const TRANSIENT_CODES = new Set([
  ASSET_STORAGE_ERROR.RETRY_LIMIT_EXCEEDED,
  ASSET_STORAGE_ERROR.CANCELED,
  "storage/server-file-wrong-size",
  "unavailable",
  "deadline-exceeded",
  "aborted",
  "cancelled",
  "internal",
  "timeout",
  "network",
]);

/**
 * `{ outcome, code }` for one failure. `queued` keeps the entry and retries
 * with backoff; `failed` pauses automatic retries until the user asks again.
 */
export function classifyAssetUploadError(error) {
  const raw = error && typeof error.code === "string" ? error.code : "";
  const code = raw.replace(/^firestore\//, "");
  if (TRANSIENT_CODES.has(raw) || TRANSIENT_CODES.has(code)) {
    return { outcome: ASSET_SYNC_OUTCOME.QUEUED, code: code || "unavailable" };
  }
  // A fetch that never reached anything: no code of its own, the shape the
  // entity engine already reads as "the network, not the request".
  if (error && error.name === "TypeError" && !raw) {
    return { outcome: ASSET_SYNC_OUTCOME.QUEUED, code: "network" };
  }
  return { outcome: ASSET_SYNC_OUTCOME.FAILED, code: code || "unknown" };
}

/**
 * Codes an IMMUTABLE-CREATE RACE can wear.
 *
 * "Is there an object?" and "write the object" cannot be one atomic
 * operation, so two devices holding the same asset can both find the path
 * empty and both try to create it. The rules let exactly one win; the loser's
 * write is refused by the create-only rule (`allow create: … resource ==
 * null`), and the service reports that refusal with the SAME permission-shaped
 * code as a genuine "you may not write here" — HTTP 403 → `storage/unauthorized`
 * in the SDK and in the emulator alike. The code alone therefore cannot tell
 * "somebody else got there first" from "your account is not allowed": only
 * RE-READING the path can (`resolveUploadFailure` below).
 *
 * The set is deliberately narrow. Transient codes are absent because they
 * already recover on their own — the next attempt heads the path and finds the
 * winner's object. `storage/unauthenticated`, `storage/quota-exceeded` and
 * `storage/invalid-argument` are absent because no object-now-exists condition
 * produces them: they are the request being wrong, not late.
 */
export const CREATE_RACE_CODES = Object.freeze([ASSET_STORAGE_ERROR.UNAUTHORIZED]);

const CREATE_RACE_CODE_SET = new Set(CREATE_RACE_CODES);

/** Whether a failed create MIGHT be a lost race rather than a refusal. */
export function isPossibleCreateRace(error) {
  return Boolean(error) && typeof error.code === "string" && CREATE_RACE_CODE_SET.has(error.code);
}

/** What the user is told. A provider's own message is never shown. */
export const ASSET_SYNC_FAILURE_MESSAGE = Object.freeze({
  [ASSET_SYNC_CODE.LOCAL_ASSET_MISSING]:
    "A file waiting to upload is no longer on this device, so it cannot be sent to your account.",
  [ASSET_SYNC_CODE.MALFORMED_LOCAL_RECORD]:
    "A file waiting to upload is stored in a form this device cannot send. It stays on this device.",
  [ASSET_SYNC_CODE.UNSUPPORTED_MIME]:
    "A file waiting to upload is of a type that cannot be stored in your account. It stays on this device.",
  [ASSET_SYNC_CODE.INVALID_METADATA]:
    "A file waiting to upload could not be described in a form your account accepts. It stays on this device.",
  [ASSET_SYNC_CODE.WORKSPACE_MISMATCH]:
    "A file waiting to upload belongs to a different workspace and was not sent.",
  [ASSET_SYNC_CODE.OBJECT_CONFLICT]:
    "A different file is already stored under this file's name in your account, so it was not overwritten. Your copy stays on this device.",
  [ASSET_SYNC_CODE.METADATA_CONFLICT]:
    "Your account already describes a different file under this file's name, so nothing was changed. Your copy stays on this device.",
  [ASSET_SYNC_CODE.MALFORMED_CLOUD_RECORD]:
    "A file record in your account is unreadable and was not overwritten. Your copy stays on this device.",
  [ASSET_STORAGE_ERROR.UNAUTHORIZED]:
    "Your account is not allowed to store files in this workspace. Sign out and back in; if it persists, contact support.",
  [ASSET_STORAGE_ERROR.UNAUTHENTICATED]:
    "Your session could not be verified, so files were not uploaded. Sign out and back in.",
  [ASSET_STORAGE_ERROR.QUOTA_EXCEEDED]:
    "Your account's file storage is full. Your files stay on this device until there is room.",
  [ASSET_STORAGE_ERROR.INVALID_ARGUMENT]:
    "A file could not be stored in your account in its current form. It stays on this device.",
  "permission-denied":
    "Your account is not allowed to store files in this workspace. Sign out and back in; if it persists, contact support.",
  unauthenticated: "Your session could not be verified, so files were not uploaded. Sign out and back in.",
  "resource-exhausted":
    "Your account's file storage is full. Your files stay on this device until there is room.",
  "invalid-argument": "A file could not be stored in your account in its current form. It stays on this device.",
  unknown: "Some files could not be uploaded to your account. They stay on this device and will be retried.",
});

export function assetSyncFailureMessage(code) {
  return ASSET_SYNC_FAILURE_MESSAGE[code] || ASSET_SYNC_FAILURE_MESSAGE.unknown;
}

/* --------------------------- the local boundary -------------------------- */

/**
 * Every LOCAL operation the engine performs, in one injectable object.
 *
 * It exists so the engine can be driven against the real Firebase emulators
 * in an integration test without a browser IndexedDB, and so a test can hold
 * a queue still while it asserts ordering. Production uses the real modules
 * below and nothing else.
 */
export const defaultAssetUploadLocal = Object.freeze({
  listPending: (workspaceId) => listPendingAssetUploads(workspaceId),
  readAsset: (assetId, kind) => readLocalAsset(assetId, { kind }),
  updateAttempt: (workspaceId, assetId, patch) => updateAssetUploadAttempt(workspaceId, assetId, patch),
  settle: (workspaceId, assetId) => settleAssetUpload(workspaceId, assetId),
  settleStored: (entry) => settleAssetUploadAsStored(entry),
  currentPdfSources: (workspaceId) => currentPdfSourceIds(workspaceId),
  reconcilePdfSources: (workspaceId, options) =>
    reconcilePdfSourceUploads({ workspaceId, sources: currentPdfSourceIds(workspaceId), ...(options || {}) }),
});

/* ------------------------------- the engine ------------------------------ */

/**
 * @param {{
 *   workspaceId: string,
 *   assetStore: object|null,      the Storage adapter; NULL means this build
 *                                 has no bucket — the engine reports
 *                                 `unconfigured` and drains nothing
 *   workspaceStore: object,       the Firestore workspace store
 *   local?: object,               see defaultAssetUploadLocal
 *   concurrency?: number, maxAutoAttempts?: number,
 *   isOnline?: () => boolean,
 *   setTimer?: Function, clearTimer?: Function, now?: () => number,
 *   addOnlineListener?: (fn: Function) => (() => void),
 * }} options
 */
export function createAssetUploadSync({
  workspaceId,
  assetStore = null,
  workspaceStore = null,
  local = defaultAssetUploadLocal,
  concurrency = DEFAULT_ASSET_UPLOAD_CONCURRENCY,
  maxAutoAttempts = DEFAULT_MAX_AUTO_ATTEMPTS,
  isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
  addOnlineListener = (fn) => {
    if (typeof window === "undefined" || !window.addEventListener) return () => {};
    window.addEventListener("online", fn);
    return () => window.removeEventListener("online", fn);
  },
} = {}) {
  if (!workspaceId) throw new Error("A workspace id is required to upload assets");

  const configured = Boolean(assetStore && workspaceStore);
  const listeners = new Set();
  const lanes = Math.max(1, Math.min(concurrency, 8));

  let stopped = false;
  let started = false;
  let removeOnline = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let draining = null; // the in-flight drain promise
  let drainAgain = false;
  let forceNext = false; // the next drain is an explicit Retry Now

  let status = configured ? ASSET_SYNC_STATUS.IDLE : ASSET_SYNC_STATUS.UNCONFIGURED;
  let lastError = null;
  let pending = 0;
  let failed = 0;
  // assetId → { total, done } for the uploads of the CURRENT drain only.
  const inFlight = new Map();
  let bytesTotal = 0;
  let bytesDone = 0;

  function emit(event) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch {
        // a listener must never break the engine
      }
    }
  }

  function snapshot() {
    return {
      status,
      pending,
      failed,
      active: inFlight.size,
      bytesTotal,
      bytesDone,
      error: lastError,
    };
  }

  function setStatus(next, error = lastError) {
    status = next;
    lastError = error;
    emit({ type: "status", ...snapshot() });
  }

  function publish() {
    emit({ type: "status", ...snapshot() });
  }

  function disarmRetry() {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(delayMs) {
    if (stopped || !configured) return;
    disarmRetry();
    const wait = Number.isFinite(delayMs)
      ? delayMs
      : ASSET_RETRY_BACKOFF_MS[Math.min(retryAttempt, ASSET_RETRY_BACKOFF_MS.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      drain();
    }, wait);
  }

  /** A local write, refused once the session is over. */
  function ifLive(run) {
    if (stopped) return Promise.resolve(null);
    return run();
  }

  /* ------------------------------ one asset ----------------------------- */

  /**
   * The facts of ONE local asset, in the one shape the rest of the lifecycle
   * reads. `readLocalAsset` returns two different shapes — a general asset's
   * stored record with its Blob, and a PDF source's bytes — because their
   * consumers differ; the difference stops here.
   */
  function factsOf(entry, record) {
    if (entry.kind === ASSET_KIND_PDF_SOURCE) {
      const size = record.bytes ? record.bytes.byteLength : 0;
      return {
        assetKind: ASSET_KIND_PDF_SOURCE,
        name: record.name || null,
        storedMimeType: "application/pdf",
        size,
        // A PDF source has no creation time of its own — its bytes are one
        // immutable version of a file, stamped when they were written.
        createdAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null,
        metadata: {},
        sourceAssetId: null,
        owner: null,
        data: record.bytes,
      };
    }
    return {
      assetKind: record.kind,
      name: record.name || null,
      storedMimeType: record.mimeType || null,
      size: typeof record.size === "number" ? record.size : record.blob ? record.blob.size : 0,
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null,
      metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : {},
      sourceAssetId: typeof record.sourceAssetId === "string" ? record.sourceAssetId : null,
      owner: typeof record.workspaceId === "string" ? record.workspaceId : null,
      data: record.blob,
    };
  }

  /**
   * Whether the object standing on the path IS the asset we were about to
   * write. Identity only — nothing about the bytes themselves.
   */
  function objectMatches(head, fields) {
    const meta = head && head.metadata ? head.metadata : {};
    const expected = assetStorageMetadata(fields);
    if (head.path && assetStore.objectPath(fields.workspaceId, fields.id) !== head.path) return false;
    if (meta.workspaceId !== expected.workspaceId) return false;
    if (meta.assetId !== expected.assetId) return false;
    if (meta.assetKind !== expected.assetKind) return false;
    if (normalizeCloudMimeType(head.contentType) !== fields.mimeType) return false;
    return Number(head.size) === Number(fields.size);
  }

  /** The immutable identity a metadata document must agree with. */
  function documentMatches(asset, fields) {
    return (
      asset.assetKind === fields.assetKind &&
      asset.mimeType === fields.mimeType &&
      Number(asset.size) === Number(fields.size) &&
      (asset.sourceAssetId || null) === (fields.sourceAssetId || null)
    );
  }

  function trackProgress(assetId, total) {
    inFlight.set(assetId, { total, done: 0 });
    bytesTotal += total;
    setStatus(ASSET_SYNC_STATUS.UPLOADING);
  }

  function recordProgress(assetId, transferred) {
    const lane = inFlight.get(assetId);
    if (!lane) return;
    const capped = Math.max(0, Math.min(Number(transferred) || 0, lane.total));
    if (capped === lane.done) return;
    bytesDone += capped - lane.done;
    lane.done = capped;
    publish();
  }

  function releaseProgress(assetId) {
    inFlight.delete(assetId);
  }

  /**
   * What a REFUSED create actually was.
   *
   * A permission-shaped refusal is ambiguous (see CREATE_RACE_CODES), so the
   * path is re-read and the object standing on it — if any — is judged by the
   * SAME identity comparison `objectMatches` applies at step D. Nothing else
   * changes: the object is never rewritten, the upload is never retried, and a
   * failure that is not a plausible race is classified exactly as it was.
   *
   *   the object now exists and IS this asset  → the race was lost, not the
   *                                              upload: `{ recovered: true }`,
   *                                              and the lifecycle continues to
   *                                              the metadata document
   *   the object now exists and is NOT         → permanent object-conflict
   *   the object still does not exist          → the ORIGINAL classification
   *                                              stands, so a real permission
   *                                              or membership failure stays
   *                                              permanent and actionable
   *
   * @returns {{ recovered: true } | { recovered: false, result: object|null }}
   */
  async function resolveUploadFailure(entry, error, fields) {
    const classified = classifyAssetUploadError(error);
    const refuse = async (outcome) => ({ recovered: false, result: await fail(entry, outcome) });
    if (!isPossibleCreateRace(error)) return refuse(classified);

    let head = null;
    try {
      head = await assetStore.objectMetadata(workspaceId, fields.id);
    } catch {
      // The second read failed too, so nothing was learned about the path.
      // The original failure stands as it was classified — a read failure must
      // never soften a refusal into a success.
      return refuse(classified);
    }
    if (stopped) return { recovered: false, result: null };
    if (!head || !head.exists) return refuse(classified);
    if (!objectMatches(head, fields)) {
      return refuse({ outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.OBJECT_CONFLICT });
    }
    return { recovered: true };
  }

  /**
   * Resolve one queue entry all the way to `synced`, or to the outcome that
   * explains why not. Never throws.
   */
  async function processEntry(entry) {
    const assetId = entry.assetId;
    // Defence in depth: the key range already makes another workspace's rows
    // unreachable, and this makes a hand-built entry unreachable too.
    if (entry.workspaceId !== workspaceId) {
      return { assetId, kind: entry.kind, outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.WORKSPACE_MISMATCH };
    }

    let record = null;
    try {
      record = await local.readAsset(assetId, entry.kind);
    } catch (error) {
      return fail(entry, classifyAssetUploadError(error));
    }
    if (stopped) return null;

    if (!record) {
      // A PDF source the workspace no longer names is not an error: it is a
      // replaced or deleted file whose bytes are already gone, and the repair
      // for a crash between those two steps is to stop owing it.
      if (entry.kind === ASSET_KIND_PDF_SOURCE && !isCurrentPdfSource(assetId)) {
        await ifLive(() => local.settle(workspaceId, assetId));
        return { assetId, kind: entry.kind, outcome: ASSET_SYNC_OUTCOME.SYNCED, code: "obsolete", obsolete: true };
      }
      return fail(entry, { outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.LOCAL_ASSET_MISSING });
    }

    const facts = factsOf(entry, record);
    if (facts.owner && facts.owner !== workspaceId) {
      return fail(entry, { outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.WORKSPACE_MISMATCH });
    }
    if (!isCloudAssetKind(facts.assetKind) || !facts.data || !(facts.size > 0)) {
      return fail(entry, { outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.MALFORMED_LOCAL_RECORD });
    }

    const transport = resolveCloudTransportMime({
      assetKind: facts.assetKind,
      mimeType: facts.storedMimeType,
      name: facts.name,
    });
    if (!transport.ok) {
      return fail(entry, { outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.UNSUPPORTED_MIME });
    }

    const built = buildAssetDocument({
      workspaceId,
      id: assetId,
      assetKind: facts.assetKind,
      name: facts.name,
      mimeType: transport.mimeType,
      size: facts.size,
      createdAt: facts.createdAt,
      metadata: facts.metadata,
      sourceAssetId: facts.sourceAssetId,
      now,
    });
    if (!built.ok) {
      return fail(entry, { outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.INVALID_METADATA });
    }
    const fields = built.fields;

    // D — what is on the path.
    let head = null;
    try {
      head = await assetStore.objectMetadata(workspaceId, assetId);
    } catch (error) {
      return fail(entry, classifyAssetUploadError(error));
    }
    if (stopped) return null;

    if (head && head.exists) {
      if (!objectMatches(head, fields)) {
        return fail(entry, { outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.OBJECT_CONFLICT });
      }
      // Already written by an earlier attempt whose answer was lost. The
      // object is immutable; it is not rewritten.
    } else {
      // E — the bytes. The check above and this write are NOT atomic, and
      // cannot be: another device can create the object in between.
      trackProgress(assetId, facts.size);
      let uploadError = null;
      try {
        await assetStore.uploadAsset(workspaceId, assetId, facts.data, {
          contentType: fields.mimeType,
          metadata: assetStorageMetadata(fields),
          onProgress: (p) => recordProgress(assetId, p && p.bytesTransferred),
        });
      } catch (error) {
        uploadError = error;
      } finally {
        releaseProgress(assetId);
      }
      if (stopped) return null;
      if (uploadError) {
        const resolved = await resolveUploadFailure(entry, uploadError, fields);
        if (!resolved.recovered) return resolved.result;
        // The object on the path IS this asset — the race was lost, not the
        // upload. Continue exactly as if we had found it at step D.
      }
    }

    // F — the metadata document.
    try {
      const existing = await workspaceStore.readAssetDocument(workspaceId, assetId);
      if (stopped) return null;
      if (!existing || !existing.exists) {
        await workspaceStore.writeAssetDocument(workspaceId, assetId, fields);
      } else {
        const check = validateAssetDocument({ workspaceId, id: assetId, fields: existing.fields });
        if (!check.ok) {
          return fail(entry, { outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.MALFORMED_CLOUD_RECORD });
        }
        if (!documentMatches(check.asset, fields)) {
          return fail(entry, { outcome: ASSET_SYNC_OUTCOME.FAILED, code: ASSET_SYNC_CODE.METADATA_CONFLICT });
        }
        if (check.asset.state === CLOUD_ASSET_STATE.TOMBSTONED) {
          // The one rewrite this engine ever performs, and the only one the
          // rules permit here: an asset this workspace still references is
          // brought back out of its tombstone. Nothing else in the document
          // changes — `restoreAssetDocument` carries the STORED fields
          // forward and drops only the tombstone.
          await workspaceStore.writeAssetDocument(workspaceId, assetId, restoreAssetDocument(existing.fields));
        }
        // A matching, stored document is already correct: nothing is written.
      }
      if (stopped) return null;
    } catch (error) {
      return fail(entry, classifyAssetUploadError(error));
    }

    // G — the local record of both, atomically.
    const settled = await ifLive(() =>
      local.settleStored({
        workspaceId,
        assetId,
        kind: facts.assetKind,
        name: fields.name,
        mimeType: fields.mimeType,
        size: fields.size,
        sourceAssetId: fields.sourceAssetId || null,
        at: now(),
      })
    );
    if (settled === null && stopped) return null;
    return { assetId, kind: entry.kind, outcome: ASSET_SYNC_OUTCOME.SYNCED, code: null };
  }

  /** Record one attempt's failure on the entry and report it. */
  async function fail(entry, { outcome, code }) {
    const attempts = (entry.attempts || 0) + 1;
    const permanent = outcome === ASSET_SYNC_OUTCOME.FAILED;
    // A permanent failure exhausts the budget rather than adding a field: the
    // queue already distinguishes "may be tried again later" from "will not
    // be tried again automatically" through `attempts`, and `lastCode` says
    // which of the two this is.
    const nextAttempts = permanent ? Math.max(maxAutoAttempts, attempts) : attempts;
    const backoff = ASSET_RETRY_BACKOFF_MS[Math.min(attempts - 1, ASSET_RETRY_BACKOFF_MS.length - 1)];
    await ifLive(() =>
      local.updateAttempt(workspaceId, entry.assetId, {
        attempts: nextAttempts,
        nextAttemptAt: permanent ? now() : now() + backoff,
        lastCode: code,
      })
    );
    return { assetId: entry.assetId, kind: entry.kind, outcome, code };
  }

  /* ------------------------------- the drain ---------------------------- */

  // The current workspace's PDF source ids, resolved once per drain so a
  // missing local file can be told apart from a replaced one without reading
  // the registry per entry. Empty when the engine's workspace is not the one
  // the durable scope is on — the registry belongs to a session, and a stale
  // one must never answer for this workspace.
  let currentPdfSources = new Set();
  function isCurrentPdfSource(assetId) {
    return currentPdfSources.has(assetId);
  }

  async function runDrain(force) {
    let entries = [];
    try {
      entries = await local.listPending(workspaceId);
    } catch (error) {
      const classified = classifyAssetUploadError(error);
      setStatus(ASSET_SYNC_STATUS.FAILED, classified.code);
      return { ok: false, results: [] };
    }
    entries = (entries || []).filter((entry) => entry && entry.workspaceId === workspaceId);
    pending = entries.length;
    failed = entries.filter((entry) => (entry.attempts || 0) >= maxAutoAttempts).length;

    if (entries.length === 0) {
      bytesTotal = 0;
      bytesDone = 0;
      setStatus(ASSET_SYNC_STATUS.IDLE, null);
      return { ok: true, results: [] };
    }

    if (force) {
      // Retry Now: reset the gate on everything this workspace still owes.
      // Bytes and identity are untouched — only when it may next be tried.
      for (const entry of entries) {
        if ((entry.attempts || 0) === 0 && !entry.lastCode) continue;
        await ifLive(() =>
          local.updateAttempt(workspaceId, entry.assetId, { attempts: 0, nextAttemptAt: now(), lastCode: null })
        );
        entry.attempts = 0;
        entry.nextAttemptAt = now();
        entry.lastCode = null;
      }
      failed = 0;
    }

    if (!isOnline()) {
      setStatus(ASSET_SYNC_STATUS.OFFLINE, null);
      emit({
        type: "outcome",
        results: entries.map((entry) => ({
          assetId: entry.assetId,
          kind: entry.kind,
          outcome: ASSET_SYNC_OUTCOME.QUEUED,
          code: ASSET_SYNC_CODE.OFFLINE,
        })),
      });
      scheduleRetry();
      return { ok: false, results: [] };
    }

    const at = now();
    const due = entries.filter(
      (entry) => (entry.attempts || 0) < maxAutoAttempts && (entry.nextAttemptAt || 0) <= at
    );
    if (due.length === 0) {
      setStatus(failed > 0 ? ASSET_SYNC_STATUS.FAILED : ASSET_SYNC_STATUS.WAITING);
      if (failed < entries.length) scheduleRetry();
      return { ok: true, results: [] };
    }

    currentPdfSources = due.some((entry) => entry.kind === ASSET_KIND_PDF_SOURCE)
      ? new Set(safeCurrentPdfSources())
      : new Set();

    bytesTotal = 0;
    bytesDone = 0;
    setStatus(ASSET_SYNC_STATUS.UPLOADING, null);

    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (!stopped) {
        const entry = due[cursor];
        cursor += 1;
        if (!entry) return;
        const result = await processEntry(entry);
        if (result) results.push(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, due.length) }, worker));
    if (stopped) return { ok: false, results };

    // Recount from the queue itself — the settlements just made are the truth,
    // not the list this drain started from.
    let remaining = [];
    try {
      remaining = (await local.listPending(workspaceId)) || [];
    } catch {
      remaining = [];
    }
    remaining = remaining.filter((entry) => entry && entry.workspaceId === workspaceId);
    pending = remaining.length;
    failed = remaining.filter((entry) => (entry.attempts || 0) >= maxAutoAttempts).length;
    const retriable = remaining.length - failed;
    bytesTotal = 0;
    bytesDone = 0;

    const worstCode = results.find((r) => r.outcome === ASSET_SYNC_OUTCOME.FAILED);
    if (remaining.length === 0) {
      retryAttempt = 0;
      setStatus(ASSET_SYNC_STATUS.IDLE, null);
    } else if (retriable > 0) {
      retryAttempt = 0;
      setStatus(ASSET_SYNC_STATUS.WAITING, null);
      scheduleRetry();
    } else {
      setStatus(ASSET_SYNC_STATUS.FAILED, worstCode ? worstCode.code : "unknown");
    }
    emit({ type: "outcome", results });
    return { ok: failed === 0, results };
  }

  function safeCurrentPdfSources() {
    try {
      const listed = local.currentPdfSources
        ? local.currentPdfSources(workspaceId)
        : currentPdfSourceIds(workspaceId);
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  }

  /** Drains now. Concurrent calls share one drain; a call during one schedules
   *  another right after it. */
  function drain(force = false) {
    if (stopped || !configured) return Promise.resolve({ ok: true, results: [] });
    disarmRetry();
    if (force) forceNext = true;
    if (draining) {
      drainAgain = true;
      return draining;
    }
    const runForce = forceNext;
    forceNext = false;
    draining = runDrain(runForce)
      .catch((error) => ({ ok: false, results: [], error }))
      .finally(() => {
        draining = null;
        if (drainAgain && !stopped) {
          drainAgain = false;
          drain();
        }
      });
    return draining;
  }

  /* ------------------------------- lifecycle ---------------------------- */

  function start() {
    if (stopped) throw new Error("A stopped asset upload engine cannot be restarted");
    if (started) return api;
    started = true;
    if (!configured) {
      setStatus(ASSET_SYNC_STATUS.UNCONFIGURED, ASSET_SYNC_CODE.UNCONFIGURED);
      return api;
    }
    removeOnline = addOnlineListener(() => {
      retryAttempt = 0;
      drain();
    });
    // The PDF atomicity repair runs BEFORE the first drain: a PDF that became
    // a valid durable document but whose queue identity never landed is owed
    // from this moment on.
    Promise.resolve()
      .then(() =>
        ifLive(() =>
          // The reconciler decides "already stored" from each source's
          // CURRENT cloud document through this engine's own workspace store
          // (src/lib/cloud/assetCloudState.js) — never from the local index.
          local.reconcilePdfSources(workspaceId, {
            readCloudAssetDocument:
              workspaceStore && typeof workspaceStore.readAssetDocument === "function"
                ? (wid, assetId) => workspaceStore.readAssetDocument(wid, assetId)
                : null,
          })
        )
      )
      .catch(() => {
        // A failed reconciliation is not a failed session: it is retried at
        // the next sign-in, and nothing has been lost meanwhile.
      })
      .then(() => {
        if (!stopped) drain();
      });
    return api;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    disarmRetry();
    if (removeOnline) removeOnline();
    removeOnline = null;
    inFlight.clear();
    listeners.clear();
  }

  /**
   * Make bounded progress before the session ends, then say what is left.
   *
   * It NEVER waits longer than `timeoutMs`, and it never discards anything:
   * whatever has not finished stays queued, with its bytes, for the next
   * sign-in of this same workspace on this device.
   */
  async function drainForSignOut({ timeoutMs = DEFAULT_SIGN_OUT_DRAIN_MS } = {}) {
    if (!configured || stopped) return summarise();
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimer(resolve, Math.max(0, timeoutMs));
    });
    try {
      await Promise.race([drain(), deadline]);
    } catch {
      // The drain's own outcomes have already reported this.
    } finally {
      if (timer !== null) clearTimer(timer);
    }
    return summarise();
  }

  async function summarise() {
    let remaining = [];
    try {
      remaining = (await local.listPending(workspaceId)) || [];
    } catch {
      remaining = [];
    }
    remaining = remaining.filter((entry) => entry && entry.workspaceId === workspaceId);
    const count = remaining.length;
    return {
      workspaceId,
      remaining: count,
      message: count === 0 ? null : signOutMessage(count),
    };
  }

  const api = Object.freeze({
    workspaceId,
    configured,
    start,
    stop,
    /** Drain now (used by the tests and the sign-out path). */
    flush: () => drain(false),
    /** An explicit Retry Now: resets the retry gate for THIS workspace only. */
    retryNow: () => drain(true),
    drainForSignOut,
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getStatus: () => snapshot(),
  });
  return api;
}

/** "3 files will finish uploading next time you sign in on this device." */
export function signOutMessage(count) {
  const n = Number(count) || 0;
  if (n <= 0) return null;
  return `${n} ${n === 1 ? "file" : "files"} will finish uploading next time you sign in on this device.`;
}
