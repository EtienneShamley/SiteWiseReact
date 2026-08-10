// Tests for PROPORTIONAL CORNER RESIZING of a section image
// (src/lib/templateSectionImageResize.js).
//
// What matters here:
//
//   - four corners, and each one grows the image when dragged AWAY from it;
//   - the persisted range is the existing display model's own (15–100), so 100 —
//     the full content column — is reachable and nothing below the minimum can
//     be stored;
//   - only a WIDTH PERCENTAGE is ever produced: no pixel width, no height, and
//     therefore no way to stretch or crop;
//   - a gesture that ends where it started produces no change to save.
//
// The component wiring (preview-only movement, one save on release, cancel,
// failed-save revert, keyboard parity) is pinned in templateSectionImageUx.test.js.

import {
  IMAGE_MAX_WIDTH_PCT,
  IMAGE_MIN_WIDTH_PCT,
  IMAGE_RESIZE_CORNER,
  IMAGE_RESIZE_CORNERS,
  IMAGE_WIDTH_KEY_STEP_PCT,
  clampImageWidthPct,
  cornerGrowsRightward,
  cornerResizeCursor,
  isResizeCorner,
  nudgeImageWidthPct,
  resizeWidthPctFromPointer,
  widthPctChanged,
} from "./templateSectionImageResize";
import {
  IMAGE_CORNER_ZONE_MAX_RATIO,
  IMAGE_CORNER_ZONE_PX,
  IMAGE_MOVE_ZONE,
  imagePointerZone,
} from "./templateSectionImageMove";
import { MAX_PHOTO_WIDTH_PCT, MIN_PHOTO_WIDTH_PCT } from "./noteAttachments";

// A 400px-wide content column: 1% is 4px, so the arithmetic below is readable.
const COL = 400;
const drag = (corner, dx, startWidthPct = 50, maxPct = null) =>
  resizeWidthPctFromPointer({
    corner,
    startWidthPct,
    startX: 1000,
    clientX: 1000 + dx,
    containerWidth: COL,
    maxPct,
  });

/* ========================================================================== */
/* 15. FOUR CORNERS                                                            */
/* ========================================================================== */

describe("15. four corners", () => {
  test("exactly four, named for where they sit", () => {
    expect(IMAGE_RESIZE_CORNERS).toEqual([
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]);
    expect(IMAGE_RESIZE_CORNERS).toHaveLength(4);
    expect(new Set(IMAGE_RESIZE_CORNERS).size).toBe(4);
    expect(Object.values(IMAGE_RESIZE_CORNER).sort()).toEqual(
      [...IMAGE_RESIZE_CORNERS].sort()
    );
  });

  test("each corner is recognised and nothing else is", () => {
    for (const corner of IMAGE_RESIZE_CORNERS) expect(isResizeCorner(corner)).toBe(true);
    for (const bad of ["left", "top", "middle", "", null, undefined, 0, {}]) {
      expect(isResizeCorner(bad)).toBe(false);
    }
  });

  test("each carries the cursor of the diagonal it sits on", () => {
    expect(cornerResizeCursor("top-left")).toBe("nwse-resize");
    expect(cornerResizeCursor("bottom-right")).toBe("nwse-resize");
    expect(cornerResizeCursor("top-right")).toBe("nesw-resize");
    expect(cornerResizeCursor("bottom-left")).toBe("nesw-resize");
    expect(cornerResizeCursor("nope")).toBe("default");
  });

  test("16. the corners are the zone the MOVE gesture declines — one geometry", () => {
    const rect = { left: 0, top: 0, width: 300, height: 200 };
    const inset = IMAGE_CORNER_ZONE_PX - 2;
    for (const [x, y] of [
      [inset, inset],
      [rect.width - inset, inset],
      [inset, rect.height - inset],
      [rect.width - inset, rect.height - inset],
    ]) {
      expect(imagePointerZone({ rect, clientX: x, clientY: y })).toBe(
        IMAGE_MOVE_ZONE.CORNER
      );
    }
    // …and the body — the overwhelming majority of the image — still moves.
    expect(imagePointerZone({ rect, clientX: 150, clientY: 100 })).toBe(
      IMAGE_MOVE_ZONE.BODY
    );
    // The small-image clamp is shared too, so a thumbnail keeps a usable body.
    expect(IMAGE_CORNER_ZONE_MAX_RATIO).toBeCloseTo(1 / 3);
  });
});

