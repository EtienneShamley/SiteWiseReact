// src/lib/templateSectionReorder.js
//
// Moving ONE item inside a flexible Template section, without changing anything
// else about it.
//
// A section is an ordered `sectionContent[rowId]` list (see
// src/lib/templateSectionContent.js) whose ARRAY ORDER IS DOCUMENT ORDER. There
// is no sort key, no index map and no ordering metadata anywhere else, so
// reordering is exactly one thing: the same entries, in a different order in
// that one array.
//
// ---------------------------------------------------------------------------
// SAME SECTION ONLY
// ---------------------------------------------------------------------------
//
// Every function here operates on ONE row's list and has no way to name a
// second one. There is deliberately no cross-section move: a writer that could
// take an item out of row A and put it into row B would be a second destination
// concept, and `activeTemplateRowId` is the single Quick Add / row destination
// authority. Cross-section movement is an open product question, not an
// omission (see the handoff §7).
//
// ---------------------------------------------------------------------------
// STABLE IDENTITY — never a position
// ---------------------------------------------------------------------------
//
// Both ends of a move are named by the item's own stable id, exactly as every
// other section writer names its target. An index is meaningless here more than
// anywhere else in the model: moving an item is precisely the operation that
// invalidates every index in the list, so an index-addressed move could act on
// whatever slid into the position it remembered.
//
// The id compared against is the id the SCREEN shows — the normalized item's id
// — because that is the id a UI action carries. `normalizeAttachment` gives an
// entry with no `id` of its own the id `entry.assetId`, so such an item stays
// movable rather than silently unaddressable.
//
// A move NEVER rebuilds an item. The stored entry objects are carried across by
// reference into their new positions, so an item's id, kind, text value, asset
// reference, name, MIME type, size, intrinsic dimensions, photo display
// metadata, creation time and any property this version does not even know
// about all survive a move untouched. Nothing is normalized on the way through.
//
// ---------------------------------------------------------------------------
// RAW STORAGE PRESERVATION — the deterministic slot rule
// ---------------------------------------------------------------------------
//
// A stored list may hold entries the strict read model cannot render — an
// unknown or future `kind`, an id-less text item, a structurally broken record.
// Phase 0 keeps them in storage rather than sanitising them away (an entry this
// version cannot interpret may be a user's photo under a shape a later version
// understands), and every existing section writer passes them through by
// reference at their exact positions.
//
// A reorder cannot do quite that, because it exists to change positions. The
// rule it uses instead is:
//
//   an INVISIBLE entry keeps its absolute stored index;
//   the VISIBLE entries are permuted among the indices visible entries already
//   occupied.
//
// So for a stored list [A, X, B, Y, C] where X and Y do not render, moving C
// before A produces [C, X, A, Y, B]: the user sees C, A, B — exactly the move
// they asked for — while X stays at index 1 and Y stays at index 3, still
// stored, still un-normalized, still protecting whatever asset they may name.
//
// It is deterministic, it never drops an entry, it never rewrites one, and it
// never reorders one the user cannot see (there is no meaningful order to put
// an invisible entry in). An invisible entry is also not addressable AS a move
// source or target, so a UI can never initiate a move against one.
//
// ---------------------------------------------------------------------------
// NO PERSISTENCE IN THE PURE RULES
// ---------------------------------------------------------------------------
//
// `moveSectionItem` and its keyboard siblings are pure list functions and write
// nothing. `reorderSectionItem` at the bottom is the one place a move becomes
// durable, through the SAME injected confirmed instance save every other
// section writer uses — one save, on the completed move, never during pointer
// movement.
//
// Pure except for that injected effect: no React, no DOM, no direct storage.

import { normalizeSectionItem } from "./templateSectionContent";

/** Where a moved item lands relative to the item it was dropped on. */
export const SECTION_PLACEMENT = {
  BEFORE: "before",
  AFTER: "after",
};

/** The two deterministic keyboard moves among VISIBLE items. */
export const SECTION_MOVE = {
  UP: "up",
  DOWN: "down",
};

/**
 * What a reorder attempt did. Deliberately distinguishes the three ways a move
 * can write nothing, because they mean different things to a caller:
 *
 *   REFUSED    the request could not be acted on (a stale id, a missing wiring).
 *              Nothing is wrong with the stored data and nothing should be
 *              reported to the user as a failure.
 *   UNCHANGED  the move was understood and would produce the order the section
 *              is already in. There is nothing to save, so nothing is saved.
 *   SAVE_FAILED the new order could not be confirmed to storage. The OLD order
 *              remains authoritative — this is the one outcome a caller must
 *              surface, because the user asked for something that did not
 *              happen.
 */
export const SECTION_REORDER_OUTCOME = {
  OK: "ok",
  REFUSED: "refused",
  UNCHANGED: "unchanged",
  SAVE_FAILED: "save-failed",
};

