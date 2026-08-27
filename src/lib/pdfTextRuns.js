// src/lib/pdfTextRuns.js
//
// Existing PDF text as EDITABLE GEOMETRY — the model behind the "Edit text"
// tool (docs/features/PDF_EDITOR.md → "Editing existing PDF text").
//
// NoteWise never rewrites a PDF's content stream: fonts inside a PDF are
// usually subset-embedded, so the glyphs for new characters do not exist in
// the file, and pdf-lib has no content-stream text editing. What the editor
// CAN do reliably is locate a run of the page's own text (pdf.js
// getTextContent gives every item's transform, advance width and font),
// cover it, and place an editable replacement exactly where it was, in the
// closest standard font, size, colour and rotation. That replacement is ONE
// annotation record (`textReplace`) — cover and text together — so it
// undoes, moves, copies, saves and exports as one object.
//
// This module is pure: it works on pdf.js text-content data and pixel
// buffers, never on the DOM or on pdf.js objects, so every rule is testable.
//
// GROUPING RULE. pdf.js splits a visible line into many items (per font
// change, per kerning break, per word on some producers). Consecutive items
// join one run while they share a baseline (perpendicular drift below
// 0.35 × font size), the same direction (within 1°), a similar size, and the
// gap along the baseline is smaller than 1.5 × font size — bigger gaps are
// table columns or justified-layout artifacts and start a new run. An item
// pdf.js marks `hasEOL` always ends its run. A run is therefore one visible
// line (or one cell of a line), which is the unit a user recognises as "that
// text" and the unit a replacement covers.

import { applyTransform } from "./pdfCoords";
import { PDF_FONT_FAMILIES, fontFamilyKind } from "./pdfAnnotationModel";

/** Ratios used when pdf.js reports no font metrics (matches pdfSearch's box). */
export const DEFAULT_ASCENT = 0.9;
export const DEFAULT_DESCENT = -0.25;

const BASELINE_TOLERANCE = 0.35; // × font size
const ANGLE_TOLERANCE_DEG = 1;
const JOIN_GAP = 1.5; // × font size — larger gaps split runs
const SPACE_GAP = 0.12; // × font size — smaller gaps are kerning, not a space
const SIZE_TOLERANCE = 0.25; // relative font-size difference that still joins

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/* -------------------------------------------------------------------------- */
/* Item geometry                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One pdf.js text item in page space: baseline origin, unit text direction,
 * font size, advance width and the font's ascent/descent ratios. Returns
 * null for an item without usable geometry (missing transform, zero size).
 */
export function textItemGeometry(item, viewportTransform, styles) {
  if (!item || typeof item.str !== "string") return null;
  const m = Array.isArray(item.transform) ? item.transform : null;
  if (!m || m.length < 6 || m.some((v) => !Number.isFinite(v))) return null;
  const vt = Array.isArray(viewportTransform) && viewportTransform.length >= 6
    ? viewportTransform
    : [1, 0, 0, 1, 0, 0];
  const origin = applyTransform(vt, m[4], m[5]);
  // Text-space unit vectors (1,0) and (0,1) mapped through both transforms.
  const along = {
    x: vt[0] * m[0] + vt[2] * m[1],
    y: vt[1] * m[0] + vt[3] * m[1],
  };
  const up = {
    x: vt[0] * m[2] + vt[2] * m[3],
    y: vt[1] * m[2] + vt[3] * m[3],
  };
  const fontSize = Math.hypot(up.x, up.y);
  const alongLen = Math.hypot(along.x, along.y);
  if (!(fontSize > 0) || !(alongLen > 0)) return null;
  const dir = { x: along.x / alongLen, y: along.y / alongLen };
  const width = finite(item.width) ?? 0;
  const style = styles && item.fontName ? styles[item.fontName] : null;
  const ascent = finite(style?.ascent) && style.ascent > 0 ? style.ascent : DEFAULT_ASCENT;
  const descent = finite(style?.descent) && style.descent < 0 ? style.descent : DEFAULT_DESCENT;
  return {
    str: item.str,
    origin,
    dir,
    angle: (Math.atan2(dir.y, dir.x) * 180) / Math.PI,
    fontSize,
    width: Math.max(0, width),
    ascent,
    descent,
    fontName: typeof item.fontName === "string" ? item.fontName : null,
    hasEOL: item.hasEOL === true,
  };
}

// Signed distance of `p` from the line through `origin` along `dir`,
// measured along the baseline (t) and perpendicular to it (n).
function projectOnto(origin, dir, p) {
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { t: dx * dir.x + dy * dir.y, n: -dx * dir.y + dy * dir.x };
}

