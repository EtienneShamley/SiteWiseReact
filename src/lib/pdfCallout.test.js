// The Callout model (src/lib/pdfCallout.js): the three-stage creation draft
// and the attached-leader geometry the overlay and the export share.
//
// P2 numbering follows the brief: 1–8 creation, 9–15 attachment (the parts
// that are pure geometry — the rendered gestures are in
// src/pdf/PdfAnnotatorP2.test.js), 46 old callouts remain readable.
import {
  CALLOUT_MIN_WIDTH,
  CALLOUT_STAGE,
  calloutAnchorCandidates,
  calloutBoxFromPoints,
  calloutDraftPreview,
  calloutLeaderGeometry,
  calloutMinHeight,
  completeCalloutDraft,
  defaultLeaderFor,
  placeCalloutAnchor,
  rotatePointDeg,
  startCalloutDraft,
} from "./pdfCallout";
import {
  MIN_SHAPE_SIZE,
  normalizeAnnotation,
  resizeRectCorner,
  serializeAnnotations,
  translateAnnotation,
  moveRect,
} from "./pdfAnnotationModel";

const BOUNDS = { width: 600, height: 800 };
const STYLE = { fontSize: 14, stroke: "#333333", strokeWidth: 2, fill: "transparent" };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* ------------------------------ creation draft --------------------------- */

describe("1–3. three-stage creation draft", () => {
  test("1. the first click establishes the leader tip, transiently", () => {
    const d = startCalloutDraft(1, { x: 100, y: 120 }, BOUNDS);
    expect(d).toEqual({ page: 1, stage: CALLOUT_STAGE.TIP, tip: { x: 100, y: 120 }, anchor: null });
    // Nothing about a draft is an annotation.
    expect(normalizeAnnotation(d)).toBeNull();
  });

  test("the tip is clamped to the page (click outside the page)", () => {
    const d = startCalloutDraft(1, { x: -30, y: 900 }, BOUNDS);
    expect(d.tip).toEqual({ x: 0, y: 800 });
  });

  test("2. the second click establishes the box anchor, still transiently", () => {
    const d1 = startCalloutDraft(1, { x: 100, y: 120 }, BOUNDS);
    const d2 = placeCalloutAnchor(d1, { x: 200, y: 160 }, BOUNDS);
    expect(d2.stage).toBe(CALLOUT_STAGE.ANCHOR);
    expect(d2.anchor).toEqual({ x: 200, y: 160 });
    expect(d2.tip).toEqual({ x: 100, y: 120 });
    expect(d1.stage).toBe(CALLOUT_STAGE.TIP); // pure: the first draft is untouched
    expect(normalizeAnnotation(d2)).toBeNull();
  });

  test("placing an anchor on a draft that has none, or is complete, is a no-op", () => {
    expect(placeCalloutAnchor(null, { x: 1, y: 1 }, BOUNDS)).toBeNull();
    const d2 = placeCalloutAnchor(startCalloutDraft(1, { x: 0, y: 0 }, BOUNDS), { x: 5, y: 5 }, BOUNDS);
    expect(placeCalloutAnchor(d2, { x: 9, y: 9 }, BOUNDS)).toBe(d2);
  });

  test("3. the third click creates the complete Callout — box from anchor to the click, leader at the tip", () => {
    const d2 = placeCalloutAnchor(startCalloutDraft(2, { x: 100, y: 120 }, BOUNDS), { x: 200, y: 160 }, BOUNDS);
    const a = completeCalloutDraft(d2, { x: 380, y: 240 }, BOUNDS, STYLE);
    expect(a.type).toBe("callout");
    expect(a.page).toBe(2);
    expect(a).toMatchObject({ x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 }, text: "" });
    expect(a.id).toEqual(expect.any(String));
    expect(a.createdAt).toEqual(expect.any(Number));
    // The record is valid at the persistence boundary, and round-trips.
    const stored = serializeAnnotations([a]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 } });
  });

  test("the third click may be on any side of the anchor (inverted drags normalize)", () => {
    const d2 = placeCalloutAnchor(startCalloutDraft(1, { x: 50, y: 50 }, BOUNDS), { x: 300, y: 300 }, BOUNDS);
    const a = completeCalloutDraft(d2, { x: 100, y: 200 }, BOUNDS, STYLE);
    expect(a).toMatchObject({ x: 100, y: 200, w: 200, h: 100 });
  });

  test("the created record carries the tool style, with No border and No fill preserved", () => {
    const d2 = placeCalloutAnchor(startCalloutDraft(1, { x: 10, y: 10 }, BOUNDS), { x: 100, y: 100 }, BOUNDS);
    const a = completeCalloutDraft(
      d2,
      { x: 300, y: 200 },
      BOUNDS,
      { ...STYLE, strokeWidth: 0, fill: "#FFF59D", bold: true, align: "center", fontSize: 18, textColor: "#123456" }
    );
    expect(a).toMatchObject({ strokeWidth: 0, fill: "#FFF59D", bold: true, align: "center", fontSize: 18, textColor: "#123456", corner: 8 });
    expect(serializeAnnotations([a])[0].strokeWidth).toBe(0);
  });

  test("4. an incomplete draft never produces a record", () => {
    expect(completeCalloutDraft(null, { x: 1, y: 1 }, BOUNDS, STYLE)).toBeNull();
    const d1 = startCalloutDraft(1, { x: 100, y: 120 }, BOUNDS);
    expect(completeCalloutDraft(d1, { x: 300, y: 300 }, BOUNDS, STYLE)).toBeNull();
    expect(completeCalloutDraft({ ...d1, stage: CALLOUT_STAGE.ANCHOR, anchor: null }, { x: 1, y: 1 }, BOUNDS, STYLE)).toBeNull();
  });
});

