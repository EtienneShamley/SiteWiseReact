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
// ---------------------------------------------------------------------------
// TWO TARGETS, ONE PIPELINE
// ---------------------------------------------------------------------------
//
// A Template row is no longer necessarily one editable answer. A flexible
// section holds an ordered list of items (src/lib/templateSectionContent.js) —
// text A, a photo, text B, a file, text C — and "refine this row" has no
// meaning there. So a refine target is one of exactly two things:
//
//   LEGACY ROW   { rowId }            -> answers[rowId] / customRows[].answer
//                                        for a row that has NOT materialised
//                                        into authoritative section content.
//                                        Byte-for-byte the behaviour that
//                                        existed before section content did.
//   SECTION ITEM { rowId, itemId }    -> sectionContent[rowId] -> the TEXT item
//                                        with that stable id, and nothing else.
//
// A section item is addressed by its ID and NEVER by its position: a photo
// dropped into a paragraph splits it, a moved image renumbers every index, and
// an index-addressed response would land on somebody else's prose. When the
// named item has gone, the response is REFUSED — never redirected to a
// neighbouring text item, and never allowed to fall back to answers[rowId],
// which such a row does not even render any more.
//
// `rowRefineTargetKey` is the single string that identifies a target for the
// per-target lifecycle map and the per-note Revert backup. For a legacy row it
// IS the row id, so every previously stored key keeps its exact meaning.
//
// Ownership boundaries this module exists to protect:
//   - a refinement changes ONE row's answer, or ONE section TEXT item's value,
//     on ONE note's NoteTemplateInstance;
//   - it never touches another row, another note, the Free-form note, the
//     attachments map, custom-row ordering/labels/heights, or a TemplateVersion
//     (versions are immutable and are never written from the note path at all);
//   - within a section it never touches another item, a PhotoItem, a FileItem,
//     an asset, a photo's display metadata, the item order, the section's extra
//     height, a structured row's typed answer or a legacy primary attachment.
//     Every entry it is not acting on — including one too malformed for this
//     version to render — is passed through by reference at its exact position;
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
import {
  answersEqual,
  isAnswerValue,
  normalizeAnswerValue,
  richAnswerText,
} from "./templateRichText";
import { SECTION_ITEM_KIND, sectionItemsForRow } from "./templateSectionContent";
import { findTextSectionItemIndex, setRowSectionItems } from "./templateSectionEditing";

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
// A Text answer may be a plain string or a tagged rich value, so emptiness is
// judged on the value's PLAIN-TEXT projection — never on its markup.
export function hasRefinableText(value) {
  return richAnswerText(value).trim().length > 0;
}

/* ------------------------------------------------------------------------ */
/* Target identity                                                           */
/* ------------------------------------------------------------------------ */

// Chosen so it cannot occur inside a generated id (src/lib/id.js) or inside a
// template row id (`row-<index>`), and so a key is readable in a devtools dump.
export const ROW_REFINE_ITEM_KEY_SEPARATOR = "::item::";

/**
 * The one string that identifies a refine target: a legacy row, or one ordered
 * section TEXT item inside a row.
 *
 * For a legacy row the key IS the row id — byte-identical to the key this
 * codebase used before section content existed — so an existing lifecycle entry
 * and an existing Revert backup keep working with no migration at all.
 *
 * For a section item the item id is part of the key, which is what makes
 * "Refine text C" and "Refine text A" two independent requests with two
 * independent backups inside one section. Returns null when there is no
 * addressable target.
 */
export function rowRefineTargetKey({ rowId, itemId = null } = {}) {
  if (typeof rowId !== "string" || !rowId) return null;
  if (typeof itemId === "string" && itemId) {
    return `${rowId}${ROW_REFINE_ITEM_KEY_SEPARATOR}${itemId}`;
  }
  return rowId;
}

/**
 * The current value of ONE ordered section TEXT item, canonicalized, or null.
 *
 * Null means "that text item is not there" — the row has no section content,
 * the id names nothing, or it names a photo/file item. It is deliberately a
 * different fact from "" (a text item that exists and is empty), because the
 * two lead to opposite decisions: refuse the response, versus apply it.
 *
 * Read through the RENDER model (`sectionItemsForRow`), so the value compared
 * against a request is exactly the value the user can see and the editor loads.
 */
export function readSectionTextItemValue(instance, rowId, itemId) {
  if (!instance || !rowId || !itemId) return null;
  const items = sectionItemsForRow(instance.sectionContent, rowId);
  const item = items.find(
    (entry) => entry.kind === SECTION_ITEM_KIND.TEXT && entry.id === itemId
  );
  return item ? item.value : null;
}

/**
 * A COPY of the instance with exactly ONE ordered section TEXT item's value
 * replaced. Returns null when there is nothing valid to write.
 *
 * The write is applied to the RAW stored list, not to the normalized render
 * model: every other entry — the text items around it, the photo and file
 * items, and any entry too malformed or too new for this version to render — is
 * carried into the result BY REFERENCE at its exact index. So item order, item
 * ids, attachment references, `display.widthPct` and anything this version does
 * not understand all survive a refinement untouched.
 *
 * `answers`, `attachments`, `evidence`, `customRows`, `sectionExtraHeight` and
 * every other row's section content are passed through on the instance itself.
 */
