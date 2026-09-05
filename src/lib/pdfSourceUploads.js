// src/lib/pdfSourceUploads.js
//
// The upload IDENTITY of a PDF's source bytes — and the repair that makes
// that identity recoverable (Production Readiness Phase 7.4).
//
// WHY THIS MODULE EXISTS. Every other asset gets its queue entry in the SAME
// IndexedDB transaction as its bytes (src/lib/assetStorage.js →
// `saveNewAsset`), so "the asset exists locally" and "the cloud is owed it"
// can never disagree. A PDF's source bytes cannot: they live in a DIFFERENT
// database (`notewise-pdf-editor` → `pdfDocBytes`, keyed by the document's
// source id) and IndexedDB has no transaction spanning two databases. Copying
// PDF bytes into the asset store to buy that atomicity was considered and
// rejected — it would double every PDF on the device and create a second copy
// that could disagree with the first.
//
// SO THE INVARIANT IS DIFFERENT, AND WEAKER ON PURPOSE:
//
//   the bytes and the registry record are confirmed FIRST, and the queue
//   identity is written after
//
// which means the one thing that can be lost is the KNOWLEDGE that a PDF is
// owed — never the PDF. That loss is repairable from durable state alone, and
// `reconcilePdfSourceUploads` is the repair: it looks at the workspace's
// CURRENT PDF documents, and anything whose bytes are here, whose cloud copy
// is not known to exist, and which nothing has queued, becomes owed again.
// A crash between the two steps therefore costs one reconciliation pass, not
// a permanently unsyncable document.
//
// WHAT THIS IS NOT. It is not the legacy asset backfill (Phase 7.6): it reads
// the CURRENT PDF registry of ONE workspace and nothing else — no reference
// sweep, no historical sources, no other asset kind.
//
// WHAT "THE CLOUD ALREADY HAS IT" MEANS HERE (corrected 2026-09-05). It is
// decided from the source's CURRENT Firestore asset document, read through
// the injected workspace-store boundary and validated through the cloud
// model — the one shared rule in src/lib/cloud/assetCloudState.js — and NEVER
// from `assetRemoteIndex`, which Phase 7.5 established is a cache and can be
// stale in both directions. A first cut of this module consulted the index;
// a stale `stored` entry over an absent document would have left a current
// PDF permanently un-owed. With no boundary, or the cloud unreachable, the
// answer is conservative: the identity is ensured and the idempotent uploader
// settles it later.

import {
  enqueueAssetUpload,
  getAssetUpload,
  isQueueableWorkspaceId,
  listPendingAssetUploads,
  settleAssetUpload,
} from "./assetUploadQueue";
import { ASSET_KIND_PDF_SOURCE, localAssetExists, localAssetSize } from "./localAssetCache";
import { CLOUD_CONFLICT_REASON, isCloudAssetConflict, readCloudAssetState } from "./cloud/assetCloudState";
import { activeAssetWorkspaceId } from "./assetStorage";
import { isValidAssetSegment } from "./cloud/assetPaths";
import { getPdfDocs, pdfSourceId } from "./pdfDocuments";

/** The kind every entry this module writes carries. */
export const PDF_SOURCE_UPLOAD_KIND = ASSET_KIND_PDF_SOURCE;

function resolveWorkspace(workspaceId) {
  const explicit = isQueueableWorkspaceId(workspaceId) ? workspaceId : null;
  if (explicit) return explicit;
  // A PDF created outside a workspace is owed to nobody, exactly as a
  // local-only asset is. `activeAssetWorkspaceId` is the same session
  // boundary every other creation path reads.
  return activeAssetWorkspaceId();
}

/**
 * The source ids of the workspace's CURRENT PDF documents.
 *
 * The registry is a durable, workspace-SCOPED record: it answers for whichever
 * workspace the durable scope is on. A caller that names a workspace therefore
 * gets an EMPTY list unless that is the workspace whose registry is loaded —
 * a stale session must never answer for another one.
 */
export function currentPdfSourceIds(workspaceId) {
  const active = activeAssetWorkspaceId();
  if (!active) return [];
  if (isQueueableWorkspaceId(workspaceId) && workspaceId !== active) return [];
  const ids = [];
  for (const doc of Object.values(getPdfDocs() || {})) {
    const sourceId = pdfSourceId(doc);
    if (isValidAssetSegment(sourceId)) ids.push(sourceId);
  }
  return ids;
}

/**
 * Record that the workspace owes the cloud one PDF's source bytes.
 *
 * Called AFTER the bytes and the registry record are confirmed, so a refusal
 * here can only lose the knowledge, never the document — and
 * `reconcilePdfSourceUploads` recovers it. Resolves null when there is no
 * workspace to owe it to.
 */
export async function enqueuePdfSourceUpload(sourceId, { workspaceId, at } = {}) {
  const owner = resolveWorkspace(workspaceId);
  if (!owner || !isValidAssetSegment(sourceId)) return null;
  return enqueueAssetUpload({
    workspaceId: owner,
    assetId: sourceId,
    kind: PDF_SOURCE_UPLOAD_KIND,
    at,
  });
}

