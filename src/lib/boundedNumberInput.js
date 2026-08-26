// src/lib/boundedNumberInput.js
//
// THE ONE EDITING RULE OF A BOUNDED NUMERIC FIELD — Template Editor
// percentages / millimetres / pixels AND PDF annotation font sizes / stroke
// widths. Pure, so each field component is a thin shell around it.
//
// Root cause it fixes: a fully controlled field that forwards
// `Number(e.target.value)` on every keystroke turns "" into 0, the model
// clamps that to the minimum, and the field snaps before the user can type —
// so a value can never be cleared and replaced.
//
// Two INTERACTION POLICIES compose the same primitives:
//
//   Template (live)   while typing, a parseable value is applied live
//                     (`liveBoundedNumber`); empty/partial applies nothing;
//                     blur/Enter commits with a fallback to the last applied
//                     value (`commitBoundedNumber`).
//   PDF (commit-only) while typing, NOTHING is applied — the draft is local;
//                     blur/Enter resolves it (`resolveBoundedNumber`): a
//                     parseable value is clamped and applied, anything else
//                     applies nothing and the field reverts. An invalid draft
//                     therefore never reaches annotation persistence.
//
// Both step with `stepBoundedNumber`, both display with `boundedNumberText`.
// Every value that leaves here is finite and inside [min, max].

/** The number the text parses to, or null for empty / partial / non-numeric. */
export function parseBoundedNumberText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") return null;
  if (!/^-?\d*\.?\d*$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Clamps into [min, max] and rounds to the given decimals (default 1). */
export function clampBoundedNumber(n, { min, max }, decimals = 1) {
  const factor = Math.pow(10, Math.max(0, Math.floor(decimals)));
  const clamped = Math.min(max, Math.max(min, n));
  return Math.round(clamped * factor) / factor;
}

/**
 * The clamped value the text resolves to, or null when it resolves to nothing
 * (empty / partial / unparseable). The fallback-free primitive: the caller
 * decides what null means — "apply nothing yet" (live) or "revert" (commit).
 */
export function resolveBoundedNumber(text, limits, decimals = 1) {
  const n = parseBoundedNumberText(text);
  if (n === null) return null;
  return clampBoundedNumber(n, limits, decimals);
}

/**
 * The value to apply LIVE for the current text, or null when nothing should
 * be applied yet. The Template policy's name for `resolveBoundedNumber`.
 */
export const liveBoundedNumber = resolveBoundedNumber;

/**
 * The value to COMMIT on blur / Enter WITH a fallback: the clamped parsed
 * value, or the last applied value (or the minimum) when the text is empty
 * or unparseable. Never null — the Template model always holds a number.
 */
export function commitBoundedNumber(text, limits, lastApplied, decimals = 1) {
  const n = resolveBoundedNumber(text, limits, decimals);
  if (n !== null) return n;
  return clampBoundedNumber(Number(lastApplied) || limits.min, limits, decimals);
}

/**
 * `current` stepped by `direction × step` (ArrowUp = +1, ArrowDown = −1),
 * clamped and rounded. A missing current value steps from the minimum.
 */
export function stepBoundedNumber(current, direction, limits, step = 1, decimals = 1) {
  const base = Number.isFinite(Number(current)) && current !== null && current !== undefined && current !== ""
    ? Number(current)
    : limits.min;
  const size = Number.isFinite(step) && step > 0 ? step : 1;
  return clampBoundedNumber(base + (direction < 0 ? -size : size), limits, decimals);
}

/** The text a committed/external value is displayed as. */
export function boundedNumberText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "";
}
