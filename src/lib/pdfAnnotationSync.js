// src/lib/pdfAnnotationSync.js
//
// PDF ANNOTATIONS in the account (Production Readiness Phase 7.7): the
// bridge between the IndexedDB annotation record (src/lib/pdfStorage.js →
// `pdfWorkspaceAnnotations`) and the Phase 6 cloud layer — the outbox, the
// sync engine, the hydration. Firestore destination:
//
//   workspaces/{wid}/pdfAnnotations/{pdfId}   { items: [...] }   (JSON payload,
//                                              chunked past the inline budget)
//
// There is NO second sync architecture here. A change is an ordinary outbox
// IDENTITY (`pdfAnnotations/<pdfId>`) in the workspace's existing outbox; the
// existing engine drains it, reading the payload at flush time through the
// PAYLOAD PROVIDER below so the newest saved array always wins; hydration
// arrives through the same workspace read as every other collection.
//
// THE INVARIANT, AND WHY IT IS DIFFERENT FROM THE MIRROR'S. The annotation
// record (IndexedDB) and the outbox (localStorage) are two storage systems
// with no transaction across them, so this module never pretends the pair
// is atomic. Instead:
//
//   1. the record is saved with `cloudDirty: true` and a bumped `revision`
//      IN ITS OWN TRANSACTION — "saved" and "owed" are one durable fact;
//   2. the outbox identity is written AFTER, and the engine is told;
//   3. a crash between 1 and 2 loses only the identity, and
//      `reconcilePdfAnnotationOutbox` re-derives it from the dirty flag at
//      the next session start — never a permanently unsyncable record;
//   4. after Firestore ACCEPTED a write, the dirty flag is cleared ONLY if
//      the record still carries the revision that was sent (the engine
//      passes it back as the settle token): a save that landed while the
//      upload was in flight keeps its flag and its newer outbox stamp, and
//      is sent next.
//
// OWNERSHIP. Every workspace record is keyed by [workspaceId, documentId];
// every function here takes the workspace EXPLICITLY, captured by the caller
// when the change was made, never read from the ambient durable scope inside
// asynchronous work — so a save scheduled under one account can never land,
// enqueue or settle as another. Records that predate workspace scoping live
// in the legacy store and are associated with a workspace only when that
// workspace's CURRENT PDF registry names the exact document id AND the Phase
// 7.6 adoption authority allows it (src/lib/assetBackfill.js →
// `resolveAdoptionAuthority`) — never merely because someone is signed in.
//
// PRECEDENCE at hydration, per document the cloud holds annotations for:
//   no local record            → written clean from the cloud
//   local record, clean        → refreshed from the cloud (the account is the
//                                 source of truth for a signed-in workspace)
//   local record, DIRTY        → kept; its outbox obligation is ensured
//   another workspace's record → never read, never written (the key forbids it)
//   legacy unscoped record     → associated first (above); when the account
//                                 ALREADY holds a valid document for it the
//                                 legacy copy is left where it is and the
//                                 cloud wins — a pre-account snapshot never
//                                 overwrites what the account has
//   malformed cloud document   → excluded, reported, quarantined by the
//                                 engine so no local value overwrites it; the
//                                 local record is untouched
//   cloud document for a PDF the registry no longer names
//                              → ignored (an orphan of a deletion whose cloud
//                                 delete did not land; it can never rehydrate
//                                 because hydration requires the registry)
//
// SEMANTICS. Last-write-wins on the WHOLE annotation array, exactly like the
// rest of Phase 6: no merge, no CRDT, no live listener — cross-device changes
// arrive at the next session start. Two devices editing the same PDF's
// annotations concurrently will end with whichever confirmed write is later.

