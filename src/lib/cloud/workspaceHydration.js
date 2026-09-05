// src/lib/cloud/workspaceHydration.js
//
// HYDRATION: places the cloud source of truth into the workspace's local
// mirror so the synchronous owner modules (and AppStateProvider, which
// hydrates from them on mount) see exactly what Firestore holds.
//
// Runs after the outbox has been replayed. Rules:
//   - every entity document is validated (src/lib/cloud/cloudModel.js →
//     readEntityDocument); a MALFORMED document is reported, excluded from
//     the mirror and marked so the sync engine never overwrites it with a
//     locally derived value — it is never treated as authoritative empty
//     data, and never silently "repaired";
//   - an entity that still has a PENDING outbox entry keeps the mirror's
//     value (a change made offline must not be undone by an older cloud
//     copy); everything else is the cloud's;
//   - the mirror is written with origin "cloud", so the capture updates its
//     snapshot and queues nothing — a download is never re-uploaded;
//   - a document of an ASYNC collection (src/lib/cloud/cloudModel.js →
//     ASYNC_ENTITY_COLLECTIONS; pdfAnnotations, whose local copy is
//     IndexedDB) is validated here exactly like the others — envelope, chunks
//     and payload shape, malformed ones reported the same way — and handed
//     back as `deferred[collection][id]` for its own module to place
//     (src/lib/pdfAnnotationSync.js), because the mirror is not its home.

import { WRITE_ORIGIN, readDurableRecord, writeDurableRecord } from "../durableStorage";
import { DURABLE_KEY_BY_COLLECTION } from "./cloudCapture";
import {
  ASYNC_ENTITY_COLLECTIONS,
  CLOUD_COLLECTION,
  ENTITY_COLLECTIONS,
  entitiesOfRecord,
  readEntityDocument,
  recordOfEntities,
  validatePdfAnnotationPayload,
} from "./cloudModel";
import { outboxEntryKey } from "./cloudOutbox";

export const MALFORMED_CLOUD_RECORD_MESSAGE =
  "One or more records in your account could not be read and were left untouched in the cloud. The app is continuing without them.";

/**
 * @param {{
 *   workspaceId: string,
 *   store: { readWorkspace: (workspaceId: string) => Promise<{ documents: object[] }> },
 *   storage?: Storage,
 *   pendingKeys?: Set<string>,          "collection/id" keys with queued local changes
 *   onMalformed?: (entry: { collection: string, id: string, reason: string }) => void,
 * }} options
 * @returns {Promise<{ counts: { [collection]: number }, malformed: object[], deferred: { [collection]: { [id]: payload } } }>}
 */
export async function hydrateWorkspaceMirror({ workspaceId, store, storage, pendingKeys = new Set(), onMalformed = null }) {
  const scope = Object.freeze({ kind: "workspace", id: workspaceId });
  const { documents } = await store.readWorkspace(workspaceId);

  const byCollection = {};
  for (const collection of ENTITY_COLLECTIONS) byCollection[collection] = {};
  const deferred = {};
  for (const collection of ASYNC_ENTITY_COLLECTIONS) deferred[collection] = {};
  const malformed = [];

  for (const doc of documents || []) {
    if (!doc) continue;
    const isMirror = ENTITY_COLLECTIONS.includes(doc.collection);
    const isDeferred = ASYNC_ENTITY_COLLECTIONS.includes(doc.collection);
    if (!isMirror && !isDeferred) continue;
    let result = readEntityDocument({
      workspaceId,
      collection: doc.collection,
      id: doc.id,
      fields: doc.fields,
      chunks: doc.chunks || [],
    });
    if (result.ok && doc.collection === CLOUD_COLLECTION.PDF_ANNOTATIONS) {
      const check = validatePdfAnnotationPayload(result.payload);
      result = check.ok ? { ok: true, payload: { items: check.items } } : { ok: false, reason: check.reason };
    }
    if (result.ok) {
      (isMirror ? byCollection : deferred)[doc.collection][doc.id] = result.payload;
    } else {
      const entry = { collection: doc.collection, id: doc.id, reason: result.reason };
      malformed.push(entry);
      if (onMalformed) onMalformed(entry);
    }
  }

  const counts = {};
  for (const collection of ENTITY_COLLECTIONS) {
    const key = DURABLE_KEY_BY_COLLECTION[collection];
    const cloudEntities = byCollection[collection];
    // Pending local changes win over the cloud copy.
    const current = entitiesOfRecord(collection, readDurableRecord(key, { storage, scope }).value) || {};
    for (const id of Object.keys(current)) {
      if (pendingKeys.has(outboxEntryKey(collection, id))) cloudEntities[id] = current[id];
    }
    for (const pendingKey of pendingKeys) {
      const [c, ...rest] = pendingKey.split("/");
      const id = rest.join("/");
      if (c === collection && !(id in current)) delete cloudEntities[id]; // a pending delete
    }
    counts[collection] = Object.keys(cloudEntities).length;
    writeDurableRecord(key, recordOfEntities(collection, cloudEntities), { storage, scope, origin: WRITE_ORIGIN.CLOUD });
  }

  return { counts, malformed, deferred };
}
