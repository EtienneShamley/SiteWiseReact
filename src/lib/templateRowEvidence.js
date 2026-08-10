// src/lib/templateRowEvidence.js
//
// WHICH document blocks one Template row produces, and in what order.
//
// A completed note has THREE distinct per-row collections on its
// NoteTemplateInstance, and they are never merged into one array:
//
//   attachments[rowId]     the PRIMARY value of a Photo/File field
//   evidence[rowId]        optional SUPPORTING evidence for any row (legacy)
//   sectionContent[rowId]  the ORDERED body of a flexible section
//
// Evidence follows the STABLE ROW ID, not the field type. A row that was Text
// when its evidence was captured keeps that evidence after the note is re-pinned
// to a version where the same id is a Photo field: the Photo field renders its
// own primary attachments, and the historical evidence renders separately
// underneath. Evidence is therefore rendered because `evidence[rowId]` exists,
// never because the current type is one of the "evidence-capable" ones — which
// is the whole reason this decision lives in one tested place instead of being
// re-derived from a field type at a render site.
//
// A row that is not part of what the note is pinned to right now simply never
// reaches this module (the caller iterates the pinned version's rows plus this
// note's custom rows), so orphan evidence — and orphan section content — is
// never rendered and, just as importantly, never deleted: it stays in storage
// untouched.
//
// ---------------------------------------------------------------------------
// SECTION CONTENT IS AUTHORITATIVE WHEN IT EXISTS
// ---------------------------------------------------------------------------
//
// `sectionContent[rowId]` (see src/lib/templateSectionContent.js) is the
// ordered, heterogeneous body of a flexible section: text, photos and files
// interleaved in exactly the order the user built them. When a row has one or
// more VALID items there, that list becomes the row's body and the row's legacy
// `evidence` is NOT rendered as well. Rendering both would show the same
// material twice the moment a later phase materialises a row's evidence into
// its ordered list — so the choice is made once, here, rather than being
// re-derived at a render site.
//
// What section content does NOT displace is the row's own PRIMARY value:
//
//   - a structured row (number/date/time/checkbox/yes-no/dropdown) keeps its
//     typed control over `answers[rowId]` first, then the ordered items;
//   - a legacy Photo/File field keeps its `attachments[rowId]` first, then the
//     ordered items.
//
// Only a Text row (and a note-specific custom row, which is Text by
// definition) hands its whole body over: its first ordered item becomes the
// row head and carries the label, so `answers[rowId]` is not rendered as well.
// The stored answer is left exactly where it is — this is a read-time choice,
// never a migration.
//
// A row with no valid section content plans EXACTLY the blocks it always did.
//
// Pure: no React, no DOM, no storage.

import { normalizeAttachment, ATTACHMENT_KIND } from "./noteAttachments";
import { SECTION_ITEM_KIND, sectionItemsForRow } from "./templateSectionContent";
import { sectionExtraHeightFor } from "./templateSectionHeight";
import { FIELD_TYPE, normalizeType } from "./templateFields";

export const ROW_BLOCK_KIND = {
  // An ordinary row: label + the type-appropriate answer control.
  ROW: "row",
  // The head of a compound Photo/File field: label + upload control + errors.
  ATTACHMENT_HEAD: "attachment-head",
  // One atomic block per PRIMARY Photo/File attachment.
  ATTACHMENT: "attachment",
  // One atomic block per SUPPORTING evidence item.
  EVIDENCE: "evidence",
  // One block per ordered `sectionContent` item. The first one carries the row
  // label (`isRowHead`) when the row has no primary block of its own.
  SECTION_ITEM: "section-item",
};

// Preferred/minimum heights for an atomic attachment block. These are hints for
// the first paint only — PagedDocument measures the real rendered height — and
// they match the values the compound Photo/File field already used, so adding
// evidence cannot change where an existing Photo/File field paginates.
export const ATTACHMENT_BLOCK_MIN_PX = { photo: 60, file: 36 };

// First-paint hint for an ordered section TEXT item.
//
// It applies to EVERY text item including the head, because a flexible section
// is content-driven: its height comes from what is actually in it, never from
// the legacy whole-row height. See sectionItemMinHeight.
export const SECTION_TEXT_BLOCK_MIN_PX = 24;

// The field types that keep their own typed control ABOVE any ordered section
// content. Photo/File are absent deliberately: they are handled by the caller's
// `isAttachmentField` flag, which also accounts for whether attachment
// rendering is enabled at all (a Template Builder never renders note content).
const STRUCTURED_FIELD_TYPES = new Set([
  FIELD_TYPE.NUMBER,
  FIELD_TYPE.DATE,
  FIELD_TYPE.TIME,
  FIELD_TYPE.CHECKBOX,
  FIELD_TYPE.YESNO,
  FIELD_TYPE.SELECT,
]);

