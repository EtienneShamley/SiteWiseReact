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

describe("zoom, viewport offset and device pixel ratio", () => {
  const ZOOMS = [0.4, 0.75, 1, 1.1, 1.25, 1.5, 2, 3, 4];

  test("a stored annotation lands on the same screen position at every zoom", () => {
    const stored = { x: 137.25, y: 402.5 }; // page space, the canonical form
    for (const scale of ZOOMS) {
      const onScreen = pointToScreen(stored, scale);
      expect(pointToPage(onScreen, scale).x).toBeCloseTo(stored.x, 10);
      expect(pointToPage(onScreen, scale).y).toBeCloseTo(stored.y, 10);
      // The ratio is exactly the zoom factor — no other term enters.
      expect(onScreen.x / stored.x).toBeCloseTo(scale, 10);
    }
  });

  test("the same page point drawn at any zoom yields identical stored geometry", () => {
    const target = { x: 250, y: 175 };
    const stored = ZOOMS.map((scale) =>
      pointToPage({ x: target.x * scale, y: target.y * scale }, scale)
    );
    for (const s of stored) {
      expect(s.x).toBeCloseTo(target.x, 10);
      expect(s.y).toBeCloseTo(target.y, 10);
    }
  });

  test("a scrolled or offset viewport does not change stored coordinates", () => {
    // The page container has moved on screen (scroll, resize, narrower window),
    // but the pointer is over the same spot on the page.
    const scale = 1.5;
    const pageX = 90;
    const pageY = 140;
    for (const container of [
      { left: 0, top: 0 },
      { left: 233, top: -845 },
      { left: -12.5, top: 4000 },
    ]) {
      const clientRect = {
        left: container.left + pageX * scale,
        top: container.top + pageY * scale,
        width: 40 * scale,
        height: 12 * scale,
      };
      const out = clientRectToPageRect(clientRect, container, scale);
      expect(out.x).toBeCloseTo(pageX, 10);
      expect(out.y).toBeCloseTo(pageY, 10);
      expect(out.w).toBeCloseTo(40, 10);
      expect(out.h).toBeCloseTo(12, 10);
    }
  });

  test("device pixel ratio never enters the conversion", () => {
    // Pointer events and getBoundingClientRect are both in CSS pixels, so a
    // retina display must not shift placement. Same CSS input, same result.
    const scale = 1.25;
    const cssPoint = { x: 300, y: 220 };
    const onRetina = pointToPage(cssPoint, scale);
    const onStandard = pointToPage(cssPoint, scale);
    expect(onRetina).toEqual(onStandard);
    // Backing-store pixels (CSS x DPR) are NOT what the conversion consumes.
    for (const dpr of [1, 2, 3]) {
      const backingStore = { x: cssPoint.x * dpr, y: cssPoint.y * dpr };
      if (dpr === 1) continue;
      expect(pointToPage(backingStore, scale).x).not.toBeCloseTo(onStandard.x, 5);
    }
  });

  test("export geometry is derived from page space alone, so zoom cannot reach it", () => {
    const conv = makePageToPdf([1, 0, 0, -1, 0, 792]);
    const stored = { x: 120, y: 200 };
    const exported = conv.toPdf(stored.x, stored.y);
    for (const scale of ZOOMS) {
      // Whatever the editor was zoomed to, the round trip returns the same
      // page-space point, and therefore the same PDF user-space point.
      const roundTripped = pointToPage(pointToScreen(stored, scale), scale);
      const again = conv.toPdf(roundTripped.x, roundTripped.y);
      expect(again.x).toBeCloseTo(exported.x, 8);
      expect(again.y).toBeCloseTo(exported.y, 8);
    }
  });

  test("page -> PDF -> page round-trips within tolerance on a rotated page", () => {
    const transform = [0, 1, 1, 0, 0, 0]; // 90-degree rotated page
    const conv = makePageToPdf(transform);
    for (const p of [{ x: 0, y: 0 }, { x: 100, y: 250 }, { x: 611.5, y: 791.25 }]) {
      const user = conv.toPdf(p.x, p.y);
      const back = applyTransform(transform, user.x, user.y);
      expect(back.x).toBeCloseTo(p.x, 8);
      expect(back.y).toBeCloseTo(p.y, 8);
    }
  });

  test("a zero or missing scale degrades to 1 instead of dividing by zero", () => {
    expect(toPage(50, 0)).toBe(50);
    expect(toScreen(50, undefined)).toBe(50);
    expect(pointToPage({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
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
