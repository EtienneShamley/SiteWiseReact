// src/lib/templateRowRefine.js
//
// ROW-LEVEL AI refinement for Template form Text answers: the pure model behind
// it — eligibility, request identity, the rules that decide whether a returning
// response may be applied at all, the answer write itself, the per-row request
// lifecycle, and the per-note/per-row Revert backup.
//
// This is NOT whole-note refinement and NOT a second AI contract. Everything
// that talks to the provider is reused unchanged:
//   - the style presets, the allowlist and output validation come from
//     src/lib/refineContract.js (the same module the server enforces),
//   - the request itself goes through src/lib/refineClient.js (one request per
//     call, no automatic retry),
//   - the status vocabulary is src/lib/refineLifecycle.js REFINE_STATUS.
// The only thing defined here is what the shared modules cannot express: state
// keyed by ROW, and messages that say "this field" instead of "your note".
//
// Ownership boundaries this module exists to protect:
//   - a refinement changes ONE row's answer on ONE note's NoteTemplateInstance;
//   - it never touches another row, another note, the Free-form note, the
//     attachments map, custom-row ordering/labels/heights, or a TemplateVersion
//     (versions are immutable and are never written from the note path at all);
//   - a request that comes back after the world has moved on is DISCARDED, not
//     force-fitted (see canApplyRowRefineResponse).
//
// Pure: no React, no storage, no fetch, no DOM.

import {
  REFINE_OUTCOME,
  isAllowedRefineStyle,
} from "./refineContract";
import { REFINE_STATUS } from "./refineLifecycle";
import { FIELD_TYPE, normalizeType } from "./templateFields";
import { updateCustomRow } from "./noteCustomRows";

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

/**
 * Only the unified Text answer is refinable. Number, date, time, checkbox,
 * yes/no, dropdown, photo and file rows are structured values, not prose, and
 * are never sent to a model. Labels, the report title and company branding are
 * not answers at all and are out of scope by construction — this function is
 * only ever asked about an answer row.
 *
 * Note-specific custom rows are Text by definition (CUSTOM_ROW_TYPE), so the
 * same check covers both storage paths.
 */
export function isRefinableRowType(type) {
  return normalizeType(type) === FIELD_TYPE.TEXT;
}

// A row is refinable when it is addressable (has an id) and holds Text.
export function isRefinableRow(row) {
  return !!(row && typeof row.id === "string" && row.id && isRefinableRowType(row.type));
}

// Whitespace is not content: an all-space field must not spend a request.
export function hasRefinableText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/* ------------------------------------------------------------------------ */
/* Request identity                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Everything a response needs to prove it still belongs where it was sent from.
 *
 * `sentText` is the RAW answer at click time (not the trimmed copy the
 * transport sends), because it is compared byte-for-byte against the row's
 * current answer before the result is applied — see canApplyRowRefineResponse.
 *
 * Returns null for anything unusable, so a malformed request can never be
 * started at all: no note, no row, an off-allowlist style (the frontend may
 * only ever SELECT a preset, never author instruction text), or empty content.
 */
export function makeRowRefineRequest({
  requestId,
  noteId,
  templateId = null,
  templateVersionId = null,
  rowId,
  isCustomRow = false,
  style,
  sentText,
} = {}) {
  if (!requestId || typeof requestId !== "number") return null;
  if (!noteId || typeof noteId !== "string") return null;
  if (!rowId || typeof rowId !== "string") return null;
  if (!isAllowedRefineStyle(style)) return null;
  if (!hasRefinableText(sentText)) return null;

  return {
    requestId,
    noteId,
    templateId: templateId ?? null,
    templateVersionId: templateVersionId ?? null,
    rowId,
    isCustomRow: !!isCustomRow,
    style,
    sentText,
  };
}

/* ------------------------------------------------------------------------ */
/* Reading and writing ONE row's answer                                      */
/* ------------------------------------------------------------------------ */

/**
 * The current answer for a row, through the correct storage path.
 *
 * Master rows: the instance `answers` map, keyed by the stable field id.
 * Custom rows: the answer lives ON the row object inside `customRows` and is
 * deliberately never mirrored into `answers`.
 *
 * Returns null when a CUSTOM row no longer exists — that is a different fact
 * from "the row exists and is empty" ("") and the two must not be conflated.
 */
export function readRowAnswer(instance, rowId, isCustomRow) {
  if (!instance || !rowId) return null;

  if (isCustomRow) {
    const rows = Array.isArray(instance.customRows) ? instance.customRows : [];
    const row = rows.find((r) => r && r.id === rowId);
    if (!row) return null;
    return typeof row.answer === "string" ? row.answer : "";
  }

  const answers = instance.answers && typeof instance.answers === "object"
    ? instance.answers
    : {};
  const value = answers[rowId];
  return typeof value === "string" ? value : "";
}

