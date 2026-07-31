// src/lib/templateBranding.js
//
// Single source of truth for a TemplateVersion's optional BRANDING
// configuration: the branded document header (banner + logo placement), the
// report title block, and the two-column table's colours.
//
// This module is pure and framework-agnostic (no React, no DOM, no storage) so
// every clamp, fallback and style mapping is unit-testable in isolation, and so
// there is exactly ONE place where stored branding values become style values.
//
// TRUST BOUNDARY — everything here treats stored branding as untrusted input:
//   - Colours are accepted ONLY as #rgb / #rrggbb and are re-emitted in a
//     normalized lowercase 6-digit form. `rgb()`, `hsl()`, `var(--x)`, `url(...)`
//     and every other CSS function or keyword is rejected to its default.
//   - Every other value is either a clamped finite number or a member of a
//     small enum; an unknown value falls back to the default, it is never
//     passed through.
//   - The normalized object is built by WHITELIST, so an unknown property in
//     stored data is dropped and can never reach a style object.
//   - No arbitrary CSS string is ever stored or read back. The only CSS strings
//     produced here (the banner clip-path polygons) are constant literals
//     selected by an enum, never assembled from stored text.
// Callers render exclusively through React style objects / CSS custom
// properties; `dangerouslySetInnerHTML` is never involved.
//
// BACKWARD COMPATIBILITY — branding is additive and optional. A TemplateVersion
// published before it existed has no `branding` key, and `normalizeBranding()`
// then returns LEGACY-shaped defaults deliberately chosen to reproduce the
// PREVIOUS appearance (white paper, centred logo band of the same height, dark
// text, white cells, neutral 1px borders, no title). Opening an old template
// must not recolour it or change its pagination. Nothing here rewrites stored
// data — normalization is read-time only, exactly like normalizeRows().

/* ------------------------------- enums ---------------------------------- */

// Restrained set of header compositions. Deliberately small (see the sprint
// brief: "Do not create dozens of presets"). The reference layout — logo at the
// upper left with a brand banner filling the rest of the header — is
// LOGO_LEFT combined with an angled banner edge.
export const HEADER_LAYOUT = {
  // Logo sits in a clear zone on the left; the banner fills the space to its right.
  LOGO_LEFT: "logo-left",
  // Banner spans the whole header; the logo is placed over it.
  LOGO_OVER: "logo-over",
  // Banner is a strip along the bottom of the header; the logo sits above it.
  LOGO_ABOVE: "logo-above",
  // Banner spans the whole header; no logo is drawn.
  BANNER_ONLY: "banner-only",
};

export const HEADER_LAYOUTS = [
  { value: HEADER_LAYOUT.LOGO_LEFT, label: "Logo left, banner beside" },
  { value: HEADER_LAYOUT.LOGO_OVER, label: "Logo over banner" },
  { value: HEADER_LAYOUT.LOGO_ABOVE, label: "Logo above banner" },
  { value: HEADER_LAYOUT.BANNER_ONLY, label: "Banner only" },
];

// Shape of the banner's leading edge. Implemented with CONSTANT clip-path
// polygons (CSS geometry), never a generated image and never a path editor.
export const BANNER_SHAPE = {
  STRAIGHT: "straight",
  INSET_LEFT: "inset-left",
  ANGLED_LEFT: "angled-left",
};

export const BANNER_SHAPES = [
  { value: BANNER_SHAPE.STRAIGHT, label: "Straight" },
  { value: BANNER_SHAPE.INSET_LEFT, label: "Inset left" },
  { value: BANNER_SHAPE.ANGLED_LEFT, label: "Angled left" },
];

export const TITLE_ALIGNMENT = { LEFT: "left", CENTER: "center", RIGHT: "right" };

export const TITLE_ALIGNMENTS = [
  { value: TITLE_ALIGNMENT.LEFT, label: "Left" },
  { value: TITLE_ALIGNMENT.CENTER, label: "Centre" },
  { value: TITLE_ALIGNMENT.RIGHT, label: "Right" },
];

export const TITLE_WEIGHT = { REGULAR: "regular", BOLD: "bold" };

