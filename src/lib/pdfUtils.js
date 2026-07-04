// src/lib/pdfUtils.js
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

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

/* -------------------------------------------------------------------------- */
/* Flatten helpers                                                            */
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

// Converts an overlay-space point (pixels, at the given render scale, y-down)
// into PDF space (points, y-up).
function makeToPdf(scale, pageHeight) {
  const S = scale || 1;
  return (x, y) => ({ x: x / S, y: pageHeight - y / S });
}

function drawWrappedText(page, text, font, { x, yTop, maxWidth, fontSize, color }) {
  const str = String(text || "").trim();
  if (!str) return;
  const words = str.split(/\s+/);
  let line = "";
  const lines = [];
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(test, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  let y = yTop - fontSize;
  for (const l of lines) {
    page.drawText(l, { x, y, size: fontSize, font, color: rgb(color.r, color.g, color.b) });
    y -= fontSize * 1.25;
  }
}

// Highlight / underline / strike are stored as a line segment (x0,y0)-(x1,y1)
// plus a perpendicular thickness. Flatten as the exact rotated rect via its
// four corners; for the common horizontal/vertical case this is pixel-exact,
// for an off-axis mark it degrades gracefully to that rect's bounding box.
function drawMark(page, a, toPdf) {
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
  const offLow = -t + shift;
  const offHigh = t + shift;

  const corners = [
    { x: x0 + px * offHigh, y: y0 + py * offHigh },
    { x: x1 + px * offHigh, y: y1 + py * offHigh },
    { x: x1 + px * offLow, y: y1 + py * offLow },
    { x: x0 + px * offLow, y: y0 + py * offLow },
  ].map((c) => toPdf(c.x, c.y));

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const color = hexToRgb01(
    isHighlight ? a.fill : a.stroke,
    isHighlight ? { r: 1, g: 0.96, b: 0.61 } : { r: 0.2, g: 0.2, b: 0.2 }
  );

  page.drawRectangle({
    x: minX,
    y: minY,
    width: Math.max(0.5, maxX - minX),
    height: Math.max(0.5, maxY - minY),
    color: rgb(color.r, color.g, color.b),
    opacity: isHighlight ? a.opacity ?? 0.35 : 1,
    borderOpacity: 0,
  });
}

// Textbox / callout: bordered (and optionally filled) box with wrapped text.
function drawBoxText(page, a, font, toPdf, S) {
  const p1 = toPdf(a.x, a.y);
  const p2 = toPdf(a.x + (a.w || 0), a.y + (a.h || 0));
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);
  const hasFill = a.fill && a.fill !== "transparent";
  const fillColor = hasFill ? hexToRgb01(a.fill) : null;
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });
  const strokeWidth = (a.strokeWidth ?? 2) / S;

  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    color: fillColor ? rgb(fillColor.r, fillColor.g, fillColor.b) : undefined,
    borderColor: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
    borderWidth: strokeWidth,
  });

  if (a.type === "callout" && a.leader) {
    const lp = toPdf(a.leader.x, a.leader.y);
    page.drawLine({
      start: { x: lp.x, y: lp.y },
      end: { x: p1.x, y: p1.y },
      thickness: strokeWidth,
      color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
    });
  }

  drawWrappedText(page, a.text, font, {
    x: x + 4 / S,
    yTop: y + h - 4 / S,
    maxWidth: Math.max(10, w - 8 / S),
    fontSize: Math.max(6, (a.fontSize || 14) / S),
    color: hexToRgb01(a.textColor, { r: 0.07, g: 0.07, b: 0.07 }),
  });
}

