// src/lib/templateSectionEditing.js
//
// The WRITE rules for a flexible Template section's ordered content.
//
// src/lib/templateSectionContent.js is deliberately read-only: it says what a
// stored `sectionContent[rowId]` list MEANS. This module is its write-side
// twin — it says how that list is FIRST CREATED for a row that has never had
// one, and how one text item inside it is replaced. It is still pure: every
// function takes stored values and returns new ones, and nothing here touches
// storage, React or the DOM. The confirmed instance save stays in
// NoteTemplateDoc, where it already is.
//
// ---------------------------------------------------------------------------
// MATERIALISATION — a legacy row becoming an ordered section
// ---------------------------------------------------------------------------
//
// Most existing rows have no `sectionContent` at all: their body is
// `answers[rowId]` (or `customRows[].answer`) with optional `evidence[rowId]`
// underneath. Such a row keeps that shape until the user actually CHANGES its
// text. On that first real change — never on focus, never on selection, never
// on a formatting command that altered nothing — the row's visible content is
// rebuilt ONCE as an ordered list:
//
//   [ TextItem(the NEW edited value), ...the row's carryable evidence, in order ]
//
// and that complete list is written in a SINGLE confirmed save. There is
// deliberately no intermediate state in which `sectionContent[rowId]` exists
// but does not yet carry the row's evidence: from Phase 1 onward section
// content is AUTHORITATIVE for rendering, so a half-written list would make the
// user's photos and files vanish for as long as the second write took — and
// forever if it failed.
//
// FROZEN LEGACY COPIES. Materialisation adds; it never clears. `answers[rowId]`
// (or `customRows[].answer`) keeps its PRE-EDIT value and `evidence[rowId]`
// keeps its entries, both untouched, as compatibility copies. They stop being
// rendered because section content outranks them, not because they were
// destroyed. Removing them is a later, separately approved change.
//
// NO BINARY IS DUPLICATED. A carried evidence entry is copied VERBATIM — the
// same `assetId`, the same attachment id, the same display metadata — so both
// collections name the one Blob that already exists in IndexedDB. No asset is
// created, rewritten or deleted, and `isAttachmentAssetReferenced` already
// scans `attachments`, `evidence` AND `sectionContent`, so a Blob named by
// either copy is protected from cleanup.
//
// WHAT IS NOT CARRIED, and why:
//   - a legacy base64 data-URL STRING. `sectionContent` was created long after
//     the attachment-reference model; a string there is foreign data, and the
//     legacy base64 compatibility path belongs to `attachments`, untouched.
//   - an entry with a missing, unknown or merely similar-looking `kind`, or one
//     `normalizeSectionItem` cannot use. A section item's kind is a strict
//     discriminator; guessing would render somebody's report content as
//     something it is not.
//   - an entry carrying `kind: "text"`. Whatever that is, it is not evidence,
//     and copying it as a text item would silently drop its asset reference.
// Such an entry stays exactly where it is, in the frozen `evidence[rowId]`.
//
// WHAT IS NEVER MATERIALISED:
//   - a structured row's typed value (number/date/time/checkbox/yes-no/select).
//     It stays in `answers[rowId]`, where its control reads and writes it.
//   - a legacy Photo/File field's primary `attachments[rowId]`.
// Both keep their own primary control and may hold ordered section items BELOW
// it; neither turns its own value into a text item.
//
// ---------------------------------------------------------------------------
// UPDATING ONE TEXT ITEM
// ---------------------------------------------------------------------------
//
// A section may be text A, photo, text B, file, text C. Editing text B must
// replace the value of text B and nothing else: every other item keeps its
// exact position, its exact id and its exact attachment reference. Items are
// therefore found by their stable `id`, NEVER by array index — an index is
// meaningless the moment the list is reordered, and reordering is coming.
//
// An item that no longer exists is a refusal, not a redirection: a late
// callback from an editor whose item has gone must write nowhere rather than
// overwrite whichever text item happens to sit nearby.
//
// Pure: no React, no DOM, no storage.

import { ATTACHMENT_KIND } from "./noteAttachments";
import { answersEqual, isAnswerValue } from "./templateRichText";
import {
  SECTION_ITEM_KIND,
  isTextSectionItem,
  normalizeSectionItem,
  sectionItemsForRow,
} from "./templateSectionContent";

/** Is this entry a stored TEXT item with exactly this id? */
function isTextItemWithId(entry, itemId) {
  return (
    !!entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.kind === SECTION_ITEM_KIND.TEXT &&
    entry.id === itemId
  );
}

/**
 * A new ordered TEXT item, or null when it could not be built safely.
 *
 * The id must be a real, caller-minted string: a text item has NO read-time id
 * fallback (a positional one would re-address the item — and its editor
 * identity and its Refine backup with it — after a reorder), so an id-less item
 * would simply stop rendering.
 *
 * The value must already be an ANSWER VALUE — a plain string or a tagged
 * `{ format: "richtext/1", html }`, i.e. exactly what `serializeAnswerFromHtml`
 * produces. Nothing else is coerced into one: silently turning an unrecognised
 * value into "" would destroy the text it came from.
 */
