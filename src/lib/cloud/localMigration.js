// src/lib/cloud/localMigration.js
//
// The EXPLICIT local → cloud migration of this browser's pre-account data.
//
// Before accounts existed every note, template and PDF entry lived under the
// bare durable keys (the LOCAL scope of src/lib/durableStorage.js). Signing
// in never moves that data: it is offered, once the signed-in workspace is
// resolved and hydrated, as a step the user must choose. This module is that
// step's model and runner.
//
// SEMANTICS
//   detect      what the local scope holds (counts only; nothing is parsed
//               that is not already parsed by the owner modules' readers);
//   ambiguity   the local-data binding (src/lib/localDataBinding.js) says
//               whether other accounts used this data on this browser — the
//               dialog then WARNS and names the count, it never decides;
//   run         for each entity collection: every local entity whose id is
//               NOT already present in the workspace mirror is written into
//               the mirror (an ordinary captured write, so it is queued for
//               the cloud like any edit); entities the workspace already
//               holds are left exactly as they are — the cloud copy wins,
//               which is what makes a retry, a second click and a resumed
//               half-run duplicate-free and non-destructive;
//   confirm     the outbox is flushed and the run is COMPLETE only when
//               nothing remains queued; otherwise it is "in progress" and
//               resumes (idempotently) on the next attempt;
//   local data  the local-scope originals are NEVER modified or removed by
//               the migration. They stay as this browser's backup until the
//               user explicitly removes them (src/components/SettingsModal.js).
//
// The record of a run lives in the local-data binding (`migration`) — and,
// once complete, as `workspaces/{wid}/migrations/{sourceId}` in the cloud so
// another device can see that this browser's data was imported.

import { DURABLE_KEYS, DURABLE_SCOPE_KIND, WRITE_ORIGIN, readDurableRecord, readScopedValue, writeDurableRecord } from "../durableStorage";
import { DEFAULT_TEMPLATE_KEY } from "../templateModel";
import { hasLocalCustomerData, localDataSeenUnderOtherAccount, readLocalDataBinding, recordMigrationState } from "../localDataBinding";
import { DURABLE_KEY_BY_COLLECTION } from "./cloudCapture";
import { CLOUD_COLLECTION, ENTITY_COLLECTIONS, NODE_KIND, entitiesOfRecord, recordOfEntities } from "./cloudModel";
import { outboxSize } from "./cloudOutbox";

export const LOCAL_MIGRATION_STATUS = Object.freeze({
  NOT_STARTED: "not-started",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  FAILED: "failed",
});

const LOCAL_SCOPE = Object.freeze({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });

function localRecord(key, storage) {
  return readDurableRecord(key, { storage, scope: LOCAL_SCOPE }).value;
}

/** The local scope's entities per collection, exactly as the cloud would
 *  see them. The legacy default-template string is folded into settings. */
export function readLocalEntities(storage) {
  const out = {};
  for (const collection of ENTITY_COLLECTIONS) {
    const key = DURABLE_KEY_BY_COLLECTION[collection];
    out[collection] = entitiesOfRecord(collection, localRecord(key, storage)) || {};
  }
  if (Object.keys(out[CLOUD_COLLECTION.SETTINGS]).length === 0) {
    const legacyPointer = readScopedValue(DEFAULT_TEMPLATE_KEY, storage, LOCAL_SCOPE);
    if (legacyPointer) out[CLOUD_COLLECTION.SETTINGS] = entitiesOfRecord(CLOUD_COLLECTION.SETTINGS, { defaultTemplateId: legacyPointer });
  }
  return out;
}

/**
 * What this browser holds outside any account, for the dialog:
 *   { present, counts: { projects, folders, notes, templates, templateVersions, pdfs }, seenByOtherAccounts, otherAccountCount, record }
 */