import { CLOUD_COLLECTION, buildEntityDocument, validatePdfAnnotationPayload } from "./cloud/cloudModel";
import { captureExternalChanges } from "./cloud/cloudCapture";
import { OUTBOX_OP, hasOutboxEntry, outboxEntryKey } from "./cloud/cloudOutbox";
import { DURABLE_KEYS, DURABLE_SCOPE_KIND, RECORD_STATE, readDurableRecord } from "./durableStorage";
import { readLocalMigrationState } from "./cloud/localMigration";
import { readLocalDataBinding } from "./localDataBinding";
import { resolveAdoptionAuthority } from "./assetBackfill";
import {
  adoptLegacyAnnotations,
  hydrateWorkspaceAnnotations,
  listLegacyAnnotationIds,
  listWorkspaceAnnotationRecords,
  loadAnnotationRecord,
  removeAnnotations,
  saveAnnotations,
  settleWorkspaceAnnotations,
} from "./pdfStorage";

export const PDF_ANNOTATIONS_COLLECTION = CLOUD_COLLECTION.PDF_ANNOTATIONS;

/** The error code the payload provider throws for an unreadable local record. */
export const LOCAL_PAYLOAD_MALFORMED_CODE = "local-payload-malformed";

function isWorkspaceId(value) {
  return typeof value === "string" && value.length > 0;
}

function upsertChange(pdfId) {
  return { collection: PDF_ANNOTATIONS_COLLECTION, id: pdfId, op: OUTBOX_OP.UPSERT };
}

/** How many chunk documents an annotation array occupies in the cloud. */
export function annotationChunkCount(workspaceId, pdfId, items) {
  const built = buildEntityDocument({
    workspaceId: workspaceId || "-",
    collection: PDF_ANNOTATIONS_COLLECTION,
    id: pdfId,
    payload: { items: Array.isArray(items) ? items : [] },
  });
  return built.chunks.length;
}

/* ------------------------- the live writers ----------------------------- */
/* The editor's writers (src/lib/pdfAnnotationWriter.js) register here per   */
/* document, so the application state can bring them to a defined point     */
/* around a DESTRUCTIVE transition of that document without relying on timer */
/* timing or React's unmount order:                                          */
/*   drain   BEFORE the transition — flush what is pending and await every   */
/*           write in flight, so an unsaved edit is durable (and survives a  */
/*           refused transition) and no pre-transition write can start after */
/*           the transition's own save;                                      */
/*   reset   AFTER a committed replacement — drop anything scheduled in the  */
/*           window and open a new generation; the writer keeps working for  */
/*           the replacement file;                                           */
/*   retire  AFTER a committed deletion — reset, and refuse every later      */
/*           change and the unmount flush: nothing can recreate the record   */
/*           or turn the cloud delete back into an update.                   */

const liveWriters = new Map(); // documentId → Set<writer>

export function registerPdfAnnotationWriter(documentId, writer) {
  if (!documentId || !writer) return () => {};
  if (!liveWriters.has(documentId)) liveWriters.set(documentId, new Set());
  const set = liveWriters.get(documentId);
  set.add(writer);
  return () => {
    set.delete(writer);
    if (set.size === 0) liveWriters.delete(documentId);
  };
}

function writersOf(documentId) {
  return Array.from(liveWriters.get(documentId) || []);
}

/** Flushes and awaits every live writer of a document. `{ ok, error }`. */
export async function drainPdfAnnotationWriters(documentId) {
  let error = null;
  for (const writer of writersOf(documentId)) {
    try {
      const result = await writer.drain();
      if (result && result.ok === false && !error) error = result.error || new Error("annotation save failed");
    } catch (err) {
      if (!error) error = err;
    }
  }
  return { ok: error === null, error };
}

/** After a committed replacement: nothing scheduled before it may run. */
export function resetPdfAnnotationWriters(documentId) {
  for (const writer of writersOf(documentId)) writer.reset();
}

/** After a committed deletion: nothing may ever write this document again. */
export function retirePdfAnnotationWriters(documentId) {
  for (const writer of writersOf(documentId)) writer.retire();
}

/** Test-only. */
export function __resetPdfAnnotationWritersForTests() {
  liveWriters.clear();
}

/* ------------------------------ the writes ------------------------------ */

