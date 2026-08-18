// src/lib/templateSectionEditing.js
//
// What SURVIVES of the legacy `sectionContent` write model after Phase G — the
// three rules other modules still need about a row's ORDERED ITEM LIST, none of
// which creates or edits one.
//
// Until Phase G this module was the write-side twin of
// src/lib/templateSectionContent.js: it said how a row's `sectionContent[rowId]`
// list was first CREATED (materialisation) and how one text item inside it was
// replaced. That interaction no longer exists. A flexible Template Section is
// ONE shared ProseMirror document, its first genuine edit writes
// `sectionDoc[rowId]` (src/lib/templateSectionDoc.js), and every historical
// `sectionContent` list is FROZEN: still read (through the adapter,
// src/lib/templateSectionDocAdapter.js), still exported, still protecting its
// assets — but never written to again. `materializeRowSectionItems`,
// `makeTextSectionItem`, `updateTextSectionItemValue`, `setRowSectionItems`,
// `findTextSectionItemIndex` and `rowHasSectionContent` were deleted with the
// writers that called them.
//
// What remains, and why each is a READER or a DELETION-ONLY step:
//
//   carryableEvidenceItems   the carry gate the READ ADAPTER applies to a
//                            legacy row's `evidence[rowId]` when it presents
//                            that row as one document. It decides what a
//                            historical evidence entry can safely become in the
//                            document — the same rule materialisation used, so
//                            a row adapted today holds exactly the body a row
//                            materialised in an earlier build holds.
//   removeRowSectionContent  a `sectionContent` map with ONE row's frozen list
//                            REMOVED — used only when a note-specific custom
//                            row is deleted, so a list keyed by a row that can
//                            never be rendered again does not outlive it.
//   sectionContentAssetIds   the asset ids that frozen list named, so the
//                            deletion of that row can offer them to the global
//                            deletion gate (which still decides).
//
// FROZEN LEGACY COPIES. Nothing here clears `answers[rowId]`,
// `customRows[].answer` or `evidence[rowId]`: a row's older representations stop
// being rendered because something outranks them, never because they were
// destroyed. `isAttachmentAssetReferenced` still scans `attachments`, `evidence`,
// `sectionContent` AND `sectionDoc`, so a Blob named by any copy is protected.
//
// WHAT IS NOT CARRIED into a document body, and why:
//   - a legacy base64 data-URL STRING. `sectionContent` was created long after
//     the attachment-reference model; a string there is foreign data, and the
//     legacy base64 compatibility path belongs to `attachments`, untouched.
//   - an entry with a missing, unknown or merely similar-looking `kind`, or one
//     `normalizeSectionItem` cannot use. A section item's kind is a strict
//     discriminator; guessing would render somebody's report content as
//     something it is not.
//   - an entry carrying `kind: "text"`. Whatever that is, it is not evidence,
//     and copying it as a text item would silently drop its asset reference.
// Such an entry stays exactly where it is, in the frozen `evidence[rowId]`, is
// reported by the adapter as `skipped`, and keeps rendering through the
// compatibility path (see src/lib/templateSectionBody.js).
//
// Pure: no React, no DOM, no storage.

import { ATTACHMENT_KIND } from "./noteAttachments";
import { isTextSectionItem, normalizeSectionItem } from "./templateSectionContent";

/**
 * The entries of one raw stored `evidence[rowId]` array that may be carried
 * into a Section document, copied VERBATIM and in their stored order.
 *
 * "Verbatim" is the whole point: the copy reuses the entry's existing
 * attachment id, asset id and display metadata, so the document and the frozen
 * evidence name one Blob rather than two. Each entry is shallow-copied so the
 * two never share a mutable object.
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

/** A `sectionContent` map with ONE row's frozen list removed. Other rows untouched. */
export function removeRowSectionContent(map, rowId) {
  const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (typeof rowId !== "string" || !rowId || !(rowId in base)) return base;
  const next = { ...base };
  delete next[rowId];
  return next;
}

/**
 * Every asset id referenced by one row's raw stored list, in stored order.
 *
 * Used when a note-specific custom row is deleted: its frozen ordered content
 * goes with it, so those assets become deletion CANDIDATES. They are still only
 * deleted once `isAttachmentAssetReferenced` proves nothing else names them —
 * the frozen `evidence` copy and the modern `sectionDoc` of the same row are
 * removed in the same save, but a genuinely shared asset must survive.
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