/* ========================================================================== */
/* 17–20. DIRECTION                                                            */
/* ========================================================================== */

describe("17–20. the direction rule", () => {
  test("17. a RIGHT corner dragged outward (right) GROWS the image", () => {
    expect(drag(IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, +40)).toBe(60); // +40px of 400 = +10%
    expect(drag(IMAGE_RESIZE_CORNER.TOP_RIGHT, +40)).toBe(60);
  });

  test("18. a RIGHT corner dragged inward (left) SHRINKS it", () => {
    expect(drag(IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, -40)).toBe(40);
    expect(drag(IMAGE_RESIZE_CORNER.TOP_RIGHT, -40)).toBe(40);
  });

  test("19. a LEFT corner dragged outward (left) GROWS it", () => {
    expect(drag(IMAGE_RESIZE_CORNER.BOTTOM_LEFT, -40)).toBe(60);
    expect(drag(IMAGE_RESIZE_CORNER.TOP_LEFT, -40)).toBe(60);
  });

  test("20. a LEFT corner dragged inward (right) SHRINKS it", () => {
    expect(drag(IMAGE_RESIZE_CORNER.BOTTOM_LEFT, +40)).toBe(40);
    expect(drag(IMAGE_RESIZE_CORNER.TOP_LEFT, +40)).toBe(40);
  });

  test("cornerGrowsRightward states it once for both paths", () => {
    expect(cornerGrowsRightward("top-right")).toBe(true);
    expect(cornerGrowsRightward("bottom-right")).toBe(true);
    expect(cornerGrowsRightward("top-left")).toBe(false);
    expect(cornerGrowsRightward("bottom-left")).toBe(false);
  });

  test("VERTICAL travel is ignored — width is the only dimension", () => {
    const flat = resizeWidthPctFromPointer({
      corner: "bottom-right",
      startWidthPct: 50,
      startX: 0,
      clientX: 40,
      containerWidth: COL,
    });
    const steep = resizeWidthPctFromPointer({
      corner: "bottom-right",
      startWidthPct: 50,
      startX: 0,
      clientX: 40,
      clientY: 9999, // not a parameter at all
      containerWidth: COL,
    });
    expect(flat).toBe(steep);
  });

  test("the movement is proportional to the CONTENT COLUMN, not to pixels", () => {
    const narrow = resizeWidthPctFromPointer({
      corner: "bottom-right",
      startWidthPct: 50,
      startX: 0,
      clientX: 50,
      containerWidth: 200,
    });
    const wide = resizeWidthPctFromPointer({
      corner: "bottom-right",
      startWidthPct: 50,
      startX: 0,
      clientX: 50,
      containerWidth: 1000,
    });
    expect(narrow).toBe(75); // 50px of 200 = 25%
    expect(wide).toBe(55); // 50px of 1000 = 5%
  });
});

/* ========================================================================== */
/* 21–24. THE CLAMP AND WHAT IS PRODUCED                                       */
/* ========================================================================== */

