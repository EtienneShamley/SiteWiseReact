// src/lib/freeformExportPdfHtml.js
//
// The Free-form PDF's markup and its stylesheet.
//
// SCOPING IS A CORRECTNESS REQUIREMENT, NOT HOUSEKEEPING.
// html2pdf clones the container it is given into an overlay attached to
// document.body, so any rule the container carries applies to the RUNNING
// APPLICATION for the duration of the capture. The previous Free-form export
// shipped `body`, `*`, `img`, `table`, `td`, `pre`, `code`, `blockquote` and
// `h1,h2,h3` rules plus an `@page` block, all unscoped, and restyled the app
// every time someone exported. Every selector below therefore begins with
// `.nw-ff-doc`, and a unit test parses this stylesheet selector by selector to
// prove it.
//
// NO VERTICAL MARGINS ANYWHERE. Spacing is expressed as padding on the block
// wrapper. This is deliberate: a child's top/bottom margin collapses out of its
// parent's measured height, so a planner that measures a block in isolation and
// a page that renders it among siblings would disagree — which is precisely how
// content ends up straddling a page boundary. With every margin at zero the
// measured height and the rendered height are the same number by construction.
//
// Two other rules carry more weight than they look:
//   - `.nw-ff-page` is `170mm`, the exact declaration html2pdf gives its own
//     container, so the capture cannot overflow it and shave the right edge.
//   - `.nw-ff-pagenum` reserves its gap with PADDING, never a top margin: the
//     runner MEASURES this element to reserve the footer before placing any
//     block, and a top margin would collapse out of that measurement and leave
//     the page number sitting on the sliced bottom edge of the capture.

import { USABLE_WIDTH_MM } from "./templateExportCapture";
import {
  FILE_CARD_CLASS,
  FREEFORM_WRAP_GROUP_CLASS,
  IMAGE_PLACEHOLDER_CLASS,
  createInertDocument,
} from "./freeformExportBlocks";
import {
  MEDIA_WIDTH_PCT_ATTR,
  mediaWrapExportCss,
  normalizeMediaWidthPct,
} from "./editorMediaLayout";

export const FREEFORM_DOC_CLASS = "nw-ff-doc";
export const FREEFORM_PAGE_CLASS = "nw-ff-page";
export const FREEFORM_BLOCK_CLASS = "nw-ff-block";
export const FREEFORM_PAGENUM_CLASS = "nw-ff-pagenum";

// The gap below one block, in CSS px. Applied as padding on the wrapper, so it
// is part of the block's measured height and cannot collapse away.
export const BLOCK_GAP_PX = 8;

/* ------------------------------------------------------------------------ */
/* Preparation: link hardening and deterministic image sizing                */
/* ------------------------------------------------------------------------ */

/**
 * One image's exported box.
 *
 * Only the WIDTH is ever chosen; the height is derived from the same intrinsic
 * ratio, so there is no code path that can stretch or crop the image. An image
 * is scaled DOWN to fit the usable width and one usable page height, and is
 * never scaled UP beyond the size the note itself asked for.
 */
export function imageLayout(
  { intrinsicWidth, intrinsicHeight, requestedWidth },
  { contentWidthPx, maxHeightPx }
) {
  const maxWidth = Number(contentWidthPx) > 0 ? Number(contentWidthPx) : 0;
  const maxHeight = Number(maxHeightPx) > 0 ? Number(maxHeightPx) : 0;
  const iw = Number(intrinsicWidth);
  const ih = Number(intrinsicHeight);
  const ratioKnown = iw > 0 && ih > 0;

  // The intended rendered size: what the note stored, else the image's own
  // natural size. Never larger than either.
  const intended = Number(requestedWidth) > 0 ? Number(requestedWidth) : iw;
  let width = intended > 0 ? intended : maxWidth;
  if (maxWidth > 0) width = Math.min(width, maxWidth);

  if (ratioKnown && maxHeight > 0) {
    const widthAtMaxHeight = maxHeight * (iw / ih);
    if (width > widthAtMaxHeight) width = widthAtMaxHeight;
  }

  const finalWidth = Math.max(1, Math.floor(width));
  return {
    widthPx: finalWidth,
    heightPx: ratioKnown ? Math.max(1, Math.round(finalWidth * (ih / iw))) : null,
    maxHeightPx: maxHeight || null,
    ratioKnown,
  };
}

/**
 * Everything that must be settled on the export HTML BEFORE a block is measured.
 *
 * 1. Links are hardened. The href itself already passed the project's URL policy
 *    when it was created (src/lib/editorUrlSafety.js); this adds the rel
 *    behaviour rather than carrying it in stored markup, and strips any target.
 * 2. Every image is given an explicit box derived from its decoded intrinsic
 *    size, so its height no longer depends on when the browser finishes
 *    decoding — which is what made the old capture measure an image as almost
 *    nothing and then overflow the space it had been given.
 *
 * Runs on a DETACHED copy. The editor, the stored note HTML and the stored
 * assets are untouched.
 */