/**
 * A COPY of the instance with exactly one row's answer replaced.
 *
 * Master row: only `answers[rowId]` changes.
 * Custom row: the write goes through the existing updateCustomRow helper, so a
 * custom row's id, label, type, placement, preferredHeight, createdAt and
 * templateId are carried through untouched and its position in the array — the
 * document order — is unchanged. `updatedAt` moves, exactly as it does when the
 * user types into the row by hand; it is bookkeeping, not identity.
 *
 * Attachments and every other row are passed through by reference. Returns null
 * when there is nothing valid to write.
 */
export function applyRowAnswerToInstance(instance, { rowId, isCustomRow }, text) {
  if (!instance || !rowId || typeof text !== "string") return null;

  if (isCustomRow) {
    const rows = Array.isArray(instance.customRows) ? instance.customRows : [];
    if (!rows.some((r) => r && r.id === rowId)) return null;
    return { ...instance, customRows: updateCustomRow(rows, rowId, { answer: text }) };
  }

  const answers = instance.answers && typeof instance.answers === "object"
    ? instance.answers
    : {};
  return { ...instance, answers: { ...answers, [rowId]: text } };
}

/* ------------------------------------------------------------------------ */
/* May this response be applied?                                             */
/* ------------------------------------------------------------------------ */

export const ROW_REFINE_REJECTION = {
  MISSING_INSTANCE: "missing-instance",
  NOTE_MISMATCH: "note-mismatch",
  TEMPLATE_MISMATCH: "template-mismatch",
  VERSION_MISMATCH: "version-mismatch",
  ROW_MISSING: "row-missing",
  ANSWER_CHANGED: "answer-changed",
};

/**
 * The single gate every returning response passes through.
 *
 * `instance` is the CURRENT state of the ORIGINATING note (read back at apply
 * time — from live state when that note is still on screen, from storage when
 * the user has moved to another note). It is never whichever note happens to be
 * visible: a background result is written to the note it was started from, or
 * to nothing at all.
 *
 * Rejections, and why each one exists:
 *   missing-instance  the note (or its template data) is gone — never recreate it
 *   note-mismatch     defensive: the wrong record was handed in
 *   template-mismatch the note was re-pinned to a different template
 *   version-mismatch  the note was re-pinned to a different VERSION. Versions
 *                     are immutable, so a matching version id proves the master
 *                     row set — and the target row's type — is still exactly
 *                     what the request was built against.
 *   row-missing       a custom row was deleted while the request was in flight
 *   answer-changed    the user kept typing. Their newer text is what they mean;
 *                     the model was working from text that no longer exists, so
 *                     applying it would silently destroy a manual edit.
 */
export function canApplyRowRefineResponse(request, instance) {
  if (!request) return { ok: false, reason: ROW_REFINE_REJECTION.MISSING_INSTANCE };
  if (!instance) return { ok: false, reason: ROW_REFINE_REJECTION.MISSING_INSTANCE };
  if (instance.noteId !== request.noteId) {
    return { ok: false, reason: ROW_REFINE_REJECTION.NOTE_MISMATCH };
  }
  if ((instance.templateId ?? null) !== (request.templateId ?? null)) {
    return { ok: false, reason: ROW_REFINE_REJECTION.TEMPLATE_MISMATCH };
  }
  if ((instance.templateVersionId ?? null) !== (request.templateVersionId ?? null)) {
    return { ok: false, reason: ROW_REFINE_REJECTION.VERSION_MISMATCH };
  }

  const current = readRowAnswer(instance, request.rowId, request.isCustomRow);
  if (current === null) {
    return { ok: false, reason: ROW_REFINE_REJECTION.ROW_MISSING };
  }
  if (current !== request.sentText) {
    return { ok: false, reason: ROW_REFINE_REJECTION.ANSWER_CHANGED };
  }

  return { ok: true, previousAnswer: current };
}

/* ------------------------------------------------------------------------ */
/* Per-row request lifecycle                                                 */
/* ------------------------------------------------------------------------ */
//
// { [rowId]: { status, message, requestId } } — one slot per row, so a request
// on one row neither blocks nor reports on another.

export function createRowRefineState() {
  return {};
}

export function getRowRefineState(map, rowId) {
  if (!map || !rowId) return null;
  return map[rowId] || null;
}

export function isRowRefineLoading(map, rowId) {
  const entry = getRowRefineState(map, rowId);
  return !!entry && entry.status === ROW_REFINE_STATUS.LOADING;
}

/**
 * Enter loading for one row. Refused (same reference returned) while that row
 * already has a request in flight — the state-level duplicate-submission guard
 * behind the disabled button. Other rows are untouched.
 */
