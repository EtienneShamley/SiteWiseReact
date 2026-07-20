// Automated checks for the PDF editor coordinate model (src/lib/pdfCoords.js).
import {
  toPage,
  toScreen,
  pointToPage,
  pointToScreen,
  clientRectToPageRect,
  applyTransform,
  invertTransform,
  makePageToPdf,
  normalizeQuads,
} from "./pdfCoords";

describe("screen <-> page scalar/point conversion", () => {
  test("round-trips at any zoom level", () => {
    for (const scale of [0.5, 1, 1.1, 1.5, 3]) {
      expect(toScreen(toPage(123.4, scale), scale)).toBeCloseTo(123.4, 10);
      const p = pointToScreen(pointToPage({ x: 50, y: 75 }, scale), scale);
      expect(p.x).toBeCloseTo(50, 10);
      expect(p.y).toBeCloseTo(75, 10);
    }
  });

  test("drawing at 100% and viewing at 150% lands at the same page position", () => {
    const drawnAt1 = pointToPage({ x: 200, y: 300 }, 1);
    const drawnAt15 = pointToPage({ x: 300, y: 450 }, 1.5);
    expect(drawnAt1.x).toBeCloseTo(drawnAt15.x, 10);
    expect(drawnAt1.y).toBeCloseTo(drawnAt15.y, 10);
  });
});

describe("clientRectToPageRect", () => {
  test("converts selection client rects into page space", () => {
    const containerRect = { left: 100, top: 50 };
    const rect = { left: 130, top: 80, width: 60, height: 15 };
    const out = clientRectToPageRect(rect, containerRect, 1.5);
    expect(out.x).toBeCloseTo(20);
    expect(out.y).toBeCloseTo(20);
    expect(out.w).toBeCloseTo(40);
    expect(out.h).toBeCloseTo(10);
  });
});

describe("affine transforms", () => {
  test("invertTransform inverts an arbitrary affine matrix", () => {
    const m = [0, 1, -1, 0, 595, 10]; // rotation + translation
    const inv = invertTransform(m);
    const p = applyTransform(m, 33, 44);
    const back = applyTransform(inv, p.x, p.y);
    expect(back.x).toBeCloseTo(33, 8);
    expect(back.y).toBeCloseTo(44, 8);
  });

  test("unrotated page: page space -> PDF user space is a y-flip", () => {
    // scale-1 viewport transform of an unrotated 612x792 page
    const conv = makePageToPdf([1, 0, 0, -1, 0, 792]);
    const p = conv.toPdf(100, 100);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(692);
    expect(conv.textAngleDeg).toBeCloseTo(0);
  });

  test("90-degree rotated page maps corners correctly and reports text angle", () => {
    // pdf.js scale-1 viewport transform for a 612x792 page with /Rotate 90:
    // viewport dims become 792x612; transform = [0, 1, 1, 0, 0, 0]
    const conv = makePageToPdf([0, 1, 1, 0, 0, 0]);
    // Page-space origin (top-left of rotated view) -> PDF user space origin
    const o = conv.toPdf(0, 0);
    expect(o.x).toBeCloseTo(0);
    expect(o.y).toBeCloseTo(0);
    // A point one unit right on screen moves one unit up/down the PDF's y
    const r = conv.toPdf(1, 0);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
    // Text angle is +/-90 so flattened text stays upright
    expect(Math.abs(conv.textAngleDeg)).toBeCloseTo(90);
  });

  test("scale-1 viewports preserve lengths (thickness/font sizes pass through)", () => {
    const conv = makePageToPdf([0, 1, 1, 0, 0, 0]);
    expect(Math.hypot(conv.dirX.x, conv.dirX.y)).toBeCloseTo(1, 8);
    expect(Math.hypot(conv.dirDown.x, conv.dirDown.y)).toBeCloseTo(1, 8);
  });
});

describe("normalizeQuads", () => {
  test("drops degenerate rects", () => {
    const out = normalizeQuads([
      { x: 0, y: 0, w: 0.1, h: 10 },
      { x: 0, y: 0, w: 50, h: 10 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].w).toBe(50);
  });

  test("drops container rects that contain the line rects", () => {
    const container = { x: 10, y: 10, w: 300, h: 40 }; // parent element rect
    const line1 = { x: 12, y: 12, w: 280, h: 14 };
    const line2 = { x: 12, y: 30, w: 150, h: 14 };
    const out = normalizeQuads([container, line1, line2]);
    expect(out).toHaveLength(2);
    expect(out.some((q) => q.h > 20)).toBe(false);
  });

  test("merges overlapping rects on the same line, keeps separate lines", () => {
    const out = normalizeQuads([
      { x: 10, y: 100, w: 50, h: 12 },
      { x: 58, y: 100.5, w: 40, h: 12 }, // same line, overlapping
      { x: 10, y: 120, w: 80, h: 12 }, // next line
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].x).toBeCloseTo(10);
    expect(out[0].w).toBeCloseTo(88);
  });

  test("multi-line selection stays one quad per line", () => {
    const lines = [0, 1, 2].map((i) => ({ x: 20, y: 50 + i * 16, w: 200, h: 13 }));
    const out = normalizeQuads(lines);
    expect(out).toHaveLength(3);
  });
});
