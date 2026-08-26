// src/lib/pdfSelection.js
//
// The pure model of ANNOTATION selection in the PDF editor.
//
// One canonical selection: an ordered list of annotation ids (the last one is
// the primary — the item whose handles are shown). It is transient editor
// state: it lives in React state in PdfAnnotator, is reported upward for the
// ribbon's contextual options, and never touches the annotation records or
// storage. Every operation here is a pure function over that list plus the
// current items, so single selection, additive (Shift/Cmd) selection,
// marquee selection and the "what can I edit for this selection" summary the
// ribbon needs are all unit-testable without a DOM.
//
// Selection only ever addresses NoteWise annotations by id. The PDF's own
// printed text is never a candidate — the marquee tests annotation bounds and
// nothing else.
import { ANNOTATION_TYPES, annotationBounds, normalizeRect } from "./pdfAnnotationModel";

/** Marker for a property whose value differs across the selection. */
export const MIXED = "__mixed__";

/* ------------------------------ Membership ------------------------------ */

/** Single click: replace the selection, or with `additive` toggle membership. */
export function resolveClickSelection(selected, id, { additive = false } = {}) {
  const cur = Array.isArray(selected) ? selected : [];
  if (!id) return additive ? cur : [];
  if (!additive) return cur.length === 1 && cur[0] === id ? cur : [id];
  return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}

/** Marquee release: replace with the hits, or with `additive` union them in. */
export function resolveMarqueeSelection(selected, hitIds, { additive = false } = {}) {
  const hits = Array.isArray(hitIds) ? hitIds : [];
  if (!additive) return hits;
  const cur = Array.isArray(selected) ? selected : [];
  const out = cur.slice();
  for (const id of hits) if (!out.includes(id)) out.push(id);
  return out;
}

/** Drop ids that no longer exist (after delete/undo/reload). */
export function pruneSelection(selected, items) {
  const alive = new Set((items || []).map((it) => it?.id));
  const cur = Array.isArray(selected) ? selected : [];
  const out = cur.filter((id) => alive.has(id));
  return out.length === cur.length ? cur : out;
}

/** The primary (most recently added) selected id, or null. */
export function primaryId(selected) {
  return Array.isArray(selected) && selected.length ? selected[selected.length - 1] : null;
}

/* -------------------------------- Marquee -------------------------------- */

export function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * The page-space marquee rectangle between the pointer-down origin and the
 * current pointer position, normalized so width/height are non-negative and
 * clamped to the page. A marquee has no minimum size — a tiny one simply
 * selects nothing.
 */
export function marqueeRect(origin, current, bounds) {
  const r = normalizeRect({
    x: origin?.x ?? 0,
    y: origin?.y ?? 0,
    w: (current?.x ?? 0) - (origin?.x ?? 0),
    h: (current?.y ?? 0) - (origin?.y ?? 0),
  });
  const W = Number.isFinite(bounds?.width) ? bounds.width : Infinity;
  const H = Number.isFinite(bounds?.height) ? bounds.height : Infinity;
  const x = Math.max(0, Math.min(r.x, W));
  const y = Math.max(0, Math.min(r.y, H));
  return {
    x,
    y,
    w: Math.max(0, Math.min(r.x + r.w, W) - x),
    h: Math.max(0, Math.min(r.y + r.h, H) - y),
  };
}

/** Whether a pointer moved far enough (in screen px) to count as a drag. */
export function isDragDistance(start, current, threshold = 3) {
  return Math.hypot((current?.x ?? 0) - (start?.x ?? 0), (current?.y ?? 0) - (start?.y ?? 0)) >= threshold;
}

/**
 * Ids of the annotations on `pageNo` whose bounds intersect `rect` (page
 * space). Items with no usable geometry are never hit.
 */
export function itemsInRect(items, pageNo, rect) {
  if (!rect || rect.w <= 0 || rect.h <= 0) return [];
  const out = [];
  for (const it of items || []) {
    if (!it || it.page !== pageNo) continue;
    const b = annotationBounds(it);
    if (b && rectsIntersect(b, rect)) out.push(it.id);
  }
  return out;
}

