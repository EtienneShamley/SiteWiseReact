// src/lib/pdfUtils.js
import * as pdfjsLib from "pdfjs-dist";
import {
  PDFDocument,
  rgb,
  StandardFonts,
  degrees,
  LineCapStyle,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  fill,
  stroke,
  fillAndStroke,
  setFillingRgbColor,
  setStrokingRgbColor,
  setLineWidth,
} from "pdf-lib";
import { makePageToPdf } from "./pdfCoords";
import {
  arrowHeadPoints,
  arrowHeadSize,
  fontFamilyKind,
  hasNoBorder,
  isNoFill,
  normalizeAnnotation,
  sortByZOrder,
} from "./pdfAnnotationModel";

// Point the worker to the copy placed in /public
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

/**
 * Accepts Uint8Array | ArrayBuffer | Blob, returns a PDF.js document
 */
export async function loadPdf(src) {
  let bytes;
  if (src instanceof Uint8Array) {
    bytes = src;
  } else if (src instanceof Blob) {
    const ab = await src.arrayBuffer();
    bytes = new Uint8Array(ab);
  } else {
    // ArrayBuffer or ArrayBuffer-like
    // slice(0) ensures we have a fresh, non-detached copy
    const ab = src?.slice ? src.slice(0) : src;
    bytes = new Uint8Array(ab);
  }
  return pdfjsLib.getDocument({ data: bytes }).promise;
}

/**
 * Per-page layout metadata at scale 1 — the basis of the editor's coordinate
 * model (see src/lib/pdfCoords.js and docs/features/PDF_EDITOR.md):
 * [{ pageNo, baseW, baseH, transform, rotation, hasText }]
 * `transform` maps PDF user space -> page space; flattening inverts it.
 */
export async function getDocumentLayout(pdfDoc) {
  const pages = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const hasText = (textContent.items || []).some((it) => it.str && it.str.trim());
    pages.push({
      pageNo: p,
      baseW: viewport.width,
      baseH: viewport.height,
      transform: Array.from(viewport.transform),
      rotation: viewport.rotation,
      hasText,
    });
  }
  return pages;
}

export async function renderPageToCanvas(pdfDoc, pageNumber, scale = 1.25) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, width: canvas.width, height: canvas.height, scale };
}

/**
 * Render the pdf.js text layer for a page into `container` at `scale`.
 * The container (or an ancestor) must carry the `--scale-factor` CSS
 * variable equal to `scale`, per pdf.js layer conventions.
 */
export async function renderPageTextLayer(pdfDoc, pageNumber, container, scale) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  container.textContent = "";
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport,
  });
  await textLayer.render();
  return textLayer;
}

/* -------------------------------------------------------------------------- */
/* Export transaction state                                                   */
/*                                                                            */
/* Export is an explicit operation with four states rather than a boolean, so */
/* a failure can never be presented as a success and a second press cannot    */
/* start a concurrent export.                                                 */
/* -------------------------------------------------------------------------- */

export const EXPORT_STATE = {
  IDLE: "idle",
  EXPORTING: "exporting",
  SUCCESS: "success",
  FAILURE: "failure",
};

/** True only when a new export may begin. Refuses duplicates and no-document. */
export function canStartExport(state, { hasDocument = true } = {}) {
  if (!hasDocument) return false;
  return state !== EXPORT_STATE.EXPORTING;
}

/* -------------------------------------------------------------------------- */
/* Flatten helpers                                                            */
/*                                                                            */
/* All annotation geometry arrives in page space (scale-1 viewport units,     */
/* y-down — see src/lib/pdfCoords.js). Each page's converter (`conv`) maps    */
/* page space into PDF user space via the inverse of that page's scale-1      */
/* viewport transform, which makes flattening independent of on-screen zoom   */
/* and correct on rotated pages. Because page-space lengths equal PDF points, */
/* thicknesses and font sizes pass through unconverted.                       */
/* -------------------------------------------------------------------------- */