export function prepareFreeformPdfHtml(html, options = {}) {
  const { sizes, contentWidthPx, maxHeightPx, createDocument } = options;
  if (typeof html !== "string" || !html) return "";

  const doc = (createDocument || createInertDocument)();
  const container = doc.createElement("div");
  container.innerHTML = html;

  for (const anchor of Array.from(container.querySelectorAll("a"))) {
    anchor.removeAttribute("target");
    if (anchor.hasAttribute("href")) {
      anchor.setAttribute("rel", "noopener noreferrer nofollow");
    }
  }

  for (const img of Array.from(container.querySelectorAll("img"))) {
    const src = img.getAttribute("src") || "";
    const decoded = (sizes && sizes.get && sizes.get(src)) || null;
    const attrWidth = Number(img.getAttribute("width"));
    const attrHeight = Number(img.getAttribute("height"));

    // A user-chosen width (shared media core, `data-width-pct`) is a fraction
    // of the content column — the same meaning it has on screen — and takes
    // precedence over the intrinsic width hint. It is read through the shared
    // normalizer, so this path and the editor can never disagree about what a
    // stored value means. Absent, the pre-existing rule stands unchanged.
    const widthPct = normalizeMediaWidthPct(img.getAttribute(MEDIA_WIDTH_PCT_ATTR));
    const requestedWidth =
      widthPct !== null && Number(contentWidthPx) > 0
        ? (widthPct / 100) * Number(contentWidthPx)
        : attrWidth;

    const layout = imageLayout(
      {
        intrinsicWidth: decoded ? decoded.width : attrWidth,
        intrinsicHeight: decoded ? decoded.height : attrHeight,
        requestedWidth,
      },
      { contentWidthPx, maxHeightPx }
    );

    // The width/height attributes are replaced by the computed box so the
    // rendered size is stated once, in one place.
    img.removeAttribute("width");
    img.removeAttribute("height");
    const sizing = layout.heightPx
      ? `width: ${layout.widthPx}px; height: ${layout.heightPx}px;`
      : `width: auto; height: auto;${
          layout.maxHeightPx ? ` max-height: ${layout.maxHeightPx}px;` : ""
        }`;
    img.setAttribute("style", `${sizing} max-width: 100%;`);
  }

  return container.innerHTML;
}

