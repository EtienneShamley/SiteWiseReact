// src/lib/templateExportHtml.js
//
// The canonical Template export model rendered to HTML.
//
// One renderer serves three flavours:
//   "standalone" — the downloadable .html file: self-contained, script-free,
//                  no external asset, opens correctly offline
//   "pdf"        — the same document laid out page by page for html2pdf, with
//                  explicit page breaks computed from the shared A4 geometry
//   "docx"       — a restrained subset html-to-docx can carry into Word
//
// SAFETY
//   - Rich-text answers are rendered through the EXISTING sanitization boundary
//     (`answerToModel` + `modelToHtml`, src/lib/templateRichText.js). Stored
//     HTML is never passed through: the output is rebuilt from the normalized
//     model, so only the model's own elements (p, h1–h6, br, strong, em, u, s,
//     sub, sup, code, pre, blockquote, hr, ul, ol, li, table, tbody, tr, td,
//     th, span, mark, a — plus a disabled checkbox for a task item's state)
//     can appear, colours are already validated to #rrggbb, fonts to the
//     approved family list and a bounded pixel size, alignment is one of four
//     keywords, and hrefs have already passed the project's URL policy.
//   - Every other string (labels, note title, template name, filenames, field
//     values) is HTML-escaped here.
//   - Colours and dimensions come from `normalizeBranding` / `photoLayout`, so
//     no stored string reaches a style declaration verbatim.
//   - No script, no event handler, no external URL, no object URL, no `blob:`
//     URL and no internal asset or field id is ever emitted.

import {
  brandingStyles,
  normalizeBranding,
  layoutShowsLogo,
} from "./templateBranding";
import { RICH_BLOCK, modelToHtml } from "./templateRichText";
import { headerTextModel, headerTextModelIsEmpty } from "./templateHeaderLayout";
import { EXPORT_UNIT } from "./templateExportModel";
import {
  MEDIA_LAYOUT_MODE,
  MEDIA_LAYOUT_MODE_ATTR,
  MEDIA_LAYOUT_SIDE,
  MEDIA_LAYOUT_SIDE_ATTR,
  mediaWrapExportCss,
} from "./editorMediaLayout";
import { normalizeRowHeightPx, photoLayout } from "./templateExportPagination";
import { USABLE_HEIGHT_PX, USABLE_WIDTH_PX } from "./pageGeometry";
import {
  PDF_PAGE_CONTENT_HEIGHT_PX,
  USABLE_WIDTH_MM,
} from "./templateExportCapture";

export const EXPORT_FLAVOR = {
  STANDALONE: "standalone",
  PDF: "pdf",
  DOCX: "docx",
};

// Mirrors PhotoAttachment.PHOTO_MAX_HEIGHT_PX: the usable A4 content height
// less an allowance for cell padding and continuation context, so one photo
// always fits inside a single page and is scaled down rather than cropped.
// This is the DOCX/standalone bound; the PDF derives a tighter one from the
// page capacity it actually paginates against (see makeRenderContext).
export const EXPORT_PHOTO_MAX_HEIGHT_PX = Math.round(USABLE_HEIGHT_PX - 60);

// `.nw-tpl-label` / `.nw-tpl-cell` vertical padding (6px top + 6px bottom). The
// minimum-height box lives INSIDE the cell, so the stored row height has to have
// the cell's own chrome taken off it for the row to come out the height the
// template author actually set.
export const ROW_CELL_VERTICAL_PADDING_PX = 12;

// `.nw-tpl-photo` vertical margin (4px top + 4px bottom).
const PHOTO_BLOCK_MARGIN_PX = 8;

/* ------------------------------------------------------------------------ */
/* Escaping                                                                  */
/* ------------------------------------------------------------------------ */
// Local by design: this module is the only place plain export data becomes
// markup, and the rich-text path never comes through here (it is rebuilt from
// the model by templateRichText.modelToHtml).

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return esc(value).replace(/"/g, "&quot;");
}

// camelCase React-style keys -> CSS declarations. Only ever applied to objects
// produced by brandingStyles(), whose every value is a validated hex colour or
// a number-derived string.
function styleAttr(styleObject) {
  const parts = [];
  for (const key of Object.keys(styleObject || {})) {
    const value = styleObject[key];
    if (value == null || value === "") continue;
    const prop = key.startsWith("--")
      ? key
      : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    parts.push(`${prop}: ${value}`);
  }
  return parts.join("; ");
}

/* ------------------------------------------------------------------------ */
/* Rich text                                                                 */
/* ------------------------------------------------------------------------ */

// The glyphs a task item's state degrades to where a checkbox control cannot
// travel (Word input), and the text a horizontal rule degrades to there.
export const DOCX_TASK_CHECKED_GLYPH = "\u2611"; // ☑
export const DOCX_TASK_UNCHECKED_GLYPH = "\u2610"; // ☐
export const DOCX_RULE_TEXT = "\u2500".repeat(32); // ────

