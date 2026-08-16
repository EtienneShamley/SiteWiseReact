// src/lib/templateSectionDocSegments.js
//
// A resolved Section body → the ordered LAYOUT UNITS a page is built from.
//
// A Section document (src/lib/templateSectionDoc.js) is one ordered list of
// text runs, images and files. A page is not: the Template document is a list
// of measured, atomic blocks that PagedDocument flows across real A4 pages
// (src/components/template/PagedDocument.js). This module is the projection
// between the two — the SEGMENTS a body is laid out as:
//
//   text       a run of prose
//   image      one image
//   file       one file card
//   compat     one stored item the document cannot represent, still rendered
//              through the compatibility renderer it already uses
//
// A WRAPPED image and the text that flows beside it are ONE segment. A float
// only wraps text that shares its formatting context, so splitting them across
// two blocks would measure — and paginate — something that cannot exist on the
// page: the text would reflow the moment the two halves landed on different
// pages. Fusing them is the same conservative rule the Free-form editor's page
// guides already apply to wrapped media.
//
// ---------------------------------------------------------------------------
// WHY A LEGACY BODY SEGMENTS ON ITS ITEM BOUNDARIES
// ---------------------------------------------------------------------------
//
// A row whose body is the ordered `sectionContent` list paginates today at ITEM
// boundaries: one block per stored item, each with its own cell padding. The
// adapter merges two adjacent stored TextItems into ONE text node, because in a
// document that is what a stretch of prose between two media nodes is — so
// segmenting purely on media boundaries would silently coarsen the pagination
// of every note that has two adjacent text items, and would drop the gap
// between them.
//
// So when the body carries PROVENANCE (it was adapted from stored items, see
// templateSectionDocAdapter.js), a text run is split back onto the item
// boundaries it was assembled from, and every skipped item is put back at its
// own stored index. The result is exactly the block sequence the row has today
// — same order, same count, same ids — which is what lets the static view and
// the legacy interactive view of one row agree on the page.
//
// A STORED modern document has no provenance and no legacy items, so it
// segments on media boundaries alone, which is the natural granularity of a
// document.
//
// ---------------------------------------------------------------------------
// NOTHING HERE IS STORED
// ---------------------------------------------------------------------------
//
// Segments are a read projection. No page number, no measured height and no
// segment index is ever written into `sectionDoc` or anywhere else — the same
// rule the block planner has always followed (src/lib/templateRowContent.js).
//
// Pure: no React, no DOM, no storage.

import { SECTION_DOC_NODE } from "./templateSectionDoc";
import { SECTION_ITEM_KIND } from "./templateSectionContent";
import { MEDIA_LAYOUT_MODE, normalizeMediaLayout } from "./editorMediaLayout";

/** What one segment renders. */
export const SECTION_SEGMENT_KIND = {
  /** A run of prose (one or more rich-text model blocks). */
  TEXT: "text",
  /** One image. May also carry the text that wraps beside it. */
  IMAGE: "image",
  /** One file card. */
  FILE: "file",
  /**
   * One stored item the document cannot represent, rendered by the
   * compatibility renderer it already uses. Never produced from a document
   * node — only from the reader's `skipped` list.
   */
  COMPAT: "compat",
  /**
   * THE WHOLE BODY, as one live editor.
   *
   * An EditorView needs a single contiguous DOM root, so an ACTIVE Section is
   * one block rather than one block per segment. This segment is never produced
   * from a document node — it is the caller's statement that this row's body is
   * currently being edited (see `sectionEditorSegment`), and it is what lets the
   * existing block planner lay an active Section out through exactly the same
   * path an inactive one takes.
   */
  EDITOR: "editor",
};

/**
 * The single segment an ACTIVE Section plans as.
 *
 * It carries no blocks and no attrs: the live document is the editor's, not a
 * projection of it. `key` is a constant, so the active block keeps ONE React
 * key for the whole editing session — which is what stops the editor being
 * unmounted and remounted (losing its focus and caret) at the moment its first
 * genuine edit changes which stored representation the row's body comes from.
 */
