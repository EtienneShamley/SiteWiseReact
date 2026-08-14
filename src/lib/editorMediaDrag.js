// src/lib/editorMediaDrag.js
//
// THE DOCUMENT SIDE OF A MEDIA BODY DRAG — where a dragged image may land, and
// the ONE transaction that moves it there.
//
// Part of the shared NoteWise editor media core (docs/PROJECT_DECISIONS.md →
// "Shared NoteWise Editor Core"). Phase C2 replaces the browser's native HTML5
// node drag with a pointer-owned gesture; this module owns the two document
// questions that gesture asks:
//
//   1. DESTINATION. Pointer coordinates resolve through ProseMirror's own
//      `view.posAtCoords`, and the candidate insertion point comes from
//      prosemirror-transform's `dropPoint` — the same resolution the editor's
//      native drop path uses. The destination is therefore always a REAL
//      document position where this block node legally fits, never an external
//      slot, never a synthetic zone. A destination that would reproduce the
//      current document (immediately before/after the node, or inside it) is
//      not a destination at all — an insertion indicator must never promise a
//      move the transaction would then refuse.
//
//   2. THE MOVE. One transaction: delete the node at its source, map the
//      destination through that deletion, insert THE SAME node object at the
//      mapped position. Mapping is what makes "destination after the source"
//      land correctly once the source is gone. The node instance carries every
//      attribute with it (assetId/src, widthPct, layoutMode, layoutSide,
//      intrinsic dimensions, alt, title) — nothing is recreated, no asset is
//      read, written or deleted, and no new assetId can exist. One transaction
//      is one undo step and one autosave, dispatched by the caller's surface
//      exactly as any other edit.
//
// The ghost geometry (how large the floating preview is drawn, and where) was
// proven on Template section images; it is re-exported here under media-core
// names, wrapping — not copying — src/lib/templateSectionImageMove.js, exactly
// as editorMediaResize.js wraps the resize arithmetic. Consolidating the
// implementation's home is Phase G.
//
// No React, no DOM, no storage: the view is injected, and everything else is
// ProseMirror state in and ProseMirror transactions out.

import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import {
  IMAGE_DRAG_PREVIEW_MAX_PX,
  imageDragPreviewGeometry,
} from "./templateSectionImageMove";

/** The node type a media body drag moves. One name, shared with updateMediaAttrs. */
export const MEDIA_IMAGE_NODE_NAME = "image";

/** The largest edge the floating drag preview may be drawn at. */
export const MEDIA_DRAG_GHOST_MAX_PX = IMAGE_DRAG_PREVIEW_MAX_PX;

/**
 * Where the floating preview sits for a pointer position — scaled down
 * proportionally past the cap, grab point preserved under the pointer.
 * The proven Template rule, wrapped under its media-core name.
 */
export const mediaDragGhostGeometry = imageDragPreviewGeometry;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** The image node at `pos`, or null when `pos` does not hold one. */
function imageNodeAt(state, pos) {
  if (!state || !state.doc || !Number.isInteger(pos) || pos < 0) return null;
  let node = null;
  try {
    node = state.doc.nodeAt(pos);
  } catch {
    return null;
  }
  if (!node || !node.type || node.type.name !== MEDIA_IMAGE_NODE_NAME) return null;
  return node;
}

/**
 * Is inserting the node at `to` indistinguishable from where it already is?
 * Immediately before the node, immediately after it, and anywhere inside its
 * own range all rebuild the same document — a drop there must be a no-op.
 */
function isSamePlace(from, nodeSize, to) {
  return to >= from && to <= from + nodeSize;
}

/**
 * Resolve the pointer to a candidate destination for the image at `srcPos`.
 *
 * Returns `{ pos }` — a real ProseMirror document position where this block
 * node can legally be inserted — or null when the coordinates resolve nowhere,
 * the node cannot fit anywhere near them, or the resolved point would not
 * actually move the image. Null is what hides the insertion indicator, so the
 * indicator can only ever show a drop the move transaction will accept.
 */
export function resolveMediaDragDestination(view, { x, y, srcPos } = {}) {
  if (!view || typeof view.posAtCoords !== "function" || !view.state) return null;
  if (!finite(x) || !finite(y)) return null;

  const state = view.state;
  const node = imageNodeAt(state, srcPos);
  if (!node) return null;

  let coords = null;
  try {
    coords = view.posAtCoords({ left: x, top: y });
  } catch {
    return null;
  }
  if (!coords || !Number.isInteger(coords.pos)) return null;

  // The nearest position where a slice holding exactly this node fits — the
  // editor's own native drop resolution, reused rather than reinvented.
  let target = null;
  try {
    target = dropPoint(state.doc, coords.pos, new Slice(Fragment.from(node), 0, 0));
  } catch {
    return null;
  }
  if (!Number.isInteger(target)) return null;
  if (isSamePlace(srcPos, node.nodeSize, target)) return null;

  return { pos: target };
}

/**
 * Build the ONE transaction that moves the image at `from` to `to`.
 *
 * `to` is a position in the CURRENT document (as resolved while dragging);
 * the deletion is mapped so a destination past the source lands where the
 * user aimed once the node's own size no longer sits in front of it. The
 * moved node keeps ProseMirror node selection, so the image stays the
 * selected object after the drop exactly as it was while dragging.
 *
 * Returns the transaction, or null when the move is invalid or a no-op —
 * and a null build dispatches NOTHING, so a refused drop cannot create an
 * undo step, an autosave, or any document change at all.
 */
export function buildMediaMoveTransaction(state, { from, to } = {}) {
  const node = imageNodeAt(state, from);
  if (!node) return null;
  if (!Number.isInteger(to) || to < 0 || to > state.doc.content.size) return null;
  if (isSamePlace(from, node.nodeSize, to)) return null;

  try {
    const tr = state.tr;
    tr.delete(from, from + node.nodeSize);
    const mappedTo = tr.mapping.map(to);

    // The destination must still accept the node once the source is gone.
    const $to = tr.doc.resolve(mappedTo);
    const index = $to.index();
    if (!$to.parent.canReplaceWith(index, index, node.type)) return null;

    tr.insert(mappedTo, node);
    tr.setSelection(NodeSelection.create(tr.doc, mappedTo));
    tr.scrollIntoView();
    return tr;
  } catch {
    return null;
  }
}

/**
 * Commit a move: build the one transaction and dispatch it exactly once.
 * `{ ok: false }` means nothing was dispatched and the document is untouched.
 */
export function moveMediaNode(view, { from, to } = {}) {
  if (!view || typeof view.dispatch !== "function" || !view.state) {
    return { ok: false };
  }
  const tr = buildMediaMoveTransaction(view.state, { from, to });
  if (!tr) return { ok: false };
  view.dispatch(tr);
  return { ok: true };
}
