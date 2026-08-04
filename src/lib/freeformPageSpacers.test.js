// Behavioural tests for the Free-form editor's measured page PLAN
// (src/lib/freeformPageSpacers.js).
//
// Every case below is a real planning decision made from real (fixture)
// geometry — not an assertion about how the source is written. A "block" here
// is whatever the editor laid out as a top-level node: a paragraph, a heading,
// a list, a table, an image, a file card, a code block or a blockquote. The
// planner does not care which, and that is the point: it only ever breaks
// BETWEEN two of them.
import {
  MIN_VISUAL_PAGE_COUNT,
  naturalBlockGeometry,
  pageSpacerGapOffsetPx,
  pageSpacerHeightPx,
  planFreeformPageSpacers,
  samePageSpacerPlan,
} from "./freeformPageSpacers";

const CAPACITY = 1000; // one sheet's usable content height, px
const MARGIN = 76; // one paper margin, px
const GAP = 20; // the workspace gap between two sheets, px

/** A run of equal-height blocks laid out end to end, with no gaps between. */
function stack(heights, { start = 0, step = 2 } = {}) {
  const blocks = [];
  let top = start;
  let pos = 1;
  for (const height of heights) {
    blocks.push({ pos, top, bottom: top + height });
    top += height;
    pos += step;
  }
  return blocks;
}

const plan = (blocks, overrides = {}) =>
  planFreeformPageSpacers(blocks, {
    capacityPx: CAPACITY,
    marginPx: MARGIN,
    gapPx: GAP,
    ...overrides,
  });

/* ===================== Natural (spacer-free) coordinates ================== */

describe("naturalBlockGeometry removes the spacers' own height", () => {
  test("a document with no spacer is passed through unchanged", () => {
    const entries = [
      { spacer: false, pos: 1, top: 0, bottom: 100 },
      { spacer: false, pos: 5, top: 100, bottom: 260 },
    ];
    expect(naturalBlockGeometry(entries)).toEqual([
      { pos: 1, top: 0, bottom: 100 },
      { pos: 5, top: 100, bottom: 260 },
    ]);
  });

  test("blocks after a spacer are reported where they would be without it", () => {
    const entries = [
      { spacer: false, pos: 1, top: 0, bottom: 900 },
      { spacer: true, heightPx: 250 },
      { spacer: false, pos: 5, top: 1150, bottom: 1300 },
    ];
    expect(naturalBlockGeometry(entries)).toEqual([
      { pos: 1, top: 0, bottom: 900 },
      { pos: 5, top: 900, bottom: 1050 },
    ]);
  });

  test("several spacers accumulate", () => {
    const entries = [
      { spacer: false, pos: 1, top: 0, bottom: 100 },
      { spacer: true, heightPx: 200 },
      { spacer: false, pos: 3, top: 300, bottom: 400 },
      { spacer: true, heightPx: 150 },
      { spacer: false, pos: 5, top: 550, bottom: 650 },
    ];
    expect(naturalBlockGeometry(entries).map((b) => b.top)).toEqual([0, 100, 200]);
  });

  test("a spacer contributes no block of its own", () => {
    const entries = [
      { spacer: true, heightPx: 200 },
      { spacer: false, pos: 1, top: 200, bottom: 300 },
    ];
    const blocks = naturalBlockGeometry(entries);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].pos).toBe(1);
  });

  test("an unmeasured (zero-height) block is not inverted", () => {
    const blocks = naturalBlockGeometry([
      { spacer: false, pos: 1, top: 40, bottom: 10 },
    ]);
    expect(blocks[0].bottom).toBe(blocks[0].top);
  });

  test("junk input degrades to an empty list rather than throwing", () => {
    expect(naturalBlockGeometry(null)).toEqual([]);
    expect(naturalBlockGeometry(undefined)).toEqual([]);
    expect(naturalBlockGeometry([null, undefined])).toEqual([]);
  });
});

/* ============================== Spacer sizing ============================= */

describe("a spacer occupies the full boundary, not just a gap", () => {
  test("remainder of the ending sheet + its bottom margin + the gap + the next top margin", () => {
    expect(pageSpacerHeightPx({ fillPx: 300, marginPx: MARGIN, gapPx: GAP })).toBe(
      300 + MARGIN + GAP + MARGIN
    );
  });

  test("a boundary at an exact sheet fit is still margin + gap + margin", () => {
    expect(pageSpacerHeightPx({ fillPx: 0, marginPx: MARGIN, gapPx: GAP })).toBe(
      MARGIN + GAP + MARGIN
    );
  });

  test("an overrunning sheet never produces negative space", () => {
    expect(pageSpacerHeightPx({ fillPx: -400, marginPx: MARGIN, gapPx: GAP })).toBe(
      MARGIN + GAP + MARGIN
    );
  });

  test("the gap band starts after the remainder and the bottom margin", () => {
    expect(pageSpacerGapOffsetPx({ fillPx: 300, marginPx: MARGIN, gapPx: GAP })).toBe(
      376
    );
    expect(pageSpacerGapOffsetPx(null)).toBe(0);
  });

  test("the gap band always ends one top margin above the next sheet's content", () => {
    const spacer = { fillPx: 120, marginPx: MARGIN, gapPx: GAP };
    const height = pageSpacerHeightPx(spacer);
    const gapEnd = pageSpacerGapOffsetPx(spacer) + GAP;
    expect(height - gapEnd).toBe(MARGIN);
  });
});

