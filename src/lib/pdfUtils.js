// src/lib/pdfUtils.js
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb, StandardFonts, degrees } from "pdf-lib";
import { makePageToPdf } from "./pdfCoords";

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

// Wrapped text: all layout math happens in page space (y-down), each line's
// baseline anchor is converted individually, and the glyphs are rotated by
// the page-space text angle so text reads upright on rotated pages.
function drawWrappedText(page, text, font, conv, { x, yTop, maxWidth, fontSize, color }) {
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
  const rotate = degrees(conv.textAngleDeg);
  let lineY = yTop + fontSize;
  for (const l of lines) {
    if (l) {
      const p = conv.toPdf(x, lineY);
      page.drawText(l, { x: p.x, y: p.y, size: fontSize, font, color: rgb(color.r, color.g, color.b), rotate });
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

// Textbox / callout: bordered (and optionally filled) box with wrapped text.
function drawBoxText(page, a, font, conv) {
  const hasFill = a.fill && a.fill !== "transparent";
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });

  drawPageRect(page, { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 }, conv, {
    color: hasFill ? hexToRgb01(a.fill) : undefined,
    borderColor: strokeColor,
    borderWidth: a.strokeWidth ?? 2,
  });

  if (a.type === "callout" && a.leader) {
    const lp = conv.toPdf(a.leader.x, a.leader.y);
    const bp = conv.toPdf(a.x, a.y);
    page.drawLine({
      start: { x: lp.x, y: lp.y },
      end: { x: bp.x, y: bp.y },
      thickness: a.strokeWidth ?? 2,
      color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
    });
  }

  drawWrappedText(page, a.text, font, conv, {
    x: a.x + 4,
    yTop: a.y + 4,
    maxWidth: Math.max(10, (a.w || 0) - 8),
    fontSize: Math.max(6, a.fontSize || 14),
    color: hexToRgb01(a.textColor, { r: 0.07, g: 0.07, b: 0.07 }),
  });
}

// Typewriter: plain text, no border. a.y is the text baseline on screen.
function drawPlainText(page, a, font, conv) {
  const fontSize = Math.max(6, a.fontSize || 14);
  drawWrappedText(page, a.text, font, conv, {
    x: a.x,
    yTop: a.y - fontSize,
    maxWidth: 400,
    fontSize,
    color: hexToRgb01(a.textColor, { r: 0.07, g: 0.07, b: 0.07 }),
  });
}

function drawArrowHead(page, from, tip, size, color, thickness) {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = Math.PI / 7;
  const w1 = { x: tip.x - size * Math.cos(ang - spread), y: tip.y - size * Math.sin(ang - spread) };
  const w2 = { x: tip.x - size * Math.cos(ang + spread), y: tip.y - size * Math.sin(ang + spread) };
  page.drawLine({ start: tip, end: w1, thickness, color });
  page.drawLine({ start: tip, end: w2, thickness, color });
}

function drawArrow(page, a, conv) {
  const p1 = conv.toPdf(a.x1, a.y1);
  const p2 = conv.toPdf(a.x2, a.y2);
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });
  const color = rgb(strokeColor.r, strokeColor.g, strokeColor.b);
  const thickness = a.strokeWidth ?? 2;

  page.drawLine({ start: p1, end: p2, thickness, color });

  const headSize = Math.max(6, thickness * 4);
  if (a.head === "single" || a.head === "double") drawArrowHead(page, p1, p2, headSize, color, thickness);
  if (a.head === "double") drawArrowHead(page, p2, p1, headSize, color, thickness);
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
  const hasFill = a.fill && a.fill !== "transparent";
  drawPageRect(page, { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 }, conv, {
    color: hasFill ? hexToRgb01(a.fill) : undefined,
    borderColor: hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 }),
    borderWidth: a.strokeWidth ?? 2,
  });
}

function drawPen(page, a, conv) {
  const pts = a.pts || [];
  if (pts.length < 2) return;
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });
  const color = rgb(strokeColor.r, strokeColor.g, strokeColor.b);
  const thickness = a.strokeWidth ?? 3;
  for (let i = 1; i < pts.length; i++) {
    const p1 = conv.toPdf(pts[i - 1].x, pts[i - 1].y);
    const p2 = conv.toPdf(pts[i].x, pts[i].y);
    page.drawLine({ start: p1, end: p2, thickness, color });
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
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const page = pages[i];
    const anns = annotations?.[pageNo] || [];
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
            drawBoxText(page, ann, font, conv);
            break;
          case "typewriter":
            drawPlainText(page, ann, font, conv);
            break;
          case "arrow":
            drawArrow(page, ann, conv);
            break;
          case "sticky":
            drawSticky(page, ann, font, conv);
            break;
          case "rect":
            drawRect(page, ann, conv);
            break;
          case "pen":
            drawPen(page, ann, conv);
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
