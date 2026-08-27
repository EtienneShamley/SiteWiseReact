// src/lib/imageAnnotationRaster.js
//
// The RASTER boundary of the Photo Annotator (P4): the annotation items of an
// image surface — the same canonical records the shared engine edits
// (src/lib/pdfAnnotationModel.js), in native image pixels — burned onto a copy
// of the photograph with the Canvas 2D API, at the image's own resolution.
//
// This is the image-surface counterpart of the PDF flatten in
// src/lib/pdfUtils.js: same paint order (sortByZOrder), same arrowheads
// (arrowHeadPoints), same callout leader (calloutLeaderGeometry), same
// no-fill / no-border semantics, the same 6-unit text inset, 1.25 line
// height and CSS-line-box baseline the SVG overlay renders — so the
// flattened picture matches the editor as closely as canvas text can match
// browser text. Nothing here screenshots the DOM: the output is a
// deterministic function of (source pixels, size, items), so the same layer
// produces the same picture on every save.
//
// SPLIT: everything above `renderAnnotatedImage` is pure over a 2D-context
// interface (fillRect, beginPath, fillText, measureText…) and is exercised in
// tests with a recording context; the platform pieces — a canvas, the
// decoded source, Blob encoding — arrive through `deps`.
import {
  ANNOTATION_TYPES,
  DEFAULT_FONT_FAMILY,
  STICKY_SIZE,
  arrowHeadPoints,
  arrowHeadSize,
  hasNoBorder,
  isNoFill,
  normalizeAnnotationList,
  sortByZOrder,
  typewriterBox,
} from "./pdfAnnotationModel";
import { calloutLeaderGeometry } from "./pdfCallout";
import { replacementBaseline, replacementLineHeight } from "./pdfTextRuns";
import { IMAGE_OUTPUT_QUALITY, chooseOutputType, decodeImageSource, isAllowedImageMimeType, normalizeMimeType } from "./imageProcessing";

/* -------------------------------------------------------------------------- */
/* Text                                                                       */
/* -------------------------------------------------------------------------- */

/** The CSS font shorthand for a text annotation — what the overlay renders with. */
export function annotationFont(a) {
  const fs = Math.max(1, Number(a?.fontSize) || 14);
  const family = a?.fontFamily || DEFAULT_FONT_FAMILY;
  return `${a?.italic ? "italic " : ""}${a?.bold ? "bold " : ""}${fs}px ${family}`;
}

/**
 * Break `text` into drawn lines the way a `white-space: pre-wrap` box does:
 * explicit newlines always break; words wrap at `maxWidth`; a single word
 * wider than the box is broken between characters rather than overflowing.
 * `measure(str)` returns the advance width of `str` in the current font.
 */
