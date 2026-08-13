// src/lib/templateSectionContent.js
//
// The ORDERED CONTENT of a flexible Template section.
//
// A section is an ordinary Template row that holds an ordered list of items —
// text, photos and files interleaved in whatever order the user built them —
// instead of a single answer with attachments bolted underneath. The list lives
// on the note's NoteTemplateInstance:
//
//   sectionContent: { [rowId]: SectionItem[] }
//
// keyed by the SAME stable row id as `answers` / `attachments` / `evidence` (a
// pinned master field id, or a note-specific custom row id — ids are unique
// across both, so custom sections need no second map). Array order IS document
// order; there is no separate ordering structure, no index map and no sort key.
//
// The field is ADDITIVE and OPTIONAL. An instance saved before it existed reads
// as no section content, exactly like `customRows` and `evidence`, so there is
// no stored migration and no schema/version bump.
//
// ---------------------------------------------------------------------------
// ITEM SHAPES — built from the primitives that already exist, never new ones
// ---------------------------------------------------------------------------
//
//   TextItem   { id, kind: "text", value }
//   PhotoItem  { id, kind: "photo", assetId, name, mimeType, size, createdAt,
//                intrinsicWidth, intrinsicHeight, display: { widthPct, alignment } }
//   FileItem   { id, kind: "file",  assetId, name, mimeType, size, createdAt }
//
// A photo/file item IS the existing attachment reference (src/lib/noteAttachments.js)
// — same fields, same `kind` values, same asset store (IndexedDB kinds
// note-photo / note-file). It is normalized by the existing `normalizeAttachment`
// and nothing here invents a second asset-reference type or a second store.
//
// A text item's `value` IS the existing Template answer value (a plain string,
// or a tagged `{ format: "richtext/1", html }`), normalized by the existing
// `normalizeAnswerValue`, so the sanitization boundary, the plain/rich demotion
// and answer comparison all apply unchanged.
//
// ---------------------------------------------------------------------------
// INVARIANT — DO NOT store section ordering or attachment metadata inside
// `answers[rowId]` (or inside a custom row's `answer`)
// ---------------------------------------------------------------------------
//
// The answer model (src/lib/templateRichText.js) is SHAPE-DISCRIMINATED: an
// answer is EITHER a plain string OR `{ format: "richtext/1", html }`, and
// nothing else. Consequently:
//
//   - `normalizeAnswerValue` REBUILDS a rich value as a fresh `{ format, html }`
//     object from the parsed model, so any extra property hung on the answer is
//     DISCARDED at every read boundary (render, editor load, export, refine) —
//     and demoted to a bare string when the content needs no rich text at all.
//   - `answerIdentity` / `answersEqual` compare only the string or the html, so
//     an ordering-only change would compare EQUAL and the row-level Refine apply
//     gate would overwrite reordered content believing nothing had changed.
//   - A value of any other shape fails `isAnswerValue`, so `normalizeAnswerValue`
//     returns "" and the row reads as EMPTY everywhere.
//   - On a note-specific custom row it is worse still: `normalizeCustomRow`
//     coerces a non-answer to "", and the next edit writes that "" back through
//     the confirmed save — real data loss.
//
// That is why ordered content lives in its own collection, and why a text item
// stores an UNMODIFIED answer value rather than an extended one.
//
// This module is READ-TIME ONLY. Nothing here writes, mutates or migrates
// stored data: a malformed entry is skipped for rendering and left exactly
// where it is in storage.
//
// Pure: no React, no DOM, no storage.

import { ATTACHMENT_KIND, normalizeAttachment } from "./noteAttachments";
import { normalizeAnswerValue } from "./templateRichText";

// The three kinds an ordered section item may have. The photo/file values are
// the EXISTING attachment kinds, re-exported here rather than restated, so the
// two vocabularies can never drift apart.
export const SECTION_ITEM_KIND = {
  TEXT: "text",
  PHOTO: ATTACHMENT_KIND.PHOTO,
  FILE: ATTACHMENT_KIND.FILE,
};

