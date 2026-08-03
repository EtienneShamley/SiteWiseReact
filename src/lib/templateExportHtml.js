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
//     model, so only p/br/strong/em/u/s/ul/ol/li/span/mark/a can appear, colours
//     are already validated to #rrggbb, alignment is one of four keywords, and
//     hrefs have already passed the project's URL policy.
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
import { modelToHtml } from "./templateRichText";
import { EXPORT_UNIT } from "./templateExportModel";
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

/**
 * One rich-text block as sanitized HTML.
 *
 * `modelToHtml` is the shared serializer and the only source of this markup.
 * A continuation ordered list carries `start` so its items are not renumbered
 * from 1 after a page break — applied to the `<ol>` this function itself just
 * produced, never to user input.
 */
function blockHtml(block) {
  const html = modelToHtml([block]);
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

  // Only the width is CHOSEN; the height is derived from the stored intrinsic
  // ratio (or left to the browser, capped by max-height + object-fit: contain).
  // The image scales down to fit the page and can never be cropped.
  const sizing = layout.heightPx
    ? `width: ${layout.widthPx}px; height: ${layout.heightPx}px;`
    : `width: ${layout.widthPx}px; height: auto;${
        layout.maxHeightPx ? ` max-height: ${layout.maxHeightPx}px;` : ""
      }`;
  return (
    `<div class="nw-tpl-photo" style="text-align: ${align}">` +
    `<img src="${escAttr(unit.dataUrl)}" alt="${escAttr(unit.name)}" ` +
    `style="${sizing} max-width: 100%;" />` +
    `</div>`
  );
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

export function unitHtml(unit, ctx) {
  if (!unit) return "";
  switch (unit.type) {
    case EXPORT_UNIT.BLOCK:
      return hardenLinks(blockHtml(unit.block));
    case EXPORT_UNIT.VALUE:
      return `<p>${esc(unit.text)}</p>`;
    case EXPORT_UNIT.PHOTO:
      return photoHtml(unit, ctx);
    case EXPORT_UNIT.FILE:
      return fileHtml(unit);
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
  const units = (fragment.units || [])
    .map((unit) => unitHtml(unit, ctx))
    .join("");
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

  return (
    `<tr class="nw-tpl-row">` +
    `<td class="${labelClass}" style="${labelStyle}">${labelInner}</td>` +
    `<td class="nw-tpl-cell" style="${cellStyle}">${units}</td>` +
    `</tr>`
  );
}

/* ------------------------------------------------------------------------ */
/* Branded header, title and document meta                                   */
/* ------------------------------------------------------------------------ */

function headerHtml(model, ctx) {
  const branding = ctx.branding;
  if (!branding.header.enabled) return "";
  const styles = brandingStyles(branding);

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
    rowMaxHeightPx,
    // The answer column's real width, used to size photos.
    contentWidthPx: Math.max(
      1,
      Math.round((USABLE_WIDTH_PX * (100 - leftPct)) / 100) - 24
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
  return (
    `<table class="nw-tpl-table" cellspacing="0" cellpadding="0">` +
    `<colgroup><col style="width: ${ctx.leftPct}%" /><col /></colgroup>` +
    `<tbody>${rows}</tbody></table>`
  );
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
  return `
    .nw-tpl-doc {
      width: 100%; margin: 0 auto;
      background: #ffffff; color: #111111;
      font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.45;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .nw-tpl-doc *, .nw-tpl-doc *::before, .nw-tpl-doc *::after { box-sizing: border-box; }
    ${pdf ? `.nw-tpl-page { width: ${USABLE_WIDTH_MM}mm; }` : ".nw-tpl-page { max-width: 820px; margin: 0 auto; }"}
    .nw-tpl-pagebreak { page-break-before: always; break-before: page; height: 0; }
    .nw-tpl-header { position: relative; width: 100%; overflow: hidden; margin-bottom: 6mm; }
    .nw-tpl-banner { position: absolute; }
    .nw-tpl-logobox { position: absolute; }
    .nw-tpl-logo { position: absolute; height: auto; display: block; }
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
    .nw-tpl-empty { min-height: 1em; }
    .nw-tpl-missing { font-style: italic; color: #555555; }
    .nw-tpl-photo { margin: 4px 0; }
    .nw-tpl-photo img { object-fit: contain; height: auto; }
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