/**
 * The renderable entries of one raw stored attachment/evidence array.
 *
 * Each entry keeps its RAW STORED INDEX alongside the normalized value, because
 * removal addresses an entry by its index in the stored array. Normalization
 * drops unusable entries, so a normalized position is NOT a stored position —
 * carrying the raw index is what keeps "remove the second thing I can see" and
 * "remove stored entry 2" the same operation even when entry 1 is malformed.
 *
 * Nothing here rewrites storage: a filtered entry stays exactly where it is.
 */
function renderableEntries(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((raw, index) => ({ raw, norm: normalizeAttachment(raw), index }))
    .filter((entry) => entry.norm !== null);
}

/**
 * The evidence items to render for one row, in stored order.
 *
 * Order is preserved exactly as stored — photo, file, photo stays photo, file,
 * photo. Photos are never regrouped ahead of files.
 *
 * A legacy base64 STRING is not a valid evidence entry. Evidence is a collection
 * created after the attachment-reference model existed, so a string here is
 * foreign or corrupt data rather than history to be honoured (the legacy
 * base64 compatibility path belongs to `attachments`, and is untouched). Such an
 * entry is skipped at render time and left in storage.
 */
export function rowEvidenceItems(evidenceMap, rowId) {
  if (!evidenceMap || typeof evidenceMap !== "object" || Array.isArray(evidenceMap)) {
    return [];
  }
  if (!rowId) return [];
  return renderableEntries(evidenceMap[rowId]).filter(
    (entry) => typeof entry.norm !== "string"
  );
}

/** True when this row has at least one renderable evidence item. */
export function hasRowEvidence(evidenceMap, rowId) {
  return rowEvidenceItems(evidenceMap, rowId).length > 0;
}

/** The primary Photo/File attachment items of one row, in stored order. */
export function rowAttachmentItems(attachmentsMap, rowId) {
  if (!attachmentsMap || typeof attachmentsMap !== "object") return [];
  if (!rowId) return [];
  return renderableEntries(attachmentsMap[rowId]);
}

/**
 * The ordered items of one row's flexible section, in stored order.
 *
 * Delegates to the Phase 0 read model so the strict item discriminator, the
 * "an id-less text item is skipped" rule and the "an empty text item is real
 * authored content" rule are stated in exactly one place. Raw `sectionContent`
 * is never read directly by a planner or a render site.
 */
export function rowSectionItems(sectionContent, rowId) {
  return sectionItemsForRow(sectionContent, rowId);
}

/** True when this row has at least one renderable ordered section item. */
export function hasRowSectionContent(sectionContent, rowId) {
  return rowSectionItems(sectionContent, rowId).length > 0;
}

function attachmentMinHeight(norm) {
  const kind = typeof norm === "string" ? ATTACHMENT_KIND.PHOTO : norm.kind;
  return kind === ATTACHMENT_KIND.FILE
    ? ATTACHMENT_BLOCK_MIN_PX.file
    : ATTACHMENT_BLOCK_MIN_PX.photo;
}

/**
 * The first-paint height HINT for one ordered section item, decided by the
 * ITEM'S OWN kind and by nothing else.
 *
 * This is what makes a flexible section content-driven. It is deliberately used
 * for the head item too: a section's height is the sum of what is in it, so a
 * short paragraph followed by a photo stacks tightly instead of reserving the
 * legacy whole-row height above the photo.
 *
 * It is only ever a HINT. `resolveBlockHeight` takes
 * `max(preferred, measured)`, and PagedDocument measures the real rendered
 * height, so the number below governs the first paint and the floor — never the
 * final layout. Keeping it small is what stops pagination reserving page space
 * the block does not use; the render site applies the SAME value as its DOM
 * `min-height`, so the estimate and the real box agree.
 *
 * Exported so the render site cannot drift from the planner.
 */
export function sectionItemMinHeight(item) {
  if (!item) return SECTION_TEXT_BLOCK_MIN_PX;
  if (item.kind === SECTION_ITEM_KIND.TEXT) return SECTION_TEXT_BLOCK_MIN_PX;
  return item.kind === SECTION_ITEM_KIND.FILE
    ? ATTACHMENT_BLOCK_MIN_PX.file
    : ATTACHMENT_BLOCK_MIN_PX.photo;
}

