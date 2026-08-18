// src/lib/templateRowContent.js
//
// WHICH document blocks one Template row produces, and in what order.
//
// Named for what it decides: a row's CONTENT PLAN. It owns four things, and
// evidence is only the smallest of them —
//
//   1. ROW AUTHORITY      — which collection is a row's body
//                           (`sectionReplacesRowAnswer`)
//   2. BLOCK PLANNING     — the ordered, atomic, pageable blocks of one row
//                           (`planRowBlocks`) and their height hints
//   3. SECTION BODY PLAN  — one block per segment of the unified Section
//                           document (or ONE editor block while it is active);
//                           the first standing in for the row itself
//   4. LEGACY ORDERING    — a structured primary value, or a legacy Photo/File
//                           primary, first; legacy `evidence` last
//
// (It was called `templateRowEvidence.js` while `evidence` was the only extra
// collection a row could have. Renamed in Phase 10 — same behaviour, same
// exports.)
//
// A completed note has THREE distinct per-row collections on its
// NoteTemplateInstance, and they are never merged into one array:
//
//   attachments[rowId]     the PRIMARY value of a Photo/File field
//   evidence[rowId]        LEGACY supporting evidence for any row — READ-ONLY
//                          compatibility storage; nothing creates new entries
//   sectionContent[rowId]  the ORDERED body of a flexible section, and the
//                          authoritative one wherever it exists
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
// A SECTION DOCUMENT IS AUTHORITATIVE WHEN IT EXISTS
// ---------------------------------------------------------------------------
//
// A flexible Section's body is ONE ordered document (src/lib/templateSectionDoc.js
// — the modern `sectionDoc[rowId]`, or the historical `sectionContent[rowId]`
// list / legacy answer+evidence ADAPTED into one by the canonical reader,
// src/lib/templateSectionBody.js). The caller hands this planner that body's
// LAYOUT SEGMENTS (src/lib/templateSectionDocSegments.js) — or ONE editor
// segment while the Section is being edited — and the row plans one block per
// segment. When it does, the row's legacy `evidence` is NOT rendered as well:
// the document already carries what the adapter could carry, and rendering
// both would show the same material twice. The choice is made once, here.
//
// What a Section document does NOT displace is the row's own PRIMARY value:
//
//   - a structured row (number/date/time/checkbox/yes-no/dropdown) keeps its
//     typed control over `answers[rowId]` first, then the document segments;
//   - a legacy Photo/File field keeps its `attachments[rowId]` first, then the
//     document segments.
//
// Only a Text row (and a note-specific custom row, which is Text by
// definition) hands its whole body over: its first segment becomes the row
// head and carries the label, so `answers[rowId]` is not rendered as well. The
// stored answer is left exactly where it is — this is a read-time choice, never
// a migration.
//
// A row with no document segments plans EXACTLY the blocks it always did.
//
// PHASE G. Until Phase G this planner also carried a SECOND plan for the same
// body — `SECTION_ITEM`, one block per raw `sectionContent` item, which the
// legacy per-item interaction rendered and addressed while it owned a row. That
// interaction is retired (the shared Section editor is the only one), so the
// item plan, `rowSectionItems`, `hasRowSectionContent`, `sectionItemMinHeight`
// and the raw `sectionContent` parameter were deleted with it. The segment
// projection still puts an adapted body's boundaries back on its stored items,
// so a historical note paginates exactly as it did.
//
// Pure: no React, no DOM, no storage.

import { normalizeAttachment, ATTACHMENT_KIND } from "./noteAttachments";
import { SECTION_ITEM_KIND } from "./templateSectionContent";
import { sectionExtraHeightFor } from "./templateSectionHeight";
import { FIELD_TYPE, normalizeType } from "./templateFields";
import {
  SECTION_SEGMENT_KIND,
  compatSegmentItemKind,
} from "./templateSectionDocSegments";

export const ROW_BLOCK_KIND = {
  // An ordinary row: label + the type-appropriate answer control.
  ROW: "row",
  // The head of a compound Photo/File field: label + upload control + errors.
  ATTACHMENT_HEAD: "attachment-head",
  // One atomic block per PRIMARY Photo/File attachment.
  ATTACHMENT: "attachment",
  // One atomic block per SUPPORTING evidence item (a row with no document
  // body only).
  EVIDENCE: "evidence",
  // One block per SEGMENT of a row's unified Section DOCUMENT body, planned
  // from the canonical body reader. The first one carries the row label
  // (`isRowHead`) when the row has no primary block of its own. An ACTIVE
  // Section plans as ONE such block (the editor segment). See planRowBlocks.
  SECTION_SEGMENT: "section-segment",
};

// Preferred/minimum heights for an atomic attachment block. These are hints for
// the first paint only — PagedDocument measures the real rendered height — and
// they match the values the compound Photo/File field already used, so adding
// evidence cannot change where an existing Photo/File field paginates.
export const ATTACHMENT_BLOCK_MIN_PX = { photo: 60, file: 36 };

