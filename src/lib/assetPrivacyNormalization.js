// src/lib/assetPrivacyNormalization.js
//
// THE PRIVACY NORMALISATION OF ASSETS THAT ARE ALREADY STORED (Production
// Readiness Phase 7.8).
//
// Every image created from now on is normalised at the moment it is written
// (src/lib/imageProcessing.js → `normalizeImageFile`). This module exists for
// the images that were written BEFORE that: the ones already sitting in this
// browser's asset store, adopted and enqueued by the Phase 7.6 backfill, whose
// bytes may still carry the EXIF/GPS of the camera that took them. They have
// not left the device — the Storage bucket has never been configured — and
// they must not be allowed to, unnormalised, the moment it is.
//
// THE RULES, and why each one is absolute:
//
//   THE ASSET ID NEVER CHANGES.       Every reference to it — a note's
//                                     `data-asset-id`, a Template
//                                     attachment, an annotation's original —
//                                     names that id. A "new asset with clean
//                                     bytes" would be a different asset and
//                                     every one of those references would
//                                     break. So the bytes under the id are
//                                     replaced, in place, once, before the
//                                     cloud has ever seen them.
//
//   ONLY WHAT IS STILL OWED.          The proof that an asset has NOT been
//                                     uploaded is that its workspace still
//                                     owes it: `settleAssetUploadAsStored`
//                                     removes the queue entry at the moment
//                                     the upload lands. No queue entry, no
//                                     rewrite — which is how the immutable
//                                     cloud object is protected without
//                                     asking the network. An asset the local
//                                     remote index already records as
//                                     `stored` is refused for the same
//                                     reason, belt and braces.
//
//   ONE TRANSACTION.                  The updated record and the queue entry
//                                     whose retry gate must be reset are in
//                                     the same IndexedDB database
//                                     (src/lib/assetDb.js), so they are
//                                     written together or not at all. A crash
//                                     halfway leaves the ORIGINAL bytes and
//                                     the ORIGINAL queue entry — a state the
//                                     next pass simply repeats. There is no
//                                     window in which a reference points at
//                                     nothing, or the queue describes bytes
//                                     that are not there.
//
//   RE-READ INSIDE THE TRANSACTION.   The re-encode happens outside it (a
//                                     canvas cannot run inside an IndexedDB
//                                     transaction), so everything the
//                                     decision rested on is checked again
//                                     with the write in hand: the record
//                                     still exists, still belongs to this
//                                     workspace, still describes the bytes
//                                     that were transformed, is still owed,
//                                     and is still unmarked. Anything else
//                                     and nothing is written.
//
//   NO RESIZE.                        A stored image's intrinsic width and
//                                     height are written into the documents
//                                     that reference it. This pass changes
//                                     the CONTAINER, never the picture: same
//                                     pixels, same dimensions, no metadata.
//
//   THE MEDIA DECIDES, NOT THE KIND.  An attachment (`note-file`,
//                                     `editor-file`) is inspected too, because
//                                     an image is an image whichever control
//                                     created it and a Photo field and a File
//                                     field both accept JPEG/PNG/WebP. Its
//                                     BYTES answer the question — never its
//                                     declared MIME type and never its
//                                     filename. An attachment that is a real
//                                     document is reported `not-applicable`
//                                     and is left byte-for-byte alone.
//
// It is bounded (the workspace's own upload queue), restartable (idempotent
// per asset, and a marked asset is skipped), workspace-scoped (the queue
// cannot be addressed without naming the workspace) and interruptible (the
// session guard is checked between assets). It never blocks the application:
// the upload engine enforces the same invariant on its own, so this pass is an
// optimisation of WHEN the work happens, never the only thing standing
// between an unnormalised image and the cloud.