function hexToRgb01(hex, fallback = { r: 0, g: 0, b: 0 }) {
  if (!hex || typeof hex !== "string") return fallback;
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return fallback;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  if ([r, g, b].some((v) => Number.isNaN(v))) return fallback;
  return { r, g, b };
}

// Transform the 4 corners of a page-space rect into PDF user space and draw
// the bounding box. Exact for 0/90/180/270-degree page rotations.
function drawPageRect(page, rect, conv, { color, opacity, borderColor, borderWidth } = {}) {
  const corners = [
    conv.toPdf(rect.x, rect.y),
    conv.toPdf(rect.x + rect.w, rect.y),
    conv.toPdf(rect.x + rect.w, rect.y + rect.h),
    conv.toPdf(rect.x, rect.y + rect.h),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  page.drawRectangle({
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(0.5, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(0.5, Math.max(...ys) - Math.min(...ys)),
    color: color ? rgb(color.r, color.g, color.b) : undefined,
    opacity: color ? opacity ?? 1 : undefined,
    borderColor: borderColor ? rgb(borderColor.r, borderColor.g, borderColor.b) : undefined,
    borderWidth: borderColor ? borderWidth ?? 1 : undefined,
    borderOpacity: borderColor ? 1 : 0,
  });
}

/* ------------------------------ Fonts ------------------------------------ */

// The editor's three families × bold/italic map onto the PDF standard fonts,
// so what the ribbon offers is exactly what the flattened file can show.
const FONT_TABLE = {
  sans: [
    StandardFonts.Helvetica,
    StandardFonts.HelveticaBold,
    StandardFonts.HelveticaOblique,
    StandardFonts.HelveticaBoldOblique,
  ],
  serif: [
    StandardFonts.TimesRoman,
    StandardFonts.TimesRomanBold,
    StandardFonts.TimesRomanItalic,
    StandardFonts.TimesRomanBoldItalic,
  ],
  mono: [
    StandardFonts.Courier,
    StandardFonts.CourierBold,
    StandardFonts.CourierOblique,
    StandardFonts.CourierBoldOblique,
  ],
};

/** The standard font name for an annotation's family/bold/italic. */
export function standardFontFor(item) {
  const row = FONT_TABLE[fontFamilyKind(item?.fontFamily)] || FONT_TABLE.sans;
  const idx = (item?.bold ? 1 : 0) + (item?.italic ? 2 : 0);
  return row[idx];
}

/** Embed each standard font at most once per document. */
function makeFontCache(pdfDoc) {
  const cache = new Map();
  return async (item) => {
    const name = standardFontFor(item);
    if (!cache.has(name)) cache.set(name, await pdfDoc.embedFont(name));
    return cache.get(name);
  };
}

/* ------------------------------ Geometry --------------------------------- */

/** Rotate a page-space point about a centre by `deg` (SVG sense: clockwise on screen). */
function rotatePoint(p, centre, deg) {
  if (!deg) return p;
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const sn = Math.sin(rad);
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return { x: centre.x + dx * c - dy * sn, y: centre.y + dx * sn + dy * c };
}

const KAPPA = 0.5522847498;

/**
 * Draw a page-space rectangle — optionally with rounded corners and rotated
 * about its centre — as a PDF path, so the exported box has the same corners
 * the editor shows (the plain drawRectangle always produced sharp corners,
 * and could not rotate about the centre). Points are built in page space,
 * transformed through `conv`, and emitted as raw path operators.
 */
function drawRoundedBox(page, rect, conv, { corner = 0, rotate = 0, fillColor, strokeColor, strokeWidth }) {
  const { x, y, w, h } = rect;
  if (!(w > 0) || !(h > 0)) return;
  const r = Math.max(0, Math.min(corner || 0, w / 2, h / 2));
  const centre = { x: x + w / 2, y: y + h / 2 };
  const P = (px, py) => {
    const q = rotatePoint({ x: px, y: py }, centre, rotate);
    return conv.toPdf(q.x, q.y);
  };
  const ops = [pushGraphicsState()];
  const doFill = !!fillColor;
  const doStroke = !!strokeColor && strokeWidth > 0;
  if (!doFill && !doStroke) return;
  if (doFill) ops.push(setFillingRgbColor(fillColor.r, fillColor.g, fillColor.b));
  if (doStroke) {
    ops.push(setStrokingRgbColor(strokeColor.r, strokeColor.g, strokeColor.b));
    ops.push(setLineWidth(strokeWidth));
  }
  const k = r * KAPPA;
  const seg = (p) => lineTo(p.x, p.y);
  const curve = (c1, c2, p) => appendBezierCurve(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
  const start = P(x + r, y);
  ops.push(moveTo(start.x, start.y));
  ops.push(seg(P(x + w - r, y)));
  if (r > 0) ops.push(curve(P(x + w - r + k, y), P(x + w, y + r - k), P(x + w, y + r)));
  ops.push(seg(P(x + w, y + h - r)));
  if (r > 0) ops.push(curve(P(x + w, y + h - r + k), P(x + w - r + k, y + h), P(x + w - r, y + h)));
  ops.push(seg(P(x + r, y + h)));
  if (r > 0) ops.push(curve(P(x + r - k, y + h), P(x, y + h - r + k), P(x, y + h - r)));
  ops.push(seg(P(x, y + r)));
  if (r > 0) ops.push(curve(P(x, y + r - k), P(x + r - k, y), P(x + r, y)));
  ops.push(closePath());
  ops.push(doFill && doStroke ? fillAndStroke() : doFill ? fill() : stroke());
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
}

// Wrapped text: all layout math happens in page space (y-down), each line's
// baseline anchor is converted individually, and the glyphs are rotated by
// the page-space text angle so text reads upright on rotated pages. `align`
// positions each line inside `maxWidth`; `rotate`/`centre` rotate the whole
// block with its box.
function drawWrappedText(
  page,
  text,
  font,
  conv,
  { x, yTop, maxWidth, fontSize, color, align = "left", rotate = 0, centre = null }
) {
  const str = String(text || "").trim();
  if (!str) return;
  const paragraphs = str.split(/\n/);
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(test, fontSize) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  // Page-space clockwise rotation is a negative PDF (counter-clockwise) angle.
  const angle = degrees(conv.textAngleDeg - (rotate || 0));
  let lineY = yTop + fontSize;
  for (const l of lines) {
    if (l) {
      const width = font.widthOfTextAtSize(l, fontSize);
      const dx =
        align === "center" ? Math.max(0, (maxWidth - width) / 2) : align === "right" ? Math.max(0, maxWidth - width) : 0;
      const anchor =
        rotate && centre ? rotatePoint({ x: x + dx, y: lineY }, centre, rotate) : { x: x + dx, y: lineY };
      const p = conv.toPdf(anchor.x, anchor.y);
      page.drawText(l, { x: p.x, y: p.y, size: fontSize, font, color: rgb(color.r, color.g, color.b), rotate: angle });
    }
    lineY += fontSize * 1.25;
  }
}

// Quad-based text markup (highlight / underline / strikeout created from a
// real text selection): one logical annotation carries one rect per line.
function drawQuadMarkup(page, a, conv) {
  const quads = Array.isArray(a.quads) ? a.quads : [];
  const isHighlight = a.type === "highlight";
  const color = hexToRgb01(
    isHighlight ? a.fill : a.stroke,
    isHighlight ? { r: 1, g: 0.96, b: 0.61 } : { r: 0.2, g: 0.2, b: 0.2 }
  );
  for (const q of quads) {
    let rect;
    if (isHighlight) {
      rect = q;
    } else if (a.type === "underline") {
      const t = a.thickness ?? Math.max(1, q.h * 0.06);
      rect = { x: q.x, y: q.y + q.h - t, w: q.w, h: t };
    } else {
      // strike: band across the middle of the line
      const t = a.thickness ?? Math.max(1, q.h * 0.08);
      rect = { x: q.x, y: q.y + q.h / 2 - t / 2, w: q.w, h: t };
    }
    drawPageRect(page, rect, conv, {
      color,
      opacity: isHighlight ? a.opacity ?? 0.35 : 1,
    });
  }
}

// Drag-band markup (fallback for scanned/image-only pages): a line segment
// (x0,y0)-(x1,y1) plus a perpendicular thickness, all in page space.
function drawMark(page, a, conv) {
  const { x0, y0, x1, y1 } = a;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const px = -uy;
  const py = ux;
  const isHighlight = a.type === "highlight";
  const isUnderline = a.type === "underline";
  const t = (a.thickness ?? (isHighlight ? 22 : 3)) / 2;
  // Strike-through stays centered on the dragged line; underline is shifted
  // fully below it by one band-height (2t), matching the on-screen render
  // in PdfAnnotator.renderMark so the exported PDF is WYSIWYG.
  const shift = isUnderline ? 2 * t : 0;
  const corners = [
    { x: x0 + px * (t + shift), y: y0 + py * (t + shift) },
    { x: x1 + px * (t + shift), y: y1 + py * (t + shift) },
    { x: x1 + px * (-t + shift), y: y1 + py * (-t + shift) },
    { x: x0 + px * (-t + shift), y: y0 + py * (-t + shift) },
  ].map((c) => conv.toPdf(c.x, c.y));

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const color = hexToRgb01(
    isHighlight ? a.fill : a.stroke,
    isHighlight ? { r: 1, g: 0.96, b: 0.61 } : { r: 0.2, g: 0.2, b: 0.2 }
  );

  page.drawRectangle({
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(0.5, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(0.5, Math.max(...ys) - Math.min(...ys)),
    color: rgb(color.r, color.g, color.b),
    opacity: isHighlight ? a.opacity ?? 0.35 : 1,
    borderOpacity: 0,
  });
}

// Textbox / callout: a (rounded, possibly rotated) box with an optional fill,
// an optional border and wrapped text — the same corner radius, inset, line
// height, alignment, font and border state the editor overlay renders.
function drawBoxText(page, a, font, conv) {
  const hasFill = !isNoFill(a.fill);
  const noBorder = hasNoBorder(a);
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });
  const strokeWidth = noBorder ? 0 : a.strokeWidth ?? 2;
  const rect = { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 };
  const centre = { x: a.x + rect.w / 2, y: a.y + rect.h / 2 };
  const rotate = a.rotate || 0;

  drawRoundedBox(page, rect, conv, {
    corner: a.corner ?? 8,
    rotate,
    fillColor: hasFill ? hexToRgb01(a.fill) : null,
    strokeColor: noBorder ? null : strokeColor,
    strokeWidth,
  });

  if (a.type === "callout" && a.leader) {
    const lp = conv.toPdf(a.leader.x, a.leader.y);
    const corner = rotatePoint({ x: a.x, y: a.y }, centre, rotate);
    const bp = conv.toPdf(corner.x, corner.y);
    page.drawLine({
      start: { x: lp.x, y: lp.y },
      end: { x: bp.x, y: bp.y },
      // The leader is the callout's point; it stays visible without a border.
      thickness: strokeWidth || 1.5,
      color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
    });
  }

  drawWrappedText(page, a.text, font, conv, {
    x: a.x + 6,
    yTop: a.y + 6,
    maxWidth: Math.max(10, rect.w - 12),
    fontSize: Math.max(6, a.fontSize || 14),
    color: hexToRgb01(a.textColor, { r: 0.07, g: 0.07, b: 0.07 }),
    align: a.align || "left",
    rotate,
    centre,
  });
}

// Typewriter: plain text, no border. a.y is the text baseline on screen.
function drawPlainText(page, a, font, conv) {
  const fontSize = Math.max(6, a.fontSize || 14);
  drawWrappedText(page, a.text, font, conv, {
    x: a.x + 4,
    yTop: a.y - fontSize + 2,
    maxWidth: 400,
    fontSize,
    color: hexToRgb01(a.textColor, { r: 0.07, g: 0.07, b: 0.07 }),
  });
}

// Arrowhead barbs are computed in PAGE space by the shared helper the editor
// overlay uses, then converted — so the exported head matches the one drawn
// on screen instead of being derived from separate maths.
function drawArrowHead(page, from, tip, size, conv, color, thickness) {
  const barbs = arrowHeadPoints(from, tip, size);
  const start = conv.toPdf(tip.x, tip.y);
  for (const barb of barbs) {
    const end = conv.toPdf(barb.x, barb.y);
    page.drawLine({ start, end, thickness, color, lineCap: LineCapStyle.Round });
  }
}

// Arrow and line: one two-point segment, optionally with arrowheads.
function drawSegment(page, a, conv) {
  const p1 = { x: a.x1, y: a.y1 };
  const p2 = { x: a.x2, y: a.y2 };
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });
  const color = rgb(strokeColor.r, strokeColor.g, strokeColor.b);
  const thickness = a.strokeWidth ?? 2;

  page.drawLine({
    start: conv.toPdf(p1.x, p1.y),
    end: conv.toPdf(p2.x, p2.y),
    thickness,
    color,
    lineCap: LineCapStyle.Round,
  });

  if (a.type !== "arrow") return;
  const headSize = arrowHeadSize(thickness);
  if (a.head === "single" || a.head === "double") {
    drawArrowHead(page, p1, p2, headSize, conv, color, thickness);
  }
  if (a.head === "double") drawArrowHead(page, p2, p1, headSize, conv, color, thickness);
}

