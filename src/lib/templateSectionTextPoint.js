// src/lib/templateSectionTextPoint.js
//
// Resolving a POINTER COORDINATE over a section text item into a position in
// that item's stored value.
//
// This is what makes "drop the image here, inside this paragraph" possible. It
// answers exactly one question — WHERE in the text did the user point? — and
// answers it as a position in the NORMALIZED ANSWER MODEL
// (src/lib/templateRichText.js), never as an offset into an HTML string.
//
// ---------------------------------------------------------------------------
// WHY NOT ProseMirror's own posAtCoords
// ---------------------------------------------------------------------------
//
// TemplateRowEditor already uses `editor.view.posAtCoords` to place the caret,
// and that is the right tool WHEN THERE IS AN EDITOR. There almost never is
// one here: only the single text item the user is currently typing in carries a
// ProseMirror view, and the item an image is being dropped onto is, by
// definition, one the user is pointing at rather than editing. Every other text
// item on the page is a static React rendering (TemplateRichTextView) with no
// view, no schema instance and no positions to ask about.
//
// So the resolution is done at the layer both states genuinely share:
//
//   1. THE BROWSER'S OWN caret resolver — `caretPositionFromPoint` /
//      `caretRangeFromPoint` — turns the coordinate into a DOM (node, offset).
//      This is the same native text-position machinery ProseMirror's
//      `posAtCoords` is built on; it is not hit-testing arithmetic of our own.
//   2. That DOM position is mapped to a position in the MODEL by counting
//      characters in the rendered subtree. The rendering is generated from the
//      model one element per block (TemplateRichTextView renders
//      `blocks.map(renderBlock)`, and ProseMirror renders the same document the
//      same way), so "the nth top-level element" IS "the nth model block", and
//      the characters in a block's subtree are exactly the characters in its
//      inline runs.
//
// NOTHING HERE READS, WRITES, SLICES OR CONCATENATES HTML. It reads text-node
// lengths and element positions. The split that follows (see
// src/lib/templateSectionTextSplit.js) operates on the model and is
// re-serialized through the existing sanitization boundary, so no untrusted
// markup path is created or widened by any of this.
//
// ---------------------------------------------------------------------------
// LISTS SPLIT BETWEEN ITEMS
// ---------------------------------------------------------------------------
//
// A paragraph is split at a character. A list is split BETWEEN LIST ITEMS —
// mid-item splitting would have to either produce two lists whose numbering
// restarts inside a sentence, or invent a list item containing half a clause.
// Splitting at the nearest item boundary keeps both halves structurally valid
// lists, which is also what a word processor does when a picture is dropped
// into a bulleted list.
//
// The DOM functions take their `document` by parameter, so the mapping rules
// are testable without a browser.

export const ANSWER_POINT_KIND = {
  PARAGRAPH: "paragraph",
  LIST: "list",
};

/**
 * The number of CHARACTERS inside `root` that precede the DOM position
 * (node, offset).
 *
 * Only text nodes contribute. `<br>` contributes nothing, which is exactly
 * right: the model represents a line break as an inline node carrying no text,
 * so the two counts stay in step. Elements that wrap text (strong, em, a, span,
 * mark…) contribute only through the text inside them, so formatting never
 * shifts an offset.
 *
 * Returns 0 when the position is not inside `root` — a caller that cannot
 * establish where it is must land at the start rather than somewhere arbitrary.
 */
export function textOffsetWithin(root, node, offset) {
  if (!root || !node) return 0;

  const state = { count: 0, done: false };

  const countAll = (current) => {
    if (!current) return;
    if (current.nodeType === 3) {
      state.count += String(current.nodeValue || "").length;
      return;
    }
    const kids = current.childNodes ? Array.from(current.childNodes) : [];
    for (const kid of kids) countAll(kid);
  };

  const walk = (current) => {
    if (state.done || !current) return;

    if (current === node) {
      if (current.nodeType === 3) {
        const length = String(current.nodeValue || "").length;
        const clamped = Math.max(0, Math.min(Number(offset) || 0, length));
        state.count += clamped;
      } else {
        // An ELEMENT position: `offset` is a child index, so everything in the
        // children before it precedes the caret.
        const kids = current.childNodes ? Array.from(current.childNodes) : [];
        const limit = Math.max(0, Math.min(Number(offset) || 0, kids.length));
        for (let i = 0; i < limit; i += 1) countAll(kids[i]);
      }
      state.done = true;
      return;
    }

    if (current.nodeType === 3) {
      state.count += String(current.nodeValue || "").length;
      return;
    }

    const kids = current.childNodes ? Array.from(current.childNodes) : [];
    for (const kid of kids) {
      walk(kid);
      if (state.done) return;
    }
  };

  walk(root);
  return state.done ? state.count : 0;
}

/**
 * The index, among `container`'s ELEMENT children, of the top-level block that
 * contains this node — i.e. which model block the caret is in. -1 when the node
 * is not inside one.
 *
 * The correspondence is structural, not conventional: the renderer emits one
 * element per model block and nothing else at that level.
 */
