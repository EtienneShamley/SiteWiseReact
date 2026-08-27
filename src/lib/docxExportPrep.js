// src/lib/docxExportPrep.js
//
// The WORD FIDELITY BOUNDARY — one preparation step every DOCX export runs
// its HTML through, immediately before html-to-docx, plus the conversion
// options that make the document default match the HTML/PDF exports.
//
// Why this exists. html-to-docx converts HTML to WordprocessingML but reads a
// narrow slice of it: it skips <head> (so every stylesheet rule NoteWise
// writes is ignored), honours only a handful of INLINE properties (color,
// background-color, text-align, font-family, font-size in px/pt,
// line-height, margin-left/right, width), sizes images from inline px only
// (a % width is a share of the image's own pixels), sizes table cells from
// px/pt/cm/in only (never %), drops <mark>, <em>, <s> and inline <code>
// formatting outright (it knows <i> but not <em>), converts only the FIRST
// child of an <a>, and turns any colour it cannot parse — `inherit`,
// `currentColor`, `var(--x)` — into black. (Each of these was confirmed
// against the library's real output; see docxExportPrep.test.js.) Each rule below
// closes one of those gaps at the boundary, deterministically, so the same
// note exports the same way from every entry point (Export menu, Share
// dialog, Document Preview, Template export).
//
// What this is NOT: it never changes what the HTML/PDF/Markdown exports
// receive — it runs on a copy, after their shared adapters, only on the DOCX
// path — and it never invents content. Where Word cannot represent something
// the degradation is explicit and listed in docs/ARCHITECTURE.md → "Word
// export fidelity contract".
//
// The functions are pure over a DOM string (DOMParser) so they run the same
// in the browser and in jsdom tests.

/* ------------------------------ Page model ------------------------------ */

const TWIPS_PER_INCH = 1440;
const PX_PER_INCH = 96;

/** A4 in twips, with html-to-docx's default one-inch margins. */
export const DOCX_PAGE = Object.freeze({
  widthTwips: 11906,
  heightTwips: 16838,
  marginTwips: 1440,
});

/** Width of the printable area in CSS px — what a 100 % image or table fills. */
export const DOCX_CONTENT_WIDTH_PX = Math.floor(
  ((DOCX_PAGE.widthTwips - 2 * DOCX_PAGE.marginTwips) / TWIPS_PER_INCH) * PX_PER_INCH
); // 601

/** The document default font — the same family the HTML/PDF stylesheets use. */
export const DOCX_DEFAULT_FONT = "Arial";

/**
 * html-to-docx options for a NoteWise document. `fontSizePt` is the body
 * size the HTML stylesheet declares for that document kind (12 for a
 * Free-form note, 11 for a Template); the library takes half-points.
 */
export function docxConversionOptions({ fontSizePt = 12 } = {}) {
  const half = Math.max(2, Math.round(fontSizePt * 2));
  return {
    font: DOCX_DEFAULT_FONT,
    fontSize: half,
    complexScriptFontSize: half,
    pageSize: { width: DOCX_PAGE.widthTwips, height: DOCX_PAGE.heightTwips },
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  };
}

/* ------------------------------ Helpers --------------------------------- */

const COLOUR_KEYWORDS = new Set([
  "black", "silver", "gray", "grey", "white", "maroon", "red", "purple", "fuchsia", "green",
  "lime", "olive", "yellow", "navy", "blue", "teal", "aqua", "orange", "transparent",
]);

/** A colour html-to-docx can turn into RRGGBB (or a keyword it ignores). */
export function isDocxColour(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return false;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return true;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/.test(v)) return true;
  if (/^hsla?\(/.test(v)) return true;
  if (COLOUR_KEYWORDS.has(v)) return true;
  return /^[a-z]+$/.test(v) && !["inherit", "initial", "unset", "currentcolor", "revert"].includes(v);
}

const px = (n) => `${Math.max(1, Math.round(n))}px`;

