// src/lib/assetBackfill.js
//
// The LEGACY ASSET BACKFILL (Production Readiness Phase 7.6): the one place
// that decides which of this browser's pre-Phase-7.2 binaries belong to the
// workspace that is open, and the one place that associates them with it.
//
// THE PROBLEM IT SOLVES. Phase 6 moved a browser's structured data — notes,
// templates, PDF registry entries — into Firestore. The binaries those
// records reference did not move: they are still sitting in this browser's
// IndexedDB with NO `workspaceId` on them, because Phase 7.2 deliberately
// left every pre-existing record untouched (src/lib/assetStorage.js). A
// legacy record is readable in every scope for exactly that reason, and it is
// the reason the backfill has to exist: until an asset names a workspace, the
// upload engine does not know who owes it to the cloud, and it can never
// reach the account.
//
// THE RULE THAT MAKES IT SAFE. A legacy asset is adopted ONLY because the
// CURRENT WORKSPACE'S OWN DURABLE REFERENCES name that exact asset id. Never
// because of a filename, a MIME type, a timestamp, a note title, or "the
// account that happens to be signed in". A browser can have been used by more
// than one person; ownership is derived from references and from the recorded
// migration decision (src/lib/localDataBinding.js), or it is not derived at
// all and the situation is reported instead of guessed.
//
// WHAT IT NEVER DOES:
//   - touch an unreferenced legacy blob (it is left exactly where it is, and
//     costs the account nothing);
//   - read, re-tag or upload an asset another workspace already owns — that
//     is a reported conflict, never a rewrite;
//   - copy a Blob, change an asset id, or edit a single reference;
//   - copy PDF source bytes into the asset store (they stay in
//     `pdfDocBytes`, and their queue identity is repaired by the Phase 7.4
//     reconciler, which is the authority on which sources are CURRENT);
//   - remove local bytes. Nothing here deletes anything.
//
// CLOUD STATE IS READ FROM THE CLOUD, NEVER FROM THE LOCAL INDEX. Phase 7.5
// established that `assetRemoteIndex` is a discovery / performance cache and
// NOT authoritative lifecycle state: it can say `stored` for a document
// another device has since tombstoned or that never landed, and it can say
// `tombstoned` for one that has since been restored. Trusting it here would
// let a referenced asset be adopted WITHOUT the upload identity it needs and
// then never be owed again — a permanently unsynced file. So before any
// referenced asset is declared "already in the cloud", its CURRENT Firestore
// document is read through the existing workspace-store boundary and
// validated through the cloud model (`resolveCloudAssetState`), and the
// decision — queue or not — is passed INTO the adoption transaction, which
// consults no cache of its own. When the cloud cannot be asked at all, the
// answer is conservative: a queue identity is ensured, because the Phase 7.4
// engine is idempotent and settles it with zero writes if the object is
// already there.
//
// SHAPE. One PURE-ish planning layer (`planAssetBackfill` — every store it
// touches is injectable and it writes nothing) and one small runner
// (`runAssetBackfill`). React components call the runner through
// src/context/DataScopeContext.js; none of them reaches IndexedDB.

import { listAssets } from "./assetStorage";
import { ASSET_STORE, ASSET_UPLOAD_QUEUE_STORE, assetDbTransaction } from "./assetDb";
import { getAssetUpload, isQueueableWorkspaceId, makeAssetUploadEntry } from "./assetUploadQueue";
import { ASSET_KIND_PDF_SOURCE, localAssetSize } from "./localAssetCache";
import { reconcilePdfSourceUploads } from "./pdfSourceUploads";
import { recordedLiveAssetIds } from "./assetReferences";
import { isValidAssetSegment } from "./cloud/assetPaths";
import {
  CLOUD_ASSET_DECISION,
  CLOUD_CONFLICT_REASON,
  isCloudAssetConflict,
  readCloudAssetState,
  resolveCloudAssetState,
} from "./cloud/assetCloudState";
import { DURABLE_KEYS, DURABLE_SCOPE_KIND, readDurableMap } from "./durableStorage";
import { LOCAL_MIGRATION_STATUS, readLocalMigrationState } from "./cloud/localMigration";
import { readLocalDataBinding } from "./localDataBinding";
import { pdfSourceId } from "./pdfDocuments";