export function topLevelBlockIndex(container, node) {
  if (!container || !node) return -1;
  let current = node;
  while (current && current !== container) {
    if (current.parentNode === container) {
      const children = container.children ? Array.from(container.children) : [];
      const index = children.indexOf(current);
      return index;
    }
    current = current.parentNode;
  }
  return -1;
}

/** The `<li>` ancestor of a node within one list element, or null. */
export function closestListItem(listEl, node) {
  if (!listEl || !node) return null;
  let current = node;
  while (current && current !== listEl) {
    if (
      current.nodeType === 1 &&
      String(current.tagName || "").toLowerCase() === "li" &&
      current.parentNode === listEl
    ) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * The DOM caret position under a coordinate, through the browser's own
 * resolver. Standard-first (`caretPositionFromPoint`), with the long-standing
 * WebKit/Blink spelling as the fallback. Null when neither exists or neither
 * can resolve the point — a caller must then decline rather than guess.
 */
export function caretFromPoint(doc, clientX, clientY) {
  if (!doc) return null;
  try {
    if (typeof doc.caretPositionFromPoint === "function") {
      const position = doc.caretPositionFromPoint(clientX, clientY);
      if (position && position.offsetNode) {
        return { node: position.offsetNode, offset: position.offset || 0 };
      }
    }
  } catch {
    /* fall through to the alternative spelling */
  }
  try {
    if (typeof doc.caretRangeFromPoint === "function") {
      const range = doc.caretRangeFromPoint(clientX, clientY);
      if (range && range.startContainer) {
        return { node: range.startContainer, offset: range.startOffset || 0 };
      }
    }
  } catch {
    /* nothing resolvable */
  }
  return null;
}

/**
 * The top of the caret's LINE BOX, in client coordinates, or null.
 *
 * Presentation only — it is where the insertion line is drawn so the user can
 * see which line the image will land on. Nothing structural depends on it, and
 * a browser that cannot supply it simply gets the fallback indicator.
 */
export function caretLineTop(doc, caret) {
  if (!doc || !caret || typeof doc.createRange !== "function") return null;
  try {
    const range = doc.createRange();
    range.setStart(caret.node, caret.offset);
    range.collapse(true);
    const rect =
      typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : null;
    if (!rect) return null;
    // A collapsed range in an empty element can report an all-zero rect; that
    // is not a position, it is the absence of one.
    if (!rect.height && !rect.top) return null;
    return rect.top;
  } catch {
    return null;
  }
}

/**
 * Resolve a pointer coordinate over one rendered text item into a split point
 * in its model.
 *
 * @param container the element the item's rich text is rendered into — the
 *                  static `.twocol-rich` view, or the active editor's
 *                  `.twocol-rich-input`. Both are one element per model block.
 * @param model     the item's value as `answerToModel` produced it
 * @param doc       the document (injected, so the rules are testable)
 *
 * @returns { point, caretTop } or null. `point` is one of:
 *            { kind: "paragraph", blockIndex, offset }
 *            { kind: "list", blockIndex, itemIndex }   split BEFORE that item
 */
export function answerPointFromCoords({
  container,
  clientX,
  clientY,
  model,
  doc,
} = {}) {
  if (!container || !Array.isArray(model) || model.length === 0) return null;

  const caret = caretFromPoint(doc, clientX, clientY);
  if (!caret) return null;
  if (typeof container.contains === "function" && !container.contains(caret.node)) {
    return null;
  }

  const blockIndex = topLevelBlockIndex(container, caret.node);
  if (blockIndex < 0 || blockIndex >= model.length) return null;

  const block = model[blockIndex];
  const children = container.children ? Array.from(container.children) : [];
  const blockEl = children[blockIndex] || null;
  if (!block || !blockEl) return null;

  const caretTop = caretLineTop(doc, caret);

  if (block.type === "bulletList" || block.type === "orderedList") {
    const items = Array.isArray(block.items) ? block.items : [];
    const li = closestListItem(blockEl, caret.node);
    if (!li) return { point: { kind: ANSWER_POINT_KIND.LIST, blockIndex, itemIndex: 0 }, caretTop };
    const listItems = blockEl.children ? Array.from(blockEl.children) : [];
    const index = listItems.indexOf(li);
    if (index < 0) return { point: { kind: ANSWER_POINT_KIND.LIST, blockIndex, itemIndex: 0 }, caretTop };
    // Above the item's midpoint means "before it"; below means "after it".
    const rect =
      typeof li.getBoundingClientRect === "function" ? li.getBoundingClientRect() : null;
    const below = !!(rect && rect.height > 0 && clientY >= rect.top + rect.height / 2);
    const itemIndex = Math.max(0, Math.min(items.length, below ? index + 1 : index));
    return { point: { kind: ANSWER_POINT_KIND.LIST, blockIndex, itemIndex }, caretTop };
  }

  return {
    point: {
      kind: ANSWER_POINT_KIND.PARAGRAPH,
      blockIndex,
      offset: textOffsetWithin(blockEl, caret.node, caret.offset),
    },
    caretTop,
  };
}