export function makeTextSectionItem({ id, value } = {}) {
  if (typeof id !== "string" || !id) return null;
  if (!isAnswerValue(value)) return null;
  return { id, kind: SECTION_ITEM_KIND.TEXT, value };
}

/**
 * The entries of one raw stored `evidence[rowId]` array that may be carried
 * into ordered section content, copied VERBATIM and in their stored order.
 *
 * "Verbatim" is the whole point: the copy reuses the entry's existing
 * attachment id, asset id and display metadata, so the two collections name one
 * Blob rather than two. Each entry is shallow-copied so the two arrays never
 * share a mutable object.
 *
 * The gate is `normalizeSectionItem` — the same rule that decides whether an
 * item RENDERS — plus an explicit "not a text item" guard. Using the render
 * rule as the gate is what guarantees that nothing carried across becomes
 * invisible; anything it rejects stays in the frozen `evidence` copy instead of
 * being converted into a shape it was never in.
 */
export function carryableEvidenceItems(rawEvidenceList) {
  if (!Array.isArray(rawEvidenceList)) return [];
  const out = [];
  for (const entry of rawEvidenceList) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    // An evidence record claiming `kind: "text"` is not evidence. It must not
    // become a text item either: `normalizeSectionItem` would accept it and
    // drop the asset reference it carries.
    if (isTextSectionItem(entry)) continue;
    if (entry.kind !== ATTACHMENT_KIND.PHOTO && entry.kind !== ATTACHMENT_KIND.FILE) {
      continue;
    }
    if (normalizeSectionItem(entry) === null) continue;
    out.push({ ...entry });
  }
  return out;
}

/**
 * The COMPLETE ordered body to write on a row's first real text change, or null
 * when it could not be built (an unusable id or value — the caller must then
 * write nothing at all rather than write a partial row).
 *
 * The text item comes FIRST and carries the value being committed right now —
 * the new text the user just typed, never the stale pre-edit answer. The row's
 * carryable evidence follows it, in its existing order.
 */
export function materializeRowSectionItems({ textItemId, value, evidence } = {}) {
  const textItem = makeTextSectionItem({ id: textItemId, value });
  if (!textItem) return null;
  return [textItem, ...carryableEvidenceItems(evidence)];
}

/** The index of the stored TEXT item with this id, or -1. Never by position. */
export function findTextSectionItemIndex(list, itemId) {
  if (!Array.isArray(list) || typeof itemId !== "string" || !itemId) return -1;
  return list.findIndex((entry) => isTextItemWithId(entry, itemId));
}

/**
 * One row's stored list with ONE text item's value replaced, or null.
 *
 * Null means "write nothing", and it covers three cases that must all be
 * refused rather than approximated:
 *   - the value is not an answer value;
 *   - no text item with that id exists any more (a late callback from an editor
 *     whose item has gone — it is never redirected to another item);
 *   - the value is unchanged in MEANING (`answersEqual`), so selecting text or
 *     running a command that altered nothing produces no save.
 *
 * Every other entry is passed through by reference-copy at its exact position,
 * so order, ids, attachment references and photo display metadata are all
 * preserved untouched.
 */
export function updateTextSectionItemValue(list, itemId, value) {
  if (!isAnswerValue(value)) return null;
  const index = findTextSectionItemIndex(list, itemId);
  if (index === -1) return null;
  if (answersEqual(list[index].value, value)) return null;
  return list.map((entry, i) => (i === index ? { ...entry, value } : entry));
}

/** A `sectionContent` map with ONE row's list replaced. Other rows untouched. */
export function setRowSectionItems(map, rowId, items) {
  const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (typeof rowId !== "string" || !rowId || !Array.isArray(items)) return base;
  return { ...base, [rowId]: items };
}

/** A `sectionContent` map with ONE row's list removed. Other rows untouched. */
export function removeRowSectionContent(map, rowId) {
  const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (typeof rowId !== "string" || !rowId || !(rowId in base)) return base;
  const next = { ...base };
  delete next[rowId];
  return next;
}

/**
 * Does this row already have a usable ordered body?
 *
 * Asked through the RENDER model, because that is the question that matters: a
 * row whose stored list normalizes to nothing renders from its legacy answer,
 * so it has not been materialised yet and its first real edit still should
 * materialise it.
 */
export function rowHasSectionContent(map, rowId) {
  return sectionItemsForRow(map, rowId).length > 0;
}

/**
 * Every asset id referenced by one row's raw stored list, in stored order.
 *
 * Used when a note-specific custom row is deleted: its ordered content goes
 * with it, so those assets become deletion CANDIDATES. They are still only
 * deleted once `isAttachmentAssetReferenced` proves nothing else names them —
 * the frozen `evidence` copy of the same row is removed in the same save, but a
 * genuinely shared asset must survive.
 */
export function sectionContentAssetIds(map, rowId) {
  const list = map && typeof map === "object" && !Array.isArray(map) ? map[rowId] : null;
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (isTextSectionItem(entry)) continue;
    if (typeof entry.assetId === "string" && entry.assetId) ids.push(entry.assetId);
  }
  return ids;
}
