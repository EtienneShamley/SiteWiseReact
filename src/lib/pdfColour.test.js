// Automated checks for the canonical PDF colour representation
// (src/lib/pdfColour.js) shared by the swatches, the visual picker, the hex
// field, the overlay and the export.
import { isLightColour, isNoColour, normalizeHexColour, pickerValue, PDF_COLOUR_SWATCHES } from "./pdfColour";
import { NO_FILL } from "./pdfAnnotationModel";

describe("21. one canonical colour value", () => {
  test("six-digit hex in any case, with or without #, normalizes to #RRGGBB", () => {
    expect(normalizeHexColour("#ff00aa")).toBe("#FF00AA");
    expect(normalizeHexColour("ff00aa")).toBe("#FF00AA");
    expect(normalizeHexColour("  #1976D2 ")).toBe("#1976D2");
  });

  test("three-digit hex expands", () => {
    expect(normalizeHexColour("#abc")).toBe("#AABBCC");
  });

  test("anything else is rejected — names, rgb(), urls, empty", () => {
    for (const bad of ["red", "rgb(1,2,3)", "url(x)", "#12345", "#1234567", "", null, 12, "javascript:alert(1)"]) {
      expect(normalizeHexColour(bad)).toBeNull();
    }
  });

  test("the visual picker always receives a hex it can display", () => {
    expect(pickerValue("#E53935")).toBe("#E53935");
    expect(pickerValue(NO_FILL)).toBe("#000000");
    expect(pickerValue(undefined, "#FFFFFF")).toBe("#FFFFFF");
  });

  test("no-colour tokens are recognised", () => {
    expect(isNoColour(NO_FILL)).toBe(true);
    expect(isNoColour("none")).toBe(true);
    expect(isNoColour("")).toBe(true);
    expect(isNoColour("#FFFFFF")).toBe(false);
  });

  test("every swatch is itself canonical", () => {
    for (const c of PDF_COLOUR_SWATCHES) expect(normalizeHexColour(c)).toBe(c);
  });

  test("swatch legibility helper", () => {
    expect(isLightColour("#FFFFFF")).toBe(true);
    expect(isLightColour("#111111")).toBe(false);
  });
});