/**
 * LOCKED FORMAT POLICY for the document vocabulary (2026-08-18), per flavour:
 *
 *   heading / blockquote / code / inline marks / tables / sub-sup / fonts
 *     standalone, PDF, DOCX  → the SAME semantic markup `modelToHtml` emits
 *                              (headings, <blockquote>, <pre><code>, <table>,
 *                              <sub>/<sup>, one validated style span);
 *                              html-to-docx carries every one of these.
 *   task list
 *     standalone, PDF        → the TaskItem NodeView's own shape with a
 *                              disabled native checkbox showing the state
 *                              (the Free-form exports carry the same control)
 *     DOCX                   → degrades DETERMINISTICALLY: each item becomes
 *                              its own blocks with a ☑ / ☐ glyph leading the
 *                              first line (html-to-docx has no checkbox)
 *   horizontal rule
 *     standalone, PDF        → <hr>
 *     DOCX                   → degrades DETERMINISTICALLY to a rule line of
 *                              box-drawing characters (html-to-docx drops <hr>)
 *
 * The semantic ORDER is identical in every flavour and nothing is dropped.
 */
function docxDegrade(block) {
  if (!block) return [];
  if (block.type === RICH_BLOCK.HORIZONTAL_RULE) {
    return [{ type: RICH_BLOCK.PARAGRAPH, align: "left", content: [{ type: "text", text: DOCX_RULE_TEXT, marks: {} }] }];
  }
  if (block.type === RICH_BLOCK.TASK_LIST) {
    const out = [];
    for (const item of block.items || []) {
      const glyph = { type: "text", text: `${item && item.checked ? DOCX_TASK_CHECKED_GLYPH : DOCX_TASK_UNCHECKED_GLYPH} `, marks: {} };
      const blocks = Array.isArray(item && item.blocks) && item.blocks.length ? item.blocks : [{ type: RICH_BLOCK.PARAGRAPH, align: "left", content: [] }];
      const [first, ...rest] = blocks;
      if (first && first.type === RICH_BLOCK.PARAGRAPH) {
        out.push({ ...first, content: [glyph, ...(first.content || [])] });
      } else {
        out.push({ type: RICH_BLOCK.PARAGRAPH, align: "left", content: [glyph] });
        out.push(first);
      }
      out.push(...rest);
    }
    return out;
  }
  return [block];
}

/**
 * One rich-text block as sanitized HTML.
 *
 * `modelToHtml` is the shared serializer and the only source of this markup.
 * A continuation ordered list carries `start` so its items are not renumbered
 * from 1 after a page break — applied to the `<ol>` this function itself just
 * produced, never to user input.
 */
function blockHtml(block, ctx) {
  const docx = !!ctx && ctx.flavor === EXPORT_FLAVOR.DOCX;
  const blocks = docx ? docxDegrade(block) : [block];
  const html = modelToHtml(blocks, { taskCheckbox: docx ? "none" : "input" });
  const start = Number(block && block.start);
  if (block && block.type === "orderedList" && Number.isFinite(start) && start > 1) {
    return html.replace(/^<ol>/, `<ol start="${Math.floor(start)}">`);
  }
  return html;
}

// Safe rel/target on links. The href already passed the project's URL policy;
// this adds the rel behaviour rather than carrying it in stored markup.
function hardenLinks(html) {
  return html.replace(/<a href=/g, '<a rel="noopener noreferrer nofollow" href=');
}

/* ------------------------------------------------------------------------ */
/* Units                                                                     */
/* ------------------------------------------------------------------------ */

function photoHtml(unit, ctx) {
  if (unit.unavailable || !unit.dataUrl) {
    // Explicit, never a silent omission.
    return `<p class="nw-tpl-missing">${esc(unit.unavailableText)}</p>`;
  }

  const layout = photoLayout(unit, {
    contentWidthPx: ctx.contentWidthPx,
    maxHeightPx: ctx.photoMaxHeightPx,
  });
  const align =
    unit.alignment === "center" || unit.alignment === "right"
      ? unit.alignment
      : "left";

  if (ctx.flavor === EXPORT_FLAVOR.DOCX) {
    // Word takes an explicit pixel width; the height is derived from the same
    // intrinsic ratio, so the image is scaled and never stretched.
    const height = layout.heightPx ? ` height="${layout.heightPx}"` : "";
    return `<p style="text-align: ${align}"><img src="${escAttr(
      unit.dataUrl
    )}" alt="${escAttr(unit.name)}" width="${layout.widthPx}"${height} /></p>`;
  }

  return (
    `<div class="nw-tpl-photo" style="text-align: ${align}">` +
    `<img src="${escAttr(unit.dataUrl)}" alt="${escAttr(unit.name)}" ` +
    `style="${photoSizingStyle(layout)} max-width: 100%;" />` +
    `</div>`
  );
}

// Only the width is CHOSEN; the height is derived from the stored intrinsic
// ratio (or left to the browser, capped by max-height + object-fit: contain).
// The image scales down to fit the page and can never be cropped.
function photoSizingStyle(layout) {
  return layout.heightPx
    ? `width: ${layout.widthPx}px; height: ${layout.heightPx}px;`
    : `width: ${layout.widthPx}px; height: auto;${
        layout.maxHeightPx ? ` max-height: ${layout.maxHeightPx}px;` : ""
      }`;
}