/**
 * How the two halves of an image-induced split were separated, and therefore
 * how they must be put back together if the image between them goes away.
 *
 *   INLINE  the cut fell INSIDE a paragraph. "…this morning " / "and conditions"
 *           must heal back to "…this morning and conditions" — one paragraph,
 *           no boundary invented.
 *   BLOCK   the cut fell at a real paragraph / list-item boundary. That boundary
 *           is the user's own and must survive healing.
 */
export const SECTION_TEXT_JOIN = {
  INLINE: "inline",
  BLOCK: "block",
};

/**
 * SPLIT PROVENANCE — the ONLY thing that makes two adjacent text items heal.
 *
 * When an image is dropped into the middle of a paragraph the one text item
 * becomes two, and the continuation (the RIGHT half) records where it came
 * from: `continuesFrom: { itemId, join }`, naming the item that keeps the LEFT
 * half. Nothing else in the product ever writes this field — two consecutive
 * Quick Add sends are two independent captured blocks and carry none — which is
 * exactly what stops "adjacent" from being mistaken for "belongs together".
 *
 * It is note-instance state on the SectionItem and nowhere else: no
 * TemplateVersion carries it, and it is never document content (export reads a
 * text item's `value`, and only its `value`).
 *
 * Refused, so a corrupt or hostile record cannot invent a relationship:
 *   - a non-object, or one with no usable `itemId`;
 *   - an item naming ITSELF, which would describe a merge with no second item.
 * An unrecognised or missing `join` normalizes to BLOCK — the conservative
 * answer, because it preserves a paragraph boundary rather than silently
 * running two paragraphs of the user's report together.
 */
export function normalizeTextContinuation(raw, ownId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const itemId = raw.itemId;
  if (typeof itemId !== "string" || !itemId) return null;
  if (itemId === ownId) return null;
  return {
    itemId,
    join:
      raw.join === SECTION_TEXT_JOIN.INLINE
        ? SECTION_TEXT_JOIN.INLINE
        : SECTION_TEXT_JOIN.BLOCK,
  };
}

/** True for the text kind — the one item kind that is not an asset reference. */
export function isTextSectionItem(entry) {
  return !!(entry && typeof entry === "object" && entry.kind === SECTION_ITEM_KIND.TEXT);
}

/**
 * Normalize ONE stored section item for rendering, or return null.
 *
 * Text items:
 *   - the `id` must be a non-empty string. There is deliberately NO read-time
 *     id fallback: unlike a template row (whose positional `row-<index>` id is
 *     derived from an immutable version and is therefore stable), a section
 *     item's position changes when the user reorders the list, so a positional
 *     id would silently re-address the item — and with it its editor identity
 *     and its Refine backup. An id-less text item is skipped instead.
 *   - the value goes through `normalizeAnswerValue`, which never throws and
 *     yields "" for anything unusable. An empty text item is legitimate content
 *     (a blank paragraph the user left behind), so it is KEPT rather than
 *     dropped — only a structurally unusable item disappears.
 *
 * Photo/file items: `normalizeAttachment` decides, exactly as it does for
 * `attachments` and `evidence`. It supplies the same defaults, clamps the same
 * display metadata, guarantees a non-empty id (`entry.id || entry.assetId`) and
 * returns null when there is no `assetId` to render from.
 *
 * DISPATCH IS EXPLICIT, AND UNKNOWN KINDS ARE SKIPPED. `sectionContent` is a new
 * discriminated union: the `kind` is the discriminator and only "text", "photo"
 * and "file" are members. It deliberately does NOT inherit the legacy fallback
 * inside `normalizeAttachment`, where a missing or unrecognised `kind` becomes a
 * photo. That fallback exists because the `attachments` collection predates the
 * kind field and its historical entries have to keep rendering; `sectionContent`
 * has never existed historically, so it has no such history to honour. An entry
 * with a missing, unknown or future kind is therefore skipped rather than
 * reinterpreted as an image — guessing would render somebody's report content as
 * something it is not.
 *
 * A legacy base64 data-URL STRING is not a valid section item either —
 * `sectionContent` was created long after the attachment-reference model, so a
 * string here is foreign or corrupt data rather than history to honour (the
 * legacy base64 compatibility path belongs to `attachments` and is untouched).
 */