/**
 * Plan the ordered document blocks for ONE row.
 *
 * Five shapes come out of this, and the first is the one that matters most for
 * not regressing anything:
 *
 *  1. An ordinary row with NO evidence and NO section content produces exactly
 *     ONE block, with no `group` and no `keepWithNext` — byte-for-byte the
 *     block the table emitted before either collection existed. Such a note
 *     paginates identically.
 *
 *  2. An ordinary row WITH evidence becomes a compound field: the row block is
 *     the head (keeping its answer control), followed by one atomic block per
 *     evidence item, all sharing the row's `group` so the existing continuation
 *     context ("Label — continued") applies when the row resumes on a new page.
 *     `keepWithNext` stops the answer being orphaned at a page bottom.
 *
 *  3. A Photo/File field keeps its existing head + primary attachment blocks,
 *     and any historical evidence is appended AFTER them in the same group —
 *     two distinct collections, in one row, never merged into one array.
 *
 *  4. A TEXT (or note-specific custom) row WITH section content hands its body
 *     to the ordered list: one block per item, in stored order, the first
 *     carrying the row label as the head. `answers[rowId]` and `evidence[rowId]`
 *     are not rendered as well. Such a row is CONTENT-DRIVEN: every block's
 *     height hint comes from its own item kind, so a short paragraph followed by
 *     a photo stacks tightly. A single text item reproduces shape 1's structure
 *     — one block, no group, no keepWithNext — but sizes itself to its text
 *     rather than to the legacy `row.px`.
 *
 *  5. A STRUCTURED row, or a legacy Photo/File field, WITH section content keeps
 *     its own primary block(s) first and appends the ordered items after them,
 *     in the same group. Its `evidence` is not rendered as well.
 *
 * @param row               the render row ({ id, label, px, type, isCustom })
 * @param isAttachmentField whether the row's CURRENT pinned type is Photo/File
 *                          AND attachment rendering is enabled (note mode)
 * @param attachments       the instance's raw attachments map
 * @param evidence          the instance's raw evidence map
 * @param sectionContent    the instance's raw sectionContent map
 * @param sectionExtraHeight the instance's raw sectionExtraHeight map — the
 *                          OPTIONAL extra working space the user has dragged
 *                          onto the bottom of a flexible section. Absent for
 *                          every section nobody has resized, which is the
 *                          default and the whole point.
 */
