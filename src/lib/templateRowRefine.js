// src/lib/templateRowRefine.js
//
// The SHARED per-target AI-refine lifecycle of the Template form: the status
// vocabulary, the field-scoped user-facing messages, the "is there any text to
// refine" gate, the per-TARGET request lifecycle map, and the generic per-note
// Revert-backup map helpers.
//
// This is NOT whole-note refinement and NOT a second AI contract. Everything
// that talks to the provider is reused unchanged:
//   - the style presets, the allowlist and output validation come from
//     src/lib/refineContract.js (the same module the server enforces),
//   - the request itself goes through src/lib/refineClient.js (one request per
//     call, no automatic retry),
//   - the status vocabulary is src/lib/refineLifecycle.js REFINE_STATUS.
// The only thing defined here is what the shared modules cannot express: state
// keyed by TARGET, and messages that say "this field" instead of "your note".
//
// ---------------------------------------------------------------------------
// PHASE G — the legacy TARGET MODEL was retired
// ---------------------------------------------------------------------------
//
// Until Phase G this module also owned the LEGACY refine writers: a target was
// a legacy Text row's `answers[rowId]` / `customRows[].answer`, or ONE
// `sectionContent` TEXT item addressed by its stable id, and this module read
// that value, built the request, decided whether a returning response could
// still be applied (`canApplyRowRefineResponse`) and wrote the refined value
// back into the instance. Every flexible Template Section is now ONE shared
// ProseMirror document, refined as a TEXT RUN of that document through
// src/lib/templateSectionRefine.js — one editor transaction, one undo step,
// stale-response validation against the live range — so no legacy writer is
// reachable for any supported row, and those functions were deleted with the
// interaction that called them (`rowRefineTargetKey`, `isRefineTargetKeyForRow`,
// `readSectionTextItemValue`, `applySectionTextItemToInstance`,
// `makeRowRefineRequest`, `readRowAnswer`, `applyRowAnswerToInstance`,
// `canApplyRowRefineResponse`, `isRefinableRow(Type)`, and the answer-typed
// backup accessors). The MODERN target key is `sectionRefineTargetKey`
// (`rowId::seg::n`), and its backups are `makeSectionRefineBackup` pairs — both
// in templateSectionRefine.js — stored in the generic per-note map the helpers
// at the bottom of this file still manage.
//
// Ownership boundaries this module continues to protect: one status slot per
// target, so a request on one Section neither blocks nor reports on another; a
// late response can never clear or overwrite a NEWER request's state; and a
// backup for note A / target A is unreachable from note B / target B.
//
// Pure: no React, no storage, no fetch, no DOM.

import { REFINE_OUTCOME } from "./refineContract";
import { REFINE_STATUS } from "./refineLifecycle";
import { richAnswerText } from "./templateRichText";

// The row lifecycle uses the SAME status vocabulary as note-level Refine —
// re-exported rather than redefined so the two can never drift apart.
export const ROW_REFINE_STATUS = REFINE_STATUS;

/* ------------------------------------------------------------------------ */
/* User-facing messages                                                      */
/* ------------------------------------------------------------------------ */

// Field-scoped wording. The note-level equivalents in refineContract say "your
// note has not been changed", which would be actively misleading on a single
// row of a form. Keyed by the SHARED outcome constants, so a new outcome cannot
// be handled here without being handled there.
export const ROW_REFINE_MESSAGE = {
  [REFINE_OUTCOME.UNAVAILABLE]:
    "AI refinement is currently unavailable. This field has not been changed.",
  [REFINE_OUTCOME.FAILURE]:
    "AI refinement could not complete. This field has not been changed.",
};

export function rowRefineMessageFor(outcome) {
  return ROW_REFINE_MESSAGE[outcome] || ROW_REFINE_MESSAGE[REFINE_OUTCOME.FAILURE];
}

// No provider request is made for an empty field — this is said instead.
export const ROW_REFINE_EMPTY_MESSAGE =
  "Enter text in this field before refining.";

// The user kept typing while the request was in flight. Their newer text wins;
// the AI result is discarded and no Revert backup is created, because nothing
// was replaced.
export const ROW_REFINE_CHANGED_MESSAGE =
  "This field changed while AI was working. The result was not applied.";

// The result was valid but could not be persisted. The answer is unchanged.
export const ROW_REFINE_SAVE_FAILED_MESSAGE =
  "The refined text could not be saved to this note. This field has not been changed.";

// Revert could not be persisted. The field keeps its refined text rather than
// being left in a state that exists only on screen.
export const ROW_REFINE_REVERT_FAILED_MESSAGE =
  "The previous text could not be restored. This field has not been changed.";

export const ROW_REFINE_LOADING_MESSAGE = "Refining this field…";
export const ROW_REFINE_SUCCESS_MESSAGE = "Field refined.";
export const ROW_REFINE_REVERTED_MESSAGE = "Refinement reverted.";

/* ------------------------------------------------------------------------ */
/* Eligibility                                                               */
/* ------------------------------------------------------------------------ */

// Whitespace is not content: an all-space run must not spend a request.
// A text run's value is a plain string or a tagged rich value, so emptiness is
// judged on the value's PLAIN-TEXT projection — never on its markup. Which
// ROWS may be refined at all is the modern owner's decision
// (`resolveSectionRefineOwner` in src/lib/templateSectionRefine.js).
export function hasRefinableText(value) {
  return richAnswerText(value).trim().length > 0;
}

