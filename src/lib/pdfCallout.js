// src/lib/pdfCallout.js
//
// The Callout: ONE annotation record (`type: "callout"`) that owns a text box
// (`x, y, w, h`, text and box style) and a leader `leader: { x, y }` — the
// page-space point being called out. The leader is not a second annotation:
// it is part of the callout, so moving, copying, saving and exporting the
// callout carries it along, and nothing here changes the stored shape a P1
// (or older) document already has.
//
// Two things live in this module, both pure and DOM-free so the overlay, the
// export and the tests share exactly one definition:
//
// 1. Leader geometry — where the leader ATTACHES to the box. The attachment
//    point is derived from the box and the tip every time it is drawn (the
//    nearest of the box's edge midpoints and corners, after the box's own
//    rotation), so moving or resizing the box can never detach the leader,
//    and a leader drawn by the editor is the leader the flattened PDF gets.
//
// 2. The three-stage creation draft — click 1: the tip; click 2: the box's
//    first corner; click 3: the opposite corner, which sizes the box. The
//    draft is transient state in the annotator (page space throughout), never
//    an annotation, so Escape, a tool change or unmount can discard it
//    without leaving a half-made record behind. Only the third click builds
//    a record, through `completeCalloutDraft`.
import {
  ANNOTATION_TYPES,
  DEFAULT_FONT_FAMILY,
  NO_FILL,
  arrowHeadPoints,
  arrowHeadSize,
  clampPointToPage,
  newAnnotationBase,
  rectFromPoints,
} from "./pdfAnnotationModel";

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const point = (v) => {
  if (!v || typeof v !== "object") return null;
  const x = finite(v.x);
  const y = finite(v.y);
  return x === undefined || y === undefined ? null : { x, y };
};

/* -------------------------------------------------------------------------- */
/* Leader geometry                                                            */
/* -------------------------------------------------------------------------- */

/** Rotate a page-space point about `centre` by `deg` (SVG sense: clockwise). */
export function rotatePointDeg(p, centre, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
}

/**
 * Where a historical callout without a stored leader points. P1 rendered a
 * leader here but did not export one; both now derive from this so the
 * editor and the flattened PDF agree.
 */
export function defaultLeaderFor(item) {
  return { x: (finite(item?.x) ?? 0) - 20, y: (finite(item?.y) ?? 0) - 20 };
}

/** The leader's stroke width: the box border, or a visible hairline with No border. */
export function calloutLeaderWidth(item) {
  const w = finite(item?.strokeWidth);
  return w && w > 0 ? w : 1.5;
}

/**
 * The eight attachment candidates of an (unrotated) box — its four edge
 * midpoints and four corners — in page space after the box's rotation.
 */
export function calloutAnchorCandidates(item) {
  const x = finite(item?.x) ?? 0;
  const y = finite(item?.y) ?? 0;
  const w = Math.max(0, finite(item?.w) ?? 0);
  const h = Math.max(0, finite(item?.h) ?? 0);
  const centre = { x: x + w / 2, y: y + h / 2 };
  const rotate = finite(item?.rotate) ?? 0;
  const raw = [
    { x: x + w / 2, y }, // top
    { x: x + w, y: y + h / 2 }, // right
    { x: x + w / 2, y: y + h }, // bottom
    { x, y: y + h / 2 }, // left
    { x, y }, // nw
    { x: x + w, y }, // ne
    { x: x + w, y: y + h }, // se
    { x, y: y + h }, // sw
  ];
  return raw.map((p) => rotatePointDeg(p, centre, rotate));
}

/**
 * The complete leader geometry of a callout in page space: the `tip` (the
 * point called out, with an arrowhead), the `anchor` on the box it attaches
 * to, the arrowhead `barbs` and the stroke `width`. Returns null for a record
 * without a usable box. The overlay draws exactly this and so does the export.
 */
export function calloutLeaderGeometry(item) {
  if (!item || typeof item !== "object") return null;
  if (finite(item.x) === undefined || finite(item.y) === undefined) return null;
  const tip = point(item.leader) || defaultLeaderFor(item);
  const candidates = calloutAnchorCandidates(item);
  let anchor = candidates[0];
  let best = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - tip.x, c.y - tip.y);
    if (d < best) {
      best = d;
      anchor = c;
    }
  }
  const width = calloutLeaderWidth(item);
  const size = arrowHeadSize(width);
  // A tip sitting on its anchor has no direction; draw no head rather than a
  // head pointing along an arbitrary axis.
  const barbs = best > 0.5 ? arrowHeadPoints(anchor, tip, size) : [];
  return { tip, anchor, barbs, width, headSize: size };
}

/* -------------------------------------------------------------------------- */
/* Box sizing                                                                 */
/* -------------------------------------------------------------------------- */

/** The narrowest text box the third click can produce, in page units. */
export const CALLOUT_MIN_WIDTH = 40;

/** One line of text plus the box's 6-unit inset on each side. */
export function calloutMinHeight(fontSize) {
  const fs = finite(fontSize) && fontSize > 0 ? fontSize : 14;
  return Math.ceil(fs * 1.25 + 12);
}