export function planRowBlocks({
  row,
  isAttachmentField = false,
  attachments = null,
  evidence = null,
  sectionContent = null,
  sectionExtraHeight = null,
} = {}) {
  if (!row || !row.id) return [];

  const rowId = row.id;
  const sectionItems = rowSectionItems(sectionContent, rowId);
  const hasSection = sectionItems.length > 0;
  // AUTHORITY: ordered section content replaces the row's legacy evidence, so
  // material a later phase materialises into the ordered list can never appear
  // twice. Nothing is deleted — `evidence[rowId]` stays in storage untouched.
  const evidenceItems = hasSection ? [] : rowEvidenceItems(evidence, rowId);
  const attachmentItems = isAttachmentField
    ? rowAttachmentItems(attachments, rowId)
    : [];

  // Does the row still emit a primary block of its own above the ordered items?
  // Only a Text row hands its whole body over; every other type keeps its typed
  // value or its primary attachments first.
  const sectionOwnsRowHead =
    hasSection &&
    !isAttachmentField &&
    !STRUCTURED_FIELD_TYPES.has(normalizeType(row.type));

  // A row is compound when it emits more than one block.
  const blockCount =
    (isAttachmentField ? 1 + attachmentItems.length : sectionOwnsRowHead ? 0 : 1) +
    sectionItems.length +
    evidenceItems.length;
  const isCompound = isAttachmentField || blockCount > 1;
  const group = isCompound ? rowId : null;

  const blocks = [];

  if (isAttachmentField) {
    blocks.push({
      kind: ROW_BLOCK_KIND.ATTACHMENT_HEAD,
      id: rowId,
      rowId,
      group,
      // The head stays with the first attachment OR, when the field is empty,
      // with the first section item or evidence item — a heading is never left
      // alone.
      keepWithNext:
        attachmentItems.length + sectionItems.length + evidenceItems.length > 0,
      minHeight: Math.max(56, row.px || 56),
      splittable: false,
      attachmentCount: attachmentItems.length,
    });

    attachmentItems.forEach((item) => {
      blocks.push({
        kind: ROW_BLOCK_KIND.ATTACHMENT,
        id: `${rowId}::att-${
          typeof item.norm === "string" ? `legacy-${item.index}` : item.norm.id
        }`,
        rowId,
        group,
        keepWithNext: false,
        minHeight: attachmentMinHeight(item.norm),
        splittable: false,
        item,
      });
    });
  } else if (!sectionOwnsRowHead) {
    blocks.push({
      kind: ROW_BLOCK_KIND.ROW,
      id: rowId,
      rowId,
      group,
      keepWithNext: evidenceItems.length + sectionItems.length > 0,
      minHeight: row.px || 120,
      // The editable Text answer is deliberately not sliced across pages in
      // this phase — unchanged behaviour.
      splittable: false,
    });
  }

  // The user's optional extra working space, and WHICH block carries it.
  //
  // It belongs to the LOGICAL SECTION, so it is attached to that section's LAST
  // block rather than being spread across every item. Three things follow, and
  // all three are the reason for doing it this way:
  //
  //   - every other item keeps its own content height, so text, photo and text
  //     stay independently pageable and no item gains a hidden reserve;
  //   - if the section is split across pages the extra lands with the block that
  //     ends the section — on the LAST page it occupies — so a continuation
  //     fragment never carries it and never becomes independently resizeable;
  //   - it is added to a MINIMUM, not imposed as a height, so content can only
  //     ever make the block taller. Nothing can be clipped.
  //
  // Only a flexible section has one: a structured row and a legacy Photo/File
  // field keep their own primary control and their existing `row.px`.
  const sectionExtraPx = sectionOwnsRowHead
    ? sectionExtraHeightFor(sectionExtraHeight, rowId)
    : 0;
  const sectionTailIndex = sectionItems.length - 1;

  sectionItems.forEach((item, position) => {
    // The head item stands in for the row block: it is the block that renders
    // the label and the row actions. It does NOT inherit the row's preferred
    // height — see the minHeight note below.
    const isRowHead = sectionOwnsRowHead && position === 0;
    // The end of the LOGICAL section: the block that carries the extra space
    // and the one resize affordance. In a single-item section that is the head
    // itself.
    const isSectionTail = sectionOwnsRowHead && position === sectionTailIndex;
    blocks.push({
      kind: ROW_BLOCK_KIND.SECTION_ITEM,
      // The HEAD item keeps the ROW's own block id, because it IS the row block
      // — it renders the label, the actions and the height handle, and it is
      // what the plain `ROW` block was a moment before the row materialised.
      // The block id is PagedDocument's React key and its measurement key, so
      // holding it steady is what lets a row become a section WHILE THE USER IS
      // TYPING without the editor being torn down and rebuilt underneath them.
      // It cannot collide: a row emits a head item only when it emits neither a
      // `ROW` block nor an `ATTACHMENT_HEAD`.
      //
      // Every item after it is namespaced apart from `::att-` and `::ev-`, so
      // an ordered item can never collide with a primary attachment or an
      // evidence item (they would otherwise share one measurement entry and one
      // React key).
      id: isRowHead ? rowId : `${rowId}::sec-${item.id}`,
      rowId,
      group,
      // A head is never orphaned from the item that follows it; every ordered
      // item after that is atomic and stands on its own.
      keepWithNext: isRowHead && sectionItems.length > 1,
      // CONTENT-DRIVEN, head included. The row's own `px` is deliberately NOT a
      // floor here: once a row's body is authoritative section content, the
      // legacy whole-row height would reserve a blank area above the first
      // photo or file and would make pagination reserve page space the block
      // does not use. `row.px` still governs every row whose body is its own
      // answer control — a legacy Text row, a structured row, a Photo/File
      // field — which is where the user actually dragged it.
      minHeight:
        sectionItemMinHeight(item) + (isSectionTail ? sectionExtraPx : 0),
      // A photo or a file moves whole to the next page. A text item is not
      // sliced either — the same restraint the editable Text answer already has.
      splittable: false,
      sectionItem: item,
      isRowHead,
      isSectionTail,
      // Descriptive, for the render site: how much blank working space to draw
      // after this block's content, and therefore what a drag starts from.
      sectionExtraPx: isSectionTail ? sectionExtraPx : 0,
    });
  });

  evidenceItems.forEach((item, position) => {
    blocks.push({
      kind: ROW_BLOCK_KIND.EVIDENCE,
      // Namespaced separately from `::att-`, so a primary attachment and an
      // evidence item can never collide on a block id (they would otherwise
      // share one measurement entry and one React key).
      id: `${rowId}::ev-${item.norm.id}`,
      rowId,
      group,
      keepWithNext: false,
      minHeight: attachmentMinHeight(item.norm),
      splittable: false,
      item,
      // The only disambiguation offered, and only when it is genuinely needed:
      // a Photo/File field showing its own primary attachments AND historical
      // evidence would otherwise present two collections as one list. A row
      // whose evidence is its only attachment content needs no label at all.
      showEvidenceLabel: position === 0 && attachmentItems.length > 0,
    });
  });

  return blocks;
}