/* ------------------------------------------------------------------------ */
/* Per-target request lifecycle                                              */
/* ------------------------------------------------------------------------ */
//
// { [targetKey]: { status, message, requestId } } — one slot per TARGET, so a
// request on one row neither blocks nor reports on another, and neither does a
// request on one section text item against another item of the SAME section.
//
// `targetKey` is the modern `sectionRefineTargetKey` (`rowId::seg::n`) — one
// slot per text run of one Section. The map's shape is unchanged from the
// legacy keying it replaced; only what a key names is different.

export function createRowRefineState() {
  return {};
}

export function getRowRefineState(map, targetKey) {
  if (!map || !targetKey) return null;
  return map[targetKey] || null;
}

export function isRowRefineLoading(map, targetKey) {
  const entry = getRowRefineState(map, targetKey);
  return !!entry && entry.status === ROW_REFINE_STATUS.LOADING;
}

/**
 * Enter loading for one target. Refused (same reference returned) while that
 * target already has a request in flight — the state-level duplicate-submission
 * guard behind the disabled button. Every other target is untouched.
 */
export function beginRowRefine(map, targetKey, requestId) {
  const base = map || {};
  if (!targetKey || !requestId) return base;
  if (isRowRefineLoading(base, targetKey)) return base;
  return {
    ...base,
    [targetKey]: {
      status: ROW_REFINE_STATUS.LOADING,
      message: ROW_REFINE_LOADING_MESSAGE,
      requestId,
    },
  };
}

// True while this target's slot still belongs to this request — false once a
// newer request has taken it, so an older response can never overwrite a newer.
export function isRowRefineCurrent(map, targetKey, requestId) {
  const entry = getRowRefineState(map, targetKey);
  return !!entry && entry.requestId === requestId;
}

/**
 * Leave loading for one target. Ignored for a superseded request, so a late
 * response cannot clear the loading state of the request that replaced it.
 */
export function settleRowRefine(map, targetKey, { requestId, status, message } = {}) {
  const base = map || {};
  if (!targetKey) return base;
  const entry = getRowRefineState(base, targetKey);
  if (!entry || entry.status !== ROW_REFINE_STATUS.LOADING) return base;
  if (entry.requestId !== requestId) return base;

  const settled =
    status === ROW_REFINE_STATUS.SUCCESS ||
    status === ROW_REFINE_STATUS.UNAVAILABLE ||
    status === ROW_REFINE_STATUS.FAILURE
      ? status
      : ROW_REFINE_STATUS.FAILURE;

  return {
    ...base,
    [targetKey]: { status: settled, message: message || null, requestId },
  };
}

/**
 * Set a message on a target WITHOUT a request having been made (the empty-field
 * case, and the Revert confirmation). Refused while that target is loading, so
 * it can never mask an in-flight request.
 */
export function setRowRefineMessage(map, targetKey, status, message) {
  const base = map || {};
  if (!targetKey) return base;
  if (isRowRefineLoading(base, targetKey)) return base;
  const entry = getRowRefineState(base, targetKey);
  return {
    ...base,
    [targetKey]: {
      status,
      message: message || null,
      requestId: entry ? entry.requestId : 0,
    },
  };
}

// Drop a target's transient feedback. Returns the same reference when there is
// nothing to drop, so it cannot drive a render loop.
export function clearRowRefineStatus(map, targetKey) {
  const base = map || {};
  if (!targetKey || !(targetKey in base)) return base;
  const next = { ...base };
  delete next[targetKey];
  return next;
}

/* ------------------------------------------------------------------------ */
/* Per-note, per-target Revert backup — the generic map helpers              */
/* ------------------------------------------------------------------------ */
//
// { [noteId]: { [targetKey]: backup } }
//
// Deliberately separate from:
//   - the Free-form Refine backup (src/lib/refineLifecycle.js — one HTML state
//     per note),
//   - TipTap undo/redo.
// One backup per note per TARGET, session-only. The refined document and the
// reverted document both persist normally through the instance record; only
// the ability to step back is session-scoped.
//
// The SHAPE of one backup — and the accessor that validates it — is the modern
// pair `makeSectionRefineBackup` / `getSectionRefineBackup` /
// `setSectionRefineBackup` in src/lib/templateSectionRefine.js. What lives here
// is only what is generic to the map itself: removing one target's entry and
// pruning notes that no longer exist.

export function clearRowRefineBackup(backups, noteId, targetKey) {
  const base = backups || {};
  if (!noteId || !targetKey) return base;
  const forNote = base[noteId];
  if (!forNote || !(targetKey in forNote)) return base;
  const nextForNote = { ...forNote };
  delete nextForNote[targetKey];
  const next = { ...base };
  if (Object.keys(nextForNote).length === 0) delete next[noteId];
  else next[noteId] = nextForNote;
  return next;
}

/**
 * Drop backups belonging to notes that no longer exist, mirroring the deleted-
 * note cleanup the autosave status and Free-form Refine already perform. Returns the
 * SAME reference when nothing needs removing.
 */
export function pruneRowRefineBackups(backups, liveNoteIds) {
  if (!backups) return {};
  const ids = Object.keys(backups);
  if (!ids.length) return backups;
  const keep = ids.filter((id) => liveNoteIds && liveNoteIds.has(id));
  if (keep.length === ids.length) return backups;
  const next = {};
  for (const id of keep) next[id] = backups[id];
  return next;
}