describe("21–24. bounds", () => {
  test("21. a huge inward drag clamps at the model MINIMUM", () => {
    expect(drag(IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, -100000)).toBe(MIN_PHOTO_WIDTH_PCT);
    expect(drag(IMAGE_RESIZE_CORNER.TOP_LEFT, +100000)).toBe(MIN_PHOTO_WIDTH_PCT);
    expect(IMAGE_MIN_WIDTH_PCT).toBe(MIN_PHOTO_WIDTH_PCT);
    expect(MIN_PHOTO_WIDTH_PCT).toBe(15);
  });

  test("22. the maximum is 100 — the full content column is reachable", () => {
    expect(drag(IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, +100000)).toBe(100);
    expect(IMAGE_MAX_WIDTH_PCT).toBe(MAX_PHOTO_WIDTH_PCT);
    expect(MAX_PHOTO_WIDTH_PCT).toBe(100);
    expect(clampImageWidthPct(100)).toBe(100);
    expect(clampImageWidthPct(140)).toBe(100);
  });

  test("an optional display cap narrows the ceiling but never the floor", () => {
    // The one-page height rule a very tall portrait hits.
    expect(drag(IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, +100000, 50, 70)).toBe(70);
    // A nonsensical cap can never push a width below what the model stores.
    expect(clampImageWidthPct(50, 5)).toBe(MIN_PHOTO_WIDTH_PCT);
  });

  test("23/24. the output is one number — a width percentage, never a height", () => {
    const pct = drag(IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, +40);
    expect(typeof pct).toBe("number");
    expect(pct).toBeGreaterThanOrEqual(MIN_PHOTO_WIDTH_PCT);
    expect(pct).toBeLessThanOrEqual(MAX_PHOTO_WIDTH_PCT);
  });

  test("23/24. no height, aspect ratio or pixel width appears in the module at all", () => {
    const code = require("fs")
      .readFileSync(require("path").join(__dirname, "templateSectionImageResize.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/heightPct|intrinsicHeight|widthPx|aspect/i);
    expect(code).not.toMatch(/clientY/);
  });

  test("unusable input produces null, never a width of zero", () => {
    expect(resizeWidthPctFromPointer()).toBeNull();
    expect(drag("middle", 40)).toBeNull();
    expect(
      resizeWidthPctFromPointer({
        corner: "bottom-right",
        startWidthPct: 50,
        startX: 0,
        clientX: 10,
        containerWidth: 0,
      })
    ).toBeNull();
    expect(
      resizeWidthPctFromPointer({
        corner: "bottom-right",
        startWidthPct: NaN,
        startX: 0,
        clientX: 10,
        containerWidth: COL,
      })
    ).toBeNull();
    expect(clampImageWidthPct("60")).toBeNull();
  });
});

/* ========================================================================== */
/* A GESTURE THAT CHANGES NOTHING                                              */
/* ========================================================================== */

describe("nothing to save", () => {
  test("a press and release at the same point produces no change", () => {
    const pct = drag(IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, 0);
    expect(pct).toBe(50);
    expect(widthPctChanged(pct, 50)).toBe(false);
  });

  test("a sub-percentage-point wobble is not a change either", () => {
    expect(widthPctChanged(50.4, 50)).toBe(false);
    expect(widthPctChanged(50.6, 50)).toBe(true);
  });

  test("widthPctChanged refuses to compare unusable values", () => {
    expect(widthPctChanged(null, 50)).toBe(false);
    expect(widthPctChanged(50, undefined)).toBe(false);
  });
});

/* ========================================================================== */
/* THE KEYBOARD STEP                                                           */
/* ========================================================================== */

describe("the keyboard equivalent", () => {
  test("one step widens or narrows by a sensible amount", () => {
    expect(IMAGE_WIDTH_KEY_STEP_PCT).toBe(5);
    expect(nudgeImageWidthPct({ widthPct: 50, stepPct: IMAGE_WIDTH_KEY_STEP_PCT })).toBe(55);
    expect(nudgeImageWidthPct({ widthPct: 50, stepPct: -IMAGE_WIDTH_KEY_STEP_PCT })).toBe(45);
  });

  test("it shares the pointer path's clamp exactly", () => {
    expect(nudgeImageWidthPct({ widthPct: 98, stepPct: 5 })).toBe(100);
    expect(nudgeImageWidthPct({ widthPct: 17, stepPct: -5 })).toBe(15);
    expect(nudgeImageWidthPct({ widthPct: 50, stepPct: 5, maxPct: 52 })).toBe(52);
  });

  test("a step that cannot move produces null — a silent no-op, not a save", () => {
    expect(nudgeImageWidthPct({ widthPct: 100, stepPct: 5 })).toBeNull();
    expect(nudgeImageWidthPct({ widthPct: 15, stepPct: -5 })).toBeNull();
    expect(nudgeImageWidthPct({ widthPct: 50, stepPct: 0 })).toBeNull();
    expect(nudgeImageWidthPct()).toBeNull();
  });

  test("it returns whole percentage points, like the stored model", () => {
    expect(nudgeImageWidthPct({ widthPct: 47.4, stepPct: 5 })).toBe(52);
  });
});