/**
 * ONE WRAPPED modern Section image with the text that flows beside it.
 *
 * LOCKED FORMAT POLICY (Phase F6b):
 *
 *   DOCX      degrades DETERMINISTICALLY to BLOCK: the same block photo markup
 *             every other photo gets (explicit pixel width, derived height),
 *             followed by the text — content, order and sizing preserved, the
 *             wrap visually lost on purpose. html-to-docx cannot carry a CSS
 *             float reliably, and no native floating-image support is built.
 *   HTML/PDF  the wrap is PRESERVED through the shared media core's own export
 *             derivation: the `<img>` carries the same `data-layout-*`
 *             attributes the shared serializer emits, `mediaWrapExportCss`
 *             (the ONE float rule every NoteWise export reads) floats it, and
 *             the `.nw-tpl-wrap` group is a `flow-root` formatting context, so
 *             the float can never escape its group into unrelated later
 *             content, a later row, or another page. Only the width is chosen
 *             (`widthPct` of the answer column, capped like every photo); the
 *             height follows the intrinsic ratio.
 *
 * A missing image follows the existing missing-photo policy (an explicit
 * placeholder, never a silent omission); the text still follows it.
 */
function wrapHtml(unit, ctx) {
  const photo = unit.photo || {};
  const blocks = (Array.isArray(unit.blocks) ? unit.blocks : [])
    .map((block) => unitHtml(block, ctx))
    .join("");

  if (ctx.flavor === EXPORT_FLAVOR.DOCX) {
    return photoHtml(photo, ctx) + blocks;
  }

  let image;
  if (photo.unavailable || !photo.dataUrl) {
    image = `<p class="nw-tpl-missing">${esc(photo.unavailableText)}</p>`;
  } else {
    const layout = photoLayout(photo, {
      contentWidthPx: ctx.contentWidthPx,
      maxHeightPx: ctx.photoMaxHeightPx,
    });
    const side =
      unit.side === MEDIA_LAYOUT_SIDE.RIGHT
        ? MEDIA_LAYOUT_SIDE.RIGHT
        : MEDIA_LAYOUT_SIDE.LEFT;
    image =
      `<img class="nw-tpl-wrapimg" ` +
      `${MEDIA_LAYOUT_MODE_ATTR}="${MEDIA_LAYOUT_MODE.WRAP}" ` +
      `${MEDIA_LAYOUT_SIDE_ATTR}="${side}" ` +
      `src="${escAttr(photo.dataUrl)}" alt="${escAttr(photo.name)}" ` +
      `style="${photoSizingStyle(layout)} max-width: 100%;" />`;
  }
  return `<div class="nw-tpl-wrap">${image}${blocks}</div>`;
}

function fileHtml(unit) {
  // Metadata only — the binary is in no export format, and this says so.
  return (
    `<div class="nw-tpl-file">` +
    `<strong>${esc(unit.name)}</strong>` +
    `<span> — ${esc(unit.meta ? `${unit.meta} — ` : "")}${esc(unit.note)}</span>` +
    `</div>`
  );
}

/**
 * The deliberate blank working space at the end of a flexible section.
 *
 * Real layout BELOW the section's content, never a constraint on it, so nothing
 * can be clipped or compressed — the same model the live document uses.
 *
 * WORD (docx) GETS NOTHING. html-to-docx has no equivalent for a fixed-height
 * empty box, and manufacturing a run of empty paragraphs to approximate one
 * would put content the user never typed into their document. Word reflows the
 * report anyway, so the honest conversion is to omit it.
 *
 * The height is CLAMPED to what one page's content area can actually hold. The
 * stored maximum (one usable page, SECTION_EXTRA_MAX_PX) is larger than the
 * PDF's per-page capacity once the footer is reserved, and an atomic unit taller
 * than a page is an unsplittable export failure — so the clamp is what keeps a
 * maximally-dragged section exportable rather than a hard error.
 */
function spaceHtml(unit, ctx) {
  if (ctx.flavor === EXPORT_FLAVOR.DOCX) return "";
  const border = Number(ctx.table?.borderWidthPx) || 0;
  const ceiling = Math.max(
    1,
    Math.round(ctx.rowMaxHeightPx - ROW_CELL_VERTICAL_PADDING_PX - border)
  );
  const px = Math.min(ceiling, Math.max(1, Math.round(Number(unit.heightPx) || 0)));
  if (!(px > 0)) return "";
  return `<div class="nw-tpl-space" style="height: ${px}px" aria-hidden="true"></div>`;
}

export function unitHtml(unit, ctx) {
  if (!unit) return "";
  switch (unit.type) {
    case EXPORT_UNIT.BLOCK:
      return hardenLinks(blockHtml(unit.block, ctx));
    case EXPORT_UNIT.VALUE:
      return `<p>${esc(unit.text)}</p>`;
    case EXPORT_UNIT.PHOTO:
      return photoHtml(unit, ctx);
    case EXPORT_UNIT.FILE:
      return fileHtml(unit);
    case EXPORT_UNIT.WRAP:
      return wrapHtml(unit, ctx);
    case EXPORT_UNIT.SPACE:
      return spaceHtml(unit, ctx);
    case EXPORT_UNIT.EMPTY:
    default:
      // The branded layout's intended empty state: an empty cell that still
      // occupies its row. Never "undefined", "null" or an internal identifier.
      return `<p class="nw-tpl-empty">&nbsp;</p>`;
  }
}

/* ------------------------------------------------------------------------ */
/* Rows                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * The inner height a row's minimum box must have for the ROW to end up as tall
 * as the template author made it.
 *
 * Returns 0 — no box at all — for every flavour except PDF (Word and the
 * standalone document flow their own way and their output must not change), and
 * for a continuation fragment, whose height is its content's alone.
 *
 * Exported so the pagination tests can assert that what the planner measures is
 * exactly what the exported markup carries.
 */
