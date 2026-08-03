// src/lib/freeformExportBlocks.js
//
// The Free-form note's PDF BLOCK MODEL and its fragmentation rules.
//
// This is the Free-form half of the export architecture recorded in
// docs/PROJECT_DECISIONS.md → "Free-form PDF pagination uses measured block
// planning". It deliberately shares NOTHING with the Template row/unit model
// (src/lib/templateExportPagination.js): a Template row is a labelled page
// object, a Free-form block is a rich-text element, and the two fragment at
// completely different boundaries.
//
// What it does:
//   1. Turns the already-resolved export HTML into an ORDERED list of top-level
//      blocks. Order is source order and nothing is flattened to plain text —
//      every inline mark, link, colour and hard break survives untouched,
//      because a block IS its original element, serialized.
//   2. Splits a block that is taller than the space available at safe
//      STRUCTURAL boundaries only — never at a rendered line, never at a raw
//      string index:
//        paragraphs / headings -> whole words and hard breaks
//        lists                 -> top-level list items (then inside one item)
//        blockquotes           -> contained blocks (then inside one block)
//        code                  -> newlines, byte-preserving
//        tables                -> complete rows, rowspan-aware
//      A block that cannot be divided is reported, never clipped.
//
// Splitting is DOM-aware throughout. A paragraph is sliced by walking its own
// node tree and keeping a range of word/break/image ATOMS, so `<strong>`,
// `<a href>`, `<code>` and nested inline structure are preserved on both sides
// and the concatenated text of the fragments is byte-identical to the original.
//
// The height oracle is INJECTED. Every candidate this module proposes is
// measured before it is accepted, so the search is deterministic and directly
// unit-testable without a browser — but it is this module, not the test, that
// decides where a fragment ends.
//
// Pure with respect to the application: it parses into a DETACHED, inert
// document (no resource loads, no script execution) and never touches the
// editor, the stored note HTML or the stored assets.

import { EXPORT_ATTACHMENT_CLASS } from "./exportFileAttachments";
import { EXPORT_IMAGE_PLACEHOLDER_CLASS } from "./editorImageAssets";

/* ------------------------------------------------------------------------ */
/* Kinds                                                                     */
/* ------------------------------------------------------------------------ */

export const FREEFORM_BLOCK = Object.freeze({
  HEADING: "heading",
  PARAGRAPH: "paragraph",
  IMAGE: "image",
  FILE_CARD: "fileCard",
  LIST: "list",
  BLOCKQUOTE: "blockquote",
  CODE: "code",
  TABLE: "table",
  RULE: "rule",
  OTHER: "other",
});

export const FREEFORM_FRAGMENT_FAILURE = Object.freeze({
  UNSPLITTABLE: "unsplittable",
});

// Re-exported, never re-declared: the classes come from the modules that EMIT
// them, so the block model and the resolvers can never drift apart.
export const FILE_CARD_CLASS = EXPORT_ATTACHMENT_CLASS;
export const IMAGE_PLACEHOLDER_CLASS = EXPORT_IMAGE_PLACEHOLDER_CLASS;

// A split halves its input, so a legitimate split terminates quickly. The cap
// exists so a degenerate height oracle can never recurse without bound.
const MAX_SPLIT_DEPTH = 24;

/* ------------------------------------------------------------------------ */
/* Detached parsing                                                          */
/* ------------------------------------------------------------------------ */

// A detached document: parsing here loads no resources and runs no script.
export function createInertDocument() {
  return document.implementation.createHTMLDocument("");
}

function parseInto(html, doc) {
  const container = doc.createElement("div");
  container.innerHTML = typeof html === "string" ? html : "";
  return container;
}

function parseElement(html, doc) {
  const container = parseInto(html, doc);
  return container.firstElementChild;
}

/* ------------------------------------------------------------------------ */
/* Classification                                                            */
/* ------------------------------------------------------------------------ */

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

function hasClass(el, name) {
  return !!(el && el.classList && el.classList.contains(name));
}

// A paragraph that holds nothing but one image is an IMAGE block: it must move
// whole rather than being sliced as though it were text.
function isImageOnlyParagraph(el) {
  if (el.tagName !== "P") return false;
  if ((el.textContent || "").trim() !== "") return false;
  const images = el.querySelectorAll("img");
  return images.length === 1;
}

