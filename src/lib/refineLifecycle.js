// src/lib/refineLifecycle.js
//
// The pure state model behind AI Refine: the request lifecycle, the identity
// rules that stop a stale response landing in the wrong place, and the
// single-slot per-note Refine backup.
//
// Kept free of React and of the editor so every rule below is directly
// testable (no DOM testing library is installed — see docs/TESTING.md).
//
// Refine history is NOT Save progress history (src/lib/noteProgressHistory.js).
// Save progress keeps 20 user-created restore points per note per view.
// Refine keeps exactly ONE automatic pre-refine state per note, created only
// immediately before a valid AI result is applied. The two never share storage
// and are never merged.

export const REFINE_STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  SUCCESS: "success",
  UNAVAILABLE: "unavailable",
  FAILURE: "failure",
};

// Exactly one previous state per note. Deliberately not a list: the product
// has always offered a single-step revert, and deepening it without a decision
// would quietly turn Refine into a second history system.
export const REFINE_BACKUP_DEPTH = 1;

export function createRefineState() {
  return {
    status: REFINE_STATUS.IDLE,
    // The note the in-flight (or last) request belongs to.
    noteId: null,
    // Monotonic id, so a superseded response can be recognised.
    requestId: 0,
    message: null,
  };
}

/**
 * Enter the loading state for a specific note and request id.
 * A request is only startable from a non-loading state — this is the state-level
 * duplicate-submission guard that backs the disabled button.
 */
export function beginRefine(state, { noteId, requestId }) {
  if (!noteId || !requestId) return state;
  if (state.status === REFINE_STATUS.LOADING) return state;
  return {
    status: REFINE_STATUS.LOADING,
    noteId,
    requestId,
    message: null,
  };
}

export function isRefineLoading(state) {
  return !!state && state.status === REFINE_STATUS.LOADING;
}

/**
 * May this response be acted on at all?
 *
 * False for a response from a superseded request, so an older result can never
 * overwrite a newer one. The response's own originating note id is carried by
 * the caller and used for the write — see applyFreeformHtml in MainArea — so
 * this deliberately does NOT compare against whichever note is now on screen.
 */
export function shouldSettleResponse(state, { requestId }) {
  if (!state || !requestId) return false;
  if (state.status !== REFINE_STATUS.LOADING) return false;
  return state.requestId === requestId;
}

/**
 * Leave the loading state. Ignored for a superseded request so a late response
 * cannot clear the loading state of the request that replaced it.
 */
export function settleRefine(state, { requestId, outcome, message }) {
  if (!shouldSettleResponse(state, { requestId })) return state;
  const status =
    outcome === REFINE_STATUS.SUCCESS ||
    outcome === REFINE_STATUS.UNAVAILABLE ||
    outcome === REFINE_STATUS.FAILURE
      ? outcome
      : REFINE_STATUS.FAILURE;
  return { ...state, status, message: message || null };
}

/**
 * Drop a transient message that no longer describes what the user is looking
 * at (note or view change). An in-flight request is left alone: it still owns
 * its originating note and must still be able to settle.
 */
export function clearRefineMessage(state) {
  if (!state || state.status === REFINE_STATUS.LOADING) return state;
  if (state.status === REFINE_STATUS.IDLE && !state.message) return state;
  return { ...createRefineState(), requestId: state.requestId };
}

/* ------------------------------------------------------------------------ */
/* Per-note Refine backup                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Record the pre-refine Free-form HTML for ONE note.
 *
 * Callers must only reach here after a valid AI result has been received —
 * failure, unavailable, timeout, malformed and empty output must create no
 * backup at all, or Revert would offer to restore a state that was never left.
 */
export function setRefineBackup(backups, noteId, html) {
  if (!noteId || typeof html !== "string") return backups || {};
  return { ...(backups || {}), [noteId]: html };
}

/**
 * The backup for exactly this note. Returns null for every other note, which
 * is what stops Note A's backup being applied to Note B.
 */
export function getRefineBackup(backups, noteId) {
  if (!backups || !noteId) return null;
  const html = backups[noteId];
  return typeof html === "string" ? html : null;
}

export function hasRefineBackup(backups, noteId) {
  return getRefineBackup(backups, noteId) !== null;
}

export function clearRefineBackup(backups, noteId) {
  if (!backups || !noteId || !(noteId in backups)) return backups || {};
  const next = { ...backups };
  delete next[noteId];
  return next;
}

/**
 * Drop backups belonging to notes that no longer exist, mirroring the
 * deleted-note cleanup the Save progress history performs. Returns the SAME
 * reference when nothing needs removing, so it cannot drive a render loop.
 */
export function pruneRefineBackups(backups, liveNoteIds) {
  if (!backups) return {};
  const ids = Object.keys(backups);
  if (!ids.length) return backups;
  const keep = ids.filter((id) => liveNoteIds && liveNoteIds.has(id));
  if (keep.length === ids.length) return backups;
  const next = {};
  for (const id of keep) next[id] = backups[id];
  return next;
}
