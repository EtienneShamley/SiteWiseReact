// src/lib/saveStatus.js
//
// The pure state model behind NoteWise's autosave status.
//
// There is no manual save action. Editing persists continuously through the
// existing storage paths (the note-content record for the Free-form note, the
// NoteTemplateInstance record for the Template form); this model only reports
// what actually happened to those writes.
//
// Two rules define the whole module:
//   1. `Saved` may only ever follow a write Firestore has ACCEPTED (Production
//      Readiness Phase 6). React state updating, the editor rendering, a timer
//      elapsing, a write merely being attempted, or even the local mirror
//      write having landed are all insufficient — see settleSave/markLoaded.
//      A local write that is still waiting for the connection is its own
//      state, `queued` ("Saved on this device"), never "Saved".
//   2. Status is owned per NOTE ID and per NOTE VIEW, and every transition
//      carries a monotonically increasing sequence number. A completion settles
//      only the exact note, view and sequence that started it, so an older
//      completion can never overwrite a newer `Saving…` or a newer failure, and
//      a background write for one note can never alter another note's status.
//
// The wording says where the change is: "Saved" once it is in the account,
// "Saved on this device" while it is only in this browser's mirror and queue.
//
// Kept free of React, storage and the DOM so every rule is directly testable
// (no DOM testing library is installed — see docs/TESTING.md). The timers that
// coalesce the VISIBLE state live in src/hooks/useSaveStatus.js.

import { NOTE_VIEW, isNoteView } from "./noteViews";

// Internal states. `dirty` (a real change is pending a write) and `saving` (a
// write is in progress) are both reported to the user as "Saving…" — the
// distinction matters to the code, not to the person.
export const SAVE_STATUS = {
  IDLE: "idle",
  DIRTY: "dirty",
  SAVING: "saving",
  SAVED: "saved",
  QUEUED: "queued",
  FAILED: "failed",
};

// The outcome a completion may report.
export const SAVE_OUTCOME = Object.freeze({
  SAVED: "saved",
  QUEUED: "queued",
  FAILED: "failed",
});

// The complete user-facing vocabulary. `idle` has no label: nothing has
// happened yet, and inventing a reassuring one would be a claim about storage.
export const SAVE_STATUS_LABEL = {
  [SAVE_STATUS.DIRTY]: "Saving…",
  [SAVE_STATUS.SAVING]: "Saving…",
  [SAVE_STATUS.SAVED]: "Saved",
  [SAVE_STATUS.QUEUED]: "Saved on this device",
  [SAVE_STATUS.FAILED]: "Save failed",
};

// Explains what "Saved" actually means. Shown as the status tooltip and as
// its accessible description.
export const SAVED_HINT = "Changes are automatically saved to your NoteWise account.";
// Kept under its former name for the callers that still import it.
export const SAVED_LOCALLY_HINT = SAVED_HINT;

// Explains "Saved on this device": the change is in this browser and queued
// for the account.
export const QUEUED_HINT =
  "Saved in this browser. It will be saved to your account when the connection returns.";

// The failure explanation. Restrained by design: it never contains an exception
// message, a stack trace, a storage key or any user content.
export const SAVE_FAILED_DETAIL =
  "Your latest changes could not be saved to your account. They stay on screen and in this browser; your next change will try again.";

/** The hint that belongs with an entry's status, or null for none. */
export function saveStatusHint(entry) {
  if (entry?.status === SAVE_STATUS.QUEUED) return QUEUED_HINT;
  if (entry?.status === SAVE_STATUS.FAILED) return null;
  return SAVED_HINT;
}

// How long "Saving…" stays visible before a CONFIRMED success is allowed to
// replace it. This coalesces the display only — the underlying write is
// synchronous and immediate, and is never delayed. A failure is never held.
export const SAVING_MIN_VISIBLE_MS = 450;

const IDLE_ENTRY = Object.freeze({ status: SAVE_STATUS.IDLE, seq: 0 });

export function createSaveStatusState() {
  return {};
}

export function emptyNoteSaveStatus() {
  return {
    [NOTE_VIEW.FREEFORM]: IDLE_ENTRY,
    [NOTE_VIEW.TEMPLATE_FORM]: IDLE_ENTRY,
  };
}

// A stable key for one note's one view — used by the hook to key its timers so
// a pending transition can never be applied to a different note or view.
export function saveStatusKey(noteId, view) {
  return `${noteId || ""}::${view || ""}`;
}

/* ------------------------------- reading -------------------------------- */

// Always returns an entry, so callers never branch on undefined. An unknown
// note or view is idle, which displays nothing.
export function getSaveStatus(statusByNote, noteId, view) {
  if (!statusByNote || !noteId || !isNoteView(view)) return IDLE_ENTRY;
  const entry = statusByNote[noteId]?.[view];
  return entry && typeof entry === "object" ? entry : IDLE_ENTRY;
}

// The exact user-facing text, or null when there is nothing honest to say.
export function saveStatusLabel(entry) {
  return SAVE_STATUS_LABEL[entry?.status] || null;
}

