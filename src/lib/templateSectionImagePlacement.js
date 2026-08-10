// src/lib/templateSectionImagePlacement.js
//
// WHERE A NEW SECTION IMAGE GOES, AND HOW BIG IT ARRIVES.
//
// A flexible Template section is a document body, not an evidence tray. A
// reader who receives, prints or exports the finished note must be able to
// understand the image FROM THE DOCUMENT — "Open larger" is optional
// convenience, never the only way to see what was photographed. Two defaults
// follow from that, and both are decided here, once:
//
//   1. a new image lands where a person would have put it — right after the
//      sentence it illustrates, not at the bottom of everything;
//   2. it arrives at the full width of the section's own content column, not as
//      a thumbnail somebody has to click.
//
// ---------------------------------------------------------------------------
// THE PLACEMENT RULE
// ---------------------------------------------------------------------------
//
//   - if the section already holds a MEANINGFUL text item, the image is
//     inserted immediately AFTER THE FIRST one;
//   - if it holds no meaningful text at all, the image goes to the TOP.
//
// "Meaningful" is deliberately NOT a sentence detector. No punctuation is
// parsed, no language is assumed and no attempt is made to find a full stop: a
// text item is meaningful when it has any text in it at all
// (`isEmptyAnswerValue` — the same emptiness test the rest of the answer model
// uses). "The first sentence" in the product requirement means "the first
// meaningful block of content", and that is exactly what this asks.
//
// An EMPTY text item is not an anchor, but it is not in the way either. A
// section whose only content is the empty item that keeps it typeable puts the
// image at the top, ABOVE that item — the image is the first thing on the page,
// with no blank band reserved above it, and the empty item remains below as the
// place to type. Nothing is deleted to achieve that.
//
// ---------------------------------------------------------------------------
// WHY THE ANCHOR SKIPS A RUN OF MEDIA THAT IS ALREADY THERE
// ---------------------------------------------------------------------------
//
// A literal reading of "immediately after the first meaningful text item" puts
// EVERY new image at the same index, so a Quick Add composition holding three
// photos would store them in reverse order — the staged order Quick Add
// promises would be silently inverted, and the user would have to reorder by
// hand what they had just captured in sequence.
//
// So the anchor moves forward over the photo/file items ALREADY sitting
// directly after that first paragraph, and the new image joins the end of that
// run. The band of media that follows the opening paragraph stays one band, in
// capture order. For the common case — a paragraph with nothing after it yet —
// the two readings are identical, and the image lands immediately after the
// text exactly as specified.
//
// Only VISIBLE photo/file items are skipped. An entry this version cannot
// render is not skipped over, because it cannot be reasoned about; it keeps its
// place, and the insertion happens in front of it.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT DECIDE
// ---------------------------------------------------------------------------
//
//   - A STRUCTURED row's typed control (Date, Number, Select, …) and a legacy
//     Photo/File field's primary attachment are NOT part of `sectionContent` at
//     all — they live in `answers[rowId]` / `attachments[rowId]` and the planner
//     renders them before any section item. So "the top of sectionContent" is
//     already "directly after the fixed primary control", with nothing to
//     special-case here: this module cannot move an image above a primary
//     control because it cannot see one.
//   - `sectionExtraHeight` is NOT content. It is trailing working space attached
//     to the section's tail block and derived from array order, so a new image
//     is never placed "after the blank area" — placement is decided from the
//     item list alone, which this module is the only input to.
//
// Pure: no React, no DOM, no storage.

import { ATTACHMENT_KIND } from "./noteAttachments";
import { isEmptyAnswerValue } from "./templateRichText";
import { SECTION_ITEM_KIND, normalizeSectionItem } from "./templateSectionContent";

/**
 * The width a NEWLY INSERTED section photo is created at: 100% of the section's
 * own right-hand content column (never the whole physical page — the label
 * column is outside it).
 *
 * Set EXPLICITLY at creation time rather than by changing any global default.
 * `DEFAULT_PHOTO_WIDTH_PCT` still governs a photo whose stored `display` says
 * nothing, so every photo already persisted keeps exactly the width it has:
 * nothing is migrated, nothing is silently enlarged.
 */
export const NEW_SECTION_PHOTO_WIDTH_PCT = 100;

function rawList(list) {
  return Array.isArray(list) ? list : [];
}

/** A visible photo or file item — the two kinds that form a media run. */
function isVisibleMedia(item) {
  return (
    !!item &&
    (item.kind === ATTACHMENT_KIND.PHOTO || item.kind === ATTACHMENT_KIND.FILE)
  );
}

/**
 * The index in the RAW stored list at which a new photo should be inserted.
 *
 * Raw, because that is what a writer mutates: entries this version cannot
 * render still occupy real stored positions and must keep them.
 */
export function sectionPhotoInsertIndex(list) {
  const entries = rawList(list);

  // The anchor: just past the first meaningful text item, or the very top.
  let index = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const item = normalizeSectionItem(entries[i]);
    if (!item) continue;
    if (item.kind === SECTION_ITEM_KIND.TEXT && !isEmptyAnswerValue(item.value)) {
      index = i + 1;
      break;
    }
  }

  // Join the END of the media run already sitting at the anchor, so a sequence
  // of captures keeps the order it was captured in.
  while (index < entries.length && isVisibleMedia(normalizeSectionItem(entries[index]))) {
    index += 1;
  }

  return index;
}

/**
 * One row's next stored list with `photo` placed by the rule above, preceded by
 * `leading` when this very write is materialising the row.
 *
 * `leading` is appended to the stored list FIRST and the placement is then
 * decided over the whole composed body, because that composed body IS the
 * section's content order after this write: a legacy row's carried answer is
 * the first meaningful text item the moment it exists, and the new image
 * belongs after it.
 *
 * Every existing entry is carried by REFERENCE — nothing is rebuilt, nothing is
 * normalized on the way through and nothing is dropped. An entry too malformed
 * for this version to render survives untouched, and its relative order with
 * respect to every other entry is preserved.
 */
export function sectionListWithNewPhoto(list, photo, leading = []) {
  const base = [...rawList(list), ...(Array.isArray(leading) ? leading : [])];
  const at = sectionPhotoInsertIndex(base);
  return [...base.slice(0, at), photo, ...base.slice(at)];
}
