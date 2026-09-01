// src/lib/cloud/cloudCapture.js
//
// Turns every durable WRITE in a workspace scope into entity-level outbox
// entries — the bridge between the Phase 4 owner modules (which write whole
// records, synchronously, and know nothing about the cloud) and Firestore
// (which stores one document per entity).
//
// Installed once as the durable-storage write capture
// (src/lib/durableStorage.js → setDurableWriteCapture). For each write it:
//   1. maps the logical key to its cloud collection (or ignores the key);
//   2. flattens the previous and the new record into entities
//      (src/lib/cloud/cloudModel.js — the tree becomes nodes, a map becomes
//      its entries);
//   3. diffs them, so only entities that actually changed are queued;
//   4. appends the changes to the workspace's persisted outbox
//      (src/lib/cloud/cloudOutbox.js) and tells the sync engine.
//
// The previous record is read from storage only the FIRST time a key is
// seen; afterwards the capture keeps its own flattened snapshot, so the diff
// never re-parses a multi-megabyte map on every keystroke. A write whose
// origin is "cloud" (hydration placing Firestore's state into the mirror)
// updates the snapshot and queues NOTHING — that is what stops a download
// from being re-uploaded. Writes in the local (pre-account) scope are never
// captured: this browser's own data reaches an account only through the
// explicit migration.
//
// Never throws into the owner module: the local write has already been
// confirmed by the time this runs, and a refused outbox write is reported as
// a persistence issue and remembered in memory for the next enqueue.

import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  WRITE_ORIGIN,
  reportPersistenceIssue,
  setDurableWriteCapture,
} from "../durableStorage";
import { CLOUD_COLLECTION, buildEntityDocument, diffEntities, entitiesOfRecord } from "./cloudModel";
import { OUTBOX_OP, enqueueOutbox } from "./cloudOutbox";

/** Logical durable key → cloud collection. Keys absent here stay local. */
export const COLLECTION_BY_DURABLE_KEY = Object.freeze({
  [DURABLE_KEYS.tree]: CLOUD_COLLECTION.NODES,
  [DURABLE_KEYS.noteContent]: CLOUD_COLLECTION.NOTE_CONTENT,
  [DURABLE_KEYS.templates]: CLOUD_COLLECTION.TEMPLATES,
  [DURABLE_KEYS.templateVersions]: CLOUD_COLLECTION.TEMPLATE_VERSIONS,
  [DURABLE_KEYS.templateInstances]: CLOUD_COLLECTION.TEMPLATE_INSTANCES,
  [DURABLE_KEYS.pdfDocs]: CLOUD_COLLECTION.PDF_DOCS,
  [DURABLE_KEYS.notePdfRefs]: CLOUD_COLLECTION.NOTE_PDF_REFS,
  [DURABLE_KEYS.workspaceSettings]: CLOUD_COLLECTION.SETTINGS,
});

export const DURABLE_KEY_BY_COLLECTION = Object.freeze(
  Object.fromEntries(Object.entries(COLLECTION_BY_DURABLE_KEY).map(([k, c]) => [c, k]))
);

const listeners = new Set();
// physicalKey → flattened entities of the record as last written
const snapshots = new Map();
// Changes that could not be persisted to the outbox yet, per workspace.
const unsavedChanges = new Map();

export const OUTBOX_WRITE_FAILED_MESSAGE =
  "Your change was saved on this device but NoteWise could not record that it still has to reach your account. Free some browser storage; the next change will retry.";

/** Listeners are told `{ workspaceId, changes }` after each captured write. */
export function subscribeCapturedChanges(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(event) {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch {
      // a listener failure must never reach the owner module
    }
  }
}

function changesOf(collection, previousEntities, nextEntities) {
  const { upserts, deletes } = diffEntities(previousEntities, nextEntities);
  const changes = upserts.map(({ id }) => ({ collection, id, op: OUTBOX_OP.UPSERT }));
  for (const id of deletes) {
    // A chunked entity's chunk count is only known from the value being
    // removed; remember it so the delete can remove the chunks too.
    const built = buildEntityDocument({ workspaceId: "-", collection, id, payload: previousEntities[id] });
    changes.push({ collection, id, op: OUTBOX_OP.DELETE, chunks: built.chunks.length });
  }
  return changes;
}

export function createCloudCapture({ storage, now } = {}) {
  return {
    needsPrevious(physicalKey) {
      return !snapshots.has(physicalKey);
    },
    record({ key, scope, physicalKey, previous, value, origin }) {
      if (!scope || scope.kind !== DURABLE_SCOPE_KIND.WORKSPACE) return;
      const collection = COLLECTION_BY_DURABLE_KEY[key];
      if (!collection) return;
      const previousEntities = snapshots.has(physicalKey)
        ? snapshots.get(physicalKey)
        : entitiesOfRecord(collection, previous) || {};
      const nextEntities = entitiesOfRecord(collection, value) || {};
      snapshots.set(physicalKey, nextEntities);
      if (origin === WRITE_ORIGIN.CLOUD) return;

      const changes = changesOf(collection, previousEntities, nextEntities);
      const carried = unsavedChanges.get(scope.id) || [];
      const all = carried.concat(changes);
      if (all.length === 0) return;
      try {
        enqueueOutbox(scope.id, all, { storage, now });
        unsavedChanges.delete(scope.id);
      } catch {
        unsavedChanges.set(scope.id, all);
        reportPersistenceIssue({
          kind: "cloud-outbox-write-failed",
          key,
          message: OUTBOX_WRITE_FAILED_MESSAGE,
        });
        return;
      }
      notify({ workspaceId: scope.id, changes });
    },
  };
}

let installed = false;

/** Installs the capture on the durable-storage boundary (idempotent). */
export function installCloudCapture(options) {
  setDurableWriteCapture(createCloudCapture(options));
  installed = true;
}

export function isCloudCaptureInstalled() {
  return installed;
}

/** Forgets the snapshot of every record of one workspace (or all). Called
 *  when a workspace session opens, so the first write after a hydration
 *  compares against what hydration wrote, never a stale snapshot. */
export function forgetCaptureSnapshots(workspaceId = null) {
  if (workspaceId === null) {
    snapshots.clear();
    return;
  }
  const marker = `/${workspaceId}/`;
  for (const key of Array.from(snapshots.keys())) {
    if (key.includes(marker)) snapshots.delete(key);
  }
}

/** Test-only. */
export function __resetCloudCaptureForTests() {
  setDurableWriteCapture(null);
  installed = false;
  listeners.clear();
  snapshots.clear();
  unsavedChanges.clear();
}