export function classifyBlockElement(el) {
  if (!el || el.nodeType !== 1) return FREEFORM_BLOCK.OTHER;
  const tag = el.tagName;
  if (HEADING_TAGS.has(tag)) return FREEFORM_BLOCK.HEADING;
  if (tag === "IMG") return FREEFORM_BLOCK.IMAGE;
  if (tag === "HR") return FREEFORM_BLOCK.RULE;
  if (tag === "PRE") return FREEFORM_BLOCK.CODE;
  if (tag === "TABLE") return FREEFORM_BLOCK.TABLE;
  if (tag === "BLOCKQUOTE") return FREEFORM_BLOCK.BLOCKQUOTE;
  if (tag === "UL" || tag === "OL") return FREEFORM_BLOCK.LIST;
  if (hasClass(el, FILE_CARD_CLASS)) return FREEFORM_BLOCK.FILE_CARD;
  if (hasClass(el, IMAGE_PLACEHOLDER_CLASS)) return FREEFORM_BLOCK.IMAGE;
  if (tag === "P") {
    return isImageOnlyParagraph(el)
      ? FREEFORM_BLOCK.IMAGE
      : FREEFORM_BLOCK.PARAGRAPH;
  }
  // An unknown but safe block element is kept whole and visible rather than
  // dropped — a deterministic fallback, never a silent omission.
  return FREEFORM_BLOCK.OTHER;
}

const SPLITTABLE_KINDS = new Set([
  FREEFORM_BLOCK.PARAGRAPH,
  FREEFORM_BLOCK.HEADING,
  FREEFORM_BLOCK.LIST,
  FREEFORM_BLOCK.BLOCKQUOTE,
  FREEFORM_BLOCK.CODE,
  FREEFORM_BLOCK.TABLE,
]);

export function kindIsSplittable(kind) {
  return SPLITTABLE_KINDS.has(kind);
}

/* ------------------------------------------------------------------------ */
/* Extraction                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The resolved export HTML as an ordered block list.
 *
 * Top-level element children become blocks in source order. Loose top-level
 * text (which the editor does not produce, but which stored legacy HTML might)
 * is wrapped in a paragraph rather than discarded.
 *
 * Every block carries its own serialized HTML, so the planner, the fragmenter
 * and the final page renderer all work on exactly the same representation —
 * the planner can never measure one thing and render another.
 */
export function extractFreeformBlocks(html, deps = {}) {
  const doc = (deps.createDocument || createInertDocument)();
  const container = parseInto(html, doc);
  const blocks = [];

  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === 3) {
      const text = node.data;
      if (!text || !text.trim()) continue;
      const p = doc.createElement("p");
      p.textContent = text;
      blocks.push(makeBlock(p, blocks.length));
      continue;
    }
    if (node.nodeType !== 1) continue;
    blocks.push(makeBlock(node, blocks.length));
  }

  return blocks;
}

function makeBlock(el, index) {
  const kind = classifyBlockElement(el);
  return {
    id: `nw-ff-b${index}`,
    kind,
    html: el.outerHTML,
    // A heading must not be stranded alone at the foot of a page.
    keepWithNext: kind === FREEFORM_BLOCK.HEADING,
    splittable: kindIsSplittable(kind),
  };
}

/** A continuation fragment of `block`, carrying `html` and a derived id. */
function fragmentOf(block, html, suffix) {
  const kind = block.kind;
  return {
    ...block,
    id: `${block.id}${suffix}`,
    html,
    // A continuation never re-triggers orphan control: its "next" block is its
    // own remainder, and forcing them together would defeat the split.
    keepWithNext: false,
    splittable: kindIsSplittable(kind),
    continued: true,
  };
}

/* ------------------------------------------------------------------------ */
/* Inline atoms (paragraphs and headings)                                    */
/* ------------------------------------------------------------------------ */

// A text node as alternating [word, whitespace, word, ...]. Either end may be
// an empty string, which is how leading/trailing whitespace is represented
// without losing it.
function textSegments(data) {
  return String(data == null ? "" : data).split(/(\s+)/);
}

