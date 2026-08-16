// src/lib/editorMediaLayout.js
//
// THE LAYOUT VOCABULARY OF THE SHARED NOTEWISE EDITOR MEDIA CORE.
//
// This module is the single authority for what a media node's presentation
// attributes may hold — the layout mode/side vocabulary, the width-percentage
// rule, and the class/style derivation future consumers (the NodeView and the
// export path) will read. Because both sides derive their presentation from
// the same functions here, the editor and an export can never disagree about
// what a stored layout means.
//
// Decision record: docs/PROJECT_DECISIONS.md → "Shared NoteWise Editor Core"
// (2026-08-14). This foundation is shared by the Free-form editor and the
// future per-Section Template editor; nothing in it may be surface-specific.
//
// ---------------------------------------------------------------------------
// THE MODEL, AND WHY IT IS OPEN
// ---------------------------------------------------------------------------
//
//   widthPct     15–100 (the existing photo width rule), or null. Null means
//                "no stored width" — the legacy rendering (intrinsic size,
//                max-width: 100%) that every image written before this
//                vocabulary existed still gets.
//
//   layout mode  an OPEN vocabulary, currently `block` and `wrap`. A mode this
//                build does not recognise normalizes to `block` — a future
//                document degrades to safe stacked placement rather than
//                breaking, and an old document (no mode at all) means `block`
//                by definition.
//
//   layout side  `left` | `right`, meaningful ONLY for `wrap`. A wrap with no
//                usable side is not renderable as a wrap, so it degrades to
//                `block` as one unit — mode and side are normalized TOGETHER,
//                never trusted separately.
//
// Extending the model later means adding a mode token (and only the attributes
// that mode actually renders), not reshaping what is already stored.
//
// Pure: no DOM, no React, no storage, no editor.

import { MAX_PHOTO_WIDTH_PCT, MIN_PHOTO_WIDTH_PCT, clampWidthPct } from "./noteAttachments";

/** The serialized attribute names — owned here, emitted only by the image serializer. */
export const MEDIA_WIDTH_PCT_ATTR = "data-width-pct";
export const MEDIA_LAYOUT_MODE_ATTR = "data-layout-mode";
export const MEDIA_LAYOUT_SIDE_ATTR = "data-layout-side";

export const MEDIA_LAYOUT_MODE = {
  BLOCK: "block",
  WRAP: "wrap",
};

export const MEDIA_LAYOUT_SIDE = {
  LEFT: "left",
  RIGHT: "right",
};

/** Every mode this build can render, in a stable order. */
export const MEDIA_LAYOUT_MODES = [MEDIA_LAYOUT_MODE.BLOCK, MEDIA_LAYOUT_MODE.WRAP];
export const MEDIA_LAYOUT_SIDES = [MEDIA_LAYOUT_SIDE.LEFT, MEDIA_LAYOUT_SIDE.RIGHT];

/** The model's own width bounds, re-stated once so consumers never hard-code them. */
export const MEDIA_MIN_WIDTH_PCT = MIN_PHOTO_WIDTH_PCT;
export const MEDIA_MAX_WIDTH_PCT = MAX_PHOTO_WIDTH_PCT;

function token(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  return t || null;
}

/**
 * A stored/parsed width percentage → a whole point within 15–100, or null.
 *
 * Null (not a default width) is the answer for anything that is not a finite
 * number, because "no stored width" must keep meaning "legacy rendering". An
 * out-of-range NUMBER is clamped rather than dropped — the user chose a width,
 * and the nearest width the model allows is closer to their intent than
 * silently losing it.
 */
export function normalizeMediaWidthPct(value) {
  // Only a number or a numeric string can describe a width. Anything else —
  // including an array, whose Number() coercion is a well-known 0 — is null.
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(clampWidthPct(n));
}

/** A mode token → a member of the open vocabulary, else `block`. */
export function normalizeMediaLayoutMode(value) {
  const t = token(value);
  return MEDIA_LAYOUT_MODES.includes(t) ? t : MEDIA_LAYOUT_MODE.BLOCK;
}

/** A side token → `left` | `right`, else null. */
export function normalizeMediaLayoutSide(value) {
  const t = token(value);
  return MEDIA_LAYOUT_SIDES.includes(t) ? t : null;
}

/**
 * Normalize a (mode, side) pair AS ONE UNIT.
 *
 * `{ mode: "block" }` is the universal fallback: unknown mode, missing mode,
 * and a wrap without a usable side all land there. `side` is null for block —
 * it is not meaningful, so it is not carried.
 */
export function normalizeMediaLayout({ mode, side } = {}) {
  const m = normalizeMediaLayoutMode(mode);
  if (m === MEDIA_LAYOUT_MODE.WRAP) {
    const s = normalizeMediaLayoutSide(side);
    if (s) return { mode: m, side: s };
    return { mode: MEDIA_LAYOUT_MODE.BLOCK, side: null };
  }
  return { mode: MEDIA_LAYOUT_MODE.BLOCK, side: null };
}

/** True when this layout is the default the serializer may omit entirely. */
export function isDefaultMediaLayout(layout) {
  const l = normalizeMediaLayout(layout || {});
  return l.mode === MEDIA_LAYOUT_MODE.BLOCK;
}