export const TITLE_WEIGHTS = [
  { value: TITLE_WEIGHT.REGULAR, label: "Regular" },
  { value: TITLE_WEIGHT.BOLD, label: "Bold" },
];

/* ------------------------------- limits --------------------------------- */
// Every numeric limit lives here so the Builder inputs, the clamps and the
// tests all read the same values.

// 29mm ≈ 110px at the 96dpi CSS reference density — the height of the previous
// fixed logo band, so an existing template's pagination is unchanged.
export const HEADER_HEIGHT_MM = { min: 8, max: 80, default: 29 };
export const LOGO_WIDTH_PCT = { min: 5, max: 100, default: 40 };
export const LOGO_POS_PCT = { min: 0, max: 100, default: 50 };
export const TITLE_FONT_SIZE_PT = { min: 10, max: 28, default: 16 };
export const BORDER_WIDTH_PX = { min: 0, max: 3, default: 1 };

// A report title is a heading, not a body of text. The clamp keeps a pasted
// document out of the layout; it is a sanity bound, not a security control
// (the value is rendered as an escaped React text child either way).
export const TITLE_MAX_LENGTH = 200;

// Positions the logo snaps to while being dragged (flush start / centred /
// flush end, on both axes) and the tolerance in percentage points. Restrained
// on purpose: no alignment guides, no additional placement modes.
export const LOGO_SNAP_TARGETS = Object.freeze([0, 50, 100]);
export const LOGO_SNAP_THRESHOLD_PCT = 2;

// WCAG AA for normal body text. Used for a NON-BLOCKING warning only — a
// company's chosen colour is never silently changed (see the brief, §9).
export const MIN_CONTRAST_RATIO = 4.5;

/* ------------------------------ defaults -------------------------------- */

export const DEFAULT_COLORS = Object.freeze({
  banner: "#ffffff",
  title: "#111111",
  labelBackground: "#ffffff",
  labelText: "#111111",
  contentBackground: "#ffffff",
  contentText: "#111111",
  border: "#d1d5db",
});

// The defaults an ABSENT branding object resolves to. These reproduce the
// pre-branding appearance: a white document, the logo centred in a band of the
// same height as before, dark text, white cells, neutral 1px borders, and no
// title block (so no new height is consumed and nothing repaginates).
export const DEFAULT_BRANDING = Object.freeze({
  header: Object.freeze({
    enabled: true,
    heightMm: HEADER_HEIGHT_MM.default,
    backgroundColor: DEFAULT_COLORS.banner,
    layoutStyle: HEADER_LAYOUT.LOGO_ABOVE,
    bannerShape: BANNER_SHAPE.STRAIGHT,
    logo: Object.freeze({
      widthPct: LOGO_WIDTH_PCT.default,
      xPct: LOGO_POS_PCT.default,
      yPct: LOGO_POS_PCT.default,
    }),
  }),
  title: Object.freeze({
    enabled: false,
    text: "",
    color: DEFAULT_COLORS.title,
    fontSizePt: TITLE_FONT_SIZE_PT.default,
    fontWeight: TITLE_WEIGHT.BOLD,
    alignment: TITLE_ALIGNMENT.LEFT,
  }),
  table: Object.freeze({
    labelBackgroundColor: DEFAULT_COLORS.labelBackground,
    labelTextColor: DEFAULT_COLORS.labelText,
    contentBackgroundColor: DEFAULT_COLORS.contentBackground,
    contentTextColor: DEFAULT_COLORS.contentText,
    borderColor: DEFAULT_COLORS.border,
    borderWidthPx: BORDER_WIDTH_PX.default,
  }),
});

