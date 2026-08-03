// src/lib/noteCustomRows.js
//
// Note-specific custom rows: the pure model for a section a person adds while
// COMPLETING a template note, when the company template did not anticipate it.
//
// Ownership boundary (see docs/PROJECT_DECISIONS.md):
//   - A custom row belongs to ONE note's NoteTemplateInstance and to the
//     template that was pinned when it was created (`templateId`). It is never
//     written to a TemplateVersion, never publishes a version, and never
//     appears in another note using the same template.
//   - Switching a note to another template hides that template's custom rows
//     (they are filtered by `templateId`); switching back shows them again with
//     their labels, answers, heights and placement intact.
//
// This module is pure and framework-agnostic (no storage, no React) so the
// ordering and fallback rules can be unit-tested directly. Nothing here derives
// or stores page numbers — pagination remains derived at render time.

import { newId } from "./id";
import { FIELD_TYPE } from "./templateFields";
import { isAnswerValue } from "./templateRichText";

// Custom rows are Text-only in this phase: the point is to add a project
// specific observation quickly, not to expose the field-type designer.
export const CUSTOM_ROW_TYPE = FIELD_TYPE.TEXT;
export const CUSTOM_ROW_DEFAULT_HEIGHT_PX = 96;
export const CUSTOM_ROW_MIN_HEIGHT_PX = 48;
export const CUSTOM_ROW_DEFAULT_LABEL = "New section";

export const PLACEMENT = { ABOVE: "above", BELOW: "below" };

// Reported (never stored) reason a custom row could not be placed at its
// recorded anchor and was moved to the end of the document instead.
export const FALLBACK_REASON = { MISSING_ANCHOR: "missing-anchor" };

export function normalizePosition(position) {
  return position === PLACEMENT.ABOVE ? PLACEMENT.ABOVE : PLACEMENT.BELOW;
}

// Creates a brand-new custom row — the only place a custom-row id is minted.
export function makeCustomRow({
  templateId = null,
  anchorFieldId = null,
  position = PLACEMENT.BELOW,
  label = CUSTOM_ROW_DEFAULT_LABEL,
  now = Date.now(),
} = {}) {
  return {
    id: newId(),
    templateId: templateId ?? null,
    label,
    type: CUSTOM_ROW_TYPE,
    answer: "",
    preferredHeight: CUSTOM_ROW_DEFAULT_HEIGHT_PX,
    placement: {
      anchorFieldId: anchorFieldId ?? null,
      position: normalizePosition(position),
    },
    createdAt: now,
    updatedAt: now,
  };
}