import { ASSET_STORE, ASSET_UPLOAD_QUEUE_STORE, ASSET_REMOTE_INDEX_STORE, assetDbTransaction } from "./assetDb";
import { isQueueableWorkspaceId, listPendingAssetUploads, notifyAssetQueueWrite } from "./assetUploadQueue";
import { REMOTE_ASSET_STATE } from "./assetRemoteIndex";
import { isValidAssetSegment } from "./cloud/assetPaths";
import { normalizeImageBytesForPrivacy } from "./imageProcessing";
import {
  PRIVACY_SCOPE,
  isPrivacyNormalizableKind,
  isPrivacyNormalized,
  privacyScopeForKind,
  withPrivacyNormalization,
} from "./imagePrivacy";

/** What one asset's normalisation attempt did. */
export const PRIVACY_RESULT = Object.freeze({
  /** The bytes were re-encoded and the record now carries the marker. */
  NORMALIZED: "normalized",
  /** The bytes were inspected, found clean, and only the marker was written. */
  VERIFIED: "verified",
  /** It already carried the marker; nothing was read and nothing written. */
  ALREADY_NORMALIZED: "already-normalized",
  /**
   * There was nothing to do: a PDF source, or an ATTACHMENT whose bytes were
   * read and are not an accepted image — a document, left byte-for-byte alone
   * and deliberately not marked, because the marker is a statement about an
   * image. This is the one outcome the uploader accepts without a marker, and
   * only for a non-picture kind.
   */
  NOT_APPLICABLE: "not-applicable",
  /** This browser no longer holds it. */
  MISSING: "missing",
  /** It belongs to another workspace — never read, never rewritten. */
  FOREIGN_WORKSPACE: "foreign-workspace",
  /**
   * It is not owed to the cloud any more, or is already recorded as stored
   * there: an immutable cloud object, and this pass does not touch it.
   */
  ALREADY_STORED: "already-stored",
  /** The record changed under us; the next pass repeats the work. */
  CHANGED: "changed",
  /** The bytes could not be decoded or re-encoded. Nothing was written. */
  FAILED: "failed",
});

/** The outcomes that leave the asset safe to upload. */
const SATISFIED = new Set([
  PRIVACY_RESULT.NORMALIZED,
  PRIVACY_RESULT.VERIFIED,
  PRIVACY_RESULT.ALREADY_NORMALIZED,
  PRIVACY_RESULT.NOT_APPLICABLE,
]);

export function isPrivacySatisfied(status) {
  return SATISFIED.has(status);
}

/** The store boundary, injectable so the flow is testable without a canvas. */
export const defaultPrivacyDeps = Object.freeze({
  listPending: (workspaceId) => listPendingAssetUploads(workspaceId),
  /**
   * The SHARED privacy core (src/lib/imageProcessing.js) — the same one the
   * creation paths use, so a stored asset and a newly-created one can never
   * be normalised by two different implementations.
   */
  prepare: (blob, options, deps) => normalizeImageBytesForPrivacy(blob, options, deps),
});

function withDeps(deps) {
  return deps ? { ...defaultPrivacyDeps, ...deps } : defaultPrivacyDeps;
}

/**
 * Read ONE asset record (with its Blob) for this pass.
 *
 * It goes straight to the asset store rather than through the shared read
 * boundary on purpose: a remote read-through would DOWNLOAD the workspace's
 * cloud copy, and an asset that is in the cloud is exactly the asset this
 * pass must not touch.
 */
function readAssetRecord(assetId) {
  return assetDbTransaction(ASSET_STORE, "readonly", (stores) => stores[ASSET_STORE].get(assetId));
}

/* ------------------------------- one asset -------------------------------- */

/**
 * Bring ONE stored image asset up to the current privacy policy.
 *
 * @param {{workspaceId: string, assetId: string, record?: object}} input
 *        `record` is the caller's already-read record (the upload engine has
 *        one in hand); it is re-read here when absent, and re-read again
 *        inside the write transaction either way.
 * @returns {Promise<{status: string, assetId: string, record: object|null}>}
 *          never throws for one asset's failure.
 */