/* --------------------------- value normalizers --------------------------- */

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// True only for a literal #rgb / #rrggbb colour. Everything else — including
// named colours, rgb()/hsl(), var(), url(), and any string carrying a ';' or
// '(' — is false, so no CSS expression can enter a style object.
export function isValidHexColor(value) {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

// Normalizes to lowercase 6-digit #rrggbb, or returns `fallback` when the input
// is not a valid hex colour. Never throws, never passes the raw input through.
export function normalizeHexColor(value, fallback) {
  const safeFallback = isValidHexColor(fallback) ? expandHex(fallback) : DEFAULT_COLORS.title;
  if (!isValidHexColor(value)) return safeFallback;
  return expandHex(value);
}

function expandHex(value) {
  const hex = value.trim().toLowerCase();
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

// Clamps a finite number into [min, max]; anything that is not a real number
// falls back to `def` — including NaN, ±Infinity, null, "", "12px", booleans,
// objects and arrays.
//
// The empty/null cases are handled explicitly BEFORE any coercion on purpose:
// `Number("")`, `Number(null)` and `Number([])` are all 0, which is finite, so a
// plain Number() would silently clamp a MISSING value to the minimum of the
// range instead of restoring the default. For a header height that is the
// difference between "not configured" and "8mm tall".
export function clampNumber(value, { min, max, default: def }) {
  let n;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    n = Number(value);
  } else {
    return def;
  }
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

const HEADER_LAYOUT_VALUES = HEADER_LAYOUTS.map((l) => l.value);
const BANNER_SHAPE_VALUES = BANNER_SHAPES.map((s) => s.value);
const TITLE_ALIGNMENT_VALUES = TITLE_ALIGNMENTS.map((a) => a.value);
const TITLE_WEIGHT_VALUES = TITLE_WEIGHTS.map((w) => w.value);

/* --------------------------- branding normalizer ------------------------- */

// Read-time normalization of a stored branding object. Built by WHITELIST: the
// result contains exactly the keys below, so an unknown property in stored data
// is dropped rather than interpreted. Absent/invalid input yields
// DEFAULT_BRANDING, which reproduces the pre-branding appearance.
//
// Never mutates its argument and never rewrites storage.
export function normalizeBranding(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const header = src.header && typeof src.header === "object" ? src.header : {};
  const title = src.title && typeof src.title === "object" ? src.title : {};
  const table = src.table && typeof src.table === "object" ? src.table : {};
  const logo = header.logo && typeof header.logo === "object" ? header.logo : {};

  return {
    header: {
      enabled: normalizeBoolean(header.enabled, DEFAULT_BRANDING.header.enabled),
      heightMm: clampNumber(header.heightMm, HEADER_HEIGHT_MM),
      backgroundColor: normalizeHexColor(
        header.backgroundColor,
        DEFAULT_BRANDING.header.backgroundColor
      ),
      layoutStyle: normalizeEnum(
        header.layoutStyle,
        HEADER_LAYOUT_VALUES,
        DEFAULT_BRANDING.header.layoutStyle
      ),
      bannerShape: normalizeEnum(
        header.bannerShape,
        BANNER_SHAPE_VALUES,
        DEFAULT_BRANDING.header.bannerShape
      ),
      logo: {
        widthPct: clampNumber(logo.widthPct, LOGO_WIDTH_PCT),
        xPct: clampNumber(logo.xPct, LOGO_POS_PCT),
        yPct: clampNumber(logo.yPct, LOGO_POS_PCT),
      },
    },
    title: {
      enabled: normalizeBoolean(title.enabled, DEFAULT_BRANDING.title.enabled),
      text: normalizeTitleText(title.text),
      color: normalizeHexColor(title.color, DEFAULT_BRANDING.title.color),
      fontSizePt: clampNumber(title.fontSizePt, TITLE_FONT_SIZE_PT),
      fontWeight: normalizeEnum(
        title.fontWeight,
        TITLE_WEIGHT_VALUES,
        DEFAULT_BRANDING.title.fontWeight
      ),
      alignment: normalizeEnum(
        title.alignment,
        TITLE_ALIGNMENT_VALUES,
        DEFAULT_BRANDING.title.alignment
      ),
    },
    table: {
      labelBackgroundColor: normalizeHexColor(
        table.labelBackgroundColor,
        DEFAULT_BRANDING.table.labelBackgroundColor
      ),
      labelTextColor: normalizeHexColor(
        table.labelTextColor,
        DEFAULT_BRANDING.table.labelTextColor
      ),
      contentBackgroundColor: normalizeHexColor(
        table.contentBackgroundColor,
        DEFAULT_BRANDING.table.contentBackgroundColor
      ),
      contentTextColor: normalizeHexColor(
        table.contentTextColor,
        DEFAULT_BRANDING.table.contentTextColor
      ),
      borderColor: normalizeHexColor(
        table.borderColor,
        DEFAULT_BRANDING.table.borderColor
      ),
      borderWidthPx: Math.round(clampNumber(table.borderWidthPx, BORDER_WIDTH_PX)),
    },
  };
}

function normalizeTitleText(value) {
  if (typeof value !== "string") return DEFAULT_BRANDING.title.text;
  return value.slice(0, TITLE_MAX_LENGTH);
}

// True when the normalized branding is identical to the defaults an ABSENT
// branding object resolves to. Used by the publish comparison so a legacy
// version (no branding key) and a freshly-normalized default compare equal and
// re-saving an untouched legacy template stays a no-op.
export function isDefaultBranding(branding) {
  return (
    JSON.stringify(normalizeBranding(branding)) ===
    JSON.stringify(normalizeBranding(undefined))
  );
}

/* ------------------------- branding -> style objects ---------------------- */

// Constant clip-path polygons, selected by enum. These are literals — nothing
// stored is ever interpolated into a CSS string.
const BANNER_CLIP_PATHS = Object.freeze({
  [BANNER_SHAPE.STRAIGHT]: null,
  [BANNER_SHAPE.INSET_LEFT]: "polygon(8% 0%, 100% 0%, 100% 100%, 8% 100%)",
  [BANNER_SHAPE.ANGLED_LEFT]: "polygon(16% 0%, 100% 0%, 100% 100%, 0% 100%)",
});

// Where the banner sits inside the header box, per layout preset. Values are
// percentages of the header box; the logo is positioned independently.
const BANNER_BOX = Object.freeze({
  [HEADER_LAYOUT.LOGO_LEFT]: { left: 22, top: 0, height: 100 },
  [HEADER_LAYOUT.LOGO_OVER]: { left: 0, top: 0, height: 100 },
  [HEADER_LAYOUT.LOGO_ABOVE]: { left: 0, top: 62, height: 38 },
  [HEADER_LAYOUT.BANNER_ONLY]: { left: 0, top: 0, height: 100 },
});

// The area the logo may occupy, per layout preset (percentages of the header
// box). This is what makes the logo BOUNDED: xPct/yPct address a position
// inside this box only, never the page.
const LOGO_BOX = Object.freeze({
  [HEADER_LAYOUT.LOGO_LEFT]: { left: 0, top: 0, width: 24, height: 100 },
  [HEADER_LAYOUT.LOGO_OVER]: { left: 0, top: 0, width: 100, height: 100 },
  [HEADER_LAYOUT.LOGO_ABOVE]: { left: 0, top: 0, width: 100, height: 60 },
  [HEADER_LAYOUT.BANNER_ONLY]: null, // no logo in this preset
});

export function bannerClipPath(shape) {
  return BANNER_CLIP_PATHS[normalizeEnum(shape, BANNER_SHAPE_VALUES, BANNER_SHAPE.STRAIGHT)];
}

// True when this layout preset draws a logo at all.
export function layoutShowsLogo(layoutStyle) {
  return (
    normalizeEnum(layoutStyle, HEADER_LAYOUT_VALUES, DEFAULT_BRANDING.header.layoutStyle) !==
    HEADER_LAYOUT.BANNER_ONLY
  );
}

/**
 * Maps a branding object to the SAFE style objects the renderer applies.
 *
 * Every value in the result is either a number-derived string built here or a
 * normalized hex colour — there is no path by which a stored string reaches a
 * style property verbatim.
 *
 * The logo's position uses `left/top` percentages paired with a matching
 * negative `translate`. That makes containment STRUCTURAL rather than clamped:
 * for any xPct/yPct in 0–100 the logo is inside its box by construction
 * (0 = flush start, 50 = centred, 100 = flush end), at any zoom, on reflow, and
 * in print — with no DOM measurement involved. Only `width` is ever set, so the
 * aspect ratio can never be distorted.
 */
export function brandingStyles(rawBranding) {
  const b = normalizeBranding(rawBranding);
  const layout = b.header.layoutStyle;
  const bannerBox = BANNER_BOX[layout];
  const logoBox = LOGO_BOX[layout];
  const clipPath = bannerClipPath(b.header.bannerShape);

  return {
    header: {
      height: `${b.header.heightMm}mm`,
    },
    banner: {
      left: `${bannerBox.left}%`,
      right: 0,
      top: `${bannerBox.top}%`,
      height: `${bannerBox.height}%`,
      backgroundColor: b.header.backgroundColor,
      ...(clipPath ? { clipPath } : {}),
    },
    // The bounded region the logo may be placed within.
    logoBox: logoBox
      ? {
          left: `${logoBox.left}%`,
          top: `${logoBox.top}%`,
          width: `${logoBox.width}%`,
          height: `${logoBox.height}%`,
        }
      : null,
    logo: {
      left: `${b.header.logo.xPct}%`,
      top: `${b.header.logo.yPct}%`,
      width: `${b.header.logo.widthPct}%`,
      transform: `translate(-${b.header.logo.xPct}%, -${b.header.logo.yPct}%)`,
    },
    title: {
      color: b.title.color,
      fontSize: `${b.title.fontSizePt}pt`,
      fontWeight: b.title.fontWeight === TITLE_WEIGHT.BOLD ? 700 : 400,
      textAlign: b.title.alignment,
    },
    // CSS custom properties consumed by template.css. They cascade from the
    // wrapper above <PagedDocument> to every row on every page, so master rows,
    // note-specific custom rows and Photo/File continuation rows all inherit
    // one company style with no per-row or per-cell overrides.
    table: {
      "--nw-tpl-label-bg": b.table.labelBackgroundColor,
      "--nw-tpl-label-text": b.table.labelTextColor,
      "--nw-tpl-content-bg": b.table.contentBackgroundColor,
      "--nw-tpl-content-text": b.table.contentTextColor,
      "--nw-tpl-border-color": b.table.borderColor,
      "--nw-tpl-border-width": `${b.table.borderWidthPx}px`,
    },
  };
}

/* ------------------------------- contrast -------------------------------- */

// sRGB relative luminance (WCAG 2.x). Input must be a hex colour; anything
// invalid is treated as the default dark text so a warning is never computed
// from garbage.
export function relativeLuminance(hex) {
  const value = normalizeHexColor(hex, DEFAULT_COLORS.title);
  const channel = (pair) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = channel(value.slice(1, 3));
  const g = channel(value.slice(3, 5));
  const b = channel(value.slice(5, 7));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG contrast ratio between two colours (1 to 21).
export function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Non-blocking readability advice for the Builder. Returns one entry per colour
// pair that falls below MIN_CONTRAST_RATIO. The user's chosen colour is NEVER
// changed as a result — this only reports.
export function contrastWarnings(rawBranding) {
  const b = normalizeBranding(rawBranding);
  const pairs = [
    {
      id: "label",
      ratio: contrastRatio(b.table.labelTextColor, b.table.labelBackgroundColor),
      message: "Label text is hard to read on the label column colour",
    },
    {
      id: "content",
      ratio: contrastRatio(b.table.contentTextColor, b.table.contentBackgroundColor),
      message: "Content text is hard to read on the content cell colour",
    },
  ];
  return pairs
    .filter((p) => p.ratio < MIN_CONTRAST_RATIO)
    .map((p) => ({ id: p.id, message: p.message, ratio: Math.round(p.ratio * 100) / 100 }));
}

/* ------------------------- direct-manipulation helpers -------------------- */

// Snaps a dragged percentage to 0 / 50 / 100 when it lands within the
// threshold. Deliberately the ONLY snapping in this phase: no alignment guides,
// no additional placement modes.
export function snapLogoPct(value) {
  const clamped = clampNumber(value, LOGO_POS_PCT);
  for (const target of LOGO_SNAP_TARGETS) {
    if (Math.abs(clamped - target) <= LOGO_SNAP_THRESHOLD_PCT) return target;
  }
  return Math.round(clamped * 10) / 10;
}

// Clamps a dragged/typed logo width to the allowed range, rounded to 0.1%.
export function clampLogoWidthPct(value) {
  return Math.round(clampNumber(value, LOGO_WIDTH_PCT) * 10) / 10;
}
