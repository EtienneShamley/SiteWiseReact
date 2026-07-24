// src/lib/templateFields.js
//
// Single source of truth for the structured Template Field Type system
// (Text, Multiline, Number, Date, Time, Checkbox, Yes/No, Dropdown).
//
// This module is pure and framework-agnostic so it can be unit-tested in
// isolation. It provides:
//   - the field-type catalog used by the builder's type selector,
//   - read-time row/option normalization that supplies safe rendering
//     defaults WITHOUT mutating stored immutable template versions and
//     WITHOUT ever generating a fresh id on an ordinary read,
//   - the BottomBar text-insertion compatibility check.
//
// Backward-compatibility choices (see docs/ARCHITECTURE.md):
//   - There is a single unified "text" field type. It renders as a full-cell
//     textarea (multiline, preserves line breaks). The earlier separate
//     "multiline" type has been folded into it: a stored `type: "multiline"`
//     (and the old default of an untyped row) normalizes to "text". This keeps
//     existing multi-line answers, including line breaks, visible and
//     unchanged while removing the single-line/multiline distinction.
//   - Ids are never regenerated on read. An id-less row falls back to a
//     DETERMINISTIC positional id (`row-<index>`), so the same row resolves to
//     the same effective id on every reload and answers keyed by it are never
//     orphaned. New rows/options are the only place a fresh `newId()` is used.

import { newId } from "./id";

export const FIELD_TYPE = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  TIME: "time",
  CHECKBOX: "checkbox",
  YESNO: "yesno",
  SELECT: "select",
};

// Ordered catalog for the builder's per-row type selector.
export const FIELD_TYPES = [
  { value: FIELD_TYPE.TEXT, label: "Text" },
  { value: FIELD_TYPE.NUMBER, label: "Number" },
  { value: FIELD_TYPE.DATE, label: "Date" },
  { value: FIELD_TYPE.TIME, label: "Time" },
  { value: FIELD_TYPE.CHECKBOX, label: "Checkbox" },
  { value: FIELD_TYPE.YESNO, label: "Yes / No" },
  { value: FIELD_TYPE.SELECT, label: "Dropdown" },
];

const VALID_TYPES = new Set(FIELD_TYPES.map((t) => t.value));

// Legacy types that map onto a current type (the old "multiline" is now "text").
const LEGACY_TYPE_ALIASES = { multiline: FIELD_TYPE.TEXT };

// Unknown / missing / legacy-"multiline" type => unified "text".
export function normalizeType(type) {
  if (LEGACY_TYPE_ALIASES[type]) return LEGACY_TYPE_ALIASES[type];
  return VALID_TYPES.has(type) ? type : FIELD_TYPE.TEXT;
}

// Normalize dropdown options for RENDERING. Option ids are preserved as-is;
// an id-less option falls back to a deterministic positional id (never a
// fresh id on read). Values are coerced to strings for safe rendering.
export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((o, idx) => ({
    id: (o && o.id) || `opt-${idx}`,
    value:
      o && typeof o.value === "string" ? o.value : String((o && o.value) ?? ""),
  }));
}

// Create a brand-new dropdown option (the only place option ids are minted).
export function makeOption(value = "") {
  return { id: newId(), value };
}

// Normalize a stored row for RENDERING only — it never rewrites the stored
// immutable version. `idx` supplies the deterministic id fallback.
export function normalizeRow(row, idx) {
  const r = row || {};
  const type = normalizeType(r.type);
  return {
    id: r.id || `row-${idx}`,
    label: r.label ?? "",
    px: r.px ?? 120,
    minPx: r.minPx ?? 100,
    type,
    // Options are only meaningful for dropdowns, but dormant options on a row
    // whose type was switched away from Dropdown are retained (not deleted)
    // for the smallest safe behavior — see docs/ARCHITECTURE.md.
    options: normalizeOptions(r.options),
  };
}

export function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r, idx) => normalizeRow(r, idx));
}

// BottomBar text insertion is only valid for the free-text destination.
export function isTextInsertable(type) {
  return normalizeType(type) === FIELD_TYPE.TEXT;
}

// ---------- Answer display resolution (guards against id leakage) ----------
//
// A dropdown answer stores the selected option's stable id. That id must be
// resolved to its label for display, and must NEVER be shown as raw text — for
// example when a field that was previously a dropdown is now rendered as a Text
// field (the note re-pinned to a version where the field's type changed), its
// stored option id would otherwise appear verbatim in the textarea.
//
// The check is by EXACT identity (the value is the row's own id, or a known
// option id), never by "looks like a UUID", so legitimate user text — even a
// UUID a user actually typed — is preserved. Resolution is display-only and
// non-destructive: the stored answer is untouched, so if the note later returns
// to a version where the field is a dropdown, the label resolves again.

// True when `value` is provably internal metadata (the field's own id, or one
// of the known dropdown option ids), not user-entered content.
export function isInternalIdValue(value, rowId, knownOptionIds) {
  if (typeof value !== "string" || value === "") return false;
  if (value === rowId) return true;
  return !!(knownOptionIds && knownOptionIds.has && knownOptionIds.has(value));
}

// The string a text-like control should DISPLAY: the stored string, unless it
// is provably an internal id (then blank, so a placeholder shows instead).
export function displayTextValue(value, rowId, knownOptionIds) {
  if (typeof value !== "string") return "";
  return isInternalIdValue(value, rowId, knownOptionIds) ? "" : value;
}

// Resolve a stored dropdown option id to its label from a set of options.
// Returns "" when the id doesn't match any option, so an unresolved option id
// is shown as blank rather than as raw text.
export function resolveOptionLabel(options, optionId) {
  const opt = (Array.isArray(options) ? options : []).find(
    (o) => o && o.id === optionId
  );
  return opt ? opt.value : "";
}