export function isSaveFailed(entry) {
  return entry?.status === SAVE_STATUS.FAILED;
}

export function isSaveQueued(entry) {
  return entry?.status === SAVE_STATUS.QUEUED;
}

export function isSavePending(entry) {
  return (
    entry?.status === SAVE_STATUS.DIRTY || entry?.status === SAVE_STATUS.SAVING
  );
}

/* ------------------------------ transitions ------------------------------ */

function withEntry(statusByNote, noteId, view, entry) {
  const base =
    statusByNote && typeof statusByNote === "object" ? statusByNote : {};
  const existing = base[noteId] || emptyNoteSaveStatus();
  return {
    ...base,
    [noteId]: { ...emptyNoteSaveStatus(), ...existing, [view]: entry },
  };
}

function guard(statusByNote, noteId, view, seq) {
  if (!noteId || !isNoteView(view) || !Number.isFinite(seq) || seq <= 0) {
    return statusByNote && typeof statusByNote === "object" ? statusByNote : {};
  }
  return null;
}

/**
 * A real change has been made and a write is pending.
 *
 * Deliberately replaces a previous `failed` state: the user edited again, so a
 * fresh attempt is genuinely pending. Only a confirmed write may then produce
 * `Saved locally` — a failure that is never retried stays visible.
 */
export function markDirty(statusByNote, noteId, view, seq) {
  const refused = guard(statusByNote, noteId, view, seq);
  if (refused) return refused;
  return withEntry(statusByNote, noteId, view, {
    status: SAVE_STATUS.DIRTY,
    seq,
  });
}

/** A write for this note and view is now in progress. */
export function beginSave(statusByNote, noteId, view, seq) {
  const refused = guard(statusByNote, noteId, view, seq);
  if (refused) return refused;
  return withEntry(statusByNote, noteId, view, {
    status: SAVE_STATUS.SAVING,
    seq,
  });
}

function statusOfOutcome(outcome) {
  if (outcome === true || outcome === SAVE_OUTCOME.SAVED) return SAVE_STATUS.SAVED;
  if (outcome === SAVE_OUTCOME.QUEUED) return SAVE_STATUS.QUEUED;
  return SAVE_STATUS.FAILED;
}

/**
 * Record the CONFIRMED outcome of one write: `true`/"saved" (accepted by the
 * account), "queued" (in this browser, waiting for the connection) or
 * `false`/"failed".
 *
 * Ignored unless this note/view is still waiting for exactly this sequence, so:
 *   - a superseded completion cannot overwrite a newer `Saving…`;
 *   - a delayed success cannot overwrite a newer failure;
 *   - a completion belonging to another note or another view changes nothing
 *     here (it is keyed by its own note and view, never by "whatever is
 *     visible now").
 */
export function settleSave(statusByNote, noteId, view, seq, outcome) {
  const refused = guard(statusByNote, noteId, view, seq);
  if (refused) return refused;
  const current = getSaveStatus(statusByNote, noteId, view);
  if (current.seq !== seq) return statusByNote;
  return withEntry(statusByNote, noteId, view, {
    status: statusOfOutcome(outcome),
    seq,
  });
}

/**
 * This note/view's stored state was READ BACK successfully from the workspace
 * mirror, so it is genuinely persisted and may say so without passing through
 * `Saving…` — "Saved" when nothing for it is still queued for the account,
 * "Saved on this device" (`queued: true`) when a change is still waiting.
 *
 * Callers must only reach here after an actual successful read of stored
 * content — never because a note object exists, React state initialized, an
 * empty editor mounted or a component mounted.
 *
 * Applies only to an `idle` view: a note that already has a real status this
 * session (including a genuine failure) keeps it when the user returns to it.
 */
export function markLoaded(statusByNote, noteId, view, seq, { queued = false } = {}) {
  const refused = guard(statusByNote, noteId, view, seq);
  if (refused) return refused;
  const current = getSaveStatus(statusByNote, noteId, view);
  if (current.status !== SAVE_STATUS.IDLE) return statusByNote;
  return withEntry(statusByNote, noteId, view, {
    status: queued ? SAVE_STATUS.QUEUED : SAVE_STATUS.SAVED,
    seq,
  });
}

/**
 * Drop the statuses of notes that no longer exist. Returns the SAME reference
 * when nothing needs removing, so callers can set state unconditionally without
 * driving a render loop (same contract as the other prune helpers).
 */
export function pruneSaveStatus(statusByNote, liveNoteIds) {
  const base =
    statusByNote && typeof statusByNote === "object" ? statusByNote : {};
  const live =
    liveNoteIds instanceof Set ? liveNoteIds : new Set(liveNoteIds || []);
  const keys = Object.keys(base);
  const survivors = keys.filter((noteId) => live.has(noteId));
  if (survivors.length === keys.length) return base;

  const next = {};
  for (const noteId of survivors) next[noteId] = base[noteId];
  return next;
}
