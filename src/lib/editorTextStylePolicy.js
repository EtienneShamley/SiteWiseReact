// src/lib/editorTextStylePolicy.js
//
// THE SHARED FONT POLICY of the NoteWise editor core: which font families and
// font sizes a document may CARRY, and the one canonical form each is stored
// and rendered in.
//
// The toolbar offers the choices in src/constants/editorOptions.js. This module
// is the other half of that fact: whatever arrives at a persistence or render
// boundary — a Tiptap `textStyle` mark serialized to `style="font-family: …;
// font-size: …"`, a pasted Word/Google-Docs span, a hand-edited stored value —
// is reduced to EXACTLY one of the approved families and to one bounded integer
// pixel size, or it is dropped. No raw CSS string is ever carried across.
//
//   font family  → the approved entry's own `value` (so a stored document and
//                  the toolbar's option list can never disagree about what
//                  "Times New Roman" means), matched on the FIRST family name
//                  case-insensitively with quotes ignored;
//   font size    → `"<n>px"`, an integer between FONT_SIZE_MIN_PX and
//                  FONT_SIZE_MAX_PX. `pt` is converted (Word paste), `px`
//                  is rounded, anything else is rejected.
//
// Used by the Template rich-text model's sanitization boundary
// (src/lib/templateRichText.js) at every read/write of a Section document. The
// Free-form note keeps its own historical storage behaviour (raw Tiptap HTML);
// its toolbar draws from the same option constants, so the two surfaces offer
// the same choices.
//
// Pure: no DOM, no editor, no React.

import { FONT_FAMILIES, FONT_SIZES } from "../constants/editorOptions";

export const FONT_SIZE_MIN_PX = 6;
export const FONT_SIZE_MAX_PX = 96;

/** The bare first family name of a CSS font-family list, lower-cased. */
function firstFamilyName(value) {
  if (typeof value !== "string") return "";
  const first = value.split(",")[0] || "";
  return first.trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

const FAMILY_BY_NAME = new Map(
  FONT_FAMILIES.map((entry) => [firstFamilyName(entry.value), entry.value])
);

/**
 * The approved canonical font-family value for a stored/pasted value, or null.
 *
 * `'Times New Roman', serif`, `"Times New Roman", serif`, `Times New Roman`
 * and `times new roman, Georgia` all normalize to the ONE approved value.
 */
export function normalizeFontFamily(value) {
  const name = firstFamilyName(value);
  if (!name) return null;
  return FAMILY_BY_NAME.get(name) || null;
}

/** The approved canonical `"<n>px"` for a stored/pasted font size, or null. */
export function normalizeFontSize(value) {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px|pt)\s*$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const px = Math.round(match[2].toLowerCase() === "pt" ? (n * 4) / 3 : n);
  if (px < FONT_SIZE_MIN_PX || px > FONT_SIZE_MAX_PX) return null;
  return `${px}px`;
}

/** True when the value is one of the toolbar's own size options. */
export function isToolbarFontSize(value) {
  return FONT_SIZES.some((entry) => entry.value === value);
}
