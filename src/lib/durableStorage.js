// src/lib/durableStorage.js
//
// The ONE place durable customer data enters and leaves localStorage.
//
// "Durable" means product data a user cannot recreate from memory: the
// project/folder/note tree, Free-form note content, the template library and
// its immutable versions, per-note template instances, the PDF registry and
// note→PDF links. UI preferences (theme, zoom, refine mode, a per-note
// coordinate system) are NOT durable in this sense: they have their own
// tolerant, never-throwing helpers and do not come through here.
//
// Every durable record is a JSON value under one key from DURABLE_KEYS — the
// authoritative catalogue. Owner modules (treeStorage, noteContentStorage,
// templateModel, pdfDocuments, notePdfRefs) import their key from it and
// re-export it, so a key literal never appears anywhere else.
//
// Two guarantees this module exists for:
//
//   1. A malformed record is NEVER silently treated as authoritative empty
//      data. Before a corrupt value can be read as "nothing stored", its raw
//      text is copied verbatim to a quarantine key (`<key>.corrupt.<ts>`) and
//      indexed, so a later write to the original key destroys nothing that
//      cannot be recovered by hand. If quarantining itself fails (quota,
//      storage refusing writes), writes to that key are REFUSED until the
//      record is acknowledged — the only remaining way to lose the data would
//      be to overwrite it, and that is exactly what is blocked.
//
//   2. A write that did not land is never reported as a write that did.
//      `writeDurableRecord` throws on quota, serialization or refusal; the
//      caller decides how to surface that (the persistence banner, the note's
//      save status). Nothing here swallows a failure.
//
// Both are observable: `subscribePersistenceIssues` delivers a user-safe
// message (never an exception, a stack trace or note text) whenever a record
// is quarantined or blocked, and `listQuarantinedRecords` exposes what was
// set aside.
//
// Every function takes an optional `storage` so the behaviour is testable
// against an in-memory Storage as well as jsdom's real localStorage.
//
// SCOPE (Production Readiness Phase 6). The catalogue names LOGICAL records;
// where each one physically lives depends on the active durable scope:
//
//   { kind: "local" }               the legacy, pre-account records under the
//                                   bare key — this browser's own data, the
//                                   SOURCE of the explicit local→cloud
//                                   migration and never written by a signed-in
//                                   session;
//   { kind: "workspace", id }       the signed-in account's workspace: every
//                                   key is namespaced under the workspace id
//                                   (`notewise-workspace-v1/<id>/<key>`), so
//                                   two accounts on one browser can never read
//                                   or write each other's records, and a
//                                   workspace's records are its MIRROR of the
//                                   cloud source of truth (src/lib/cloud/).
//
// Owner modules never see this: they keep asking for the logical key and the
// scope decides the physical one. A WRITE CAPTURE hook (installed by the
// cloud layer) sees every durable write with its previous value, which is how
// entity-level cloud writes are derived without the owner modules changing.

export const DURABLE_KEYS = Object.freeze({
  tree: "notewise-tree-v1",
  noteContent: "sitewise-notes",
  templates: "sitewise-templates-v1",
  templateVersions: "sitewise-template-versions-v1",
  templateInstances: "sitewise-note-template-instances-v1",
  pdfDocs: "notewise-pdf-docs-v1",
  notePdfRefs: "notewise-note-pdf-refs-v1",
  // Workspace-level pointers (the default template). Added in Phase 6 so the
  // pointer is a durable, captured record; the pre-account string key it
  // replaces is still read as a fallback (src/lib/templateModel.js).
  workspaceSettings: "notewise-workspace-settings-v1",
});

// User-facing names for the catalogue above — what a persistence message may
// say about a record. Never the key itself.
const RECORD_LABELS = Object.freeze({
  [DURABLE_KEYS.tree]: "your projects and folders",
  [DURABLE_KEYS.noteContent]: "your note content",
  [DURABLE_KEYS.templates]: "your templates",
  [DURABLE_KEYS.templateVersions]: "your template versions",
  [DURABLE_KEYS.templateInstances]: "your template notes",
  [DURABLE_KEYS.pdfDocs]: "your PDF list",
  [DURABLE_KEYS.notePdfRefs]: "your note↔PDF links",
  [DURABLE_KEYS.workspaceSettings]: "your workspace settings",
});

