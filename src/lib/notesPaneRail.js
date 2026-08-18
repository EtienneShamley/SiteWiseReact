// src/lib/notesPaneRail.js
//
// THE COLLAPSED NOTES RAIL — what a collapsed Notes pane says about itself.
//
// The pane is the contents of ONE folder (see MiddlePane.js), so collapsed it
// still shows three things: that it is Notes, how many notes are in the folder
// it represents, and the way back. This module owns the two decisions in that
// — WHEN a count is honest, and HOW it is worded — as pure values, so they can
// be proved with real numbers rather than described.
//
// WHY THE COUNT IS NOT ALWAYS SHOWN. The count belongs to a PROJECT-CHILD
// folder. With a root-level folder selected there is no applicable folder for
// it, and "0" would not mean "this folder is empty" — it would mean "there is
// nothing to count here", which is a different statement and a misleading one.
// Omitting it is the honest answer; the Notes identity and the way back stay.
//
// Pure: no React, no DOM, no storage.

/** Above this, the rail shows `99+` so a narrow column cannot be widened by a number. */
export const NOTE_COUNT_DISPLAY_CAP = 99;

/**
 * The count to show, or null when showing one would be misleading.
 *
 * `noteCount` is the length of the SAME canonical collection the expanded pane
 * lists — never a separately tracked number, which is what keeps it correct
 * through note creation, deletion and any future move without anything to keep
 * in step.
 */
export function notesRailCount({ activeProjectId, activeFolderId, noteCount } = {}) {
  if (!activeProjectId || !activeFolderId) return null;
  // Only a real number is a count. `Number(null)` is 0, so coercing here would
  // turn an ABSENT count into a confident "0 notes" — the exact misleading
  // zero this function exists to prevent.
  if (typeof noteCount !== "number" || !Number.isFinite(noteCount) || noteCount < 0) {
    return null;
  }
  return Math.floor(noteCount);
}

/** The visible text for a count, capped so the rail stays narrow. */
export function formatNoteCount(count) {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return "";
  return count > NOTE_COUNT_DISPLAY_CAP
    ? `${NOTE_COUNT_DISPLAY_CAP}+`
    : String(Math.floor(count));
}

/**
 * The restore control's accessible name. It carries the count in WORDS, so a
 * screen reader hears what the rail shows rather than a bare "expand" — and
 * "no notes" rather than "0 notes", which reads as a quantity nobody says out
 * loud. With no applicable folder it names the action alone.
 */
export function notesRailRestoreLabel(count) {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
    return "Expand notes pane";
  }
  const n = Math.floor(count);
  if (n === 0) return "Expand notes pane, no notes";
  if (n === 1) return "Expand notes pane, 1 note";
  return `Expand notes pane, ${n} notes`;
}
