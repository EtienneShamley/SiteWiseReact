// src/lib/templateRichText.js
//
// The value model and safety boundary for Template form Text answers.
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
// SECURITY — the sanitization boundary lives here and nowhere else:
//   - HTML is PARSED (DOMParser) and REBUILT from an explicit whitelist. It is
//     never pattern-stripped, never patched, and never passed through.
//   - Only p, br, strong, em, u, s, ul, ol, li, span, mark and a survive.
//     Everything else is either dropped whole (script/style/media/controls) or
//     unwrapped so its readable text survives without its element.
//   - The only style properties that survive are text-align on a paragraph and
//     color / background-color on an inline span / mark, each rebuilt from a
//     validated value. A raw style string is never carried across.
//   - Link hrefs go through the project's existing URL policy
//     (src/lib/editorUrlSafety.js). A rejected link becomes ordinary text.
//   - Nothing produced here can carry an event handler, a data attribute, a
//     ProseMirror/runtime attribute, a DOM reference or an object URL, because
//     the output is built from the model rather than copied from the input.
//
// Sanitization runs at every boundary: reading a stored value, loading it into
// the editor, serializing an edit, rendering a static answer, and printing.
//
// Framework-agnostic (no React, no storage, no editor). It uses DOMParser,
// which exists in the browser and in the jsdom test environment.

import { normalizeLinkUrl } from "./editorUrlSafety";
import { isValidHexColor, normalizeHexColor } from "./templateBranding";

export const RICH_TEXT_FORMAT = "richtext/1";

export const ANSWER_ALIGNMENTS = ["left", "center", "right", "justify"];

// Elements whose CONTENT is not user prose. Dropped whole — text included.
const DROP_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "object", "embed",
  "img", "picture", "source", "track", "video", "audio", "canvas", "svg",
  "math", "input", "textarea", "select", "option", "button", "form", "label",
  "fieldset", "legend", "link", "meta", "base", "title", "head", "map", "area",
  "frame", "frameset", "applet", "portal", "dialog", "slot",
]);

// Elements that are not approved but DO separate content. Their readable text
// is kept, as its own paragraph, so pasting a heading or a table does not lose
// the words in it.
const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
  "section", "article", "aside", "header", "footer", "main", "nav", "figure",
  "figcaption", "table", "thead", "tbody", "tfoot", "caption", "tr", "td",
  "th", "dl", "dt", "dd", "address", "hr", "details", "summary",
]);

// Guard against pathological nesting in stored or pasted content.
const MAX_LIST_DEPTH = 6;

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
/* Value validation (colours, alignment, links)                              */
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

/* ------------------------------------------------------------------------ */
/* Parsing HTML into the normalized model                                    */
/* ------------------------------------------------------------------------ */
//
// Model:
//   Block  = { type: "paragraph", align, content: Inline[] }
//          | { type: "bulletList" | "orderedList", items: Block[][] }
//   Inline = { type: "text", text, marks: { bold, italic, underline, strike,
//                                           color, highlight, link } }
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

function walkChildren(parent, marks, ctx) {
  const children = parent.childNodes ? Array.from(parent.childNodes) : [];
  for (const node of children) walkNode(node, marks, ctx);
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

  const tag = String(node.tagName || "").toLowerCase();
  if (!tag || DROP_TAGS.has(tag)) return;

  if (tag === "br") {
    ctx.pushBreak();
    return;
  }

  if (tag === "ul" || tag === "ol") {
    ctx.pushList(node, tag === "ol" ? "orderedList" : "bulletList", marks);
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
    case "mark": {
      const color = normalizeAnswerColor(readStyle(node, "background-color"));
      return walkChildren(node, color ? { ...marks, highlight: color } : marks, ctx);
    }
    case "span": {
      const color = normalizeAnswerColor(readStyle(node, "color"));
      return walkChildren(node, color ? { ...marks, color } : marks, ctx);
    }
    case "a": {
      const href = safeAnswerLinkHref(node.getAttribute("href"));
      // An unsafe or malformed href drops the link mark only — the words the
      // user wrote stay, as ordinary text.
      return walkChildren(node, href ? { ...marks, link: href } : marks, ctx);
    }
    default:
      break;
  }

  if (tag === "li" || BLOCK_TAGS.has(tag)) {
    ctx.pushBlockElement(node, tag, marks);
    return;
  }

  // Any other element (font, small, abbr, code, custom elements…): unwrap it
  // and keep its text.
  walkChildren(node, marks, ctx);
}

