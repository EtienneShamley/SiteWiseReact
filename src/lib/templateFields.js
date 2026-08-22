// src/lib/templateFields.js
//
// Single source of truth for the structured Template Field Type system
// (Text, Multiline, Number, Date, Time, Checkbox, Yes/No, Dropdown).
//
// This module is pure and framework-agnostic so it can be unit-tested in
// isolation. It provides:
//   - the VALIDITY set of stored field types (`FIELD_TYPES`, `normalizeType`)
//     and, separately, the smaller CREATION catalog the builder's type selector
//     offers (`BUILDER_FIELD_TYPES`, `builderFieldTypeOptions`),
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
  PHOTO: "photo",
  FILE: "file",
};

// Every type a STORED row may legitimately carry — the validity set behind
// `normalizeType`. It is deliberately unchanged and complete: `photo` and
// `file` remain fully valid stored types, so an existing pinned TemplateVersion
// containing one keeps rendering and exporting exactly as it does today.
//
// This is NOT the builder's creation catalog — see BUILDER_FIELD_TYPES below.
export const FIELD_TYPES = [
  { value: FIELD_TYPE.TEXT, label: "Text" },
  { value: FIELD_TYPE.NUMBER, label: "Number" },
  { value: FIELD_TYPE.DATE, label: "Date" },
  { value: FIELD_TYPE.TIME, label: "Time" },
  { value: FIELD_TYPE.CHECKBOX, label: "Checkbox" },
  { value: FIELD_TYPE.YESNO, label: "Yes / No" },
  { value: FIELD_TYPE.SELECT, label: "Dropdown" },
  { value: FIELD_TYPE.PHOTO, label: "Photo" },
  { value: FIELD_TYPE.FILE, label: "File" },
];

// ---------- BUILDER CREATION CATALOG ----------
//
// What the Template Builder OFFERS when a user chooses a row's type. It is a
// strict subset of the validity set above, and the split is the whole point:
// which types are STORABLE and which types are CREATABLE are different
// questions, so narrowing the second one can never invalidate data written
// under the first.
//
// The normal row is a SECTION — a flexible document area that may later hold
// text, images and files in any order. Its stored type is the existing unified
// `"text"`, unchanged: a Section is not a new persisted row type, it is the
// user-facing name for the flexible area that type has already described since
// the section model landed (see src/lib/templateSectionContent.js and the
// authority rule in src/lib/templateRowContent.js). No migration, no schema
// bump, and every existing `type: "text"` row IS a Section already.
//
// "Text" is therefore NOT offered alongside "Section": they would be the same
// stored thing under two names, and a user choosing between them would be
// choosing nothing.
//
// Photo and File are NOT offered. Photos and files are CONTENT a user adds
// while completing a note (typing, Quick Add, camera, upload) into any section
// — never something they should have to predict and design into the template.
// The structured types below are not closed containers either: each defines one
// primary typed control, and supplementary section content may still be added
// beneath it at runtime.
export const BUILDER_FIELD_TYPES = [
  { value: FIELD_TYPE.TEXT, label: "Section" },
  { value: FIELD_TYPE.NUMBER, label: "Number" },
  { value: FIELD_TYPE.DATE, label: "Date" },
  { value: FIELD_TYPE.TIME, label: "Time" },
  { value: FIELD_TYPE.CHECKBOX, label: "Checkbox" },
  { value: FIELD_TYPE.YESNO, label: "Yes / No" },
  { value: FIELD_TYPE.SELECT, label: "Dropdown" },
];

// The type a brand-new row gets. Kept here next to the catalog so the default
// and the catalog can never drift apart.
export const DEFAULT_BUILDER_FIELD_TYPE = FIELD_TYPE.TEXT;

// Legacy-only selector entries. These exist so that a row ALREADY stored as
// Photo or File shows its own real type in the builder's selector instead of
// silently displaying as something it is not. They are keyed by type and are
// added ONLY for the row that already carries that type — never as a general
// choice, so a Photo/File row cannot be created from a row that isn't one.
const LEGACY_BUILDER_FIELD_TYPES = {
  [FIELD_TYPE.PHOTO]: { value: FIELD_TYPE.PHOTO, label: "Photo (legacy)" },
  [FIELD_TYPE.FILE]: { value: FIELD_TYPE.FILE, label: "File (legacy)" },
};

// The selector options for ONE builder row, given its CURRENT stored type.
//
// Ordinary rows get the creation catalog exactly. A row already stored as
// Photo/File additionally gets its own legacy entry, so the selector reflects
// the stored type truthfully and switching away from it stays a deliberate user
// action rather than an implicit conversion on open. Nothing here writes: the
// stored type is read, never rewritten.
export function builderFieldTypeOptions(currentType) {
  const legacy = LEGACY_BUILDER_FIELD_TYPES[currentType];
  return legacy ? [...BUILDER_FIELD_TYPES, legacy] : BUILDER_FIELD_TYPES;
}

// True for the attachment-bearing field types (evidence lives on the note's
// NoteTemplateInstance as asset references, never on the TemplateVersion).
export function isAttachmentFieldType(type) {
  const t = normalizeType(type);
  return t === FIELD_TYPE.PHOTO || t === FIELD_TYPE.FILE;
}

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
  const normalized = {
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
  // `pxExplicit` marks a height a user deliberately dragged, so a stored `px`
  // is told apart from a scaffold default (src/lib/templateRowHeight.js). It is
  // carried through ONLY when present: a row that never had one must not gain
  // the key on a read, or every legacy row would claim a deliberate height.
  if (r.pxExplicit === true) normalized.pxExplicit = true;
  // The row's VALUE COLUMNS, when it has more than the one every row has always
  // had. Carried through raw and projected for rendering by `rowCells`
  // (src/lib/templateColumns.js) — the single owner of the column model, which
  // reads this module and so cannot be read from it. A row without the key is
  // left without it, which is what keeps an existing template's published bytes
  // identical.
  if (Array.isArray(r.cells)) normalized.cells = r.cells;
  // The row's LABEL cell fill override, when it has one. Carried through raw
  // and validated by the fill model (src/lib/templateFill.js) at the point of
  // use, exactly like `cells` above — this module owns the field schema, not
  // the colour model. A row without the key is left without it, which is what
  // keeps an existing template's published bytes identical.
  if (r.labelFill && typeof r.labelFill === "object") normalized.labelFill = r.labelFill;
  return normalized;
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
