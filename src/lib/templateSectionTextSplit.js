// src/lib/templateSectionTextSplit.js
//
// Placing a section IMAGE inside a section's TEXT — the Word-like part of the
// flexible section.
//
// Dragging an image onto a position inside a paragraph must produce:
//
//     TEXT BEFORE
//     IMAGE
//     TEXT AFTER
//
// which in the ordered `sectionContent[rowId]` model is exactly three items in
// a row. Nothing else about the section changes: no new row, no second section,
// no duplicated label, no page metadata.
//
// ---------------------------------------------------------------------------
// THE SPLIT HAPPENS IN THE MODEL, NEVER IN HTML
// ---------------------------------------------------------------------------
//
// A text item's value is either a plain string or a tagged
// `{ format: "richtext/1", html }` (src/lib/templateRichText.js). Splitting the
// stored HTML with string operations would be both unsafe and wrong — an offset
// into markup is not an offset into text, and a cut between `<strong>` and
// `</strong>` produces two invalid fragments.
//
// So the value is taken through the EXISTING boundary instead:
//
//   answerToModel(value)     parse + sanitize into the normalized block model
//   split the MODEL          structural: blocks, inline runs, marks, list items
//   modelToHtml / demote     re-serialize each half exactly as an ordinary edit
//                            does (a half that needs no rich text becomes a
//                            plain string, same as serializeAnswerFromHtml)
//
// Formatting survives by CONSTRUCTION rather than by care: a mark lives on an
// inline run, and a run that straddles the cut is copied into two runs carrying
// the SAME marks. Bold, italic, underline, strike, colour, highlight, links,
// paragraph alignment, line breaks and list structure therefore all come
// through, and nothing outside the schema can appear on either side because
// both sides are rendered from the model by the one serializer.
//
// ---------------------------------------------------------------------------
// STABLE IDENTITY — the original id stays with the text BEFORE the image
// ---------------------------------------------------------------------------
//
// A split turns one text item into two, so one of them must be new. The
// original id goes to the BEFORE half:
//
//   - it keeps the ORDER of ids stable (the item that was there is still the
//     one that comes first), which is what a live editor, the materialising
//     session record and a future per-item Refine backup are all keyed on;
//   - the AFTER half is genuinely new content in a new position, so a new id is
//     the honest description of it.
//
// The AFTER half also records WHERE IT CAME FROM — `continuesFrom: { itemId,
// join }` naming the BEFORE half (src/lib/templateSectionContent.js). That one
// field is what makes the split reversible: if the image between them is later
// removed or moved somewhere else, the two halves are recognised as fragments
// of ONE paragraph and heal back into it
// (src/lib/templateSectionTextHeal.js). Nothing else in the product writes it,
// so two separately captured text items that merely end up adjacent are never
// merged.
//
// The moving image is carried by REFERENCE. Its item id, `assetId`, `display`,
// name, MIME type, size, intrinsic dimensions, creation time and any property
// this version does not know about are untouched, and no asset is created,
// copied or deleted — a move is a change of position and nothing else.
//
// ---------------------------------------------------------------------------
// NO MEANINGLESS EMPTY FRAGMENTS
// ---------------------------------------------------------------------------
//
// Dropping at the very start of a paragraph would produce an empty BEFORE, and
// at the very end an empty AFTER. Writing those would litter the section with
// blank text items the user never authored and would have to delete. So:
//
//   BEFORE empty   the image is inserted BEFORE the original item, which keeps
//                  its id and its whole value. No id is minted.
//   AFTER empty    the image is inserted AFTER the original item, likewise.
//   BOTH empty     the item is an empty paragraph. It is KEPT — an empty text
//                  item is what makes a section typeable — and the image goes
//                  in front of it.
//
// That is also what makes a plain "put it above this paragraph" drop work
// without a second code path: it is the same split, resolved at offset 0.
//
// ---------------------------------------------------------------------------
// RAW STORAGE
// ---------------------------------------------------------------------------
//
// The rebuild walks the RAW stored list and passes every entry it is not acting
// on through by reference, so entries this version cannot render survive in
// their relative order, un-normalized, still protecting whatever asset they may
// name. It deliberately does NOT use the absolute-index slot rule that
// `moveSectionItem` uses: a split changes the LENGTH of the list, so absolute
// indices cannot be preserved by anything. Relative order is, and nothing is
// dropped or rewritten.
//
// Pure except for `moveSectionItemIntoText` at the bottom, which becomes
// durable through the same injected confirmed instance save every other section
// writer uses.

