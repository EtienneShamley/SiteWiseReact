// src/lib/boundedNumberInput.js
//
// THE EDITING RULE OF A BOUNDED NUMERIC FIELD (percentages, millimetres,
// pixels) in the Template Editor — pure, so the field component is a thin
// shell around it.
//
// Root cause it fixes: the previous numeric fields were fully controlled and
// forwarded `Number(e.target.value)` on every keystroke. `Number("")` is 0, so
// clearing the field to type a new value committed 0, the model clamped it to
// the range minimum, and the field snapped to that minimum before the user
// could type — the "cannot cleanly replace 0" defect.
//
//   while typing   the field shows exactly what was typed. A parseable value
//                  is applied LIVE (clamped by the model, so the document
//                  follows the keystrokes) but the field text is NOT rewritten
//                  from the clamped value while it has focus; empty or partial
//                  input applies nothing.
//   on commit      (blur / Enter) the text is resolved: a parseable value is
//                  clamped and applied, anything else reverts to the last
//                  applied value. Escape reverts without applying.
//
// Every value that leaves here is finite and inside [min, max]; a malformed
// value can never reach the model, and never breaks a layout.

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
 * The value to apply LIVE for the current text, or null when nothing should
 * be applied yet (empty / partial input).
 */
export function liveBoundedNumber(text, limits, decimals = 1) {
  const n = parseBoundedNumberText(text);
  if (n === null) return null;
  return clampBoundedNumber(n, limits, decimals);
}

/**
 * The value to COMMIT on blur / Enter: the clamped parsed value, or the last
 * applied value when the text is empty or unparseable.
 */
export function commitBoundedNumber(text, limits, lastApplied, decimals = 1) {
  const n = parseBoundedNumberText(text);
  if (n === null) return clampBoundedNumber(Number(lastApplied) || limits.min, limits, decimals);
  return clampBoundedNumber(n, limits, decimals);
}

/** The text a committed/external value is displayed as. */
export function boundedNumberText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "";
}