/** Why this browser's legacy assets may — or may not — be adopted here. */
export const ADOPTION_AUTHORITY = Object.freeze({
  /** The user explicitly moved this browser's data into THIS workspace. */
  MIGRATED_HERE: "migrated-here",
  /** No other account has ever been recorded against this browser's data. */
  UNAMBIGUOUS: "unambiguous",
  /** This browser's data was explicitly moved into a DIFFERENT workspace. */
  MIGRATED_ELSEWHERE: "migrated-elsewhere",
  /** Another account used this browser's data and no migration settled it. */
  OTHER_ACCOUNT: "other-account",
});

/** The outcome of one adoption attempt. */
export const ADOPTION_RESULT = Object.freeze({
  ADOPTED: "adopted",
  ALREADY_OWNED: "already-owned",
  FOREIGN_WORKSPACE: "foreign-workspace",
  MISSING: "missing",
});

/** Why a referenced asset could not be associated with this workspace. */
export const BACKFILL_CONFLICT = Object.freeze({
  FOREIGN_WORKSPACE: "foreign-workspace",
  AMBIGUOUS_BINDING: "ambiguous-binding",
  /** The workspace's CURRENT cloud document describes a different asset. */
  CLOUD_IDENTITY: CLOUD_CONFLICT_REASON[CLOUD_ASSET_DECISION.CONFLICT],
  /** The workspace's CURRENT cloud document does not validate. */
  MALFORMED_CLOUD_RECORD: CLOUD_CONFLICT_REASON[CLOUD_ASSET_DECISION.MALFORMED],
});

// The cloud-state rule itself lives in src/lib/cloud/assetCloudState.js and is
// SHARED with the PDF source reconciliation; re-exported here so the callers
// and tests of this module keep one import.
export { CLOUD_ASSET_DECISION, resolveCloudAssetState };

/** The lifecycle of one backfill pass, for the status surfaces. */
export const BACKFILL_PHASE = Object.freeze({
  IDLE: "idle",
  CHECKING: "checking",
  DONE: "done",
  ERROR: "error",
});

/** Why the old browser copy may not be removed yet. */
export const OLD_COPY_REFUSAL = Object.freeze({
  UPLOADS_PENDING: "uploads-pending",
  CONFLICT: "conflict",
  NOT_ASSOCIATED: "not-associated",
});

/** Asset kinds whose bytes are pictures, for the migration summary. */
const IMAGE_KINDS = Object.freeze(["logo", "note-photo", "editor-image"]);

const WORKSPACE_SCOPE = (id) => Object.freeze({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id });
export const LOCAL_REFERENCE_SCOPE = Object.freeze({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });

/**
 * The default store boundary. Every one of these is injectable so the
 * planner can be exercised without IndexedDB, and so a test can force a
 * refusal or a failure at exactly one of them.
 */
export const defaultBackfillDeps = Object.freeze({
  listAssets: () => listAssets(),
  getQueueEntry: (workspaceId, assetId) => getAssetUpload(workspaceId, assetId),
  localAssetSize: (assetId, options) => localAssetSize(assetId, options),
  /**
   * The workspace's CURRENT asset document, `{ exists, fields }`, through the
   * workspace store (src/lib/cloud/firestoreWorkspaceStore.js →
   * `readAssetDocument`). There is deliberately NO default: this module does
   * not own a cloud connection, the session does, and it injects the store's
   * own reader (src/context/DataScopeContext.js). Absent, every cloud state
   * resolves to `unknown` and every asset is queued conservatively.
   */
  readCloudAssetDocument: null,
  adopt: (assetId, workspaceId, options) => adoptLegacyAssetIntoWorkspace(assetId, workspaceId, options),
  reconcilePdfSources: (workspaceId, sources, options) =>
    reconcilePdfSourceUploads({ workspaceId, sources, ...(options || {}) }),
  readMigrationState: (storage) => readLocalMigrationState(storage),
  readBinding: (storage) => readLocalDataBinding(storage),
});

function withDeps(deps) {
  return deps ? { ...defaultBackfillDeps, ...deps } : defaultBackfillDeps;
}

/* --------------------------- ownership authority -------------------------- */