// Ellipse: the page-space bounding box becomes a centre plus two radii, and
// the ellipse is rotated by the page's text angle so it stays correct on
// rotated pages (exact at 0/90/180/270 degrees).
function drawEllipseAnn(page, a, conv) {
  const w = a.w || 0;
  const h = a.h || 0;
  if (w <= 0 || h <= 0) return;
  const centre = conv.toPdf(a.x + w / 2, a.y + h / 2);
  const hasFill = !isNoFill(a.fill);
  const noBorder = hasNoBorder(a);
  if (!hasFill && noBorder) return;
  const border = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });
  const fillCol = hasFill ? hexToRgb01(a.fill) : null;
  page.drawEllipse({
    x: centre.x,
    y: centre.y,
    xScale: w / 2,
    yScale: h / 2,
    rotate: degrees(conv.textAngleDeg),
    color: fillCol ? rgb(fillCol.r, fillCol.g, fillCol.b) : undefined,
    opacity: fillCol ? a.opacity ?? 1 : undefined,
    borderColor: noBorder ? undefined : rgb(border.r, border.g, border.b),
    borderWidth: noBorder ? 0 : a.strokeWidth ?? 2,
    borderOpacity: noBorder ? 0 : 1,
  });
}

function drawSticky(page, a, font, conv) {
  const size = 18;
  const color = hexToRgb01(a.color, { r: 1, g: 0.88, b: 0.51 });

  drawPageRect(page, { x: a.x, y: a.y, w: size, h: size }, conv, {
    color,
    borderColor: { r: 0.2, g: 0.2, b: 0.2 },
    borderWidth: 0.5,
  });

  const note = String(a.note || "").trim();
  if (note) {
    drawWrappedText(page, note, font, conv, {
      x: a.x + size + 4,
      yTop: a.y,
      maxWidth: 220,
      fontSize: 10,
      color: { r: 0.07, g: 0.07, b: 0.07 },
    });
  }
}