export function sectionEditorSegment({ minHeightPx = 0 } = {}) {
  return {
    kind: SECTION_SEGMENT_KIND.EDITOR,
    key: "editor",
    index: 0,
    blocks: null,
    attrs: null,
    itemId: null,
    itemIndex: null,
    order: 0,
    wrapped: false,
    // The block floor an ACTIVE Section keeps, when the caller wants one. A row
    // still on its LEGACY answer keeps the height the user dragged for it, so
    // clicking into it cannot make the row jump; a row whose body is already a
    // document is content-driven and passes nothing.
    minHeightPx: Number(minHeightPx) > 0 ? Math.round(Number(minHeightPx)) : 0,
  };
}

/** Is this image node placed as a float (and therefore fused with its text)? */
function isWrapped(attrs) {
  return (
    normalizeMediaLayout({
      mode: attrs && attrs.layoutMode,
      side: attrs && attrs.layoutSide,
    }).mode === MEDIA_LAYOUT_MODE.WRAP
  );
}

/**
 * The provenance parts of node `i`, as an array (possibly empty).
 *
 * Defensive rather than trusting: a caller may hand over a body with no
 * provenance at all (a stored modern document), a short array, or a malformed
 * entry — none of which may throw, and all of which mean the same thing here:
 * "this node names no stored item".
 */
function partsFor(sources, i) {
  const parts = Array.isArray(sources) ? sources[i] : null;
  if (!Array.isArray(parts)) return [];
  return parts.filter((p) => p && typeof p === "object");
}

/**
 * Split one text node into the units its stored items contributed, or leave it
 * whole.
 *
 * The split is taken ONLY when the provenance genuinely accounts for every
 * block (the counts sum to the run's length). Anything else — no provenance, a
 * single contributor, or counts that do not add up — leaves the run whole,
 * because a partial split would move prose into the wrong block.
 */
function textUnitsFor(node, parts, fallbackOrder) {
  const blocks = Array.isArray(node.blocks) ? node.blocks : [];
  const usable = parts.filter((p) => Number.isInteger(p.blocks) && p.blocks > 0);
  const total = usable.reduce((sum, p) => sum + p.blocks, 0);

  if (usable.length < 2 || total !== blocks.length) {
    const first = parts[0] || null;
    return [
      {
        kind: SECTION_SEGMENT_KIND.TEXT,
        blocks,
        itemId: first ? first.id || null : null,
        itemIndex: first && Number.isInteger(first.index) ? first.index : null,
        order: first && Number.isInteger(first.index) ? first.index : fallbackOrder,
      },
    ];
  }

  const units = [];
  let cursor = 0;
  for (const part of usable) {
    units.push({
      kind: SECTION_SEGMENT_KIND.TEXT,
      blocks: blocks.slice(cursor, cursor + part.blocks),
      itemId: part.id || null,
      itemIndex: Number.isInteger(part.index) ? part.index : null,
      order: Number.isInteger(part.index) ? part.index : fallbackOrder,
    });
    cursor += part.blocks;
  }
  return units;
}

/** One media node → one unit. */
function mediaUnitFor(node, parts, fallbackOrder) {
  const first = parts[0] || null;
  const known = first && Number.isInteger(first.index);
  return {
    kind:
      node.type === SECTION_DOC_NODE.FILE
        ? SECTION_SEGMENT_KIND.FILE
        : SECTION_SEGMENT_KIND.IMAGE,
    attrs: node.attrs || {},
    blocks: null,
    itemId: first ? first.id || null : null,
    itemIndex: known ? first.index : null,
    order: known ? first.index : fallbackOrder,
  };
}