export const CORRUPT_RECORD_INDEX_KEY = "notewise-corrupt-records-v1";
export const CORRUPT_QUARANTINE_INFIX = ".corrupt.";

export const RECORD_STATE = Object.freeze({
  MISSING: "missing",
  OK: "ok",
  CORRUPT: "corrupt",
});

export const PERSISTENCE_ISSUE = Object.freeze({
  CORRUPT_QUARANTINED: "corrupt-quarantined",
  CORRUPT_UNRECOVERABLE: "corrupt-unrecoverable",
  WRITE_BLOCKED: "write-blocked",
});

export function recordLabel(key) {
  return RECORD_LABELS[key] || "some stored data";
}

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/* ---------------------------------- scope -------------------------------- */

export const DURABLE_SCOPE_KIND = Object.freeze({ LOCAL: "local", WORKSPACE: "workspace" });
export const WORKSPACE_SCOPE_PREFIX = "notewise-workspace-v1/";
const LOCAL_SCOPE = Object.freeze({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });

let activeScope = LOCAL_SCOPE;

/** A frozen, validated scope. Anything that is not a workspace with an id is
 *  the local scope. */
export function normalizeDurableScope(scope) {
  if (
    scope &&
    scope.kind === DURABLE_SCOPE_KIND.WORKSPACE &&
    typeof scope.id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(scope.id)
  ) {
    return Object.freeze({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: scope.id });
  }
  return LOCAL_SCOPE;
}

/** Makes `scope` the one every durable read and write resolves against. */
export function setDurableScope(scope) {
  activeScope = normalizeDurableScope(scope);
  return activeScope;
}

export function getDurableScope() {
  return activeScope;
}

/** The physical storage key of a logical key in a scope (default: active). */
export function scopedStorageKey(key, scope = activeScope) {
  const s = normalizeDurableScope(scope);
  return s.kind === DURABLE_SCOPE_KIND.WORKSPACE ? `${WORKSPACE_SCOPE_PREFIX}${s.id}/${key}` : key;
}

