// src/lib/noteProgressHistory.js
//
// "Save progress" restore points: the pure model behind the temporary,
// SESSION-ONLY editing history a note keeps while it is open.
//
// Ownership boundary (see docs/PROJECT_DECISIONS.md):
//   - History is scoped by NOTE ID and by NOTE VIEW. A note's Free-form note
//     history and its Template form history are independent lists: saving in
//     one never writes the other, restoring one never changes the other, and
//     neither is ever visible from another note.
//   - History is IN-MEMORY ONLY. Nothing here reads or writes storage; the
//     actual note content and template instance persist through their own
//     systems. Restore points are deliberately gone after a reload, and the UI
//     says so.
//   - A restore point holds LIGHTWEIGHT state only. Attachment evidence is
//     captured as the same reference shape the instance stores ({ id, assetId,
//     kind, … }) — never a Blob, never base64, never an object URL.
//
// This module is pure and framework-agnostic (no storage, no React) so the
// isolation, capping, ordering and asset-retention rules can be unit-tested
// directly.

import { newId } from "./id";
import { isLegacyAttachmentEntry, normalizeAttachments } from "./noteAttachments";

// The two views a note can be edited in. These are the HISTORY's own view
// identifiers; MainArea maps its existing `noteLayout` values onto them.
export const NOTE_VIEW = {
  FREEFORM: "freeform",
  TEMPLATE_FORM: "templateForm",
};

// User-facing names for the two views. One definition, used by the tab labels,
// the dropdown heading and every accessible name, so they can never drift.
export const NOTE_VIEW_LABEL = {
  [NOTE_VIEW.FREEFORM]: "Free-form note",
  [NOTE_VIEW.TEMPLATE_FORM]: "Template form",
};

// Retained restore points per note, PER VIEW. Each view has its own budget: a
// note may hold 20 Free-form points and 20 Template form points at once, and
// another note has its own independent budgets. This is a small working
// history, deliberately not unlimited and deliberately not durable revision
// history (that is a later backend feature).
export const MAX_RESTORE_POINTS = 20;

export function isNoteView(view) {
  return view === NOTE_VIEW.FREEFORM || view === NOTE_VIEW.TEMPLATE_FORM;
}

export function noteViewLabel(view) {
  return NOTE_VIEW_LABEL[view] || "";
}

// The dropdown heading, which is what lets the individual entries show a bare
// timestamp without becoming ambiguous.
export function restoreHistoryHeading(view) {
  const label = noteViewLabel(view);
  return label ? `${label} restore points` : "Restore points";
}

export function emptyNoteHistory() {
  return { [NOTE_VIEW.FREEFORM]: [], [NOTE_VIEW.TEMPLATE_FORM]: [] };
}

/* ----------------------------- reading history ---------------------------- */

// Oldest → newest (creation order). Order is ARRAY order, never a timestamp
// sort, so two points created in the same millisecond keep a deterministic
// sequence.
export function getRestorePoints(historyByNote, noteId, view) {
  if (!historyByNote || !noteId || !isNoteView(view)) return [];
  const list = historyByNote[noteId]?.[view];
  return Array.isArray(list) ? list : [];
}

// Newest → oldest, for display. Returns a copy; the stored array is untouched.
export function listRestorePointsNewestFirst(historyByNote, noteId, view) {
  return getRestorePoints(historyByNote, noteId, view).slice().reverse();
}

// Looked up by stable id (never by timestamp — two points can share a
// millisecond) and scoped to one note and one view, so a lookup can never
// reach another note's or another view's point.
export function findRestorePoint(historyByNote, noteId, view, pointId) {
  if (!pointId) return null;
  return (
    getRestorePoints(historyByNote, noteId, view).find((p) => p.id === pointId) ||
    null
  );
}

/* ---------------------------- creating a point ---------------------------- */

// The Free-form note's restorable state is its canonical rich-text HTML — the
// same value the editor already persists. This is deliberately not full editor
// version control (no selection, no history stack, no per-edit points).
export function makeFreeformRestorePoint({
  html,
  id = newId(),
  now = Date.now(),
} = {}) {
  return {
    id,
    view: NOTE_VIEW.FREEFORM,
    ts: now,
    html: typeof html === "string" ? html : "",
  };
}

