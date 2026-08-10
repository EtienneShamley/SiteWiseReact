// Unit tests for the pure block-pagination logic (src/lib/paginateBlocks.js).
// These cover the invariants the page-aware document depends on: order, no
// drops/duplicates, exact-fit, overflow-to-next-page, automatic multi-page
// creation, oversized blocks, the preferred/minimum-height rule, the
// split-capable interface, and that page assignment is purely derived.
import {
  paginateBlocks,
  resolveBlockHeight,
  annotateGroupContinuations,
  countPages,
  placedBlockIds,
  FIT_EPSILON_PX,
} from "./paginateBlocks";

const USABLE = 1000;

// Helper: build simple blocks.
const B = (id, height, extra = {}) => ({ id, height, ...extra });

describe("resolveBlockHeight (preferred/minimum height rule)", () => {
  test("uses the preferred height when content is shorter", () => {
    expect(resolveBlockHeight(120, 80)).toBe(120);
  });
  test("grows past the preferred height when content is taller", () => {
    expect(resolveBlockHeight(120, 300)).toBe(300);
  });
  test("treats missing values as 0", () => {
    expect(resolveBlockHeight(undefined, undefined)).toBe(0);
    expect(resolveBlockHeight(150, undefined)).toBe(150);
  });
});

describe("basic distribution", () => {
  test("blocks that all fit stay on a single page in order", () => {
    const res = paginateBlocks(
      [B("a", 200), B("b", 300), B("c", 400)],
      USABLE
    );
    expect(countPages(res)).toBe(1);
    expect(placedBlockIds(res)).toEqual(["a", "b", "c"]);
  });

  test("a block that does not fit the remaining space moves to the next page whole", () => {
    // 600 + 500 = 1100 > 1000 -> b moves to page 2, kept whole.
    const res = paginateBlocks([B("a", 600), B("b", 500)], USABLE);
    expect(countPages(res)).toBe(2);
    expect(res.pages[0].map((x) => x.id)).toEqual(["a"]);
    expect(res.pages[1].map((x) => x.id)).toEqual(["b"]);
  });

  test("an exact-fit block fills the page and the next starts a new page", () => {
    const res = paginateBlocks(
      [B("a", 400), B("b", 600), B("c", 100)],
      USABLE
    );
    // a+b = 1000 (exact fit) on page 1; c on page 2.
    expect(res.pages[0].map((x) => x.id)).toEqual(["a", "b"]);
    expect(res.pages[1].map((x) => x.id)).toEqual(["c"]);
  });

  test("sub-pixel overflow within epsilon still fits the same page", () => {
    const res = paginateBlocks(
      [B("a", 500), B("b", 500 + FIT_EPSILON_PX / 2)],
      USABLE
    );
    expect(countPages(res)).toBe(1);
  });
});

describe("automatic multi-page creation", () => {
  test("creates as many pages as needed for a long run of blocks", () => {
    // 10 blocks of 300 into 1000 usable -> 3 per page -> 4 pages.
    const blocks = Array.from({ length: 10 }, (_, i) => B(`r${i}`, 300));
    const res = paginateBlocks(blocks, USABLE);
    expect(countPages(res)).toBe(4);
    expect(res.pages[0].map((x) => x.id)).toEqual(["r0", "r1", "r2"]);
    expect(res.pages[3].map((x) => x.id)).toEqual(["r9"]);
  });
});

describe("no dropped or duplicated blocks, order preserved", () => {
  test("every block appears exactly once, in original order", () => {
    const blocks = Array.from({ length: 25 }, (_, i) =>
      B(`b${i}`, 100 + (i % 5) * 120)
    );
    const res = paginateBlocks(blocks, USABLE);
    const ids = placedBlockIds(res);
    expect(ids).toEqual(blocks.map((b) => b.id)); // same order, none lost
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });
});

