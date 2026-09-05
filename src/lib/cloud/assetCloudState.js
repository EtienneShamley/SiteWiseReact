// src/lib/cloud/assetCloudState.js
//
// THE AUTHORITATIVE-CLOUD-STATE RULE for one local asset, as one pure
// function — shared by the legacy asset backfill (src/lib/assetBackfill.js)
// and the PDF source reconciliation (src/lib/pdfSourceUploads.js) so the two
// cannot answer "does the cloud already have this" differently.
//
// WHY THE LOCAL REMOTE INDEX IS NEVER CONSULTED. Phase 7.5 established that
// `assetRemoteIndex` is a discovery / performance cache and NOT lifecycle
// state: it can say `stored` for a document another device has since
// tombstoned or that never landed, and `tombstoned` for one since restored.
// Deciding "already stored" from it lets a referenced asset go without the
// upload identity it needs — and then it is never owed again. So the answer
// comes from the asset's CURRENT Firestore document, read through the
// workspace store's own `readAssetDocument` and validated through the cloud
// model, and from nothing else.
//
// The identity compared is the upload engine's own four facts
// (src/lib/cloud/assetUploadSync.js → `documentMatches`): kind, transport
// MIME, size, source asset.

import { CLOUD_ASSET_STATE, validateAssetDocument } from "./assetCloudModel";
import { resolveCloudTransportMime } from "./assetTransportMime";

/**
 * What the workspace's CURRENT Firestore document says about one referenced
 * local asset — and, from that alone, whether a queue identity is required.
 */
export const CLOUD_ASSET_DECISION = Object.freeze({
  /** Validated, `stored`, identity matches: the cloud has it. No queue. */
  STORED: "stored",
  /** No document: the cloud does not have it. Queue. */
  ABSENT: "absent",
  /** Validated, identity matches, `tombstoned`. Queued — see below. */
  TOMBSTONED: "tombstoned",
  /** Validated but describes a DIFFERENT asset. Reported; nothing written. */
  CONFLICT: "conflict",
  /** Does not validate. Reported; nothing written. */
  MALFORMED: "malformed",
  /** The cloud could not be asked (no boundary, offline, refused). Queue. */
  UNKNOWN: "unknown",
});

/**
 * The immutable identity a cloud document must agree with. The MIME is
 * compared only when the local record can resolve one; a record whose type
 * cannot be resolved is compared on the other three, because the engine will
 * refuse to upload it anyway and the cloud copy is what the workspace has.
 */
export function cloudIdentityMatches(asset, local) {
  if (asset.assetKind !== local.kind) return false;
  if (Number(asset.size) !== Number(local.size)) return false;
  if ((asset.sourceAssetId || null) !== (local.sourceAssetId || null)) return false;
  const transport = resolveCloudTransportMime({ assetKind: local.kind, mimeType: local.mimeType, name: local.name });
  if (transport.ok && transport.mimeType !== asset.mimeType) return false;
  return true;
}

/**
 * The rule, over `doc` = `{ exists, fields }` as the workspace store returns
 * it (`null` when the cloud could not be asked):
 *
 *   document validates, `stored`, identity matches   → STORED     no queue
 *   document absent                                  → ABSENT     queue
 *   document validates, identity DIFFERS             → CONFLICT   no queue, report,
 *                                                                 nothing overwritten
 *   document does not validate                       → MALFORMED  no queue, report,
 *                                                                 nothing overwritten
 *   document validates, identity matches, tombstoned → TOMBSTONED queue (below)
 *   cloud unreachable / no boundary / refused        → UNKNOWN    queue (conservative)
 *
 * TOMBSTONED IS QUEUED, NOT RESTORED HERE. The only approved `tombstoned →
 * stored` write in the product is the upload engine's (Phase 7.4: a matching
 * tombstoned document is restored when the asset is uploaded because a
 * reference for it exists locally). Queueing hands it to that approved path;
 * nothing here writes to the cloud.
 *
 * @param {{ workspaceId: string, assetId: string,
 *           local: { kind, mimeType, name, size, sourceAssetId },
 *           doc: { exists: boolean, fields: object|null } | null }} input
 * @returns {{ decision: string, queue: boolean, reason?: string, asset?: object }}
 */
export function resolveCloudAssetState({ workspaceId, assetId, local, doc } = {}) {
  if (!doc || typeof doc !== "object") return { decision: CLOUD_ASSET_DECISION.UNKNOWN, queue: true };
  if (!doc.exists) return { decision: CLOUD_ASSET_DECISION.ABSENT, queue: true };
  const check = validateAssetDocument({ workspaceId, id: assetId, fields: doc.fields });
  if (!check.ok) return { decision: CLOUD_ASSET_DECISION.MALFORMED, queue: false, reason: check.reason };
  const asset = check.asset;
  if (!cloudIdentityMatches(asset, local || {})) {
    return { decision: CLOUD_ASSET_DECISION.CONFLICT, queue: false, asset };
  }
  if (asset.state === CLOUD_ASSET_STATE.TOMBSTONED) {
    return { decision: CLOUD_ASSET_DECISION.TOMBSTONED, queue: true, asset };
  }
  return { decision: CLOUD_ASSET_DECISION.STORED, queue: false, asset };
}

/**
 * Ask the cloud through an injected boundary and apply the rule. No boundary,
 * or a boundary that throws, is UNKNOWN — never a guess in either direction.
 *
 * @param {Function|null} readCloudAssetDocument `(workspaceId, assetId) => Promise<{ exists, fields }>`
 */
export async function readCloudAssetState(readCloudAssetDocument, { workspaceId, assetId, local } = {}) {
  if (typeof readCloudAssetDocument !== "function") {
    return resolveCloudAssetState({ workspaceId, assetId, local, doc: null });
  }
  let doc = null;
  try {
    doc = await readCloudAssetDocument(workspaceId, assetId);
  } catch {
    doc = null;
  }
  return resolveCloudAssetState({ workspaceId, assetId, local, doc });
}

/** The reported reason for each conflict decision — one vocabulary for the
 *  backfill's and the PDF reconciler's `conflicts` lists. */
export const CLOUD_CONFLICT_REASON = Object.freeze({
  [CLOUD_ASSET_DECISION.CONFLICT]: "cloud-identity-conflict",
  [CLOUD_ASSET_DECISION.MALFORMED]: "malformed-cloud-record",
});

/** True when the decision means "report it; write nothing to the cloud". */
export function isCloudAssetConflict(decision) {
  return decision === CLOUD_ASSET_DECISION.CONFLICT || decision === CLOUD_ASSET_DECISION.MALFORMED;
}