/**
 * Splits an instance's stored attachments map into what a restore point may
 * hold and what it must leave alone.
 *
 * Structured references are copied through the existing `normalizeAttachments`
 * whitelist, so only the known reference properties can ever enter history —
 * a Blob, a data URL or any future binary-bearing property cannot, even by
 * accident.
 *
 * A field whose stored array still contains a LEGACY base64 data-URL string
 * (pre-migration evidence) is not captured at all: copying it would put base64
 * into history, and dropping it would let a restore destroy the user's
 * evidence. Its field id is recorded instead, and restoring leaves that field's
 * current stored value exactly as it is.
 */
export function captureTemplateFormAttachments(attachmentsMap) {
  const source =
    attachmentsMap && typeof attachmentsMap === "object" ? attachmentsMap : {};
  const attachments = {};
  const uncapturedFieldIds = [];

  for (const fieldId of Object.keys(source)) {
    const list = source[fieldId];
    if (!Array.isArray(list)) continue;
    if (list.some((entry) => isLegacyAttachmentEntry(entry))) {
      uncapturedFieldIds.push(fieldId);
      continue;
    }
    attachments[fieldId] = normalizeAttachments(list);
  }

  return { attachments, uncapturedFieldIds };
}

// A custom row is copied deeply enough that later edits to the live row (label,
// answer, height, placement) cannot reach back into the captured point.
function copyCustomRows(customRows) {
  return (Array.isArray(customRows) ? customRows : [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      ...r,
      placement:
        r.placement && typeof r.placement === "object" ? { ...r.placement } : r.placement,
    }));
}

/**
 * The smallest complete restorable state of a note's Template form: which
 * template version it was pinned to, the answers keyed by field id, the
 * note-specific custom rows (labels, answers, ordering/placement, preferred
 * heights) and the attachment REFERENCES with their photo display metadata.
 *
 * Returns null when there is no instance to capture, so the caller can report
 * that instead of storing an empty point.
 */
export function makeTemplateFormRestorePoint({
  instance,
  id = newId(),
  now = Date.now(),
} = {}) {
  if (!instance || typeof instance !== "object") return null;

  const { attachments, uncapturedFieldIds } = captureTemplateFormAttachments(
    instance.attachments
  );
  const answers =
    instance.answers && typeof instance.answers === "object"
      ? { ...instance.answers }
      : {};

  return {
    id,
    view: NOTE_VIEW.TEMPLATE_FORM,
    ts: now,
    // Captured as they were AT THIS MOMENT: restoring an older point may
    // therefore restore an earlier template assignment together with the
    // instance state that belonged to it.
    templateId: instance.templateId ?? null,
    templateVersionId: instance.templateVersionId ?? null,
    answers,
    customRows: copyCustomRows(instance.customRows),
    attachments,
    uncapturedAttachmentFieldIds: uncapturedFieldIds,
  };
}

/**
 * Appends a restore point to the list for its OWN view (read from the point,
 * so a mismatched caller can never write into the wrong history) and keeps the
 * newest `limit`.
 *
 * The oldest point is discarded only as part of the same successful append —
 * a point that was never created (a failed capture returns null and never
 * reaches here) evicts nothing.
 */
export function addRestorePoint(
  historyByNote,
  noteId,
  point,
  limit = MAX_RESTORE_POINTS
) {
  const base =
    historyByNote && typeof historyByNote === "object" ? historyByNote : {};
  if (!noteId || !point || !isNoteView(point.view)) return base;

  const existing = base[noteId] || emptyNoteHistory();
  const view = point.view;
  const current = Array.isArray(existing[view]) ? existing[view] : [];
  const appended = [...current, point];
  const capped =
    limit > 0 && appended.length > limit
      ? appended.slice(appended.length - limit)
      : appended;

  return {
    ...base,
    [noteId]: { ...emptyNoteHistory(), ...existing, [view]: capped },
  };
}

/**
 * Drops the in-memory histories of notes that no longer exist, so a long
 * session cannot accumulate the restore points of deleted notes.
 *
 * Returns the SAME object reference when nothing needs removing, so callers
 * can set state unconditionally without causing a render loop.
 */
export function pruneDeletedNoteHistories(historyByNote, liveNoteIds) {
  const base =
    historyByNote && typeof historyByNote === "object" ? historyByNote : {};
  const live =
    liveNoteIds instanceof Set ? liveNoteIds : new Set(liveNoteIds || []);

  const keys = Object.keys(base);
  const survivors = keys.filter((noteId) => live.has(noteId));
  if (survivors.length === keys.length) return base;

  const next = {};
  for (const noteId of survivors) next[noteId] = base[noteId];
  return next;
}