export function rowMinBoxHeightPx(fragment, ctx) {
  if (!ctx || ctx.flavor !== EXPORT_FLAVOR.PDF) return 0;
  if (!fragment || fragment.continued) return 0;
  // A flexible section's body is its ordered content, and its height is that
  // content plus whatever space the user deliberately added below it. The legacy
  // whole-row height is not a floor for such a row — applying it would reserve a
  // blank band above its first photo, which is exactly the defect the live
  // document removed. Only a row whose body IS section content is affected.
  if (fragment.contentDriven) return 0;
  const normalized = normalizeRowHeightPx(
    fragment.preferredHeightPx,
    ctx.rowMaxHeightPx
  );
  const border = Number(ctx.table?.borderWidthPx) || 0;
  // `border-collapse: collapse` shares each horizontal border between the two
  // rows that meet at it, so one border width is what a row actually adds.
  return Math.max(
    0,
    Math.round(normalized - ROW_CELL_VERTICAL_PADDING_PX - border)
  );
}

export function rowHtml(fragment, ctx) {
  const t = ctx.table;
  const labelStyle = styleAttr({
    backgroundColor: t.labelBackgroundColor,
    color: t.labelTextColor,
    border: `${t.borderWidthPx}px solid ${t.borderColor}`,
  });
  const cellStyle = styleAttr({
    backgroundColor: t.contentBackgroundColor,
    color: t.contentTextColor,
    border: `${t.borderWidthPx}px solid ${t.borderColor}`,
  });
  // THIS ROW'S CELLS on the table's grid. `fragment.cells` is the canonical list
  // from the export model and always holds at least one entry, whose units ARE
  // `fragment.units` — so an undivided row (every row of every template
  // published before the grid existed) emits exactly the one `<td>` it always
  // did, from exactly the same units. A PAGINATED fragment carries only the
  // units the planner put on this page, so it takes the row-level `units` for a
  // single cell spanning the whole value area rather than the whole row's cells.
  const columnCount = Math.max(1, ctx.columnWidths.length);
  const cells =
    Array.isArray(fragment.cells) && fragment.cells.length && !fragment.continued
      ? fragment.cells
      : [{ units: fragment.units || [], span: columnCount }];
  const labelClass = fragment.continued
    ? "nw-tpl-label nw-tpl-label--continued"
    : "nw-tpl-label";

  // A MINIMUM, never a fixed height: an ordinary block with `min-height` grows
  // when its own content is taller, and the answer cell can push the row taller
  // still. Nothing here can clip or vertically compress a cell. `min-height` on
  // a `<tr>` or `<td>` is not reliably honoured by table layout, which is why
  // the constraint sits on a plain block inside the label cell instead.
  const minBox = rowMinBoxHeightPx(fragment, ctx);
  const label = esc(fragment.label);
  const labelInner = minBox
    ? `<div class="nw-tpl-rowmin" style="min-height: ${minBox}px">${label}</div>`
    : label;

  const unitsFor = (cell) =>
    (cell.units || []).map((unit) => unitHtml(unit, ctx)).join("");

  // ONE `<td>` per cell, spanning the grid columns it covers — an ordinary HTML
  // `colspan`, which is exactly what this model is. A cell covering every column
  // emits no `colspan` attribute at all when the table has one column, so every
  // existing template's markup is byte-for-byte what it always was.
  //
  // Word understands `colspan` natively, so the DOCX conversion needs no second
  // representation, and `table-layout: fixed` over the `<colgroup>` above gives
  // the PDF the same calculated widths the live document uses.
  const valueCells = cells
    .map((cell) => {
      const span = Math.max(1, Math.floor(Number(cell.span) || 1));
      const colspan = span > 1 ? ` colspan="${span}"` : "";
      return `<td class="nw-tpl-cell" style="${cellStyle}"${colspan}>${unitsFor(cell)}</td>`;
    })
    .join("");

  return (
    `<tr class="nw-tpl-row">` +
    `<td class="${labelClass}" style="${labelStyle}">${labelInner}</td>` +
    valueCells +
    `</tr>`
  );
}

/* ------------------------------------------------------------------------ */
/* Branded header, title and document meta                                   */
/* ------------------------------------------------------------------------ */