// The style attribute is handled as TEXT, not through the CSSOM: jsdom (and
// some browsers) silently drop declarations they consider invalid — `color:
// inherit` among them — while html-to-docx parses the raw attribute and
// would still see them.
function readStyle(el) {
  const raw = el.getAttribute("style") || "";
  const decls = [];
  for (const part of raw.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (prop && value) decls.push([prop, value]);
  }
  return decls;
}

function writeStyle(el, decls) {
  if (!decls.length) {
    el.removeAttribute("style");
    return;
  }
  // Canonical order, so preparing prepared HTML is byte-identical.
  const sorted = decls.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  el.setAttribute("style", sorted.map(([p, v]) => `${p}: ${v}`).join("; "));
}

const getDecl = (decls, prop) => {
  const hit = decls.find(([p]) => p === prop);
  return hit ? hit[1] : "";
};
const setDecl = (decls, prop, value) => {
  const i = decls.findIndex(([p]) => p === prop);
  if (i >= 0) decls[i] = [prop, value];
  else decls.push([prop, value]);
};
const dropDecl = (decls, prop) => {
  for (let i = decls.length - 1; i >= 0; i -= 1) if (decls[i][0] === prop) decls.splice(i, 1);
};

function parseLength(value, base) {
  const s = String(value || "").trim();
  let m = s.match(/^([\d.]+)px$/i);
  if (m) return Number(m[1]);
  m = s.match(/^([\d.]+)pt$/i);
  if (m) return (Number(m[1]) * PX_PER_INCH) / 72;
  m = s.match(/^([\d.]+)%$/);
  if (m && base > 0) return (Number(m[1]) / 100) * base;
  return null;
}

function wrapChildren(doc, el, tagName) {
  const wrapper = doc.createElement(tagName);
  while (el.firstChild) wrapper.appendChild(el.firstChild);
  el.appendChild(wrapper);
}

/* -------------------------------- Rules --------------------------------- */

/**
 * Rule 1 — colours. Drop `color` / `background-color` values Word cannot
 * hold (`inherit`, `currentColor`, custom properties): html-to-docx would
 * otherwise emit BLACK for them, which is how a highlighted run in a
 * Free-form note came out black in Word. Also drop `transparent`
 * backgrounds so they never become shading.
 */
function sanitizeColours(decls) {
  for (const prop of ["color", "background-color"]) {
    const v = getDecl(decls, prop);
    if (!v) continue;
    if (!isDocxColour(v) || (prop === "background-color" && /^transparent$/i.test(v.trim()))) {
      dropDecl(decls, prop);
    }
  }
}

/**
 * Rule 2 — highlight. `<mark>` is exported as SHADING in the mark's own
 * colour (a plain span with background-color) rather than Word's
 * fixed-palette yellow highlighter, so the colour the user chose survives.
 */
function markToShading(doc, mark) {
  const span = doc.createElement("span");
  const decls = readStyle(mark);
  const out = [];
  const bg = getDecl(decls, "background-color") || mark.getAttribute("data-color");
  if (bg && isDocxColour(bg)) out.push(["background-color", bg]);
  const color = getDecl(decls, "color");
  if (color && isDocxColour(color)) out.push(["color", color]);
  writeStyle(span, out);
  while (mark.firstChild) span.appendChild(mark.firstChild);
  mark.replaceWith(span);
}

/**
 * Rule 2b — emphasis tags. html-to-docx renders <i> but NOT <em> (Tiptap's
 * italic mark), and an <em> inside <strong> loses the bold as well; <code>
 * outside <pre> renders as plain text. <em> becomes <i>; inline <code>
 * becomes a Courier New span. Strikethrough (<s>/<del>/<strike>) has no
 * representation in this converter and is a documented degradation.
 */
function renameTag(doc, el, tagName) {
  const next = doc.createElement(tagName);
  for (const attr of Array.from(el.attributes)) next.setAttribute(attr.name, attr.value);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
  return next;
}