// Typewriter: plain text, no border.
function drawPlainText(page, a, font, toPdf, S) {
  const p = toPdf(a.x, a.y);
  const fontSize = Math.max(6, (a.fontSize || 14) / S);
  drawWrappedText(page, a.text, font, {
    x: p.x,
    yTop: p.y,
    maxWidth: 400 / S,
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

function drawArrow(page, a, toPdf, S) {
  const p1 = toPdf(a.x1, a.y1);
  const p2 = toPdf(a.x2, a.y2);
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });
  const color = rgb(strokeColor.r, strokeColor.g, strokeColor.b);
  const thickness = (a.strokeWidth ?? 2) / S;

  page.drawLine({ start: p1, end: p2, thickness, color });

  const headSize = Math.max(6, thickness * 4);
  if (a.head === "single" || a.head === "double") drawArrowHead(page, p1, p2, headSize, color, thickness);
  if (a.head === "double") drawArrowHead(page, p2, p1, headSize, color, thickness);
}

function drawSticky(page, a, font, toPdf, S) {
  const p = toPdf(a.x, a.y);
  const size = 18 / S;
  const color = hexToRgb01(a.color, { r: 1, g: 0.88, b: 0.51 });

  page.drawRectangle({
    x: p.x,
    y: p.y - size,
    width: size,
    height: size,
    color: rgb(color.r, color.g, color.b),
    borderColor: rgb(0.2, 0.2, 0.2),
    borderWidth: 0.5,
  });

  const note = String(a.note || "").trim();
  if (note) {
    drawWrappedText(page, note, font, {
      x: p.x + size + 4 / S,
      yTop: p.y,
      maxWidth: 220 / S,
      fontSize: Math.max(6, 10 / S),
      color: { r: 0.07, g: 0.07, b: 0.07 },
    });
  }
}

function drawRect(page, a, toPdf, S) {
  const p1 = toPdf(a.x, a.y);
  const p2 = toPdf(a.x + (a.w || 0), a.y + (a.h || 0));
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);
  const hasFill = a.fill && a.fill !== "transparent";
  const fillColor = hasFill ? hexToRgb01(a.fill) : null;
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });

  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    color: fillColor ? rgb(fillColor.r, fillColor.g, fillColor.b) : undefined,
    borderColor: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
    borderWidth: (a.strokeWidth ?? 2) / S,
  });
}

function drawPen(page, a, toPdf, S) {
  const pts = a.pts || [];
  if (pts.length < 2) return;
  const strokeColor = hexToRgb01(a.stroke, { r: 0.2, g: 0.2, b: 0.2 });
  const color = rgb(strokeColor.r, strokeColor.g, strokeColor.b);
  const thickness = (a.strokeWidth ?? 3) / S;
  for (let i = 1; i < pts.length; i++) {
    const p1 = toPdf(pts[i - 1].x, pts[i - 1].y);
    const p2 = toPdf(pts[i].x, pts[i].y);
    page.drawLine({ start: p1, end: p2, thickness, color });
  }
}

/**
 * Flatten annotations onto the PDF using pdf-lib.
 * src: Uint8Array | ArrayBuffer | Blob
 * annotations: { [pageNo]: Array<annotation item, as produced by PdfAnnotator> }
 * scale: the render scale the overlay coordinates were captured at (default 1)
 */
export async function flattenAnnotations(src, annotations, scale = 1) {
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

  const S = scale || 1;
  // Load with a safe copy to avoid detached buffers
  const pdfDoc = await PDFDocument.load(bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const page = pages[i];
    const { height } = page.getSize();
    const toPdf = makeToPdf(S, height);

    const anns = annotations?.[pageNo] || [];
    for (const ann of anns) {
      try {
        switch (ann.type) {
          case "highlight":
          case "underline":
          case "strike":
            drawMark(page, ann, toPdf);
            break;
          case "textbox":
          case "callout":
            drawBoxText(page, ann, font, toPdf, S);
            break;
          case "typewriter":
            drawPlainText(page, ann, font, toPdf, S);
            break;
          case "arrow":
            drawArrow(page, ann, toPdf, S);
            break;
          case "sticky":
            drawSticky(page, ann, font, toPdf, S);
            break;
          case "rect":
            drawRect(page, ann, toPdf, S);
            break;
          case "pen":
            drawPen(page, ann, toPdf, S);
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