// The composed header (Template Editor A1): the layout REGION — banner behind,
// the logo and the header text flowing in one direction on top. Editing
// affordances (the dashed boundary, the resize handle, selection outlines,
// placeholders) are Template Editor classes that are simply never emitted here.
function composedHeaderHtml(model, ctx, styles) {
  const branding = ctx.branding;
  const layout = branding.header.layout;
  const showLogo = !!(model.logo && layout.logo.visible);
  // The HEADER-RESTRICTED model — the same reader the on-screen header uses, so
  // a header can never export a structural block the header contract forbids.
  const textModel = headerTextModel(layout.text.value);
  const textHtml = headerTextModelIsEmpty(textModel) ? "" : modelToHtml(textModel);

  if (ctx.flavor === EXPORT_FLAVOR.DOCX) {
    // Word has no flexbox: a row becomes a two-cell table (logo cell sized to
    // the logo's share of the width), a column becomes stacked paragraphs.
    const logoPx = Math.max(1, Math.floor((USABLE_WIDTH_PX * layout.logo.widthPct) / 100));
    const logoCell = showLogo
      ? `<img src="${escAttr(model.logo.dataUrl)}" alt="" width="${logoPx}" />`
      : "";
    const textCell = textHtml ? `<div class="nw-tpl-headtext">${textHtml}</div>` : "";
    const first = layout.order === "text-first" ? textCell : logoCell;
    const second = layout.order === "text-first" ? logoCell : textCell;
    if (!first && !second) return "";
    if (layout.direction === "row" && showLogo && textHtml) {
      const logoW = Math.round(layout.logo.widthPct);
      const textW = 100 - logoW;
      const cells =
        layout.order === "text-first"
          ? `<td style="width: ${textW}%; vertical-align: middle;">${textCell}</td>` +
            `<td style="width: ${logoW}%; vertical-align: middle;">${logoCell}</td>`
          : `<td style="width: ${logoW}%; vertical-align: middle;">${logoCell}</td>` +
            `<td style="width: ${textW}%; vertical-align: middle;">${textCell}</td>`;
      return `<table class="nw-tpl-headrow" cellspacing="0" cellpadding="0" style="width: 100%;"><tbody><tr>${cells}</tr></tbody></table>`;
    }
    return (first ? `<p>${first}</p>` : "") + (second ? `<p>${second}</p>` : "");
  }

  const logoObj = showLogo
    ? `<div class="nw-tpl-obj nw-tpl-obj-logo" style="${styleAttr(styles.composed.logo)}">` +
      `<img class="nw-tpl-objlogo" alt="" src="${escAttr(model.logo.dataUrl)}" /></div>`
    : "";
  const textObj = textHtml ? `<div class="nw-tpl-obj nw-tpl-obj-text nw-tpl-headtext">${textHtml}</div>` : "";
  const objects = layout.order === "text-first" ? textObj + logoObj : logoObj + textObj;
  const dirClass = layout.direction === "column" ? "nw-tpl-objects--column" : "nw-tpl-objects--row";
  return (
    `<div class="nw-tpl-header nw-tpl-header--composed" style="${styleAttr(styles.composed.header)}">` +
    `<div class="nw-tpl-banner" style="${styleAttr(styles.banner)}"></div>` +
    `<div class="nw-tpl-objects ${dirClass}" style="${styleAttr(styles.composed.objects)}">${objects}</div>` +
    `</div>`
  );
}

function headerHtml(model, ctx) {
  const branding = ctx.branding;
  if (!branding.header.enabled) return "";
  const styles = brandingStyles(branding);

  if (branding.header.layout) return composedHeaderHtml(model, ctx, styles);

  if (ctx.flavor === EXPORT_FLAVOR.DOCX) {
    // Word has no absolute positioning worth relying on: the logo is rendered
    // as an ordinary image at its configured relative width.
    if (!model.logo || !layoutShowsLogo(branding.header.layoutStyle)) return "";
    const width = Math.max(
      1,
      Math.floor((ctx.contentWidthPx * branding.header.logo.widthPct) / 100)
    );
    return `<p><img src="${escAttr(model.logo.dataUrl)}" alt="" width="${width}" /></p>`;
  }

  const logo =
    model.logo && styles.logoBox && layoutShowsLogo(branding.header.layoutStyle)
      ? `<div class="nw-tpl-logobox" style="${styleAttr(styles.logoBox)}">` +
        `<img class="nw-tpl-logo" alt="" src="${escAttr(model.logo.dataUrl)}" ` +
        `style="${styleAttr(styles.logo)}" /></div>`
      : "";

  return (
    `<div class="nw-tpl-header" style="${styleAttr(styles.header)}">` +
    `<div class="nw-tpl-banner" style="${styleAttr(styles.banner)}"></div>` +
    logo +
    `</div>`
  );
}

function titleHtml(model, ctx) {
  const title = ctx.branding.title;
  // A composed header carries its text inside the region; the separate legacy
  // title block belongs only to a version without a layout.
  if (ctx.branding.header.layout) return "";
  if (!title.enabled) return "";
  const text = (title.text || "").trim();
  // A completed report never prints an empty title band.
  if (!text) return "";
  const styles = brandingStyles(ctx.branding);
  return `<h1 class="nw-tpl-title" style="${styleAttr(styles.title)}">${esc(text)}</h1>`;
}

function metaHtml(model) {
  // Document provenance, in restrained text. No internal ids.
  return (
    `<p class="nw-tpl-meta">${esc(model.note.title)} · ${esc(model.template.name)}</p>`
  );
}

function fallbackNoticeHtml(model) {
  const list = model.placementFallbacks || [];
  if (!list.length) return "";
  const text =
    list.length === 1
      ? `The section "${list[0].label || "Untitled"}" no longer has its original position in this template and is shown at the end of the document.`
      : `${list.length} sections no longer have their original position in this template and are shown at the end of the document.`;
  return `<p class="nw-tpl-notice">${esc(text)}</p>`;
}

/* ------------------------------------------------------------------------ */
/* Pages                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * @param options.rowMaxHeightPx the tallest a row's MINIMUM may be — the PDF
 *   planner passes the page capacity it paginates against (usable page height
 *   less the reserved footer) so a stored row height can never exceed the space
 *   a page actually has. Defaults to the whole page box.
 */
