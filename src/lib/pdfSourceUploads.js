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

import {
  enqueueAssetUpload,
  getAssetUpload,
  isQueueableWorkspaceId,
  listPendingAssetUploads,
  settleAssetUpload,
} from "./assetUploadQueue";
import { REMOTE_ASSET_STATE, getRemoteAssetEntry } from "./assetRemoteIndex";
import { ASSET_KIND_PDF_SOURCE, localAssetExists } from "./localAssetCache";
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
 * It removes ONLY a pending identity. An entry whose bytes already reached
 * the cloud is left alone: the object exists, the remote index knows it, and
 * removing an object is the garbage collector's job under the owner-only
 * delete rule, not this one's.
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
  const remote = await getRemoteAssetEntry(owner, sourceId);
  if (remote && remote.state === REMOTE_ASSET_STATE.STORED) {
    return { released: false, reason: "already-stored" };
  }
  const entry = await getAssetUpload(owner, sourceId);
  if (!entry) return { released: false, reason: "not-queued" };
  await settleAssetUpload(owner, sourceId);
  return { released: true, reason: null };
}

/**
 * The PDF ATOMICITY REPAIR for one workspace, in both directions:
 *
 *   enqueue  a CURRENT document's source whose bytes are here, whose cloud
 *            copy is not known to exist, and which nothing has queued — the
 *            state a crash between "the PDF is durable" and "the cloud is
 *            owed it" leaves behind, and the state a PDF created before this
 *            phase existed is already in;
 *   settle   a queued `pdf-source` no current document names and whose bytes
 *            are gone — a superseded or deleted file whose release did not
 *            land. Nothing could ever upload it, so the workspace stops
 *            owing it.
 *
 * Idempotent: a second pass over an unchanged workspace does nothing. It
 * never touches another workspace's rows, another asset kind, or any bytes.
 *
 * @param {{ workspaceId: string, sources?: string[] }} options
 *        `sources` — the current documents' source ids; defaults to the
 *        active workspace's registry.
 * @returns {{ enqueued: string[], settled: string[] }}
 */
export async function reconcilePdfSourceUploads({ workspaceId, sources } = {}) {
  const owner = isQueueableWorkspaceId(workspaceId) ? workspaceId : null;
  if (!owner) return { enqueued: [], settled: [] };
  const current = Array.isArray(sources) ? sources : currentPdfSourceIds(owner);
  const currentSet = new Set(current.filter((id) => isValidAssetSegment(id)));

  const enqueued = [];
  for (const sourceId of currentSet) {
    const remote = await getRemoteAssetEntry(owner, sourceId);
    if (remote && remote.state === REMOTE_ASSET_STATE.STORED) continue;
    const existing = await getAssetUpload(owner, sourceId);
    if (existing) continue;
    if (!(await localAssetExists(sourceId, { kind: PDF_SOURCE_UPLOAD_KIND }))) continue;
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

  return { enqueued, settled };
}