// Read-time normalization: supplies safe defaults for a stored row without
// rewriting storage. A row without an id is unusable (its answer could not be
// addressed) and is dropped from RENDERING only — the stored array is not
// rewritten by this function.
export function normalizeCustomRow(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) {
    return null;
  }
  const placement = raw.placement && typeof raw.placement === "object" ? raw.placement : {};
  const preferred = Number(raw.preferredHeight);
  return {
    id: raw.id,
    templateId: raw.templateId ?? null,
    label: typeof raw.label === "string" ? raw.label : "",
    // Text-only in this phase; any other stored type still renders as Text.
    type: CUSTOM_ROW_TYPE,
    // A custom row's answer is a Template Text answer: EITHER a plain string
    // (legacy and ordinary unformatted text) OR a tagged `richtext/1` value.
    // Both are recognised through the one existing value boundary
    // (src/lib/templateRichText.js) — the shape is what decides, never what a
    // string happens to contain, so a legacy answer reading `<b>x</b>` stays
    // literal characters. Anything else (a number, a boolean, a malformed
    // tagged object) is not an answer and reads as empty; it is NEVER coerced
    // into rich text. Read-time only: nothing here rewrites stored data.
    answer: isAnswerValue(raw.answer) ? raw.answer : "",
    preferredHeight:
      Number.isFinite(preferred) && preferred > 0
        ? Math.max(CUSTOM_ROW_MIN_HEIGHT_PX, preferred)
        : CUSTOM_ROW_DEFAULT_HEIGHT_PX,
    placement: {
      anchorFieldId:
        typeof placement.anchorFieldId === "string" && placement.anchorFieldId
          ? placement.anchorFieldId
          : null,
      position: normalizePosition(placement.position),
    },
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

export function normalizeCustomRows(list) {
  return (Array.isArray(list) ? list : [])
    .map((r) => normalizeCustomRow(r))
    .filter((r) => r !== null);
}

// The custom rows belonging to one template. `null`/absent templateId matches
// a note with no template assigned, so a row can never leak across templates.
export function customRowsForTemplate(list, templateId) {
  const wanted = templateId ?? null;
  return normalizeCustomRows(list).filter((r) => (r.templateId ?? null) === wanted);
}

// Appends a new custom row. Array order IS creation order and is what keeps
// multiple rows sharing one anchor in a stable, predictable sequence.
export function insertCustomRow(list, spec) {
  const rows = Array.isArray(list) ? list.slice() : [];
  const row = makeCustomRow(spec);
  rows.push(row);
  return { rows, row };
}

export function updateCustomRow(list, id, patch, now = Date.now()) {
  return (Array.isArray(list) ? list : []).map((r) =>
    r && r.id === id ? { ...r, ...patch, updatedAt: now } : r
  );
}

// Deletes a custom row and RE-ANCHORS any row anchored to it onto the deleted
// row's own anchor, so a surviving row keeps its place in the document instead
// of being flung to the end.
export function deleteCustomRow(list, id, now = Date.now()) {
  const rows = Array.isArray(list) ? list : [];
  const removed = rows.find((r) => r && r.id === id) || null;
  const inherited = removed?.placement || { anchorFieldId: null, position: PLACEMENT.BELOW };
  return rows
    .filter((r) => r && r.id !== id)
    .map((r) =>
      r.placement?.anchorFieldId === id
        ? {
            ...r,
            placement: {
              anchorFieldId: inherited.anchorFieldId ?? null,
              position: normalizePosition(inherited.position),
            },
            updatedAt: now,
          }
        : r
    );
}

// The renderable row shape, matching the template row shape the two-column
// table already renders (`{ id, label, px, minPx, type, options }`) plus the
// `isCustom` marker that selects note-specific actions and persistence.
export function toRenderRow(customRow) {
  return {
    id: customRow.id,
    label: customRow.label,
    px: customRow.preferredHeight,
    minPx: CUSTOM_ROW_MIN_HEIGHT_PX,
    type: CUSTOM_ROW_TYPE,
    options: [],
    isCustom: true,
  };
}

/**
 * Deterministic document order for a note: the pinned version's rows with the
 * note's custom rows woven in at their anchors.
 *
 * Rules:
 *   - a row anchored `below` field A renders directly after A; a row anchored
 *     `above` field B renders directly before B;
 *   - multiple rows sharing one anchor+position keep their creation (array)
 *     order;
 *   - a custom row may anchor to another custom row (resolved recursively);
 *   - a row whose anchor no longer exists — the field was removed by a newer
 *     TemplateVersion, or the anchor row was deleted — is NOT deleted and NOT
 *     rewritten: it is placed at the END of the document, in creation order,
 *     and reported in `fallbacks` so the caller can say so. An anchor cycle
 *     (only reachable via corrupted storage) is treated the same way.
 *
 * Returns `{ rows, fallbacks }` where `rows` is the ordered render list
 * (template rows passed through untouched, custom rows via `toRenderRow`) and
 * `fallbacks` is `[{ id, label, reason }]`. Nothing is persisted or mutated.
 */
export function resolveCustomRowOrder(templateRows, customRows) {
  const tRows = Array.isArray(templateRows) ? templateRows : [];
  const cRows = normalizeCustomRows(customRows);

  if (cRows.length === 0) {
    return { rows: tRows.slice(), fallbacks: [] };
  }

  const templateIds = new Set(tRows.map((r) => r && r.id));
  const customById = new Map(cRows.map((r) => [r.id, r]));

  // Classify each custom row: does its anchor chain terminate at a template
  // row (placeable), or not (fallback to the end)?
  const status = new Map();
  const classify = (id, seen) => {
    if (status.has(id)) return status.get(id);
    const row = customById.get(id);
    if (!row) return "orphan";
    if (seen.has(id)) return "orphan"; // cycle
    seen.add(id);
    const anchorId = row.placement.anchorFieldId;
    let result;
    if (anchorId && templateIds.has(anchorId)) result = "anchored";
    else if (anchorId && customById.has(anchorId)) {
      result = classify(anchorId, seen) === "anchored" ? "anchored" : "orphan";
    } else result = "orphan";
    status.set(id, result);
    return result;
  };
  for (const row of cRows) classify(row.id, new Set());

  // anchorId -> { above: [customRow], below: [customRow] }, creation order.
  const children = new Map();
  const orphans = [];
  for (const row of cRows) {
    if (status.get(row.id) !== "anchored") {
      orphans.push(row);
      continue;
    }
    const anchorId = row.placement.anchorFieldId;
    if (!children.has(anchorId)) children.set(anchorId, { above: [], below: [] });
    children.get(anchorId)[row.placement.position].push(row);
  }

  const expand = (customRow, out) => {
    const kids = children.get(customRow.id) || { above: [], below: [] };
    for (const child of kids.above) expand(child, out);
    out.push(toRenderRow(customRow));
    for (const child of kids.below) expand(child, out);
  };

  const rows = [];
  for (const templateRow of tRows) {
    const kids = children.get(templateRow && templateRow.id) || { above: [], below: [] };
    for (const child of kids.above) expand(child, rows);
    rows.push(templateRow);
    for (const child of kids.below) expand(child, rows);
  }

  const fallbacks = [];
  for (const row of orphans) {
    rows.push(toRenderRow(row));
    fallbacks.push({
      id: row.id,
      label: row.label,
      reason: FALLBACK_REASON.MISSING_ANCHOR,
    });
  }

  return { rows, fallbacks };
}
