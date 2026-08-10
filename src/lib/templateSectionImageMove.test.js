// src/lib/templateSectionImageMove.test.js
//
// The gesture rules that let the IMAGE ITSELF be the move surface without
// swallowing an ordinary click, and that keep the corners reserved for the
// proportional resize work that lands next.

import {
  IMAGE_CORNER_ZONE_PX,
  IMAGE_MOVE_THRESHOLD_PX,
  IMAGE_MOVE_ZONE,
  exceedsMoveThreshold,
  imagePointerZone,
  isImageMoveSurface,
} from "./templateSectionImageMove";

// A comfortably large image, so the corner zone is the flat 20px square.
const rect = { left: 100, top: 200, width: 400, height: 300 };

describe("4. the image BODY is the move initiator", () => {
  test("the centre of the image is a move surface", () => {
    expect(imagePointerZone({ rect, clientX: 300, clientY: 350 })).toBe(
      IMAGE_MOVE_ZONE.BODY
    );
    expect(isImageMoveSurface({ rect, clientX: 300, clientY: 350 })).toBe(true);
  });

  test("the middle of an EDGE is still body — only corners are reserved", () => {
    // Middle of the top edge, the left edge, the right edge and the bottom edge.
    expect(isImageMoveSurface({ rect, clientX: 300, clientY: 201 })).toBe(true);
    expect(isImageMoveSurface({ rect, clientX: 101, clientY: 350 })).toBe(true);
    expect(isImageMoveSurface({ rect, clientX: 499, clientY: 350 })).toBe(true);
    expect(isImageMoveSurface({ rect, clientX: 300, clientY: 499 })).toBe(true);
  });

  test("a point outside the image is neither — 'not here' is its own answer", () => {
    expect(imagePointerZone({ rect, clientX: 50, clientY: 350 })).toBeNull();
    expect(imagePointerZone({ rect, clientX: 300, clientY: 900 })).toBeNull();
    expect(isImageMoveSurface({ rect, clientX: 50, clientY: 350 })).toBe(false);
  });

  test("an unusable rect or coordinate starts nothing", () => {
    expect(imagePointerZone({ rect: null, clientX: 1, clientY: 1 })).toBeNull();
    expect(
      imagePointerZone({ rect: { left: 0, top: 0, width: 0, height: 0 }, clientX: 0, clientY: 0 })
    ).toBeNull();
    expect(imagePointerZone({ rect, clientX: NaN, clientY: 350 })).toBeNull();
    expect(imagePointerZone()).toBeNull();
  });
});

describe("the CORNERS are reserved for proportional resizing, not for moving", () => {
  test("all four corners decline a move", () => {
    const corners = [
      [102, 202], // top-left
      [498, 202], // top-right
      [102, 498], // bottom-left
      [498, 498], // bottom-right
    ];
    for (const [x, y] of corners) {
      expect(imagePointerZone({ rect, clientX: x, clientY: y })).toBe(
        IMAGE_MOVE_ZONE.CORNER
      );
      expect(isImageMoveSurface({ rect, clientX: x, clientY: y })).toBe(false);
    }
  });

  test("the zone is exactly the documented square", () => {
    const justInside = IMAGE_CORNER_ZONE_PX - 1;
    const justOutside = IMAGE_CORNER_ZONE_PX + 1;
    expect(
      imagePointerZone({ rect, clientX: 100 + justInside, clientY: 200 + justInside })
    ).toBe(IMAGE_MOVE_ZONE.CORNER);
    expect(
      imagePointerZone({ rect, clientX: 100 + justOutside, clientY: 200 + justOutside })
    ).toBe(IMAGE_MOVE_ZONE.BODY);
  });

  test("a SMALL image still has a usable body — the zone shrinks with it", () => {
    // 30x30: an unclamped 20px zone would leave no body at all.
    const tiny = { left: 0, top: 0, width: 30, height: 30 };
    expect(imagePointerZone({ rect: tiny, clientX: 15, clientY: 15 })).toBe(
      IMAGE_MOVE_ZONE.BODY
    );
    expect(imagePointerZone({ rect: tiny, clientX: 1, clientY: 1 })).toBe(
      IMAGE_MOVE_ZONE.CORNER
    );
  });

  test("the corner size is configurable, so the resize work can widen it", () => {
    expect(imagePointerZone({ rect, clientX: 130, clientY: 230, cornerPx: 40 })).toBe(
      IMAGE_MOVE_ZONE.CORNER
    );
    expect(imagePointerZone({ rect, clientX: 130, clientY: 230, cornerPx: 10 })).toBe(
      IMAGE_MOVE_ZONE.BODY
    );
  });
});

describe("5/6/7. a short click is a click; only real travel starts a move", () => {
  const from = { startX: 300, startY: 350 };

  test("6. no movement at all stays a click", () => {
    expect(exceedsMoveThreshold({ ...from, clientX: 300, clientY: 350 })).toBe(false);
  });

  test("6. movement BELOW the threshold stays a click", () => {
    expect(exceedsMoveThreshold({ ...from, clientX: 302, clientY: 351 })).toBe(false);
    expect(
      exceedsMoveThreshold({ ...from, clientX: 300 + IMAGE_MOVE_THRESHOLD_PX - 1, clientY: 350 })
    ).toBe(false);
  });

  test("exactly AT the threshold is still a click — a move must be unambiguous", () => {
    expect(
      exceedsMoveThreshold({ ...from, clientX: 300 + IMAGE_MOVE_THRESHOLD_PX, clientY: 350 })
    ).toBe(false);
  });

  test("7. movement ABOVE the threshold arms the move", () => {
    expect(
      exceedsMoveThreshold({ ...from, clientX: 300 + IMAGE_MOVE_THRESHOLD_PX + 1, clientY: 350 })
    ).toBe(true);
    expect(exceedsMoveThreshold({ ...from, clientX: 300, clientY: 400 })).toBe(true);
  });

  test("travel in ANY direction counts the same", () => {
    const far = IMAGE_MOVE_THRESHOLD_PX + 5;
    expect(exceedsMoveThreshold({ ...from, clientX: 300 - far, clientY: 350 })).toBe(true);
    expect(exceedsMoveThreshold({ ...from, clientX: 300, clientY: 350 - far })).toBe(true);
    // Diagonal travel that is under the threshold on each axis but over it in a
    // straight line.
    expect(exceedsMoveThreshold({ ...from, clientX: 303, clientY: 354 })).toBe(true);
  });

  test("an unusable coordinate never arms a move", () => {
    expect(exceedsMoveThreshold({ ...from, clientX: undefined, clientY: 400 })).toBe(false);
    expect(exceedsMoveThreshold({ startX: null, startY: null, clientX: 1, clientY: 1 })).toBe(
      false
    );
    expect(exceedsMoveThreshold()).toBe(false);
  });
});

describe("the module stays a rule, not a mechanism", () => {
  test("no React, no DOM lookup, no storage", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "templateSectionImageMove.js"),
      "utf8"
    );
    expect(source).not.toMatch(/require\(|from "react"/);
    expect(source).not.toMatch(/document\.|window\.|localStorage/);
  });
});