function drawRect(page, a, conv) {
  const hasFill = !isNoFill(a.fill);
  const noBorder = hasNoBorder(a);
  if (!hasFill && noBorder) return;
  drawPageRect(page, { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 }, conv, {
    color: hasFill ? hexToRgb01(a.fill) : undefined,
    borderColor: noBorder ? undefined : hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 }),
    borderWidth: noBorder ? 0 : a.strokeWidth ?? 2,
  });
}

// Freehand pen and freehand highlight: a sampled page-space path drawn as
// consecutive round-capped segments. The highlight variant carries the same
// opacity the editor renders it with.
function drawPath(page, a, conv) {
  const pts = a.pts || [];
  if (pts.length < 2) return;
  const isHighlight = a.type === "freehandHighlight";
  const strokeColor = hexToRgb01(
    a.stroke,
    isHighlight ? { r: 1, g: 0.96, b: 0.61 } : { r: 0.2, g: 0.2, b: 0.2 }
  );
  const color = rgb(strokeColor.r, strokeColor.g, strokeColor.b);
  const thickness = a.strokeWidth ?? (isHighlight ? 16 : 3);
  const opacity = isHighlight ? a.opacity ?? 0.35 : 1;
  for (let i = 1; i < pts.length; i++) {
    page.drawLine({
      start: conv.toPdf(pts[i - 1].x, pts[i - 1].y),
      end: conv.toPdf(pts[i].x, pts[i].y),
      thickness,
      color,
      opacity,
      lineCap: LineCapStyle.Round,
    });
  }
}