export function normalizeSectionItem(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  switch (entry.kind) {
    case SECTION_ITEM_KIND.TEXT: {
      if (typeof entry.id !== "string" || !entry.id) return null;
      const item = {
        id: entry.id,
        kind: SECTION_ITEM_KIND.TEXT,
        value: normalizeAnswerValue(entry.value),
      };
      // Carried through the read model deliberately: healing decides from what
      // is on screen ("are these two adjacent right now?"), so the relationship
      // has to survive normalization. It is added only when a valid one is
      // stored, so an ordinary text item's normalized shape is unchanged.
      const continuesFrom = normalizeTextContinuation(entry.continuesFrom, entry.id);
      if (continuesFrom) item.continuesFrom = continuesFrom;
      return item;
    }

    case SECTION_ITEM_KIND.PHOTO:
    case SECTION_ITEM_KIND.FILE:
      // The kind is already known to be one of the two, so the coercion inside
      // normalizeAttachment cannot change it — only its validation, defaults and
      // display clamping apply.
      return normalizeAttachment(entry);

    default:
      // Missing, unknown or a future kind: skipped, never guessed at.
      return null;
  }
}

/**
 * Read-time normalization for an instance's whole `sectionContent` map.
 *
 * Mirrors `normalizeEvidenceMap`'s container rules, so the two collections
 * behave identically where they overlap:
 *   - a missing / non-object / array container normalizes to {}
 *   - an empty row id is ignored
 *   - a non-array per-row collection is dropped
 *   - item order is preserved EXACTLY (text, photo, text stays text, photo, text)
 *   - an unusable item is skipped without shifting the items around it
 *   - a malformed row is dropped on its own; every other row is unaffected
 *   - a row with no usable items is omitted, so the map stays clean
 *
 * Display/read only: nothing here rewrites stored data.
 */
export function normalizeSectionContent(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  const out = {};
  for (const rowId of Object.keys(map)) {
    if (!rowId) continue;
    const list = map[rowId];
    if (!Array.isArray(list)) continue;
    const items = [];
    for (const entry of list) {
      const item = normalizeSectionItem(entry);
      if (item !== null) items.push(item);
    }
    if (items.length) out[rowId] = items;
  }
  return out;
}

/** The normalized items of ONE row, in stored order. Always an array. */
export function sectionItemsForRow(map, rowId) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  if (!rowId) return [];
  const list = map[rowId];
  if (!Array.isArray(list)) return [];
  const items = [];
  for (const entry of list) {
    const item = normalizeSectionItem(entry);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * Does this RAW stored `sectionContent` map reference the given asset id?
 *
 * Part of the asset-deletion gate (see `isAttachmentAssetReferenced` in
 * src/lib/templateModel.js), so it is deliberately more tolerant than the
 * render path: it walks the RAW map and matches any non-text object entry whose
 * `assetId` equals the one asked about, WITHOUT normalizing first. Two reasons:
 *
 *   1. Erring toward "still referenced" is the safe direction for a deletion
 *      decision — an entry too malformed to render must still protect its Blob
 *      rather than have it destroyed underneath it.
 *   2. Normalizing would run the rich-text parser over every text item, which
 *      is pointless work for a question about asset ids.
 *
 * This is a DELIBERATE divergence from `normalizeSectionItem`, which skips an
 * entry with a missing or unknown `kind` rather than guessing at it. Skipping it
 * for RENDERING is safe; treating it as unreferenced for DELETION is not, since
 * the Blob may still be live and a future kind may legitimately own it. So an
 * entry carrying a matching `assetId` protects that asset even when nothing
 * renders it. The cost of being wrong here is one orphaned Blob; the cost of
 * being wrong the other way is destroying a user's evidence.
 *
 * A TEXT item never counts as an asset reference, even if a corrupt record
 * carries an `assetId` alongside `kind: "text"` — a text item has no Blob, so
 * it can never be what keeps one alive.
 */
export function sectionContentReferencesAsset(map, assetId) {
  if (!assetId) return false;
  if (!map || typeof map !== "object" || Array.isArray(map)) return false;
  for (const rowId of Object.keys(map)) {
    const list = map[rowId];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (isTextSectionItem(entry)) continue;
      if (entry.assetId === assetId) return true;
    }
  }
  return false;
}