/* ------------------------------ Capabilities ----------------------------- */

const T = ANNOTATION_TYPES;
const TEXT_FIELDS = ["textColor", "fontSize", "fontFamily", "bold", "italic"];
const BOX_FIELDS = ["stroke", "strokeWidth", "fill"];

/**
 * The editable style fields per annotation type — exactly the fields the
 * overlay renders AND the flattened export honours, so nothing the ribbon
 * offers can silently vanish on save or export.
 */
export const EDITABLE_FIELDS = Object.freeze({
  [T.TEXTBOX]: [...TEXT_FIELDS, "align", ...BOX_FIELDS],
  [T.CALLOUT]: [...TEXT_FIELDS, "align", ...BOX_FIELDS],
  [T.TYPEWRITER]: [...TEXT_FIELDS],
  [T.RECT]: [...BOX_FIELDS],
  [T.ELLIPSE]: [...BOX_FIELDS],
  [T.ARROW]: ["stroke", "strokeWidth", "head"],
  [T.LINE]: ["stroke", "strokeWidth"],
  [T.POLYLINE]: ["stroke", "strokeWidth"],
  [T.PEN]: ["stroke", "strokeWidth"],
  [T.FREEHAND_HIGHLIGHT]: ["stroke", "strokeWidth", "opacity"],
  [T.HIGHLIGHT]: ["fill", "opacity"],
  [T.UNDERLINE]: ["stroke"],
  [T.STRIKE]: ["stroke"],
  [T.STICKY]: ["color"],
});

/** What an absent field means, so the ribbon shows the rendered value. */
export const FIELD_DEFAULTS = Object.freeze({
  textColor: "#111111",
  fontSize: 14,
  bold: false,
  italic: false,
  align: "left",
  stroke: "#333333",
  strokeWidth: 2,
  fill: "transparent",
  opacity: 0.35,
  head: "single",
  color: "#FFE082",
});

/**
 * Summarize a selection for the contextual options bar.
 *
 * `fields` is the INTERSECTION of the selected types' editable fields — the
 * only properties that can safely be applied to every selected item — and
 * `values[field]` is the shared value, or MIXED when the items disagree.
 */
export function selectionSummary(items, selected) {
  const ids = Array.isArray(selected) ? selected : [];
  const byId = new Map((items || []).map((it) => [it?.id, it]));
  const picked = ids.map((id) => byId.get(id)).filter(Boolean);
  const types = [...new Set(picked.map((it) => it.type))];

  let fields = null;
  for (const type of types) {
    const f = EDITABLE_FIELDS[type] || [];
    fields = fields === null ? f.slice() : fields.filter((x) => f.includes(x));
  }
  fields = fields || [];

  const values = {};
  for (const field of fields) {
    let shared;
    let mixed = false;
    for (const it of picked) {
      const v = it[field] === undefined ? FIELD_DEFAULTS[field] : it[field];
      if (shared === undefined) shared = v;
      else if (shared !== v) {
        mixed = true;
        break;
      }
    }
    values[field] = mixed ? MIXED : shared;
  }

  return { count: picked.length, ids: picked.map((it) => it.id), types, items: picked, fields, values };
}

/** Apply a style patch to exactly the selected items; others are untouched. */
export function applyPatchToSelection(items, selected, patch) {
  const ids = new Set(Array.isArray(selected) ? selected : []);
  if (!ids.size || !patch || typeof patch !== "object") return items;
  let changed = false;
  const next = (items || []).map((it) => {
    if (!it || !ids.has(it.id)) return it;
    const allowed = EDITABLE_FIELDS[it.type] || [];
    const out = { ...it };
    let touched = false;
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.includes(key)) continue;
      if (out[key] === value) continue;
      if (value === undefined) delete out[key];
      else out[key] = value;
      touched = true;
    }
    if (!touched) return it;
    changed = true;
    return out;
  });
  return changed ? next : items;
}