function collectBlocks(parent, marks, depth) {
  const blocks = [];
  let current = null;

  const flush = () => {
    if (current && current.content.length > 0) {
      blocks.push({
        type: "paragraph",
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
      if (depth >= MAX_LIST_DEPTH) {
        // Too deep to be real content: keep the words, drop the structure.
        const inner = collectBlocks(el, activeMarks, depth + 1);
        blocks.push(...inner);
        return;
      }
      const items = [];
      const children = el.children ? Array.from(el.children) : [];
      for (const child of children) {
        if (String(child.tagName || "").toLowerCase() !== "li") continue;
        const itemBlocks = collectBlocks(child, activeMarks, depth + 1);
        items.push(
          itemBlocks.length
            ? itemBlocks
            : [{ type: "paragraph", align: "left", content: [] }]
        );
      }
      if (items.length) blocks.push({ type, items });
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
        if (tag === "p") blocks.push({ type: "paragraph", align, content: [] });
        return;
      }

      for (const block of inner) {
        if (align !== "left" && block.type === "paragraph" && block.align === "left") {
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

function inlineToHtml(node) {
  if (!node) return "";
  if (node.type === "break") return "<br>";
  const marks = node.marks || {};
  let html = escapeText(node.text || "");
  if (marks.strike) html = `<s>${html}</s>`;
  if (marks.underline) html = `<u>${html}</u>`;
  if (marks.italic) html = `<em>${html}</em>`;
  if (marks.bold) html = `<strong>${html}</strong>`;
  // Both colour values are already validated to #rrggbb, and the alignment to
  // one of four keywords, so nothing user-controlled is interpolated into CSS.
  if (marks.color) html = `<span style="color: ${marks.color}">${html}</span>`;
  if (marks.highlight) {
    html = `<mark style="background-color: ${marks.highlight}">${html}</mark>`;
  }
  if (marks.link) html = `<a href="${escapeAttribute(marks.link)}">${html}</a>`;
  return html;
}

function blockToHtml(block) {
  if (!block) return "";
  if (block.type === "paragraph") {
    const align = block.align && block.align !== "left" ? block.align : null;
    const style = align ? ` style="text-align: ${align}"` : "";
    return `<p${style}>${(block.content || []).map(inlineToHtml).join("")}</p>`;
  }
  const tag = block.type === "orderedList" ? "ol" : "ul";
  const items = (block.items || [])
    .map((item) => `<li>${(item || []).map(blockToHtml).join("")}</li>`)
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

export function modelToHtml(model) {
  return (Array.isArray(model) ? model : []).map(blockToHtml).join("");
}

/* ------------------------------------------------------------------------ */
/* Plain-text projections                                                    */
/* ------------------------------------------------------------------------ */

function blockIsPlain(block) {
  if (!block || block.type !== "paragraph") return false;
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
 * paragraphs and line breaks, with no marks, lists or alignment. This is what
 * keeps an ordinary answer a compact string instead of a tagged rich value.
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

function modelToReadableText(model, indent = "") {
  const lines = [];
  for (const block of Array.isArray(model) ? model : []) {
    if (!block) continue;
    if (block.type === "paragraph") {
      lines.push(indent + paragraphText(block));
      continue;
    }
    const ordered = block.type === "orderedList";
    (block.items || []).forEach((item, index) => {
      const marker = ordered ? `${index + 1}. ` : "- ";
      const itemText = modelToReadableText(item, `${indent}  `);
      const [first, ...rest] = itemText.split("\n");
      lines.push(`${indent}${marker}${(first || "").trim()}`);
      for (const line of rest) lines.push(line);
    });
  }
  return lines.join("\n");
}

/**
 * A meaningful plain-text projection of any answer value.
 *
 * This is what the AI provider receives — never raw markup — and what an empty
 * check is made against. List structure survives as readable markers rather
 * than being flattened into an unreadable run-on.
 */
export function richAnswerText(value) {
  if (typeof value === "string") return value;
  if (!isRichAnswerValue(value)) return "";
  return modelToReadableText(parseAnswerHtmlToModel(value.html));
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
      type: "paragraph",
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
 * genuinely carries marks, lists or alignment becomes a tagged rich value.
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
  if (typeof normalized === "string") return `s ${normalized}`;
  return `r ${normalized.html}`;
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