export function applySectionTextItemToInstance(instance, { rowId, itemId } = {}, value) {
  if (!instance || !rowId || !itemId || !isAnswerValue(value)) return null;

  const map =
    instance.sectionContent &&
    typeof instance.sectionContent === "object" &&
    !Array.isArray(instance.sectionContent)
      ? instance.sectionContent
      : null;
  const list = map && Array.isArray(map[rowId]) ? map[rowId] : null;
  if (!list) return null;

  // By stable id. An item that has gone is a refusal — the caller must not fall
  // back to a neighbour, and must not fall back to answers[rowId].
  const index = findTextSectionItemIndex(list, itemId);
  if (index === -1) return null;

  const items = list.map((entry, i) => (i === index ? { ...entry, value } : entry));
  return { ...instance, sectionContent: setRowSectionItems(map, rowId, items) };
}

/* ------------------------------------------------------------------------ */
/* Request identity                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Everything a response needs to prove it still belongs where it was sent from.
 *
 * Two values are captured, and they do different jobs:
 *   - `sentValue` is the row's COMPLETE answer representation at click time (a
 *     plain string or a tagged rich value). It is what the apply gate compares
 *     against, so a formatting-only edit made while the model was working
 *     counts as an edit and protects the user's work.
 *   - `sentText` is the plain-text projection of that value. It is what the
 *     provider receives: meaningful prose, never raw markup.
 *
 * `itemId` — OPTIONAL — names one ordered section TEXT item inside the row. It
 * is what makes the response's destination exact: the apply step finds the same
 * stable id again in the FRESHEST stored list, so an image moved, an item
 * appended or a paragraph split while the model was working cannot re-address
 * it. When absent this is a legacy row request and every field below keeps the
 * exact shape and meaning it had before section content existed.
 *
 * `sentValue` is ONLY the target's own value — one row answer, or one TextItem.
 * Nothing else in the section is read into it: not a neighbouring text item,
 * not an image name, not an attachment's metadata, not the row's label.
 *
 * Returns null for anything unusable, so a malformed request can never be
 * started at all: no note, no row, an unusable item id, an off-allowlist style
 * (the frontend may only ever SELECT a preset, never author instruction text),
 * or empty content.
 */
export function makeRowRefineRequest({
  requestId,
  noteId,
  templateId = null,
  templateVersionId = null,
  rowId,
  itemId = null,
  isCustomRow = false,
  style,
  sentValue,
} = {}) {
  if (!requestId || typeof requestId !== "number") return null;
  if (!noteId || typeof noteId !== "string") return null;
  if (!rowId || typeof rowId !== "string") return null;
  // Named but unusable is a refusal, not a silent demotion to a row request:
  // that would point the response at answers[rowId] instead.
  if (itemId !== null && (typeof itemId !== "string" || !itemId)) return null;
  if (!isAllowedRefineStyle(style)) return null;
  if (!isAnswerValue(sentValue)) return null;
  if (!hasRefinableText(sentValue)) return null;

  return {
    requestId,
    noteId,
    templateId: templateId ?? null,
    templateVersionId: templateVersionId ?? null,
    rowId,
    itemId: itemId ?? null,
    targetKey: rowRefineTargetKey({ rowId, itemId }),
    isCustomRow: !!isCustomRow,
    style,
    sentValue: normalizeAnswerValue(sentValue),
    sentText: richAnswerText(sentValue),
  };
}

/* ------------------------------------------------------------------------ */
/* Reading and writing ONE row's answer                                      */
/* ------------------------------------------------------------------------ */