function angleDelta(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

function finishRun(run, index) {
  const fs = run.fontSize;
  const h = (run.ascent - run.descent) * fs;
  const w = Math.max(0.5, run.end - run.start);
  // "Up" on screen for this run: perpendicular to the direction of reading.
  const up = { x: run.dir.y, y: -run.dir.x };
  const centreT = run.start + w / 2;
  const centreU = ((run.ascent + run.descent) / 2) * fs;
  const centre = {
    x: run.origin.x + run.dir.x * centreT + up.x * centreU,
    y: run.origin.y + run.dir.y * centreT + up.y * centreU,
  };
  // Snap near-zero angles so ordinary horizontal text stores no rotation.
  const angle = Math.abs(run.angle) < 0.05 ? 0 : Math.round(run.angle * 100) / 100;
  return {
    index,
    text: run.text,
    // The unrotated frame; rotating it about its centre by `angle` (SVG
    // sense, clockwise on screen) gives the run's actual position.
    x: centre.x - w / 2,
    y: centre.y - h / 2,
    w,
    h,
    angle,
    fontSize: fs,
    ascent: run.ascent,
    descent: run.descent,
    fontName: run.fontName,
    // Baseline offset from the frame's top, in page units.
    baselineOffset: run.ascent * fs,
  };
}

/**
 * Group one page's pdf.js text content into line runs (see the grouping rule
 * in the file header). `viewportTransform` is the page's scale-1 viewport
 * transform. Returns [] for a page without selectable text.
 */
export function buildTextRuns(textContent, viewportTransform) {
  const items = Array.isArray(textContent?.items) ? textContent.items : [];
  const styles = textContent?.styles || null;
  const runs = [];
  let cur = null;

  const close = () => {
    if (cur && cur.text.trim()) runs.push(finishRun(cur, runs.length));
    cur = null;
  };

  for (const item of items) {
    const g = textItemGeometry(item, viewportTransform, styles);
    if (!g) {
      // A geometry-less EOL marker still ends the current line.
      if (item?.hasEOL) close();
      continue;
    }
    if (!g.str) {
      if (g.hasEOL) close();
      continue;
    }

    let joined = false;
    if (cur) {
      const { t, n } = projectOnto(cur.origin, cur.dir, g.origin);
      const sizeOk =
        Math.abs(g.fontSize - cur.fontSize) / Math.max(cur.fontSize, g.fontSize) <= SIZE_TOLERANCE;
      const gap = t - cur.end;
      if (
        angleDelta(g.angle, cur.angle) <= ANGLE_TOLERANCE_DEG &&
        Math.abs(n) <= BASELINE_TOLERANCE * cur.fontSize &&
        sizeOk &&
        gap >= -0.5 * cur.fontSize &&
        gap <= JOIN_GAP * cur.fontSize
      ) {
        const needsSpace =
          gap > SPACE_GAP * cur.fontSize && !/\s$/.test(cur.text) && !/^\s/.test(g.str);
        cur.text += (needsSpace ? " " : "") + g.str;
        cur.end = Math.max(cur.end, t + g.width);
        cur.start = Math.min(cur.start, t);
        // Keep the largest glyph box on the line so the cover hides everything.
        if (g.fontSize > cur.fontSize) {
          cur.fontSize = g.fontSize;
          cur.fontName = g.fontName;
        }
        cur.ascent = Math.max(cur.ascent, g.ascent);
        cur.descent = Math.min(cur.descent, g.descent);
        joined = true;
      }
    }
    if (!joined) {
      close();
      cur = {
        origin: g.origin,
        dir: g.dir,
        angle: g.angle,
        fontSize: g.fontSize,
        ascent: g.ascent,
        descent: g.descent,
        fontName: g.fontName,
        text: g.str,
        start: 0,
        end: g.width,
      };
    }
    if (g.hasEOL) close();
  }
  close();
  return runs;
}

/* -------------------------------------------------------------------------- */
/* Hit testing                                                                */
/* -------------------------------------------------------------------------- */

/** Rotate a page-space point about a centre by `deg` (SVG sense). */
function rotateAbout(p, centre, deg) {
  if (!deg) return p;
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return { x: centre.x + dx * c - dy * s, y: centre.y + dx * s + dy * c };
}

/** The four page-space corners of a run's (possibly rotated) frame. */
export function runCorners(run) {
  const centre = { x: run.x + run.w / 2, y: run.y + run.h / 2 };
  return [
    { x: run.x, y: run.y },
    { x: run.x + run.w, y: run.y },
    { x: run.x + run.w, y: run.y + run.h },
    { x: run.x, y: run.y + run.h },
  ].map((p) => rotateAbout(p, centre, run.angle || 0));
}

/**
 * The run under a page-space point, or null. `tolerance` (page units) pads
 * the frame so a click just outside thin text still resolves. When runs
 * overlap the smallest one wins — a word-level item over a whole line.
 */
export function hitTestRun(runs, point, tolerance = 2) {
  if (!Array.isArray(runs) || !point) return null;
  let best = null;
  for (const run of runs) {
    const centre = { x: run.x + run.w / 2, y: run.y + run.h / 2 };
    const local = rotateAbout(point, centre, -(run.angle || 0));
    const inside =
      local.x >= run.x - tolerance &&
      local.x <= run.x + run.w + tolerance &&
      local.y >= run.y - tolerance &&
      local.y <= run.y + run.h + tolerance;
    if (!inside) continue;
    if (!best || run.w * run.h < best.w * best.h) best = run;
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Font description                                                           */
/* -------------------------------------------------------------------------- */

const BOLD_RE = /bold|black|heavy|semibold|demibold|extrabold|ultrabold/i;
const ITALIC_RE = /italic|oblique/i;
const SERIF_RE = /times|georgia|garamond|cambria|book|roman|serif|minion|palatino|baskerville/i;
const MONO_RE = /mono|courier|consolas|menlo|code/i;

/**
 * Approximate a PDF font as the editor's family × bold × italic. Uses, in
 * order of trust: the pdf.js font object flags when the page has loaded it
 * (`bold`, `italic`, `isSerifFont`, `isMonospace`, `name`), the font NAME
 * (e.g. "ABCDEF+Arial-BoldMT"), then the generic `fontFamily` pdf.js reports
 * in `textContent.styles`. Embedded/subset fonts cannot be reproduced; the
 * result is the closest of the three standard families the export can show.
 */
export function describeFont({ fontName, styles, fontObj } = {}) {
  const style = styles && fontName ? styles[fontName] : null;
  const name = String(fontObj?.name || fontObj?.loadedName || "");
  const generic = String(style?.fontFamily || "").toLowerCase();

  let bold = fontObj?.bold === true || fontObj?.black === true || BOLD_RE.test(name);
  let italic = fontObj?.italic === true || ITALIC_RE.test(name);

  let kind;
  if (fontObj?.isMonospace === true || MONO_RE.test(name) || /mono/.test(generic)) kind = "mono";
  else if (fontObj?.isSerifFont === true || SERIF_RE.test(name.replace(/sans[- ]?serif/i, "")))
    kind = "serif";
  else if (/^serif$/.test(generic.trim())) kind = "serif";
  else kind = "sans";
  // "sans-serif" contains "serif": the regex above strips it before testing.
  if (/sans/i.test(name) && !MONO_RE.test(name)) kind = "sans";

  const family = PDF_FONT_FAMILIES.find((f) => f.id === kind) || PDF_FONT_FAMILIES[0];
  return { kind: fontFamilyKind(family.css), fontFamily: family.css, bold: !!bold, italic: !!italic };
}

/* -------------------------------------------------------------------------- */
/* Colour sampling                                                            */
/* -------------------------------------------------------------------------- */

const toHex = (n) => n.toString(16).padStart(2, "0");
const QUANT = 16; // colour bucket size for the histogram
const MIN_CONTRAST = 60; // Euclidean RGB distance that separates ink from paper

/**
 * Derive the paper colour and the ink colour of a text run from the pixels
 * the page rendered there. `pixels` is ImageData-like ({ data, width,
 * height }, RGBA). The most common colour is the background (the cover
 * colour); the most common colour clearly different from it is the text
 * colour. Returns { background, foreground } as #RRGGBB, each null when the
 * buffer is empty or (for foreground) when nothing contrasts — e.g. a run
 * over a photo, where the cover colour is a guess the ribbon lets the user
 * correct. Never throws on malformed input.
 */
export function sampleRunColours(pixels) {
  const data = pixels?.data;
  const len = data?.length;
  if (!len || len < 4) return { background: null, foreground: null };
  const hist = new Map();
  for (let i = 0; i + 3 < len; i += 4) {
    if (data[i + 3] < 128) continue; // transparent → not paper, not ink
    const key = ((data[i] / QUANT) | 0) * 65536 + ((data[i + 1] / QUANT) | 0) * 256 + ((data[i + 2] / QUANT) | 0);
    const e = hist.get(key);
    if (e) {
      e.n += 1;
      e.r += data[i];
      e.g += data[i + 1];
      e.b += data[i + 2];
    } else hist.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
  }
  if (!hist.size) return { background: null, foreground: null };
  const buckets = [...hist.values()].sort((a, b) => b.n - a.n);
  const mean = (e) => ({ r: Math.round(e.r / e.n), g: Math.round(e.g / e.n), b: Math.round(e.b / e.n) });
  const bg = mean(buckets[0]);
  let fg = null;
  for (const e of buckets.slice(1)) {
    const c = mean(e);
    if (Math.hypot(c.r - bg.r, c.g - bg.g, c.b - bg.b) >= MIN_CONTRAST) {
      fg = c;
      break;
    }
  }
  const hex = (c) => `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`.toUpperCase();
  return { background: hex(bg), foreground: fg ? hex(fg) : null };
}

/* -------------------------------------------------------------------------- */
/* Replacement record                                                         */
/* -------------------------------------------------------------------------- */

export const DEFAULT_COVER = "#FFFFFF";
export const DEFAULT_INK = "#111111";

/**
 * The field values a `textReplace` annotation inherits from a run. Pure:
 * the caller adds `id`/`page`/timestamps via newAnnotationBase. `font` is a
 * describeFont() result; `colours` a sampleRunColours() result; both may be
 * missing, in which case the stable fallbacks apply (sans, white cover,
 * near-black ink).
 */
export function replacementFromRun(run, { font, colours } = {}) {
  if (!run) return null;
  const f = font || describeFont({});
  const out = {
    x: run.x,
    y: run.y,
    w: run.w,
    h: run.h,
    text: run.text,
    sourceText: run.text,
    fontSize: Math.max(1, Math.round(run.fontSize * 100) / 100),
    fontFamily: f.fontFamily,
    ascent: run.ascent,
    descent: run.descent,
    textColor: colours?.foreground || DEFAULT_INK,
    fill: colours?.background || DEFAULT_COVER,
    strokeWidth: 0,
  };
  if (f.bold) out.bold = true;
  if (f.italic) out.italic = true;
  if (run.angle) out.rotate = run.angle;
  return out;
}

/**
 * A replacement seeded from a native text selection: `quads` are the
 * selection's page-space line rects (already normalized), `text` the
 * selected string, `run` the run under the first line (for size, font and
 * metrics). One line keeps the exact selected extent; several lines become
 * one block whose line pitch is measured from the quads. Returns null when
 * the selection has no usable geometry.
 */
export function replacementFromSelection({ quads, text, run, font, colours }) {
  const lines = (quads || []).filter((q) => q && q.w > 0.5 && q.h > 0.5).sort((a, b) => a.y - b.y);
  if (!lines.length || !run) return null;
  const base = replacementFromRun(run, { font, colours });
  if (!base) return null;
  const minX = Math.min(...lines.map((q) => q.x));
  const maxX = Math.max(...lines.map((q) => q.x + q.w));
  const top = Math.min(...lines.map((q) => q.y));
  const bottom = Math.max(...lines.map((q) => q.y + q.h));
  const str = String(text || "").replace(/\r\n?/g, "\n");
  const out = { ...base, x: minX, w: Math.max(0.5, maxX - minX), text: str, sourceText: str };
  delete out.rotate; // selection rects are axis-aligned by construction
  if (lines.length === 1) {
    // Keep the run's own vertical frame so the baseline is preserved.
    return out;
  }
  const pitch = (lines[lines.length - 1].y - lines[0].y) / (lines.length - 1);
  out.y = top;
  out.h = Math.max(base.h, bottom - top);
  out.lineHeight = Math.max(0.8, Math.round((pitch / base.fontSize) * 100) / 100);
  // Baseline of the first line stays where the run's was.
  out.ascent = Math.max(0.5, (run.y + run.baselineOffset - top) / base.fontSize);
  return out;
}

/**
 * The line pitch a replacement renders and exports with: its stored
 * `lineHeight` ratio, else the glyph box (ascent − descent) so a single line
 * sits exactly where the original did.
 */
export function replacementLineHeight(item) {
  const lh = finite(item?.lineHeight);
  if (lh && lh > 0) return lh;
  const ascent = finite(item?.ascent) ?? DEFAULT_ASCENT;
  const descent = finite(item?.descent) ?? DEFAULT_DESCENT;
  return Math.max(0.8, ascent - descent);
}

/** Baseline offset from the frame top, in page units, for a replacement. */
export function replacementBaseline(item) {
  const ascent = finite(item?.ascent) ?? DEFAULT_ASCENT;
  const fs = finite(item?.fontSize) ?? 14;
  return ascent * fs;
}
