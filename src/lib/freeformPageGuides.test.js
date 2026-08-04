// Unit tests for the Free-form editor's pure visual page GEOMETRY
// (src/lib/freeformPageGuides.js).
//
// Deterministic numeric fixtures only — no DOM, no layout, no browser
// measurement. The measured PLAN built on top of this geometry is verified in
// freeformPageSpacers.test.js; the hook that feeds both real measurements is
// verified by freeformPagedEditorWiring.test.js.
import {
  FREEFORM_PAGE_GUIDE_CAPTION,
  PAGE_FIT_EPSILON_PX,
  PAGE_GAP_MIN_PX,
  PAGE_GAP_PX,
  VISUAL_PAGE_ASPECT,
  VISUAL_PAGE_MARGIN_RATIO,
  visualPageContentHeight,
  visualPageMarginHeight,
  visualPageWorkspaceGap,
} from "./freeformPageGuides";
import {
  PAGE_MARGIN_MM,
  PAGE_SIZE_MM,
  USABLE_HEIGHT_PX,
  USABLE_WIDTH_PX,
} from "./pageGeometry";

describe("visual page geometry is the shared A4 usable-box ratio", () => {
  test("the aspect is 257mm of usable height per 170mm of usable width", () => {
    expect(VISUAL_PAGE_ASPECT).toBeCloseTo(257 / 170, 9);
  });

  test("it is read from the shared page geometry, not restated", () => {
    expect(VISUAL_PAGE_ASPECT).toBe(USABLE_HEIGHT_PX / USABLE_WIDTH_PX);
  });

  test("the real 170mm usable width yields the real 257mm usable height", () => {
    expect(visualPageContentHeight(USABLE_WIDTH_PX)).toBeCloseTo(
      USABLE_HEIGHT_PX,
      6
    );
  });

  test("the page height scales with the CONTENT width, so a narrower column keeps A4 proportions", () => {
    const full = visualPageContentHeight(680);
    const half = visualPageContentHeight(340);
    expect(half).toBeCloseTo(full / 2, 9);
  });

  test("an unmeasured or nonsensical width reports 0 rather than guessing", () => {
    expect(visualPageContentHeight(0)).toBe(0);
    expect(visualPageContentHeight(-500)).toBe(0);
    expect(visualPageContentHeight(NaN)).toBe(0);
    expect(visualPageContentHeight(undefined)).toBe(0);
    expect(visualPageContentHeight(null)).toBe(0);
  });

  test("a sub-pixel fit tolerance exists, so an exact fit is not a second page", () => {
    expect(PAGE_FIT_EPSILON_PX).toBeGreaterThan(0);
    expect(PAGE_FIT_EPSILON_PX).toBeLessThan(1);
  });
});

describe("paper margin depth", () => {
  test("the ratio is the shared 20mm margin over the shared 170mm usable width", () => {
    expect(VISUAL_PAGE_MARGIN_RATIO).toBeCloseTo(20 / 170, 9);
    expect(VISUAL_PAGE_MARGIN_RATIO).toBeCloseTo(
      PAGE_MARGIN_MM.top /
        (PAGE_SIZE_MM.width - PAGE_MARGIN_MM.left - PAGE_MARGIN_MM.right),
      9
    );
  });

  test("at the real A4 content width the margin is the real 20mm", () => {
    const twentyMm = (USABLE_WIDTH_PX / 170) * 20;
    expect(visualPageMarginHeight(USABLE_WIDTH_PX)).toBeCloseTo(twentyMm, 6);
  });

  test("a full sheet is always taller than its two margins combined", () => {
    for (const width of [200, 400, USABLE_WIDTH_PX, 900]) {
      expect(visualPageContentHeight(width)).toBeGreaterThan(
        visualPageMarginHeight(width) * 2
      );
    }
  });

  test("it narrows with the paper, keeping every sheet's proportions", () => {
    expect(visualPageMarginHeight(340)).toBeCloseTo(
      visualPageMarginHeight(680) / 2,
      9
    );
  });

  test("an unmeasured width reports 0, so no padding is applied before layout", () => {
    expect(visualPageMarginHeight(0)).toBe(0);
    expect(visualPageMarginHeight(NaN)).toBe(0);
    expect(visualPageMarginHeight(undefined)).toBe(0);
  });
});

describe("the workspace gap between two sheets", () => {
  test("is a restrained physical separation, 16–24px at a normal desktop width", () => {
    const gap = visualPageWorkspaceGap(USABLE_WIDTH_PX);
    expect(gap).toBeGreaterThanOrEqual(16);
    expect(gap).toBeLessThanOrEqual(24);
    expect(gap).toBeCloseTo(PAGE_GAP_PX, 6);
  });

  test("reduces on a narrower paper, but never collapses to a hairline", () => {
    const narrow = visualPageWorkspaceGap(USABLE_WIDTH_PX / 2);
    expect(narrow).toBeLessThan(visualPageWorkspaceGap(USABLE_WIDTH_PX));
    expect(narrow).toBeGreaterThanOrEqual(PAGE_GAP_MIN_PX);
  });

  test("is floored at the minimum however narrow the screen gets", () => {
    expect(visualPageWorkspaceGap(1)).toBe(PAGE_GAP_MIN_PX);
    expect(visualPageWorkspaceGap(80)).toBe(PAGE_GAP_MIN_PX);
  });

  test("never exceeds the desktop gap on an unusually wide paper", () => {
    expect(visualPageWorkspaceGap(USABLE_WIDTH_PX * 4)).toBe(PAGE_GAP_PX);
  });

  test("is monotonic in the paper width", () => {
    let previous = 0;
    for (const width of [50, 150, 300, 450, 600, USABLE_WIDTH_PX, 1200]) {
      const gap = visualPageWorkspaceGap(width);
      expect(gap).toBeGreaterThanOrEqual(previous);
      previous = gap;
    }
  });

  test("an unmeasured width reports 0, so no gap is drawn before layout", () => {
    expect(visualPageWorkspaceGap(0)).toBe(0);
    expect(visualPageWorkspaceGap(NaN)).toBe(0);
  });
});

describe("honest wording caption", () => {
  test("is the exact required sentence", () => {
    expect(FREEFORM_PAGE_GUIDE_CAPTION).toBe(
      "Approximate page layout — use Document Preview and select PDF for exact export pages."
    );
  });

  test("states the layout is approximate and names Document Preview + PDF as the exact alternative", () => {
    expect(FREEFORM_PAGE_GUIDE_CAPTION).toMatch(/approximate/i);
    expect(FREEFORM_PAGE_GUIDE_CAPTION).toMatch(/Document Preview/);
    expect(FREEFORM_PAGE_GUIDE_CAPTION).toMatch(/select PDF/);
    expect(FREEFORM_PAGE_GUIDE_CAPTION).toMatch(/exact export pages/i);
  });

  test("is one static string, not a per-page-count template", () => {
    expect(typeof FREEFORM_PAGE_GUIDE_CAPTION).toBe("string");
  });
});
