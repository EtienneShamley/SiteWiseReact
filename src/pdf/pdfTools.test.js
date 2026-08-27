// Automated checks for the PDF tool catalogue (src/pdf/pdfTools.js): pointer
// ownership per tool (the Sticky/Text placement defect), and the ribbon-owned
// tool style memory.
import {
  CLICK_PLACE_TOOLS,
  CREATION_TOOLS,
  DEFAULT_TOOL_STYLES,
  TOOL,
  TOOL_LABELS,
  createToolStyles,
  isCreationTool,
  overlayOwnsPointer,
  patchToolStyle,
  toolStyleFor,
  annotationTypeForTool,
} from "./pdfTools";
import { ANNOTATION_TYPES } from "../lib/pdfAnnotationModel";

describe("3. tool state", () => {
  test("Select and Pan are not creation tools; everything else is", () => {
    expect(isCreationTool(TOOL.SELECT)).toBe(false);
    expect(isCreationTool(TOOL.PAN)).toBe(false);
    for (const t of CREATION_TOOLS) expect(isCreationTool(t)).toBe(true);
    expect(isCreationTool(undefined)).toBe(false);
  });

  test("every creation tool creates a known annotation type and has a label", () => {
    for (const t of CREATION_TOOLS) {
      // P3: Edit text is the one tool whose product is not its own name.
      expect(Object.values(ANNOTATION_TYPES)).toContain(annotationTypeForTool(t));
      expect(TOOL_LABELS[t]).toBeTruthy();
    }
  });
});

describe("32. Sticky Note / Text placement: the overlay must own the pointer for click-to-place tools", () => {
  test("click-to-place tools (the previous defect) own the pointer on every page", () => {
    expect(CLICK_PLACE_TOOLS).toEqual([TOOL.TYPEWRITER, TOOL.STICKY]);
    for (const t of CLICK_PLACE_TOOLS) {
      expect(overlayOwnsPointer(t, true)).toBe(true);
      expect(overlayOwnsPointer(t, false)).toBe(true);
    }
  });

  test("drag-creation tools own the pointer; markup tools only on pages without text", () => {
    expect(overlayOwnsPointer(TOOL.RECT, true)).toBe(true);
    expect(overlayOwnsPointer(TOOL.HIGHLIGHT, true)).toBe(false); // browser text selection
    expect(overlayOwnsPointer(TOOL.HIGHLIGHT, false)).toBe(true); // drag-band fallback
  });

  test("Select and Pan never own the pointer (text selection / scrolling stay native)", () => {
    expect(overlayOwnsPointer(TOOL.SELECT, true)).toBe(false);
    expect(overlayOwnsPointer(TOOL.PAN, false)).toBe(false);
  });
});

describe("tool style memory (session-only, ribbon-owned)", () => {
  test("starts from the defaults, as copies", () => {
    const styles = createToolStyles();
    expect(styles[TOOL.TEXTBOX]).toEqual(DEFAULT_TOOL_STYLES[TOOL.TEXTBOX]);
    expect(styles[TOOL.TEXTBOX]).not.toBe(DEFAULT_TOOL_STYLES[TOOL.TEXTBOX]);
  });

  test("a patch is remembered for that tool only and never mutates the previous object", () => {
    const a = createToolStyles();
    const b = patchToolStyle(a, TOOL.TEXTBOX, { fontSize: 20, strokeWidth: 0 });
    expect(b).not.toBe(a);
    expect(a[TOOL.TEXTBOX].fontSize).toBe(14);
    expect(toolStyleFor(b, TOOL.TEXTBOX)).toMatchObject({ fontSize: 20, strokeWidth: 0 });
    expect(toolStyleFor(b, TOOL.CALLOUT).fontSize).toBe(14);
  });

  test("an unknown tool is ignored and reads as an empty style", () => {
    const a = createToolStyles();
    expect(patchToolStyle(a, TOOL.SELECT, { x: 1 })).toBe(a);
    expect(toolStyleFor(a, "nope")).toEqual({});
  });

  test("the defaults are frozen and box tools default to No fill, with a border", () => {
    expect(Object.isFrozen(DEFAULT_TOOL_STYLES)).toBe(true);
    expect(DEFAULT_TOOL_STYLES[TOOL.TEXTBOX]).toMatchObject({ fill: "transparent", strokeWidth: 2 });
  });
});