/**
 * The current answer for a row, through the correct storage path, canonicalized
 * (a plain string stays a string; a stored rich value is re-validated).
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
    return normalizeAnswerValue(row.answer);
  }

  const answers = instance.answers && typeof instance.answers === "object"
    ? instance.answers
    : {};
  return normalizeAnswerValue(answers[rowId]);
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
export function applyRowAnswerToInstance(instance, { rowId, isCustomRow }, value) {
  // A plain string (AI output, ordinary typing) or a tagged rich value (Revert
  // restoring a formatted answer). Nothing else may be written into an answer.
  if (!instance || !rowId || !isAnswerValue(value)) return null;

  if (isCustomRow) {
    const rows = Array.isArray(instance.customRows) ? instance.customRows : [];
    if (!rows.some((r) => r && r.id === rowId)) return null;
    return { ...instance, customRows: updateCustomRow(rows, rowId, { answer: value }) };
  }

  const answers = instance.answers && typeof instance.answers === "object"
    ? instance.answers
    : {};
  return { ...instance, answers: { ...answers, [rowId]: value } };
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
  ITEM_MISSING: "item-missing",
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
 *   item-missing      the ordered section TEXT item the request named is gone —
 *                     deleted, or replaced by something that is no longer text.
 *                     The response is DISCARDED. It is never applied to the item
 *                     next to it, and never written back into answers[rowId]:
 *                     both would put model output somewhere the user never asked
 *                     for it.
 *   answer-changed    the user kept editing. Their newer answer is what they
 *                     mean; the model was working from content that no longer
 *                     exists, so applying it would silently destroy that edit.
 *                     The comparison is on the COMPLETE canonical answer
 *                     representation, so applying bold while a request is in
 *                     flight counts as an edit just as typing does. For a
 *                     section item this is also what catches a paragraph that
 *                     was SPLIT around a dropped image while the request ran:
 *                     the original id stays on the BEFORE half, whose value has
 *                     necessarily changed, so the stale result cannot overwrite
 *                     it. Moving an image or appending an item changes no
 *                     value, so neither invalidates a pending refinement —
 *                     which is exactly why the target is an id and not an index.
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

  // An ITEM request is resolved against section content and returns here. There
  // is deliberately no path from a missing item to the legacy answer below.
  if (request.itemId) {
    const item = readSectionTextItemValue(instance, request.rowId, request.itemId);
    if (item === null) {
      return { ok: false, reason: ROW_REFINE_REJECTION.ITEM_MISSING };
    }
    if (!answersEqual(item, request.sentValue)) {
      return { ok: false, reason: ROW_REFINE_REJECTION.ANSWER_CHANGED };
    }
    return { ok: true, previousAnswer: item };
  }

  const current = readRowAnswer(instance, request.rowId, request.isCustomRow);
  if (current === null) {
    return { ok: false, reason: ROW_REFINE_REJECTION.ROW_MISSING };
  }
  if (!answersEqual(current, request.sentValue)) {
    return { ok: false, reason: ROW_REFINE_REJECTION.ANSWER_CHANGED };
  }

  // The COMPLETE prior representation, so Revert restores formatting exactly.
  return { ok: true, previousAnswer: current };
}

/* ------------------------------------------------------------------------ */
/* Per-target request lifecycle                                              */
/* ------------------------------------------------------------------------ */
//
// { [targetKey]: { status, message, requestId } } — one slot per TARGET, so a
// request on one row neither blocks nor reports on another, and neither does a
// request on one section text item against another item of the SAME section.
//
// `targetKey` comes from rowRefineTargetKey: a bare row id for a legacy row (so
// this map's shape and its keys are unchanged for every row that has not
// materialised), and `rowId::item::itemId` for a section text item.

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
/* Per-note, per-target Revert backup                                        */
/* ------------------------------------------------------------------------ */
//
// { [noteId]: { [targetKey]: previousAnswer } }
//
// Deliberately separate from:
//   - the Free-form Refine backup (src/lib/refineLifecycle.js — one HTML state
//     per note),
//   - TipTap undo/redo.
// One previous value per note per TARGET, session-only. The refined answer and
// the reverted answer both persist normally through the instance record; only
// the ability to step back is session-scoped.
//
// The target key carries the item id for a section text item, which is what
// makes Revert on text C restore text C's own previous VALUE and nothing else —
// not text A, not a photo, not a file, not the item order, and never a whole
// `sectionContent` snapshot. Two text items in one section therefore hold two
// independent backups that cannot overwrite one another.

export function setRowRefineBackup(backups, noteId, targetKey, previousAnswer) {
  const base = backups || {};
  // The COMPLETE previous value — a plain string or a tagged rich value — so
  // Revert restores the answer's formatting, not just its words.
  if (!noteId || !targetKey || !isAnswerValue(previousAnswer)) return base;
  return { ...base, [noteId]: { ...(base[noteId] || {}), [targetKey]: previousAnswer } };
}

/**
 * The backup for exactly this note AND this target. Returns null for every
 * other note and every other target — this is what stops Note A's backup
 * reaching Note B, Row A's backup reverting Row B, and text item A's backup
 * reverting text item B inside the same section.
 */
export function getRowRefineBackup(backups, noteId, targetKey) {
  if (!backups || !noteId || !targetKey) return null;
  const forNote = backups[noteId];
  if (!forNote || typeof forNote !== "object") return null;
  const value = forNote[targetKey];
  return isAnswerValue(value) ? value : null;
}

export function hasRowRefineBackup(backups, noteId, targetKey) {
  return getRowRefineBackup(backups, noteId, targetKey) !== null;
}

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

// The TARGET KEYS of ONE note that currently have a backup, for deciding which
// rows and which section text items show a Revert control. Always a Set, never
// null, so callers need no guard. (Named for the row-only world it was written
// in; its entries are now target keys, which for a legacy row are still row
// ids.)
export function rowIdsWithBackup(backups, noteId) {
  const forNote = backups && noteId ? backups[noteId] : null;
  if (!forNote || typeof forNote !== "object") return new Set();
  return new Set(Object.keys(forNote));
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
