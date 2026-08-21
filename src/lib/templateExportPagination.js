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
//     truncation. The caller stops the export;
//   - the document vocabulary splits at ITS safe boundaries — task-list items,
//     a quote's inner blocks, code-block lines, complete table rows that break
//     no rowspan — and a heading or a rule is atomic (see `splitUnit`).
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
 *
 * A WRAP unit — a wrapped modern Section image fused with the text beside it —
 * is a GROUP that is kept whole whenever it fits one page (the caller only
 * splits a unit that cannot fit a page on its own). When it cannot, it degrades
 * DETERMINISTICALLY the way the Free-form PDF degrades a wrap group that cannot
 * fit a page: the image becomes a block photo and the text blocks stand on their
 * own, splittable as text always is. Nothing is dropped, nothing is repeated,
 * and the semantic order — image, then its text — is preserved.
 */
export function splitUnit(unit) {
  if (!unit) return [];
  if (unit.type === EXPORT_UNIT.WRAP) {
    const pieces = [];
    if (unit.photo) pieces.push(unit.photo);
    for (const block of Array.isArray(unit.blocks) ? unit.blocks : []) {
      pieces.push(block);
    }
    return pieces;
  }
  if (unit.type !== EXPORT_UNIT.BLOCK) return [];
  const block = unit.block;
  if (!block) return [];
  if (block.type === "paragraph") return splitParagraph(block);
  if (block.type === "bulletList" || block.type === "orderedList") {
    return splitList(block);
  }
  // THE DOCUMENT VOCABULARY (2026-08-18) — each with a deterministic policy:
  //   heading          atomic (a heading taller than a page is not real content)
  //   horizontal rule  atomic
  //   task list        at ITEM boundaries, exactly like a list
  //   blockquote       at its inner block boundaries, then inside one block —
  //                    every piece stays a quote
  //   code block       at LINE boundaries, byte-preserving; one line is atomic
  //   table            at complete ROW boundaries that break no rowspan (the
  //                    same rowspan-safe rule the Free-form PDF applies); a
  //                    table with no safe cut is atomic and, if it cannot fit
  //                    a page, is a reported failure — never clipped
  if (block.type === "taskList") return splitTaskList(block);
  if (block.type === "blockquote") return splitBlockquote(block);
  if (block.type === "codeBlock") return splitCodeBlock(block);
  if (block.type === "table") return splitTable(block);
  return [];
}

function blockUnit(block) {
  return { type: EXPORT_UNIT.BLOCK, block };
}

function splitTaskList(block) {
  const items = Array.isArray(block.items) ? block.items : [];
  if (items.length < 2) return [];
  const middle = Math.ceil(items.length / 2);
  return [
    blockUnit({ type: "taskList", items: items.slice(0, middle) }),
    blockUnit({ type: "taskList", items: items.slice(middle) }),
  ];
}

function splitBlockquote(block) {
  const blocks = Array.isArray(block.blocks) ? block.blocks : [];
  if (blocks.length >= 2) {
    const middle = Math.ceil(blocks.length / 2);
    return [
      blockUnit({ type: "blockquote", blocks: blocks.slice(0, middle) }),
      blockUnit({ type: "blockquote", blocks: blocks.slice(middle) }),
    ];
  }
  if (blocks.length === 1) {
    return splitUnit(blockUnit(blocks[0])).map((piece) =>
      blockUnit({ type: "blockquote", blocks: [piece.block] })
    );
  }
  return [];
}

function splitCodeBlock(block) {
  const text = typeof block.text === "string" ? block.text : "";
  const lines = text.split("\n");
  if (lines.length < 2) return [];
  const middle = Math.ceil(lines.length / 2);
  return [
    blockUnit({ type: "codeBlock", language: block.language || null, text: lines.slice(0, middle).join("\n") }),
    blockUnit({ type: "codeBlock", language: block.language || null, text: lines.slice(middle).join("\n") }),
  ];
}

/**
 * Row counts at which a table may be divided without breaking a rowspan: a
 * cell that spans past the cut cannot be honoured on either side, so that
 * boundary is simply not offered.
 */
export function safeTableRowSplitPoints(rows) {
  const safe = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let k = 1; k < list.length; k += 1) {
    let ok = true;
    for (let i = 0; i < k && ok; i += 1) {
      for (const cell of (list[i] && list[i].cells) || []) {
        const span = Number(cell && cell.rowspan);
        if (Number.isFinite(span) && span > 1 && i + span > k) {
          ok = false;
          break;
        }
      }
    }
    if (ok) safe.push(k);
  }
  return safe;
}

function splitTable(block) {
  const rows = Array.isArray(block.rows) ? block.rows : [];
  if (rows.length < 2) return [];
  const points = safeTableRowSplitPoints(rows);
  if (!points.length) return [];
  // The safe cut nearest the middle.
  const middle = rows.length / 2;
  let cut = points[0];
  for (const point of points) {
    if (Math.abs(point - middle) < Math.abs(cut - middle)) cut = point;
  }
  return [
    blockUnit({ type: "table", rows: rows.slice(0, cut) }),
    blockUnit({ type: "table", rows: rows.slice(cut) }),
  ];
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
    // Atomic, or already indivisible. (A WRAP unit with no beside-text
    // legitimately degrades to ONE smaller piece — its block photo — which is
    // why "at least one piece" rather than "at least two" is the guard; every
    // other splittable unit yields two or more, and the depth cap above bounds
    // any degenerate oracle.)
    if (pieces.length < 1) return false;
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
  // A row DIVIDED INTO SEVERAL CELLS is ATOMIC, exactly as it is on screen (see
  // planRowBlocks). Its cells sit side by side across the page and their content
  // has no single vertical order, so there is no boundary at which such a row
  // could be cut without either interleaving two cells' text or dropping every
  // cell but the first. A divided row that genuinely cannot fit a page therefore
  // FAILS the export through the existing unsplittable path — the same rule this
  // module already applies to any content it cannot divide safely: nothing is
  // ever clipped and nothing is ever silently lost.
  if (Array.isArray(row?.cells) && row.cells.length > 1) {
    return { ok: false, reason: FRAGMENT_FAILURE.UNSPLITTABLE };
  }
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