describe("preview feedback between clicks", () => {
  test("after click 1 the preview is a leader from the tip to the pointer", () => {
    const d1 = startCalloutDraft(1, { x: 100, y: 120 }, BOUNDS);
    const p = calloutDraftPreview(d1, { x: 250, y: 300 }, BOUNDS, 14);
    expect(p).toEqual({ stage: 1, tip: { x: 100, y: 120 }, to: { x: 250, y: 300 }, box: null });
    // No pointer position yet: the tip alone.
    expect(calloutDraftPreview(d1, null, BOUNDS, 14).to).toBeNull();
  });

  test("after click 2 the preview is the provisional box with the leader attached to it", () => {
    const d2 = placeCalloutAnchor(startCalloutDraft(1, { x: 100, y: 120 }, BOUNDS), { x: 200, y: 160 }, BOUNDS);
    const p = calloutDraftPreview(d2, { x: 380, y: 240 }, BOUNDS, 14);
    expect(p.stage).toBe(2);
    expect(p.box).toEqual({ x: 200, y: 160, w: 180, h: 80 });
    // The attachment is the box's nearest anchor to the tip: its top-left.
    expect(p.to).toEqual({ x: 200, y: 160 });
    // The preview box equals the box the third click would create there.
    const a = completeCalloutDraft(d2, { x: 380, y: 240 }, BOUNDS, STYLE);
    expect({ x: a.x, y: a.y, w: a.w, h: a.h }).toEqual(p.box);
  });

  test("no draft, no preview", () => {
    expect(calloutDraftPreview(null, { x: 1, y: 1 }, BOUNDS, 14)).toBeNull();
  });
});

describe("box sizing from the second and third clicks", () => {
  test("a horizontal-only third click still yields one text line of height, growing down from the anchor", () => {
    const box = calloutBoxFromPoints({ x: 100, y: 100 }, { x: 260, y: 100 }, BOUNDS, 14);
    expect(box).toEqual({ x: 100, y: 100, w: 160, h: calloutMinHeight(14) });
    expect(calloutMinHeight(14)).toBe(Math.ceil(14 * 1.25 + 12));
  });

  test("a very small third click never produces a box below the minimum size", () => {
    const box = calloutBoxFromPoints({ x: 100, y: 100 }, { x: 103, y: 101 }, BOUNDS, 14);
    expect(box.w).toBe(CALLOUT_MIN_WIDTH);
    expect(box.h).toBe(calloutMinHeight(14));
    expect(box.w).toBeGreaterThan(MIN_SHAPE_SIZE);
  });

  test("near the right/bottom edge the minimum box grows back INTO the page", () => {
    const box = calloutBoxFromPoints({ x: 595, y: 795 }, { x: 599, y: 799 }, BOUNDS, 14);
    expect(box.x + box.w).toBeLessThanOrEqual(600);
    expect(box.y + box.h).toBeLessThanOrEqual(800);
    expect(box.w).toBe(CALLOUT_MIN_WIDTH);
    expect(box.h).toBe(calloutMinHeight(14));
  });

  test("a third click outside the page is clamped to it", () => {
    const box = calloutBoxFromPoints({ x: 500, y: 700 }, { x: 900, y: 1200 }, BOUNDS, 14);
    expect(box).toEqual({ x: 500, y: 700, w: 100, h: 100 });
  });

  test("the minimum height follows the font size", () => {
    expect(calloutMinHeight(28)).toBeGreaterThan(calloutMinHeight(14));
    expect(calloutMinHeight(undefined)).toBe(calloutMinHeight(14));
    expect(calloutMinHeight(-3)).toBe(calloutMinHeight(14));
  });
});