export async function normalizeStoredAssetPrivacy({ workspaceId, assetId, record = null } = {}, deps = null) {
  const d = withDeps(deps);
  const now = typeof d.now === "function" ? d.now : Date.now;
  const out = (status, updated = null) => ({ status, assetId, record: updated });

  if (!isQueueableWorkspaceId(workspaceId) || !isValidAssetSegment(assetId)) {
    return out(PRIVACY_RESULT.MISSING);
  }

  let current = record;
  if (!current) {
    try {
      current = await readAssetRecord(assetId);
    } catch {
      return out(PRIVACY_RESULT.FAILED);
    }
  }
  if (!current || !current.id) return out(PRIVACY_RESULT.MISSING);
  const owner = isQueueableWorkspaceId(current.workspaceId) ? current.workspaceId : null;
  if (owner && owner !== workspaceId) return out(PRIVACY_RESULT.FOREIGN_WORKSPACE);

  // WHICH POLICY APPLIES — from the MEDIA, not from the control that created
  // the asset. A picture kind is always inspected and fails closed; an
  // attachment kind is inspected too, because its bytes may BE an image, and
  // only the bytes can say so.
  const scope = privacyScopeForKind(current.kind);
  if (scope === PRIVACY_SCOPE.EXEMPT) return out(PRIVACY_RESULT.NOT_APPLICABLE, current);
  if (isPrivacyNormalized(current.metadata)) return out(PRIVACY_RESULT.ALREADY_NORMALIZED, current);
  if (!current.blob || typeof current.blob.size !== "number" || current.blob.size === 0) {
    return out(PRIVACY_RESULT.MISSING);
  }

  // Inspect, and re-encode only what carries metadata — the SHARED core, the
  // same one every creation path uses. `assumeImage` is the whole difference
  // between the two scopes: a picture whose format we cannot read is still
  // re-encoded through the decoder, while an attachment that is not an image
  // is a document and comes back untouched.
  let prepared;
  try {
    prepared = await d.prepare(
      current.blob,
      { assumeImage: scope === PRIVACY_SCOPE.PICTURE, fallbackMimeType: current.mimeType || null },
      deps || undefined
    );
  } catch {
    return out(PRIVACY_RESULT.FAILED);
  }
  if (!prepared) return out(PRIVACY_RESULT.FAILED);

  // A document. Nothing is written and nothing is marked — the marker is a
  // statement about an image, and this is not one. The uploader reads this
  // outcome as "there was nothing to do", which is the only case in which it
  // accepts an unmarked asset.
  if (prepared.image === false) return out(PRIVACY_RESULT.NOT_APPLICABLE, current);
  if (!prepared.privacy) return out(PRIVACY_RESULT.FAILED);

  if (!prepared.changed) {
    // The bytes are already clean. Only the MARKER is written, so the next
    // pass and every upload retry skip the inspection entirely.
    return commit(
      { workspaceId, assetId, previous: current, blob: null, mimeType: null, at: now() },
      prepared.privacy,
      PRIVACY_RESULT.VERIFIED
    );
  }

  return commit(
    {
      workspaceId,
      assetId,
      previous: current,
      blob: prepared.blob,
      mimeType: prepared.mimeType || current.mimeType || null,
      at: now(),
    },
    prepared.privacy,
    PRIVACY_RESULT.NORMALIZED
  );
}

/**
 * The write: the record and the queue entry, in ONE transaction, only if
 * everything the decision rested on is still true.
 *
 * `blob` is null for a marker-only update (the bytes were already clean), in
 * which case the stored Blob, size, MIME type and `updatedAt` are all left
 * exactly as they are: nothing about the asset changed, so nothing about the
 * asset is rewritten except the statement that it has been checked.
 */