/* ================================ Planning ================================ */

describe("a document that fits on one sheet", () => {
  test("gets no spacer at all", () => {
    const result = plan(stack([200, 300, 400]));
    expect(result.pageCount).toBe(1);
    expect(result.spacers).toEqual([]);
  });

  test("an empty document is still one sheet", () => {
    const result = plan([]);
    expect(result.pageCount).toBe(MIN_VISUAL_PAGE_COUNT);
    expect(result.spacers).toEqual([]);
    expect(result.columnHeightPx).toBe(CAPACITY);
  });

  test("content that exactly fills the sheet does not start a second one", () => {
    expect(plan(stack([500, 500])).pageCount).toBe(1);
  });

  test("a fraction of a pixel over an exact fit is still one sheet", () => {
    expect(plan(stack([500, 500.25])).pageCount).toBe(1);
  });

  test("the column still reserves a whole sheet, so the paper is not cut short", () => {
    expect(plan(stack([120])).columnHeightPx).toBe(CAPACITY);
  });
});

describe("a block that would cross the sheet bottom moves down instead", () => {
  test("the boundary is placed BEFORE that block, at its own start position", () => {
    const blocks = stack([600, 300, 300]); // third block ends at 1200 > 1000
    const result = plan(blocks);
    expect(result.pageCount).toBe(2);
    expect(result.spacers).toHaveLength(1);
    expect(result.spacers[0].pos).toBe(blocks[2].pos);
  });

  test("a boundary position is always a block start — never inside one", () => {
    const blocks = stack([420, 420, 420, 420, 420]);
    const starts = blocks.map((b) => b.pos);
    for (const spacer of plan(blocks).spacers) {
      expect(starts).toContain(spacer.pos);
    }
  });

  test("no sentence is left in the bottom margin: the sheet's remainder is filled", () => {
    // Two 400px blocks fill 800 of 1000; the third would reach 1200.
    const result = plan(stack([400, 400, 400]));
    const spacer = result.spacers[0];
    // The 200px of unused sheet, then the bottom margin, gap and top margin.
    expect(spacer.fillPx).toBe(200);
    expect(spacer.heightPx).toBe(200 + MARGIN + GAP + MARGIN);
  });

  test("the next sheet begins below a real top margin", () => {
    const spacer = plan(stack([400, 400, 400])).spacers[0];
    expect(spacer.marginPx).toBe(MARGIN);
    expect(spacer.heightPx - (pageSpacerGapOffsetPx(spacer) + spacer.gapPx)).toBe(
      MARGIN
    );
  });

  test("there is a genuine visible workspace gap between the two sheets", () => {
    expect(plan(stack([400, 400, 400])).spacers[0].gapPx).toBe(GAP);
  });

  test("sheets are numbered from 2 upwards — the sheet each boundary introduces", () => {
    const result = plan(stack([600, 600, 600, 600, 600]));
    expect(result.spacers.map((s) => s.page)).toEqual([2, 3, 4, 5]);
    expect(result.pageCount).toBe(5);
  });

  test("block order is preserved: boundary positions strictly increase", () => {
    const positions = plan(stack(new Array(12).fill(300))).spacers.map((s) => s.pos);
    const sorted = positions.slice().sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
    expect(new Set(positions).size).toBe(positions.length);
  });

  test("each sheet's own measurement restarts from that sheet's top", () => {
    // 3 x 600px: block 2 starts sheet 2 (600+600 > 1000), block 3 measures
    // against sheet 2's top (600), so 1800-600 = 1200 > 1000 → sheet 3.
    const result = plan(stack([600, 600, 600]));
    expect(result.pageCount).toBe(3);
  });
});

describe("oversized blocks are deterministic and never fragmented", () => {
  test("a block taller than one sheet stays whole and overruns its sheet", () => {
    const result = plan(stack([2500]));
    expect(result.spacers).toEqual([]);
    expect(result.pageCount).toBe(1);
  });

  test("the block AFTER an oversized one starts a new sheet", () => {
    const blocks = stack([2500, 100]);
    const result = plan(blocks);
    expect(result.spacers).toHaveLength(1);
    expect(result.spacers[0].pos).toBe(blocks[1].pos);
  });

  test("an oversized block never produces negative space at its boundary", () => {
    expect(plan(stack([2500, 100])).spacers[0].fillPx).toBe(0);
  });

  test("consecutive oversized blocks each get their own sheet, and it terminates", () => {
    const result = plan(stack([2500, 2500, 2500]));
    expect(result.pageCount).toBe(3);
    expect(result.spacers).toHaveLength(2);
  });

  test("the first block on a sheet never triggers a boundary, however tall", () => {
    // Without that rule this input would loop forever producing empty sheets.
    const result = plan(stack([50, 100000]));
    expect(result.pageCount).toBe(2);
    expect(result.spacers).toHaveLength(1);
  });

  test("a lone oversized block still reserves at least its own height", () => {
    expect(plan(stack([2500])).columnHeightPx).toBe(2500);
  });
});

