// src/pdf/pdfTools.js
//
// The ONE definition of the PDF editor's tools: their ids, how each creates
// an annotation (drag, click-to-place, or text selection), and the style each
// tool starts new annotations with. Both the ribbon (PdfEditorTab) and the
// overlay (PdfAnnotator) import from here — previously each carried its own
// copy of the tool enum.
//
// Tool STYLE is session state owned by the ribbon: the options a user sets for
// a tool are remembered for the next annotation of that kind until the editor
// is closed. It is never persisted and never written into an existing
// annotation — editing a selected annotation goes through
// PdfAnnotator.applyToSelection instead.
import { DEFAULT_FONT_FAMILY, NO_FILL } from "../lib/pdfAnnotationModel";

export const TOOL = {
  SELECT: "select",
  PAN: "pan",
  HIGHLIGHT: "highlight",
  UNDERLINE: "underline",
  STRIKE: "strike",
  TYPEWRITER: "typewriter",
  TEXTBOX: "textbox",
  CALLOUT: "callout",
  STICKY: "sticky",
  ARROW: "arrow",
  LINE: "line",
  POLYLINE: "polyline",
  RECT: "rect",
  ELLIPSE: "ellipse",
  PEN: "pen",
  FREEHAND_HIGHLIGHT: "freehandHighlight",
};

/** Tools that mark up the PDF's own text (text selection → quads). */
export const MARKUP_TOOLS = [TOOL.HIGHLIGHT, TOOL.UNDERLINE, TOOL.STRIKE];

/** Tools whose annotation is created by dragging out a shape or stroke. */
export const DRAG_CREATE_TOOLS = [
  TOOL.ARROW,
  TOOL.LINE,
  TOOL.RECT,
  TOOL.ELLIPSE,
  TOOL.TEXTBOX,
  TOOL.CALLOUT,
  TOOL.PEN,
  TOOL.FREEHAND_HIGHLIGHT,
];

/**
 * Tools whose annotation is placed with a single click. These hand the tool
 * back to Select once the item exists, so typing into the new item cannot
 * place another one.
 */
export const CLICK_PLACE_TOOLS = [TOOL.TYPEWRITER, TOOL.STICKY];

/** Every tool that creates annotations (as opposed to Select / Pan). */
export const CREATION_TOOLS = [...MARKUP_TOOLS, ...DRAG_CREATE_TOOLS, ...CLICK_PLACE_TOOLS];

export function isCreationTool(tool) {
  return CREATION_TOOLS.includes(tool);
}

/**
 * Whether the annotation overlay must own the pointer for this tool on this
 * page. Drag-creation and click-placement tools always do; the text-markup
 * tools only on pages WITHOUT a text layer (drag-band fallback) — on text
 * pages the browser's own selection does the work.
 */
export function overlayOwnsPointer(tool, pageHasText) {
  if (DRAG_CREATE_TOOLS.includes(tool) || CLICK_PLACE_TOOLS.includes(tool)) return true;
  if (MARKUP_TOOLS.includes(tool)) return !pageHasText;
  return false;
}

/** Human labels used by the ribbon and the options bar. */
export const TOOL_LABELS = {
  [TOOL.SELECT]: "Select",
  [TOOL.PAN]: "Hand (Pan)",
  [TOOL.HIGHLIGHT]: "Highlight",
  [TOOL.UNDERLINE]: "Underline",
  [TOOL.STRIKE]: "Strikethrough",
  [TOOL.TYPEWRITER]: "Text",
  [TOOL.TEXTBOX]: "Text box",
  [TOOL.CALLOUT]: "Callout",
  [TOOL.STICKY]: "Sticky note",
  [TOOL.ARROW]: "Arrow",
  [TOOL.LINE]: "Line",
  [TOOL.POLYLINE]: "Polyline",
  [TOOL.RECT]: "Rectangle",
  [TOOL.ELLIPSE]: "Ellipse",
  [TOOL.PEN]: "Freehand pen",
  [TOOL.FREEHAND_HIGHLIGHT]: "Freehand highlight",
};

/** The style a tool starts each new annotation with. */
export const DEFAULT_TOOL_STYLES = Object.freeze({
  [TOOL.HIGHLIGHT]: { color: "#FFF59D", opacity: 0.35, thickness: 22 },
  [TOOL.UNDERLINE]: { stroke: "#1976D2", strokeWidth: 3, thickness: 3 },
  [TOOL.STRIKE]: { stroke: "#E53935", strokeWidth: 3, thickness: 3 },
  [TOOL.TEXTBOX]: {
    textColor: "#111111",
    fontSize: 14,
    fontFamily: DEFAULT_FONT_FAMILY,
    bold: false,
    italic: false,
    align: "left",
    stroke: "#333333",
    strokeWidth: 2,
    fill: NO_FILL,
  },
  [TOOL.TYPEWRITER]: {
    textColor: "#111111",
    fontSize: 14,
    fontFamily: DEFAULT_FONT_FAMILY,
    bold: false,
    italic: false,
  },
  [TOOL.CALLOUT]: {
    textColor: "#111111",
    fontSize: 14,
    fontFamily: DEFAULT_FONT_FAMILY,
    bold: false,
    italic: false,
    align: "left",
    stroke: "#333333",
    strokeWidth: 2,
    fill: NO_FILL,
  },
  [TOOL.STICKY]: { color: "#FFE082" },
  [TOOL.ARROW]: { stroke: "#333333", strokeWidth: 2, head: "single" },
  [TOOL.LINE]: { stroke: "#333333", strokeWidth: 2 },
  [TOOL.POLYLINE]: { stroke: "#333333", strokeWidth: 2 },
  [TOOL.RECT]: { stroke: "#333333", strokeWidth: 2, fill: NO_FILL },
  [TOOL.ELLIPSE]: { stroke: "#333333", strokeWidth: 2, fill: NO_FILL },
  [TOOL.PEN]: { stroke: "#1976D2", strokeWidth: 3 },
  [TOOL.FREEHAND_HIGHLIGHT]: { stroke: "#FFF59D", strokeWidth: 16, opacity: 0.35 },
});

/** A fresh, mutable copy of every tool's default style (session memory). */
export function createToolStyles() {
  const out = {};
  for (const [tool, style] of Object.entries(DEFAULT_TOOL_STYLES)) out[tool] = { ...style };
  return out;
}

/** The style for `tool`, falling back to its defaults. Always a copy. */
export function toolStyleFor(styles, tool) {
  return { ...(DEFAULT_TOOL_STYLES[tool] || {}), ...(styles?.[tool] || {}) };
}

/** Return new styles with `patch` merged into one tool's style. */
export function patchToolStyle(styles, tool, patch) {
  if (!tool || !DEFAULT_TOOL_STYLES[tool]) return styles;
  return { ...styles, [tool]: { ...toolStyleFor(styles, tool), ...patch } };
}
