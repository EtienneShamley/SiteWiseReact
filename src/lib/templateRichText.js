// src/lib/templateRichText.js
//
// THE SHARED RICH-TEXT MODEL and safety boundary of every Template document:
// a Template Text answer (`richtext/1`) and the prose of a modern Template
// Section document (`sectiondoc/1`, src/lib/templateSectionDoc.js) are both
// read, sanitized, rendered statically and exported through the model below.
//
// A Template Text answer is EITHER:
//
//   "Hello\nWorld"                                   a plain string (legacy and
//                                                    ordinary unformatted text)
//   { format: "richtext/1", html: "<p><strong>…" }   a tagged rich value
//
// The two are distinguished by the value's SHAPE, never by looking at what a
// string contains. That is the whole point: a legacy answer that happens to
// read `<b>Inspection failed</b>` is a string, is rendered as literal
// characters, and can never become markup. Nothing here sniffs, guesses, or
// upgrades a value because it "looks like" HTML.
//
// A rich value is only ever produced by `serializeAnswerFromHtml`, and only
// when the content genuinely needs it: content that is nothing but text,
// paragraphs and line breaks serializes back to a plain string, so ordinary
// answers stay compact in localStorage and an answer does not become rich
// merely because the user focused the row.
//
// THE VOCABULARY (Template Section full-document parity, 2026-08-18)
// -----------------------------------------------------------------
// The model carries the professional document vocabulary the NoteWise editor
// core exposes on its toolbar — the same vocabulary the Free-form note has —
// so a flexible Template Section is a real document surface rather than a
// restrained form field:
//
//   blocks   paragraph, heading (1–6), bullet / ordered list, task list,
//            blockquote, code block, horizontal rule, table
//   marks    bold, italic, underline, strike, subscript, superscript, inline
//            code, text colour, highlight, link, font family, font size
//
// Every stored `richtext/1` and `sectiondoc/1` document produced before this
// vocabulary existed contains only its earlier subset (the serializer never
// emitted anything else), so such a document parses to exactly the model it
// always did — the extension is additive and needs no format bump.
//
// SECURITY — the sanitization boundary lives here and nowhere else:
//   - HTML is PARSED (DOMParser) and REBUILT from an explicit whitelist. It is
//     never pattern-stripped, never patched, and never passed through.
//   - Only the elements the model can express survive: p, h1–h6, br, strong,
//     em, u, s, sub, sup, code, pre, blockquote, hr, ul, ol, li, table, tr,
//     td, th, span, mark and a. Everything else is either dropped whole
//     (script/style/media/controls) or unwrapped so its readable text survives
//     without its element.
//   - The only style properties that survive are text-align on a paragraph or
//     heading, and color / background-color / font-family / font-size on an
//     inline span / mark — each rebuilt from a VALIDATED value: colours to
//     #rrggbb, alignment to one of four keywords, font family to one of the
//     approved families and font size to a bounded integer pixel value
//     (src/lib/editorTextStylePolicy.js). A raw style string is never carried
//     across.
//   - Table cell spans are bounded integers; a code block's language is a
//     short identifier; a task item's state is a boolean. Nothing else on a
//     structural element survives.
//   - Link hrefs go through the project's existing URL policy
//     (src/lib/editorUrlSafety.js). A rejected link becomes ordinary text.
//   - Nothing produced here can carry an event handler, a data attribute the
//     model does not itself define, a ProseMirror/runtime attribute, a DOM
//     reference or an object URL, because the output is built from the model
//     rather than copied from the input.
//
// Sanitization runs at every boundary: reading a stored value, loading it into
// the editor, serializing an edit, rendering a static answer, exporting and
// printing.
//
// THE SERIALIZED FORM IS WHAT TIPTAP PARSES. `modelToHtml` emits exactly the
// element shapes the shared editor extensions' `parseHTML` rules recognise
// (`<ul data-type="taskList"><li data-type="taskItem" data-checked>`,
// `<pre><code class="language-…">`, `<td colspan rowspan colwidth>`, …), so a
// document opened in the editor holds the same nodes the static view draws.
//
// Framework-agnostic (no React, no storage, no editor). It uses DOMParser,
// which exists in the browser and in the jsdom test environment.

import { normalizeLinkUrl } from "./editorUrlSafety";
import { isValidHexColor, normalizeHexColor } from "./templateBranding";
import { normalizeFontFamily, normalizeFontSize } from "./editorTextStylePolicy";

export const RICH_TEXT_FORMAT = "richtext/1";

export const ANSWER_ALIGNMENTS = ["left", "center", "right", "justify"];

/** The heading levels the model carries (the shared editor core's default). */
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6];

/** Block types of the model. Node-model names deliberately match Tiptap's. */
export const RICH_BLOCK = Object.freeze({
  PARAGRAPH: "paragraph",
  HEADING: "heading",
  BULLET_LIST: "bulletList",
  ORDERED_LIST: "orderedList",
  TASK_LIST: "taskList",
  BLOCKQUOTE: "blockquote",
  CODE_BLOCK: "codeBlock",
  HORIZONTAL_RULE: "horizontalRule",
  TABLE: "table",
});