export function makeRenderContext(model, flavor, options = {}) {
  const branding = normalizeBranding(model.branding);
  const leftPct = model.layout?.leftPct ?? 18;
  // The table's VALUE-COLUMN GRID, as percentages of the WHOLE table — one
  // `<col>` each, so the exported table has real vertical columns and a cell
  // simply spans the ones it covers. A model without a grid (or one column) is
  // the single full-width value column every template has always had.
  const gridColumns = Array.isArray(model.layout?.valueColumns)
    ? model.layout.valueColumns
    : [];
  const valueShare = 100 - leftPct;
  const columnWidths =
    gridColumns.length > 1
      ? gridColumns.map((c) => ((Number(c.widthPct) || 0) * valueShare) / 100)
      : [valueShare];
  const isPdf = flavor === EXPORT_FLAVOR.PDF;
  const rowMaxHeightPx =
    Number(options.rowMaxHeightPx) > 0
      ? Number(options.rowMaxHeightPx)
      : PDF_PAGE_CONTENT_HEIGHT_PX;
  const border = Number(branding.table?.borderWidthPx) || 0;
  return {
    flavor,
    branding,
    table: branding.table,
    leftPct,
    columnWidths,
    rowMaxHeightPx,
    // The answer area's real width, used to size photos. A divided table sizes
    // them against its WIDEST value column, which is the widest a photo can
    // actually be laid out in.
    contentWidthPx: Math.max(
      1,
      Math.round((USABLE_WIDTH_PX * Math.max(...columnWidths)) / 100) - 24
    ),
    // For the PDF this is derived from the SAME capacity the planner uses, less
    // the row and photo chrome the image sits inside, so a full-page photo is
    // scaled down to fit rather than overflowing its row into the footer. Other
    // flavours keep the long-standing bound; their output is unchanged.
    photoMaxHeightPx: isPdf
      ? Math.max(
          1,
          rowMaxHeightPx -
            ROW_CELL_VERTICAL_PADDING_PX -
            border -
            PHOTO_BLOCK_MARGIN_PX
        )
      : EXPORT_PHOTO_MAX_HEIGHT_PX,
  };
}

/**
 * One page's footer. Exported so the PDF runner can MEASURE it and reserve its
 * height before placing any row — the page number is part of the page box, not
 * something appended to whatever space happens to be left.
 */
export function buildPageFooterHtml(pageNumber, pageCount) {
  return `<div class="nw-tpl-pagenum">Page ${Math.floor(
    Number(pageNumber) || 1
  )} of ${Math.floor(Number(pageCount) || 1)}</div>`;
}

/**
 * The page-1 lead-in (branded header, report title, provenance line, and any
 * placement notice). Exported so the PDF runner can MEASURE it — it consumes
 * real page height and participates in pagination like any row.
 */
export function buildDocumentHeadHtml(model, ctx) {
  return (
    headerHtml(model, ctx) +
    titleHtml(model, ctx) +
    metaHtml(model) +
    fallbackNoticeHtml(model)
  );
}

export function buildRowsTableHtml(fragments, ctx) {
  return tableHtml(fragments, ctx);
}

/** A self-contained chunk the PDF runner can mount offscreen and measure. */
export function buildMeasurableHtml(inner) {
  return `<div class="nw-tpl-doc"><section class="nw-tpl-page">${inner}</section></div>`;
}

function tableHtml(fragments, ctx) {
  const rows = fragments.map((f) => rowHtml(f, ctx)).join("");
  // ONE `<col>` per real table column: the label column, then the value grid.
  // A one-column table emits exactly the `<colgroup>` this exporter has always
  // emitted, so every existing template's markup is unchanged.
  const cols =
    ctx.columnWidths.length > 1
      ? ctx.columnWidths
          .map((w) => `<col style="width: ${roundWidth(w)}%" />`)
          .join("")
      : "<col />";
  return (
    `<table class="nw-tpl-table" cellspacing="0" cellpadding="0">` +
    `<colgroup><col style="width: ${ctx.leftPct}%" />${cols}</colgroup>` +
    `<tbody>${rows}</tbody></table>`
  );
}

