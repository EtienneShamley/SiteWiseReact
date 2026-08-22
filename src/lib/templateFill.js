// src/lib/templateFill.js
//
// THE CANONICAL FILL — one representation of "a surface is painted this
// colour, this opaque", shared by the document page, the table's defaults and
// every individual cell override.
//
// A FILL is `{ color: "#rrggbb", opacity: 0..100 }` and nothing else. It is a
// BACKGROUND value: it never travels to text, to a border or to a control, and
// it is never expressed as a CSS `opacity` on a container — which would fade
// the text, the images, the borders and the picker buttons sitting inside it.
// Opacity is carried in the COLOUR (an alpha channel), so only the paint is
// translucent (Template Editor A3, 2026-08-21).
//
// ---------------------------------------------------------------------------
// ABSENT IS "INHERIT", AND THAT IS THE WHOLE INHERITANCE MODEL
// ---------------------------------------------------------------------------
//
// `null` is a real, load-bearing value here: it means THIS SURFACE HAS NO
// OVERRIDE, so whatever it inherits from decides. It is not "transparent" and
// it is not "white" — `{ color: "#ffffff", opacity: 0 }` is a deliberate
// invisible fill and is a completely different stored thing.
//
//     DOCUMENT   branding.page.background*        the paper
//         |
//     TABLE      branding.table.*BackgroundColor  the label / value defaults
//         |          + .*BackgroundOpacity
//         |
//     ROW/CELL   row.labelFill, cell.fill         the individual override
//
// A cell is painted `cell.fill ?? tableDefault`, resolved at READ time. Nothing
// ever copies a default into a cell, so changing the table default moves every
// cell that has no override of its own and leaves every cell that has one
// exactly where the user put it — and "Use default" is simply storing `null`
// again, never storing a copy of the current default.
//
// ---------------------------------------------------------------------------
// ONE PAINTED LAYER PER SURFACE
// ---------------------------------------------------------------------------
//
// Inheritance is resolved in the MODEL, never by stacking two painted DOM
// layers, because a stack cannot be reproduced across export flavours: an
// exported `<td>` has one background and a Word cell has one shading colour.
// So the resolved fill of a cell is painted ONCE, over the page, over the white
// paper — and that is the identical stack on screen, in the standalone HTML, in
// the PDF, in print and (flattened, see below) in Word.
//
// ---------------------------------------------------------------------------
// DETERMINISTIC DEGRADATION
// ---------------------------------------------------------------------------
//
// Word's table shading (`w:shd w:fill`) is an OPAQUE colour — there is no alpha
// channel to carry. Rather than dropping the opacity (which would print a
// 10%-tint header as a solid slab) the fill is FLATTENED: composited over its
// real backdrop — the page fill, over white paper — into the single opaque hex
// that looks the same. The composite is plain source-over alpha blending, so it
// is deterministic and testable, and nothing is ever written back to storage:
// flattening happens at export time from the same stored `{ color, opacity }`.
//
// TRUST BOUNDARY — every colour here goes through `normalizeHexColor` (defined
// below and re-exported by src/lib/templateBranding.js under its long-standing
// name), so only `#rgb` / `#rrggbb` is ever accepted and no CSS function,
// keyword, `var()` or `url()` can reach a style declaration. Every opacity is a
// clamped finite number. The `rgba(...)` strings produced below are assembled
// from those validated parts alone — nothing stored is ever interpolated.
//
// This module deliberately imports NOTHING: it is the bottom of the colour
// stack, which is what lets templateBranding.js build on it without a cycle.