/**
 * Rule 3 — inline typography that html-to-docx only understands as TAGS:
 * `font-weight` ≥ 600 / bold / bolder → <b>; `font-style: italic|oblique` →
 * <i>; `text-decoration` underline → <u>, line-through → <s>. Relative font
 * sizes (em/rem/%) are removed: the library would render them as 5 pt.
 */
function inlineTypographyToTags(doc, el, decls) {
  const weight = getDecl(decls, "font-weight").toLowerCase();
  if (weight && (weight === "bold" || weight === "bolder" || Number(weight) >= 600)) {
    if (!el.closest("b, strong")) wrapChildren(doc, el, "b");
  }
  if (weight) dropDecl(decls, "font-weight");
  const style = getDecl(decls, "font-style").toLowerCase();
  if (style === "italic" || style === "oblique") {
    if (!el.closest("i, em")) wrapChildren(doc, el, "i");
  }
  if (style) dropDecl(decls, "font-style");
  const deco = `${getDecl(decls, "text-decoration")} ${getDecl(decls, "text-decoration-line")}`.toLowerCase();
  if (/underline/.test(deco) && !el.closest("u, ins")) wrapChildren(doc, el, "u");
  if (/line-through/.test(deco) && !el.closest("s, strike, del")) wrapChildren(doc, el, "s");
  if (deco.trim()) {
    dropDecl(decls, "text-decoration");
    dropDecl(decls, "text-decoration-line");
  }
  const size = getDecl(decls, "font-size");
  if (size && !/^[\d.]+(px|pt)$/i.test(size)) dropDecl(decls, "font-size");
}

/**
 * Rule 4 — images. Word takes an absolute pixel box. A `%` width (the
 * editor's stored share of the content width) becomes that share of the
 * DOCX printable width; `width`/`height` attributes (the Template renderer's
 * computed pixel box) become the same inline style. Height follows the
 * intrinsic ratio when it is known and is otherwise left to the library.
 * Nothing is ever wider than the printable area.
 */
function sizeImage(img, contentWidthPx) {
  const attrW = Number(img.getAttribute("width"));
  const attrH = Number(img.getAttribute("height"));
  const ratio = attrW > 0 && attrH > 0 ? attrH / attrW : null;
  const decls = readStyle(img);
  let width = parseLength(getDecl(decls, "width"), contentWidthPx);
  if (width === null && attrW > 0) width = attrW;
  if (width === null) return;
  width = Math.min(width, contentWidthPx);
  setDecl(decls, "width", px(width));
  let height = parseLength(getDecl(decls, "height"), 0);
  if (height === null && ratio) height = width * ratio;
  if (height !== null && height > 0) setDecl(decls, "height", px(height));
  else setDecl(decls, "height", "auto");
  writeStyle(img, decls);
}

/**
 * Rule 5 — tables. A table fills the printable width unless it carries an
 * explicit px width; `<col>` widths (px or %) and `%` cell widths become px
 * cell widths — the only unit html-to-docx writes into `tcW` — so a
 * label/value split or a Tiptap column layout keeps its proportions. Cells
 * without an inline border get `cellBorder` (the stylesheet rule Word never
 * sees) when the caller supplies one.
 */
