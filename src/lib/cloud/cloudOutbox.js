// src/lib/cloud/cloudOutbox.js
//
// The persisted, per-workspace OUTBOX: which entities still have to reach
// Firestore. One small localStorage record per workspace:
//
//   notewise-cloud-outbox-v1/<workspaceId>
//   { version: 1, entries: { "<collection>/<id>": { collection, id, op, at, chunks } } }
//
// It stores IDENTITIES, not values: the value to write is read from the
// workspace mirror at flush time, so a burst of edits to one note is one
// entry and the flush always sends the latest state. `op` is "upsert" or
// "delete"; a later change to the same entity replaces the earlier entry.
// `at` is the stamp of the most recent change — a flush removes an entry only
// if it still carries the stamp the flush read, so a change made while a
// batch was in flight is never dropped. `chunks` remembers, for a delete, how
// many chunk documents the entity had, since the mirror no longer knows.
//
// Survives reloads, sign-out and the loss of the network: an entry stays
// until Firestore has ACCEPTED the write. Pure over an injectable Storage.

export const OUTBOX_KEY_PREFIX = "notewise-cloud-outbox-v1/";
export const OUTBOX_OP = Object.freeze({ UPSERT: "upsert", DELETE: "delete" });

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function outboxStorageKey(workspaceId) {
  return `${OUTBOX_KEY_PREFIX}${workspaceId}`;
}

export function outboxEntryKey(collection, id) {
  return `${collection}/${id}`;
}

function normalizeEntry(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  const [collection, ...rest] = String(key).split("/");
  const id = rest.join("/");
  if (!collection || !id) return null;
  const op = raw.op === OUTBOX_OP.DELETE ? OUTBOX_OP.DELETE : OUTBOX_OP.UPSERT;
  return {
    collection,
    id,
    op,
    at: Number(raw.at) || 0,
    chunks: Number.isInteger(raw.chunks) && raw.chunks > 0 ? raw.chunks : 0,
  };
}

/** The outbox of a workspace: `{ entries: { key: entry } }`. Never throws. */
export function readOutbox(workspaceId, storage = defaultStorage()) {
  const empty = { entries: {} };
  if (!storage || !workspaceId) return empty;
  let raw = null;
  try {
    raw = storage.getItem(outboxStorageKey(workspaceId));
  } catch {
    return empty;
  }
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    const entries = {};
    const source = parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
    for (const key of Object.keys(source)) {
      const entry = normalizeEntry(key, source[key]);
      if (entry) entries[key] = entry;
    }
    return { entries };
  } catch {
    // An unreadable outbox loses only "what still needs uploading"; the
    // mirror keeps the values. It is replaced by the next enqueue.
    return empty;
  }
}

function writeOutbox(workspaceId, outbox, storage) {
  const key = outboxStorageKey(workspaceId);
  if (Object.keys(outbox.entries).length === 0) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({ version: 1, entries: outbox.entries }));
}

/**
 * Records changes `[{ collection, id, op, chunks? }]`. Throws only when the
 * storage refuses the write — the caller decides how to surface that.
 * Returns the entries as stored.
 */
export function enqueueOutbox(workspaceId, changes, { storage = defaultStorage(), now = Date.now } = {}) {
  if (!storage) throw new Error("Browser storage is not available");
  const outbox = readOutbox(workspaceId, storage);
  const at = now();
  for (const change of changes || []) {
    if (!change || typeof change.collection !== "string" || typeof change.id !== "string" || !change.id) continue;
    const key = outboxEntryKey(change.collection, change.id);
    outbox.entries[key] = {
      collection: change.collection,
      id: change.id,
      op: change.op === OUTBOX_OP.DELETE ? OUTBOX_OP.DELETE : OUTBOX_OP.UPSERT,
      at,
      chunks: Number.isInteger(change.chunks) && change.chunks > 0 ? change.chunks : 0,
    };
  }
  writeOutbox(workspaceId, outbox, storage);
  return outbox.entries;
}

/**
 * Removes entries whose stamp is still the one the caller saw. An entry that
 * was re-queued meanwhile (a newer `at`) is kept. Returns how many were
 * removed. Never throws — a refused removal leaves entries that will simply
 * be re-sent (writes are idempotent sets).
 */
export function settleOutbox(workspaceId, settled, storage = defaultStorage()) {
  if (!storage) return 0;
  const outbox = readOutbox(workspaceId, storage);
  let removed = 0;
  for (const item of settled || []) {
    const key = outboxEntryKey(item.collection, item.id);
    const entry = outbox.entries[key];
    if (entry && entry.at === item.at) {
      delete outbox.entries[key];
      removed += 1;
    }
  }
  try {
    writeOutbox(workspaceId, outbox, storage);
  } catch {
    // see the contract above
  }
  return removed;
}

export function listOutboxEntries(workspaceId, storage = defaultStorage()) {
  return Object.values(readOutbox(workspaceId, storage).entries).sort((a, b) => a.at - b.at);
}

export function outboxSize(workspaceId, storage = defaultStorage()) {
  return Object.keys(readOutbox(workspaceId, storage).entries).length;
}

export function hasOutboxEntry(workspaceId, collection, id, storage = defaultStorage()) {
  return outboxEntryKey(collection, id) in readOutbox(workspaceId, storage).entries;
}

/** Every "collection/id" key still pending — what a hydration must not
 *  overwrite from the cloud. */
export function pendingOutboxKeys(workspaceId, storage = defaultStorage()) {
  return new Set(Object.keys(readOutbox(workspaceId, storage).entries));
}

/** Drops the whole outbox of a workspace. Used only by tests and by the
 *  explicit "remove this browser's copy" action after everything synced. */
export function clearOutbox(workspaceId, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(outboxStorageKey(workspaceId));
  } catch {
    // nothing to protect
  }
}