/* --------------------------- asset retention ------------------------------ */

/**
 * Every asset id an ACTIVE Template form restore point still depends on,
 * across every note in the session history.
 *
 * This exists because a restore point holds references, not bytes: if the
 * normal reference-aware cleanup deleted a Blob the moment the CURRENT instance
 * stopped referencing it, restoring an earlier point would resurrect a
 * reference to an asset that no longer exists. An asset is therefore
 * deletable only when neither the current note state nor any live restore point
 * refers to it. Once a point is evicted by the 20-point cap, or the session
 * ends, the reference disappears with it and ordinary cleanup applies again.
 */
export function collectHistoryAssetIds(historyByNote) {
  const ids = new Set();
  const base =
    historyByNote && typeof historyByNote === "object" ? historyByNote : {};

  for (const noteId of Object.keys(base)) {
    const points = base[noteId]?.[NOTE_VIEW.TEMPLATE_FORM];
    if (!Array.isArray(points)) continue;
    for (const point of points) {
      const map = point?.attachments;
      if (!map || typeof map !== "object") continue;
      for (const fieldId of Object.keys(map)) {
        const list = map[fieldId];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (entry && typeof entry.assetId === "string" && entry.assetId) {
            ids.add(entry.assetId);
          }
        }
      }
    }
  }
  return ids;
}

export function isAssetReferencedByHistory(historyByNote, assetId) {
  if (!assetId) return false;
  return collectHistoryAssetIds(historyByNote).has(assetId);
}

/* ------------------------------- restoring -------------------------------- */

/**
 * Whether a Template form point can be applied at all.
 *
 * A point pins an exact templateVersionId. Versions are retained forever —
 * even when their template is deleted — so an unresolvable version means the
 * stored data is gone or corrupt. In that case the restore is refused WHOLE:
 * the current form is left exactly as it is rather than partially rebuilt.
 * `versionExists` is injected so this stays pure and testable.
 */
export function validateTemplateFormRestorePoint(point, { versionExists } = {}) {
  if (!point || point.view !== NOTE_VIEW.TEMPLATE_FORM) {
    return { ok: false, error: "This restore point is not a Template form restore point." };
  }
  if (point.templateVersionId) {
    const exists =
      typeof versionExists === "function" ? !!versionExists(point.templateVersionId) : false;
    if (!exists) {
      return {
        ok: false,
        error:
          "This restore point's template version is no longer available, so nothing was changed.",
      };
    }
  }
  return { ok: true };
}

/**
 * The attachments map to write when applying a Template form point.
 *
 * Captured fields are replaced by the point's references. Fields that were not
 * captured (legacy base64 evidence, see captureTemplateFormAttachments) keep
 * their CURRENT stored value untouched. A field the point does not mention is
 * dropped from the map — it was added after the point was taken — but its
 * underlying Blobs are never deleted here: asset lifecycle stays separate and
 * reference-aware, and the reference may be restored again later.
 */
export function mergeRestoredAttachments(currentMap, point) {
  const current = currentMap && typeof currentMap === "object" ? currentMap : {};
  const captured = point?.attachments && typeof point.attachments === "object" ? point.attachments : {};

  const next = {};
  for (const fieldId of Object.keys(captured)) {
    const list = captured[fieldId];
    next[fieldId] = (Array.isArray(list) ? list : []).map((entry) => ({
      ...entry,
      ...(entry && entry.display ? { display: { ...entry.display } } : {}),
    }));
  }
  for (const fieldId of point?.uncapturedAttachmentFieldIds || []) {
    if (Array.isArray(current[fieldId])) next[fieldId] = current[fieldId];
  }
  return next;
}

/* --------------------------------- labels --------------------------------- */

// A restore point is identified to the user by its time. Raw ids are never
// displayed. The list sits under a heading naming the view (see
// restoreHistoryHeading), so an entry does not repeat it.
export function restorePointTimeLabel(point) {
  const ts = Number(point?.ts);
  if (!Number.isFinite(ts) || ts <= 0) return "Unknown time";
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "Unknown time";
  }
}

// The fuller "Free-form note · 10:42 AM" form, for accessible names where the
// surrounding heading is not adjacent.
export function restorePointAccessibleLabel(point) {
  const label = noteViewLabel(point?.view);
  const time = restorePointTimeLabel(point);
  return label ? `${label} · ${time}` : time;
}