function layoutTable(table, { contentWidthPx, cellBorder }) {
  const tableDecls = readStyle(table);
  let tableWidth = parseLength(getDecl(tableDecls, "width"), contentWidthPx);
  if (tableWidth === null || tableWidth > contentWidthPx) tableWidth = contentWidthPx;
  setDecl(tableDecls, "width", px(tableWidth));
  writeStyle(table, tableDecls);

  const cols = Array.from(table.querySelectorAll(":scope > colgroup > col, :scope > col"));
  const colWidths = cols.map((col) => {
    const w = parseLength(getDecl(readStyle(col), "width"), tableWidth);
    if (w !== null) return w;
    const attr = col.getAttribute("width");
    return attr ? parseLength(/%$/.test(attr) ? attr : `${attr}px`, tableWidth) : null;
  });
  const known = colWidths.filter((w) => w !== null);
  const scale = known.length && known.reduce((a, b) => a + b, 0) > tableWidth
    ? tableWidth / known.reduce((a, b) => a + b, 0)
    : 1;

  const rows = Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === table);
  for (const tr of rows) {
    const cells = Array.from(tr.children).filter((c) => /^t[dh]$/i.test(c.tagName));
    let colIndex = 0;
    for (const cell of cells) {
      const span = Math.max(1, Number(cell.getAttribute("colspan")) || 1);
      const decls = readStyle(cell);
      const own = parseLength(getDecl(decls, "width"), tableWidth);
      if (own !== null) {
        setDecl(decls, "width", px(Math.min(own, tableWidth)));
      } else if (colWidths.length && span === 1 && colWidths[colIndex] != null) {
        setDecl(decls, "width", px(colWidths[colIndex] * scale));
      } else if (colWidths.length && span > 1) {
        const sum = colWidths.slice(colIndex, colIndex + span).reduce((a, b) => a + (b || 0), 0);
        if (sum > 0) setDecl(decls, "width", px(sum * scale));
      }
      if (
        cellBorder &&
        !getDecl(decls, "border") &&
        !["top", "right", "bottom", "left"].some((side) => getDecl(decls, `border-${side}`))
      ) {
        setDecl(decls, "border", cellBorder);
      }
      writeStyle(cell, decls);
      colIndex += span;
    }
  }
  // Word reads the widths from the cells; the <col> elements are inert.
  for (const col of cols) col.remove();
  for (const cg of Array.from(table.querySelectorAll(":scope > colgroup"))) cg.remove();
}

/**
 * Rule 6 — one run per text leaf. html-to-docx applies a formatting TAG
 * only to text it directly contains or to mixed children: `<strong><i>x</i>
 * </strong>` loses the bold, `<u><i>x</i></u>` the underline, a styled span
 * AROUND a link loses the link, and an anchor with several children keeps
 * only the first. So every text leaf is rebuilt from the formatting its
 * inline ancestors carry, in the one shape the converter renders fully:
 *
 *     <a href>?  >  <span style="…; font-weight: bold">?  >  <i>|<u>|<sub>|<sup>
 *
 * (a style span propagates into a tag child; bold is therefore carried as
 * `font-weight: bold` rather than as a tag). Italic AND underline on one
 * leaf need two tags, which the converter only combines around a text
 * sibling: a zero-width space is placed before the leaf in that one case.
 */
const INLINE_FORMAT_TAGS = new Set(["a", "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span", "font", "sub", "sup"]);
const ATOMIC_INLINE = new Set(["img", "br"]);
const ZWSP = "\u200B";

function extendContext(ctx, el) {
  const tag = el.tagName.toLowerCase();
  const next = { ...ctx, decls: ctx.decls.slice() };
  if (tag === "a" && el.getAttribute("href") != null) {
    next.href = el.getAttribute("href");
    next.anchorAttrs = Array.from(el.attributes).map((a) => [a.name, a.value]);
  }
  if (tag === "b" || tag === "strong") next.bold = true;
  if (tag === "i" || tag === "em") next.italic = true;
  if (tag === "u" || tag === "ins") next.underline = true;
  if (tag === "s" || tag === "strike" || tag === "del") next.strike = true;
  if (tag === "sub") next.sub = true;
  if (tag === "sup") next.sup = true;
  for (const [prop, value] of readStyle(el)) {
    if (prop === "font-weight") {
      const w = value.toLowerCase();
      if (w === "bold" || w === "bolder" || Number(w) >= 600) next.bold = true;
      continue;
    }
    setDecl(next.decls, prop, value);
  }
  return next;
}