/**
 * Flatten annotations onto the PDF using pdf-lib.
 * src: Uint8Array | ArrayBuffer | Blob — the ORIGINAL source bytes
 * annotations: { [pageNo]: Array<annotation item, page-space coordinates> }
 * pageMetas: { [pageNo]: { transform } } — each page's scale-1 viewport
 *   transform from getDocumentLayout(); required for correct positioning
 *   (falls back to a simple y-flip when absent).
 *
 * The output is a flattened deliverable: annotations are burned into the
 * page content stream, not written as editable native PDF annotation objects.
 */
export async function flattenAnnotations(src, annotations, pageMetas = {}) {
  let bytes;
  if (src instanceof Uint8Array) {
    bytes = src;
  } else if (src instanceof Blob) {
    const ab = await src.arrayBuffer();
    bytes = new Uint8Array(ab);
  } else {
    const ab = src?.slice ? src.slice(0) : src;
    bytes = new Uint8Array(ab);
  }

  // Load with a safe copy to avoid detached buffers
  const pdfDoc = await PDFDocument.load(bytes);
  const fontFor = makeFontCache(pdfDoc);
  const font = await fontFor({});

  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const page = pages[i];
    // Validate through the same whitelist the editor and storage use, then
    // paint in the shared z-order (translucent highlights underneath). A
    // single malformed annotation is skipped, never fatal.
    const anns = sortByZOrder(
      (annotations?.[pageNo] || []).map(normalizeAnnotation).filter(Boolean)
    );
    if (!anns.length) continue;

    const meta = pageMetas?.[pageNo];
    // Fallback for callers without layout metadata: unrotated y-down page
    // space over the full media box (equivalent to the scale-1 viewport of
    // an unrotated page).
    const transform = meta?.transform || [1, 0, 0, -1, 0, page.getSize().height];
    const conv = makePageToPdf(transform);

    for (const ann of anns) {
      try {
        switch (ann.type) {
          case "highlight":
          case "underline":
          case "strike":
            if (Array.isArray(ann.quads) && ann.quads.length) drawQuadMarkup(page, ann, conv);
            else drawMark(page, ann, conv);
            break;
          case "textbox":
          case "callout":
            drawBoxText(page, ann, await fontFor(ann), conv);
            break;
          case "typewriter":
            drawPlainText(page, ann, await fontFor(ann), conv);
            break;
          case "arrow":
          case "line":
            drawSegment(page, ann, conv);
            break;
          case "sticky":
            drawSticky(page, ann, font, conv);
            break;
          case "rect":
            drawRect(page, ann, conv);
            break;
          case "ellipse":
            drawEllipseAnn(page, ann, conv);
            break;
          case "pen":
          case "freehandHighlight":
            drawPath(page, ann, conv);
            break;
          default:
            break;
        }
      } catch {
        // Skip a single malformed annotation rather than aborting the whole export.
      }
    }
  }

  const out = await pdfDoc.save();
  return new Blob([out], { type: "application/pdf" });
}
