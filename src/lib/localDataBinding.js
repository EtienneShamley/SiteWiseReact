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
//     migration: { status: "not-started" }   reserved for the migration phase
//   }
//
// It is a preference-grade record: tolerant, never throwing, never blocking,
// and NOT part of the durable catalogue (src/lib/durableStorage.js) — losing
// it loses a hint, not customer content. It never influences what the
// application reads or shows.

import { DURABLE_KEYS } from "./durableStorage";

export const LOCAL_DATA_BINDING_KEY = "notewise-local-data-account-v1";
export const MIGRATION_STATUS = Object.freeze({ NOT_STARTED: "not-started" });
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
      migration: {
        status:
          parsed.migration && typeof parsed.migration.status === "string"
            ? parsed.migration.status
            : MIGRATION_STATUS.NOT_STARTED,
      },
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
 * True when the local data has been used under an account other than `uid`.
 * The future migration step asks before binding in that case.
 */
export function localDataSeenUnderOtherAccount(uid, storage = defaultStorage()) {
  const record = readLocalDataBinding(storage);
  if (!record) return false;
  return record.uids.some((seen) => seen !== uid);
}