describe("the reserved paper column", () => {
  test("reserves one whole sheet per page plus every spacer's height", () => {
    const result = plan(stack([400, 400, 400]));
    expect(result.columnHeightPx).toBe(
      /* sheet 2 natural top */ 800 + result.spacers[0].heightPx + CAPACITY
    );
  });

  test("grows with the page count", () => {
    const one = plan(stack([300])).columnHeightPx;
    const three = plan(stack([600, 600, 600])).columnHeightPx;
    expect(three).toBeGreaterThan(one * 2);
  });

  test("is zero when nothing is measurable yet, so no min-height is applied", () => {
    expect(plan(stack([300]), { capacityPx: 0 }).columnHeightPx).toBe(0);
    expect(plan(stack([300]), { capacityPx: NaN }).columnHeightPx).toBe(0);
  });
});

describe("an unmeasurable layout degrades rather than guessing", () => {
  test("no capacity means one sheet and no boundaries", () => {
    for (const capacityPx of [0, -100, NaN, undefined, null]) {
      const result = plan(stack([400, 400, 400]), { capacityPx });
      expect(result.pageCount).toBe(1);
      expect(result.spacers).toEqual([]);
    }
  });

  test("junk block input degrades to one sheet", () => {
    expect(plan(null).pageCount).toBe(1);
    expect(plan(undefined).spacers).toEqual([]);
    expect(plan([null, undefined]).pageCount).toBe(1);
  });

  test("the plan and its spacers are frozen — a consumer cannot mutate them", () => {
    const result = plan(stack([400, 400, 400]));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.spacers)).toBe(true);
    expect(Object.isFrozen(result.spacers[0])).toBe(true);
  });
});

/* ============================== Plan stability ============================= */

describe("the plan is stable, so measurement cannot feed itself", () => {
  test("re-measuring an unchanged layout produces an equal plan", () => {
    const blocks = stack([400, 400, 400, 400]);
    expect(samePageSpacerPlan(plan(blocks), plan(blocks))).toBe(true);
  });

  test("measuring the SAME document through its own rendered spacers is unchanged", () => {
    // Pass 1: no spacer on screen yet.
    const first = plan(stack([400, 400, 400]));
    const spacerHeight = first.spacers[0].heightPx;

    // Pass 2: the DOM now contains that spacer, so the third block is pushed
    // down by exactly its height. Natural coordinates take it back out again.
    const rendered = naturalBlockGeometry([
      { spacer: false, pos: 1, top: 0, bottom: 400 },
      { spacer: false, pos: 3, top: 400, bottom: 800 },
      { spacer: true, heightPx: spacerHeight },
      {
        spacer: false,
        pos: 5,
        top: 800 + spacerHeight,
        bottom: 1200 + spacerHeight,
      },
    ]);
    const second = planFreeformPageSpacers(rendered, {
      capacityPx: CAPACITY,
      marginPx: MARGIN,
      gapPx: GAP,
    });

    expect(samePageSpacerPlan(first, second)).toBe(true);
  });

  test("sub-pixel jitter is not a change", () => {
    const a = plan(stack([400, 400, 400]));
    const b = plan(stack([400.2, 400, 400]));
    expect(samePageSpacerPlan(a, b)).toBe(true);
  });

  test("a real content change IS a change", () => {
    expect(samePageSpacerPlan(plan(stack([400, 400, 400])), plan(stack([400])))).toBe(
      false
    );
  });

  test("a width change (different capacity, margin and gap) IS a change", () => {
    const blocks = stack([400, 400, 400]);
    const wide = plan(blocks);
    const narrow = plan(blocks, { capacityPx: 500, marginPx: 38, gapPx: 10 });
    expect(samePageSpacerPlan(wide, narrow)).toBe(false);
  });

  test("a moved boundary IS a change, even at the same page count", () => {
    const a = plan(stack([400, 400, 400]));
    const b = plan(stack([900, 400, 400]));
    expect(a.pageCount).toBe(b.pageCount);
    expect(samePageSpacerPlan(a, b)).toBe(false);
  });

  test("comparison is total: a null plan is never equal to a real one", () => {
    expect(samePageSpacerPlan(null, plan(stack([300])))).toBe(false);
    expect(samePageSpacerPlan(plan(stack([300])), null)).toBe(false);
    expect(samePageSpacerPlan(null, null)).toBe(true);
  });
});

/* ============================ Deleting content ============================= */

describe("removing content collapses the sheets again", () => {
  test("deleting the block that caused a boundary removes that boundary", () => {
    expect(plan(stack([400, 400, 400])).pageCount).toBe(2);
    expect(plan(stack([400, 400])).pageCount).toBe(1);
  });

  test("shrinking a block pulls the following one back onto the sheet", () => {
    expect(plan(stack([600, 300, 300])).pageCount).toBe(2);
    expect(plan(stack([200, 300, 300])).pageCount).toBe(1);
  });
});