/**
 * The text box between the second click (`anchor`) and the pointer/third
 * click (`p`): a normalized, page-clamped rect that is never narrower than
 * CALLOUT_MIN_WIDTH nor shorter than one text line — a third click made
 * only horizontally still yields a usable box, growing away from the anchor.
 */
export function calloutBoxFromPoints(anchor, p, bounds, fontSize) {
  const a = clampPointToPage(anchor, bounds);
  const minH = calloutMinHeight(fontSize);
  const W = finite(bounds?.width) && bounds.width > 0 ? bounds.width : Infinity;
  const H = finite(bounds?.height) && bounds.height > 0 ? bounds.height : Infinity;
  const c = clampPointToPage(p, bounds);
  // Grow the pointer corner away from the anchor until each axis meets its
  // minimum, then let rectFromPoints normalize and clamp the result.
  let tx = c.x;
  if (Math.abs(tx - a.x) < CALLOUT_MIN_WIDTH) {
    const towardsNegative = tx < a.x || (tx === a.x && a.x + CALLOUT_MIN_WIDTH > W);
    tx = towardsNegative ? a.x - CALLOUT_MIN_WIDTH : a.x + CALLOUT_MIN_WIDTH;
    if (tx < 0) tx = a.x + CALLOUT_MIN_WIDTH;
    if (tx > W) tx = a.x - CALLOUT_MIN_WIDTH;
  }
  let ty = c.y;
  if (Math.abs(ty - a.y) < minH) {
    // A horizontal-only third click sizes the box DOWN from the anchor by
    // default (the anchor is the top-left the user reads the box from),
    // falling back to upward at the bottom edge.
    const towardsNegative = ty < a.y || (ty === a.y && a.y + minH > H);
    ty = towardsNegative ? a.y - minH : a.y + minH;
    if (ty < 0) ty = a.y + minH;
    if (ty > H) ty = a.y - minH;
  }
  return rectFromPoints(a, { x: tx, y: ty }, bounds, Math.min(CALLOUT_MIN_WIDTH, minH));
}

/* -------------------------------------------------------------------------- */
/* Creation draft                                                             */
/* -------------------------------------------------------------------------- */

/** How many clicks the draft has taken: 1 = tip placed, 2 = box corner placed. */
export const CALLOUT_STAGE = Object.freeze({ TIP: 1, ANCHOR: 2 });

/** First click: the tip. */
export function startCalloutDraft(pageNo, tip, bounds) {
  return { page: pageNo, stage: CALLOUT_STAGE.TIP, tip: clampPointToPage(tip, bounds), anchor: null };
}

/** Second click: the box's first corner. Returns a new draft. */
export function placeCalloutAnchor(draft, p, bounds) {
  if (!draft || draft.stage !== CALLOUT_STAGE.TIP) return draft;
  return { ...draft, stage: CALLOUT_STAGE.ANCHOR, anchor: clampPointToPage(p, bounds) };
}

/**
 * What the overlay previews while the pointer moves: after click 1 a leader
 * from the tip to the pointer; after click 2 the provisional box and the
 * leader attached to it. Pure so the preview is testable at any zoom.
 */
export function calloutDraftPreview(draft, hover, bounds, fontSize) {
  if (!draft) return null;
  const h = point(hover);
  if (draft.stage === CALLOUT_STAGE.TIP) {
    return { stage: draft.stage, tip: draft.tip, to: h ? clampPointToPage(h, bounds) : null, box: null };
  }
  const box = calloutBoxFromPoints(draft.anchor, h || draft.anchor, bounds, fontSize);
  const geometry = calloutLeaderGeometry({ ...box, leader: draft.tip });
  return { stage: draft.stage, tip: draft.tip, to: geometry?.anchor || null, box };
}

/**
 * Third click: build the complete callout record. This is the ONLY point at
 * which a record exists; the caller adds it to the document as one history
 * entry. Returns null unless the draft has both earlier stages.
 */
export function completeCalloutDraft(draft, p, bounds, style = {}) {
  if (!draft || draft.stage !== CALLOUT_STAGE.ANCHOR || !draft.anchor || !draft.tip) return null;
  const box = calloutBoxFromPoints(draft.anchor, p, bounds, style.fontSize);
  return {
    ...newAnnotationBase(draft.page, ANNOTATION_TYPES.CALLOUT),
    ...box,
    leader: { x: draft.tip.x, y: draft.tip.y },
    text: "",
    textColor: style.textColor || "#111111",
    fontSize: style.fontSize || 14,
    fontFamily: style.fontFamily || DEFAULT_FONT_FAMILY,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.align && style.align !== "left" ? { align: style.align } : {}),
    stroke: style.stroke || "#333333",
    // 0 is a real value here: "No border" (the leader stays visible).
    strokeWidth: style.strokeWidth ?? 2,
    fill: style.fill ?? NO_FILL,
    corner: 8,
  };
}