// Column widths are emitted at two decimal places so a normalized percentage
// never reaches the markup as a 17-digit float.
function roundWidth(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * The document body.
 *
 * `pages` is an array of pages, each an array of row fragments. Every flavour
 * except PDF passes a single page; the PDF runner passes the distribution it
 * computed from the shared A4 geometry and inserts explicit page breaks.
 *
 * The branded header, the title and the provenance line are simply FIRST in
 * document order, so they appear on page 1 and are never repeated.
 */
export function buildTemplateExportBody(
  model,
  { flavor, pages, rowMaxHeightPx } = {}
) {
  const ctx = makeRenderContext(model, flavor || EXPORT_FLAVOR.STANDALONE, {
    rowMaxHeightPx,
  });
  const pageList =
    Array.isArray(pages) && pages.length
      ? pages
      : [(model.rows || []).map((row) => ({ ...row, continued: false }))];

  const sections = pageList.map((fragments, index) => {
    const first = index === 0;
    const head = first
      ? headerHtml(model, ctx) +
        titleHtml(model, ctx) +
        metaHtml(model) +
        fallbackNoticeHtml(model)
      : "";
    // Numbering comes from the PAGE PLAN, never from anything html2pdf reports
    // after rasterising: one planned page is one wrapper is one PDF page.
    const footer =
      ctx.flavor === EXPORT_FLAVOR.PDF
        ? buildPageFooterHtml(index + 1, pageList.length)
        : "";
    return `<section class="nw-tpl-page">${head}${tableHtml(fragments, ctx)}${footer}</section>`;
  });

  const separator =
    ctx.flavor === EXPORT_FLAVOR.PDF
      ? '<div class="html2pdf__page-break"></div>'
      : '<div class="nw-tpl-pagebreak"></div>';

  return `<div class="nw-tpl-doc">${sections.join(separator)}</div>`;
}

/* ------------------------------------------------------------------------ */
/* Stylesheet                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The class-scoped rules.
 *
 * Every selector begins with `.nw-tpl-`, so this can be injected into the live
 * application document (the PDF measurement probe does exactly that) without
 * being able to restyle anything the application itself renders. Typography
 * lives on `.nw-tpl-doc` rather than on `body` for the same reason — and so a
 * measurement taken in the probe matches the exported document exactly.
 *
 * Two rules carry more weight than they look:
 *   - `.nw-tpl-page` is `170mm` — the exact declaration html2pdf gives its own
 *     container. A page wider than that (it used to be a rounded-up 643px)
 *     overflows the capture and the table's right border is cut mid-stroke.
 *   - `.nw-tpl-pagenum` reserves its gap with PADDING, not a top margin. The
 *     runner measures this element to reserve the footer before placing rows,
 *     and a top margin collapses out of that measurement — so it would go
 *     unreserved and the page number would sit on the very bottom edge of the
 *     capture, sliced in half. It is deliberately not a margin.
 *
 * Kept comment-free: the rules are parsed selector-by-selector by a test that
 * proves every one of them is `.nw-tpl-` scoped.
 */
export function templateExportComponentCss(flavor) {
  const pdf = flavor === EXPORT_FLAVOR.PDF;
  const docx = flavor === EXPORT_FLAVOR.DOCX;
  // The wrapped-image rules of the SHARED media core, scoped to the wrap group.
  // The DOCX flavour deliberately carries NO float rule at all (its markup never
  // emits a wrapped image — see `wrapHtml`), exactly as the Free-form DOCX
  // export builds its input without them, so Word input degrades to block
  // placement deterministically.
  const wrapCss =
    "\n    .nw-tpl-wrap { display: flow-root; }\n" +
    "    .nw-tpl-wrap img { object-fit: contain; }" +
    mediaWrapExportCss(".nw-tpl-wrap");
  return `
    .nw-tpl-doc {
      width: 100%; margin: 0 auto;
      background: #ffffff; color: #111111;
      font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.45;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .nw-tpl-doc *, .nw-tpl-doc *::before, .nw-tpl-doc *::after { box-sizing: border-box; }
    ${
      pdf
        ? `.nw-tpl-page { width: ${USABLE_WIDTH_MM}mm; }`
        : // ONE content width for every surface. This used to be an arbitrary
          // 820px (~217mm) — wider than the A4 content column the app document,
          // the PDF and the print stylesheet all use — so the standalone HTML
          // document and the Document Preview rendered the same table wider than
          // the note it was previewing. It is now the SAME shared usable width
          // the page geometry defines, so Builder, note, Preview and every
          // export agree. `max-width` rather than `width`, so a narrow window
          // still narrows the document instead of scrolling it sideways.
          `.nw-tpl-page { max-width: ${USABLE_WIDTH_MM}mm; margin: 0 auto; }`
    }
    .nw-tpl-pagebreak { page-break-before: always; break-before: page; height: 0; }
    .nw-tpl-header { position: relative; width: 100%; overflow: hidden; margin-bottom: 6mm; }
    .nw-tpl-banner { position: absolute; }
    .nw-tpl-logobox { position: absolute; }
    .nw-tpl-logo { position: absolute; height: auto; display: block; }
    .nw-tpl-header--composed { display: flex; flex-direction: column; height: auto; }
    .nw-tpl-objects { position: relative; z-index: 1; display: flex; flex: 1 1 auto; width: 100%; min-width: 0; gap: 4mm; }
    .nw-tpl-objects--column { align-items: stretch; }
    .nw-tpl-obj { min-width: 0; }
    .nw-tpl-obj-logo { flex: 0 0 auto; line-height: 0; }
    .nw-tpl-objlogo { display: block; width: 100%; height: auto; }
    .nw-tpl-obj-text { flex: 1 1 0; align-self: center; min-width: 0; overflow-wrap: anywhere; }
    .nw-tpl-objects--column .nw-tpl-obj-text { flex: 0 0 auto; width: 100%; align-self: stretch; }
    .nw-tpl-headtext { font-size: 16pt; line-height: 1.25; color: #111111; }
    .nw-tpl-headtext p { margin: 0; }
    .nw-tpl-headtext ul, .nw-tpl-headtext ol { margin: 0 0 4px 18px; padding: 0; }
    .nw-tpl-headtext h1, .nw-tpl-headtext h2, .nw-tpl-headtext h3, .nw-tpl-headtext h4, .nw-tpl-headtext h5, .nw-tpl-headtext h6 { margin: 0; line-height: 1.25; }
    .nw-tpl-headtext table { border-collapse: collapse; width: 100%; }
    .nw-tpl-headtext td, .nw-tpl-headtext th { border: 1px solid #999999; padding: 2px 6px; vertical-align: top; }
    .nw-tpl-headrow td { padding: 0; }
    .nw-tpl-title { margin: 0 0 4mm 0; padding: 0; }
    .nw-tpl-meta { margin: 0 0 3mm 0; font-size: 9pt; color: #555555; }
    .nw-tpl-notice { margin: 0 0 3mm 0; font-size: 9pt; color: #555555; }
    .nw-tpl-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .nw-tpl-row { page-break-inside: avoid; break-inside: avoid; }
    .nw-tpl-label, .nw-tpl-cell {
      padding: 6px 10px; vertical-align: top;
      overflow-wrap: anywhere; word-break: break-word;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .nw-tpl-label { font-weight: 600; }
    .nw-tpl-rowmin { display: block; }
    .nw-tpl-label--continued { font-weight: 500; font-style: italic; opacity: 0.75; }
    .nw-tpl-cell p { margin: 0 0 6px 0; }
    .nw-tpl-cell p:last-child { margin-bottom: 0; }
    .nw-tpl-cell ul, .nw-tpl-cell ol { margin: 0 0 6px 18px; padding: 0; }
    .nw-tpl-cell a { color: inherit; text-decoration: underline; }
    .nw-tpl-cell h1, .nw-tpl-cell h2, .nw-tpl-cell h3, .nw-tpl-cell h4, .nw-tpl-cell h5, .nw-tpl-cell h6 {
      margin: 0 0 4px 0; line-height: 1.25; font-weight: 700; page-break-after: avoid; break-after: avoid;
    }
    .nw-tpl-cell h1 { font-size: 1.5em; }
    .nw-tpl-cell h2 { font-size: 1.3em; }
    .nw-tpl-cell h3 { font-size: 1.15em; font-weight: 600; }
    .nw-tpl-cell h4, .nw-tpl-cell h5, .nw-tpl-cell h6 { font-size: 1.05em; font-weight: 600; }
    .nw-tpl-cell blockquote { margin: 0 0 6px 0; padding: 2px 0 2px 10px; border-left: 3px solid #999999; color: #444444; }
    .nw-tpl-cell pre {
      margin: 0 0 6px 0; padding: 6px 8px; background: #f5f5f5; border-radius: 3px;
      white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    }
    .nw-tpl-cell pre, .nw-tpl-cell code {
      font-family: ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace; font-size: 0.9em;
    }
    .nw-tpl-cell code { background: #f5f5f5; padding: 0 3px; border-radius: 2px; }
    .nw-tpl-cell pre code { background: none; padding: 0; }
    .nw-tpl-cell hr { border: 0; border-top: 1px solid #cccccc; margin: 4px 0 6px 0; }
    .nw-tpl-cell sub, .nw-tpl-cell sup { line-height: 0; }
    .nw-tpl-cell table { width: 100%; margin: 0 0 6px 0; border-collapse: collapse; table-layout: fixed; }
    .nw-tpl-cell td, .nw-tpl-cell th { border: 1px solid #cccccc; padding: 4px 6px; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
    .nw-tpl-cell th { background: #f2f2f2; font-weight: 700; text-align: left; }
    .nw-tpl-cell td p:last-child, .nw-tpl-cell th p:last-child { margin-bottom: 0; }
    .nw-tpl-cell ul[data-type="taskList"] { list-style: none; margin-left: 4px; }
    .nw-tpl-cell li[data-type="taskItem"] { display: flex; gap: 6px; align-items: flex-start; }
    .nw-tpl-cell li[data-type="taskItem"] > label { flex: 0 0 auto; }
    .nw-tpl-cell li[data-type="taskItem"] > div { flex: 1 1 auto; min-width: 0; }
    .nw-tpl-empty { min-height: 1em; }
    .nw-tpl-space { width: 100%; }
    .nw-tpl-missing { font-style: italic; color: #555555; }
    .nw-tpl-photo { margin: 4px 0; }
    .nw-tpl-photo img { object-fit: contain; height: auto; }${docx ? "" : wrapCss}
    .nw-tpl-file {
      border: 1px solid #cccccc; border-radius: 4px; padding: 6px 8px; margin: 4px 0;
      font-size: 10pt; page-break-inside: avoid; break-inside: avoid;
    }
    .nw-tpl-file span { color: #555555; }
    .nw-tpl-pagenum { padding-top: 4mm; font-size: 8pt; color: #777777; text-align: right; }
  `;
}

/** The full stylesheet for a standalone document (page box + component rules). */
export function templateExportCss(flavor) {
  return `
    @page { size: A4; margin: 20mm; }
    html, body { margin: 0; padding: 0; background: #ffffff; }
    ${templateExportComponentCss(flavor)}
  `;
}

/**
 * A COMPLETE, self-contained document.
 *
 * No script, no event handler, no external stylesheet, font or image: every
 * asset is already an inline data URL, so the file displays correctly when it
 * is opened on its own with no network available.
 */
export function buildTemplateExportDocument(model, { flavor, pages } = {}) {
  const kind = flavor || EXPORT_FLAVOR.STANDALONE;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<title>${esc(model.note.title)}</title>` +
    `<style>${templateExportCss(kind)}</style></head>` +
    `<body>${buildTemplateExportBody(model, { flavor: kind, pages })}</body></html>`
  );
}