// Elements whose CONTENT is not user prose. Dropped whole — text included.
const DROP_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "object", "embed",
  "img", "picture", "source", "track", "video", "audio", "canvas", "svg",
  "math", "input", "textarea", "select", "option", "button", "form", "label",
  "fieldset", "legend", "link", "meta", "base", "title", "head", "map", "area",
  "frame", "frameset", "applet", "portal", "dialog", "slot", "colgroup", "col",
]);

// Elements that are not (or not at this depth) approved structure but DO
// separate content. Their readable text is kept, as its own paragraph, so
// pasting an unknown container does not lose the words in it.
const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
  "section", "article", "aside", "header", "footer", "main", "nav", "figure",
  "figcaption", "table", "thead", "tbody", "tfoot", "caption", "tr", "td",
  "th", "dl", "dt", "dd", "address", "hr", "details", "summary",
]);

const HEADING_TAGS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

// Guard against pathological nesting in stored or pasted content: lists,
// task lists, blockquotes and tables all count.
const MAX_LIST_DEPTH = 6;
const MAX_NESTING_DEPTH = MAX_LIST_DEPTH;

// A table span beyond this is not real content.
const MAX_CELL_SPAN = 50;
// A column width beyond this is not a real column.
const MAX_COL_WIDTH_PX = 4000;

const CODE_LANGUAGE_RE = /^[a-z0-9_+#.-]{1,40}$/i;

/* ------------------------------------------------------------------------ */
/* Value shape                                                               */
/* ------------------------------------------------------------------------ */

export function isRichAnswerValue(value) {
  return !!(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.format === RICH_TEXT_FORMAT &&
    typeof value.html === "string"
  );
}

/** True for anything this module recognises as a Text answer. */
export function isAnswerValue(value) {
  return typeof value === "string" || isRichAnswerValue(value);
}

/* ------------------------------------------------------------------------ */
/* Value validation (colours, alignment, links, spans, languages)            */
/* ------------------------------------------------------------------------ */

// The CSSOM normalizes `#ff0000` to `rgb(255, 0, 0)`, so both forms have to be
// recognised. Everything else — named colours, hsl(), rgba(), var(), url(),
// expression(), CSS-wide keywords — is rejected and the mark is simply dropped.
const RGB_RE =
  /^rgb\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)$/i;

export function normalizeAnswerColor(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (isValidHexColor(raw)) return normalizeHexColor(raw, "#000000");

  const match = RGB_RE.exec(raw);
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map((n) => Number(n));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function normalizeAnswerAlignment(value) {
  if (typeof value !== "string") return "left";
  const v = value.trim().toLowerCase();
  return ANSWER_ALIGNMENTS.includes(v) ? v : "left";
}

/** A safe href, or null — a rejected link is rendered as ordinary text. */
export function safeAnswerLinkHref(raw) {
  const result = normalizeLinkUrl(raw);
  return result.ok ? result.href : null;
}

/** A heading level the model carries, or null. */
export function normalizeHeadingLevel(value) {
  const n = Number(value);
  return HEADING_LEVELS.includes(n) ? n : null;
}

/** A bounded, positive integer table span (defaults to 1). */
export function normalizeCellSpan(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, MAX_CELL_SPAN);
}

/**
 * A stored column-width list ("100,120" or [100, 120]) → positive integer
 * pixel widths, or null when unusable. Its LENGTH must equal the cell's
 * colspan (that is what the table extension expects), so a mismatched list is
 * dropped rather than half-applied.
 */
export function normalizeColWidth(value, colspan) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(",")
    : null;
  if (!raw || !raw.length) return null;
  const widths = raw.map((v) => Number(String(v).trim()));
  // `0` is the table extension's own "this spanned column has no width yet"
  // marker (it writes e.g. "120,0" for a two-column cell whose second column
  // is unsized), so it is carried; a negative, absurd or unparsable width
  // drops the whole list.
  if (widths.some((w) => !Number.isFinite(w) || w < 0 || w > MAX_COL_WIDTH_PX)) {
    return null;
  }
  const span = normalizeCellSpan(colspan);
  if (widths.length !== span) return null;
  if (widths.every((w) => w === 0)) return null;
  return widths.map((w) => Math.round(w));
}

/**
 * Column widths made CONSISTENT down each column — the same normalization the
 * table extension itself applies on the first document change (prosemirror-
 * tables `fixTables`: a column's established width is written onto every cell
 * of that column that lacks it or disagrees with it). Applying the identical
 * rule at parse time makes a stored table a FIXED POINT of the round trip:
 * what the model serializes is what the editor would have written anyway, so
 * opening a Section can never be followed by a width-only "edit". Presentation
 * only — no content, span or order changes.
 */