/** One reported-skipped stored item → one compatibility unit. */
function compatUnitFor(entry, position) {
  const order = Number.isInteger(entry.index) ? entry.index : position;
  return {
    kind: SECTION_SEGMENT_KIND.COMPAT,
    blocks: null,
    attrs: null,
    reason: entry.reason || null,
    itemKind: entry.kind || null,
    entry: entry.entry,
    itemId: entry.id || null,
    itemIndex: order,
    order,
  };
}

/**
 * A resolved Section body → its ordered segments.
 *
 * @param nodes   the body's document nodes (templateSectionDoc.js node model)
 * @param sources the adapter's parallel provenance array, when the body was
 *                adapted from stored items; absent for a stored document
 * @param skipped the reader's list of stored items the document cannot hold
 *
 * @returns an ordered array of segments. Each carries `index` (its position in
 *          this list) and `key` — the stable item id it came from where there
 *          is one, so a segment keeps the SAME identity across renders and
 *          across the switch between the static and the legacy interactive
 *          rendering of the same row.
 */
export function sectionDocSegments({ nodes, sources, skipped } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const units = [];

  list.forEach((node, i) => {
    if (!node || typeof node !== "object") return;
    const parts = partsFor(sources, i);
    if (node.type === SECTION_DOC_NODE.TEXT) {
      units.push(...textUnitsFor(node, parts, i));
      return;
    }
    if (node.type === SECTION_DOC_NODE.IMAGE || node.type === SECTION_DOC_NODE.FILE) {
      units.push(mediaUnitFor(node, parts, i));
    }
  });

  // Compatibility material is interleaved by the stored index it names, so an
  // unrepresentable item stays exactly where the user has always seen it. When
  // the body is a stored document there are no stored indices to interleave
  // against (see the reader) and these land after the document instead —
  // visible, never duplicated, never dropped.
  const hasProvenance = units.some((u) => Number.isInteger(u.itemIndex) && u.itemIndex >= 0);
  const compat = (Array.isArray(skipped) ? skipped : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, position) => compatUnitFor(entry, position));

  let ordered;
  if (hasProvenance && compat.length) {
    // A stable merge on the stored index: equal indices keep document order
    // first, which is the order the adapter itself walked.
    ordered = [...units, ...compat]
      .map((unit, position) => ({ unit, position }))
      .sort((a, b) => a.unit.order - b.unit.order || a.position - b.position)
      .map((x) => x.unit);
  } else {
    ordered = [...units, ...compat];
  }

  // A float and the prose that flows beside it are measured as one box.
  const fused = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const unit = ordered[i];
    const next = ordered[i + 1];
    if (
      unit.kind === SECTION_SEGMENT_KIND.IMAGE &&
      isWrapped(unit.attrs) &&
      next &&
      next.kind === SECTION_SEGMENT_KIND.TEXT
    ) {
      fused.push({ ...unit, wrapped: true, blocks: next.blocks });
      i += 1;
      continue;
    }
    fused.push(
      unit.kind === SECTION_SEGMENT_KIND.IMAGE
        ? { ...unit, wrapped: isWrapped(unit.attrs) }
        : unit
    );
  }

  return fused.map((unit, index) => ({
    ...unit,
    index,
    key: unit.itemId || `seg-${index}`,
  }));
}

/**
 * Which stored item kind a compatibility segment stands in for.
 *
 * The reader reports the kind it read; a legacy evidence entry that was never
 * carryable reports none, and a bare string entry is a legacy base64 image by
 * definition (the only shape that has ever existed). Photo is therefore the
 * answer whenever nothing more specific is known — which matches what the
 * legacy renderer does with the same entry.
 */
export function compatSegmentItemKind(segment) {
  if (!segment) return SECTION_ITEM_KIND.PHOTO;
  if (segment.itemKind === SECTION_ITEM_KIND.FILE) return SECTION_ITEM_KIND.FILE;
  return SECTION_ITEM_KIND.PHOTO;
}
