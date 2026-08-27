// src/lib/pdfAnnotationModel.js
//
// The normalized persistence boundary and shared geometry model for PDF
// annotations.
//
// Every annotation that is READ from storage passes through
// `normalizeAnnotationList`, and everything WRITTEN to storage passes through
// `serializeAnnotations`. Both work from an explicit per-type field whitelist,
// so transient UI state (editing/dragging/pointer ids/menu state), DOM
// references and object URLs can never reach a stored record, and a malformed
// stored record can never reach the renderer.
//
// Coordinates are page space throughout — pdf.js scale-1 viewport units, y-down
// (see src/lib/pdfCoords.js). This module never touches the DOM and never
// mutates its inputs, so it is fully unit-testable.
import { newId } from "./id";

export const ANNOTATION_TYPES = {
  HIGHLIGHT: "highlight",
  UNDERLINE: "underline",
  STRIKE: "strike",
  TEXTBOX: "textbox",
  CALLOUT: "callout",
  TYPEWRITER: "typewriter",
  STICKY: "sticky",
  ARROW: "arrow",
  LINE: "line",
  RECT: "rect",
  ELLIPSE: "ellipse",
  PEN: "pen",
  FREEHAND_HIGHLIGHT: "freehandHighlight",
  POLYLINE: "polyline",
  // A replacement for a run of the PDF's own text: ONE record carrying the
  // cover (fill over the original glyphs) and the editable text that sits in
  // its place, with the metrics inherited from the source run
  // (src/lib/pdfTextRuns.js). The source bytes are never changed.
  TEXT_REPLACE: "textReplace",
};

/**
 * Keys that describe live editor state rather than the annotation itself.
 * They are never emitted by `serializeAnnotations` — the whitelist below is
 * what enforces that; this list exists so the rule is explicit and testable.
 */
export const TRANSIENT_KEYS = [
  "editing",
  "selected",
  "active",
  "dragging",
  "resizing",
  "pointerId",
  "menuOpen",
  "open",
  "hover",
  "el",
  "node",
  "ref",
  "url",
  "objectUrl",
  "blobUrl",
  "history",
];

/** Paint order band. Lower bands are drawn first (underneath). */
export const Z_ORDER = {
  [ANNOTATION_TYPES.HIGHLIGHT]: 0,
  [ANNOTATION_TYPES.FREEHAND_HIGHLIGHT]: 0,
  [ANNOTATION_TYPES.UNDERLINE]: 1,
  [ANNOTATION_TYPES.STRIKE]: 1,
  [ANNOTATION_TYPES.RECT]: 2,
  [ANNOTATION_TYPES.ELLIPSE]: 2,
  [ANNOTATION_TYPES.LINE]: 2,
  [ANNOTATION_TYPES.ARROW]: 2,
  [ANNOTATION_TYPES.PEN]: 2,
  [ANNOTATION_TYPES.POLYLINE]: 2,
  [ANNOTATION_TYPES.TEXTBOX]: 3,
  [ANNOTATION_TYPES.CALLOUT]: 3,
  [ANNOTATION_TYPES.TYPEWRITER]: 3,
  // Covers must sit above shapes drawn near the text and below sticky notes,
  // but under text boxes so a box placed over replaced text stays visible.
  [ANNOTATION_TYPES.TEXT_REPLACE]: 2.5,
  [ANNOTATION_TYPES.STICKY]: 4,
};

/** Smallest edge a resizable shape may be reduced to, in page units. */
export const MIN_SHAPE_SIZE = 6;

/** Upper bound on persisted points for a sampled path annotation. */
export const MAX_PATH_POINTS = 200;

/** Minimum page-space distance between two retained path points. */
export const PATH_SIMPLIFY_TOLERANCE = 1.5;

/* -------------------------------------------------------------------------- */
/* Field coercion                                                             */
/* -------------------------------------------------------------------------- */

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const positive = (v) => {
  const n = finite(v);
  return n !== undefined && n > 0 ? n : undefined;
};
const text = (v, max) => {
  if (typeof v !== "string") return undefined;
  return v.length <= max ? v : v.slice(0, max);
};