export function wrapTextLines(text, maxWidth, measure) {
  const str = String(text ?? "");
  if (!str) return [];
  const width = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Infinity;
  const out = [];
  for (const para of str.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    const words = para.split(" ");
    let line = "";
    const pushWord = (word) => {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width || !line) {
        if (!line && measure(word) > width) {
          // Break an oversized word between characters.
          let chunk = "";
          for (const ch of word) {
            if (chunk && measure(chunk + ch) > width) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        out.push(line);
        if (measure(word) > width) {
          line = "";
          pushWord(word);
        } else {
          line = word;
        }
      }
    };
    for (const word of words) pushWord(word);
    out.push(line);
  }
  return out;
}

/**
 * Where the first baseline of a CSS line box sits below its top, for the
 * overlay's sans/serif/mono families: ≈ 0.9 em plus half the leading. The
 * same approximation the Edit-text placement uses on screen (P3).
 */
export function firstBaselineOffset(fontSize, lineHeight) {
  const fs = Math.max(1, Number(fontSize) || 14);
  const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 1.25;
  return (0.9 + (lh - 1.15) / 2) * fs;
}

function drawTextBlock(ctx, a, { x, top, width, height, lineHeight, wrap, firstBaseline }) {
  const text = String(a.text ?? "");
  if (!text) return;
  const fs = Math.max(1, Number(a.fontSize) || 14);
  ctx.save();
  // The overlay's foreignObject clips its content to the text area.
  ctx.beginPath();
  ctx.rect(x, top, Math.max(0, width), Math.max(0, height));
  ctx.clip();
  ctx.font = annotationFont(a);
  ctx.fillStyle = a.textColor || "#111111";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const measure = (s) => ctx.measureText(s).width;
  const lines = wrap ? wrapTextLines(text, width, measure) : text.split("\n");
  let y = firstBaseline != null ? firstBaseline : top + firstBaselineOffset(fs, lineHeight);
  for (const line of lines) {
    if (line) {
      const lw = measure(line);
      const dx = a.align === "center" ? Math.max(0, (width - lw) / 2) : a.align === "right" ? Math.max(0, width - lw) : 0;
      ctx.fillText(line, x + dx, y);
    }
    y += fs * lineHeight;
  }
  ctx.restore();
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  ctx.beginPath();
  if (!rr) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function strokeSegment(ctx, p1, p2, stroke, width) {
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
}

function drawArrowHead(ctx, from, tip, size, stroke, width) {
  for (const barb of arrowHeadPoints(from, tip, size)) strokeSegment(ctx, tip, barb, stroke, width);
}

function withRotation(ctx, a, fn) {
  const rotate = Number(a.rotate) || 0;
  if (!rotate) {
    fn();
    return;
  }
  const cx = a.x + (a.w || 0) / 2;
  const cy = a.y + (a.h || 0) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

function drawBoxText(ctx, a) {
  const noBorder = hasNoBorder(a);
  const strokeWidth = noBorder ? 0 : a.strokeWidth ?? 2;
  const stroke = a.stroke || "#333333";
  if (a.type === ANNOTATION_TYPES.CALLOUT) {
    // The leader is drawn OUTSIDE the box's rotation, from the one shared
    // geometry the overlay and the PDF export use.
    const leader = calloutLeaderGeometry(a);
    if (leader) {
      strokeSegment(ctx, leader.anchor, leader.tip, stroke, leader.width);
      for (const barb of leader.barbs) strokeSegment(ctx, leader.tip, barb, stroke, leader.width);
    }
  }
  withRotation(ctx, a, () => {
    roundedRectPath(ctx, a.x, a.y, a.w, a.h, a.corner ?? 8);
    if (!isNoFill(a.fill)) {
      ctx.fillStyle = a.fill;
      ctx.fill();
    }
    if (!noBorder && strokeWidth > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    drawTextBlock(ctx, a, {
      x: a.x + 6,
      top: a.y + 6,
      width: Math.max(20, a.w - 12),
      height: Math.max(20, a.h - 12),
      lineHeight: 1.25,
      wrap: true,
    });
  });
}

function drawTextReplace(ctx, a) {
  withRotation(ctx, a, () => {
    if (!isNoFill(a.fill)) {
      ctx.fillStyle = a.fill;
      ctx.fillRect(a.x, a.y, a.w, a.h);
    }
    const fs = Math.max(1, Number(a.fontSize) || 14);
    const lh = replacementLineHeight(a);
    drawTextBlock(ctx, a, {
      x: a.x,
      top: a.y + replacementBaseline(a) - firstBaselineOffset(fs, lh),
      width: Math.max(20, a.w),
      height: Math.max(fs * lh, a.h),
      lineHeight: lh,
      wrap: false,
      firstBaseline: a.y + replacementBaseline(a),
    });
  });
}

function drawTypewriter(ctx, a) {
  const fs = Math.max(1, Number(a.fontSize) || 14);
  // The overlay's box: top-left at (x, y − fs), the font-proportional
  // typewriter box in size, with a 2px/4px padding and a 1.2 line height,
  // unwrapped (`white-space: pre`).
  const box = typewriterBox(fs);
  drawTextBlock(ctx, a, {
    x: a.x + 4,
    top: a.y - fs + 2,
    width: box.w - 8,
    height: box.h - 4,
    lineHeight: 1.2,
    wrap: false,
  });
}

function drawSegment(ctx, a) {
  const stroke = a.stroke || "#333333";
  const width = a.strokeWidth || 2;
  const p1 = { x: a.x1, y: a.y1 };
  const p2 = { x: a.x2, y: a.y2 };
  strokeSegment(ctx, p1, p2, stroke, width);
  const head = a.type === ANNOTATION_TYPES.ARROW ? a.head || "single" : "none";
  const size = arrowHeadSize(width);
  if (head === "single" || head === "double") drawArrowHead(ctx, p1, p2, size, stroke, width);
  if (head === "double") drawArrowHead(ctx, p2, p1, size, stroke, width);
}

function drawPath(ctx, a) {
  const pts = Array.isArray(a.pts) ? a.pts : [];
  if (pts.length < 2) return;
  const isHighlight = a.type === ANNOTATION_TYPES.FREEHAND_HIGHLIGHT;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = a.stroke || (isHighlight ? "#FFF59D" : "#1976D2");
  ctx.lineWidth = a.strokeWidth || (isHighlight ? 16 : 3);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = isHighlight ? a.opacity ?? 0.35 : 1;
  ctx.stroke();
  ctx.restore();
}

function drawRect(ctx, a) {
  const noBorder = hasNoBorder(a);
  if (!isNoFill(a.fill)) {
    ctx.fillStyle = a.fill;
    ctx.fillRect(a.x, a.y, a.w, a.h);
  }
  if (!noBorder) {
    ctx.strokeStyle = a.stroke || "#333333";
    ctx.lineWidth = a.strokeWidth ?? 2;
    ctx.lineJoin = "miter";
    ctx.strokeRect(a.x, a.y, a.w, a.h);
  }
}

function drawEllipse(ctx, a) {
  const noBorder = hasNoBorder(a);
  ctx.beginPath();
  ctx.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
  if (!isNoFill(a.fill)) {
    ctx.fillStyle = a.fill;
    ctx.fill();
  }
  if (!noBorder) {
    ctx.strokeStyle = a.stroke || "#333333";
    ctx.lineWidth = a.strokeWidth ?? 2;
    ctx.stroke();
  }
}

function drawQuadMarkup(ctx, a) {
  const color = a.type === ANNOTATION_TYPES.HIGHLIGHT ? a.fill || "#FFF59D" : a.stroke || "#333333";
  ctx.save();
  ctx.fillStyle = color;
  for (const q of a.quads) {
    if (a.type === ANNOTATION_TYPES.HIGHLIGHT) {
      ctx.globalAlpha = a.opacity ?? 0.35;
      ctx.fillRect(q.x, q.y, q.w, q.h);
      continue;
    }
    const t = Math.max(1, q.h * (a.type === ANNOTATION_TYPES.STRIKE ? 0.08 : 0.06));
    const y = a.type === ANNOTATION_TYPES.STRIKE ? q.y + q.h / 2 - t / 2 : q.y + q.h - t;
    ctx.globalAlpha = 1;
    ctx.fillRect(q.x, y, q.w, t);
  }
  ctx.restore();
}

function drawMark(ctx, a) {
  const p0 = { x: a.x0, y: a.y0 };
  const p1 = { x: a.x1, y: a.y1 };
  const bw = Math.max(1, Math.hypot(p1.x - p0.x, p1.y - p0.y));
  const isHighlight = a.type === ANNOTATION_TYPES.HIGHLIGHT;
  const bh = isHighlight ? Math.max(1, a.thickness ?? 22) : Math.max(1, a.thickness ?? a.strokeWidth ?? 3);
  const cx = (a.x0 + a.x1) / 2;
  const cy = (a.y0 + a.y1) / 2;
  const ang = a.angleSnap != null ? a.angleSnap : (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
  const y = a.type === ANNOTATION_TYPES.UNDERLINE ? cy - bh / 2 + bh : cy - bh / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((ang * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = isHighlight ? a.fill || "#FFF59D" : a.stroke || "#333333";
  ctx.globalAlpha = isHighlight ? a.opacity ?? 0.35 : 1;
  ctx.fillRect(cx - bw / 2, y, bw, bh);
  ctx.restore();
}

function drawSticky(ctx, a) {
  // Not offered by the photo ribbon, but a record that reaches a raster is
  // drawn the way the PDF export draws it: the marker and its note text.
  ctx.fillStyle = a.color || "#FFE082";
  roundedRectPath(ctx, a.x, a.y, STICKY_SIZE, STICKY_SIZE, 2);
  ctx.fill();
  ctx.strokeStyle = "#333333";
  ctx.lineWidth = 0.5;
  ctx.stroke();
  const note = String(a.note || "").trim();
  if (note) {
    drawTextBlock(ctx, { text: note, fontSize: 10, textColor: "#111111" }, {
      x: a.x + STICKY_SIZE + 4,
      top: a.y,
      width: 220,
      height: 400,
      lineHeight: 1.25,
      wrap: true,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The whole layer                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Draw every annotation onto `ctx`, in the shared paint order, in image
 * pixels. Records are validated first (the persistence whitelist), so a
 * malformed one is skipped rather than drawn wrong. Returns the number drawn.
 */
export function drawAnnotationsToContext(ctx, items) {
  const list = sortByZOrder(normalizeAnnotationList(items));
  let drawn = 0;
  for (const a of list) {
    ctx.save();
    ctx.globalAlpha = 1;
    switch (a.type) {
      case ANNOTATION_TYPES.TEXTBOX:
      case ANNOTATION_TYPES.CALLOUT:
        drawBoxText(ctx, a);
        break;
      case ANNOTATION_TYPES.TEXT_REPLACE:
        drawTextReplace(ctx, a);
        break;
      case ANNOTATION_TYPES.TYPEWRITER:
        drawTypewriter(ctx, a);
        break;
      case ANNOTATION_TYPES.ARROW:
      case ANNOTATION_TYPES.LINE:
        drawSegment(ctx, a);
        break;
      case ANNOTATION_TYPES.PEN:
      case ANNOTATION_TYPES.FREEHAND_HIGHLIGHT:
      case ANNOTATION_TYPES.POLYLINE:
        drawPath(ctx, a);
        break;
      case ANNOTATION_TYPES.RECT:
        drawRect(ctx, a);
        break;
      case ANNOTATION_TYPES.ELLIPSE:
        drawEllipse(ctx, a);
        break;
      case ANNOTATION_TYPES.HIGHLIGHT:
      case ANNOTATION_TYPES.UNDERLINE:
      case ANNOTATION_TYPES.STRIKE:
        if (Array.isArray(a.quads) && a.quads.length) drawQuadMarkup(ctx, a);
        else drawMark(ctx, a);
        break;
      case ANNOTATION_TYPES.STICKY:
        drawSticky(ctx, a);
        break;
      default:
        ctx.restore();
        continue;
    }
    ctx.restore();
    drawn += 1;
  }
  return drawn;
}

/* -------------------------------------------------------------------------- */
/* Platform: source → canvas → Blob                                           */
/* -------------------------------------------------------------------------- */

export const RASTER_FAILURE_MESSAGE = "The annotated photo could not be rendered.";

function defaultCreateCanvas() {
  if (typeof document === "undefined") throw new Error(RASTER_FAILURE_MESSAGE);
  return document.createElement("canvas");
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(RASTER_FAILURE_MESSAGE))), mimeType, quality);
      return;
    }
    if (typeof canvas.convertToBlob === "function") {
      canvas.convertToBlob({ type: mimeType, quality }).then(resolve, () => reject(new Error(RASTER_FAILURE_MESSAGE)));
      return;
    }
    reject(new Error(RASTER_FAILURE_MESSAGE));
  });
}

/**
 * The flattened rendition of `sourceBlob` with `items` drawn over it.
 *
 * The output keeps the source's pixel size and aspect (the decoded,
 * EXIF-oriented image) and its format: a PNG stays a PNG (alpha preserved,
 * lossless), a JPEG is re-encoded once — from the ORIGINAL pixels, never
 * from an earlier rendition — at the shared image quality; WebP likewise.
 *
 * @returns {Promise<{blob: Blob, width: number, height: number, mimeType: string}>}
 * @throws Error with a user-facing message
 */
export async function renderAnnotatedImage({ sourceBlob, items, mimeType, quality }, deps = {}) {
  const createCanvas = deps.createCanvas || defaultCreateCanvas;
  const decode = deps.decodeImageSource || decodeImageSource;
  const toBlob = deps.canvasToBlob || canvasToBlob;
  const sourceType = normalizeMimeType(mimeType || sourceBlob?.type);
  if (!isAllowedImageMimeType(sourceType)) throw new Error(RASTER_FAILURE_MESSAGE);

  let decoded;
  try {
    decoded = await decode(sourceBlob, deps);
  } catch {
    throw new Error(RASTER_FAILURE_MESSAGE);
  }
  if (!decoded || !(decoded.width > 0) || !(decoded.height > 0)) {
    if (decoded?.release) decoded.release();
    throw new Error(RASTER_FAILURE_MESSAGE);
  }
  try {
    const canvas = createCanvas();
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) throw new Error(RASTER_FAILURE_MESSAGE);
    ctx.drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
    drawAnnotationsToContext(ctx, items);
    const outputType = chooseOutputType(sourceType);
    const blob = await toBlob(canvas, outputType, quality ?? IMAGE_OUTPUT_QUALITY);
    if (!blob || typeof blob.size !== "number" || blob.size === 0) throw new Error(RASTER_FAILURE_MESSAGE);
    return {
      blob,
      width: decoded.width,
      height: decoded.height,
      mimeType: normalizeMimeType(blob.type) || outputType,
    };
  } finally {
    if (decoded.release) decoded.release();
  }
}