// Walk order is document order and is IDENTICAL for the original and any deep
// clone, which is what lets an atom range computed on one be applied to the
// other.
function walkInline(root, onText, onAtomNode) {
  const visit = (node) => {
    if (node.nodeType === 3) {
      onText(node);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === "BR" || tag === "IMG") {
      onAtomNode(node);
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  for (const child of Array.from(root.childNodes)) visit(child);
}

/** How many indivisible inline atoms (words, hard breaks, images) `el` holds. */
export function countInlineAtoms(el) {
  let count = 0;
  walkInline(
    el,
    (textNode) => {
      const segs = textSegments(textNode.data);
      for (let i = 0; i < segs.length; i += 2) if (segs[i] !== "") count += 1;
    },
    () => {
      count += 1;
    }
  );
  return count;
}

// Remove inline elements left holding nothing at all — an `<em>` whose only
// word went to the other fragment, say. An element that IS a break or an image,
// or that still contains one, is never pruned: those are atoms in their own
// right and carry no text. The root is never pruned.
function pruneEmptyInline(root) {
  const prune = (node) => {
    if (node.tagName === "BR" || node.tagName === "IMG") return;
    for (const child of Array.from(node.children)) prune(child);
    if (node === root) return;
    if (node.querySelector("br, img")) return;
    if ((node.textContent || "") !== "") return;
    node.remove();
  };
  prune(root);
}

/**
 * A deep clone of `el` holding only inline atoms [from, to).
 *
 * Whitespace travels with the word it FOLLOWS, so concatenating the text of
 * `slice(0, k)` and `slice(k, N)` reproduces the original text exactly — no
 * duplicated space, no missing space. Leading whitespace with no preceding word
 * travels with the word it precedes, for the same reason.
 */
export function sliceInlineAtoms(el, from, to) {
  const clone = el.cloneNode(true);
  let index = 0;
  const drop = [];

  walkInline(
    clone,
    (textNode) => {
      const segs = textSegments(textNode.data);
      const kept = new Array(segs.length).fill(false);
      const isWord = new Array(segs.length).fill(false);

      for (let i = 0; i < segs.length; i += 2) {
        if (segs[i] === "") continue;
        isWord[i] = true;
        const atom = index++;
        kept[i] = atom >= from && atom < to;
      }

      for (let i = 1; i < segs.length; i += 2) {
        let prev = -1;
        for (let j = i - 1; j >= 0; j -= 2) {
          if (isWord[j]) {
            prev = j;
            break;
          }
        }
        if (prev >= 0) {
          kept[i] = kept[prev];
          continue;
        }
        let next = -1;
        for (let j = i + 1; j < segs.length; j += 2) {
          if (isWord[j]) {
            next = j;
            break;
          }
        }
        kept[i] = next >= 0 ? kept[next] : false;
      }

      textNode.data = segs.filter((_, i) => kept[i]).join("");
    },
    (atomNode) => {
      const atom = index++;
      if (!(atom >= from && atom < to)) drop.push(atomNode);
    }
  );

  for (const node of drop) node.remove();
  pruneEmptyInline(clone);
  return clone;
}

/* ------------------------------------------------------------------------ */
/* Bounded search                                                            */
/* ------------------------------------------------------------------------ */

/**
 * The largest `k` in [1, max] for which `candidate(k)` fits, by binary search.
 *
 * Every candidate considered is MEASURED — nothing is estimated — and the
 * search is bounded by log2(max) probes, so it always terminates.
 *
 * @returns {number} the largest fitting k, or 0 when even k = 1 does not fit
 */
export function largestFitting(max, fits) {
  let lo = 1;
  let hi = Math.floor(max);
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/* ------------------------------------------------------------------------ */
/* Per-kind splitting                                                        */
/* ------------------------------------------------------------------------ */

function splitInlineElement(el, capacityPx, measure) {
  const total = countInlineAtoms(el);
  // One atom cannot be divided without cutting a word in half.
  if (total < 2) return null;

  const best = largestFitting(
    total - 1,
    (k) => measure(sliceInlineAtoms(el, 0, k).outerHTML) <= capacityPx
  );
  if (best <= 0) return null;

  return {
    head: sliceInlineAtoms(el, 0, best).outerHTML,
    tail: sliceInlineAtoms(el, best, total).outerHTML,
  };
}

function listItems(el) {
  return Array.from(el.children).filter((c) => c.tagName === "LI");
}

function listWithItems(el, items, start) {
  const clone = el.cloneNode(false);
  if (clone.tagName === "OL") {
    if (start > 1) clone.setAttribute("start", String(Math.floor(start)));
    else clone.removeAttribute("start");
  }
  for (const item of items) clone.appendChild(item.cloneNode(true));
  return clone;
}

function listStart(el) {
  const raw = Number(el.getAttribute("start"));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

function splitListElement(el, capacityPx, measure, depth) {
  const items = listItems(el);
  const start = listStart(el);
  if (items.length === 0) return null;

  if (items.length > 1) {
    const best = largestFitting(
      items.length - 1,
      (k) => measure(listWithItems(el, items.slice(0, k), start).outerHTML) <= capacityPx
    );
    if (best > 0) {
      return {
        // Continuation numbering carries forward: `start + best` is the number
        // the next item genuinely has, so an ordered list never restarts at 1.
        head: listWithItems(el, items.slice(0, best), start).outerHTML,
        tail: listWithItems(el, items.slice(best), start + best).outerHTML,
      };
    }
  }

  // Not even the first item fits: divide that item's own content. The item
  // keeps its marker on both fragments, which is the honest rendering of one
  // item that genuinely spans a page boundary — and the running number is not
  // advanced, because no complete item has been consumed.
  const first = items[0];
  const inner = splitContainerChildren(first, capacityPx, measure, depth + 1);
  if (!inner) return null;

  const headItem = first.cloneNode(false);
  headItem.innerHTML = inner.head;
  const tailItem = first.cloneNode(false);
  tailItem.innerHTML = inner.tail;

  return {
    head: listWithItems(el, [headItem], start).outerHTML,
    tail: listWithItems(el, [tailItem, ...items.slice(1)], start).outerHTML,
  };
}

function containerWithChildren(el, children) {
  const clone = el.cloneNode(false);
  for (const child of children) clone.appendChild(child.cloneNode(true));
  return clone;
}

/**
 * Split a container (blockquote, list item, generic block) at the boundaries
 * between the blocks it contains, then — if even its first child is too tall —
 * inside that child.
 */
function splitContainerChildren(el, capacityPx, measure, depth) {
  if (depth > MAX_SPLIT_DEPTH) return null;
  const children = Array.from(el.children);

  // A container of pure inline content is really a paragraph: split its words.
  if (children.length === 0) {
    const parts = splitInlineElement(el, capacityPx, measure);
    if (!parts) return null;
    const headEl = parseElement(parts.head, el.ownerDocument);
    const tailEl = parseElement(parts.tail, el.ownerDocument);
    return { head: headEl.innerHTML, tail: tailEl.innerHTML };
  }

  if (children.length > 1) {
    const best = largestFitting(
      children.length - 1,
      (k) =>
        measure(containerWithChildren(el, children.slice(0, k)).outerHTML) <=
        capacityPx
    );
    if (best > 0) {
      return {
        head: containerWithChildren(el, children.slice(0, best)).innerHTML,
        tail: containerWithChildren(el, children.slice(best)).innerHTML,
      };
    }
  }

  const first = children[0];
  const inner = splitFreeformElement(first, capacityPx, measure, depth + 1);
  if (!inner) return null;

  const headHtml = inner.head;
  const tailHtml = inner.tail + children.slice(1).map((c) => c.outerHTML).join("");
  return { head: headHtml, tail: tailHtml };
}

function splitBlockquoteElement(el, capacityPx, measure, depth) {
  const inner = splitContainerChildren(el, capacityPx, measure, depth);
  if (!inner) return null;
  const head = el.cloneNode(false);
  head.innerHTML = inner.head;
  const tail = el.cloneNode(false);
  tail.innerHTML = inner.tail;
  return { head: head.outerHTML, tail: tail.outerHTML };
}

// The element whose text IS the code. TipTap emits <pre><code>…</code></pre>;
// a bare <pre> is tolerated.
function codeTextHost(el) {
  const code = el.querySelector("code");
  return code || el;
}

function splitCodeElement(el, capacityPx, measure) {
  const host = codeTextHost(el);
  const text = host.textContent || "";
  const lines = text.split("\n");
  if (lines.length < 2) return null;

  const build = (from, to) => {
    const clone = el.cloneNode(true);
    // textContent, never innerHTML: code is data, and this is what keeps every
    // character, every space of indentation and every blank line byte-exact.
    codeTextHost(clone).textContent = lines.slice(from, to).join("\n");
    return clone.outerHTML;
  };

  const best = largestFitting(
    lines.length - 1,
    (k) => measure(build(0, k)) <= capacityPx
  );
  if (best <= 0) return null;

  return { head: build(0, best), tail: build(best, lines.length) };
}

function tableRows(el) {
  const body = el.querySelector("tbody") || el;
  return Array.from(body.children).filter((c) => c.tagName === "TR");
}

/**
 * Row counts at which this table may be divided without breaking a rowspan.
 *
 * A cell that spans past the cut cannot be honoured on either side, so that
 * boundary is simply not offered — the search picks the largest SAFE row count
 * that fits, and reports the table unsplittable when none exists.
 */
export function safeTableSplitPoints(rows) {
  const safe = [];
  for (let k = 1; k < rows.length; k += 1) {
    let ok = true;
    for (let i = 0; i < k && ok; i += 1) {
      for (const cell of Array.from(rows[i].children)) {
        const span = Number(cell.getAttribute("rowspan"));
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

function tableWithRows(el, rows) {
  const clone = el.cloneNode(false);
  // colgroup carries the column widths; it belongs on every fragment so the
  // columns line up and the right-hand border stays where it was.
  const colgroup = el.querySelector("colgroup");
  if (colgroup) clone.appendChild(colgroup.cloneNode(true));
  const body = el.ownerDocument.createElement("tbody");
  for (const row of rows) body.appendChild(row.cloneNode(true));
  clone.appendChild(body);
  return clone;
}

function splitTableElement(el, capacityPx, measure) {
  const rows = tableRows(el);
  if (rows.length < 2) return null;
  const points = safeTableSplitPoints(rows);
  if (points.length === 0) return null;

  const index = largestFitting(
    points.length,
    (n) =>
      measure(tableWithRows(el, rows.slice(0, points[n - 1])).outerHTML) <=
      capacityPx
  );
  if (index <= 0) return null;
  const cut = points[index - 1];

  return {
    head: tableWithRows(el, rows.slice(0, cut)).outerHTML,
    tail: tableWithRows(el, rows.slice(cut)).outerHTML,
  };
}

/** Dispatch one element to the splitter that matches its structure. */
export function splitFreeformElement(el, capacityPx, measure, depth = 0) {
  if (!el || el.nodeType !== 1) return null;
  if (depth > MAX_SPLIT_DEPTH) return null;
  const kind = classifyBlockElement(el);

  switch (kind) {
    case FREEFORM_BLOCK.PARAGRAPH:
    case FREEFORM_BLOCK.HEADING:
      return splitInlineElement(el, capacityPx, measure);
    case FREEFORM_BLOCK.LIST:
      return splitListElement(el, capacityPx, measure, depth);
    case FREEFORM_BLOCK.BLOCKQUOTE:
      return splitBlockquoteElement(el, capacityPx, measure, depth);
    case FREEFORM_BLOCK.CODE:
      return splitCodeElement(el, capacityPx, measure);
    case FREEFORM_BLOCK.TABLE:
      return splitTableElement(el, capacityPx, measure);
    default:
      // Images, file cards, rules and unknown blocks are ATOMIC by design.
      return null;
  }
}

/**
 * Split one block's HTML so the head fits `capacityPx`.
 *
 * @returns {{head: string, tail: string} | null} null when the block is atomic,
 *   or when nothing that fits can be produced without cutting a rendered line.
 */
export function splitFreeformBlockHtml(html, capacityPx, measure, deps = {}) {
  const doc = (deps.createDocument || createInertDocument)();
  const el = parseElement(html, doc);
  if (!el) return null;
  const parts = splitFreeformElement(el, capacityPx, measure, 0);
  if (!parts || !parts.head || !parts.tail) return null;
  return parts;
}

/**
 * Reduce every block to fragments that each fit `capacityPx` — a WHOLE page.
 *
 * This runs before placement, so the page distributor is guaranteed never to
 * receive a block taller than a page and can never be forced to grow one.
 * A block that fits already passes through completely unchanged.
 *
 * @returns {{ok: true, blocks}} | {{ok: false, reason, blockId}}
 */
export function fitFreeformBlocks(blocks, capacityPx, measure) {
  const out = [];

  const place = (block, depth) => {
    if (depth > MAX_SPLIT_DEPTH) return false;
    const height = measure(block.html);
    if (height <= capacityPx) {
      out.push({ ...block, height });
      return true;
    }
    if (!block.splittable) return false;
    const parts = splitFreeformBlockHtml(block.html, capacityPx, measure);
    if (!parts) return false;
    return (
      place(fragmentOf(block, parts.head, `-h${depth}`), depth + 1) &&
      place(fragmentOf(block, parts.tail, `-t${depth}`), depth + 1)
    );
  };

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!place(block, 0)) {
      return {
        ok: false,
        reason: FREEFORM_FRAGMENT_FAILURE.UNSPLITTABLE,
        blockId: block.id,
      };
    }
  }

  return { ok: true, blocks: out };
}

/**
 * The concatenated HTML of an ordered fragment list — the invariant an exported
 * document must satisfy: the fragments together are exactly the original
 * content, once, in order.
 */
export function joinBlockHtml(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((b) => b.html).join("");
}