// First-paint hint for a Section document's TEXT run.
//
// It applies to EVERY text run including the head, because a flexible section
// is content-driven: its height comes from what is actually in it, never from
// the legacy whole-row height. See sectionSegmentMinHeight.
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
 * Does ordered section content REPLACE this row's own answer control?
 *
 * The one statement of the authority rule §3.4 describes, so the on-screen
 * planner below and the export model (src/lib/templateExportModel.js) can never
 * disagree about which rows hand their whole body to `sectionContent`:
 *
 *   - a Text row, and a note-specific custom row (Text by definition), hand it
 *     over — their first ordered item becomes the row head and carries the
 *     label, and `answers[rowId]` is not rendered as well;
 *   - a structured row keeps its typed control over `answers[rowId]` first;
 *   - a legacy Photo/File field keeps its `attachments[rowId]` first.
 *
 * Says nothing about whether the row HAS any section content — that is the
 * caller's question, and both callers ask it of the same read model.
 *
 * @param rowType           the row's normalized-or-raw stored type
 * @param isAttachmentField whether the row is a legacy Photo/File field whose
 *                          primary attachments are being rendered
 */
export function sectionReplacesRowAnswer(rowType, isAttachmentField = false) {
  if (isAttachmentField) return false;
  return !STRUCTURED_FIELD_TYPES.has(normalizeType(rowType));
}

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

function attachmentMinHeight(norm) {
  const kind = typeof norm === "string" ? ATTACHMENT_KIND.PHOTO : norm.kind;
  return kind === ATTACHMENT_KIND.FILE
    ? ATTACHMENT_BLOCK_MIN_PX.file
    : ATTACHMENT_BLOCK_MIN_PX.photo;
}

/**
 * The first-paint height HINT for one SEGMENT of a unified Section document,
 * decided by WHAT THE SEGMENT RENDERS and by nothing else: a run of prose is
 * one line's height, an image is a photo's, a file is a file's, and a
 * compatibility segment is whatever the stored item it stands in for would
 * have been.
 *
 * This is what makes a flexible section content-driven. It is deliberately
 * used for the head segment too: a section's height is the sum of what is in
 * it, so a short paragraph followed by a photo stacks tightly instead of
 * reserving the legacy whole-row height above the photo.
 *
 * It is only ever a HINT. `resolveBlockHeight` takes
 * `max(preferred, measured)`, and PagedDocument measures the real rendered
 * height, so the number below governs the first paint and the floor — never the
 * final layout. Keeping it small is what stops pagination reserving page space
 * the block does not use; the render site applies the SAME value as its DOM
 * `min-height`, so the estimate and the real box agree. Exported so the render
 * site cannot drift from the planner.
 *
 * A WRAPPED image carries the prose beside it in the same segment; its hint
 * stays the image's, which is the taller of the two and, like every hint here,
 * only ever a floor that measurement replaces.
 */
export function sectionSegmentMinHeight(segment) {
  if (!segment) return SECTION_TEXT_BLOCK_MIN_PX;
  switch (segment.kind) {
    // The whole body as one live editor. Its height is entirely what the user
    // has typed, so the floor is a single line of prose exactly as it is for a
    // text run — PagedDocument measures the rest. The one exception is a row
    // still on its LEGACY answer, which keeps the height the user dragged for
    // it (the caller supplies it) so that activating the Section cannot make
    // the row jump.
    case SECTION_SEGMENT_KIND.EDITOR:
      return Number(segment.minHeightPx) > 0
        ? Math.max(SECTION_TEXT_BLOCK_MIN_PX, Math.round(Number(segment.minHeightPx)))
        : SECTION_TEXT_BLOCK_MIN_PX;
    case SECTION_SEGMENT_KIND.IMAGE:
      return ATTACHMENT_BLOCK_MIN_PX.photo;
    case SECTION_SEGMENT_KIND.FILE:
      return ATTACHMENT_BLOCK_MIN_PX.file;
    case SECTION_SEGMENT_KIND.COMPAT:
      return compatSegmentItemKind(segment) === SECTION_ITEM_KIND.FILE
        ? ATTACHMENT_BLOCK_MIN_PX.file
        : ATTACHMENT_BLOCK_MIN_PX.photo;
    default:
      return SECTION_TEXT_BLOCK_MIN_PX;
  }
}