export function normalizeTableColWidths(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const height = list.length;
  if (!height) return list;

  // Table width (columns), rowspan-aware — prosemirror-tables' findWidth.
  let width = -1;
  let hasRowSpan = false;
  for (let row = 0; row < height; row += 1) {
    let rowWidth = 0;
    if (hasRowSpan) {
      for (let j = 0; j < row; j += 1) {
        for (const cell of list[j].cells || []) {
          if (j + normalizeCellSpan(cell.rowspan) > row) rowWidth += normalizeCellSpan(cell.colspan);
        }
      }
    }
    for (const cell of list[row].cells || []) {
      rowWidth += normalizeCellSpan(cell.colspan);
      if (normalizeCellSpan(cell.rowspan) > 1) hasRowSpan = true;
    }
    width = width === -1 ? rowWidth : Math.max(width, rowWidth);
  }
  if (width <= 0) return list;

  // Occupancy map + the established width per column (value, agreement count).
  const map = new Array(width * height).fill(0);
  const colWidths = new Array(width * 2).fill(null);
  const placements = []; // { row, index, start } per cell, in document order
  let mapPos = 0;
  let id = 1;
  for (let row = 0; row < height; row += 1) {
    const cells = list[row].cells || [];
    for (let i = 0; ; i += 1) {
      while (mapPos < map.length && map[mapPos] !== 0) mapPos += 1;
      if (i === cells.length) break;
      const cell = cells[i];
      const colspan = normalizeCellSpan(cell.colspan);
      const rowspan = normalizeCellSpan(cell.rowspan);
      const colwidth = normalizeColWidth(cell.colwidth, colspan);
      placements.push({ row, index: i, start: mapPos % width });
      for (let h = 0; h < rowspan; h += 1) {
        if (h + row >= height) break;
        const start = mapPos + h * width;
        for (let w = 0; w < colspan; w += 1) {
          if (start + w < map.length && map[start + w] === 0) map[start + w] = id;
          const colW = colwidth && colwidth[w];
          if (colW) {
            const widthIndex = ((start + w) % width) * 2;
            const prev = colWidths[widthIndex];
            if (prev == null || (prev !== colW && colWidths[widthIndex + 1] === 1)) {
              colWidths[widthIndex] = colW;
              colWidths[widthIndex + 1] = 1;
            } else if (prev === colW) {
              colWidths[widthIndex + 1] += 1;
            }
          }
        }
      }
      mapPos += colspan;
      id += 1;
    }
    mapPos = (row + 1) * width;
  }
  if (!colWidths.some((v, i) => i % 2 === 0 && v != null)) return list;

  // Write the established width onto every cell that lacks or disagrees.
  const out = list.map((row) => ({ ...row, cells: (row.cells || []).map((c) => ({ ...c })) }));
  for (const { row, index, start } of placements) {
    const cell = out[row].cells[index];
    const colspan = normalizeCellSpan(cell.colspan);
    const current = normalizeColWidth(cell.colwidth, colspan);
    let updated = null;
    for (let j = 0; j < colspan; j += 1) {
      const colW = colWidths[((start + j) % width) * 2];
      if (colW != null && (!current || current[j] !== colW)) {
        if (!updated) updated = current ? current.slice() : new Array(colspan).fill(0);
        updated[j] = colW;
      }
    }
    if (updated) cell.colwidth = updated;
    else cell.colwidth = current;
  }
  return out;
}

/** A code-block language identifier, or null. */
export function normalizeCodeLanguage(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return CODE_LANGUAGE_RE.test(v) ? v : null;
}

/* ------------------------------------------------------------------------ */
/* Parsing HTML into the normalized model                                    */
/* ------------------------------------------------------------------------ */
//
// Model:
//   Block  = { type: "paragraph", align, content: Inline[] }
//          | { type: "heading", level, align, content: Inline[] }
//          | { type: "bulletList" | "orderedList", items: Block[][] }
//          | { type: "taskList", items: { checked, blocks: Block[] }[] }
//          | { type: "blockquote", blocks: Block[] }
//          | { type: "codeBlock", language, text }
//          | { type: "horizontalRule" }
//          | { type: "table", rows: { cells: Cell[] }[] }
//   Cell   = { header, colspan, rowspan, colwidth, blocks: Block[] }
//   Inline = { type: "text", text, marks: { bold, italic, underline, strike,
//                                           subscript, superscript, code,
//                                           color, highlight, link,
//                                           fontFamily, fontSize } }
//          | { type: "break" }

function readStyle(el, property) {
  // Per-property CSSOM read: the raw style attribute string is never used, so
  // an unapproved declaration cannot travel with an approved one.
  try {
    return el.style ? el.style.getPropertyValue(property) : "";
  } catch {
    return "";
  }
}

function withoutMark(marks, key) {
  if (!marks || !(key in marks)) return marks;
  const next = { ...marks };
  delete next[key];
  return next;
}

