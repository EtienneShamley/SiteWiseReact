// src/lib/templateRowOps.js
//
// Pure row-insertion helpers for the MASTER Template Builder — these operate on
// TemplateVersion row definitions (the reusable company template), and are
// deliberately separate from note-specific custom rows (src/lib/noteCustomRows.js)
// so the two workflows can never share a mutation path.
//
// These functions do not mint ids, do not touch storage, and do not publish a
// version: the caller supplies an already-built row (`makeNewRow`, which uses
// `newId()`) and publishes through `publishTemplateVersion` as before, so
// version immutability and existing pinned notes are unaffected.

export const ROW_POSITION = { ABOVE: "above", BELOW: "below" };

export function normalizeRowPosition(position) {
  return position === ROW_POSITION.ABOVE ? ROW_POSITION.ABOVE : ROW_POSITION.BELOW;
}

// Appends a row to the end of the template.
export function appendRow(rows, newRow) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (newRow) list.push(newRow);
  return list;
}

// Inserts `newRow` directly above or below the row with id `anchorId`.
// An unknown/absent anchor appends at the end rather than dropping the row, so
// the caller can never lose a row it just created. Order of the existing rows
// is preserved exactly; no existing row object is mutated or replaced.
export function insertRowAt(rows, anchorId, position, newRow) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!newRow) return list;
  const idx = list.findIndex((r) => r && r.id === anchorId);
  if (idx === -1) {
    list.push(newRow);
    return list;
  }
  const at = normalizeRowPosition(position) === ROW_POSITION.ABOVE ? idx : idx + 1;
  list.splice(at, 0, newRow);
  return list;
}