/**
 * Plan the ordered document blocks for ONE row.
 *
 * Five shapes come out of this, and the first is the one that matters most for
 * not regressing anything:
 *
 *  1. An ordinary row with NO evidence and NO document body produces exactly
 *     ONE block, with no `group` and no `keepWithNext` — byte-for-byte the
 *     block the table emitted before either collection existed. Such a note
 *     paginates identically.
 *
 *  2. An ordinary row WITH legacy evidence and no document body becomes a
 *     compound field: the row block is the head (keeping its answer control),
 *     followed by one atomic block per evidence item, all sharing the row's
 *     `group` so the existing continuation context ("Label — continued")
 *     applies when the row resumes on a new page. `keepWithNext` stops the
 *     answer being orphaned at a page bottom.
 *
 *  3. A Photo/File field keeps its existing head + primary attachment blocks,
 *     and any historical evidence is appended AFTER them in the same group —
 *     two distinct collections, in one row, never merged into one array.
 *
 *  4. A TEXT (or note-specific custom) row WITH a document body hands its
 *     body to the document: one block per segment, in document order, the
 *     first carrying the row label as the head. `answers[rowId]` and
 *     `evidence[rowId]` are not rendered as well. Such a row is
 *     CONTENT-DRIVEN: every block's height hint comes from its own segment
 *     kind, so a short paragraph followed by a photo stacks tightly. A single
 *     text run reproduces shape 1's structure — one block, no group, no
 *     keepWithNext — but sizes itself to its text rather than to the legacy
 *     `row.px`.
 *
 *  5. A STRUCTURED row, or a legacy Photo/File field, WITH a document body
 *     keeps its own primary block(s) first and appends the segments after
 *     them, in the same group. Its `evidence` is not rendered as well.
 *
 * @param row               the render row ({ id, label, px, type, isCustom })
 * @param isAttachmentField whether the row's CURRENT pinned type is Photo/File
 *                          AND attachment rendering is enabled (note mode)
 * @param attachments       the instance's raw attachments map
 * @param evidence          the instance's raw evidence map
 * @param sectionSegments   the LAYOUT SEGMENTS of this row's unified Section
 *                          document body (or the ONE editor segment while it
 *                          is active). Null / empty means the row has no
 *                          document body and plans exactly as it always has.
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
  sectionExtraHeight = null,
  sectionSegments = null,
} = {}) {
  if (!row || !row.id) return [];

  const rowId = row.id;
  // `sectionSegments` are the segments of a body already resolved by the
  // canonical reader (src/lib/templateSectionBody.js) and projected for layout
  // (src/lib/templateSectionDocSegments.js). Nothing about which representation
  // is authoritative is decided here: that question belongs to the reader, and
  // this parameter is the caller's answer to it.
  const sectionUnits = Array.isArray(sectionSegments) ? sectionSegments : [];
  const hasSection = sectionUnits.length > 0;
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
    hasSection && sectionReplacesRowAnswer(row.type, isAttachmentField);

  // A row is compound when it emits more than one block.
  const blockCount =
    (isAttachmentField ? 1 + attachmentItems.length : sectionOwnsRowHead ? 0 : 1) +
    sectionUnits.length +
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
        attachmentItems.length + sectionUnits.length + evidenceItems.length > 0,
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
      keepWithNext: evidenceItems.length + sectionUnits.length > 0,
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
  const sectionTailIndex = sectionUnits.length - 1;

  sectionUnits.forEach((segment, position) => {
    // The head segment stands in for the row block: it is the block that
    // renders the label and the row actions. It does NOT inherit the row's
    // preferred height — see the minHeight note below.
    const isRowHead = sectionOwnsRowHead && position === 0;
    // The end of the LOGICAL section: the block that carries the extra space
    // and the one resize affordance. In a single-item section that is the head
    // itself.
    const isSectionTail = sectionOwnsRowHead && position === sectionTailIndex;
    blocks.push({
      kind: ROW_BLOCK_KIND.SECTION_SEGMENT,
      // The HEAD segment keeps the ROW's own block id, because it IS the row
      // block — it renders the label, the actions and the height handle, and
      // it is what the plain `ROW` block was a moment before the row's first
      // edit. The block id is PagedDocument's React key and its measurement
      // key, so holding it steady is what lets a row become a document Section
      // WHILE THE USER IS TYPING without the editor being torn down and rebuilt
      // underneath them. It cannot collide: a row emits a head segment only
      // when it emits neither a `ROW` block nor an `ATTACHMENT_HEAD`.
      //
      // Every segment after it is namespaced apart from `::att-` and `::ev-`,
      // so a segment can never collide with a primary attachment or an
      // evidence item (they would otherwise share one measurement entry and one
      // React key).
      id: isRowHead ? rowId : `${rowId}::sec-${segment.key}`,
      rowId,
      group,
      // A head is never orphaned from the item that follows it; every ordered
      // item after that is atomic and stands on its own.
      keepWithNext: isRowHead && sectionUnits.length > 1,
      // CONTENT-DRIVEN, head included. The row's own `px` is deliberately NOT a
      // floor here: once a row's body is authoritative section content, the
      // legacy whole-row height would reserve a blank area above the first
      // photo or file and would make pagination reserve page space the block
      // does not use. `row.px` still governs every row whose body is its own
      // answer control — a legacy Text row, a structured row, a Photo/File
      // field — which is where the user actually dragged it.
      minHeight: sectionSegmentMinHeight(segment) + (isSectionTail ? sectionExtraPx : 0),
      // A photo or a file moves whole to the next page. A text run is not
      // sliced either — the same restraint the editable Text answer already has.
      splittable: false,
      sectionSegment: segment,
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
