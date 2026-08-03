// src/lib/templateExportPagination.js
//
// Deterministic page safety for the Template PDF export.
//
// A Template row may hold an answer taller than one usable A4 page. Silent
// clipping is not an acceptable outcome, so a row that does not fit is SPLIT
// into continuation fragments at safe content boundaries — paragraphs, list
// items and lines — before it ever reaches the PDF renderer:
//
//   - the field label stays on the FIRST fragment;
//   - later fragments carry a restrained "Label — continued" context, matching
//     the wording the on-screen paged document already uses for a compound
//     field that resumes on a new page;
//   - document order is preserved and every unit appears EXACTLY ONCE — nothing
//     is duplicated at a boundary and nothing is dropped;
//   - a Photo is scaled down proportionally (width only, aspect ratio intact)
//     so a single image can always fit the usable page area;
//   - content that genuinely cannot be split small enough is a FAILURE, not a
//     truncation. The caller stops the export.
//
// Splitting a paragraph at a hard line break turns that break into a paragraph
// boundary, which is the closest faithful rendering available when the two
// halves land on different pages. Splitting an ordered list carries the running
// number forward (`listStart`) so continuation items are not renumbered from 1.
//
// Pure: no React, no DOM, no storage. The height oracle is INJECTED (`fits`),
// so every rule here is unit-testable without a browser, while the real runner
// supplies a measurement against a real offscreen layout.

import { EXPORT_UNIT } from "./templateExportModel";

export const FRAGMENT_FAILURE = { UNSPLITTABLE: "unsplittable" };

export const CONTINUED_SUFFIX = " — continued";

/* ------------------------------------------------------------------------ */
/* Row minimum height                                                        */
/* ------------------------------------------------------------------------ */

// The live document's row default (ResizableTwoColTable: `row.px || 120`). A
// Template row is a PAGE OBJECT, not just a container for its answer: an empty
// row still occupies the height the template author gave it. The export must
// honour that or a completed report collapses to a fraction of its real length
// — which is exactly the defect this module's caller previously shipped.
export const DEFAULT_ROW_HEIGHT_PX = 120;

/**
 * A stored row height turned into something safe to lay out with.
 *
 * `row.px` comes from the pinned template version and is authoritative whenever
 * it is a real positive number; anything else (absent, 0, negative, NaN,
 * Infinity, a string) falls back to the same 120 px default the live document
 * uses. The result is clamped to `maxPx` — the usable page height less the
 * reserved footer — so a corrupt or absurd stored height can never make a row
 * unplaceable on any page.
 */
export function normalizeRowHeightPx(value, maxPx) {
  const raw = Number(value);
  const base =
    Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ROW_HEIGHT_PX;
  const max = Number(maxPx);
  const ceiling = Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity;
  return Math.max(1, Math.min(Math.round(base), ceiling));
}

// Splitting halves its input, so a legitimate split terminates quickly. The cap
// exists so a degenerate `fits` oracle can never recurse without bound.
const MAX_SPLIT_DEPTH = 24;

export function continuationLabel(label) {
  const text = typeof label === "string" ? label.trim() : "";
  return text ? `${text}${CONTINUED_SUFFIX}` : "";
}

/* ------------------------------------------------------------------------ */
/* Photo fitting                                                             */
/* ------------------------------------------------------------------------ */

/**
 * The width one photo may occupy so that its height cannot exceed the usable
 * page area. Only WIDTH is ever produced, so the aspect ratio is preserved
 * structurally — there is no code path that can stretch or crop the image.
 */