/**
 * Saves a document's annotations locally and, under a workspace, records
 * that the account is owed them. Local-first: this resolves as soon as the
 * IndexedDB record is durable; the cloud is never awaited. Without a
 * workspace it is exactly the pre-7.7 local save.
 */
export async function persistPdfAnnotations(pdfId, items, { workspaceId = null } = {}) {
  const saved = await saveAnnotations(pdfId, items, { workspaceId });
  if (isWorkspaceId(workspaceId)) captureExternalChanges(workspaceId, [upsertChange(pdfId)]);
  return saved;
}

/**
 * Removes a document's annotations locally and, under a workspace, records
 * that the account must lose its document too (the same confirmed-first
 * deletion order as the registry: the caller has already removed the PDF).
 * The cloud obligation is captured even when the local removal is refused —
 * the PDF is gone from the registry either way — and the refusal is then
 * rethrown for the caller to report.
 */
export async function removePdfAnnotations(pdfId, { workspaceId = null } = {}) {
  if (!isWorkspaceId(workspaceId)) {
    await removeAnnotations(pdfId);
    return;
  }
  let chunks = 0;
  try {
    const record = await loadAnnotationRecord(pdfId, { workspaceId });
    if (record) chunks = annotationChunkCount(workspaceId, pdfId, record.items);
  } catch {
    // Unknown chunk count: the parent document is still deleted; orphaned
    // chunk documents can never be read (hydration reads chunks only through
    // a parent that says `chunked`).
  }
  let failure = null;
  try {
    await removeAnnotations(pdfId, { workspaceId });
  } catch (error) {
    failure = error;
  }
  captureExternalChanges(workspaceId, [{ collection: PDF_ANNOTATIONS_COLLECTION, id: pdfId, op: OUTBOX_OP.DELETE, chunks }]);
  if (failure) throw failure;
}

/* -------------------------- the payload provider ------------------------ */

/**
 * What the sync engine calls for a `pdfAnnotations` outbox entry
 * (src/lib/cloud/cloudSync.js → `payloadProviders`): the CURRENT local record
 * at flush time, and the settle that clears its dirty flag only for the
 * revision that was actually sent.
 */
export const pdfAnnotationPayloadProvider = Object.freeze({
  async load(workspaceId, pdfId) {
    const record = await loadAnnotationRecord(pdfId, { workspaceId });
    if (!record) return undefined;
    if (!Array.isArray(record.items)) {
      throw Object.assign(new Error("The stored annotation record is not an array"), { code: LOCAL_PAYLOAD_MALFORMED_CODE });
    }
    return { payload: { items: record.items }, token: record.revision };
  },
  async settle(workspaceId, pdfId, token) {
    return settleWorkspaceAnnotations(workspaceId, pdfId, token);
  },
});

/* ------------------------------ the registry ---------------------------- */

/**
 * The document ids of a workspace's CURRENT PDF registry, read from its own
 * mirror scope — never the ambient scope — with the record's state, so a
 * caller can tell "no PDFs" from "the registry could not be read".
 */
export function currentPdfRegistry(workspaceId, storage) {
  const scope = Object.freeze({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: workspaceId });
  const result = readDurableRecord(DURABLE_KEYS.pdfDocs, { scope, storage });
  const value = result.value;
  const map = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { state: result.state, ids: new Set(Object.keys(map).filter((id) => id && map[id] && typeof map[id] === "object")) };
}

/* ----------------------------- the repairs ------------------------------ */

/**
 * THE ATOMICITY REPAIR (invariant 3 above), for one workspace at session
 * start: every DIRTY record of a current PDF that has no outbox identity
 * gets one again; every record of a PDF the registry no longer names is
 * removed (the orphan of a deletion — it must never be uploaded back). The
 * prune is refused when the registry record is absent or unreadable: an
 * empty answer that is not a real "no PDFs" must not delete anything.
 * Idempotent; never touches another workspace's rows.
 */
