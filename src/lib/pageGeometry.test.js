// Unit tests for the pure page-geometry module (src/lib/pageGeometry.js).
// These lock the canonical A4 constants and the derived usable content box so a
// future accidental change to page dimensions is caught, and so export/print
// logic that reads these values has a verified contract.
import {
  PX_PER_MM,
  PAGE_SIZE_MM,
  PAGE_MARGIN_MM,
  PAGE_WIDTH_PX,
  PAGE_HEIGHT_PX,
  USABLE_WIDTH_PX,
  USABLE_HEIGHT_PX,
  mmToPx,
  pxToMm,
  getPageGeometry,
} from "./pageGeometry";

describe("page geometry constants", () => {
  test("A4 portrait is 210mm x 297mm", () => {
    expect(PAGE_SIZE_MM.width).toBe(210);
    expect(PAGE_SIZE_MM.height).toBe(297);
  });

  test("margins are a symmetric ~20mm professional-report box", () => {
    expect(PAGE_MARGIN_MM.top).toBe(20);
    expect(PAGE_MARGIN_MM.right).toBe(20);
    expect(PAGE_MARGIN_MM.bottom).toBe(20);
    expect(PAGE_MARGIN_MM.left).toBe(20);
  });

  test("px-per-mm matches the CSS 96dpi reference density", () => {
    expect(PX_PER_MM).toBeCloseTo(96 / 25.4, 6);
  });
});

describe("mm/px conversion", () => {
  test("mmToPx and pxToMm are inverse", () => {
    expect(pxToMm(mmToPx(170))).toBeCloseTo(170, 6);
    expect(mmToPx(pxToMm(642))).toBeCloseTo(642, 6);
  });

  test("non-numeric input converts to 0 rather than NaN", () => {
    expect(mmToPx(undefined)).toBe(0);
    expect(pxToMm(null)).toBe(0);
  });
});

describe("derived page dimensions", () => {
  test("page px dimensions match the mm size", () => {
    expect(PAGE_WIDTH_PX).toBeCloseTo(210 * PX_PER_MM, 6);
    expect(PAGE_HEIGHT_PX).toBeCloseTo(297 * PX_PER_MM, 6);
  });

  test("usable box subtracts both margins on each axis", () => {
    expect(USABLE_WIDTH_PX).toBeCloseTo((210 - 40) * PX_PER_MM, 6);
    expect(USABLE_HEIGHT_PX).toBeCloseTo((297 - 40) * PX_PER_MM, 6);
  });

  test("A4 portrait proportions are preserved (height > width, ~1.414 ratio)", () => {
    expect(PAGE_HEIGHT_PX).toBeGreaterThan(PAGE_WIDTH_PX);
    expect(PAGE_HEIGHT_PX / PAGE_WIDTH_PX).toBeCloseTo(297 / 210, 6);
  });

  test("usable height leaves meaningful room for content", () => {
    // Sanity: ~971px usable height at 96dpi — enough that several default rows
    // fit on page 1 before pagination kicks in.
    expect(USABLE_HEIGHT_PX).toBeGreaterThan(900);
    expect(USABLE_HEIGHT_PX).toBeLessThan(1000);
  });
});

describe("getPageGeometry", () => {
  test("returns every derived value consistent with the exported constants", () => {
    const g = getPageGeometry();
    expect(g.pageWidthPx).toBe(PAGE_WIDTH_PX);
    expect(g.pageHeightPx).toBe(PAGE_HEIGHT_PX);
    expect(g.usableWidthPx).toBe(USABLE_WIDTH_PX);
    expect(g.usableHeightPx).toBe(USABLE_HEIGHT_PX);
    expect(g.pxPerMm).toBe(PX_PER_MM);
  });
});