/**
 * MAY this session adopt legacy, unscoped binaries into `workspaceId`? Pure —
 * it reads the two records Phase 6 already keeps and decides nothing else.
 *
 * The order matters and is deliberate:
 *
 *   1. an explicit, COMPLETED structured migration into THIS workspace is the
 *      user's own decision that this browser's data is this workspace's. It
 *      outranks the ambiguity warning, because that warning was shown to the
 *      user before they made it (src/components/auth/LocalDataMigrationDialog.js);
 *   2. a migration completed into ANOTHER workspace is a recorded statement
 *      that this browser's data belongs somewhere else — refused;
 *   3. any OTHER account recorded against this browser's data, with no
 *      migration settling it — refused;
 *   4. otherwise nothing contradicts this account, and the reference set is
 *      the evidence.
 *
 * A refusal is never silent: the plan reports what it would have adopted so
 * the user can be told, and nothing is mutated.
 */
export function resolveAdoptionAuthority({ uid = null, workspaceId, migration = null, binding = null } = {}) {
  const state = migration || { status: LOCAL_MIGRATION_STATUS.NOT_STARTED, workspaceId: null };
  if (state.status === LOCAL_MIGRATION_STATUS.COMPLETED && state.workspaceId === workspaceId) {
    return { allowed: true, reason: ADOPTION_AUTHORITY.MIGRATED_HERE };
  }
  if (state.status === LOCAL_MIGRATION_STATUS.COMPLETED && typeof state.workspaceId === "string" && state.workspaceId) {
    return { allowed: false, reason: ADOPTION_AUTHORITY.MIGRATED_ELSEWHERE };
  }
  const seen = binding && Array.isArray(binding.uids) ? binding.uids : [];
  if (seen.some((seenUid) => typeof seenUid === "string" && seenUid && seenUid !== uid)) {
    return { allowed: false, reason: ADOPTION_AUTHORITY.OTHER_ACCOUNT };
  }
  return { allowed: true, reason: ADOPTION_AUTHORITY.UNAMBIGUOUS };
}

/* --------------------------- reference discovery -------------------------- */

/**
 * Every asset id one SCOPE's durable records reference, split into the two
 * universes the storage layer actually has: general assets (the `assets`
 * store) and the CURRENT PDF sources of the registry (`pdfDocBytes`).
 *
 * It reads the same four records the owner modules own, through the same
 * durable boundary, at whatever scope the caller names — the workspace mirror
 * for the backfill, the pre-account local scope for the migration summary —
 * and hands them to the ONE collector (src/lib/assetReferences.js →
 * `recordedLiveAssetIds`). There is no second, narrower scan anywhere.
 */
export function collectScopeReferences({ scope, storage = undefined, assets = [] } = {}) {
  const options = { scope, ...(storage === undefined ? {} : { storage }) };
  const noteContent = readDurableMap(DURABLE_KEYS.noteContent, options).map;
  const templateInstances = readDurableMap(DURABLE_KEYS.templateInstances, options).map;
  const templateVersions = readDurableMap(DURABLE_KEYS.templateVersions, options).map;
  const pdfDocs = readDurableMap(DURABLE_KEYS.pdfDocs, options).map;

  const pdfSourceIds = [];
  for (const doc of Object.values(pdfDocs)) {
    const source = pdfSourceId(doc);
    if (isValidAssetSegment(source) && !pdfSourceIds.includes(source)) pdfSourceIds.push(source);
  }

  const all = recordedLiveAssetIds({
    noteContent,
    templateInstances,
    templateVersions,
    assets,
    pdfSourceIds,
  });
  const pdfSet = new Set(pdfSourceIds);
  const general = [];
  for (const id of all) {
    if (!pdfSet.has(id)) general.push(id);
  }
  return { all, general, pdfSourceIds };
}

/* --------------------------- cloud-state authority ------------------------ */

/** The shared rule over the injected document boundary. */
function readCloudState(d, input) {
  return readCloudAssetState(d.readCloudAssetDocument, input);
}

/* -------------------------------- planning -------------------------------- */

function classifyKind(kind) {
  if (kind === ASSET_KIND_PDF_SOURCE) return "pdfs";
  return IMAGE_KINDS.includes(kind) ? "images" : "files";
}

function emptyCounts() {
  return { images: 0, files: 0, pdfs: 0, bytes: 0 };
}