export function detectLocalData(uid, storage) {
  const present = hasLocalCustomerData(storage);
  if (!present) {
    return { present: false, counts: emptyCounts(), seenByOtherAccounts: false, otherAccountCount: 0, record: readLocalDataBinding(storage) };
  }
  const entities = readLocalEntities(storage);
  const nodes = Object.values(entities[CLOUD_COLLECTION.NODES]);
  const noteIds = new Set(nodes.filter((n) => n.kind === NODE_KIND.NOTE).map((n) => n.id));
  for (const id of Object.keys(entities[CLOUD_COLLECTION.NOTE_CONTENT])) noteIds.add(id);
  for (const id of Object.keys(entities[CLOUD_COLLECTION.TEMPLATE_INSTANCES])) noteIds.add(id);
  const record = readLocalDataBinding(storage);
  const others = record ? record.uids.filter((seen) => seen !== uid) : [];
  return {
    present: true,
    counts: {
      projects: nodes.filter((n) => n.kind === NODE_KIND.PROJECT).length,
      folders: nodes.filter((n) => n.kind === NODE_KIND.FOLDER).length,
      notes: noteIds.size,
      templates: Object.keys(entities[CLOUD_COLLECTION.TEMPLATES]).length,
      templateVersions: Object.keys(entities[CLOUD_COLLECTION.TEMPLATE_VERSIONS]).length,
      pdfs: Object.keys(entities[CLOUD_COLLECTION.PDF_DOCS]).length,
    },
    seenByOtherAccounts: localDataSeenUnderOtherAccount(uid, storage),
    otherAccountCount: others.length,
    record,
  };
}

function emptyCounts() {
  return { projects: 0, folders: 0, notes: 0, templates: 0, templateVersions: 0, pdfs: 0 };
}

/** The migration record of the binding, normalized. */
export function readLocalMigrationState(storage) {
  const record = readLocalDataBinding(storage);
  const m = record && record.migration ? record.migration : {};
  return {
    status: Object.values(LOCAL_MIGRATION_STATUS).includes(m.status) ? m.status : LOCAL_MIGRATION_STATUS.NOT_STARTED,
    uid: typeof m.uid === "string" ? m.uid : null,
    workspaceId: typeof m.workspaceId === "string" ? m.workspaceId : null,
    sourceId: typeof m.sourceId === "string" ? m.sourceId : null,
    startedAt: Number(m.startedAt) || 0,
    completedAt: Number(m.completedAt) || 0,
    counts: m.counts && typeof m.counts === "object" ? m.counts : null,
  };
}

/**
 * Should the migration step be offered to `uid` for `workspaceId`?
 *   - never without local data;
 *   - not once this browser's data was completed INTO THIS workspace;
 *   - a run completed into ANOTHER workspace (another account) still offers
 *     the data to this account — with the ambiguity warning — because the
 *     local copy is still here and may be this person's.
 */
export function shouldOfferLocalMigration(uid, workspaceId, storage) {
  if (!hasLocalCustomerData(storage)) return false;
  const state = readLocalMigrationState(storage);
  if (state.status === LOCAL_MIGRATION_STATUS.COMPLETED && state.workspaceId === workspaceId) return false;
  return true;
}

function newSourceId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `src-${crypto.randomUUID()}`;
  } catch {
    // fall through
  }
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Runs (or resumes) the migration into `workspaceId`.
 *
 * @param {{
 *   uid: string, workspaceId: string, storage?: Storage,
 *   sync: { flush: () => Promise<any> },
 *   store?: { setDocument: Function, timestamp: Function } | null,
 *   now?: () => number,
 *   onProgress?: (phase: string) => void,
 * }} options
 * @returns {Promise<{ status: string, imported: { [collection]: number }, skipped: { [collection]: number }, pending: number, error?: Error }>}
 */