// ---------------------------------------------------------------------------
// Presentation derivation — the ONE mapping from stored attributes to how a
// consumer presents them. Classes carry the layout (so a stylesheet owns the
// actual float/clear rules); the inline style carries only the width.
// ---------------------------------------------------------------------------

export const MEDIA_CLASS = "nw-media";

/**
 * THE SHARED EDITOR ROOT MARKER (Phase F2).
 *
 * The class a shared-core editor's OWN root element carries — the contenteditable
 * root Tiptap mounts on, exactly like `.note-editor` was until now. It exists so
 * `.nw-media*` interaction chrome (and any future shared editor UI) can be
 * styled ONCE, against this one class, instead of being duplicated per surface.
 *
 * Free-form's root carries BOTH `.note-editor` and this class — `.note-editor`
 * for its own document typography (headings, lists, tables, blockquotes, code,
 * links — none of which a restrained Template Section editor will ever have),
 * this class for the shared media/file chrome. A future Template Section editor
 * root carries ONLY this class: it is never `.note-editor` and must never look
 * like the Free-form document surface, so its own document typography styling
 * (typography inside `.note-editor`-scoped rules) never leaks onto it.
 *
 * CRITICAL — dark-theme scoping. Every `.dark` OVERRIDE of shared chrome stays
 * qualified by `.note-editor` (e.g. `.dark .note-editor .nw-media--selected`),
 * never bare `.dark .nw-editor-root`. The Template paper is white in BOTH app
 * themes (see docs/ARCHITECTURE.md → Page-aware document layout); a Section
 * editor root, carrying this class but never `.note-editor`, can therefore
 * NEVER match a `.dark .note-editor …` override however the app theme is set —
 * it always renders the light/base chrome its white paper needs. Only
 * Free-form's root, which carries both classes, ever sees the dark override.
 */
export const MEDIA_EDITOR_ROOT_CLASS = "nw-editor-root";

/**
 * THE SHARED STATIC MEDIA ROOT MARKER (Phase F3).
 *
 * The class a NON-editor surface carries when it renders the same media
 * PRESENTATION — today the static Template Section document view
 * (src/components/template/TemplateSectionDocView.js), which shows a Section's
 * images exactly as the editor would while nobody is editing it.
 *
 * It scopes the PRESENTATION half of the shared media CSS only: layout (block /
 * wrap-left / wrap-right), the stored-width sizing rule, the loading and
 * unavailable placeholders, and float containment. It deliberately does NOT
 * scope any interaction chrome — the selection ring, the corner handles, the
 * controls, the drop indicator and the drag ghost stay `.nw-editor-root`-only,
 * because a static view has none of them and must never be able to show one.
 *
 * Like the editor marker, it is never `.note-editor`, so it can never match a
 * `.dark .note-editor …` override and always renders the light presentation the
 * white Template paper needs.
 */
export const MEDIA_DOC_ROOT_CLASS = "nw-doc-root";

/** The class list a media wrapper renders for a layout. Always includes the base class. */
export function mediaLayoutClassNames(layout) {
  const l = normalizeMediaLayout(layout || {});
  if (l.mode === MEDIA_LAYOUT_MODE.WRAP) {
    return [MEDIA_CLASS, `${MEDIA_CLASS}--wrap`, `${MEDIA_CLASS}--wrap-${l.side}`];
  }
  return [MEDIA_CLASS, `${MEDIA_CLASS}--block`];
}

/**
 * The inline style a stored width produces — `{ width: "45%" }` — or null when
 * there is no stored width, so a legacy image keeps its legacy rendering with
 * no style attribute at all.
 */
export function mediaWidthStyle(widthPct) {
  const pct = normalizeMediaWidthPct(widthPct);
  return pct === null ? null : { width: `${pct}%` };
}

/**
 * The float rules an EXPORTED document needs to render wrapped media — the one
 * derivation both the standalone HTML export and the PDF capture stylesheet
 * read, so a wrap can never mean different things in different files.
 *
 * Serialized note HTML carries the layout as the `data-layout-*` attributes on
 * a bare `<img>` (there is no NodeView wrapper outside the editor), so these
 * rules key off exactly the attributes the serializer emits. Every selector is
 * prefixed with the caller's scope, so an export stylesheet can keep its
 * "nothing unscoped" guarantee. An image with no layout attributes — every
 * document written before wrap existed — matches only the clear rule, which
 * is a no-op in a float-free document; its rendering is untouched.
 *
 * The caller remains responsible for float CONTAINMENT (a `display: flow-root`
 * formatting context around the flow), which is a property of the surrounding
 * markup, not of the image. No `clear` rule is emitted for other images:
 * export stylesheets render every image `inline-block` (on which `clear` has
 * no effect anyway), and forcing them `block` to make one clear rule work
 * would break genuinely inline legacy images out of their text lines.
 */
export function mediaWrapExportCss(scope) {
  const s = typeof scope === "string" ? scope.trim() : "";
  const at = (side) =>
    `${s} img[${MEDIA_LAYOUT_MODE_ATTR}="${MEDIA_LAYOUT_MODE.WRAP}"][${MEDIA_LAYOUT_SIDE_ATTR}="${side}"]`;
  return `
    ${at(MEDIA_LAYOUT_SIDE.LEFT)} { float: left; margin: 4px 16px 8px 0; }
    ${at(MEDIA_LAYOUT_SIDE.RIGHT)} { float: right; margin: 4px 0 8px 16px; }
  `;
}