/* --------------------------- zoom / scroll geometry ---------------------- */

describe("7/8. creation geometry is page space, independent of zoom and scroll", () => {
  // The overlay converts screen px to page space with (client − svgLeft) / scale
  // (PdfAnnotator.getLocal). The draft only ever sees page space, so the same
  // page-space clicks build the same callout whatever the zoom or offset.
  const clicks = [
    { x: 100, y: 120 },
    { x: 200, y: 160 },
    { x: 380, y: 240 },
  ];
  const build = (toPage) => {
    const d1 = startCalloutDraft(1, toPage(clicks[0]), BOUNDS);
    const d2 = placeCalloutAnchor(d1, toPage(clicks[1]), BOUNDS);
    return completeCalloutDraft(d2, toPage(clicks[2]), BOUNDS, STYLE);
  };
  const expected = { x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 } };
  const expectGeometry = (a) => {
    for (const k of ["x", "y", "w", "h"]) expect(a[k]).toBeCloseTo(expected[k], 9);
    expect(a.leader.x).toBeCloseTo(expected.leader.x, 9);
    expect(a.leader.y).toBeCloseTo(expected.leader.y, 9);
  };

  test.each([0.5, 1, 1.1, 2, 4])("zoom %s: screen clicks map back to the same page geometry", (scale) => {
    const screen = (p) => ({ x: p.x * scale, y: p.y * scale });
    const toPage = (p) => ({ x: screen(p).x / scale, y: screen(p).y / scale });
    expectGeometry(build(toPage));
  });

  test("a scrolled/offset page: the offset is removed before the division", () => {
    const scale = 2;
    const left = 137;
    const top = -412; // page scrolled partly above the viewport
    const client = (p) => ({ x: left + p.x * scale, y: top + p.y * scale });
    const toPage = (p) => ({ x: (client(p).x - left) / scale, y: (client(p).y - top) / scale });
    expectGeometry(build(toPage));
  });
});

/* ------------------------------ leader geometry -------------------------- */

const callout = (over = {}) => ({
  id: "c1",
  page: 1,
  type: "callout",
  x: 200,
  y: 160,
  w: 180,
  h: 80,
  leader: { x: 100, y: 120 },
  strokeWidth: 2,
  ...over,
});

describe("attached leader geometry", () => {
  test("eight attachment candidates: four edge midpoints and four corners", () => {
    const c = calloutAnchorCandidates(callout());
    expect(c).toHaveLength(8);
    expect(c).toContainEqual({ x: 290, y: 160 }); // top mid
    expect(c).toContainEqual({ x: 380, y: 200 }); // right mid
    expect(c).toContainEqual({ x: 290, y: 240 }); // bottom mid
    expect(c).toContainEqual({ x: 200, y: 200 }); // left mid
    expect(c).toContainEqual({ x: 200, y: 160 });
    expect(c).toContainEqual({ x: 380, y: 240 });
  });

  test("the leader attaches to the nearest candidate to the tip", () => {
    expect(calloutLeaderGeometry(callout()).anchor).toEqual({ x: 200, y: 160 }); // tip up-left → nw corner
    expect(calloutLeaderGeometry(callout({ leader: { x: 290, y: 20 } })).anchor).toEqual({ x: 290, y: 160 }); // above → top mid
    expect(calloutLeaderGeometry(callout({ leader: { x: 500, y: 200 } })).anchor).toEqual({ x: 380, y: 200 }); // right → right mid
    expect(calloutLeaderGeometry(callout({ leader: { x: 290, y: 400 } })).anchor).toEqual({ x: 290, y: 240 }); // below → bottom mid
  });

  test("the tip carries an arrowhead pointing at the tip, sized from the leader width", () => {
    const g = calloutLeaderGeometry(callout({ leader: { x: 290, y: 20 } }));
    expect(g.barbs).toHaveLength(2);
    for (const b of g.barbs) {
      // Both barbs sit behind the tip (towards the anchor), one each side.
      expect(b.y).toBeGreaterThan(20);
      expect(Math.hypot(b.x - 290, b.y - 20)).toBeCloseTo(g.headSize, 6);
    }
    const xs = g.barbs.map((b) => b.x).sort((p, q) => p - q);
    expect(xs[0]).toBeLessThan(290);
    expect(xs[1]).toBeGreaterThan(290);
    expect(g.width).toBe(2);
  });

  test("No border keeps a visible hairline leader (the callout's point must not vanish)", () => {
    expect(calloutLeaderGeometry(callout({ strokeWidth: 0 })).width).toBe(1.5);
    expect(calloutLeaderGeometry(callout({ strokeWidth: undefined })).width).toBe(1.5);
  });

  test("a tip sitting on its anchor draws no arrowhead rather than one at an arbitrary angle", () => {
    expect(calloutLeaderGeometry(callout({ leader: { x: 200, y: 160 } })).barbs).toEqual([]);
  });

  test("46. a historical callout without a stored leader still has one — the same one the export now draws", () => {
    const old = callout({ leader: undefined });
    expect(normalizeAnnotation(old).leader).toBeUndefined();
    const g = calloutLeaderGeometry(old);
    expect(g.tip).toEqual(defaultLeaderFor(old));
    expect(g.tip).toEqual({ x: 180, y: 140 });
    expect(g.anchor).toEqual({ x: 200, y: 160 });
  });

  test("a malformed callout (no box) has no leader geometry and never throws", () => {
    expect(calloutLeaderGeometry(null)).toBeNull();
    expect(calloutLeaderGeometry({ type: "callout" })).toBeNull();
    expect(calloutLeaderGeometry({ type: "callout", x: 1, y: 2 })).not.toBeNull(); // degenerate box: still safe
  });

  test("rotation: the attachment point rotates with the box about its centre, the tip does not", () => {
    const a = callout({ rotate: 90, leader: { x: 290, y: 20 } });
    const centre = { x: 290, y: 200 };
    const g = calloutLeaderGeometry(a);
    expect(g.tip).toEqual({ x: 290, y: 20 });
    // Rotated 90° clockwise, the box's LEFT edge midpoint (200,200) comes to
    // the top: (290, 110) — which is now the nearest point to a tip above.
    expect(near(g.anchor.x, rotatePointDeg({ x: 200, y: 200 }, centre, 90).x)).toBe(true);
    expect(near(g.anchor.y, rotatePointDeg({ x: 200, y: 200 }, centre, 90).y)).toBe(true);
    expect(near(g.anchor.x, 290) && near(g.anchor.y, 110)).toBe(true);
  });

  test("rotatePointDeg: 0° is identity; 180° reflects through the centre", () => {
    expect(rotatePointDeg({ x: 3, y: 4 }, { x: 0, y: 0 }, 0)).toEqual({ x: 3, y: 4 });
    const r = rotatePointDeg({ x: 3, y: 4 }, { x: 1, y: 1 }, 180);
    expect(near(r.x, -1) && near(r.y, -2)).toBe(true);
  });
});