describe("oversized blocks", () => {
  test("a block taller than a whole usable page gets its own page", () => {
    const res = paginateBlocks(
      [B("small", 200), B("huge", 1500), B("after", 200)],
      USABLE
    );
    expect(countPages(res)).toBe(3);
    expect(res.pages[0].map((x) => x.id)).toEqual(["small"]);
    expect(res.pages[1].map((x) => x.id)).toEqual(["huge"]);
    expect(res.pages[2].map((x) => x.id)).toEqual(["after"]);
  });

  test("a leading oversized block still gets its own page and is not dropped", () => {
    const res = paginateBlocks([B("huge", 3000), B("b", 100)], USABLE);
    expect(res.pages[0].map((x) => x.id)).toEqual(["huge"]);
    expect(res.pages[1].map((x) => x.id)).toEqual(["b"]);
    expect(placedBlockIds(res)).toEqual(["huge", "b"]);
  });
});

describe("stability (page assignment is deterministic and position-independent)", () => {
  test("re-running with identical input yields identical pages", () => {
    const blocks = [B("a", 400), B("b", 700), B("c", 250), B("d", 900)];
    const first = paginateBlocks(blocks, USABLE);
    const second = paginateBlocks(blocks, USABLE);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("split-capable interface", () => {
  test("without a splitter, a splittable block behaves as a whole block", () => {
    const res = paginateBlocks(
      [B("a", 600), B("t", 700, { splittable: true })],
      USABLE
    );
    expect(countPages(res)).toBe(2);
    expect(placedBlockIds(res)).toEqual(["a", "t"]);
  });

  test("a supplied splitter slices a splittable block across the boundary", () => {
    // 'a' fills 600; 't' (700, splittable) doesn't fit the remaining 400.
    // Splitter puts a 400 head on page 1 and a 300 tail on page 2.
    const splitBlock = (block, available) => ({
      head: { id: block.id, height: available, splittable: true },
      tail: { id: block.id, height: block.height - available, splittable: true },
    });
    const res = paginateBlocks(
      [B("a", 600), B("t", 700, { splittable: true })],
      USABLE,
      { splitBlock }
    );
    expect(countPages(res)).toBe(2);
    // head shares the first page with 'a'; tail on the second page.
    expect(res.pages[0].map((x) => x.id)).toEqual(["a", "t"]);
    expect(res.pages[0][1].part).toBe("head");
    expect(res.pages[0][1].continuesToNextPage).toBe(true);
    expect(res.pages[1].map((x) => x.id)).toEqual(["t"]);
    expect(res.pages[1][0].part).toBe("tail");
    expect(res.pages[1][0].continuedFromPrevPage).toBe(true);
  });

  test("a non-splittable block is never sliced even with a splitter present", () => {
    const splitBlock = () => {
      throw new Error("splitter should not be called for a whole block");
    };
    const res = paginateBlocks(
      [B("a", 600), B("b", 700)], // b is NOT splittable
      USABLE,
      { splitBlock }
    );
    expect(countPages(res)).toBe(2);
    expect(placedBlockIds(res)).toEqual(["a", "b"]);
  });
});

describe("degenerate input", () => {
  test("an empty document yields exactly one (empty) page", () => {
    const res = paginateBlocks([], USABLE);
    expect(countPages(res)).toBe(1);
    expect(res.pages[0]).toEqual([]);
  });

  test("a non-positive usable height falls back to one page with all blocks", () => {
    const res = paginateBlocks([B("a", 100), B("b", 200)], 0);
    expect(countPages(res)).toBe(1);
    expect(placedBlockIds(res)).toEqual(["a", "b"]);
  });
});

describe("derived, not persisted", () => {
  test("placed descriptors carry no page-number field on the block", () => {
    const res = paginateBlocks([B("a", 100), B("b", 1200)], USABLE);
    for (const page of res.pages) {
      for (const block of page) {
        expect(block).not.toHaveProperty("pageNumber");
        expect(block).not.toHaveProperty("page");
      }
    }
  });
});

describe("compound attachment fields: atomic photo blocks", () => {
  test("a photo block that does not fit moves whole to the next page (never split)", () => {
    const res = paginateBlocks(
      [B("head", 100), B("photo-1", 600, { group: "f" }), B("photo-2", 600, { group: "f" })],
      USABLE
    );
    expect(countPages(res)).toBe(2);
    expect(res.pages[0].map((b) => b.id)).toEqual(["head", "photo-1"]);
    expect(res.pages[1].map((b) => b.id)).toEqual(["photo-2"]);
    // Whole blocks only — no head/tail parts.
    for (const page of res.pages) {
      for (const b of page) expect(b.part).toBeUndefined();
    }
  });

  test("multi-photo fields continue across pages with exact order and no drops/dupes", () => {
    const blocks = [
      B("head", 80, { group: "f", keepWithNext: true }),
      ...Array.from({ length: 6 }, (_, i) => B(`p${i}`, 400, { group: "f" })),
    ];
    const res = paginateBlocks(blocks, USABLE);
    expect(placedBlockIds(res)).toEqual(["head", "p0", "p1", "p2", "p3", "p4", "p5"]);
  });
});

describe("keepWithNext (no orphaned field headings)", () => {
  test("a header alone at a page bottom moves to the next page with its first attachment", () => {
    // filler leaves exactly 100px; header (80) would fit alone, but its
    // partner (400) would not — both must move together.
    const res = paginateBlocks(
      [
        B("filler", 900),
        B("head", 80, { group: "f", keepWithNext: true }),
        B("p0", 400, { group: "f" }),
      ],
      USABLE
    );
    expect(countPages(res)).toBe(2);
    expect(res.pages[0].map((b) => b.id)).toEqual(["filler"]);
    expect(res.pages[1].map((b) => b.id)).toEqual(["head", "p0"]);
  });

  test("the pair stays where it is when both fit the remaining space", () => {
    const res = paginateBlocks(
      [
        B("filler", 400),
        B("head", 80, { group: "f", keepWithNext: true }),
        B("p0", 400, { group: "f" }),
      ],
      USABLE
    );
    expect(countPages(res)).toBe(1);
  });

  test("a pair taller than a whole page still stays together (page grows)", () => {
    const res = paginateBlocks(
      [
        B("filler", 500),
        B("head", 80, { group: "f", keepWithNext: true }),
        B("p0", USABLE - 20, { group: "f" }),
      ],
      USABLE
    );
    expect(countPages(res)).toBe(2);
    expect(res.pages[1].map((b) => b.id)).toEqual(["head", "p0"]);
  });

  test("keepWithNext on the last block is a no-op", () => {
    const res = paginateBlocks([B("head", 80, { keepWithNext: true })], USABLE);
    expect(countPages(res)).toBe(1);
    expect(placedBlockIds(res)).toEqual(["head"]);
  });
});

describe("annotateGroupContinuations", () => {
  test("marks the first block of a page that resumes the previous page's group", () => {
    const res = paginateBlocks(
      [
        B("head", 100, { group: "f", keepWithNext: true }),
        B("p0", 600, { group: "f" }),
        B("p1", 600, { group: "f" }),
        B("p2", 600, { group: "f" }),
      ],
      USABLE
    );
    annotateGroupContinuations(res.pages);
    expect(countPages(res)).toBe(3);
    // Page 2 and 3 resume the same field.
    expect(res.pages[1][0].continuedFromPrevPage).toBe(true);
    expect(res.pages[2][0].continuedFromPrevPage).toBe(true);
    // The field's first page is NOT a continuation.
    expect(res.pages[0][0].continuedFromPrevPage).toBeUndefined();
  });

  test("does not mark a page whose first block belongs to a different group", () => {
    const res = paginateBlocks(
      [B("a", 900, { group: "f1" }), B("b", 900, { group: "f2" })],
      USABLE
    );
    annotateGroupContinuations(res.pages);
    expect(res.pages[1][0].continuedFromPrevPage).toBeUndefined();
  });

  test("ungrouped blocks are never marked", () => {
    const res = paginateBlocks([B("a", 900), B("b", 900)], USABLE);
    annotateGroupContinuations(res.pages);
    expect(res.pages[1][0].continuedFromPrevPage).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* groupContinuesBelow — composing one group into ONE visible section          */
/* -------------------------------------------------------------------------- */

describe("groupContinuesBelow (same-page composition)", () => {
  test("every block of a group except the last on the page is marked", () => {
    // A section holding text, a photo and more text is ONE section of the
    // document. Only its last block on the page closes it; the ones before it
    // flow straight into the next, so no divider is drawn between two items
    // that belong together.
    const res = paginateBlocks(
      [
        B("head", 100, { group: "r1", keepWithNext: true }),
        B("photo", 100, { group: "r1" }),
        B("text", 100, { group: "r1" }),
      ],
      USABLE
    );
    annotateGroupContinuations(res.pages);
    expect(countPages(res)).toBe(1);
    expect(res.pages[0][0].groupContinuesBelow).toBe(true);
    expect(res.pages[0][1].groupContinuesBelow).toBe(true);
    // The last block of the section closes it.
    expect(res.pages[0][2].groupContinuesBelow).toBeUndefined();
  });

  test("the next block belonging to a DIFFERENT row is not composed", () => {
    // The following Template section must keep its own separating edge.
    const res = paginateBlocks(
      [
        B("r1-head", 100, { group: "r1" }),
        B("r1-photo", 100, { group: "r1" }),
        B("r2-head", 100, { group: "r2" }),
        B("r2-photo", 100, { group: "r2" }),
      ],
      USABLE
    );
    annotateGroupContinuations(res.pages);
    expect(res.pages[0][0].groupContinuesBelow).toBe(true);
    // Last block of row 1: the next block is another row.
    expect(res.pages[0][1].groupContinuesBelow).toBeUndefined();
    expect(res.pages[0][2].groupContinuesBelow).toBe(true);
    expect(res.pages[0][3].groupContinuesBelow).toBeUndefined();
  });

  test("ungrouped blocks are never composed with their neighbours", () => {
    // An ordinary single-block row keeps its complete outline.
    const res = paginateBlocks([B("a", 100), B("b", 100)], USABLE);
    annotateGroupContinuations(res.pages);
    expect(res.pages[0][0].groupContinuesBelow).toBeUndefined();
    expect(res.pages[0][1].groupContinuesBelow).toBeUndefined();
  });

  test("composition is SAME-PAGE only; a page boundary uses continuation instead", () => {
    // Across a page the section genuinely stops and resumes, which is exactly
    // what the "Label — continued" context is for.
    const res = paginateBlocks(
      [
        B("head", 400, { group: "r1" }),
        B("photo", 400, { group: "r1" }),
        B("text", 400, { group: "r1" }),
      ],
      USABLE
    );
    annotateGroupContinuations(res.pages);
    expect(countPages(res)).toBe(2);
    // Page 1 holds head + photo: they compose into one section…
    expect(res.pages[0]).toHaveLength(2);
    expect(res.pages[0][0].groupContinuesBelow).toBe(true);
    // …and the last block on the page closes it, because the section does not
    // continue BELOW here — it continues on the next PAGE.
    expect(res.pages[0][1].groupContinuesBelow).toBeUndefined();
    expect(res.pages[1][0].continuedFromPrevPage).toBe(true);
    expect(res.pages[1][0].groupContinuesBelow).toBeUndefined();
  });

  test("a block is never both composed below and a continuation of nothing", () => {
    // The two flags describe different relationships and must not be confused:
    // one looks down the same page, the other looks back a page.
    const res = paginateBlocks(
      [
        B("head", 100, { group: "r1" }),
        B("mid", 100, { group: "r1" }),
        B("tail", 100, { group: "r1" }),
      ],
      USABLE
    );
    annotateGroupContinuations(res.pages);
    for (const block of res.pages[0]) {
      expect(block.continuedFromPrevPage).toBeUndefined();
    }
  });

  test("it is derived per call and nothing is persisted", () => {
    const blocks = [
      B("head", 100, { group: "r1" }),
      B("photo", 100, { group: "r1" }),
    ];
    const res = paginateBlocks(blocks, USABLE);
    annotateGroupContinuations(res.pages);
    expect(res.pages[0][0].groupContinuesBelow).toBe(true);
    // The INPUT blocks are untouched — page relationships live on the placed
    // descriptors only.
    expect(blocks[0].groupContinuesBelow).toBeUndefined();
  });
});
