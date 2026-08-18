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
//      slot, never a synthetic zone. Phase C3 adds the LAYOUT the pointer asked
//      for (block / wrap-left / wrap-right, derived by the caller from
//      editorMediaPlacement.js): a wrap request is honoured only when the text
//      that would flow beside the image actually exists — the first block after
//      the anchor must be a non-empty textblock — and otherwise degrades to
//      block, so the indicator can never promise a wrap that would render as
//      an image with nothing beside it. A destination that would reproduce the
//      current document EXACTLY (same place, same layout) is not a destination
//      at all — the indicator must never promise a drop the transaction would
//      then refuse. Same place with a DIFFERENT layout is a real destination:
//      that is how an image is swept block → wrap-left without moving.
//
//   2. THE MOVE. One transaction: delete the node at its source, map the
//      destination through that deletion, insert THE SAME node content at the
//      mapped position — with only the two layout attributes replaced when the
//      drop chose a new layout, so position and layout always change together
//      in one undo step. Mapping is what makes "destination after the source"
//      land correctly once the source is gone. Every other attribute
//      (assetId/src, widthPct, intrinsic dimensions, alt, title) travels
//      untouched — nothing else is recreated, no asset is read, written or
//      deleted, and no new assetId can exist. A drop that only changes layout
//      at the same position is a single setNodeMarkup — still one transaction,
//      one undo step, one autosave, dispatched by the caller's surface exactly
//      as any other edit.
//
// The ghost geometry (how large the floating preview is drawn, and where) was
// proven on Template section images. Until Phase G it was re-exported here
// wrapping the legacy `templateSectionImageMove.js`; Phase G retired that
// interaction and the geometry now lives HERE, unchanged in behaviour — exactly
// as editorMediaResize.js now owns the resize arithmetic.
//
// No React, no DOM, no storage: the view is injected, and everything else is
// ProseMirror state in and ProseMirror transactions out.

import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import { MEDIA_LAYOUT_MODE, normalizeMediaLayout } from "./editorMediaLayout";

/** The node type a media body drag moves. One name, shared with updateMediaAttrs. */
export const MEDIA_IMAGE_NODE_NAME = "image";

/**
 * The largest edge the floating drag preview may be drawn at.
 *
 * A document image is commonly the full width of the content column, and a
 * ghost that size would cover the document the user is trying to aim at —
 * including the insertion indicator that tells them where it will land. So a
 * large image's preview is scaled DOWN, proportionally; a small one is shown at
 * its real size. It is a preview of the thing being held, not a second copy of
 * the page.
 */