export function photoLayout(unit, { contentWidthPx, maxHeightPx }) {
  const width = Number(contentWidthPx) > 0 ? Number(contentWidthPx) : 0;
  const maxHeight = Number(maxHeightPx) > 0 ? Number(maxHeightPx) : 0;
  const pct = Math.max(1, Math.min(100, Number(unit?.widthPct) || 100));

  let widthPx = (width * pct) / 100;

  const iw = Number(unit?.intrinsicWidth);
  const ih = Number(unit?.intrinsicHeight);
  const ratioKnown = iw > 0 && ih > 0;
  if (ratioKnown && maxHeight > 0) {
    // Exact cap: at this width the image is exactly maxHeight tall.
    const widthAtMaxHeight = maxHeight * (iw / ih);
    if (widthPx > widthAtMaxHeight) widthPx = widthAtMaxHeight;
  }
  if (width > 0) widthPx = Math.min(widthPx, width);

  const finalWidth = Math.max(1, Math.floor(widthPx));

  return {
    widthPx: finalWidth,
    // Derived from the SAME intrinsic ratio, never chosen independently, so the
    // image cannot be stretched or squashed. Emitting it makes the exported
    // layout deterministic: the row's height no longer depends on when the
    // browser happens to decode the image.
    heightPx: ratioKnown ? Math.max(1, Math.round(finalWidth * (ih / iw))) : null,
    // Enforced by CSS as well, so an image with unknown intrinsic dimensions
    // still cannot exceed the page (it scales down, never crops).
    maxHeightPx: maxHeight || null,
    ratioKnown,
  };
}

/* ------------------------------------------------------------------------ */
/* Splitting one unit                                                        */
/* ------------------------------------------------------------------------ */

function paragraphPiece(block, content) {
  return {
    type: EXPORT_UNIT.BLOCK,
    block: { type: "paragraph", align: block.align || "left", content },
  };
}

function listPiece(block, items, start) {
  const piece = { type: block.type, items };
  if (block.type === "orderedList") piece.start = start;
  return { type: EXPORT_UNIT.BLOCK, block: piece };
}

// Split one text node's text at the word boundary nearest the middle. Marks are
// carried onto both halves unchanged, so the two pieces render exactly as the
// original did apart from the line they fall on.
function splitTextNode(node) {
  const text = typeof node.text === "string" ? node.text : "";
  if (text.length < 2) return null;
  const middle = Math.floor(text.length / 2);
  let cut = text.lastIndexOf(" ", middle);
  if (cut <= 0) cut = text.indexOf(" ", middle);
  if (cut <= 0 || cut >= text.length - 1) return null;
  return [
    { ...node, text: text.slice(0, cut) },
    { ...node, text: text.slice(cut + 1) },
  ];
}

function splitParagraph(block) {
  const content = Array.isArray(block.content) ? block.content : [];

  // 1. Hard line breaks are real line boundaries and are the safest cut.
  if (content.some((n) => n && n.type === "break")) {
    const groups = [];
    let group = [];
    for (const node of content) {
      if (node && node.type === "break") {
        groups.push(group);
        group = [];
        continue;
      }
      group.push(node);
    }
    groups.push(group);
    if (groups.length > 1) return groups.map((g) => paragraphPiece(block, g));
  }

  // 2. Several inline runs: cut between two of them.
  if (content.length > 1) {
    const middle = Math.ceil(content.length / 2);
    return [
      paragraphPiece(block, content.slice(0, middle)),
      paragraphPiece(block, content.slice(middle)),
    ];
  }

  // 3. One very long run: cut it at a word boundary, keeping its marks.
  if (content.length === 1 && content[0] && content[0].type === "text") {
    const halves = splitTextNode(content[0]);
    if (halves) {
      return [
        paragraphPiece(block, [halves[0]]),
        paragraphPiece(block, [halves[1]]),
      ];
    }
  }

  return [];
}

function splitList(block) {
  const items = Array.isArray(block.items) ? block.items : [];
  // A LIST ITEM is the boundary. A single item taller than a page cannot be
  // divided without inventing a second bullet the author never wrote, so it is
  // reported as unsplittable rather than silently restructured.
  if (items.length < 2) return [];
  const start = Number(block.start) > 0 ? Number(block.start) : 1;
  const middle = Math.ceil(items.length / 2);
  return [
    listPiece(block, items.slice(0, middle), start),
    listPiece(block, items.slice(middle), start + middle),
  ];
}

