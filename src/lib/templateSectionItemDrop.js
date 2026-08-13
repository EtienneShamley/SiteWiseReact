// src/lib/templateSectionItemDrop.js
//
// WHERE WOULD THIS IMAGE LAND? — the destination rule for a section image drag.
//
// The gesture is: press the image body, move past the threshold, and the image
// follows the pointer while an insertion line shows where it would go
// (src/lib/templateSectionImageMove.js). THIS module answers the question in the
// middle: given a point on the screen, what is the destination — if any?
//
// It lives here rather than inside the renderer for the reason
// src/lib/templateSectionTextPoint.js does: the DOCUMENT IS A PARAMETER, so the
// whole resolution — hit-test, same-section check, text vs before/after, and the
// "would this actually move anything?" gate — is testable without a browser.
//
// ---------------------------------------------------------------------------
// EVERY VISIBLE ITEM IS A FULL-HEIGHT TARGET
// ---------------------------------------------------------------------------
//
// The base rule is deliberately the simplest one that can work, and it applies
// to every item kind equally:
//
//   pointer in the item's UPPER half   ->  BEFORE it
//   pointer in the item's LOWER half   ->  AFTER it
//
// A precise mid-paragraph split is an ENHANCEMENT layered on top of that, for
// text that actually has something to split. It is never a replacement for the
// base rule and can never consume an item's whole band.
//
// That ordering is what a manual test forced. An image-first section keeps an
// EMPTY text item below its picture (about 20px tall). When caret resolution was
// allowed to win there it swallowed the entire item — every position in it
// resolved to "put the image above this paragraph", which is where the image
// already was — and the image could not be moved at all. An empty paragraph has
// no interior position worth aiming at, so it is simply a before/after target
// like any photo or file.
//
// There is deliberately NO special trailing drop band. One was tried and
// removed: an invisible region hanging off the section's last block overlapped
// that block's own bottom edge and, sitting above it in the stacking order,
// stole the item's own "lower half" from it. The base rule above already gives
// every item — empty ones included — a full-height target, which is what that
// band was trying to compensate for.
//
// ---------------------------------------------------------------------------
// A DESTINATION IS A POSITION THE IMAGE WOULD ACTUALLY MOVE TO
// ---------------------------------------------------------------------------
//
// This is the rule a manual test proved was missing, and it is the whole reason
// this module exists.
//
// Resolving a caret inside a text item is NOT enough to make that text item a
// destination. Dropping at the very START of the text immediately BELOW the
// image means "put the image above this paragraph" — which is where it already
// is. The writer correctly refuses to save that, so the user got an insertion
// line, a drop, and no movement.
//
// So both kinds of destination are now gated on whether they would CHANGE the
// order, each by running the real writer rule rather than by restating its edge
// cases:
//
//   text        `sectionTextDropChangesOrder` (the split rule itself)
//   placement   `moveSectionItem` returning a list (the reorder rule itself)
//
// A position that would change nothing is not a destination, so no insertion
// line is drawn there and a release does nothing — and a text position that is
// inert FALLS BACK to the before/after rule, which for the same pointer position
// usually is a real move. No indicator therefore means no movement, always.
//
// ---------------------------------------------------------------------------
// SAME SECTION ONLY
// ---------------------------------------------------------------------------
//
// A block belonging to another row is not a destination: `data-section-row` must
// equal the row the drag started in. That is one of the three independent
// guarantees (the writers each take exactly one row id, and `activeTemplateRowId`
// remains the single row-level destination authority).
//
// Pure apart from the injected `doc`: no React, no storage, no component state.

import { answerToModel, isEmptyAnswerValue } from "./templateRichText";
import { SECTION_ITEM_KIND } from "./templateSectionContent";
import { SECTION_PLACEMENT, moveSectionItem } from "./templateSectionReorder";
import { answerPointFromCoords } from "./templateSectionTextPoint";
import { sectionTextDropChangesOrder } from "./templateSectionTextSplit";

/** The two kinds of destination a drag can resolve to. */
export const SECTION_DROP_KIND = {
  TEXT: "text",
  PLACEMENT: "placement",
};

/**
 * The section item under a screen point, as `{ host, itemId }`, or null.
 *
 * The hit-test is `elementFromPoint` + `closest`, so the WHOLE band of an item
 * is its target rather than a thin strip. The floating drag preview sets
 * `pointer-events: none`, which is what keeps this answering with the document
 * underneath rather than with the preview itself.
 */
export function sectionItemAtPoint({ doc, clientX, clientY, rowId } = {}) {
  const el = elementAtPoint(doc, clientX, clientY);
  const host = closestWith(el, "[data-section-item]");
  if (!host) return null;
  // Another row is not a destination at all.
  if (host.getAttribute("data-section-row") !== rowId) return null;
  const itemId = host.getAttribute("data-section-item");
  if (!itemId) return null;
  return { host, itemId };
}

