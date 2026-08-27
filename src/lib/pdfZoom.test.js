// Automated checks for the PDF viewer zoom model (src/lib/pdfZoom.js): the
// chosen wheel/trackpad gesture, its bounds, and focal-point preservation.
import {
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEPS,
  clampScale,
  focalScroll,
  isZoomWheel,
  wheelZoomScale,
  zoomOptionsFor,
} from "./pdfZoom";

describe("39/40. the zoom gesture is Ctrl/Cmd + wheel (which is also a trackpad pinch)", () => {
  test("39. a wheel event with ctrlKey or metaKey is a zoom", () => {
    expect(isZoomWheel({ ctrlKey: true })).toBe(true);
    expect(isZoomWheel({ metaKey: true })).toBe(true);
  });

  test("40. a plain wheel is ordinary scrolling and is left alone", () => {
    expect(isZoomWheel({ ctrlKey: false, metaKey: false, deltaY: 120 })).toBe(false);
    expect(isZoomWheel({ shiftKey: true })).toBe(false);
    expect(isZoomWheel(null)).toBe(false);
  });

  test("wheel up zooms in, wheel down zooms out, and a zero delta is a no-op", () => {
    expect(wheelZoomScale(1, -100)).toBeGreaterThan(1);
    expect(wheelZoomScale(1, 100)).toBeLessThan(1);
    expect(wheelZoomScale(1.3, 0)).toBe(1.3);
  });

  test("line/page delta modes are scaled into pixel magnitudes", () => {
    expect(wheelZoomScale(1, -3, 1)).toBeCloseTo(wheelZoomScale(1, -48, 0));
  });
});

describe("41. bounded, no runaway", () => {
  test("41. the scale never leaves [MIN_SCALE, MAX_SCALE]", () => {
    let s = 1;
    for (let i = 0; i < 200; i++) s = wheelZoomScale(s, -1000);
    expect(s).toBe(MAX_SCALE);
    for (let i = 0; i < 200; i++) s = wheelZoomScale(s, 1000);
    expect(s).toBe(MIN_SCALE);
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(99)).toBe(MAX_SCALE);
  });

  test("one event moves the scale by at most 25% either way — an inertial burst cannot jump", () => {
    expect(wheelZoomScale(1, -100000)).toBeCloseTo(1.25);
    expect(wheelZoomScale(1, 100000)).toBeCloseTo(0.8);
  });
});

describe("42. focal point preservation keeps annotations and page aligned under the pointer", () => {
  test("the content point under the pointer stays put when the scale doubles", () => {
    const before = { scrollLeft: 100, scrollTop: 400 };
    const focal = { x: 50, y: 120 }; // pointer, relative to the viewport
    const after = focalScroll(before, focal, 1, 2);
    // Content px under the pointer: (100+50, 400+120) → at 2x that point is
    // at (300, 1040); it must sit at the same viewport offset (50, 120).
    expect(after).toEqual({ scrollLeft: 250, scrollTop: 920 });
  });

  test("never scrolls negative and tolerates a missing focal point", () => {
    expect(focalScroll({ scrollLeft: 0, scrollTop: 0 }, null, 2, 1)).toEqual({ scrollLeft: 0, scrollTop: 0 });
    expect(focalScroll({ scrollLeft: 10, scrollTop: 10 }, { x: 100, y: 100 }, 2, 1).scrollTop).toBeGreaterThanOrEqual(0);
  });
});

describe("zoom select options", () => {
  test("on-ladder values show the ladder; an off-ladder value is inserted in order", () => {
    expect(zoomOptionsFor(1)).toBe(ZOOM_STEPS);
    expect(zoomOptionsFor(1.1)).toEqual([50, 75, 100, 110, 125, 150, 175, 200, 300]);
  });
});

describe("P4. a surface-specific zoom range", () => {
  const { DEFAULT_ZOOM_RANGE } = require("./pdfZoom");
  test("the default range IS the PDF viewer's, so every existing call is unchanged", () => {
    expect(DEFAULT_ZOOM_RANGE).toEqual({ min: MIN_SCALE, max: MAX_SCALE });
    expect(clampScale(0.1)).toBe(MIN_SCALE);
  });
  test("a wider range lets a large photograph fit and zoom to 8×", () => {
    const range = { min: 0.05, max: 8 };
    expect(clampScale(0.1, range)).toBe(0.1);
    expect(clampScale(20, range)).toBe(8);
    expect(clampScale(NaN, range)).toBe(1);
    expect(clampScale(0.1, { min: -1, max: 0 })).toBe(MIN_SCALE); // invalid range → default
  });
  test("wheel zoom, focal scroll and the ladder all honour the range", () => {
    const range = { min: 0.05, max: 8 };
    const s = wheelZoomScale(0.1, 500, 0, range);
    expect(s).toBeLessThan(0.1);
    expect(s).toBeGreaterThanOrEqual(0.05);
    // From 0.2 to 0.4 the point under the pointer stays put — only if 0.2 is
    // not clamped up to the PDF minimum.
    expect(focalScroll({ scrollLeft: 100, scrollTop: 100 }, { x: 50, y: 50 }, 0.2, 0.4, range)).toEqual({ scrollLeft: 250, scrollTop: 250 });
    expect(zoomOptionsFor(0.1, [10, 25, 50, 100], range)).toEqual([10, 25, 50, 100]);
    expect(zoomOptionsFor(0.19, [10, 25, 50, 100], range)).toEqual([10, 19, 25, 50, 100]);
  });
});