function commit({ workspaceId, assetId, previous, blob, mimeType, at }, mark, successStatus) {
  const previousSize = typeof previous.size === "number" ? previous.size : previous.blob.size;
  return assetDbTransaction(
    [ASSET_STORE, ASSET_UPLOAD_QUEUE_STORE, ASSET_REMOTE_INDEX_STORE],
    "readwrite",
    (stores) => {
      let outcome = { status: PRIVACY_RESULT.CHANGED, assetId, record: null };
      const assets = stores[ASSET_STORE];
      const queue = stores[ASSET_UPLOAD_QUEUE_STORE];
      const remote = stores[ASSET_REMOTE_INDEX_STORE];

      const read = assets.get(assetId);
      read.onsuccess = () => {
        const record = read.result;
        if (!record || !record.id) {
          outcome = { status: PRIVACY_RESULT.MISSING, assetId, record: null };
          return;
        }
        const owner = isQueueableWorkspaceId(record.workspaceId) ? record.workspaceId : null;
        if (owner && owner !== workspaceId) {
          outcome = { status: PRIVACY_RESULT.FOREIGN_WORKSPACE, assetId, record: null };
          return;
        }
        if (isPrivacyNormalized(record.metadata)) {
          // Another pass finished first. That is success, not a conflict.
          outcome = { status: PRIVACY_RESULT.ALREADY_NORMALIZED, assetId, record };
          return;
        }
        // The bytes that were transformed must still be the bytes that are
        // stored. Anything else and the transformation describes a file that
        // is no longer here.
        const size = typeof record.size === "number" ? record.size : record.blob ? record.blob.size : null;
        if (size !== previousSize || (record.updatedAt || null) !== (previous.updatedAt || null)) {
          outcome = { status: PRIVACY_RESULT.CHANGED, assetId, record: null };
          return;
        }

        const remoteRead = remote.get([workspaceId, assetId]);
        remoteRead.onsuccess = () => {
          const known = remoteRead.result;
          if (known && known.state === REMOTE_ASSET_STATE.STORED) {
            // This browser has recorded the workspace as holding these bytes.
            // A stored object is immutable; nothing here rewrites one.
            outcome = { status: PRIVACY_RESULT.ALREADY_STORED, assetId, record: null };
            return;
          }
          const queueRead = queue.get([workspaceId, assetId]);
          queueRead.onsuccess = () => {
            const entry = queueRead.result;
            if (!entry) {
              // Nothing is owed: it has already been uploaded (the settlement
              // removes the entry), or it was never this workspace's to send.
              outcome = { status: PRIVACY_RESULT.ALREADY_STORED, assetId, record: null };
              return;
            }
            const next = blob
              ? {
                  ...record,
                  blob,
                  mimeType: mimeType || record.mimeType || null,
                  size: blob.size,
                  updatedAt: at,
                  metadata: withPrivacyNormalization(record.metadata, mark),
                }
              : { ...record, metadata: withPrivacyNormalization(record.metadata, mark) };
            assets.put(next);
            if (blob) {
              // The bytes are different ones now, so a retry gate set by a
              // failure against the OLD bytes no longer describes anything.
              queue.put({ ...entry, attempts: 0, nextAttemptAt: at, lastCode: null });
            }
            outcome = { status: successStatus, assetId, record: next };
          };
        };
      };
      return () => outcome;
    }
  )
    .then((outcome) => {
      // A re-armed entry is due again NOW, and the engine may be idle or
      // sitting on a long backoff against the OLD bytes. Told only after the
      // commit, and only when the queue row was actually rewritten.
      if (blob && outcome && outcome.status === successStatus) notifyAssetQueueWrite(workspaceId);
      return outcome;
    })
    .catch(() => ({ status: PRIVACY_RESULT.FAILED, assetId, record: null }));
}

/* -------------------------------- the pass -------------------------------- */

/** The lifecycle of one privacy pass, for the status surfaces. */
export const PRIVACY_PHASE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  DONE: "done",
  ERROR: "error",
});

/**
 * WHICH of a workspace's queued assets this pass would LOOK AT, without doing
 * any of it. The candidate set is the workspace's OWN upload queue filtered to
 * the governed kinds — pictures AND attachments, because an attachment's bytes
 * may be an image and only reading them can say. PDF sources and everything
 * already settled are not in it by construction, and another workspace's rows
 * cannot be addressed. An attachment that turns out to be a document is
 * reported `not-applicable` and nothing about it is written.
 */