function sameMarks(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

function parseHtmlBody(html) {
  if (typeof html !== "string" || html === "") return null;
  if (typeof DOMParser === "undefined") return null;
  try {
    // text/html parsing is inert: no script runs, no resource is fetched.
    return new DOMParser().parseFromString(html, "text/html").body || null;
  } catch {
    return null;
  }
}

function tagOf(node) {
  return String((node && node.tagName) || "").toLowerCase();
}

function emptyParagraph() {
  return { type: RICH_BLOCK.PARAGRAPH, align: "left", content: [] };
}

function walkChildren(parent, marks, ctx) {
  const children = parent.childNodes ? Array.from(parent.childNodes) : [];
  for (const node of children) walkNode(node, marks, ctx);
}

/** The text-style marks a span-like element carries, validated one by one. */
function spanMarks(node, marks) {
  let next = marks;
  const color = normalizeAnswerColor(readStyle(node, "color"));
  if (color) next = { ...next, color };
  const fontFamily = normalizeFontFamily(readStyle(node, "font-family"));
  if (fontFamily) next = { ...next, fontFamily };
  const fontSize = normalizeFontSize(readStyle(node, "font-size"));
  if (fontSize) next = { ...next, fontSize };
  return next;
}

function walkNode(node, marks, ctx) {
  // Text
  if (node.nodeType === 3) {
    // Newlines/tabs between block tags are HTML formatting, not content. Real
    // spacing INSIDE a paragraph is preserved verbatim (the editor renders with
    // pre-wrap, so a double space the user typed is real content).
    const text = String(node.nodeValue || "").replace(/[\r\n\t]+/g, " ");
    if (!text) return;
    if (!text.trim() && !ctx.hasPendingText()) return;
    ctx.pushText(text, marks);
    return;
  }
  if (node.nodeType !== 1) return; // comments, CDATA, processing instructions

  const tag = tagOf(node);
  if (!tag || DROP_TAGS.has(tag)) return;

  if (tag === "br") {
    ctx.pushBreak();
    return;
  }

  if (tag === "ul" || tag === "ol") {
    if (tag === "ul" && node.getAttribute("data-type") === "taskList") {
      ctx.pushTaskList(node, marks);
      return;
    }
    ctx.pushList(node, tag === "ol" ? RICH_BLOCK.ORDERED_LIST : RICH_BLOCK.BULLET_LIST, marks);
    return;
  }

  switch (tag) {
    case "strong":
    case "b":
      return walkChildren(node, { ...marks, bold: true }, ctx);
    case "em":
    case "i":
      return walkChildren(node, { ...marks, italic: true }, ctx);
    case "u":
    case "ins":
      return walkChildren(node, { ...marks, underline: true }, ctx);
    case "s":
    case "strike":
    case "del":
      return walkChildren(node, { ...marks, strike: true }, ctx);
    case "sub":
      // Sub/superscript are mutually exclusive, exactly as the editor marks are.
      return walkChildren(node, { ...withoutMark(marks, "superscript"), subscript: true }, ctx);
    case "sup":
      return walkChildren(node, { ...withoutMark(marks, "subscript"), superscript: true }, ctx);
    case "code":
      return walkChildren(node, { ...marks, code: true }, ctx);
    case "mark": {
      const color = normalizeAnswerColor(readStyle(node, "background-color"));
      return walkChildren(node, color ? { ...marks, highlight: color } : marks, ctx);
    }
    case "span":
      return walkChildren(node, spanMarks(node, marks), ctx);
    case "a": {
      const href = safeAnswerLinkHref(node.getAttribute("href"));
      // An unsafe or malformed href drops the link mark only — the words the
      // user wrote stay, as ordinary text.
      return walkChildren(node, href ? { ...marks, link: href } : marks, ctx);
    }
    default:
      break;
  }

  if (HEADING_TAGS[tag]) {
    ctx.pushHeading(node, HEADING_TAGS[tag], marks);
    return;
  }
  if (tag === "blockquote") {
    ctx.pushBlockquote(node, marks);
    return;
  }
  if (tag === "pre") {
    ctx.pushCodeBlock(node);
    return;
  }
  if (tag === "hr") {
    ctx.pushHorizontalRule();
    return;
  }
  if (tag === "table") {
    ctx.pushTable(node, marks);
    return;
  }

  if (tag === "li" || BLOCK_TAGS.has(tag)) {
    ctx.pushBlockElement(node, tag, marks);
    return;
  }

  // Any other element (font, small, abbr, custom elements…): unwrap it and
  // keep its text.
  walkChildren(node, marks, ctx);
}

/** The rows of a table element, in document order, whatever sections wrap them. */
function tableRowElements(table) {
  const rows = [];
  const visit = (el) => {
    for (const child of el.children ? Array.from(el.children) : []) {
      const tag = tagOf(child);
      if (tag === "tr") rows.push(child);
      else if (tag === "thead" || tag === "tbody" || tag === "tfoot") visit(child);
    }
  };
  visit(table);
  return rows;
}

/** Was this task item checked? Tiptap's own attribute first, a checkbox after. */
function taskItemChecked(li) {
  const declared = li.getAttribute("data-checked");
  if (declared === "true") return true;
  if (declared === "false") return false;
  const box = li.querySelector ? li.querySelector('input[type="checkbox"]') : null;
  return !!(box && box.hasAttribute("checked"));
}

function collectBlocks(parent, marks, depth) {
  const blocks = [];
  let current = null;

  const flush = () => {
    if (current && current.content.length > 0) {
      blocks.push({
        type: RICH_BLOCK.PARAGRAPH,
        align: current.align,
        content: current.content,
      });
    }
    current = null;
  };

  const ensure = () => {
    if (!current) current = { align: "left", content: [] };
    return current;
  };

  // Structure this deep is not real content: keep the words, drop the
  // structure — the SAME rule pathological list nesting has always followed.
  const tooDeep = () => depth >= MAX_NESTING_DEPTH;

  const ctx = {
    hasPendingText: () => !!current && current.content.length > 0,
    pushText(text, activeMarks) {
      const paragraph = ensure();
      const last = paragraph.content[paragraph.content.length - 1];
      if (last && last.type === "text" && sameMarks(last.marks, activeMarks)) {
        last.text += text;
        return;
      }
      paragraph.content.push({ type: "text", text, marks: { ...activeMarks } });
    },
    pushBreak() {
      ensure().content.push({ type: "break" });
    },
    pushList(el, type, activeMarks) {
      flush();
      if (tooDeep()) {
        const inner = collectBlocks(el, activeMarks, depth + 1);
        blocks.push(...inner);
        return;
      }
      const items = [];
      const children = el.children ? Array.from(el.children) : [];
      for (const child of children) {
        if (tagOf(child) !== "li") continue;
        const itemBlocks = collectBlocks(child, activeMarks, depth + 1);
        items.push(itemBlocks.length ? itemBlocks : [emptyParagraph()]);
      }
      if (items.length) blocks.push({ type, items });
    },
    pushTaskList(el, activeMarks) {
      flush();
      if (tooDeep()) {
        blocks.push(...collectBlocks(el, activeMarks, depth + 1));
        return;
      }
      const items = [];
      const children = el.children ? Array.from(el.children) : [];
      for (const child of children) {
        if (tagOf(child) !== "li") continue;
        const itemBlocks = collectBlocks(child, activeMarks, depth + 1);
        items.push({
          checked: taskItemChecked(child),
          blocks: itemBlocks.length ? itemBlocks : [emptyParagraph()],
        });
      }
      if (items.length) blocks.push({ type: RICH_BLOCK.TASK_LIST, items });
    },
    pushHeading(el, level, activeMarks) {
      flush();
      const inner = collectBlocks(el, activeMarks, depth);
      const align = normalizeAnswerAlignment(readStyle(el, "text-align"));
      // A heading holds inline content only. Its first paragraph IS the
      // heading (an empty heading is a deliberate empty line, kept exactly as
      // an empty paragraph is); anything structural that was nested inside it
      // (malformed input) follows it as ordinary blocks.
      const first = inner.findIndex((b) => b && b.type === RICH_BLOCK.PARAGRAPH);
      const content = first >= 0 ? inner[first].content : [];
      blocks.push({ type: RICH_BLOCK.HEADING, level, align, content });
      inner.forEach((b, i) => {
        if (i !== first) blocks.push(b);
      });
    },
    pushBlockquote(el, activeMarks) {
      flush();
      const inner = collectBlocks(el, activeMarks, depth + 1);
      if (!inner.length) return;
      if (tooDeep()) {
        blocks.push(...inner);
        return;
      }
      blocks.push({ type: RICH_BLOCK.BLOCKQUOTE, blocks: inner });
    },
    pushCodeBlock(el) {
      flush();
      // The text of a code block is preserved verbatim — newlines included —
      // which is why it never goes through the inline text walk above.
      const text = String(el.textContent || "");
      const codeChild = el.querySelector ? el.querySelector("code") : null;
      let language = null;
      const className = codeChild && typeof codeChild.className === "string" ? codeChild.className : "";
      for (const cls of className.split(/\s+/)) {
        if (cls.startsWith("language-")) {
          language = normalizeCodeLanguage(cls.slice("language-".length));
          break;
        }
      }
      blocks.push({ type: RICH_BLOCK.CODE_BLOCK, language, text });
    },
    pushHorizontalRule() {
      flush();
      blocks.push({ type: RICH_BLOCK.HORIZONTAL_RULE });
    },
    pushTable(el, activeMarks) {
      flush();
      if (tooDeep()) {
        blocks.push(...collectBlocks(el, activeMarks, depth + 1));
        return;
      }
      // A caption is prose about the table; it precedes it as a paragraph.
      const caption = el.querySelector ? el.querySelector(":scope > caption") : null;
      if (caption) blocks.push(...collectBlocks(caption, activeMarks, depth + 1));

      const rows = [];
      for (const tr of tableRowElements(el)) {
        const cells = [];
        for (const cell of tr.children ? Array.from(tr.children) : []) {
          const tag = tagOf(cell);
          if (tag !== "td" && tag !== "th") continue;
          const colspan = normalizeCellSpan(cell.getAttribute("colspan"));
          const rowspan = normalizeCellSpan(cell.getAttribute("rowspan"));
          const cellBlocks = collectBlocks(cell, activeMarks, depth + 1);
          cells.push({
            header: tag === "th",
            colspan,
            rowspan,
            colwidth: normalizeColWidth(cell.getAttribute("colwidth"), colspan),
            blocks: cellBlocks.length ? cellBlocks : [emptyParagraph()],
          });
        }
        if (cells.length) rows.push({ cells });
      }
      if (rows.length) blocks.push({ type: RICH_BLOCK.TABLE, rows: normalizeTableColWidths(rows) });
    },
    pushBlockElement(el, tag, activeMarks) {
      flush();
      const inner = collectBlocks(el, activeMarks, depth);
      // Alignment is only read from a real paragraph, and is applied to what
      // that paragraph produced. Other block tags are separators only.
      const align =
        tag === "p" ? normalizeAnswerAlignment(readStyle(el, "text-align")) : "left";

      if (inner.length === 0) {
        // A genuinely empty paragraph is a blank line the user typed, and is
        // preserved. An empty div/td/heading carries nothing and is dropped.
        if (tag === "p") blocks.push({ type: RICH_BLOCK.PARAGRAPH, align, content: [] });
        return;
      }

      for (const block of inner) {
        if (align !== "left" && block.type === RICH_BLOCK.PARAGRAPH && block.align === "left") {
          blocks.push({ ...block, align });
        } else {
          blocks.push(block);
        }
      }
    },
  };

  // Blocks produced by a nested element are appended in order; inline content
  // accumulates into `current` until something flushes it.
  const children = parent.childNodes ? Array.from(parent.childNodes) : [];
  for (const node of children) walkNode(node, marks, ctx);
  flush();
  return blocks;
}

/**
 * Parse untrusted HTML into the normalized model. Never throws; unusable input
 * produces an empty model.
 */
export function parseAnswerHtmlToModel(html) {
  const body = parseHtmlBody(html);
  if (!body) return [];
  try {
    return collectBlocks(body, {}, 0);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------ */
/* Rendering the model back to normalized HTML                               */
/* ------------------------------------------------------------------------ */

function escapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * The validated text-style declarations of one inline node, as a CSS string
 * safe to interpolate — every value is one this module itself produced.
 */
export function inlineStyleDeclarations(marks) {
  const parts = [];
  if (marks.color) parts.push(`color: ${marks.color}`);
  if (marks.fontFamily) parts.push(`font-family: ${marks.fontFamily}`);
  if (marks.fontSize) parts.push(`font-size: ${marks.fontSize}`);
  return parts.join("; ");
}

function inlineToHtml(node) {
  if (!node) return "";
  if (node.type === "break") return "<br>";
  const marks = node.marks || {};
  let html = escapeText(node.text || "");
  if (marks.code) html = `<code>${html}</code>`;
  if (marks.subscript) html = `<sub>${html}</sub>`;
  if (marks.superscript) html = `<sup>${html}</sup>`;
  if (marks.strike) html = `<s>${html}</s>`;
  if (marks.underline) html = `<u>${html}</u>`;
  if (marks.italic) html = `<em>${html}</em>`;
  if (marks.bold) html = `<strong>${html}</strong>`;
  // Every value below is already validated (colours to #rrggbb, the font
  // family to an approved entry, the size to a bounded "<n>px", the alignment
  // to one of four keywords), so nothing user-controlled is interpolated into
  // CSS. One span carries the whole text style, exactly as the editor's own
  // textStyle mark serializes.
  const style = inlineStyleDeclarations(marks);
  if (style) html = `<span style="${style}">${html}</span>`;
  if (marks.highlight) {
    html = `<mark style="background-color: ${marks.highlight}">${html}</mark>`;
  }
  if (marks.link) html = `<a href="${escapeAttribute(marks.link)}">${html}</a>`;
  return html;
}

function alignStyle(block) {
  const align = block.align && block.align !== "left" ? block.align : null;
  return align ? ` style="text-align: ${align}"` : "";
}

/**
 * Rendering options for `modelToHtml`.
 *
 *   taskCheckbox  "none"  (default) the CANONICAL stored form: a task item
 *                         carries its state as `data-checked` only, exactly the
 *                         shape the TaskItem extension parses (it renders its
 *                         own control);
 *                 "input" a PRESENTATION form for a static document (an
 *                         export): the same label/checkbox/div shape the
 *                         TaskItem NodeView renders, with a disabled native
 *                         checkbox showing the state. Never stored.
 */
const DEFAULT_HTML_OPTIONS = Object.freeze({ taskCheckbox: "none" });

function blocksToHtml(blocks, options = DEFAULT_HTML_OPTIONS) {
  return (Array.isArray(blocks) ? blocks : []).map((b) => blockToHtml(b, options)).join("");
}

function cellToHtml(cell, options) {
  const tag = cell.header ? "th" : "td";
  const colspan = normalizeCellSpan(cell.colspan);
  const rowspan = normalizeCellSpan(cell.rowspan);
  const colwidth = normalizeColWidth(cell.colwidth, colspan);
  let attrs = "";
  if (colspan > 1) attrs += ` colspan="${colspan}"`;
  if (rowspan > 1) attrs += ` rowspan="${rowspan}"`;
  if (colwidth) attrs += ` colwidth="${colwidth.join(",")}"`;
  const inner = blocksToHtml(cell.blocks, options) || "<p></p>";
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

function taskItemHtml(item, options) {
  const checked = !!(item && item.checked);
  const inner = blocksToHtml(item && item.blocks, options) || "<p></p>";
  if (options && options.taskCheckbox === "input") {
    return (
      `<li data-type="taskItem" data-checked="${checked ? "true" : "false"}">` +
      `<label><input type="checkbox" disabled${checked ? " checked" : ""}><span></span></label>` +
      `<div>${inner}</div></li>`
    );
  }
  return `<li data-type="taskItem" data-checked="${checked ? "true" : "false"}">${inner}</li>`;
}

function blockToHtml(block, options = DEFAULT_HTML_OPTIONS) {
  if (!block) return "";
  switch (block.type) {
    case RICH_BLOCK.PARAGRAPH:
      return `<p${alignStyle(block)}>${(block.content || []).map(inlineToHtml).join("")}</p>`;
    case RICH_BLOCK.HEADING: {
      const level = normalizeHeadingLevel(block.level) || 1;
      return `<h${level}${alignStyle(block)}>${(block.content || [])
        .map(inlineToHtml)
        .join("")}</h${level}>`;
    }
    case RICH_BLOCK.BULLET_LIST:
    case RICH_BLOCK.ORDERED_LIST: {
      const tag = block.type === RICH_BLOCK.ORDERED_LIST ? "ol" : "ul";
      const items = (block.items || [])
        .map((item) => `<li>${blocksToHtml(item, options) || "<p></p>"}</li>`)
        .join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case RICH_BLOCK.TASK_LIST: {
      const items = (block.items || []).map((item) => taskItemHtml(item, options)).join("");
      return `<ul data-type="taskList">${items}</ul>`;
    }
    case RICH_BLOCK.BLOCKQUOTE:
      return `<blockquote>${blocksToHtml(block.blocks, options) || "<p></p>"}</blockquote>`;
    case RICH_BLOCK.CODE_BLOCK: {
      const language = normalizeCodeLanguage(block.language);
      const cls = language ? ` class="language-${language}"` : "";
      return `<pre><code${cls}>${escapeText(block.text || "")}</code></pre>`;
    }
    case RICH_BLOCK.HORIZONTAL_RULE:
      return "<hr>";
    case RICH_BLOCK.TABLE: {
      const rows = (block.rows || [])
        .map(
          (row) =>
            `<tr>${(row && row.cells ? row.cells : []).map((cell) => cellToHtml(cell, options)).join("")}</tr>`
        )
        .join("");
      return `<table><tbody>${rows}</tbody></table>`;
    }
    default:
      return "";
  }
}

export function modelToHtml(model, options = DEFAULT_HTML_OPTIONS) {
  return blocksToHtml(model, options);
}

/* ------------------------------------------------------------------------ */
/* Plain-text projections                                                    */
/* ------------------------------------------------------------------------ */

function blockIsPlain(block) {
  if (!block || block.type !== RICH_BLOCK.PARAGRAPH) return false;
  if (block.align && block.align !== "left") return false;
  return (block.content || []).every(
    (node) =>
      node &&
      (node.type === "break" ||
        (node.type === "text" && Object.keys(node.marks || {}).length === 0))
  );
}

/**
 * True when the model carries nothing a plain string cannot hold: text,
 * paragraphs and line breaks, with no marks, structure or alignment. This is
 * what keeps an ordinary answer a compact string instead of a tagged rich
 * value.
 */
export function modelIsPlain(model) {
  return (Array.isArray(model) ? model : []).every(blockIsPlain);
}

function paragraphText(block) {
  return (block.content || [])
    .map((node) => (node.type === "break" ? "\n" : node.text || ""))
    .join("");
}

/** The lossless string form of a plain model. Only valid when modelIsPlain. */
export function modelToPlainString(model) {
  return (Array.isArray(model) ? model : []).map(paragraphText).join("\n");
}

function indentLines(text, indent) {
  return text.split("\n").map((line) => `${indent}${line}`);
}

function modelToReadableText(model, indent = "") {
  const lines = [];
  for (const block of Array.isArray(model) ? model : []) {
    if (!block) continue;
    switch (block.type) {
      case RICH_BLOCK.PARAGRAPH:
      case RICH_BLOCK.HEADING:
        lines.push(indent + paragraphText(block));
        break;
      case RICH_BLOCK.BULLET_LIST:
      case RICH_BLOCK.ORDERED_LIST: {
        const ordered = block.type === RICH_BLOCK.ORDERED_LIST;
        (block.items || []).forEach((item, index) => {
          const marker = ordered ? `${index + 1}. ` : "- ";
          const itemText = modelToReadableText(item, `${indent}  `);
          const [first, ...rest] = itemText.split("\n");
          lines.push(`${indent}${marker}${(first || "").trim()}`);
          for (const line of rest) lines.push(line);
        });
        break;
      }
      case RICH_BLOCK.TASK_LIST:
        (block.items || []).forEach((item) => {
          const marker = item && item.checked ? "[x] " : "[ ] ";
          const itemText = modelToReadableText(item ? item.blocks : [], `${indent}  `);
          const [first, ...rest] = itemText.split("\n");
          lines.push(`${indent}${marker}${(first || "").trim()}`);
          for (const line of rest) lines.push(line);
        });
        break;
      case RICH_BLOCK.BLOCKQUOTE:
        lines.push(...indentLines(modelToReadableText(block.blocks, ""), `${indent}> `));
        break;
      case RICH_BLOCK.CODE_BLOCK:
        lines.push(...indentLines(String(block.text || ""), indent));
        break;
      case RICH_BLOCK.HORIZONTAL_RULE:
        // A rule is not text: it contributes nothing to a text projection.
        break;
      case RICH_BLOCK.TABLE:
        for (const row of block.rows || []) {
          const cells = (row && row.cells ? row.cells : []).map((cell) =>
            modelToReadableText(cell.blocks, "").replace(/\n+/g, " ").trim()
          );
          lines.push(indent + cells.join(" | "));
        }
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

/**
 * A meaningful plain-text projection of any answer value.
 *
 * This is what the AI provider receives — never raw markup — and what an empty
 * check is made against. Structure survives as readable markers rather than
 * being flattened into an unreadable run-on.
 */
export function richAnswerText(value) {
  if (typeof value === "string") return value;
  if (!isRichAnswerValue(value)) return "";
  return modelToReadableText(parseAnswerHtmlToModel(value.html));
}

/** The readable-text projection of a model (blocks), for callers that hold one. */
export function modelToReadable(model) {
  return modelToReadableText(model);
}

export function isEmptyAnswerValue(value) {
  return richAnswerText(value).trim() === "";
}

/* ------------------------------------------------------------------------ */
/* The stored-value boundary                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Canonicalize any stored value for reading, comparison and rendering.
 *
 * A string is returned untouched and is NEVER parsed as HTML. A tagged value is
 * re-sanitized (stored data is untrusted) and demoted back to a plain string if
 * nothing in it needs rich text. Anything else — a boolean, a number, a
 * malformed tagged object — becomes an empty answer.
 *
 * This is a READ-time projection. Nothing here writes to storage: a value is
 * only re-persisted when the user genuinely edits that row.
 */
export function normalizeAnswerValue(value) {
  if (typeof value === "string") return value;
  if (!isRichAnswerValue(value)) return "";
  try {
    const model = parseAnswerHtmlToModel(value.html);
    if (modelIsPlain(model)) return modelToPlainString(model);
    return { format: RICH_TEXT_FORMAT, html: modelToHtml(model) };
  } catch {
    return "";
  }
}

/** The model a renderer should draw: literal text for a string, blocks for rich. */
export function answerToModel(value) {
  const normalized = normalizeAnswerValue(value);
  if (typeof normalized === "string") return plainTextToBlocks(normalized);
  return parseAnswerHtmlToModel(normalized.html);
}

export function plainTextToBlocks(text) {
  const value = typeof text === "string" ? text : "";
  return value
    .split("\n")
    .map((line) => ({
      type: RICH_BLOCK.PARAGRAPH,
      align: "left",
      content: line ? [{ type: "text", text: line, marks: {} }] : [],
    }));
}

/**
 * The document to hand the editor when a row is activated.
 *
 * A plain string becomes a ProseMirror document made of TEXT NODES — it is
 * never handed over as an HTML string, which is what guarantees that a legacy
 * answer containing `<b>` stays literal characters instead of becoming bold.
 */
export function answerToEditorContent(value) {
  const normalized = normalizeAnswerValue(value);
  if (typeof normalized === "string") return plainTextToDoc(normalized);
  return normalized.html;
}

export function plainTextToDoc(text) {
  const value = typeof text === "string" ? text : "";
  return {
    type: "doc",
    content: value.split("\n").map((line) =>
      line
        ? { type: "paragraph", content: [{ type: "text", text: line }] }
        : { type: "paragraph" }
    ),
  };
}

/**
 * The answer value for what the editor currently holds.
 *
 * Content that only needs a string becomes a string; only content that
 * genuinely carries marks, structure or alignment becomes a tagged rich value.
 */
export function serializeAnswerFromHtml(html) {
  const model = parseAnswerHtmlToModel(html);
  if (modelIsPlain(model)) return modelToPlainString(model);
  return { format: RICH_TEXT_FORMAT, html: modelToHtml(model) };
}

/* ------------------------------------------------------------------------ */
/* Comparison                                                                */
/* ------------------------------------------------------------------------ */

/**
 * A canonical string for one answer value, so two values can be compared by
 * MEANING rather than by object identity. Two rich values holding the same
 * markup compare equal; a string and a rich value never do, even when their
 * plain text matches — a formatting-only change is a real change.
 */
export function answerIdentity(value) {
  const normalized = normalizeAnswerValue(value);
  if (typeof normalized === "string") return `s ${normalized}`;
  return `r ${normalized.html}`;
}

export function answersEqual(a, b) {
  return answerIdentity(a) === answerIdentity(b);
}

/* ------------------------------------------------------------------------ */
/* Inserting literal text (BottomBar / transcription)                        */
/* ------------------------------------------------------------------------ */

/**
 * ProseMirror nodes for inserting text LITERALLY at the cursor.
 *
 * Deliberately not a string: TipTap parses a string as HTML, so inserted or
 * transcribed text containing markup characters would become nodes. Empty text
 * nodes are omitted because ProseMirror refuses them.
 */
export function textInsertionNodes(text) {
  if (typeof text !== "string" || text === "") return [];
  const nodes = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (line) nodes.push({ type: "text", text: line });
  });
  return nodes;
}

/**
 * Append text to an answer that is NOT currently being edited, preserving the
 * existing "blank field takes the text, otherwise a new line" behaviour and the
 * value's representation.
 */
export function appendTextToAnswer(value, text) {
  if (typeof text !== "string" || text === "") return normalizeAnswerValue(value);
  const normalized = normalizeAnswerValue(value);

  if (typeof normalized === "string") {
    if (normalized.trim().length === 0) return text;
    return normalized.endsWith("\n") ? normalized + text : `${normalized}\n${text}`;
  }

  const model = parseAnswerHtmlToModel(normalized.html);
  const appended = model.concat(plainTextToBlocks(text));
  return { format: RICH_TEXT_FORMAT, html: modelToHtml(appended) };
}