function buildLeaf(doc, ctx, node) {
  let inner = node;
  const tags = [];
  if (ctx.italic) tags.push("i");
  if (ctx.underline) tags.push("u");
  if (ctx.strike) tags.push("s");
  if (ctx.sub) tags.push("sub");
  else if (ctx.sup) tags.push("sup");
  // Innermost first: the converter renders one tag around text fully.
  for (const tag of tags.slice().reverse()) {
    const el = doc.createElement(tag);
    el.appendChild(inner);
    inner = el;
  }
  if (tags.length > 1) {
    // Two tag formats: the outer tag renders only with a text sibling.
    inner.insertBefore(doc.createTextNode(ZWSP), inner.firstChild);
  }
  const decls = ctx.decls.slice();
  if (ctx.bold) setDecl(decls, "font-weight", "bold");
  if (decls.length) {
    const span = doc.createElement("span");
    writeStyle(span, decls);
    span.appendChild(inner);
    inner = span;
  }
  if (ctx.href != null) {
    const a = doc.createElement("a");
    for (const [name, value] of ctx.anchorAttrs || []) a.setAttribute(name, value);
    a.appendChild(inner);
    inner = a;
  }
  return inner;
}

const EMPTY_CTX = { href: null, anchorAttrs: null, bold: false, italic: false, underline: false, strike: false, sub: false, sup: false, decls: [] };

function hasInlineFormatChild(el) {
  return Array.from(el.children).some((c) => INLINE_FORMAT_TAGS.has(c.tagName.toLowerCase()));
}

