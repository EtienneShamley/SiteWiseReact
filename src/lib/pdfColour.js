// src/lib/pdfColour.js
//
// The one canonical colour representation for PDF annotations: a six-digit
// lowercase-insensitive hex string ("#RRGGBB"), or the model's NO_FILL token.
// The visual picker, the swatch grid, the hex field, the overlay renderer and
// the pdf-lib export all agree on this — a native <input type="color"> can
// only emit/accept #rrggbb, and the export's hexToRgb01 only reads six digits.
import { NO_FILL } from "./pdfAnnotationModel";

/** The swatch palette shared by every colour control in the PDF ribbon. */
export const PDF_COLOUR_SWATCHES = [
  "#111111",
  "#333333",
  "#9E9E9E",
  "#FFFFFF",
  "#FFF59D",
  "#FFECB3",
  "#FFD54F",
  "#FF9800",
  "#C8E6C9",
  "#A5D6A7",
  "#43A047",
  "#BBDEFB",
  "#90CAF9",
  "#1976D2",
  "#F48FB1",
  "#E53935",
  "#8E24AA",
];

const HEX6 = /^#?([0-9a-f]{6})$/i;
const HEX3 = /^#?([0-9a-f]{3})$/i;

/**
 * Normalize user or stored input to "#RRGGBB" (uppercase digits), or null when
 * it is not a hex colour. Accepts "#abc", "abc", "#aabbcc", "aabbcc" and
 * surrounding whitespace; rejects everything else (names, rgb(), URLs).
 */
export function normalizeHexColour(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  let m = HEX6.exec(s);
  if (m) return `#${m[1].toUpperCase()}`;
  m = HEX3.exec(s);
  if (m) {
    const [r, g, b] = m[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return null;
}

/** True for a value that means "no colour / no fill". */
export function isNoColour(value) {
  return value == null || value === "" || value === NO_FILL || value === "none";
}

/**
 * The value a native colour input can display for a stored colour: the hex
 * itself, or `fallback` for NO_FILL / unreadable values.
 */
export function pickerValue(value, fallback = "#000000") {
  return normalizeHexColour(value) || fallback;
}

/**
 * Whether text drawn on `hex` should be dark, so a swatch label stays legible.
 * Uses relative luminance of the sRGB value.
 */
export function isLightColour(hex) {
  const h = normalizeHexColour(hex);
  if (!h) return true;
  const r = parseInt(h.slice(1, 3), 16) / 255;
  const g = parseInt(h.slice(3, 5), 16) / 255;
  const b = parseInt(h.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}