/** True when `physicalKey` belongs to a workspace scope; returns its id. */
export function workspaceIdOfStorageKey(physicalKey) {
  if (typeof physicalKey !== "string" || !physicalKey.startsWith(WORKSPACE_SCOPE_PREFIX)) return null;
  const rest = physicalKey.slice(WORKSPACE_SCOPE_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
}

/* -------------------- scope-following, non-durable values ---------------- */
// Small markers that must FOLLOW the scope (migration guards, the default
// template pointer) without being durable records: tolerant helpers that
// never throw and never quarantine. They exist so no owner module has to
// know how a key is namespaced.

export function readScopedValue(key, storage = defaultStorage(), scope = activeScope) {
  if (!storage) return null;
  try {
    const value = storage.getItem(scopedStorageKey(key, scope));
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function writeScopedValue(key, value, storage = defaultStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(scopedStorageKey(key), String(value));
    return true;
  } catch {
    return false;
  }
}

export function removeScopedValue(key, storage = defaultStorage()) {
  if (!storage) return false;
  try {
    storage.removeItem(scopedStorageKey(key));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ write capture ---------------------------- */
// One capture at a time. `needsPrevious(physicalKey)` says whether the
// capture wants the stored value read BEFORE the write (it keeps its own
// snapshot afterwards); `record(event)` runs after a CONFIRMED write with
//   { key, scope, physicalKey, previous, value, origin }
// where `origin` is "app" for an ordinary write and "cloud" for a value the
// cloud layer is placing into the mirror (which must never round-trip back).

let writeCapture = null;

export const WRITE_ORIGIN = Object.freeze({ APP: "app", CLOUD: "cloud" });

export function setDurableWriteCapture(capture) {
  writeCapture =
    capture && typeof capture.record === "function" && typeof capture.needsPrevious === "function"
      ? capture
      : null;
}

function parseOrNull(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ------------------------------ issue channel ---------------------------- */

const listeners = new Set();

/** Subscribe to user-safe persistence issues. Returns an unsubscribe. */
export function subscribePersistenceIssues(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reports a persistence issue to every subscriber. A listener that throws
 *  cannot break the caller or the other listeners. */
export function reportPersistenceIssue(issue) {
  for (const listener of Array.from(listeners)) {
    try {
      listener(issue);
    } catch {
      // A listener failure must never turn a report into a crash.
    }
  }
}

/* ----------------------- corruption quarantine + block -------------------- */

// Keys whose corrupt raw value could NOT be quarantined. A write to one of
// these would destroy the only copy, so it is refused until acknowledged.
// In-memory by design: a reload re-reads the record and retries quarantine.
const blockedKeys = new Set();

export class DurableWriteBlockedError extends Error {
  constructor(key) {
    super(
      `Stored data for ${recordLabel(key)} is unreadable and could not be set aside for recovery, so it was not overwritten.`
    );
    this.name = "DurableWriteBlockedError";
    this.key = key;
  }
}

function readIndex(storage) {
  try {
    const raw = storage.getItem(CORRUPT_RECORD_INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === "object") : [];
  } catch {
    return [];
  }
}

/** Every record set aside so far: [{ key, quarantineKey, at, bytes }].
 *  `key` is the PHYSICAL key (scope-qualified for a workspace record). */
export function listQuarantinedRecords(storage = defaultStorage()) {
  if (!storage) return [];
  return readIndex(storage).map((e) => ({
    key: String(e.key || ""),
    quarantineKey: String(e.quarantineKey || ""),
    at: Number(e.at) || 0,
    bytes: Number(e.bytes) || 0,
  }));
}

/** True when writes to `key` (in the active scope) are currently refused. */
export function isDurableWriteBlocked(key) {
  return blockedKeys.has(scopedStorageKey(key));
}

/** Lifts a write block after the caller has dealt with the unreadable
 *  record (exported the raw value, decided to discard it). */
export function acknowledgeCorruptRecord(key) {
  blockedKeys.delete(scopedStorageKey(key));
}

// Copies the raw text aside. Returns true when a copy is safely stored (now
// or from an earlier run with identical content), false when it is not.
function quarantine(storage, key, raw, now) {
  const index = readIndex(storage);
  for (const entry of index) {
    if (entry.key !== key) continue;
    try {
      if (storage.getItem(entry.quarantineKey) === raw) return true;
    } catch {
      // fall through and try a fresh copy
    }
  }
  const quarantineKey = `${key}${CORRUPT_QUARANTINE_INFIX}${now}`;
  try {
    storage.setItem(quarantineKey, raw);
    // Confirm the copy actually landed before trusting it.
    if (storage.getItem(quarantineKey) !== raw) return false;
    index.push({ key, quarantineKey, at: now, bytes: raw.length });
    storage.setItem(CORRUPT_RECORD_INDEX_KEY, JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------- read ---------------------------------- */

/**
 * Reads one durable record.
 *
 *   { state: "missing", value: null }
 *   { state: "ok",      value }
 *   { state: "corrupt", value: null, quarantined: boolean }
 *
 * A corrupt record is quarantined (see header) and reported before this
 * returns; callers then degrade to their empty shape. Storage being entirely
 * unavailable reads as "missing" — there is nothing to protect.
 */
export function readDurableRecord(key, { storage = defaultStorage(), now = Date.now, scope = activeScope } = {}) {
  if (!storage) return { state: RECORD_STATE.MISSING, value: null };
  const physicalKey = scopedStorageKey(key, scope);
  let raw = null;
  try {
    raw = storage.getItem(physicalKey);
  } catch {
    return { state: RECORD_STATE.MISSING, value: null };
  }
  if (raw === null || raw === undefined || raw === "") {
    return { state: RECORD_STATE.MISSING, value: null };
  }
  try {
    return { state: RECORD_STATE.OK, value: JSON.parse(raw) };
  } catch {
    const quarantined = quarantine(storage, physicalKey, raw, now());
    if (quarantined) blockedKeys.delete(physicalKey);
    else blockedKeys.add(physicalKey);
    reportPersistenceIssue({
      kind: quarantined
        ? PERSISTENCE_ISSUE.CORRUPT_QUARANTINED
        : PERSISTENCE_ISSUE.CORRUPT_UNRECOVERABLE,
      key,
      message: quarantined
        ? `Stored data for ${recordLabel(key)} could not be read. The unreadable copy was set aside for recovery and the app is continuing without it.`
        : `Stored data for ${recordLabel(key)} could not be read and could not be set aside for recovery. It has not been overwritten; free some browser storage and reload.`,
    });
    return { state: RECORD_STATE.CORRUPT, value: null, quarantined };
  }
}

/**
 * Reads a durable record that must be a plain object map. Anything else —
 * missing, corrupt, an array, a scalar — reads as `{}` (a fresh copy, never a
 * shared one). The record's state travels alongside for callers that care.
 */
export function readDurableMap(key, options) {
  const result = readDurableRecord(key, options);
  const value = result.value;
  const map =
    value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  return { map, state: result.state };
}

/* --------------------------------- write --------------------------------- */

/**
 * Writes one durable record. THROWS when the write cannot be trusted:
 *   - the key is blocked (its corrupt value could not be set aside),
 *   - the value does not serialize,
 *   - storage refuses the write (quota, unavailable).
 * Returning without throwing IS the confirmation.
 */
export function writeDurableRecord(
  key,
  value,
  { storage = defaultStorage(), origin = WRITE_ORIGIN.APP, scope = activeScope } = {}
) {
  const writeScope = normalizeDurableScope(scope);
  const physicalKey = scopedStorageKey(key, writeScope);
  if (blockedKeys.has(physicalKey)) {
    const err = new DurableWriteBlockedError(key);
    reportPersistenceIssue({ kind: PERSISTENCE_ISSUE.WRITE_BLOCKED, key, message: err.message });
    throw err;
  }
  if (!storage) throw new Error("Browser storage is not available");
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") {
    throw new Error("The record could not be serialized");
  }
  const capture = writeCapture;
  const previous =
    capture && capture.needsPrevious(physicalKey) ? parseOrNull(storage.getItem(physicalKey)) : undefined;
  storage.setItem(physicalKey, serialized);
  if (capture) {
    capture.record({ key, scope: writeScope, physicalKey, previous, value, origin });
  }
}

/** Removes one durable record. Throws if storage refuses. */
export function removeDurableRecord(
  key,
  { storage = defaultStorage(), origin = WRITE_ORIGIN.APP, scope = activeScope } = {}
) {
  if (!storage) throw new Error("Browser storage is not available");
  const removeScope = normalizeDurableScope(scope);
  const physicalKey = scopedStorageKey(key, removeScope);
  const capture = writeCapture;
  const previous =
    capture && capture.needsPrevious(physicalKey) ? parseOrNull(storage.getItem(physicalKey)) : undefined;
  storage.removeItem(physicalKey);
  if (capture) {
    capture.record({ key, scope: removeScope, physicalKey, previous, value: null, origin });
  }
}

/** True when a record (any content) is physically stored for `key` in the
 *  active scope. Never parses. */
export function hasDurableRecord(key, storage = defaultStorage(), scope = activeScope) {
  if (!storage) return false;
  try {
    const raw = storage.getItem(scopedStorageKey(key, scope));
    return typeof raw === "string" && raw !== "";
  } catch {
    return false;
  }
}

/* --------------------------------- tests --------------------------------- */

/** Test-only: forgets in-memory blocks, listeners, the scope and the capture. */
export function __resetDurableStorageForTests() {
  blockedKeys.clear();
  listeners.clear();
  activeScope = LOCAL_SCOPE;
  writeCapture = null;
}
