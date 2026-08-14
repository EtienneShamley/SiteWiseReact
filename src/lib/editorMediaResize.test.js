// src/lib/editorMediaResize.test.js
//
// The shared resize boundary. The arithmetic itself is proven in depth by
// templateSectionImageResize.test.js; these tests assert the shared surface —
// that the media-core names expose the SAME proven rules (so the two consumers
// can never disagree), plus the behaviours a shared consumer will rely on.
// They are written against behaviour, not against the aliasing, so they keep
// holding when Phase G moves the implementation's home into this module.

import {
  MEDIA_RESIZE_CORNER,
  MEDIA_RESIZE_CORNERS,
  MEDIA_WIDTH_KEY_STEP_PCT,
  clampMediaWidthPct,
  isMediaResizeCorner,
  mediaCornerGrowsRightward,
  mediaCornerResizeCursor,
  mediaWidthPctChanged,
  mediaWidthPctFromPointer,
  nudgeMediaWidthPct,
} from "./editorMediaResize";

describe("the corner vocabulary", () => {
  test("four corners, in a stable order", () => {
    expect(MEDIA_RESIZE_CORNERS).toEqual([
      MEDIA_RESIZE_CORNER.TOP_LEFT,
      MEDIA_RESIZE_CORNER.TOP_RIGHT,
      MEDIA_RESIZE_CORNER.BOTTOM_LEFT,
      MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
    ]);
    for (const corner of MEDIA_RESIZE_CORNERS) {
      expect(isMediaResizeCorner(corner)).toBe(true);
    }
    expect(isMediaResizeCorner("middle")).toBe(false);
  });

  test("right corners grow rightward, left corners grow leftward", () => {
    expect(mediaCornerGrowsRightward(MEDIA_RESIZE_CORNER.TOP_RIGHT)).toBe(true);
    expect(mediaCornerGrowsRightward(MEDIA_RESIZE_CORNER.BOTTOM_RIGHT)).toBe(true);
    expect(mediaCornerGrowsRightward(MEDIA_RESIZE_CORNER.TOP_LEFT)).toBe(false);
    expect(mediaCornerGrowsRightward(MEDIA_RESIZE_CORNER.BOTTOM_LEFT)).toBe(false);
  });

  test("each corner reports the diagonal cursor it sits on", () => {
    expect(mediaCornerResizeCursor(MEDIA_RESIZE_CORNER.TOP_LEFT)).toBe("nwse-resize");
    expect(mediaCornerResizeCursor(MEDIA_RESIZE_CORNER.BOTTOM_RIGHT)).toBe("nwse-resize");
    expect(mediaCornerResizeCursor(MEDIA_RESIZE_CORNER.TOP_RIGHT)).toBe("nesw-resize");
    expect(mediaCornerResizeCursor(MEDIA_RESIZE_CORNER.BOTTOM_LEFT)).toBe("nesw-resize");
  });
});

describe("pointer arithmetic", () => {
  test("dragging away from the image grows it; into it shrinks it", () => {
    const base = {
      startWidthPct: 50,
      startX: 400,
      containerWidth: 1000,
    };
    // Right corner, 100px right of a 1000px column = +10 points.
    expect(
      mediaWidthPctFromPointer({ ...base, corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 500 })
    ).toBe(60);
    // Left corner mirrors: 100px LEFT grows.
    expect(
      mediaWidthPctFromPointer({ ...base, corner: MEDIA_RESIZE_CORNER.BOTTOM_LEFT, clientX: 300 })
    ).toBe(60);
    // And into the image shrinks, symmetrically.
    expect(
      mediaWidthPctFromPointer({ ...base, corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 300 })
    ).toBe(40);
  });

  test("the clamp holds at both ends", () => {
    expect(clampMediaWidthPct(7)).toBe(15);
    expect(clampMediaWidthPct(150)).toBe(100);
    expect(clampMediaWidthPct(150, 80)).toBe(80);
    // The display cap can never push below the model minimum.
    expect(clampMediaWidthPct(50, 5)).toBe(15);
  });

  test("unusable input answers null, never zero", () => {
    expect(mediaWidthPctFromPointer({})).toBeNull();
    expect(
      mediaWidthPctFromPointer({
        corner: "middle",
        startWidthPct: 50,
        startX: 0,
        clientX: 10,
        containerWidth: 100,
      })
    ).toBeNull();
    expect(
      mediaWidthPctFromPointer({
        corner: MEDIA_RESIZE_CORNER.TOP_LEFT,
        startWidthPct: 50,
        startX: 0,
        clientX: 10,
        containerWidth: 0,
      })
    ).toBeNull();
  });
});

describe("keyboard step", () => {
  test("the step is 5 points and goes through the same clamp", () => {
    expect(MEDIA_WIDTH_KEY_STEP_PCT).toBe(5);
    expect(nudgeMediaWidthPct({ widthPct: 50, stepPct: MEDIA_WIDTH_KEY_STEP_PCT })).toBe(55);
    expect(nudgeMediaWidthPct({ widthPct: 98, stepPct: 5 })).toBe(100);
    // Already at the ceiling: a silent no-op, not a save.
    expect(nudgeMediaWidthPct({ widthPct: 100, stepPct: 5 })).toBeNull();
    expect(nudgeMediaWidthPct({ widthPct: 15, stepPct: -5 })).toBeNull();
  });
});

describe("what counts as a change", () => {
  test("whole points decide; a sub-point gesture saves nothing", () => {
    expect(mediaWidthPctChanged(50.4, 50)).toBe(false);
    expect(mediaWidthPctChanged(51, 50)).toBe(true);
    expect(mediaWidthPctChanged(null, 50)).toBe(false);
  });
});