export function beginRowRefine(map, rowId, requestId) {
  const base = map || {};
  if (!rowId || !requestId) return base;
  if (isRowRefineLoading(base, rowId)) return base;
  return {
    ...base,
    [rowId]: {
      status: ROW_REFINE_STATUS.LOADING,
      message: ROW_REFINE_LOADING_MESSAGE,
      requestId,
    },
  };
}

// True while this row's slot still belongs to this request — false once a newer
// request has taken it, so an older response can never overwrite a newer one.
export function isRowRefineCurrent(map, rowId, requestId) {
  const entry = getRowRefineState(map, rowId);
  return !!entry && entry.requestId === requestId;
}

/**
 * Leave loading for one row. Ignored for a superseded request, so a late
 * response cannot clear the loading state of the request that replaced it.
 */
export function settleRowRefine(map, rowId, { requestId, status, message } = {}) {
  const base = map || {};
  if (!rowId) return base;
  const entry = getRowRefineState(base, rowId);
  if (!entry || entry.status !== ROW_REFINE_STATUS.LOADING) return base;
  if (entry.requestId !== requestId) return base;

  const settled =
    status === ROW_REFINE_STATUS.SUCCESS ||
    status === ROW_REFINE_STATUS.UNAVAILABLE ||
    status === ROW_REFINE_STATUS.FAILURE
      ? status
      : ROW_REFINE_STATUS.FAILURE;

  return { ...base, [rowId]: { status: settled, message: message || null, requestId } };
}

/**
 * Set a message on a row WITHOUT a request having been made (the empty-field
 * case, and the Revert confirmation). Refused while that row is loading, so it
 * can never mask an in-flight request.
 */
export function setRowRefineMessage(map, rowId, status, message) {
  const base = map || {};
  if (!rowId) return base;
  if (isRowRefineLoading(base, rowId)) return base;
  const entry = getRowRefineState(base, rowId);
  return {
    ...base,
    [rowId]: { status, message: message || null, requestId: entry ? entry.requestId : 0 },
  };
}

// Drop a row's transient feedback. Returns the same reference when there is
// nothing to drop, so it cannot drive a render loop.
export function clearRowRefineStatus(map, rowId) {
  const base = map || {};
  if (!rowId || !(rowId in base)) return base;
  const next = { ...base };
  delete next[rowId];
  return next;
}

/* ------------------------------------------------------------------------ */
/* Per-note, per-row Revert backup                                           */
/* ------------------------------------------------------------------------ */
//
// { [noteId]: { [rowId]: previousAnswer } }
//
// Deliberately separate from:
//   - the Free-form Refine backup (src/lib/refineLifecycle.js — one HTML state
//     per note),
//   - Save progress restore points (src/lib/noteProgressHistory.js — 20 points
//     per note per view),
//   - TipTap undo/redo.
// One previous value per note per row, session-only. The refined answer and the
// reverted answer both persist normally through the instance record; only the
// ability to step back is session-scoped.

export function setRowRefineBackup(backups, noteId, rowId, previousAnswer) {
  const base = backups || {};
  if (!noteId || !rowId || typeof previousAnswer !== "string") return base;
  return { ...base, [noteId]: { ...(base[noteId] || {}), [rowId]: previousAnswer } };
}

/**
 * The backup for exactly this note AND this row. Returns null for every other
 * note and every other row — this is what stops Note A's backup reaching Note B
 * and Row A's backup reverting Row B.
 */
export function getRowRefineBackup(backups, noteId, rowId) {
  if (!backups || !noteId || !rowId) return null;
  const forNote = backups[noteId];
  if (!forNote || typeof forNote !== "object") return null;
  const value = forNote[rowId];
  return typeof value === "string" ? value : null;
}

export function hasRowRefineBackup(backups, noteId, rowId) {
  return getRowRefineBackup(backups, noteId, rowId) !== null;
}

export function clearRowRefineBackup(backups, noteId, rowId) {
  const base = backups || {};
  if (!noteId || !rowId) return base;
  const forNote = base[noteId];
  if (!forNote || !(rowId in forNote)) return base;
  const nextForNote = { ...forNote };
  delete nextForNote[rowId];
  const next = { ...base };
  if (Object.keys(nextForNote).length === 0) delete next[noteId];
  else next[noteId] = nextForNote;
  return next;
}

// The rows of ONE note that currently have a backup, for deciding which rows
// show a Revert control. Always a Set, never null, so callers need no guard.
export function rowIdsWithBackup(backups, noteId) {
  const forNote = backups && noteId ? backups[noteId] : null;
  if (!forNote || typeof forNote !== "object") return new Set();
  return new Set(Object.keys(forNote));
}

/**
 * Drop backups belonging to notes that no longer exist, mirroring the deleted-
 * note cleanup Save progress and Free-form Refine already perform. Returns the
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