import {
  RICH_TEXT_FORMAT,
  answerToModel,
  isEmptyAnswerValue,
  modelIsPlain,
  modelToHtml,
  modelToPlainString,
} from "./templateRichText";
import {
  SECTION_ITEM_KIND,
  SECTION_TEXT_JOIN,
  normalizeSectionItem,
} from "./templateSectionContent";
import { visibleSectionEntries } from "./templateSectionReorder";
import { ANSWER_POINT_KIND } from "./templateSectionTextPoint";

/**
 * What a text-drop attempt did. The same three-way distinction the reorder
 * writer makes, for the same reason: only a failed SAVE is the user's problem.
 */
export const SECTION_TEXT_DROP_OUTCOME = {
  OK: "ok",
  REFUSED: "refused",
  UNCHANGED: "unchanged",
  SAVE_FAILED: "save-failed",
};

/** An answer value for a model half, through the ordinary plain/rich demotion. */
export function modelToAnswerValue(model) {
  const blocks = Array.isArray(model) ? model : [];
  if (modelIsPlain(blocks)) return modelToPlainString(blocks);
  return { format: RICH_TEXT_FORMAT, html: modelToHtml(blocks) };
}

/**
 * One paragraph's inline content, cut at a character offset.
 *
 * A run that straddles the cut becomes two runs with the SAME marks, so every
 * mark the model supports survives without being enumerated here.
 *
 * A LINE BREAK sitting exactly at the cut is CONSUMED by it: the break was the
 * line boundary, and the paragraph boundary that replaces it already provides
 * one. Keeping it would leave a blank first line on the AFTER half. Only the
 * first such break is consumed — a run of blank lines the user typed is content
 * and is preserved.
 */
export function splitInlineContent(content, offset) {
  const nodes = Array.isArray(content) ? content : [];
  const cut = Math.max(0, Number(offset) || 0);
  const before = [];
  const after = [];
  let consumed = 0;
  let boundaryBreakUsed = false;

  for (const node of nodes) {
    if (!node) continue;

    if (node.type === "break") {
      if (consumed === cut && !boundaryBreakUsed) {
        boundaryBreakUsed = true;
        continue;
      }
      (consumed < cut ? before : after).push(node);
      continue;
    }

    const text = String(node.text || "");
    const start = consumed;
    const end = start + text.length;
    consumed = end;

    if (end <= cut) {
      before.push(node);
    } else if (start >= cut) {
      after.push(node);
    } else {
      const at = cut - start;
      before.push({ ...node, text: text.slice(0, at), marks: { ...(node.marks || {}) } });
      after.push({ ...node, text: text.slice(at), marks: { ...(node.marks || {}) } });
    }
  }

  return { before, after };
}

/**
 * A normalized block model cut into two, at a resolved point.
 *
 * Returns `{ before, after, join }`, or null for a point that does not describe
 * a position in this model — an out-of-range block, or a kind that does not
 * match the block there. A caller must then write nothing rather than cut
 * somewhere approximate.
 *
 * `join` records WHAT WAS CUT, which is the only thing that can tell a later
 * heal how to put the halves back:
 *
 *   INLINE  the cut fell inside a paragraph's own inline content, so content
 *           survived on both sides of it. The paragraph must come back as ONE
 *           paragraph.
 *   BLOCK   the cut fell at a real block boundary — between two paragraphs, at
 *           the edge of one, or between two list items. That boundary is the
 *           user's own and must survive a heal.
 */