/** Every distinct image source in the export HTML, in first-seen order. */
export function collectImageSources(html, deps = {}) {
  if (typeof html !== "string" || !html || !/<img/i.test(html)) return [];
  const doc = (deps.createDocument || createInertDocument)();
  const container = doc.createElement("div");
  container.innerHTML = html;
  const out = [];
  for (const img of Array.from(container.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src && !out.includes(src)) out.push(src);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Markup                                                                    */
/* ------------------------------------------------------------------------ */

/** One block inside its spacing wrapper — the unit that is both measured and rendered. */
export function blockWrapperHtml(blockHtml) {
  return `<div class="${FREEFORM_BLOCK_CLASS}">${blockHtml || ""}</div>`;
}

/**
 * One page's footer. Exported so the runner can MEASURE it and reserve its
 * height before placing any block — the page number is part of the page box,
 * not something appended to whatever space happens to be left over.
 */
export function buildFreeformPageFooterHtml(pageNumber, pageCount) {
  return `<div class="${FREEFORM_PAGENUM_CLASS}">Page ${Math.floor(
    Number(pageNumber) || 1
  )} of ${Math.floor(Number(pageCount) || 1)}</div>`;
}

/** A self-contained chunk the runner can mount offscreen and measure. */
export function buildFreeformMeasurableHtml(inner) {
  return `<div class="${FREEFORM_DOC_CLASS}"><section class="${FREEFORM_PAGE_CLASS}">${
    inner || ""
  }</section></div>`;
}

/**
 * The paginated document body: one `<section>` per PLANNED page.
 *
 * The page-break element sits BETWEEN sections and never after the last one, so
 * html2pdf's pagebreak plugin pads each page out to a whole page box and no
 * trailing blank page is created. Numbering comes from the page plan, never
 * from anything the rasteriser reports afterwards: one planned page is one
 * wrapper is one PDF page.
 */
export function buildFreeformPdfBody(pages) {
  const list = Array.isArray(pages) && pages.length ? pages : [[]];
  const sections = list.map((blocks, index) => {
    const body = (blocks || []).map((b) => blockWrapperHtml(b.html)).join("");
    const footer = buildFreeformPageFooterHtml(index + 1, list.length);
    return `<section class="${FREEFORM_PAGE_CLASS}">${body}${footer}</section>`;
  });
  return `<div class="${FREEFORM_DOC_CLASS}">${sections.join(
    '<div class="html2pdf__page-break"></div>'
  )}</div>`;
}

/* ------------------------------------------------------------------------ */
/* Stylesheet                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The class-scoped rules.
 *
 * Every selector begins with `.nw-ff-doc`, so this can be injected into the
 * live application document (the measurement probe and html2pdf's own overlay
 * both do exactly that) without being able to restyle anything the application
 * renders. Typography lives on `.nw-ff-doc` rather than on `body` for the same
 * reason — and so a measurement taken in the probe matches the exported
 * document exactly.
 *
 * Kept comment-free: the rules are parsed selector-by-selector by a test that
 * proves every one of them is `.nw-ff-doc` scoped.
 */
export function freeformPdfCss() {
  return `
    .nw-ff-doc {
      background: #ffffff; color: #111111;
      font-family: Arial, Helvetica, sans-serif; font-size: 12pt; line-height: 1.5;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .nw-ff-doc *, .nw-ff-doc *::before, .nw-ff-doc *::after { box-sizing: border-box; }
    .nw-ff-doc * { margin: 0; }
    .nw-ff-page { width: ${USABLE_WIDTH_MM}mm; }
    .nw-ff-block { padding-bottom: ${BLOCK_GAP_PX}px; }
    .nw-ff-doc p, .nw-ff-doc li, .nw-ff-doc td, .nw-ff-doc th {
      overflow-wrap: anywhere; word-break: break-word;
    }
    .nw-ff-doc p:empty { min-height: 1.5em; }
    .nw-ff-doc h1 { font-size: 1.8em; font-weight: 700; padding-bottom: 4px; }
    .nw-ff-doc h2 { font-size: 1.5em; font-weight: 700; padding-bottom: 4px; }
    .nw-ff-doc h3 { font-size: 1.25em; font-weight: 700; padding-bottom: 3px; }
    .nw-ff-doc h4, .nw-ff-doc h5, .nw-ff-doc h6 { font-size: 1.1em; font-weight: 700; padding-bottom: 3px; }
    .nw-ff-doc img { display: inline-block; object-fit: contain; }
    .nw-ff-doc .${FREEFORM_WRAP_GROUP_CLASS} { display: flow-root; }
    ${mediaWrapExportCss(".nw-ff-doc")}
    .nw-ff-doc ul, .nw-ff-doc ol { padding-left: 24px; }
    .nw-ff-doc li + li { padding-top: 4px; }
    .nw-ff-doc li > p + p { padding-top: 6px; }
    .nw-ff-doc ul[data-type="taskList"] { list-style: none; padding-left: 4px; }
    .nw-ff-doc ul[data-type="taskList"] li { display: flex; gap: 6px; align-items: flex-start; }
    .nw-ff-doc ul[data-type="taskList"] li > label { flex: 0 0 auto; }
    .nw-ff-doc blockquote {
      border-left: 3px solid #999999; padding: 2px 0 2px 12px; color: #444444;
    }
    .nw-ff-doc blockquote > * + * { padding-top: 6px; }
    .nw-ff-doc pre {
      background: #f5f5f5; padding: 8px; border-radius: 3px;
      white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    }
    .nw-ff-doc pre, .nw-ff-doc code {
      font-family: ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace;
      font-size: 0.9em;
    }
    .nw-ff-doc pre code { background: none; padding: 0; }
    .nw-ff-doc table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .nw-ff-doc td, .nw-ff-doc th { border: 1px solid #cccccc; padding: 6px; vertical-align: top; }
    .nw-ff-doc th { background: #f2f2f2; font-weight: 700; }
    .nw-ff-doc hr { border: 0; border-top: 1px solid #cccccc; padding: 6px 0 0 0; }
    .nw-ff-doc a { color: inherit; text-decoration: underline; }
    .nw-ff-doc .${FILE_CARD_CLASS} {
      border: 1px solid #cccccc; border-radius: 4px; padding: 6px 8px; font-size: 0.9em;
    }
    .nw-ff-doc .${FILE_CARD_CLASS} span { color: #555555; }
    .nw-ff-doc .${IMAGE_PLACEHOLDER_CLASS} {
      border: 1px dashed #cccccc; border-radius: 4px; padding: 8px;
      font-size: 0.9em; font-style: italic; color: #555555;
    }
    .${FREEFORM_PAGENUM_CLASS} {
      padding-top: 4mm; font-size: 8pt; color: #777777; text-align: right;
    }
  `;
}

/** The complete container markup handed to html2pdf. */
export function buildFreeformPdfDocument(pages) {
  return `<style>${freeformPdfCss()}</style>${buildFreeformPdfBody(pages)}`;
}
