// src/lib/templateSectionLeadingText.js
//
// TYPING ABOVE A SECTION'S FIRST IMAGE.
//
// A new image dropped into a section with no meaningful text is placed FIRST,
// deliberately: an image-only section must look compact, with no blank band
// reserved above the picture for text nobody has written (handoff §13.3). The
// empty text item that keeps such a section typeable sits BELOW the image.
//
// The cost of that — and the defect this module closes — is that there was then
// nowhere to type ABOVE the image. In a word processor you click at the top-left
// of the content area, get a caret and type; the picture moves down as the text
// grows. Nothing in the ordered model prevented that; there was simply no text
// item there, and no way to ask for one.
//
// ---------------------------------------------------------------------------
// THE LEADING CARET IS VIRTUAL UNTIL IT IS TYPED INTO
// ---------------------------------------------------------------------------
//
// Clicking the leading insertion point writes NOTHING. It mints an item id in
// memory, opens the one Template editor against it, and stops there. The stored
// list is only touched by the first real change, and then it gains exactly ONE
// item:
//
//     [ Photo, TextItem("") ]                       before
//     [ TextItem("Hello"), Photo, TextItem("") ]    after the first keystroke
//
// Two things follow, and both are the reason for doing it this way:
//
//   - a click that types nothing leaves the section exactly as it was. There is
//     no permanent blank band, no orphaned empty paragraph, and focusing a
//     section still never produces a write (handoff §3.7);
//   - no DUPLICATE empty text item is ever created. The empty item below the
//     image is not moved, adopted or re-created: it is left exactly where it is,
//     because it is what keeps the space BELOW the image typeable, and the item
//     written above is the one the user actually typed into.
//
// The id is minted at click time rather than at write time on purpose: it is the
// editor's identity for the whole gesture, so the editor is NOT torn down and
// rebuilt between the first keystroke and the second, and it keeps its focus,
// its caret and its undo history across the write.
//
// The image then moves down through ORDINARY DOCUMENT FLOW. It is one block
// after another in the same ordered list; nothing is absolutely positioned,
// nothing reserves height, and `sectionExtraHeight` — the explicit trailing
// working space — is not involved at any point.
//
// Pure: no React, no DOM, no storage.

import { isAnswerValue } from "./templateRichText";
import { SECTION_ITEM_KIND, normalizeSectionItem } from "./templateSectionContent";

/**
 * Does this section BEGIN with something that cannot be typed into?
 *
 * That is exactly when a leading insertion point is offered — and only then. A
 * section whose first visible item is already text needs none: the user clicks
 * that text and types. A section with nothing visible in it at all needs none
 * either; it renders its own empty answer cell.
 *
 * Asked of the RAW stored list through the render model, so "the first item" is
 * the first item the user can actually SEE.
 */
export function sectionStartsWithMedia(items) {
  if (!Array.isArray(items)) return false;
  for (const entry of items) {
    const item = normalizeSectionItem(entry);
    if (item === null) continue;
    return item.kind !== SECTION_ITEM_KIND.TEXT;
  }
  return false;
}

/**
 * One row's stored list with a text item inserted at the very FRONT, or null —
 * "write nothing".
 *
 * Null covers the cases that must be refused rather than approximated:
 *   - an id or a value that could not make a text item (the id must be the one
 *     the caret was opened with: a text item has no read-time id fallback);
 *   - an id already in the list, which would give two items one identity.
 *
 * Everything already stored is passed through BY REFERENCE in its existing
 * order — including entries this version cannot render, which keep their
 * relative position and go on protecting whatever asset they may name. The
 * empty text item that a media-headed section keeps below its image is one of
 * those pass-throughs: it is deliberately neither moved nor removed, because it
 * is what keeps the space below the image typeable.
 */
export function sectionListWithLeadingText({ items, itemId, value } = {}) {
  const raw = Array.isArray(items) ? items : [];
  if (typeof itemId !== "string" || !itemId) return null;
  if (!isAnswerValue(value)) return null;
  for (const entry of raw) {
    if (entry && typeof entry === "object" && entry.id === itemId) return null;
  }
  return [{ id: itemId, kind: SECTION_ITEM_KIND.TEXT, value }, ...raw];
}
