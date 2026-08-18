// src/lib/templateSectionTextHeal.js
//
// Putting a paragraph back together when the image that was inside it goes
// away — the INVERSE of the retired legacy splitter (Phase G).
//
// PHASE G STATUS — A HISTORICAL-READ COMPATIBILITY RULE ONLY. The legacy
// per-item Template Section interaction that dropped an image INTO a paragraph
// (splitting one TextItem into two and writing `continuesFrom` on the right
// half) no longer exists: a modern Section is one shared ProseMirror document,
// where an image between two paragraphs is simply an image between two
// paragraphs. Nothing writes `continuesFrom` any more, and nothing persists a
// healed list. This module survives because HISTORICAL stored `sectionContent`
// lists still carry that provenance, and the read adapter
// (src/lib/templateSectionDocAdapter.js) runs `healSectionSplitText` IN MEMORY
// over them before adapting — so an old note whose image was later removed
// still reads as one paragraph, exactly as the live product would have shown
// it. The stored list is never rewritten.
//
// Dropping an image into the middle of a paragraph produces three items:
//
//     TextItem A       "The excavation started this morning "
//     PhotoItem
//     TextItem B       "and conditions were wet."   continuesFrom: A, inline
//
// which is exactly right while the image is there. But the moment that image is
// REMOVED, or MOVED somewhere else, A and B are adjacent again — and two
// adjacent text items are two independent editors. The user sees an invisible
// line they cannot type across, cannot pull the second half back up, and cannot
// finish the sentence they started. So the fragments must heal:
//
//     TextItem A       "The excavation started this morning and conditions were wet."
//
// ---------------------------------------------------------------------------
// ONLY FRAGMENTS OF ONE SPLIT EVER MERGE
// ---------------------------------------------------------------------------
//
// Adjacency alone is NOT a reason to merge, and this is the rule that matters
// most here. Two consecutive Quick Add sends are two INDEPENDENT captured
// blocks (handoff §3.5): they are separately reorderable, and merging them
// would silently rewrite a block the user had already finished. They stay two
// items forever, however adjacent they become.
//
// The only signal that says "these two belong together" is the split provenance
// the splitter itself wrote — `continuesFrom: { itemId, join }` on the RIGHT
// half, naming the LEFT half (src/lib/templateSectionContent.js). Nothing else
// in the product writes that field, so a merge can only ever undo a split this
// application performed.
//
// ---------------------------------------------------------------------------
// HEALING HAPPENS IN THE MODEL, NEVER IN HTML
// ---------------------------------------------------------------------------
//
// Exactly as the split does. Both values go through the existing answer
// boundary (`answerToModel` — parse + sanitize), the BLOCKS are joined, and the
// result is re-serialized through the existing plain/rich demotion. No HTML
// string is ever concatenated: `"<p>a</p>" + "<p>b</p>"` is not a merge, it is
// two paragraphs, and slicing off the tags to avoid that would be both unsafe
// and wrong.
//
// The `join` recorded at split time decides the shape of the joint:
//
//   INLINE  the cut fell inside a paragraph, so the LAST block of the left half
//           and the FIRST block of the right half are ONE paragraph and are
//           merged into one. "this morning " + "and conditions" comes back as
//           "this morning and conditions" — not as two paragraphs with a blank
//           line the user never typed.
//   BLOCK   the cut fell at a real paragraph or list-item boundary. That
//           boundary is the user's own content and is preserved: the blocks are
//           simply concatenated.
//
// Marks (bold, italic, underline, strike, colour, highlight, links), paragraph
// alignment, line breaks and list structure all survive because they live on
// model nodes that are carried across untouched, and both sides are rendered
// by the one serializer.
//
// ---------------------------------------------------------------------------
// IDENTITY
// ---------------------------------------------------------------------------
//
// The LEFT/original item survives, with its id. That is the id the split kept
// stable in the first place, and it is what a live editor, a materialising
// session and a Refine backup are keyed on. The continuation is REMOVED, and
// its id is reported so the caller can clear the transient state that belonged
// specifically to it. A pending Refine result addressed to a removed item must
// go on refusing — it is never redirected to the survivor.
//
// Any OTHER item that named the removed continuation as its own origin is
// re-pointed at the survivor, because the survivor now holds that content. That
// is what stops a chain of splits (A / img / B / img / C) from leaving a
// dangling relationship that could never heal.
//
// Pure: no React, no DOM, no storage.

import {
  RICH_TEXT_FORMAT,
  answerToModel,
  modelIsPlain,
  modelToHtml,
  modelToPlainString,
} from "./templateRichText";
import {
  SECTION_ITEM_KIND,
  SECTION_TEXT_JOIN,
  normalizeSectionItem,
  normalizeTextContinuation,
} from "./templateSectionContent";

/**
 * The entries of one stored list that actually RENDER, each with the id the
 * screen shows for it and the raw index it occupies.
 *
 * The gate is `normalizeSectionItem` — the same rule the render path uses — so
 * "what the user can see" and "what is adjacent" are the same set by
 * construction: an entry that renders as nothing never sits between two
 * fragments as far as healing is concerned. The entry itself is carried by
 * reference. (Moved here from the retired `templateSectionReorder.js` in
 * Phase G — this reader is its one surviving consumer.)
 */
export function visibleSectionEntries(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((entry, index) => {
    const item = normalizeSectionItem(entry);
    if (item === null) return;
    out.push({ id: item.id, index, entry });
  });
  return out;
}

/** An answer value for a merged model, through the ordinary plain/rich demotion. */
function modelToAnswerValue(model) {
  const blocks = Array.isArray(model) ? model : [];
  if (modelIsPlain(blocks)) return modelToPlainString(blocks);
  return { format: RICH_TEXT_FORMAT, html: modelToHtml(blocks) };
}