// A colour/style value must never be able to smuggle a URL (object URL, data
// URL, or a navigable scheme) into a stored record.
const URL_LIKE = /^\s*(blob:|data:|javascript:|vbscript:|file:)|:\/\//i;
const colour = (v) => {
  const s = text(v, 64);
  if (s === undefined) return undefined;
  const trimmed = s.trim();
  if (!trimmed || URL_LIKE.test(trimmed)) return undefined;
  return trimmed;
};

const opacity01 = (v) => {
  const n = finite(v);
  if (n === undefined) return undefined;
  return Math.min(1, Math.max(0, n));
};

const pageNumber = (v) => {
  const n = finite(v);
  if (n === undefined) return undefined;
  const i = Math.trunc(n);
  return i >= 1 ? i : undefined;
};

const point = (v) => {
  if (!v || typeof v !== "object") return undefined;
  const x = finite(v.x);
  const y = finite(v.y);
  return x === undefined || y === undefined ? undefined : { x, y };
};

const quad = (v) => {
  if (!v || typeof v !== "object") return undefined;
  const x = finite(v.x);
  const y = finite(v.y);
  const w = positive(v.w);
  const h = positive(v.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  return { x, y, w, h };
};

const pointList = (v) => {
  if (!Array.isArray(v)) return undefined;
  const pts = [];
  for (const raw of v) {
    const p = point(raw);
    if (p) pts.push(p);
  }
  return pts.length >= 2 ? pts : undefined;
};

/** Copy `keys` from `src` onto `out` using `fn`, skipping absent values. */
function copyOptional(out, src, keys, fn) {
  for (const key of keys) {
    const value = fn(src[key]);
    if (value !== undefined) out[key] = value;
  }
}

const HEAD_STYLES = ["none", "single", "double"];

/** Text alignment values a text annotation may carry (and export). */
export const TEXT_ALIGNMENTS = ["left", "center", "right"];

/**
 * The font families a text annotation may use. The stored value is the CSS
 * family string the editor renders with; `kind` is what the flattened export
 * maps onto a PDF standard font (Helvetica / Times / Courier). Historical
 * records store the first entry's CSS string, so they resolve to "sans".
 */
export const PDF_FONT_FAMILIES = [
  {
    id: "sans",
    label: "Sans",
    css: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  },
  { id: "serif", label: "Serif", css: "Georgia, 'Times New Roman', Times, serif" },
  { id: "mono", label: "Mono", css: "ui-monospace, Menlo, Consolas, 'Courier New', monospace" },
];

export const DEFAULT_FONT_FAMILY = PDF_FONT_FAMILIES[0].css;

/** Classify a stored CSS font-family string as sans | serif | mono. */
export function fontFamilyKind(css) {
  const s = typeof css === "string" ? css.toLowerCase() : "";
  if (/mono|courier|menlo|consolas/.test(s)) return "mono";
  if (/georgia|times|garamond|cambria/.test(s)) return "serif";
  // "sans-serif" contains "serif"; only a bare generic serif counts.
  if (/(^|[\s,])serif\b/.test(s) && !/sans-serif/.test(s)) return "serif";
  return "sans";
}

/** The canonical "no fill" value. Stored as-is; never an empty string. */
export const NO_FILL = "transparent";

/** True when a stored fill means "no fill". */
export function isNoFill(fill) {
  return fill == null || fill === NO_FILL || fill === "none";
}

/**
 * True when a box-like annotation has NO border. Canonical representation is
 * `strokeWidth: 0`; a record without a strokeWidth keeps its historical
 * default (2) and therefore has one.
 */
export function hasNoBorder(item) {
  return typeof item?.strokeWidth === "number" && item.strokeWidth === 0;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

const nonNegative = (v) => {
  const n = finite(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

function normalizeStyle(out, raw) {
  copyOptional(out, raw, ["fill", "stroke", "color", "textColor", "fontFamily"], colour);
  // A strokeWidth of exactly 0 is the canonical "no border" — it must survive
  // the boundary rather than being dropped and silently restored to 2.
  copyOptional(out, raw, ["strokeWidth"], nonNegative);
  copyOptional(out, raw, ["thickness", "fontSize", "corner"], positive);
  copyOptional(out, raw, ["rotate"], finite);
  if (raw.opacity !== undefined) {
    const o = opacity01(raw.opacity);
    if (o !== undefined) out.opacity = o;
  }
  const align = text(raw.align, 16);
  if (align && TEXT_ALIGNMENTS.includes(align)) out.align = align;
  if (raw.bold === true) out.bold = true;
  if (raw.italic === true) out.italic = true;
}

function normalizeMarkup(out, raw) {
  const quads = Array.isArray(raw.quads)
    ? raw.quads.map(quad).filter(Boolean)
    : [];
  if (quads.length) {
    out.quads = quads;
    return true;
  }
  // Drag-band fallback (scanned pages): a segment plus a perpendicular band.
  const x0 = finite(raw.x0);
  const y0 = finite(raw.y0);
  const x1 = finite(raw.x1);
  const y1 = finite(raw.y1);
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
    return false;
  }
  out.x0 = x0;
  out.y0 = y0;
  out.x1 = x1;
  out.y1 = y1;
  const snap = finite(raw.angleSnap);
  if (snap !== undefined) out.angleSnap = snap;
  return true;
}

function normalizeBox(out, raw, { requireSize }) {
  const x = finite(raw.x);
  const y = finite(raw.y);
  if (x === undefined || y === undefined) return false;
  out.x = x;
  out.y = y;
  if (requireSize) {
    const w = positive(raw.w);
    const h = positive(raw.h);
    if (w === undefined || h === undefined) return false;
    out.w = w;
    out.h = h;
  }
  return true;
}

function normalizeSegment(out, raw) {
  const x1 = finite(raw.x1);
  const y1 = finite(raw.y1);
  const x2 = finite(raw.x2);
  const y2 = finite(raw.y2);
  if ([x1, y1, x2, y2].some((v) => v === undefined)) return false;
  out.x1 = x1;
  out.y1 = y1;
  out.x2 = x2;
  out.y2 = y2;
  return true;
}

/**
 * Validate and whitelist one raw annotation.
 *
 * Returns a new plain object containing ONLY known fields, or `null` when the
 * record is malformed beyond safe repair. It is idempotent, and it never
 * fabricates `createdAt`/`updatedAt` for a record that lacks them — reading a
 * valid stored record therefore produces an identical record, so simply
 * opening a document never rewrites its stored annotations.
 */
export function normalizeAnnotation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const type = text(raw.type, 32);
  if (!type || !Object.prototype.hasOwnProperty.call(Z_ORDER, type)) return null;

  const page = pageNumber(raw.page);
  if (page === undefined) return null;

  // A missing id means an already-broken record; keeping the annotation is
  // worth more than the stable id we cannot recover.
  const id = text(raw.id, 128) || newId();

  const out = { id, page, type };

  switch (type) {
    case ANNOTATION_TYPES.HIGHLIGHT:
    case ANNOTATION_TYPES.UNDERLINE:
    case ANNOTATION_TYPES.STRIKE:
      if (!normalizeMarkup(out, raw)) return null;
      break;

    case ANNOTATION_TYPES.RECT:
    case ANNOTATION_TYPES.ELLIPSE:
      if (!normalizeBox(out, raw, { requireSize: true })) return null;
      break;

    case ANNOTATION_TYPES.TEXTBOX:
    case ANNOTATION_TYPES.CALLOUT: {
      if (!normalizeBox(out, raw, { requireSize: true })) return null;
      const body = text(raw.text, 20000);
      if (body !== undefined) out.text = body;
      const leader = point(raw.leader);
      if (leader && type === ANNOTATION_TYPES.CALLOUT) out.leader = leader;
      break;
    }

    case ANNOTATION_TYPES.TYPEWRITER: {
      if (!normalizeBox(out, raw, { requireSize: false })) return null;
      const body = text(raw.text, 20000);
      if (body !== undefined) out.text = body;
      break;
    }

    case ANNOTATION_TYPES.TEXT_REPLACE: {
      if (!normalizeBox(out, raw, { requireSize: true })) return null;
      const body = text(raw.text, 20000);
      // An EMPTY replacement is meaningful (it removes the original text), so
      // the field is always present.
      out.text = body === undefined ? "" : body;
      const source = text(raw.sourceText, 20000);
      if (source !== undefined) out.sourceText = source;
      // Metrics of the source run: ascent (>0) and descent (<0) as ratios of
      // the font size, and an optional line pitch ratio for a multi-line
      // replacement. Malformed values fall back to the module defaults.
      const ascent = positive(raw.ascent);
      if (ascent !== undefined && ascent <= 2) out.ascent = ascent;
      const descent = finite(raw.descent);
      if (descent !== undefined && descent < 0 && descent >= -1) out.descent = descent;
      const lineHeight = positive(raw.lineHeight);
      if (lineHeight !== undefined && lineHeight <= 4) out.lineHeight = lineHeight;
      break;
    }

    case ANNOTATION_TYPES.STICKY: {
      if (!normalizeBox(out, raw, { requireSize: false })) return null;
      const note = text(raw.note, 20000);
      if (note !== undefined) out.note = note;
      break;
    }

    case ANNOTATION_TYPES.ARROW:
    case ANNOTATION_TYPES.LINE: {
      if (!normalizeSegment(out, raw)) return null;
      if (type === ANNOTATION_TYPES.ARROW) {
        const head = text(raw.head, 16);
        if (head && HEAD_STYLES.includes(head)) out.head = head;
      }
      break;
    }

    case ANNOTATION_TYPES.PEN:
    case ANNOTATION_TYPES.FREEHAND_HIGHLIGHT:
    case ANNOTATION_TYPES.POLYLINE: {
      const pts = pointList(raw.pts);
      if (!pts) return null;
      out.pts = pts;
      break;
    }

    default:
      return null;
  }

  normalizeStyle(out, raw);

  const createdAt = finite(raw.createdAt);
  if (createdAt !== undefined) out.createdAt = createdAt;
  const updatedAt = finite(raw.updatedAt);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;

  return out;
}

/** Normalize a whole list, dropping malformed entries. Never mutates input. */
export function normalizeAnnotationList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const normalized = normalizeAnnotation(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * The write side of the persistence boundary. Identical to normalization —
 * the same whitelist decides what may be stored — but named separately so the
 * call sites read honestly.
 */
export function serializeAnnotations(items) {
  return normalizeAnnotationList(items);
}

/** A fresh annotation's common fields. Only new annotations get an id/time. */
export function newAnnotationBase(page, type) {
  const now = Date.now();
  return { id: newId(), page, type, createdAt: now, updatedAt: now };
}

/**
 * Stamp `updatedAt` on the items that actually changed relative to `before`.
 * Used once per committed gesture, so a no-op gesture leaves timestamps alone.
 */
export function stampUpdated(before, after, now = Date.now()) {
  const previous = new Map((before || []).map((it) => [it?.id, it]));
  return (after || []).map((item) => {
    if (!item) return item;
    const prev = previous.get(item.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(item)) return item;
    return { ...item, updatedAt: now };
  });
}

/* -------------------------------------------------------------------------- */
/* Paint order                                                                */
/* -------------------------------------------------------------------------- */

const zBand = (item) => Z_ORDER[item?.type] ?? 2;

/**
 * Return a COPY ordered for painting: translucent highlights underneath,
 * outlines and lines above them, text and sticky markers on top. Annotations
 * in the same band keep their creation order, and the canonical array is
 * never reordered. Used by both the editor overlay and the export.
 */
export function sortByZOrder(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => zBand(a.item) - zBand(b.item) || a.index - b.index)
    .map((entry) => entry.item);
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                           */
/*                                                                            */
/* `bounds` is always a page's base size: { width, height } in page units.    */
/* -------------------------------------------------------------------------- */

const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

function safeBounds(bounds) {
  const width = positive(bounds?.width) ?? Number.POSITIVE_INFINITY;
  const height = positive(bounds?.height) ?? Number.POSITIVE_INFINITY;
  return { width, height };
}

/** Clamp a page-space point inside the page. */
export function clampPointToPage(p, bounds) {
  const b = safeBounds(bounds);
  return {
    x: clamp(finite(p?.x) ?? 0, 0, b.width),
    y: clamp(finite(p?.y) ?? 0, 0, b.height),
  };
}

/** Force positive width/height, moving the origin as needed. */
export function normalizeRect(rect) {
  const x = finite(rect?.x) ?? 0;
  const y = finite(rect?.y) ?? 0;
  const w = finite(rect?.w) ?? 0;
  const h = finite(rect?.h) ?? 0;
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

/** Build a normalized, clamped rect from the two corners of a drag. */
export function rectFromPoints(p0, p1, bounds, min = MIN_SHAPE_SIZE) {
  const b = safeBounds(bounds);
  const a = clampPointToPage(p0, b);
  const c = clampPointToPage(p1, b);
  const [x, w] = resizeAxis(a.x, c.x, min, b.width);
  const [y, h] = resizeAxis(a.y, c.y, min, b.height);
  return { x, y, w, h };
}

/**
 * Resolve one axis of a resize: `anchor` stays put, `target` follows the
 * pointer. Guarantees a non-negative length of at least `min` (unless the page
 * itself is smaller) and keeps both edges inside [0, size].
 */
function resizeAxis(anchor, target, min, size) {
  if (!Number.isFinite(size) || size <= min) {
    const span = Number.isFinite(size) ? size : Math.max(min, Math.abs(target - anchor));
    return [0, span];
  }
  const a = clamp(anchor, 0, size);
  let t = clamp(target, 0, size);
  if (Math.abs(t - a) < min) {
    // Grow away from the anchor, preferring the side the pointer is on and
    // falling back to the other side when the page edge is in the way.
    const towardsNegative = t < a;
    let candidate = towardsNegative ? a - min : a + min;
    if (candidate < 0 || candidate > size) candidate = towardsNegative ? a + min : a - min;
    t = clamp(candidate, 0, size);
  }
  let lo = Math.min(a, t);
  let len = Math.abs(t - a);
  if (len < min) {
    lo = clamp(a - min, 0, size - min);
    len = min;
  }
  return [lo, len];
}

/** Translate a rect, keeping it fully inside the page. */
export function moveRect(rect, dx, dy, bounds) {
  const r = normalizeRect(rect);
  const b = safeBounds(bounds);
  const maxX = Math.max(0, b.width - r.w);
  const maxY = Math.max(0, b.height - r.h);
  return {
    x: clamp(r.x + (finite(dx) ?? 0), 0, maxX),
    y: clamp(r.y + (finite(dy) ?? 0), 0, maxY),
    w: r.w,
    h: r.h,
  };
}

export const RECT_CORNERS = ["nw", "ne", "sw", "se"];

/**
 * Resize a rect by dragging one corner. The opposite corner is the anchor, so
 * dragging past it never yields a negative or inverted rectangle.
 */
export function resizeRectCorner(rect, corner, pointerPoint, bounds, min = MIN_SHAPE_SIZE) {
  const r = normalizeRect(rect);
  const b = safeBounds(bounds);
  const p = clampPointToPage(pointerPoint, b);
  const anchorX = corner === "nw" || corner === "sw" ? r.x + r.w : r.x;
  const anchorY = corner === "nw" || corner === "ne" ? r.y + r.h : r.y;
  const [x, w] = resizeAxis(anchorX, p.x, min, b.width);
  const [y, h] = resizeAxis(anchorY, p.y, min, b.height);
  return { x, y, w, h };
}

/** Translate a two-point segment, shifting it back inside the page if needed. */
export function moveSegment(seg, dx, dy, bounds) {
  const b = safeBounds(bounds);
  const x1 = finite(seg?.x1) ?? 0;
  const y1 = finite(seg?.y1) ?? 0;
  const x2 = finite(seg?.x2) ?? 0;
  const y2 = finite(seg?.y2) ?? 0;
  let ax = finite(dx) ?? 0;
  let ay = finite(dy) ?? 0;

  const maxX = Math.max(x1, x2);
  const minX = Math.min(x1, x2);
  if (maxX + ax > b.width) ax = b.width - maxX;
  if (minX + ax < 0) ax = -minX;

  const maxY = Math.max(y1, y2);
  const minY = Math.min(y1, y2);
  if (maxY + ay > b.height) ay = b.height - maxY;
  if (minY + ay < 0) ay = -minY;

  return { x1: x1 + ax, y1: y1 + ay, x2: x2 + ax, y2: y2 + ay };
}

/** Move one endpoint of a segment, clamped inside the page. */
export function setSegmentEnd(seg, which, pointerPoint, bounds) {
  const p = clampPointToPage(pointerPoint, bounds);
  const base = {
    x1: finite(seg?.x1) ?? 0,
    y1: finite(seg?.y1) ?? 0,
    x2: finite(seg?.x2) ?? 0,
    y2: finite(seg?.y2) ?? 0,
  };
  if (which === "start") return { ...base, x1: p.x, y1: p.y };
  return { ...base, x2: p.x, y2: p.y };
}

/**
 * Sample and cap a captured pointer path.
 *
 * Drops points closer together than `tolerance`, always keeps the first and
 * last, and uniformly decimates down to `maxPoints`. Returns `[]` when fewer
 * than two meaningful points remain, so an incomplete gesture creates nothing.
 */
export function simplifyPath(
  pts,
  tolerance = PATH_SIMPLIFY_TOLERANCE,
  maxPoints = MAX_PATH_POINTS
) {
  if (!Array.isArray(pts)) return [];
  const clean = [];
  for (const raw of pts) {
    const p = point(raw);
    if (p) clean.push(p);
  }
  if (clean.length < 2) return [];

  const tol = positive(tolerance) ?? PATH_SIMPLIFY_TOLERANCE;
  const sampled = [clean[0]];
  for (let i = 1; i < clean.length; i++) {
    const last = sampled[sampled.length - 1];
    if (Math.hypot(clean[i].x - last.x, clean[i].y - last.y) >= tol) sampled.push(clean[i]);
  }

  // The stroke must end exactly where the pointer did. If the final sample was
  // dropped for being too close, it replaces the retained tail rather than
  // being appended — appending would re-introduce a sub-tolerance point.
  const end = clean[clean.length - 1];
  const tail = sampled[sampled.length - 1];
  if (tail.x !== end.x || tail.y !== end.y) {
    if (sampled.length >= 2) sampled[sampled.length - 1] = end;
    else sampled.push(end);
  }

  // A tap — every sample within the tolerance of the first — is not a stroke.
  if (sampled.length < 2) return [];

  const cap = Math.max(2, Math.trunc(positive(maxPoints) ?? MAX_PATH_POINTS));
  if (sampled.length <= cap) return sampled;

  // Uniform decimation that always retains both ends.
  const out = [];
  const step = (sampled.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) out.push(sampled[Math.round(i * step)]);
  out[out.length - 1] = sampled[sampled.length - 1];
  return out;
}

/** Clamp every point of a path inside the page. */
export function clampPathToPage(pts, bounds) {
  if (!Array.isArray(pts)) return [];
  return pts.map((p) => clampPointToPage(p, bounds));
}

/* -------------------------------------------------------------------------- */
/* Whole-annotation geometry (selection, marquee, multi-move, later clipboard)*/
/* -------------------------------------------------------------------------- */

/** Fixed on-page size of the sticky-note marker, in page units. */
export const STICKY_SIZE = 18;
/** Typewriter text has no stored size; this is its on-page hit box. */
export const TYPEWRITER_BOX = { w: 260, h: 40 };

function boundsOfPoints(pts, pad = 0) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX - pad,
    y: minY - pad,
    w: Math.max(...xs) - minX + pad * 2,
    h: Math.max(...ys) - minY + pad * 2,
  };
}

/**
 * The page-space axis-aligned bounding box of any annotation type, or null
 * for a record with no usable geometry. Rotation is ignored (the box is the
 * unrotated frame), which is what selection and marquee hit-testing use.
 */
export function annotationBounds(item) {
  if (!item || typeof item !== "object") return null;
  switch (item.type) {
    case ANNOTATION_TYPES.RECT:
    case ANNOTATION_TYPES.ELLIPSE:
    case ANNOTATION_TYPES.TEXTBOX:
    case ANNOTATION_TYPES.CALLOUT:
    case ANNOTATION_TYPES.TEXT_REPLACE: {
      const r = quad(item);
      return r ? normalizeRect(r) : null;
    }
    case ANNOTATION_TYPES.TYPEWRITER: {
      const p = point(item);
      if (!p) return null;
      const fs = positive(item.fontSize) ?? 14;
      return { x: p.x - 4, y: p.y - fs - 4, w: TYPEWRITER_BOX.w, h: TYPEWRITER_BOX.h };
    }
    case ANNOTATION_TYPES.STICKY: {
      const p = point(item);
      return p ? { x: p.x, y: p.y, w: STICKY_SIZE, h: STICKY_SIZE } : null;
    }
    case ANNOTATION_TYPES.ARROW:
    case ANNOTATION_TYPES.LINE: {
      const a = point({ x: item.x1, y: item.y1 });
      const b = point({ x: item.x2, y: item.y2 });
      if (!a || !b) return null;
      return boundsOfPoints([a, b], (positive(item.strokeWidth) ?? 2) / 2);
    }
    case ANNOTATION_TYPES.PEN:
    case ANNOTATION_TYPES.FREEHAND_HIGHLIGHT:
    case ANNOTATION_TYPES.POLYLINE: {
      const pts = pointList(item.pts);
      if (!pts) return null;
      return boundsOfPoints(pts, (positive(item.strokeWidth) ?? 2) / 2);
    }
    case ANNOTATION_TYPES.HIGHLIGHT:
    case ANNOTATION_TYPES.UNDERLINE:
    case ANNOTATION_TYPES.STRIKE: {
      const quads = Array.isArray(item.quads) ? item.quads.map(quad).filter(Boolean) : [];
      if (quads.length) {
        return boundsOfPoints(quads.flatMap((q) => [{ x: q.x, y: q.y }, { x: q.x + q.w, y: q.y + q.h }]));
      }
      const a = point({ x: item.x0, y: item.y0 });
      const b = point({ x: item.x1, y: item.y1 });
      if (!a || !b) return null;
      const t = positive(item.thickness) ?? (item.type === ANNOTATION_TYPES.HIGHLIGHT ? 22 : 3);
      return boundsOfPoints([a, b], t / 2);
    }
    default:
      return null;
  }
}

/**
 * Whether an annotation can be translated as a whole. Quad markup is anchored
 * to the PDF's own text and never moves.
 */
export function isMovable(item) {
  if (!item) return false;
  if (
    [ANNOTATION_TYPES.HIGHLIGHT, ANNOTATION_TYPES.UNDERLINE, ANNOTATION_TYPES.STRIKE].includes(
      item.type
    )
  ) {
    return !(Array.isArray(item.quads) && item.quads.length);
  }
  return annotationBounds(item) != null;
}

/**
 * Translate one annotation by (dx, dy) in page space, clamped so it stays on
 * the page. Returns the item unchanged when it cannot move. Used for
 * multi-selection moves and, later, for pasting with an offset.
 */
export function translateAnnotation(item, dx, dy, bounds) {
  if (!isMovable(item)) return item;
  const ax = finite(dx) ?? 0;
  const ay = finite(dy) ?? 0;
  switch (item.type) {
    case ANNOTATION_TYPES.RECT:
    case ANNOTATION_TYPES.ELLIPSE:
    case ANNOTATION_TYPES.TEXTBOX:
    case ANNOTATION_TYPES.CALLOUT:
    case ANNOTATION_TYPES.TEXT_REPLACE: {
      const moved = moveRect(item, ax, ay, bounds);
      const out = { ...item, ...moved };
      if (item.type === ANNOTATION_TYPES.CALLOUT && point(item.leader)) {
        out.leader = clampPointToPage(
          { x: item.leader.x + (moved.x - item.x), y: item.leader.y + (moved.y - item.y) },
          bounds
        );
      }
      return out;
    }
    case ANNOTATION_TYPES.TYPEWRITER:
    case ANNOTATION_TYPES.STICKY: {
      const p = clampPointToPage({ x: item.x + ax, y: item.y + ay }, bounds);
      return { ...item, x: p.x, y: p.y };
    }
    case ANNOTATION_TYPES.ARROW:
    case ANNOTATION_TYPES.LINE:
      return { ...item, ...moveSegment(item, ax, ay, bounds) };
    case ANNOTATION_TYPES.PEN:
    case ANNOTATION_TYPES.FREEHAND_HIGHLIGHT:
    case ANNOTATION_TYPES.POLYLINE: {
      // Shift the whole path by the largest step that keeps every point on
      // the page, so the stroke keeps its shape at the edge.
      const b = safeBounds(bounds);
      const pts = item.pts;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      let sx = ax;
      let sy = ay;
      if (Math.max(...xs) + sx > b.width) sx = b.width - Math.max(...xs);
      if (Math.min(...xs) + sx < 0) sx = -Math.min(...xs);
      if (Math.max(...ys) + sy > b.height) sy = b.height - Math.max(...ys);
      if (Math.min(...ys) + sy < 0) sy = -Math.min(...ys);
      return { ...item, pts: pts.map((p) => ({ x: p.x + sx, y: p.y + sy })) };
    }
    case ANNOTATION_TYPES.HIGHLIGHT:
    case ANNOTATION_TYPES.UNDERLINE:
    case ANNOTATION_TYPES.STRIKE: {
      const moved = moveSegment(
        { x1: item.x0, y1: item.y0, x2: item.x1, y2: item.y1 },
        ax,
        ay,
        bounds
      );
      return { ...item, x0: moved.x1, y0: moved.y1, x1: moved.x2, y1: moved.y2 };
    }
    default:
      return item;
  }
}

/* -------------------------------------------------------------------------- */
/* Arrowhead geometry (shared by the editor overlay and the export)           */
/* -------------------------------------------------------------------------- */

const ARROW_HEAD_SPREAD = Math.PI / 7;

/** Head length for a given stroke width — one definition, both renderers. */
export function arrowHeadSize(strokeWidth) {
  return Math.max(6, (positive(strokeWidth) ?? 2) * 4);
}

/**
 * The two barb endpoints of an arrowhead pointing from `from` to `tip`.
 * The editor draws these as SVG lines and the export draws the same two lines
 * in PDF user space, so the on-screen and exported arrowheads match.
 */
export function arrowHeadPoints(from, tip, size, spread = ARROW_HEAD_SPREAD) {
  const f = point(from) || { x: 0, y: 0 };
  const t = point(tip) || { x: 0, y: 0 };
  const angle = Math.atan2(t.y - f.y, t.x - f.x);
  const len = positive(size) ?? 6;
  return [
    { x: t.x - len * Math.cos(angle - spread), y: t.y - len * Math.sin(angle - spread) },
    { x: t.x - len * Math.cos(angle + spread), y: t.y - len * Math.sin(angle + spread) },
  ];
}