export function splitAnswerModel(model, point) {
  const blocks = Array.isArray(model) ? model : [];
  if (!point || typeof point !== "object") return null;
  const { blockIndex } = point;
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blocks.length) {
    return null;
  }
  const block = blocks[blockIndex];
  if (!block) return null;

  if (point.kind === ANSWER_POINT_KIND.LIST) {
    if (block.type !== "bulletList" && block.type !== "orderedList") return null;
    const items = Array.isArray(block.items) ? block.items : [];
    const at = Math.max(0, Math.min(items.length, Number(point.itemIndex) || 0));
    return {
      before: [
        ...blocks.slice(0, blockIndex),
        ...(at > 0 ? [{ type: block.type, items: items.slice(0, at) }] : []),
      ],
      after: [
        ...(at < items.length ? [{ type: block.type, items: items.slice(at) }] : []),
        ...blocks.slice(blockIndex + 1),
      ],
      // A list is always cut at an ITEM boundary (§12.4), never mid-clause, so
      // there is never an inline join to restore.
      join: SECTION_TEXT_JOIN.BLOCK,
    };
  }

  if (point.kind !== ANSWER_POINT_KIND.PARAGRAPH) return null;
  if (block.type !== "paragraph") return null;

  const { before, after } = splitInlineContent(block.content || [], point.offset);
  const align = block.align || "left";
  const beforeBlocks = blocks.slice(0, blockIndex);
  const afterBlocks = blocks.slice(blockIndex + 1);
  const beforeParagraph = { type: "paragraph", align, content: before };
  const afterParagraph = { type: "paragraph", align, content: after };

  // A HALF OF THE CUT PARAGRAPH THAT CARRIES NOTHING IS NOT KEPT.
  //
  // Cutting at a paragraph edge leaves one side with an empty remainder, and
  // writing it would put a blank line into the user's report that they never
  // typed and would have to find and delete. It is an artefact of the cut, not
  // content, so it is dropped.
  //
  // The exception is a paragraph that was ALREADY blank: nothing survives on
  // either side, and dropping both would silently delete a blank line the user
  // did type. It is kept exactly once, below the image, so content flows
  // downward past it.
  const emptyBefore = before.length === 0;
  const emptyAfter = after.length === 0;
  // The cut is INLINE only when the paragraph genuinely carried content on both
  // sides of it. An empty side means the pointer landed at the paragraph's own
  // edge, which is a real block boundary and must stay one.
  const join =
    emptyBefore || emptyAfter ? SECTION_TEXT_JOIN.BLOCK : SECTION_TEXT_JOIN.INLINE;
  if (emptyBefore && emptyAfter) {
    return { before: beforeBlocks, after: [afterParagraph, ...afterBlocks], join };
  }
  return {
    before: emptyBefore ? beforeBlocks : [...beforeBlocks, beforeParagraph],
    after: emptyAfter ? afterBlocks : [afterParagraph, ...afterBlocks],
    join,
  };
}

/**
 * One stored text value cut into two answer values at a resolved point, or
 * null when the point does not describe a position in it.
 */
export function splitAnswerValue(value, point) {
  const halves = splitAnswerModel(answerToModel(value), point);
  if (!halves) return null;
  return {
    before: modelToAnswerValue(halves.before),
    after: modelToAnswerValue(halves.after),
    join: halves.join,
  };
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry === b[i]);
}

/**
 * One row's stored list with an item MOVED to a position inside a text item,
 * splitting that text item around it — or null, meaning "write nothing".
 *
 * Null covers, deliberately as refusals rather than approximations:
 *   - a source or target id that no longer names a VISIBLE item (a stale drag);
 *   - source === target;
 *   - a target that is not a text item (a photo/file target is an ordinary
 *     before/after move and belongs to `moveSectionItem`);
 *   - a point that does not resolve in that item's model;
 *   - a missing or already-used new item id when one is genuinely needed;
 *   - a result identical to the order the section is already in.
 *
 * @returns { items, newTextItemId } — `newTextItemId` is null when the drop
 *          landed at an edge and no item had to be created.
 */