export async function runLocalMigration({ uid, workspaceId, storage, sync, store = null, now = Date.now, onProgress = null }) {
  const scope = Object.freeze({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: workspaceId });
  const progress = (phase) => {
    if (onProgress) onProgress(phase);
  };

  const previous = readLocalMigrationState(storage);
  const sourceId =
    previous.sourceId && previous.workspaceId === workspaceId ? previous.sourceId : newSourceId();
  const startedAt = previous.status === LOCAL_MIGRATION_STATUS.IN_PROGRESS && previous.workspaceId === workspaceId && previous.startedAt ? previous.startedAt : now();
  recordMigrationState(
    { status: LOCAL_MIGRATION_STATUS.IN_PROGRESS, uid, workspaceId, sourceId, startedAt, completedAt: 0, counts: null },
    { storage }
  );

  const imported = {};
  const skipped = {};
  progress("copying");
  try {
    const local = readLocalEntities(storage);
    // Sibling order offsets, so migrated nodes sort after existing ones.
    const workspaceNodes = entitiesOfRecord(CLOUD_COLLECTION.NODES, readDurableRecord(DURABLE_KEYS.tree, { storage, scope }).value) || {};
    const maxOrder = {};
    for (const node of Object.values(workspaceNodes)) {
      const parent = `${node.kind}:${node.parentId || ""}`;
      maxOrder[parent] = Math.max(maxOrder[parent] === undefined ? -1 : maxOrder[parent], Number(node.order) || 0);
    }

    for (const collection of ENTITY_COLLECTIONS) {
      const key = DURABLE_KEY_BY_COLLECTION[collection];
      const current = entitiesOfRecord(collection, readDurableRecord(key, { storage, scope }).value) || {};
      const merged = { ...current };
      let added = 0;
      let kept = 0;
      for (const id of Object.keys(local[collection])) {
        if (id in current) {
          kept += 1;
          continue;
        }
        let payload = local[collection][id];
        if (collection === CLOUD_COLLECTION.NODES) {
          const parent = `${payload.kind}:${payload.parentId || ""}`;
          const offset = maxOrder[parent] === undefined ? 0 : maxOrder[parent] + 1;
          payload = { ...payload, order: (Number(payload.order) || 0) + offset };
        }
        merged[id] = payload;
        added += 1;
      }
      imported[collection] = added;
      skipped[collection] = kept;
      if (added > 0) {
        // An ORDINARY captured write: the capture diffs it against the
        // mirror and queues exactly the added entities for the cloud.
        writeDurableRecord(key, recordOfEntities(collection, merged), { storage, scope, origin: WRITE_ORIGIN.APP });
      }
    }
  } catch (error) {
    recordMigrationState(
      { status: LOCAL_MIGRATION_STATUS.FAILED, uid, workspaceId, sourceId, startedAt, completedAt: 0, counts: null },
      { storage }
    );
    return { status: LOCAL_MIGRATION_STATUS.FAILED, imported, skipped, pending: outboxSize(workspaceId, storage), error };
  }

  progress("uploading");
  await sync.flush();
  const pending = outboxSize(workspaceId, storage);
  if (pending > 0) {
    // Still queued (offline, or refused): in progress, resumable. Nothing
    // is marked complete until Firestore has accepted every write.
    return { status: LOCAL_MIGRATION_STATUS.IN_PROGRESS, imported, skipped, pending };
  }

  const counts = { imported, skipped };
  const completedAt = now();
  progress("recording");
  if (store && typeof store.setDocument === "function") {
    try {
      await store.setDocument(["workspaces", workspaceId, "migrations", sourceId], {
        workspaceId,
        sourceId,
        uid,
        status: LOCAL_MIGRATION_STATUS.COMPLETED,
        imported,
        skipped,
        startedAt,
        completedAt,
        updatedAt: store.timestamp(),
      });
    } catch {
      // The cloud record is observability, not the completion marker: the
      // data itself has been accepted (the outbox is empty).
    }
  }
  recordMigrationState(
    { status: LOCAL_MIGRATION_STATUS.COMPLETED, uid, workspaceId, sourceId, startedAt, completedAt, counts },
    { storage }
  );
  return { status: LOCAL_MIGRATION_STATUS.COMPLETED, imported, skipped, pending: 0 };
}

/**
 * Removes this browser's LOCAL-scope originals after a completed migration.
 * Refuses (returns false) unless the migration into `workspaceId` completed
 * and nothing is still queued. Only the durable catalogue and the legacy
 * default-template pointer are removed; migration guards and frozen legacy
 * keys are left alone (inert).
 */
export function removeLocalOriginals(workspaceId, storage) {
  const state = readLocalMigrationState(storage);
  if (state.status !== LOCAL_MIGRATION_STATUS.COMPLETED || state.workspaceId !== workspaceId) return false;
  if (outboxSize(workspaceId, storage) > 0) return false;
  const target = storage || (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return false;
  try {
    for (const key of Object.values(DURABLE_KEYS)) target.removeItem(key);
    target.removeItem(DEFAULT_TEMPLATE_KEY);
    return true;
  } catch {
    return false;
  }
}