/* ---------------------------- hex primitives ----------------------------- */
//
// These live HERE, in the lowest module of the colour stack, and
// src/lib/templateBranding.js re-exports them under their long-standing names
// so every existing caller is untouched. They moved rather than being
// duplicated: a second hex validator would be a second trust boundary, and
// this module has to validate a colour before it can build one.

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// True only for a literal #rgb / #rrggbb colour. Everything else — including
// named colours, rgb()/hsl(), var(), url(), and any string carrying a ';' or
// '(' — is false, so no CSS expression can enter a style object.
export function isValidHexColor(value) {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

function expandHex(value) {
  const hex = value.trim().toLowerCase();
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

// Normalizes to lowercase 6-digit #rrggbb, or returns `fallback` when the input
// is not a valid hex colour. Never throws, never passes the raw input through.
export function normalizeHexColor(value, fallback) {
  const safeFallback = isValidHexColor(fallback) ? expandHex(fallback) : "#111111";
  if (!isValidHexColor(value)) return safeFallback;
  return expandHex(value);
}

/** Fill opacity, as a percentage. 0 = invisible, 100 = fully opaque. */
export const FILL_OPACITY = { min: 0, max: 100, default: 100 };

/**
 * WHICH SURFACE a fill override belongs to.
 *
 * The two are stored in different places for a structural reason: the value
 * cells sit on the table's shared grid and own their fills individually
 * (`cell.fill`), while the label column is ONE template-wide track, so a label
 * override is a property of the ROW (`row.labelFill`). Naming them here keeps
 * the Template Editor's selection, the renderer and the exporters using one
 * vocabulary instead of three sets of booleans.
 */
export const CELL_FILL_KIND = Object.freeze({ LABEL: "label", VALUE: "value" });

/** The colour an invalid fill colour falls back to. */
export const DEFAULT_FILL_COLOR = "#ffffff";

/** The white paper every NoteWise document is ultimately painted on. */
export const PAPER_COLOR = "#ffffff";

// Alpha is emitted at three decimal places: enough that every whole percentage
// round-trips exactly, few enough that a stored value never reaches CSS as a
// 17-digit float.
const ALPHA_DECIMALS = 3;

/**
 * Clamps a typed / dragged opacity to 0–100, rounded to a whole percent.
 *
 * The empty / null cases are rejected BEFORE coercion on purpose: `Number("")`,
 * `Number(null)` and `Number([])` are all 0, which is finite, so a plain
 * `Number()` would turn a MISSING opacity into a fully transparent fill instead
 * of restoring the opaque default. That is the same rule `clampNumber` applies
 * in src/lib/templateBranding.js, stated here because this module sits below it.
 */
export function clampFillOpacity(value) {
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return FILL_OPACITY.default;
  if (!Number.isFinite(n)) return FILL_OPACITY.default;
  return Math.round(Math.min(FILL_OPACITY.max, Math.max(FILL_OPACITY.min, n)));
}

/**
 * Read-time normalization of a stored fill.
 *
 * Returns `null` — "no override, inherit" — for absent, malformed or
 * non-object input, and for an object whose colour is not a valid hex colour.
 * A fill is never invented and never repaired into an arbitrary colour: an
 * unreadable override simply is not one.
 *
 * A MISSING opacity is 100 (a plain colour is an opaque fill, which is what
 * every colour in this product meant before opacity existed); a present but
 * malformed one is clamped, never dropped.
 */
export function normalizeFill(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!isValidHexColor(raw.color)) return null;
  return {
    color: normalizeHexColor(raw.color, DEFAULT_FILL_COLOR),
    opacity:
      raw.opacity === undefined || raw.opacity === null
        ? FILL_OPACITY.default
        : clampFillOpacity(raw.opacity),
  };
}

/** Build a fill from a colour and an opacity, both validated. Never null. */
export function makeFill(color, opacity = FILL_OPACITY.default) {
  return {
    color: normalizeHexColor(color, DEFAULT_FILL_COLOR),
    opacity: clampFillOpacity(opacity),
  };
}

/** True when two fills (either of which may be `null`) mean the same thing. */
export function fillsEqual(a, b) {
  const left = normalizeFill(a);
  const right = normalizeFill(b);
  if (!left || !right) return !left && !right;
  return left.color === right.color && left.opacity === right.opacity;
}

/**
 * The first real override in an inheritance chain, or `null`.
 *
 * Written as a chain rather than as nested `??` at the call sites so the
 * ownership order is stated once: the most specific surface that has an
 * override wins, and a surface with none is skipped entirely.
 */
export function resolveFill(...candidates) {
  for (const candidate of candidates) {
    const fill = normalizeFill(candidate);
    if (fill) return fill;
  }
  return null;
}

function channels(hex) {
  const value = normalizeHexColor(hex, DEFAULT_FILL_COLOR);
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function toHex(n) {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return clamped.toString(16).padStart(2, "0");
}

/**
 * The CSS background value for a fill, or `null` for no fill at all.
 *
 * A fully opaque fill is emitted as the plain hex colour it always was, so a
 * template that has never touched opacity produces byte-identical output on
 * every surface. Anything less is an `rgba()` built from validated integers.
 */
export function fillCss(fill) {
  const f = normalizeFill(fill);
  if (!f) return null;
  if (f.opacity >= FILL_OPACITY.max) return f.color;
  const [r, g, b] = channels(f.color);
  const factor = 10 ** ALPHA_DECIMALS;
  const alpha = Math.round((f.opacity / 100) * factor) / factor;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Composite one fill over an opaque backdrop, returning an opaque `#rrggbb`.
 *
 * Plain source-over blending: `out = fill * a + backdrop * (1 - a)`. A `null`
 * fill leaves the backdrop untouched, a 0% fill is invisible and a 100% fill
 * replaces the backdrop exactly — so the three opacity cases the product cares
 * about are all the same one line of arithmetic.
 */
export function compositeFill(fill, backdrop = PAPER_COLOR) {
  const base = normalizeHexColor(backdrop, PAPER_COLOR);
  const f = normalizeFill(fill);
  if (!f) return base;
  const alpha = f.opacity / 100;
  if (alpha >= 1) return f.color;
  const [fr, fg, fb] = channels(f.color);
  const [br, bg, bb] = channels(base);
  return `#${toHex(fr * alpha + br * (1 - alpha))}${toHex(
    fg * alpha + bg * (1 - alpha)
  )}${toHex(fb * alpha + bb * (1 - alpha))}`;
}

/**
 * Flatten a whole stack of fills onto the paper, bottom-first.
 *
 * `flattenFills([pageFill, cellFill])` is what a Word cell's shading colour is:
 * the one opaque colour that looks like the layered document does. Entries that
 * are `null` contribute nothing, which is exactly what "no override" means.
 */
export function flattenFills(fills, paper = PAPER_COLOR) {
  let out = normalizeHexColor(paper, PAPER_COLOR);
  for (const fill of Array.isArray(fills) ? fills : []) {
    out = compositeFill(fill, out);
  }
  return out;
}

/**
 * The fill as it should be STORED, or `null`.
 *
 * `null` for "no override" is what keeps a template that has never been
 * recoloured publishing exactly the bytes it always did — the key is simply
 * absent, and its absence already means "inherit".
 */
export function storedFill(fill) {
  const f = normalizeFill(fill);
  return f ? { color: f.color, opacity: f.opacity } : null;
}