function elementAtPoint(doc, clientX, clientY) {
  if (!doc || typeof doc.elementFromPoint !== "function") return null;
  return doc.elementFromPoint(clientX, clientY) || null;
}

function closestWith(el, selector) {
  const host = el && typeof el.closest === "function" ? el.closest(selector) : null;
  return host && typeof host.getAttribute === "function" ? host : null;
}

/**
 * The destination for a drag currently over this point, or null for "nowhere".
 *
 * @param doc            the document to hit-test in (injected, so this is testable)
 * @param items          the section's items, in order (normalized or raw)
 * @param rowId          the row the drag STARTED in — the only row that can host it
 * @param movingItemId   the item being dragged
 * @param allowTextDrop  false when no text-drop writer is wired
 * @param allowPlacement false when no reorder writer is wired
 */
export function resolveSectionItemDrop({
  doc,
  clientX,
  clientY,
  rowId,
  movingItemId,
  items,
  allowTextDrop = true,
  allowPlacement = true,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const hit = sectionItemAtPoint({ doc, clientX, clientY, rowId });
  if (!hit) return null;
  return destinationForItem({
    doc,
    host: hit.host,
    itemId: hit.itemId,
    clientX,
    clientY,
    movingItemId,
    items: list,
    allowTextDrop,
    allowPlacement,
  });
}

/**
 * The destination for a point that is over one particular section item.
 *
 * EVERY visible item is a full-height target, and the base rule is the simple
 * one: the pointer in its UPPER half means BEFORE it, in its LOWER half means
 * AFTER it. A precise mid-paragraph split is an ENHANCEMENT layered on top of
 * that for text that actually has something to split — never a replacement for
 * it, and never something that can consume an item's whole band.
 *
 * That ordering is what makes an EMPTY text item — the item an image-first
 * section keeps below its picture, about 20px tall — behave like any other
 * target: its upper half moves the image above it and its lower half moves the
 * image below it. Letting caret resolution win there would swallow the entire
 * item and leave the image unmovable, which is exactly what a manual test found.
 *
 * Returns null when neither would move anything, so an insertion line is never
 * drawn where a release would do nothing.
 */
function destinationForItem({
  doc,
  host,
  itemId,
  clientX,
  clientY,
  movingItemId,
  items,
  allowTextDrop,
  allowPlacement,
}) {
  // An item cannot be dropped onto itself.
  if (itemId === movingItemId) return null;

  const list = items;
  const target = list.find((item) => item && item.id === itemId);
  if (!target) return null;

  if (
    target.kind === SECTION_ITEM_KIND.TEXT &&
    allowTextDrop &&
    // Only text with something IN it can be split. An empty paragraph has no
    // interior position to aim at, so it stays a plain before/after target.
    !isEmptyAnswerValue(target.value)
  ) {
    // The active editor's ProseMirror content element, or the static rendering —
    // both are one element per model block, which is what the resolver maps
    // through.
    const container =
      (typeof host.querySelector === "function" &&
        (host.querySelector(".twocol-rich-input") || host.querySelector(".twocol-rich"))) ||
      null;
    const resolved = container
      ? answerPointFromCoords({
          container,
          clientX,
          clientY,
          model: answerToModel(target.value),
          doc,
        })
      : null;
    if (
      resolved &&
      resolved.point &&
      // A caret the image is already sitting beside is not a destination. The
      // before/after rule below may still be one for this same point.
      sectionTextDropChangesOrder({
        items: list,
        movingItemId,
        targetItemId: itemId,
        point: resolved.point,
      })
    ) {
      const hostTop =
        typeof host.getBoundingClientRect === "function"
          ? host.getBoundingClientRect().top
          : 0;
      return {
        kind: SECTION_DROP_KIND.TEXT,
        targetItemId: itemId,
        point: resolved.point,
        // Presentation only: where the insertion line is drawn, relative to this
        // block. Null simply falls back to the top of the item.
        caretOffsetTop:
          typeof resolved.caretTop === "number" ? resolved.caretTop - hostTop : null,
      };
    }
  }

  if (!allowPlacement) return null;
  if (typeof host.getBoundingClientRect !== "function") return null;
  const rect = host.getBoundingClientRect();
  const placement =
    clientY < rect.top + rect.height / 2
      ? SECTION_PLACEMENT.BEFORE
      : SECTION_PLACEMENT.AFTER;

  // Only a placement that would actually move the item is a destination, so an
  // insertion line never promises a move that the writer will refuse.
  if (
    !moveSectionItem({
      items: list,
      sourceItemId: movingItemId,
      targetItemId: itemId,
      placement,
    })
  ) {
    return null;
  }

  return { kind: SECTION_DROP_KIND.PLACEMENT, targetItemId: itemId, placement };
}
