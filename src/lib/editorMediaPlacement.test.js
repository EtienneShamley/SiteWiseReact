// src/lib/editorMediaPlacement.test.js
//
// The horizontal placement geometry of a media body drag: side bands over the
// editor content box choose wrap-left / block / wrap-right, hysteresis keeps a
// boundary hover from flickering, and unusable geometry degrades to block.

import {
  MEDIA_WRAP_BAND_HYSTERESIS_RATIO,
  MEDIA_WRAP_SIDE_BAND_RATIO,
  mediaPlacementCandidate,
  mediaPlacementContentBox,
} from "./editorMediaPlacement";

// A convenient content box: left 100, width 1000 — band boundaries at
// x = 380 (left) and x = 820 (right) with the default 28% bands.
const BOX = { contentLeft: 100, contentWidth: 1000 };
const at = (x, previous) => mediaPlacementCandidate({ x, ...BOX, previous });

const WRAP_LEFT = { mode: "wrap", side: "left" };
const WRAP_RIGHT = { mode: "wrap", side: "right" };
const BLOCK = { mode: "block", side: null };

describe("mediaPlacementCandidate — bands", () => {
  test("the left band asks for wrap-left", () => {
    expect(at(100)).toEqual(WRAP_LEFT);
    expect(at(300)).toEqual(WRAP_LEFT);
    expect(at(100 + 1000 * MEDIA_WRAP_SIDE_BAND_RATIO - 1)).toEqual(WRAP_LEFT);
  });

  test("the centre band asks for block", () => {
    expect(at(100 + 1000 * MEDIA_WRAP_SIDE_BAND_RATIO + 1)).toEqual(BLOCK);
    expect(at(600)).toEqual(BLOCK);
    expect(at(100 + 1000 * (1 - MEDIA_WRAP_SIDE_BAND_RATIO) - 1)).toEqual(BLOCK);
  });

  test("the right band asks for wrap-right", () => {
    expect(at(100 + 1000 * (1 - MEDIA_WRAP_SIDE_BAND_RATIO) + 1)).toEqual(WRAP_RIGHT);
    expect(at(1100)).toEqual(WRAP_RIGHT);
  });

  test("a pointer past the content box edges is still an emphatic side, never undefined", () => {
    expect(at(-500)).toEqual(WRAP_LEFT);
    expect(at(5000)).toEqual(WRAP_RIGHT);
  });

  test("one sweep left → centre → right walks through all three candidates", () => {
    let held = null;
    const seen = [];
    for (const x of [150, 500, 1000]) {
      held = at(x, held);
      seen.push(held.mode === "wrap" ? held.side : "block");
    }
    expect(seen).toEqual(["left", "block", "right"]);
  });
});

describe("mediaPlacementCandidate — hysteresis", () => {
  const bandX = 100 + 1000 * MEDIA_WRAP_SIDE_BAND_RATIO; // 380
  const stickPx = 1000 * MEDIA_WRAP_BAND_HYSTERESIS_RATIO; // 60

  test("jitter across the boundary does not flicker a held wrap-left", () => {
    // Held wrap-left: a few px past the plain boundary is still wrap-left.
    expect(at(bandX + 5, WRAP_LEFT)).toEqual(WRAP_LEFT);
    expect(at(bandX + stickPx - 1, WRAP_LEFT)).toEqual(WRAP_LEFT);
    // Without the held candidate, the same position is already block.
    expect(at(bandX + 5, null)).toEqual(BLOCK);
    expect(at(bandX + 5, BLOCK)).toEqual(BLOCK);
  });

  test("travelling meaningfully past the boundary does release the held side", () => {
    expect(at(bandX + stickPx + 1, WRAP_LEFT)).toEqual(BLOCK);
  });

  test("the right band is sticky symmetrically", () => {
    const rightX = 100 + 1000 * (1 - MEDIA_WRAP_SIDE_BAND_RATIO); // 820
    expect(at(rightX - 5, WRAP_RIGHT)).toEqual(WRAP_RIGHT);
    expect(at(rightX - 5, null)).toEqual(BLOCK);
    expect(at(rightX - stickPx - 1, WRAP_RIGHT)).toEqual(BLOCK);
  });

  test("holding block never widens a band — entering wrap always uses the plain boundary", () => {
    expect(at(bandX - 1, BLOCK)).toEqual(WRAP_LEFT);
  });
});

describe("mediaPlacementCandidate — degenerate geometry", () => {
  test("unusable inputs degrade to block, the placement every document understands", () => {
    expect(mediaPlacementCandidate({})).toEqual(BLOCK);
    expect(mediaPlacementCandidate({ x: NaN, ...BOX })).toEqual(BLOCK);
    expect(
      mediaPlacementCandidate({ x: 10, contentLeft: 0, contentWidth: 0 })
    ).toEqual(BLOCK);
    expect(
      mediaPlacementCandidate({ x: 10, contentLeft: NaN, contentWidth: 100 })
    ).toEqual(BLOCK);
  });

  test("a malformed previous candidate is normalized, never trusted", () => {
    expect(at(400, { mode: "wrap", side: "up" })).toEqual(BLOCK);
    expect(at(385, { mode: "nonsense", side: "left" })).toEqual(BLOCK);
  });
});

describe("mediaPlacementContentBox", () => {
  test("reads the border box corrected for padding", () => {
    const el = {
      getBoundingClientRect: () => ({ left: 50, width: 700 }),
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({ paddingLeft: "10px", paddingRight: "30px" }),
        },
      },
    };
    expect(mediaPlacementContentBox(el)).toEqual({ left: 60, width: 660 });
  });

  test("an unmeasurable element is null — the caller then gets block candidates", () => {
    expect(mediaPlacementContentBox(null)).toBeNull();
    expect(
      mediaPlacementContentBox({ getBoundingClientRect: () => ({ left: 0, width: 0 }) })
    ).toBeNull();
  });
});