/* ---------------------- attachment through editing ops ------------------- */

describe("9–11. the leader stays attached through the editing operations", () => {
  test("9. moving the text box (move-box: rect only) keeps the tip in place and the leader re-attaches", () => {
    const a = callout();
    const moved = { ...a, ...moveRect(a, 150, 300, BOUNDS) };
    expect(moved.leader).toEqual(a.leader);
    const g = calloutLeaderGeometry(moved);
    expect(g.tip).toEqual({ x: 100, y: 120 });
    // The box is now below-right of the tip; the nearest anchor is still the
    // nw corner — of the NEW box.
    expect(g.anchor).toEqual({ x: 350, y: 460 });
    expect(calloutAnchorCandidates(moved)).toContainEqual(g.anchor);
  });

  test("10. resizing the box keeps the connection valid (anchor always on the resized box)", () => {
    const a = callout({ leader: { x: 500, y: 200 } });
    const resized = { ...a, ...resizeRectCorner(a, "se", { x: 260, y: 300 }, BOUNDS) };
    expect(resized).toMatchObject({ x: 200, y: 160, w: 60, h: 140 });
    const g = calloutLeaderGeometry(resized);
    expect(calloutAnchorCandidates(resized)).toContainEqual(g.anchor);
    expect(g.anchor).toEqual({ x: 260, y: 230 }); // right mid of the new box
    expect(g.tip).toEqual({ x: 500, y: 200 });
  });

  test("11. moving the tip leaves the box in place and re-attaches the leader", () => {
    const a = callout();
    const tipMoved = { ...a, leader: { x: 290, y: 400 } };
    expect({ x: tipMoved.x, y: tipMoved.y, w: tipMoved.w, h: tipMoved.h }).toEqual({ x: 200, y: 160, w: 180, h: 80 });
    expect(calloutLeaderGeometry(tipMoved).anchor).toEqual({ x: 290, y: 240 });
  });

  test("a whole-annotation translation (multi-move, paste) carries the tip with the box", () => {
    const a = callout();
    const t = translateAnnotation(a, 30, 40, BOUNDS);
    expect(t).toMatchObject({ x: 230, y: 200, leader: { x: 130, y: 160 } });
    // Same relative geometry → same attachment point relative to the box.
    const g0 = calloutLeaderGeometry(a);
    const g1 = calloutLeaderGeometry(t);
    expect(g1.anchor).toEqual({ x: g0.anchor.x + 30, y: g0.anchor.y + 40 });
  });
});