/**
 * Two inline runs that carry exactly the same marks are one run.
 *
 * Only a tidy-up: `[{"this morning "}, {"and conditions"}]` and
 * `[{"this morning and conditions"}]` render identically and serialize to the
 * same HTML. Joining them keeps the healed value indistinguishable from text
 * that was never split — which is the whole point of healing.
 */
function sameMarks(a, b) {
  const ma = a.marks || {};
  const mb = b.marks || {};
  const keys = Object.keys(ma);
  if (keys.length !== Object.keys(mb).length) return false;
  return keys.every((key) => ma[key] === mb[key]);
}

function coalesceInline(nodes) {
  const out = [];
  for (const node of nodes) {
    if (!node) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.type === "text" &&
      node.type === "text" &&
      sameMarks(last, node)
    ) {
      out[out.length - 1] = { ...last, text: `${last.text || ""}${node.text || ""}` };
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * The two halves of one split, joined back into a single answer value.
 *
 * An INLINE join merges the left half's last paragraph with the right half's
 * first one. It falls back to plain block concatenation when either of those is
 * not a paragraph (a list, say): a fabricated inline join across two different
 * block types would corrupt the structure, and the boundary is the safe answer.
 */
export function mergeSplitTextValues(leftValue, rightValue, join) {
  const left = answerToModel(leftValue);
  const right = answerToModel(rightValue);
  if (!left.length) return modelToAnswerValue(right);
  if (!right.length) return modelToAnswerValue(left);

  const lastLeft = left[left.length - 1];
  const firstRight = right[0];
  if (
    join === SECTION_TEXT_JOIN.INLINE &&
    lastLeft &&
    firstRight &&
    lastLeft.type === "paragraph" &&
    firstRight.type === "paragraph"
  ) {
    return modelToAnswerValue([
      ...left.slice(0, -1),
      {
        type: "paragraph",
        align: lastLeft.align || "left",
        content: coalesceInline([
          ...(lastLeft.content || []),
          ...(firstRight.content || []),
        ]),
      },
      ...right.slice(1),
    ]);
  }
  return modelToAnswerValue([...left, ...right]);
}

/** The stored provenance of a RAW entry, or null. */
function continuationOf(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (entry.kind !== SECTION_ITEM_KIND.TEXT) return null;
  return normalizeTextContinuation(entry.continuesFrom, entry.id);
}

/**
 * The FIRST pair of adjacent visible items that are the two halves of one
 * split, or null.
 *
 * Adjacency is measured over the items the user can actually SEE
 * (`visibleSectionEntries`), so a stored entry this version cannot render
 * sitting between them does not pretend to keep them apart — on screen there is
 * nothing between them at all.
 */
export function findHealableSplit(items) {
  const visible = visibleSectionEntries(items);
  for (let i = 1; i < visible.length; i += 1) {
    const right = visible[i];
    const left = visible[i - 1];
    const continuation = continuationOf(right.entry);
    if (!continuation) continue;
    if (continuation.itemId !== left.id) continue;
    const leftItem = normalizeSectionItem(left.entry);
    if (!leftItem || leftItem.kind !== SECTION_ITEM_KIND.TEXT) continue;
    return {
      leftIndex: left.index,
      rightIndex: right.index,
      leftId: left.id,
      rightId: right.id,
      join: continuation.join,
    };
  }
  return null;
}

/**
 * One row's stored list with every healable split closed, or null for "nothing
 * to heal — write nothing".
 *
 * Applied repeatedly, because a section can hold a CHAIN of splits (A / img / B
 * / img / C): removing the images one at a time heals one pair per write, but a
 * single write that makes two pairs adjacent at once must heal both rather than
 * leaving the user half-mended.
 *
 * Raw storage is preserved exactly as every other section writer preserves it:
 * entries this version cannot render, and every item not part of the pair, are
 * passed through BY REFERENCE in their existing relative order. Only the
 * survivor is rebuilt, and only its `value` changes.
 *
 * @returns { items, removedItemIds, survivorItemIds } | null
 */
export function healSectionSplitText(items) {
  let current = Array.isArray(items) ? items : [];
  const removedItemIds = [];
  const survivorItemIds = [];

  // Bounded by the number of items: every pass removes exactly one entry.
  for (let guard = current.length; guard >= 0; guard -= 1) {
    const pair = findHealableSplit(current);
    if (!pair) break;

    const leftEntry = current[pair.leftIndex];
    const rightEntry = current[pair.rightIndex];
    const merged = {
      ...leftEntry,
      kind: SECTION_ITEM_KIND.TEXT,
      value: mergeSplitTextValues(leftEntry.value, rightEntry.value, pair.join),
    };

    const next = [];
    for (let i = 0; i < current.length; i += 1) {
      if (i === pair.rightIndex) continue;
      if (i === pair.leftIndex) {
        next.push(merged);
        continue;
      }
      const entry = current[i];
      // A later fragment that continued the item just removed now continues the
      // SURVIVOR, which holds that content. Without this, a chain of splits
      // would leave a relationship naming an item that no longer exists — and
      // it could never heal.
      const continuation = continuationOf(entry);
      if (continuation && continuation.itemId === pair.rightId) {
        next.push({
          ...entry,
          continuesFrom: { itemId: pair.leftId, join: continuation.join },
        });
        continue;
      }
      next.push(entry);
    }

    removedItemIds.push(pair.rightId);
    survivorItemIds.push(pair.leftId);
    current = next;
  }

  if (!removedItemIds.length) return null;
  return { items: current, removedItemIds, survivorItemIds };
}
