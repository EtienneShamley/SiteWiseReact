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

/* ------------------------- P4: surfaces and scaling ----------------------- */

describe("P4. one engine, two surfaces", () => {
  const {
    ANNOTATION_SURFACE,
    IMAGE_TOOL_GROUPS,
    PDF_TOOL_GROUPS,
    SCALED_STYLE_FIELDS,
    scaleToolStyle,
    surfaceOffersTool,
    toolGroupsForSurface,
    toolsForSurface,
  } = require("./pdfTools");

  test("7. the PDF catalogue is the P1–P3 ribbon, unchanged", () => {
    expect(toolsForSurface(ANNOTATION_SURFACE.PDF)).toEqual([
      TOOL.SELECT, TOOL.PAN,
      TOOL.HIGHLIGHT, TOOL.UNDERLINE, TOOL.STRIKE,
      TOOL.TYPEWRITER, TOOL.TEXTBOX, TOOL.CALLOUT, TOOL.STICKY, TOOL.EDIT_TEXT,
      TOOL.ARROW, TOOL.LINE, TOOL.RECT, TOOL.ELLIPSE, TOOL.PEN, TOOL.FREEHAND_HIGHLIGHT,
    ]);
    expect(toolGroupsForSurface()).toBe(PDF_TOOL_GROUPS);
    expect(toolGroupsForSurface("anything-else")).toBe(PDF_TOOL_GROUPS);
  });

  test("6/20. the image catalogue is a strict subset without the PDF-text tools", () => {
    const image = toolsForSurface(ANNOTATION_SURFACE.IMAGE);
    const pdf = toolsForSurface(ANNOTATION_SURFACE.PDF);
    for (const tool of image) expect(pdf).toContain(tool);
    expect(image).toEqual([
      TOOL.SELECT, TOOL.PAN,
      TOOL.TYPEWRITER, TOOL.TEXTBOX, TOOL.CALLOUT,
      TOOL.ARROW, TOOL.LINE, TOOL.RECT, TOOL.ELLIPSE, TOOL.PEN, TOOL.FREEHAND_HIGHLIGHT,
    ]);
    for (const tool of [TOOL.EDIT_TEXT, TOOL.HIGHLIGHT, TOOL.UNDERLINE, TOOL.STRIKE, TOOL.STICKY]) {
      expect(surfaceOffersTool(ANNOTATION_SURFACE.IMAGE, tool)).toBe(false);
      expect(surfaceOffersTool(ANNOTATION_SURFACE.PDF, tool)).toBe(true);
    }
    expect(toolGroupsForSurface(ANNOTATION_SURFACE.IMAGE)).toBe(IMAGE_TOOL_GROUPS);
    expect(Object.isFrozen(IMAGE_TOOL_GROUPS)).toBe(true);
  });

  test("default sizes scale by a factor; colours, head and opacity never do; No border stays 0", () => {
    expect(SCALED_STYLE_FIELDS).toEqual(["strokeWidth", "fontSize", "thickness"]);
    const textbox = scaleToolStyle(DEFAULT_TOOL_STYLES[TOOL.TEXTBOX], 5);
    expect(textbox).toMatchObject({ fontSize: 70, strokeWidth: 10, textColor: "#111111", fill: "transparent", align: "left" });
    expect(scaleToolStyle({ strokeWidth: 0, stroke: "#000" }, 5)).toEqual({ strokeWidth: 0, stroke: "#000" });
    expect(scaleToolStyle(DEFAULT_TOOL_STYLES[TOOL.ARROW], 3)).toMatchObject({ strokeWidth: 6, head: "single" });
    expect(scaleToolStyle(DEFAULT_TOOL_STYLES[TOOL.FREEHAND_HIGHLIGHT], 2)).toMatchObject({ strokeWidth: 32, opacity: 0.35 });
    expect(scaleToolStyle(DEFAULT_TOOL_STYLES[TOOL.PEN], NaN)).toEqual(DEFAULT_TOOL_STYLES[TOOL.PEN]);
  });

  test("createToolStyles() without a factor is byte-for-byte the PDF defaults", () => {
    expect(createToolStyles()).toEqual(createToolStyles({ sizeFactor: 1 }));
    expect(createToolStyles({ sizeFactor: 4 })[TOOL.CALLOUT]).toMatchObject({ fontSize: 56, strokeWidth: 8 });
  });
});
