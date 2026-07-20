// Automated checks for PDF find/search result calculation (src/lib/pdfSearch.js).
import {
  buildPageIndex,
  findMatchesInPage,
  findMatchesInDocument,
  matchRects,
  textItemToPageRect,
} from "./pdfSearch";

// Identity-ish scale-1 viewport transform of an unrotated page (y-flip).
const VIEWPORT = [1, 0, 0, -1, 0, 792];

// Build a minimal pdf.js-like text item: 12pt text at user-space (x, yBaseline).
function item(str, x, yBaseline, width) {
  return {
    str,
    width,
    hasEOL: false,
    transform: [12, 0, 0, 12, x, yBaseline],
  };
}

describe("textItemToPageRect", () => {
  test("places the item rect in page space (y-down)", () => {
    const r = textItemToPageRect(item("Hello", 100, 700, 50), VIEWPORT);
    expect(r.x).toBeCloseTo(100);
    // baseline at user y=700 -> page y = 92; top = baseline - fontHeight
    expect(r.y).toBeCloseTo(92 - 12);
    expect(r.w).toBeCloseTo(50);
    expect(r.h).toBeGreaterThan(12);
  });

  test("returns null for empty items", () => {
    expect(textItemToPageRect({ str: "" }, VIEWPORT)).toBeNull();
  });
});

function makeIndex(items) {
  return buildPageIndex({ items }, VIEWPORT);
}

describe("findMatchesInPage", () => {
  const index = makeIndex([
    item("Site inspection report", 50, 700, 150),
    item("Inspection date: March", 50, 680, 140),
  ]);

  test("zero matches", () => {
    expect(findMatchesInPage(index, "zebra")).toHaveLength(0);
  });

  test("one match, case-insensitive", () => {
    const m = findMatchesInPage(index, "REPORT");
    expect(m).toHaveLength(1);
    expect(m[0].rects.length).toBeGreaterThan(0);
  });

  test("many matches across items", () => {
    const m = findMatchesInPage(index, "inspection");
    expect(m).toHaveLength(2);
  });

  test("empty/whitespace query returns nothing", () => {
    expect(findMatchesInPage(index, "  ")).toHaveLength(0);
    expect(findMatchesInPage(index, "")).toHaveLength(0);
  });

  test("words do not fuse across item boundaries", () => {
    // "report" ends item 1, "Inspection" starts item 2 — "reportInspection"
    // must NOT match because a separator is inserted between items.
    expect(findMatchesInPage(index, "reportinspection")).toHaveLength(0);
  });
});

describe("matchRects", () => {
  test("sub-slices an item proportionally by character position", () => {
    const index = makeIndex([item("abcdefghij", 100, 700, 100)]); // 10 chars, 100 wide
    const rects = matchRects(index, 2, 5); // "cde"
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBeCloseTo(120);
    expect(rects[0].w).toBeCloseTo(30);
  });

  test("a match spanning two items yields a rect per item", () => {
    const index = makeIndex([
      item("Hello", 50, 700, 50),
      item("world", 110, 700, 50),
    ]);
    // Items are joined with a separator space, so "hello world" spans both.
    const m = findMatchesInPage(index, "hello world");
    expect(m).toHaveLength(1);
    expect(m[0].rects).toHaveLength(2);
    expect(m[0].rects[0].x).toBeCloseTo(50);
    expect(m[0].rects[1].x).toBeCloseTo(110);
  });
});

describe("findMatchesInDocument", () => {
  test("aggregates matches across pages in page order", () => {
    const pageIndexes = {
      2: makeIndex([item("crack in wall", 50, 700, 100)]),
      1: makeIndex([item("crack in slab, crack in beam", 50, 700, 220)]),
    };
    const all = findMatchesInDocument(pageIndexes, "crack");
    expect(all).toHaveLength(3);
    expect(all.map((m) => m.page)).toEqual([1, 1, 2]);
  });

  test("no matches anywhere", () => {
    const pageIndexes = { 1: makeIndex([item("nothing here", 0, 700, 90)]) };
    expect(findMatchesInDocument(pageIndexes, "zzz")).toHaveLength(0);
  });
});