export const MEDIA_DRAG_GHOST_MAX_PX = 240;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function usableRect(rect) {
  if (!rect) return null;
  const { left, top, width, height } = rect;
  if (!finite(left) || !finite(top) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/**
 * Where the floating preview sits for a pointer position — scaled down
 * proportionally past the cap, grab point preserved under the pointer.
 *
 * The preview exists so the image feels HELD: it follows the pointer, keeps the
 * proportions of the picture on the page, and stays under the same point of the
 * image the user pressed on (scaled with it), so it does not jump to a corner
 * the moment the gesture arms.
 *
 * Purely presentational — this decides pixels on the screen and nothing else.
 * It touches no document and no stored data, and the original node keeps its
 * place while it is shown, so the layout underneath never moves.
 *
 * Returns null for an unusable rect or point, and a caller then simply draws no
 * preview: a drag with no ghost is still a working drag.
 */
export function mediaDragGhostGeometry({
  rect,
  grabX,
  grabY,
  clientX,
  clientY,
  maxPx = MEDIA_DRAG_GHOST_MAX_PX,
} = {}) {
  const box = usableRect(rect);
  if (!box) return null;
  if (!finite(clientX) || !finite(clientY)) return null;

  const limit = finite(maxPx) && maxPx > 0 ? maxPx : MEDIA_DRAG_GHOST_MAX_PX;
  // Scaled by WIDTH only, and height follows — the aspect ratio is preserved by
  // construction rather than by clamping two dimensions independently.
  const scale = box.width > limit ? limit / box.width : 1;
  const width = box.width * scale;
  const height = box.height * scale;

  // The grab point, in the preview's own coordinates. An unusable grab point
  // falls back to the centre, which is still "held" rather than misplaced.
  const offsetX = finite(grabX) ? (grabX - box.left) * scale : width / 2;
  const offsetY = finite(grabY) ? (grabY - box.top) * scale : height / 2;

  return {
    left: clientX - offsetX,
    top: clientY - offsetY,
    width,
    height,
  };
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
 * own range all rebuild the same document — a drop there moves nothing (it may
 * still change LAYOUT; the callers below decide that separately).
 */
function isSamePlace(from, nodeSize, to) {
  return to >= from && to <= from + nodeSize;
}

/** The node's own stored layout, normalized through the shared vocabulary. */
function currentLayoutOf(node) {
  return normalizeMediaLayout({
    mode: node && node.attrs ? node.attrs.layoutMode : undefined,
    side: node && node.attrs ? node.attrs.layoutSide : undefined,
  });
}

function sameLayout(a, b) {
  return a.mode === b.mode && a.side === b.side;
}

/**
 * Is there text at the anchor that a wrapped image could actually flow beside?
 *
 * A float wraps the content that FOLLOWS it, so the question is asked of the
 * first node after the insertion point — skipping the dragged image itself
 * when the anchor sits immediately before it (the same-place layout change).
 * Only a non-empty textblock counts: wrapping against another image, a table,
 * a file card or an empty paragraph would render an image with nothing beside
 * it, which is block placement wearing a wrap label.
 */
export function wrapTargetHasText(state, target, srcPos) {
  const src = imageNodeAt(state, srcPos);
  let pos = target;
  if (src && pos >= srcPos && pos <= srcPos + src.nodeSize) {
    // Anywhere at/inside the source resolves to "the text after the image".
    pos = srcPos + src.nodeSize;
  }
  let after = null;
  try {
    after = state.doc.resolve(pos).nodeAfter;
  } catch {
    return false;
  }
  return !!(after && after.isTextblock && (after.textContent || "").trim() !== "");
}

/**
 * Resolve the pointer to a candidate destination for the image at `srcPos`.
 *
 * `layout` is the placement the pointer geometry asked for (see
 * editorMediaPlacement.js); absent, it means block — the C2 contract
 * unchanged. Returns `{ pos, layout }` — a real ProseMirror document position
 * where this block node can legally be inserted, plus the layout the drop will
 * commit (the request, degraded to block when no wrappable text exists at the
 * anchor) — or null when the coordinates resolve nowhere, the node cannot fit
 * anywhere near them, or the resolved point would change neither position nor
 * layout. Null is what hides the drop indicator, so the indicator can only
 * ever show a drop the move transaction will accept.
 */
export function resolveMediaDragDestination(view, { x, y, srcPos, layout } = {}) {
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

  // The layout this drop would actually commit: the request, degraded to
  // block when the anchor has no text to wrap.
  let effective = normalizeMediaLayout(layout || {});
  if (effective.mode === MEDIA_LAYOUT_MODE.WRAP && !wrapTargetHasText(state, target, srcPos)) {
    effective = normalizeMediaLayout({});
  }

  // Same place AND same layout would rebuild the identical document.
  if (isSamePlace(srcPos, node.nodeSize, target) && sameLayout(effective, currentLayoutOf(node))) {
    return null;
  }

  return { pos: target, layout: effective };
}

/**
 * Build the ONE transaction that moves the image at `from` to `to`, applying
 * `layout` (block / wrap-left / wrap-right) as it lands.
 *
 * `to` is a position in the CURRENT document (as resolved while dragging);
 * the deletion is mapped so a destination past the source lands where the
 * user aimed once the node's own size no longer sits in front of it. The
 * moved node keeps ProseMirror node selection, so the image stays the
 * selected object after the drop exactly as it was while dragging.
 *
 * `layout` absent means "keep the layout the node already has" — the C2
 * contract unchanged. When present it is normalized as one unit and replaces
 * ONLY layoutMode/layoutSide; every other attribute (assetId/src, widthPct,
 * intrinsic dimensions, alt, title) is carried through untouched. Position
 * and layout therefore always commit — and undo — TOGETHER.
 *
 * A drop at the same place with a changed layout is a single setNodeMarkup on
 * the node where it stands: still exactly one transaction.
 *
 * Returns the transaction, or null when the drop would change nothing — and a
 * null build dispatches NOTHING, so a refused drop cannot create an undo
 * step, an autosave, or any document change at all.
 */
export function buildMediaMoveTransaction(state, { from, to, layout } = {}) {
  const node = imageNodeAt(state, from);
  if (!node) return null;
  if (!Number.isInteger(to) || to < 0 || to > state.doc.content.size) return null;

  const nextLayout =
    layout === undefined || layout === null
      ? currentLayoutOf(node)
      : normalizeMediaLayout(layout);
  const layoutChanged = !sameLayout(nextLayout, currentLayoutOf(node));
  const attrs = layoutChanged
    ? { ...node.attrs, layoutMode: nextLayout.mode, layoutSide: nextLayout.side }
    : node.attrs;

  try {
    if (isSamePlace(from, node.nodeSize, to)) {
      // Nothing moves. A changed layout is committed on the node where it
      // stands; an unchanged one is no drop at all.
      if (!layoutChanged) return null;
      const tr = state.tr;
      tr.setNodeMarkup(from, null, attrs, node.marks);
      tr.setSelection(NodeSelection.create(tr.doc, from));
      tr.scrollIntoView();
      return tr;
    }

    const moved = layoutChanged
      ? node.type.create(attrs, node.content, node.marks)
      : node;

    const tr = state.tr;
    tr.delete(from, from + node.nodeSize);
    const mappedTo = tr.mapping.map(to);

    // The destination must still accept the node once the source is gone.
    const $to = tr.doc.resolve(mappedTo);
    const index = $to.index();
    if (!$to.parent.canReplaceWith(index, index, node.type)) return null;

    tr.insert(mappedTo, moved);
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
export function moveMediaNode(view, { from, to, layout } = {}) {
  if (!view || typeof view.dispatch !== "function" || !view.state) {
    return { ok: false };
  }
  const tr = buildMediaMoveTransaction(view.state, { from, to, layout });
  if (!tr) return { ok: false };
  view.dispatch(tr);
  return { ok: true };
}