/**
 * Split one unit into smaller units of the same meaning, or return [] when it
 * is atomic. Photos, files, structured values and the empty state are atomic.
 */
export function splitUnit(unit) {
  if (!unit || unit.type !== EXPORT_UNIT.BLOCK) return [];
  const block = unit.block;
  if (!block) return [];
  if (block.type === "paragraph") return splitParagraph(block);
  if (block.type === "bulletList" || block.type === "orderedList") {
    return splitList(block);
  }
  return [];
}

/* ------------------------------------------------------------------------ */
/* Distributing a row's units across fragments                               */
/* ------------------------------------------------------------------------ */

/**
 * Greedily fill fragments, splitting only what genuinely does not fit.
 *
 * @param units the row's ordered units
 * @param fits  (units) => boolean — does a fragment holding these units fit?
 * @returns {{ok: true, fragments: Array}} | {{ok: false, reason}}
 */
export function fragmentRowUnits(units, fits) {
  const list = Array.isArray(units) ? units : [];
  const fragments = [];
  let current = [];

  const flush = () => {
    if (current.length) {
      fragments.push(current);
      current = [];
    }
  };

  const place = (unit, depth) => {
    if (depth > MAX_SPLIT_DEPTH) return false;

    const candidate = current.concat([unit]);
    if (fits(candidate)) {
      current = candidate;
      return true;
    }

    // It did not fit alongside what is already on this fragment: start a new
    // one. Nothing is dropped and nothing is repeated — `current` is emitted
    // exactly once and this unit has not been added to it.
    flush();

    if (fits([unit])) {
      current = [unit];
      return true;
    }

    const pieces = splitUnit(unit);
    if (pieces.length < 2) return false; // atomic, or already indivisible
    for (const piece of pieces) {
      if (!place(piece, depth + 1)) return false;
    }
    return true;
  };

  for (const unit of list) {
    if (!place(unit, 0)) {
      return { ok: false, reason: FRAGMENT_FAILURE.UNSPLITTABLE };
    }
  }
  flush();

  if (fragments.length === 0) fragments.push([]);
  return { ok: true, fragments };
}

/**
 * A row as one or more page-safe fragments. A row that already fits produces
 * exactly one fragment and is completely unchanged.
 *
 * THE ROW'S MINIMUM HEIGHT APPLIES ONCE, TO THE FIRST FRAGMENT ONLY. A row is
 * only ever fragmented because its content is taller than a whole page, so its
 * stored height has already been exceeded; re-applying it to each continuation
 * would multiply one row's 120 px into 120 px per page of blank space. Later
 * fragments therefore carry `preferredHeightPx: 0` and are sized purely by their
 * own content — and `continued: true` makes the renderer emit no minimum box, so
 * measurement and markup agree without either having to special-case the value.
 */
export function fragmentRow(row, fits) {
  const result = fragmentRowUnits(row?.units, fits);
  if (!result.ok) return result;
  return {
    ok: true,
    fragments: result.fragments.map((units, index) => ({
      ...row,
      label: index === 0 ? row.label : continuationLabel(row.label),
      continued: index > 0,
      preferredHeightPx: index === 0 ? row.preferredHeightPx : 0,
      units,
    })),
  };
}

/**
 * Fragment every row of a canonical model. `fits` is called with
 * `(row, units)` so a measurement can render the row's real label column.
 */
export function fragmentModelRows(rows, fits) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const result = fragmentRow(row, (units) => fits(row, units));
    if (!result.ok) return result;
    out.push(...result.fragments);
  }
  return { ok: true, fragments: out };
}

/**
 * Every unit of every fragment, in order — the invariant an exported document
 * must satisfy: the fragments together are exactly the original content.
 */
export function flattenFragmentUnits(fragments) {
  const out = [];
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    for (const unit of fragment.units || []) out.push(unit);
  }
  return out;
}
