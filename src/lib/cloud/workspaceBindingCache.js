// src/lib/cloud/workspaceBindingCache.js
//
// Which workspace each uid last resolved to on THIS browser — a local
// memory of the authoritative answer, so a field user whose session
// restores while offline can open their workspace's mirror without a round
// trip. It is a cache of a fact Firestore owns, never a source of it: an
// online sign-in always re-resolves through the bootstrap transaction and
// overwrites this record, and a uid that has never resolved here has no
// entry (there is no fallback to a guessed or invented workspace id).
//
//   notewise-workspace-binding-v1  { version: 1, byUid: { [uid]: { workspaceId, role, resolvedAt } } }
//
// Preference-grade: tolerant, never throwing.

export const WORKSPACE_BINDING_KEY = "notewise-workspace-binding-v1";

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function read(storage) {
  if (!storage) return { version: 1, byUid: {} };
  try {
    const parsed = JSON.parse(storage.getItem(WORKSPACE_BINDING_KEY) || "null");
    if (!parsed || parsed.version !== 1 || !parsed.byUid || typeof parsed.byUid !== "object") return { version: 1, byUid: {} };
    return { version: 1, byUid: { ...parsed.byUid } };
  } catch {
    return { version: 1, byUid: {} };
  }
}

/** The cached binding of a uid, or null. */
export function readWorkspaceBinding(uid, storage = defaultStorage()) {
  if (typeof uid !== "string" || !uid) return null;
  const entry = read(storage).byUid[uid];
  if (!entry || typeof entry.workspaceId !== "string" || !entry.workspaceId) return null;
  return {
    workspaceId: entry.workspaceId,
    role: typeof entry.role === "string" ? entry.role : "member",
    resolvedAt: Number(entry.resolvedAt) || 0,
  };
}

export function writeWorkspaceBinding(uid, { workspaceId, role }, { storage = defaultStorage(), now = Date.now } = {}) {
  if (!storage || typeof uid !== "string" || !uid || typeof workspaceId !== "string" || !workspaceId) return false;
  const record = read(storage);
  record.byUid[uid] = { workspaceId, role: role || "member", resolvedAt: now() };
  try {
    storage.setItem(WORKSPACE_BINDING_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function forgetWorkspaceBinding(uid, storage = defaultStorage()) {
  if (!storage || typeof uid !== "string") return;
  const record = read(storage);
  if (!(uid in record.byUid)) return;
  delete record.byUid[uid];
  try {
    storage.setItem(WORKSPACE_BINDING_KEY, JSON.stringify(record));
  } catch {
    // nothing to protect
  }
}