function normalizeInlineRuns(doc, container) {
  if (!hasInlineFormatChild(container)) {
    for (const child of Array.from(container.children)) normalizeInlineRuns(doc, child);
    return;
  }
  const out = [];
  const walk = (node, ctx) => {
    if (node.nodeType === 3) {
      if (!node.textContent) return;
      // A zero-width space placed by an earlier pass is rebuilt, not kept.
      if (node.textContent === ZWSP) return;
      out.push(buildLeaf(doc, ctx, doc.createTextNode(node.textContent)));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (INLINE_FORMAT_TAGS.has(tag)) {
      const next = extendContext(ctx, node);
      for (const child of Array.from(node.childNodes)) walk(child, next);
      return;
    }
    if (ATOMIC_INLINE.has(tag)) {
      let el = node;
      if (ctx.href != null && tag === "img") {
        const a = doc.createElement("a");
        for (const [name, value] of ctx.anchorAttrs || []) a.setAttribute(name, value);
        a.appendChild(node);
        el = a;
      }
      out.push(el);
      return;
    }
    // A block-level element inside an inline chain keeps its own content.
    normalizeInlineRuns(doc, node);
    out.push(node);
  };
  for (const child of Array.from(container.childNodes)) walk(child, EMPTY_CTX);
  while (container.firstChild) container.removeChild(container.firstChild);
  for (const node of out) container.appendChild(node);
}

/**
 * Rule 7 — attachment references. The export card
 * `<div class="note-file-attachment-export"><strong>name</strong><span>meta</span></div>`
 * would become two paragraphs (a <div> is not a paragraph to html-to-docx).
 * It becomes ONE paragraph — name in bold, the metadata muted — the
 * "labelled attachment line" the contract promises.
 */
function attachmentToParagraph(doc, div) {
  const p = doc.createElement("p");
  const parts = Array.from(div.childNodes);
  parts.forEach((node, i) => {
    if (i > 0) p.appendChild(doc.createTextNode(" "));
    if (node.nodeType === 1 && node.tagName.toLowerCase() === "span") {
      const decls = readStyle(node);
      if (!getDecl(decls, "color")) {
        setDecl(decls, "color", "#555555");
        writeStyle(node, decls);
      }
    }
    p.appendChild(node);
  });
  div.replaceWith(p);
}

/* -------------------------------- Entry --------------------------------- */

function parseDocument(html) {
  if (typeof DOMParser === "undefined") return null;
  return new DOMParser().parseFromString(String(html || ""), "text/html");
}

function serialize(doc, hadHtmlWrapper) {
  if (hadHtmlWrapper) return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
  return doc.body.innerHTML;
}

/**
 * Prepare an HTML document (or fragment) for html-to-docx. Returns the
 * rewritten HTML, or the input unchanged where no DOM is available. The
 * transformation is idempotent: preparing prepared HTML changes nothing.
 *
 * `cellBorder` — inline border applied to cells without one (Free-form
 * tables rely on a stylesheet rule; Template cells already carry theirs).
 */
export function prepareHtmlForDocx(
  html,
  { contentWidthPx = DOCX_CONTENT_WIDTH_PX, cellBorder = null } = {}
) {
  const doc = parseDocument(html);
  if (!doc || !doc.body) return html;
  const hadHtmlWrapper = /<html[\s>]/i.test(String(html || ""));
  const body = doc.body;

  for (const mark of Array.from(body.querySelectorAll("mark"))) markToShading(doc, mark);
  for (const em of Array.from(body.querySelectorAll("em"))) renameTag(doc, em, "i");
  for (const code of Array.from(body.querySelectorAll("code"))) {
    if (code.closest("pre")) continue;
    const span = renameTag(doc, code, "span");
    const decls = readStyle(span);
    if (!getDecl(decls, "font-family")) setDecl(decls, "font-family", "Courier New");
    writeStyle(span, decls);
  }
  for (const el of Array.from(body.querySelectorAll("[style]"))) {
    const decls = readStyle(el);
    sanitizeColours(decls);
    inlineTypographyToTags(doc, el, decls);
    writeStyle(el, decls);
  }
  for (const img of Array.from(body.querySelectorAll("img"))) sizeImage(img, contentWidthPx);
  for (const table of Array.from(body.querySelectorAll("table"))) {
    layoutTable(table, { contentWidthPx, cellBorder });
  }
  for (const div of Array.from(body.querySelectorAll("div.note-file-attachment-export"))) {
    attachmentToParagraph(doc, div);
  }
  normalizeInlineRuns(doc, body);
  return serialize(doc, hadHtmlWrapper);
}

/**
 * The formatting the Word export preserves or degrades — the contract the
 * documentation, the tests and the Document Preview notice all describe.
 * Kept as data so the docs cannot drift from the code.
 */
export const DOCX_FIDELITY_CONTRACT = Object.freeze([
  { property: "Font family", rule: "preserved (named span fonts; document default Arial)" },
  { property: "Font size", rule: "preserved for px/pt sizes; relative sizes fall back to the document size" },
  { property: "Bold / italic / underline", rule: "preserved (tags and inline styles)" },
  { property: "Strikethrough", rule: "not representable by the converter — the text is kept, the strike is dropped" },
  { property: "Inline code", rule: "Courier New run; code blocks keep the converter's Courier paragraph" },
  { property: "Text colour", rule: "preserved for hex/rgb/hsl/named colours; inherited colours are dropped, never black" },
  { property: "Highlight", rule: "preserved as run shading in the chosen colour (not Word's fixed highlighter palette)" },
  { property: "Alignment", rule: "preserved (left/centre/right/justify)" },
  { property: "Paragraph spacing", rule: "Word's own single spacing with 6 pt after each paragraph" },
  { property: "Lists", rule: "preserved with nesting; task lists become ☑/☐ paragraphs" },
  { property: "Tables", rule: "structure, colspan/rowspan, cell fills and inline borders preserved; column proportions preserved as fixed widths" },
  { property: "Images", rule: "sized to the same share of the printable width as the note; never wider than the page; wrapped placement becomes block placement" },
  { property: "Attachments", rule: "one labelled reference line (name, type, size); the file is not embedded" },
  { property: "Page breaks", rule: "Word paginates; explicit breaks are not exported" },
  { property: "PDF annotations", rule: "not exported to Word — the annotated PDF is a flattened PDF export" },
]);