export function splitSectionTextForItem({
  items,
  movingItemId,
  targetItemId,
  point,
  newItemId = null,
} = {}) {
  const raw = Array.isArray(items) ? items : [];
  if (typeof movingItemId !== "string" || !movingItemId) return null;
  if (typeof targetItemId !== "string" || !targetItemId) return null;
  if (movingItemId === targetItemId) return null;

  const visible = visibleSectionEntries(raw);
  const source = visible.find((entry) => entry.id === movingItemId);
  const target = visible.find((entry) => entry.id === targetItemId);
  if (!source || !target) return null;

  const targetItem = normalizeSectionItem(target.entry);
  if (!targetItem || targetItem.kind !== SECTION_ITEM_KIND.TEXT) return null;

  const halves = splitAnswerValue(targetItem.value, point);
  if (!halves) return null;

  const beforeEmpty = isEmptyAnswerValue(halves.before);
  const afterEmpty = isEmptyAnswerValue(halves.after);

  let replacement;
  let mintedId = null;

  if (afterEmpty && !beforeEmpty) {
    // Dropped at the end: the whole text stays where it is, image after it.
    replacement = [target.entry, source.entry];
  } else if (beforeEmpty) {
    // Dropped at the start (or into an empty item): image first, the text item
    // — including a deliberately empty one, which is what keeps the section
    // typeable — follows with its id and value untouched.
    replacement = [source.entry, target.entry];
  } else {
    if (typeof newItemId !== "string" || !newItemId) return null;
    if (visible.some((entry) => entry.id === newItemId)) return null;
    mintedId = newItemId;
    replacement = [
      // The ORIGINAL id stays with the text BEFORE the image. Its own
      // provenance — if it is itself the continuation of an earlier split — is
      // carried through untouched: it still continues whatever it continued.
      { ...target.entry, kind: SECTION_ITEM_KIND.TEXT, value: halves.before },
      source.entry,
      {
        id: newItemId,
        kind: SECTION_ITEM_KIND.TEXT,
        value: halves.after,
        // THE SPLIT PROVENANCE. This half exists only because an image was put
        // inside one paragraph; if that image is later removed or moved away
        // and the two halves become adjacent again, this is what lets them heal
        // back into the single text item they came from — and what stops any
        // OTHER pair of adjacent text items from being merged.
        continuesFrom: { itemId: target.id, join: halves.join },
      },
    ];
  }

  const next = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (i === source.index) continue;
    if (i === target.index) {
      next.push(...replacement);
      continue;
    }
    next.push(raw[i]);
  }

  // The image is already exactly there: understood, and deliberately not saved.
  // Compared over the VISIBLE entries by reference, so a drop that only shuffles
  // where an unrenderable stored entry sits relative to the image — something
  // nobody can see — is correctly recognised as no change at all.
  if (
    sameList(
      visibleSectionEntries(next).map((entry) => entry.entry),
      visible.map((entry) => entry.entry)
    )
  ) {
    return null;
  }

  return { items: next, newTextItemId: mintedId };
}

// A placeholder id for the probe below. It is never written anywhere: the probe
// only asks WHETHER a split would change the order, and throws the result away.
// A collision with a real id simply makes the probe answer "no", which is the
// safe direction — the caller then offers a before/after placement instead.
const DROP_PROBE_ITEM_ID = "__section-text-drop-probe__";