/**
 * The workspace no longer owes these source bytes — the file was replaced
 * before it was ever uploaded, or the document was deleted.
 *
 * It removes ONLY the pending local obligation, and cloud state plays no
 * part in that decision: a queue row is, by construction, an upload that has
 * not been SETTLED (settlement deletes the row in the same transaction that
 * records the object — src/lib/assetUploadQueue.js), so releasing it can
 * never un-know an object the account holds. An object that did reach the
 * cloud stays there for the collector under the owner-only delete rule; this
 * function deletes nothing in the cloud. The remote index is not consulted:
 * it is a cache, and a stale `stored` entry must never keep an obsolete
 * source's identity alive so that a deleted or replaced PDF is uploaded later.
 *
 * A RACE with an upload already in flight is safe in both directions. If the
 * upload finishes after this call, its atomic settlement writes the remote
 * index and deletes a queue row that is already gone — leaving an uploaded
 * object nothing references, which is exactly what the collector exists for.
 * If it has not started, the entry is simply gone before it could.
 *
 * @returns {{ released: boolean, reason: string|null }}
 */
export async function releasePdfSourceUpload(sourceId, { workspaceId } = {}) {
  const owner = resolveWorkspace(workspaceId);
  if (!owner || !isValidAssetSegment(sourceId)) return { released: false, reason: "no-workspace" };
  const entry = await getAssetUpload(owner, sourceId);
  if (!entry) return { released: false, reason: "not-queued" };
  await settleAssetUpload(owner, sourceId);
  return { released: true, reason: null };
}

/**
 * The PDF ATOMICITY REPAIR for one workspace, in both directions:
 *
 *   enqueue  a CURRENT document's source whose bytes are here and whose
 *            CURRENT cloud document does not say "stored and matching" — the
 *            state a crash between "the PDF is durable" and "the cloud is
 *            owed it" leaves behind, the state a PDF created before this
 *            phase existed is already in, and the state a source is in once
 *            its cloud document has gone or been tombstoned;
 *   settle   a queued `pdf-source` no current document names and whose bytes
 *            are gone — a superseded or deleted file whose release did not
 *            land. Nothing could ever upload it, so the workspace stops
 *            owing it.
 *
 * The cloud decision per source is the shared rule
 * (src/lib/cloud/assetCloudState.js): stored + matching → nothing owed;
 * absent → owed; tombstoned + matching → owed, so the upload engine's
 * approved restore runs; conflicting or malformed → NOT owed and reported in
 * `conflicts`, with nothing overwritten; unknown (no boundary, offline,
 * refused) → owed conservatively.
 *
 * Idempotent: a second pass over an unchanged workspace does nothing. It
 * never touches another workspace's rows, another asset kind, or any bytes.
 *
 * @param {{ workspaceId: string, sources?: string[],
 *           readCloudAssetDocument?: Function|null }} options
 *        `sources` — the current documents' source ids; defaults to the
 *        active workspace's registry. `readCloudAssetDocument` — the
 *        workspace store's `(workspaceId, assetId) => { exists, fields }`;
 *        absent means the cloud cannot be asked.
 * @returns {{ enqueued: string[], settled: string[],
 *             conflicts: { assetId: string, reason: string }[] }}
 */
export async function reconcilePdfSourceUploads({ workspaceId, sources, readCloudAssetDocument = null } = {}) {
  const owner = isQueueableWorkspaceId(workspaceId) ? workspaceId : null;
  if (!owner) return { enqueued: [], settled: [], conflicts: [] };
  const current = Array.isArray(sources) ? sources : currentPdfSourceIds(owner);
  const currentSet = new Set(current.filter((id) => isValidAssetSegment(id)));

  const enqueued = [];
  const conflicts = [];
  for (const sourceId of currentSet) {
    const size = await localAssetSize(sourceId, { kind: PDF_SOURCE_UPLOAD_KIND });
    if (!(size > 0)) continue;
    const cloud = await readCloudAssetState(readCloudAssetDocument, {
      workspaceId: owner,
      assetId: sourceId,
      local: { kind: PDF_SOURCE_UPLOAD_KIND, mimeType: "application/pdf", name: null, size, sourceAssetId: null },
    });
    if (isCloudAssetConflict(cloud.decision)) {
      conflicts.push({ assetId: sourceId, reason: CLOUD_CONFLICT_REASON[cloud.decision] });
      continue;
    }
    if (!cloud.queue) continue;
    const existing = await getAssetUpload(owner, sourceId);
    if (existing) continue;
    await enqueueAssetUpload({ workspaceId: owner, assetId: sourceId, kind: PDF_SOURCE_UPLOAD_KIND });
    enqueued.push(sourceId);
  }

  const settled = [];
  const pending = await listPendingAssetUploads(owner);
  for (const entry of pending) {
    if (entry.kind !== PDF_SOURCE_UPLOAD_KIND) continue;
    if (currentSet.has(entry.assetId)) continue;
    if (await localAssetExists(entry.assetId, { kind: PDF_SOURCE_UPLOAD_KIND })) continue;
    await settleAssetUpload(owner, entry.assetId);
    settled.push(entry.assetId);
  }

  return { enqueued, settled, conflicts };
}
