// src/lib/localDataBinding.js
//
// The marker that RECORDS — and only records — which signed-in accounts have
// used this browser's local NoteWise data.
//
// Authentication arrived (Production Readiness Phase 5) while every note,
// template and PDF still lives in this browser's storage. That data belongs
// to whoever uses this browser profile, exactly as before; signing in does
// not move, copy, hide, re-key or claim it. What the future cloud-migration
// phase needs is to know, at that point, whether the local data was ever
// used under a DIFFERENT account than the one about to migrate it — so it
// can ask rather than silently merge one person's notes into another's
// workspace. This record is that memory:
//
//   {
//     version: 1,
//     firstUid, firstSeenAt,       the first account that opened the app here
//                                  while local data existed
//     lastUid, lastSeenAt,         the most recent one
//     uids: [...],                 every distinct account seen (capped)
//     migration: { status, uid, workspaceId, sourceId, startedAt, completedAt, counts }
//                                  the explicit local→cloud migration's record
//                                  (src/lib/cloud/localMigration.js): which
//                                  account moved this data into which
//                                  workspace, and how far it got
//   }
//
// It is a preference-grade record: tolerant, never throwing, never blocking,
// and NOT part of the durable catalogue (src/lib/durableStorage.js) — losing
// it loses a hint, not customer content. It never influences what the
// application reads or shows.

import { DURABLE_KEYS } from "./durableStorage";

export const LOCAL_DATA_BINDING_KEY = "notewise-local-data-account-v1";
export const MIGRATION_STATUS = Object.freeze({
  NOT_STARTED: "not-started",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  FAILED: "failed",
});
const MAX_UIDS = 10;

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * True when any durable customer record exists in this browser. Reads the
 * raw values only — it never parses (and so never triggers the corruption
 * quarantine) and never writes.
 */
export function hasLocalCustomerData(storage = defaultStorage()) {
  if (!storage) return false;
  for (const key of Object.values(DURABLE_KEYS)) {
    try {
      const raw = storage.getItem(key);
      if (typeof raw === "string" && raw.trim() !== "" && raw.trim() !== "{}") return true;
    } catch {
      // unreadable key: not evidence of data
    }
  }
  return false;
}

function normalizeMigration(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  const status = Object.values(MIGRATION_STATUS).includes(m.status) ? m.status : MIGRATION_STATUS.NOT_STARTED;
  const out = { status };
  if (typeof m.uid === "string") out.uid = m.uid;
  if (typeof m.workspaceId === "string") out.workspaceId = m.workspaceId;
  if (typeof m.sourceId === "string") out.sourceId = m.sourceId;
  if (Number(m.startedAt)) out.startedAt = Number(m.startedAt);
  if (Number(m.completedAt)) out.completedAt = Number(m.completedAt);
  if (m.counts && typeof m.counts === "object") out.counts = m.counts;
  return out;
}

/** The record, or null when absent or unreadable. */
export function readLocalDataBinding(storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LOCAL_DATA_BINDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    return {
      version: 1,
      firstUid: typeof parsed.firstUid === "string" ? parsed.firstUid : null,
      firstSeenAt: Number(parsed.firstSeenAt) || 0,
      lastUid: typeof parsed.lastUid === "string" ? parsed.lastUid : null,
      lastSeenAt: Number(parsed.lastSeenAt) || 0,
      uids: Array.isArray(parsed.uids) ? parsed.uids.filter((u) => typeof u === "string") : [],
      migration: normalizeMigration(parsed.migration),
    };
  } catch {
    return null;
  }
}

/**
 * Note that `uid` is using this browser now. Writes only when local customer
 * data exists (an empty browser has nothing to bind) and only when something
 * changed. Returns the record as stored, or null when nothing was recorded.
 * Never throws.
 */
export function recordAccountSession(uid, { storage = defaultStorage(), now = Date.now() } = {}) {
  if (!storage || typeof uid !== "string" || !uid.trim()) return null;
  if (!hasLocalCustomerData(storage)) return readLocalDataBinding(storage);

  const existing = readLocalDataBinding(storage);
  const next = existing
    ? { ...existing, uids: [...existing.uids] }
    : {
        version: 1,
        firstUid: uid,
        firstSeenAt: now,
        lastUid: uid,
        lastSeenAt: now,
        uids: [],
        migration: { status: MIGRATION_STATUS.NOT_STARTED },
      };
  if (!next.uids.includes(uid)) next.uids = [...next.uids, uid].slice(-MAX_UIDS);
  if (!next.firstUid) {
    next.firstUid = uid;
    next.firstSeenAt = now;
  }
  next.lastUid = uid;
  next.lastSeenAt = now;

  try {
    storage.setItem(LOCAL_DATA_BINDING_KEY, JSON.stringify(next));
  } catch {
    // Preference-grade: a refused write loses a hint, never content.
  }
  return next;
}

/**
 * Records the state of the explicit local→cloud migration. Writes even when
 * the binding does not exist yet (a run can only start with local data, so
 * the binding normally does). Never throws; returns the record as stored.
 */
export function recordMigrationState(migration, { storage = defaultStorage(), now = Date.now() } = {}) {
  if (!storage || !migration || typeof migration !== "object") return null;
  const existing = readLocalDataBinding(storage) || {
    version: 1,
    firstUid: typeof migration.uid === "string" ? migration.uid : null,
    firstSeenAt: now,
    lastUid: typeof migration.uid === "string" ? migration.uid : null,
    lastSeenAt: now,
    uids: typeof migration.uid === "string" ? [migration.uid] : [],
    migration: { status: MIGRATION_STATUS.NOT_STARTED },
  };
  const next = { ...existing, migration: normalizeMigration(migration) };
  try {
    storage.setItem(LOCAL_DATA_BINDING_KEY, JSON.stringify(next));
  } catch {
    // Preference-grade: the data itself is safe in the mirror and outbox.
  }
  return next;
}

/**
 * True when the local data has been used under an account other than `uid`.
 * The future migration step asks before binding in that case.
 */
export function localDataSeenUnderOtherAccount(uid, storage = defaultStorage()) {
  const record = readLocalDataBinding(storage);
  if (!record) return false;
  return record.uids.some((seen) => seen !== uid);
}