/** The raw stored list for a row, defensively. Never null, never shared. */
function rawList(list) {
  return Array.isArray(list) ? list : [];
}

/**
 * The entries of one stored list that actually RENDER, each with the id the
 * screen shows for it and the raw index it occupies.
 *
 * The gate is `normalizeSectionItem` — the same rule the render path uses — so
 * "what the user can see" and "what can be moved" are the same set by
 * construction, and an entry that renders as nothing is never a move target.
 *
 * The raw index is what the slot rule above needs; the entry itself is carried
 * by reference so a move can reposition the exact stored object.
 */
export function visibleSectionEntries(list) {
  const out = [];
  rawList(list).forEach((entry, index) => {
    const item = normalizeSectionItem(entry);
    if (item === null) return;
    out.push({ id: item.id, index, entry });
  });
  return out;
}

/** The ids of one section's VISIBLE items, in document order. */
export function visibleSectionItemIds(list) {
  return visibleSectionEntries(list).map((entry) => entry.id);
}

/**
 * One row's stored list with ONE item moved, or null — "refuse, write nothing".
 *
 * Null covers every case that is not unambiguously "move this visible item to
 * this visible position", and they are all refusals rather than approximations:
 *
 *   - a source id that no longer names a visible item (a stale drag, an item
 *     removed underneath the gesture). Moving "whatever is nearby" would
 *     reorder content the user never pointed at.
 *   - a target id that no longer names a visible item, for the same reason.
 *   - source and target being the same item — there is no such move.
 *   - a placement that is neither "before" nor "after".
 *   - a move whose result is the order the list is ALREADY in. Dropping an item
 *     back where it started, or "before" the item that already follows it, is a
 *     no-op, and a no-op must not produce a save.
 *
 * On success the returned array is a new array whose entries are the SAME
 * objects, repositioned per the slot rule in the header.
 */
export function moveSectionItem({
  items,
  sourceItemId,
  targetItemId,
  placement,
} = {}) {
  if (!Array.isArray(items)) return null;
  if (typeof sourceItemId !== "string" || !sourceItemId) return null;
  if (typeof targetItemId !== "string" || !targetItemId) return null;
  if (sourceItemId === targetItemId) return null;
  if (
    placement !== SECTION_PLACEMENT.BEFORE &&
    placement !== SECTION_PLACEMENT.AFTER
  ) {
    return null;
  }

  const visible = visibleSectionEntries(items);
  const from = visible.findIndex((entry) => entry.id === sourceItemId);
  if (from === -1) return null;
  if (visible.findIndex((entry) => entry.id === targetItemId) === -1) return null;

  const moved = visible[from];
  const without = visible.filter((_, i) => i !== from);
  const targetIndex = without.findIndex((entry) => entry.id === targetItemId);
  // The target was found in `visible` and is not the source, so it survives the
  // removal — but stay defensive rather than trusting an index arithmetic step.
  if (targetIndex === -1) return null;
  const insertAt =
    placement === SECTION_PLACEMENT.BEFORE ? targetIndex : targetIndex + 1;
  const nextVisible = [
    ...without.slice(0, insertAt),
    moved,
    ...without.slice(insertAt),
  ];

  // Already in that order: understood, and deliberately not saved.
  const changed = nextVisible.some((entry, i) => entry !== visible[i]);
  if (!changed) return null;

  // THE SLOT RULE. Invisible entries keep their absolute stored index (they are
  // simply never written to); the visible entries are written back, in their new
  // order, into the indices visible entries already occupied.
  const next = rawList(items).slice();
  visible.forEach((slot, i) => {
    next[slot.index] = nextVisible[i].entry;
  });
  return next;
}

/**
 * The move ONE step up or down would perform, as `{ targetItemId, placement }`,
 * or null when there is no such move.
 *
 * Null is what "unavailable" means for the caller's disabled state, and it is
 * the honest answer in every case that has one:
 *
 *   - the first visible item cannot move up;
 *   - the last visible item cannot move down;
 *   - a single-item section can do neither;
 *   - an item that is not visible is not movable at all.
 *
 * Steps are counted among VISIBLE items only. An invisible stored entry between
 * two paragraphs is preserved, but it is not a place the keyboard can move an
 * item to — there is nothing on screen there to move past.
 *
 * Accepts either a raw stored list or an already-normalized render list: both
 * describe the same items in the same order, and normalizing an item again
 * yields the same id.
 */
export function sectionItemMoveTarget({ items, itemId, direction } = {}) {
  if (typeof itemId !== "string" || !itemId) return null;
  const visible = visibleSectionEntries(items);
  const position = visible.findIndex((entry) => entry.id === itemId);
  if (position === -1) return null;

  if (direction === SECTION_MOVE.UP) {
    if (position === 0) return null;
    return {
      targetItemId: visible[position - 1].id,
      placement: SECTION_PLACEMENT.BEFORE,
    };
  }
  if (direction === SECTION_MOVE.DOWN) {
    if (position === visible.length - 1) return null;
    return {
      targetItemId: visible[position + 1].id,
      placement: SECTION_PLACEMENT.AFTER,
    };
  }
  return null;
}