export async function reconcilePdfAnnotationOutbox({ workspaceId, storage } = {}) {
  const out = { enqueued: [], pruned: [], skipped: [] };
  if (!isWorkspaceId(workspaceId)) return out;
  const registry = currentPdfRegistry(workspaceId, storage);
  const records = await listWorkspaceAnnotationRecords(workspaceId);
  for (const record of records) {
    const id = record.documentId;
    if (!registry.ids.has(id)) {
      if (registry.state === RECORD_STATE.OK) {
        await removeAnnotations(id, { workspaceId });
        out.pruned.push(id);
      } else {
        out.skipped.push(id);
      }
      continue;
    }
    if (record.cloudDirty === false) continue;
    if (hasOutboxEntry(workspaceId, PDF_ANNOTATIONS_COLLECTION, id, storage)) continue;
    if (captureExternalChanges(workspaceId, [upsertChange(id)])) out.enqueued.push(id);
  }
  return out;
}

/**
 * Associates LEGACY (unscoped, pre-7.7) annotation records with a workspace:
 * only documents the workspace's current registry names, only when the
 * Phase 7.6 authority allows adopting this browser's pre-account data into
 * this workspace, and only when the account does not already hold a valid
 * document for it (`cloudIds`; null when the cloud could not be asked —
 * offline — in which case the local record is adopted conservatively as
 * owed). An adopted record is dirty and gets its outbox identity. Nothing is
 * duplicated: the record MOVES stores. A refusal leaves everything in place
 * and reports it.
 */
export async function associateLegacyPdfAnnotations({ workspaceId, uid = null, storage, cloudIds = null } = {}) {
  const out = { adopted: [], refused: [], superseded: [], authority: null };
  if (!isWorkspaceId(workspaceId)) return out;
  const registry = currentPdfRegistry(workspaceId, storage);
  if (registry.ids.size === 0) return out;
  const legacyIds = await listLegacyAnnotationIds();
  const candidates = legacyIds.filter((id) => registry.ids.has(id));
  if (candidates.length === 0) return out;
  const authority = resolveAdoptionAuthority({
    uid,
    workspaceId,
    migration: readLocalMigrationState(storage),
    binding: readLocalDataBinding(storage),
  });
  out.authority = authority;
  if (!authority.allowed) {
    out.refused = candidates;
    return out;
  }
  for (const id of candidates) {
    if (cloudIds && cloudIds.has(id)) {
      out.superseded.push(id);
      continue;
    }
    const result = await adoptLegacyAnnotations(id, workspaceId);
    if (!result.adopted) continue;
    out.adopted.push(id);
    captureExternalChanges(workspaceId, [upsertChange(id)]);
  }
  return out;
}

/**
 * Places the account's annotation documents into the workspace's IndexedDB
 * records, by the precedence in the header. `entities` is
 * `{ [pdfId]: payload }` as the workspace hydration validated it
 * (src/lib/cloud/workspaceHydration.js → `deferred.pdfAnnotations`).
 */
export async function hydratePdfAnnotations({ workspaceId, entities, storage, pendingKeys = new Set(), onMalformed = null } = {}) {
  const out = { created: 0, refreshed: 0, kept: 0, orphans: 0, malformed: [] };
  if (!isWorkspaceId(workspaceId)) return out;
  const registry = currentPdfRegistry(workspaceId, storage);
  for (const id of Object.keys(entities || {})) {
    const check = validatePdfAnnotationPayload(entities[id]);
    if (!check.ok) {
      const entry = { collection: PDF_ANNOTATIONS_COLLECTION, id, reason: check.reason };
      out.malformed.push(entry);
      if (onMalformed) onMalformed(entry);
      continue;
    }
    if (!registry.ids.has(id)) {
      out.orphans += 1;
      continue;
    }
    const result = await hydrateWorkspaceAnnotations(workspaceId, id, check.items);
    if (result.applied) {
      if (result.reason === "created") out.created += 1;
      else out.refreshed += 1;
      continue;
    }
    out.kept += 1;
    if (!pendingKeys.has(outboxEntryKey(PDF_ANNOTATIONS_COLLECTION, id))) captureExternalChanges(workspaceId, [upsertChange(id)]);
  }
  return out;
}