export async function planImagePrivacyNormalization({ workspaceId, deps = null } = {}) {
  const d = withDeps(deps);
  if (!isQueueableWorkspaceId(workspaceId)) return { workspaceId: null, candidates: [] };
  let entries = [];
  try {
    entries = (await d.listPending(workspaceId)) || [];
  } catch {
    entries = [];
  }
  const candidates = entries
    .filter((entry) => entry && entry.workspaceId === workspaceId && entry.assetId)
    .filter((entry) => isPrivacyNormalizableKind(entry.kind))
    .map((entry) => ({ assetId: entry.assetId, kind: entry.kind }));
  return { workspaceId, candidates };
}

/**
 * Normalise every queued image of ONE workspace that still needs it.
 *
 * `isActive` is the session guard: a sign-out or an account switch stops the
 * pass BETWEEN assets, and everything already written is durable and correct.
 * `onProgress` reports real item counts — the surfaces show "n of m", never an
 * invented percentage.
 *
 * @returns {Promise<{workspaceId, total, normalized, verified, skipped,
 *                    failed, stopped}>}
 */
export async function runImagePrivacyNormalization({
  workspaceId,
  deps = null,
  isActive = () => true,
  onProgress = null,
} = {}) {
  const result = {
    workspaceId: isQueueableWorkspaceId(workspaceId) ? workspaceId : null,
    total: 0,
    done: 0,
    normalized: [],
    verified: [],
    skipped: [],
    failed: [],
    stopped: false,
  };
  if (!result.workspaceId || !isActive()) {
    result.stopped = !isActive();
    return result;
  }

  const plan = await planImagePrivacyNormalization({ workspaceId, deps });
  result.total = plan.candidates.length;
  if (result.total === 0) return result;
  if (onProgress) onProgress({ total: result.total, done: 0 });

  for (const candidate of plan.candidates) {
    if (!isActive()) {
      result.stopped = true;
      return result;
    }
    let outcome;
    try {
      outcome = await normalizeStoredAssetPrivacy({ workspaceId, assetId: candidate.assetId }, deps);
    } catch {
      outcome = { status: PRIVACY_RESULT.FAILED, assetId: candidate.assetId };
    }
    result.done += 1;
    if (outcome.status === PRIVACY_RESULT.NORMALIZED) result.normalized.push(candidate.assetId);
    else if (outcome.status === PRIVACY_RESULT.VERIFIED) result.verified.push(candidate.assetId);
    else if (outcome.status === PRIVACY_RESULT.FAILED) result.failed.push(candidate.assetId);
    else result.skipped.push(candidate.assetId);
    if (onProgress) onProgress({ total: result.total, done: result.done });
  }
  return result;
}

/* ------------------------------ status lines ------------------------------ */

/**
 * The pass's own line. It is about PREPARING files, never about uploading
 * them — the Phase 7.4 engine owns that and says so on its own line — and it
 * counts real items, so it can never show a percentage that means nothing.
 */
export function imagePrivacyStatusLine(status) {
  if (!status) return "";
  if (status.phase === PRIVACY_PHASE.ERROR) {
    return "Some images could not be prepared for secure sync. NoteWise will try again next time you sign in.";
  }
  if (status.phase === PRIVACY_PHASE.RUNNING) {
    const total = Number(status.total) || 0;
    if (total <= 0) return "";
    const done = Math.min(Number(status.done) || 0, total);
    const remaining = Math.max(total - done, 0);
    if (remaining <= 0) return "";
    return `Preparing ${remaining} ${remaining === 1 ? "image" : "images"} for secure sync…`;
  }
  if (status.phase !== PRIVACY_PHASE.DONE || !status.result) return "";
  const changed = status.result.normalized.length;
  if (changed <= 0) return "";
  return `${changed} ${changed === 1 ? "image was" : "images were"} prepared for secure sync`;
}

/** "1 image could not be prepared", or "" when everything resolved. */
export function imagePrivacyAttentionLine(status) {
  const result = status && status.phase === PRIVACY_PHASE.DONE ? status.result : null;
  const stuck = result ? result.failed.length : 0;
  if (stuck <= 0) return "";
  return `${stuck} ${stuck === 1 ? "image could" : "images could"} not be prepared for secure sync`;
}