/** Is a one-step move available for this item? The disabled-state question. */
export function canMoveSectionItem({ items, itemId, direction } = {}) {
  return sectionItemMoveTarget({ items, itemId, direction }) !== null;
}

/**
 * One row's stored list with ONE item moved a single step, or null.
 *
 * The keyboard equivalent of a drag, expressed in terms of the same one move
 * rule rather than as a second implementation — so "Move up" and "drag above
 * the item above" cannot ever disagree about what happened.
 */
export function moveSectionItemStep({ items, itemId, direction } = {}) {
  const target = sectionItemMoveTarget({ items, itemId, direction });
  if (!target) return null;
  return moveSectionItem({
    items,
    sourceItemId: itemId,
    targetItemId: target.targetItemId,
    placement: target.placement,
  });
}

const refused = (error) => ({
  ok: false,
  outcome: SECTION_REORDER_OUTCOME.REFUSED,
  error: error || null,
});

/**
 * Move ONE item inside a row's ordered section content, durably.
 *
 * The sequence is the whole contract, and it is deliberately the same shape the
 * other section writers use:
 *
 *   1. establish the intended move (the caller's source, target and placement);
 *   2. read the FRESHEST stored list — never a list closed over when a drag
 *      began, so two moves in a row both act on what is actually stored;
 *   3. calculate the next list purely;
 *   4. an unchanged order saves NOTHING;
 *   5. exactly ONE confirmed persistence attempt;
 *   6. the confirmed order is the order.
 *
 * A save failure returns SAVE_FAILED and the OLD persisted order remains
 * authoritative. Nothing here reports success before `persist` returns, so a
 * caller that renders from the instance cannot end up showing an order that was
 * never stored.
 *
 * @param rowId        the stable row id (a pinned field id or a custom row id).
 *                     There is exactly one, which is what makes a cross-section
 *                     move unexpressible.
 * @param sourceItemId the stable id of the item being moved
 * @param targetItemId the stable id of the item it is being moved relative to
 * @param placement    SECTION_PLACEMENT.BEFORE | AFTER
 * @param deps         injected effects:
 *   readSectionList(rowId) -> raw stored array   read FRESH, never closed over
 *   persist(rowId, items)  -> void, THROWS       the confirmed instance save
 *   onStructuralChange(info)                     OPTIONAL — see below
 *
 * `onStructuralChange` is REQUIRED by the append/remove primitives because they
 * create or destroy items, which can leave a live editor's transient state
 * describing an item that is no longer there. A reorder creates nothing,
 * destroys nothing and renames nothing — every id in the list before the move
 * is in the list after it — so no transient state is invalidated by one, and it
 * is deliberately optional here. In particular a MATERIALISING editor session
 * must SURVIVE a reorder: it names its item by id, and dropping the record
 * would send the next keystroke to the frozen legacy answer the row no longer
 * renders.
 *
 * @returns { ok, outcome, error?, items? }
 */
export function reorderSectionItem({
  rowId,
  sourceItemId,
  targetItemId,
  placement,
  deps = {},
} = {}) {
  if (typeof rowId !== "string" || !rowId) return refused("A row id is required");

  const { readSectionList, persist } = deps;
  if (typeof readSectionList !== "function" || typeof persist !== "function") {
    return refused("The section reorder writer is not wired");
  }

  // 2. The freshest stored list, read here and nowhere earlier.
  const current = readSectionList(rowId);

  // A stale end of the gesture is a refusal, reported as one, so a caller can
  // tell "that item has gone" apart from "that was not a move".
  const visible = visibleSectionItemIds(current);
  if (!visible.includes(sourceItemId)) {
    return refused("That item is no longer part of this section");
  }
  if (!visible.includes(targetItemId)) {
    return refused("That position is no longer part of this section");
  }

  // 3/4. Purely calculated, and an unchanged order is not written.
  const items = moveSectionItem({ items: current, sourceItemId, targetItemId, placement });
  if (!items) {
    return { ok: false, outcome: SECTION_REORDER_OUTCOME.UNCHANGED, error: null };
  }

  // 5. Exactly one confirmed persistence attempt.
  try {
    persist(rowId, items);
  } catch (err) {
    return {
      ok: false,
      outcome: SECTION_REORDER_OUTCOME.SAVE_FAILED,
      error: err?.message || String(err),
    };
  }

  if (typeof deps.onStructuralChange === "function") {
    deps.onStructuralChange({ rowId, movedItemId: sourceItemId, reason: "reorder" });
  }

  return { ok: true, outcome: SECTION_REORDER_OUTCOME.OK, items };
}