function addToCounts(counts, kind, size) {
  counts[classifyKind(kind)] += 1;
  counts.bytes += Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * WHAT a backfill would do, without doing any of it.
 *
 * Nothing here writes: it reads the workspace's references, this browser's
 * asset listing (no Blobs), the remote index and the upload queue, and sorts
 * every referenced id into exactly one bucket.
 *
 * @param {{
 *   workspaceId: string,
 *   uid?: string|null,
 *   referenceScope?: object|null,  the durable scope to read references from;
 *                                  defaults to `workspaceId`'s own mirror.
 *   storage?: Storage,
 *   deps?: object,                 see `defaultBackfillDeps`
 * }} options
 */
export async function planAssetBackfill({
  workspaceId,
  uid = null,
  referenceScope = null,
  storage = undefined,
  deps = null,
} = {}) {
  const d = withDeps(deps);
  const empty = {
    workspaceId: workspaceId || null,
    authority: { allowed: false, reason: ADOPTION_AUTHORITY.UNAMBIGUOUS },
    referenced: { total: 0, general: [], pdfSources: [] },
    general: { adopt: [], refused: [], queue: [], owned: [], stored: [], tombstoned: [], unknown: [], conflicts: [], cloudConflicts: [], missing: [] },
    pdf: { current: [], present: [], stored: [], tombstoned: [], unknown: [], queued: [], enqueue: [], cloudConflicts: [], missing: [] },
    counts: emptyCounts(),
  };
  if (!isQueueableWorkspaceId(workspaceId)) return empty;

  const authority = resolveAdoptionAuthority({
    uid,
    workspaceId,
    migration: d.readMigrationState(storage),
    binding: d.readBinding(storage),
  });

  const assets = (await d.listAssets()) || [];
  const byId = new Map();
  for (const record of assets) {
    if (record && typeof record.id === "string") byId.set(record.id, record);
  }

  const scope = referenceScope || WORKSPACE_SCOPE(workspaceId);
  const references = collectScopeReferences({ scope, storage, assets });

  const plan = {
    ...empty,
    workspaceId,
    authority,
    referenced: {
      total: references.all.size,
      general: references.general,
      pdfSources: references.pdfSourceIds,
    },
    general: { adopt: [], refused: [], queue: [], owned: [], stored: [], tombstoned: [], unknown: [], conflicts: [], cloudConflicts: [], missing: [] },
    pdf: { current: references.pdfSourceIds, present: [], stored: [], tombstoned: [], unknown: [], queued: [], enqueue: [], cloudConflicts: [], missing: [] },
    counts: emptyCounts(),
  };

  for (const assetId of references.general) {
    const record = byId.get(assetId);
    if (!record) {
      // Referenced, but this browser does not hold it. It is NOT fabricated
      // and NOT queued: if the workspace's cloud copy holds it, the Phase 7.5
      // read-through recovers it on demand; if not, it is genuinely absent
      // and the surfaces already say so.
      plan.general.missing.push(assetId);
      continue;
    }
    const item = { assetId, kind: record.kind || null, size: Number.isFinite(record.size) ? record.size : 0 };
    const owner = isQueueableWorkspaceId(record.workspaceId) ? record.workspaceId : null;

    if (owner && owner !== workspaceId) {
      // Another workspace's asset. Not read, not re-tagged, not uploaded.
      plan.general.conflicts.push({ ...item, reason: BACKFILL_CONFLICT.FOREIGN_WORKSPACE, owner });
      continue;
    }

    addToCounts(plan.counts, record.kind, item.size);

    if (!owner && !authority.allowed) {
      plan.general.refused.push({ ...item, reason: BACKFILL_CONFLICT.AMBIGUOUS_BINDING });
      continue;
    }

    // The CURRENT cloud document decides whether a queue identity is
    // required — for a legacy record about to be adopted AND for a record
    // this workspace already owns, which an earlier pass may have adopted
    // while the cloud could not be asked, or whose document has since gone.
    const cloud = await readCloudState(d, {
      workspaceId,
      assetId,
      local: {
        kind: record.kind || null,
        mimeType: record.mimeType || null,
        name: record.name || null,
        size: item.size,
        sourceAssetId: typeof record.sourceAssetId === "string" ? record.sourceAssetId : null,
      },
    });
    const decided = { ...item, queue: cloud.queue, cloud: cloud.decision };
    switch (cloud.decision) {
      case CLOUD_ASSET_DECISION.STORED:
        plan.general.stored.push(assetId);
        break;
      case CLOUD_ASSET_DECISION.TOMBSTONED:
        plan.general.tombstoned.push(assetId);
        break;
      case CLOUD_ASSET_DECISION.UNKNOWN:
        plan.general.unknown.push(assetId);
        break;
      case CLOUD_ASSET_DECISION.CONFLICT:
        plan.general.cloudConflicts.push({ ...item, reason: BACKFILL_CONFLICT.CLOUD_IDENTITY });
        break;
      case CLOUD_ASSET_DECISION.MALFORMED:
        plan.general.cloudConflicts.push({ ...item, reason: BACKFILL_CONFLICT.MALFORMED_CLOUD_RECORD });
        break;
      default:
        break;
    }

    if (!owner) {
      // Adopted either way: a legacy record referenced by this workspace is
      // this workspace's local cache whatever the cloud says. Only the queue
      // decision varies.
      plan.general.adopt.push(decided);
      continue;
    }
    plan.general.owned.push(decided);
    if (cloud.queue && !(await d.getQueueEntry(workspaceId, assetId))) plan.general.queue.push(decided);
  }

  for (const sourceId of references.pdfSourceIds) {
    const size = await d.localAssetSize(sourceId, { kind: ASSET_KIND_PDF_SOURCE });
    if (!Number.isFinite(size) || size <= 0) {
      plan.pdf.missing.push(sourceId);
      continue;
    }
    plan.pdf.present.push(sourceId);
    addToCounts(plan.counts, ASSET_KIND_PDF_SOURCE, size);
    const cloud = await readCloudState(d, {
      workspaceId,
      assetId: sourceId,
      local: { kind: ASSET_KIND_PDF_SOURCE, mimeType: "application/pdf", name: null, size, sourceAssetId: null },
    });
    if (cloud.decision === CLOUD_ASSET_DECISION.STORED) {
      plan.pdf.stored.push(sourceId);
      continue;
    }
    if (isCloudAssetConflict(cloud.decision)) {
      plan.pdf.cloudConflicts.push({ assetId: sourceId, reason: CLOUD_CONFLICT_REASON[cloud.decision] });
      continue;
    }
    if (cloud.decision === CLOUD_ASSET_DECISION.TOMBSTONED) plan.pdf.tombstoned.push(sourceId);
    if (cloud.decision === CLOUD_ASSET_DECISION.UNKNOWN) plan.pdf.unknown.push(sourceId);
    const queued = await d.getQueueEntry(workspaceId, sourceId);
    if (queued) plan.pdf.queued.push(sourceId);
    else plan.pdf.enqueue.push(sourceId);
  }

  return plan;
}

/* ------------------------------- adoption --------------------------------- */

/**
 * Associate ONE legacy binary with a workspace — the whole of it in a single
 * IndexedDB transaction over the asset store and the upload queue
 * (src/lib/assetDb.js).
 *
 * Inside that one transaction:
 *
 *   1. the asset must still EXIST;
 *   2. it must still be UNSCOPED — or already owned by THIS workspace, which
 *      makes a repeat run idempotent rather than an error;
 *   3. `workspaceId` is written onto the record. The Blob is carried across
 *      BY REFERENCE: nothing is copied, the id does not change, and no
 *      document reference is touched;
 *   4. the upload identity is created if `queue` is true and none exists.
 *
 * `queue` IS THE CALLER'S AUTHORITATIVE DECISION — the outcome of the
 * current-cloud-document check in `resolveCloudAssetState`. The transaction
 * deliberately consults NO cache of its own: `assetRemoteIndex` is not
 * lifecycle state (Phase 7.5) and reading it here is exactly how an asset
 * would be adopted without the identity it needs. It defaults to `true`, the
 * conservative answer, so a caller that has not asked the cloud still leaves
 * the asset owed rather than orphaned.
 *
 * If anything fails the transaction aborts and the asset is still unscoped
 * with no queue entry: there is no half-adopted state in either direction.
 * If another process adopted it first, the re-read inside the transaction
 * sees that — the same workspace is success, a different one is a refusal
 * that overwrites nothing. An existing queue entry is never replaced.
 *
 * @returns {Promise<{ status: string, assetId: string, workspaceId: string,
 *                     queued: boolean, owner?: string|null }>}
 *          `queued` is true when a queue identity EXISTS afterwards (created
 *          now or already there); `created` says whether this call wrote it.
 */
export async function adoptLegacyAssetIntoWorkspace(assetId, workspaceId, { at, queue = true } = {}) {
  if (!isValidAssetSegment(assetId) || !isQueueableWorkspaceId(workspaceId)) {
    return { status: ADOPTION_RESULT.MISSING, assetId, workspaceId, queued: false, created: false };
  }
  const stamp = Number.isFinite(at) ? at : Date.now();
  const wantQueue = queue !== false;
  return assetDbTransaction([ASSET_STORE, ASSET_UPLOAD_QUEUE_STORE], "readwrite", (stores) => {
    const outcome = {
      status: ADOPTION_RESULT.MISSING,
      assetId,
      workspaceId,
      queued: false,
      created: false,
      owner: null,
    };
    const read = stores[ASSET_STORE].get(assetId);
    read.onsuccess = () => {
      const record = read.result;
      if (!record || !record.id) return;
      const owner = isQueueableWorkspaceId(record.workspaceId) ? record.workspaceId : null;
      outcome.owner = owner;
      if (owner && owner !== workspaceId) {
        outcome.status = ADOPTION_RESULT.FOREIGN_WORKSPACE;
        return;
      }
      if (!owner) {
        // The ONE field that changes. `updatedAt` is deliberately left as
        // it was: the bytes did not change, and a cross-device comparison
        // reads that field.
        stores[ASSET_STORE].put({ ...record, workspaceId });
        outcome.status = ADOPTION_RESULT.ADOPTED;
      } else {
        outcome.status = ADOPTION_RESULT.ALREADY_OWNED;
      }

      const queueRead = stores[ASSET_UPLOAD_QUEUE_STORE].get([workspaceId, assetId]);
      queueRead.onsuccess = () => {
        if (queueRead.result) {
          outcome.queued = true;
          return;
        }
        if (!wantQueue) return;
        let entry = null;
        try {
          entry = makeAssetUploadEntry({ workspaceId, assetId, kind: record.kind, at: stamp });
        } catch {
          entry = null;
        }
        if (!entry) return;
        stores[ASSET_UPLOAD_QUEUE_STORE].put(entry);
        outcome.queued = true;
        outcome.created = true;
      };
    };
    return () => outcome;
  });
}

/* -------------------------------- running --------------------------------- */

/**
 * Adopt and enqueue what the plan found eligible, then repair the PDF sources
 * through the Phase 7.4 reconciler.
 *
 * It is idempotent, restartable and safe to run while the upload engine is
 * already draining: every decision is re-taken inside the adoption
 * transaction, an existing queue entry is left alone rather than replaced,
 * and the PDF reconciler was already written to converge.
 *
 * `isActive` is the session guard. A sign-out or an account switch halfway
 * through stops the pass between assets — the ones already adopted are
 * durable and correct, and the rest are picked up by the next session's pass.
 *
 * @returns {Promise<object>} a structured result, never a throw for one
 *          asset's failure: a refused transaction is reported as `failed` and
 *          retried on the next run.
 */
export async function runAssetBackfill({
  workspaceId,
  uid = null,
  plan = null,
  storage = undefined,
  deps = null,
  isActive = () => true,
  now = Date.now,
} = {}) {
  const d = withDeps(deps);
  const result = {
    workspaceId: workspaceId || null,
    ranAt: now(),
    authority: { allowed: false, reason: ADOPTION_AUTHORITY.UNAMBIGUOUS },
    adopted: [],
    alreadyOwned: [],
    queued: [],
    conflicts: [],
    missing: [],
    failed: [],
    refused: [],
    pdf: { enqueued: [], settled: [] },
    counts: emptyCounts(),
    stopped: false,
  };
  if (!isQueueableWorkspaceId(workspaceId) || !isActive()) {
    result.stopped = !isActive();
    return result;
  }

  const resolved = plan || (await planAssetBackfill({ workspaceId, uid, storage, deps }));
  result.authority = resolved.authority;
  result.counts = resolved.counts;
  result.missing = [...resolved.general.missing];
  result.conflicts = [
    ...resolved.general.conflicts.map(({ assetId, reason, owner }) => ({ assetId, reason, owner })),
    ...resolved.general.cloudConflicts.map(({ assetId, reason }) => ({ assetId, reason, owner: null })),
    ...resolved.pdf.cloudConflicts.map(({ assetId, reason }) => ({ assetId, reason, owner: null })),
  ];
  result.refused = resolved.general.refused.map(({ assetId, reason }) => ({ assetId, reason }));

  // Every referenced record this workspace owns is REVISITED, not only the
  // legacy ones: an earlier pass may have adopted it while the cloud could
  // not be asked, or its document may have since disappeared. The adoption is
  // idempotent for an owned record, and it creates a queue identity only when
  // the cloud check above said one is required and none exists.
  const work = [...resolved.general.adopt, ...resolved.general.owned];
  for (const item of work) {
    if (!isActive()) {
      result.stopped = true;
      return result;
    }
    let outcome;
    try {
      outcome = await d.adopt(item.assetId, workspaceId, { at: now(), queue: item.queue !== false });
    } catch (error) {
      result.failed.push({ assetId: item.assetId, code: error && error.name ? error.name : "error" });
      continue;
    }
    if (outcome.status === ADOPTION_RESULT.ADOPTED) result.adopted.push(item.assetId);
    else if (outcome.status === ADOPTION_RESULT.ALREADY_OWNED) result.alreadyOwned.push(item.assetId);
    else if (outcome.status === ADOPTION_RESULT.FOREIGN_WORKSPACE) {
      result.conflicts.push({
        assetId: item.assetId,
        reason: BACKFILL_CONFLICT.FOREIGN_WORKSPACE,
        owner: outcome.owner || null,
      });
      continue;
    } else {
      // Gone between the plan and the write. Not an error, and not fabricated.
      result.missing.push(item.assetId);
      continue;
    }
    if (outcome.created) result.queued.push(item.assetId);
  }

  if (!isActive()) {
    result.stopped = true;
    return result;
  }

  // PDF sources: the SAME reconciler the upload engine runs at start-up, over
  // the registry's CURRENT sources only, given the SAME cloud boundary — so it
  // applies the same current-document rule (src/lib/cloud/assetCloudState.js)
  // rather than the local index. Superseded ids whose bytes still sit in
  // this browser are not current and are never enqueued by it.
  try {
    const pdf = await d.reconcilePdfSources(workspaceId, resolved.pdf.current, {
      readCloudAssetDocument: d.readCloudAssetDocument,
    });
    if (pdf) {
      result.pdf.enqueued = Array.isArray(pdf.enqueued) ? pdf.enqueued : [];
      result.pdf.settled = Array.isArray(pdf.settled) ? pdf.settled : [];
      for (const conflict of Array.isArray(pdf.conflicts) ? pdf.conflicts : []) {
        if (!result.conflicts.some((c) => c.assetId === conflict.assetId)) {
          result.conflicts.push({ assetId: conflict.assetId, reason: conflict.reason, owner: null });
        }
      }
    }
  } catch (error) {
    result.failed.push({ assetId: null, code: "pdf-reconcile" });
  }

  return result;
}

/* --------------------------- old-copy safety gate ------------------------- */

/**
 * MAY the pre-account copy in this browser be removed?
 *
 * WHAT "THE OLD COPY" IS, precisely, in the current storage architecture: the
 * LOCAL-scope durable records in `localStorage` — this browser's pre-account
 * notes, templates and PDF registry — and nothing else
 * (src/lib/cloud/localMigration.js → `removeLocalOriginals`). The BINARIES are
 * not a second copy at all: once a legacy asset is adopted, the record in
 * `notewise-assets` IS the workspace's own local cache of that asset, the same
 * bytes the open note is rendering. There is no separate legacy binary to
 * delete, so this phase deliberately deletes none — deleting "the old copy" of
 * an image would mean deleting the image.
 *
 * What this gate adds is the honesty the button was missing: it refuses while
 * the referenced files of this workspace are still only here. Removing the
 * structured originals tells the user the browser copy is no longer needed —
 * and that is false while a referenced file has not reached the account.
 *
 * The one case where it does NOT refuse is a build with no Storage bucket:
 * nothing can ever be confirmed, the product has never claimed otherwise
 * ("Files stay on this device"), and blocking the button forever would be a
 * refusal the user could not act on.
 *
 * @returns {Promise<{ allowed: boolean, reason: string|null,
 *                     blocking: { pending: number, conflicts: number, unassociated: number } }>}
 */
export async function planOldCopyRemoval({
  workspaceId,
  uid = null,
  configured = true,
  storage = undefined,
  plan = null,
  deps = null,
} = {}) {
  const resolved = plan || (await planAssetBackfill({ workspaceId, uid, storage, deps }));
  const conflicts =
    resolved.general.conflicts.length + resolved.general.cloudConflicts.length + resolved.pdf.cloudConflicts.length;
  const unassociated = resolved.general.refused.length;
  // Anything whose CURRENT cloud document is not a matching `stored` record
  // has not reached the account — including what the cloud could not confirm.
  const pending =
    resolved.general.adopt.filter((item) => item.queue !== false).length +
    resolved.general.owned.filter((item) => item.queue !== false).length +
    resolved.pdf.enqueue.length +
    resolved.pdf.queued.length;

  const blocking = { pending, conflicts, unassociated };
  if (!configured) return { allowed: true, reason: null, blocking };
  if (conflicts > 0) return { allowed: false, reason: OLD_COPY_REFUSAL.CONFLICT, blocking };
  if (unassociated > 0) return { allowed: false, reason: OLD_COPY_REFUSAL.NOT_ASSOCIATED, blocking };
  if (pending > 0) return { allowed: false, reason: OLD_COPY_REFUSAL.UPLOADS_PENDING, blocking };
  return { allowed: true, reason: null, blocking };
}

/** The sentence Settings shows when the removal is refused. */
export function oldCopyRefusalMessage(reason, blocking = null) {
  const b = blocking || { pending: 0, conflicts: 0, unassociated: 0 };
  switch (reason) {
    case OLD_COPY_REFUSAL.CONFLICT:
      return `${b.conflicts} ${b.conflicts === 1 ? "file does" : "files do"} not match what your account holds under the same name, or ${b.conflicts === 1 ? "belongs" : "belong"} to another workspace on this browser. The old copy was kept until that is resolved.`;
    case OLD_COPY_REFUSAL.NOT_ASSOCIATED:
      return `${b.unassociated} ${b.unassociated === 1 ? "file could" : "files could"} not be associated with this workspace. The old copy was kept.`;
    case OLD_COPY_REFUSAL.UPLOADS_PENDING:
      return `${b.pending} ${b.pending === 1 ? "file has" : "files have"} not reached your account yet. The old copy was kept until they have.`;
    default:
      return "";
  }
}

/* ------------------------------ status lines ------------------------------ */

/**
 * The backfill's own line, which is about DISCOVERING and ASSOCIATING local
 * files — never about uploading them. Once a file is enqueued the Phase 7.4
 * engine owns its progress and Settings shows that on its own line, so this
 * one never invents a percentage or claims anything is moving.
 */
export function assetBackfillStatusLine(status) {
  if (!status) return "";
  if (status.phase === BACKFILL_PHASE.CHECKING) return "Checking local files…";
  if (status.phase === BACKFILL_PHASE.ERROR) return "Local files could not be checked. NoteWise will try again next time you sign in.";
  const result = status.result;
  if (status.phase !== BACKFILL_PHASE.DONE || !result) return "";
  const ready = result.queued.length + result.pdf.enqueued.length;
  if (ready > 0) return `${ready} ${ready === 1 ? "file is" : "files are"} ready to sync`;
  const associated = result.adopted.length;
  if (associated > 0) return `${associated} ${associated === 1 ? "file is" : "files are"} in your workspace`;
  return "";
}

/** "1 local file could not be associated", or "" when everything resolved. */
export function assetBackfillAttentionLine(status) {
  const result = status && status.phase === BACKFILL_PHASE.DONE ? status.result : null;
  if (!result) return "";
  const stuck = result.conflicts.length + result.refused.length + result.failed.length;
  if (stuck <= 0) return "";
  return `${stuck} ${stuck === 1 ? "local file could" : "local files could"} not be associated`;
}

/**
 * The migration dialog's file line: what moving this browser's data would
 * bring with it. Referenced local files only — an orphaned blob, another
 * workspace's asset and a file that exists only in the cloud are all
 * deliberately absent, because none of them is this browser's to move.
 *
 * `formatBytes` is supplied by the caller rather than defaulted here: the
 * product already has ONE size formatter (src/components/AssetUploadStatus.js
 * → `formatUploadBytes`), and a second copy in this layer would be a second
 * answer to "how big is that" — this module has no business importing React.
 */
export function migrationAssetSummary(counts, { formatBytes } = {}) {
  const c = counts || emptyCounts();
  const parts = [];
  const add = (n, singular, plural) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? singular : plural}`);
  };
  add(c.images, "image", "images");
  add(c.files, "file", "files");
  add(c.pdfs, "PDF file", "PDF files");
  if (parts.length === 0) return "";
  const size = typeof formatBytes === "function" && c.bytes > 0 ? formatBytes(c.bytes) : null;
  return size ? `${parts.join(", ")} (${size})` : parts.join(", ");
}