/**
 * WOULD dropping the moving item at this position in this text item actually
 * change the section's order?
 *
 * A caret position is not automatically a destination. Dropping at the very
 * START of the text item that already sits immediately BELOW the image — or at
 * the very END of the one immediately ABOVE it — resolves to "put the image
 * beside this item", which is exactly where it already is. `splitSectionTextForItem`
 * correctly refuses to write for those, so offering them as destinations gives
 * the user an insertion line, a drop, and no movement.
 *
 * The question is answered by RUNNING the real rule rather than by restating its
 * edge cases here, so the destination the gesture offers and the write that
 * follows can never disagree about what would happen.
 */
export function sectionTextDropChangesOrder({
  items,
  movingItemId,
  targetItemId,
  point,
} = {}) {
  return (
    splitSectionTextForItem({
      items,
      movingItemId,
      targetItemId,
      point,
      newItemId: DROP_PROBE_ITEM_ID,
    }) !== null
  );
}

const refused = (error) => ({
  ok: false,
  outcome: SECTION_TEXT_DROP_OUTCOME.REFUSED,
  error: error || null,
});

/**
 * Move ONE item into a position inside a text item of the SAME section,
 * durably.
 *
 * The sequence is the one every section writer uses, and it is the contract:
 *
 *   1. establish the intended drop (source, target text item, resolved point);
 *   2. read the FRESHEST stored list — never one closed over when the drag
 *      began, so the split acts on what is actually stored;
 *   3. calculate the next list purely;
 *   4. a result identical to the current order saves NOTHING;
 *   5. exactly ONE confirmed persistence attempt;
 *   6. the confirmed list is the list.
 *
 * There is exactly one `rowId`, which is what makes a cross-section drop
 * unexpressible here just as it is in the reorder writer.
 *
 * @param deps injected effects:
 *   readSectionList(rowId) -> raw stored array   read FRESH, never closed over
 *   persist(rowId, items)  -> void, THROWS       the confirmed instance save
 *   newId()                -> string             the id minter (only called
 *                                                when a split genuinely needs a
 *                                                second text item)
 *   onStructuralChange(info)                     OPTIONAL — see below
 *
 * `onStructuralChange` is optional because a split REMOVES no id: the item the
 * user was editing keeps its id on the BEFORE half, so a materialising session
 * stays valid. It is reported when supplied so a caller can reload the one live
 * editor whose stored value this rewrote.
 */
export function moveSectionItemIntoText({
  rowId,
  sourceItemId,
  targetItemId,
  point,
  deps = {},
} = {}) {
  if (typeof rowId !== "string" || !rowId) return refused("A row id is required");

  const { readSectionList, persist, newId } = deps;
  if (typeof readSectionList !== "function" || typeof persist !== "function") {
    return refused("The section text-drop writer is not wired");
  }
  if (typeof newId !== "function") {
    return refused("The section text-drop writer has no id source");
  }

  const current = readSectionList(rowId);
  const visible = visibleSectionEntries(current);
  if (!visible.some((entry) => entry.id === sourceItemId)) {
    return refused("That item is no longer part of this section");
  }
  if (!visible.some((entry) => entry.id === targetItemId)) {
    return refused("That text is no longer part of this section");
  }

  const result = splitSectionTextForItem({
    items: current,
    movingItemId: sourceItemId,
    targetItemId,
    point,
    newItemId: newId(),
  });
  if (!result) {
    return { ok: false, outcome: SECTION_TEXT_DROP_OUTCOME.UNCHANGED, error: null };
  }

  try {
    persist(rowId, result.items);
  } catch (err) {
    return {
      ok: false,
      outcome: SECTION_TEXT_DROP_OUTCOME.SAVE_FAILED,
      error: err?.message || String(err),
    };
  }

  if (typeof deps.onStructuralChange === "function") {
    deps.onStructuralChange({
      rowId,
      movedItemId: sourceItemId,
      splitTextItemId: targetItemId,
      newTextItemId: result.newTextItemId,
      reason: "split",
    });
  }

  return {
    ok: true,
    outcome: SECTION_TEXT_DROP_OUTCOME.OK,
    items: result.items,
    newTextItemId: result.newTextItemId,
    splitTextItemId: targetItemId,
  };
}
