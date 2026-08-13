// src/lib/templateSectionItemDrop.test.js
//
// THE IMAGE-MOVE REGRESSION — a manual test found that an image in a flexible
// section could be picked up but not actually moved.
//
// The failure is reproduced directly below, in "the reported failure". It was
// not the preview and not the drop commit: every destination the resolver
// offered was one the writer would refuse, and the one destination that WOULD
// have moved the image was never offered.
//
// The document is injected, so the whole pointer path — hit-test, same-section
// check, text vs before/after, and "would this actually move anything?" — runs
// here without a browser.
import {
  SECTION_DROP_KIND,
  resolveSectionItemDrop,
  sectionItemAtPoint,
} from "./templateSectionItemDrop";
import { moveSectionItem } from "./templateSectionReorder";
import { splitSectionTextForItem } from "./templateSectionTextSplit";

const photo = (id) => ({
  id,
  kind: "photo",
  assetId: `asset-${id}`,
  name: `${id}.jpg`,
  mimeType: "image/jpeg",
  size: 10,
  createdAt: 1,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct: 100, alignment: "left" },
});
const text = (id, value) => ({ id, kind: "text", value });

/* -------------------------------------------------------------------------- */
/* A FAKE DOCUMENT — one band per item, stacked down the page.                  */
/* -------------------------------------------------------------------------- */

const BAND_TOP = 100;
const BAND_HEIGHT = 40;

/**
 * A REAL DOM subtree per item — one element per model block, exactly as
 * TemplateRichTextView renders — with only the two things jsdom cannot do
 * stubbed: hit-testing (`elementFromPoint`, `getBoundingClientRect`) and the
 * caret resolver.
 *
 * The caret resolves by horizontal position: x < 200 is the very START of the
 * text, x >= 200 is a position inside it. That is what makes "the dead position
 * the image already sits beside" and "a real position inside the paragraph"
 * distinguishable, which is the heart of the reported failure.
 */
function makeDoc(items, { rowId = "row-1", caretResolves = true } = {}) {
  const bands = items.map((item, index) => {
    const top = BAND_TOP + index * BAND_HEIGHT;
    const rect = {
      left: 100,
      right: 500,
      top,
      bottom: top + BAND_HEIGHT,
      width: 400,
      height: BAND_HEIGHT,
    };

    const host = document.createElement("div");
    host.setAttribute("data-section-row", rowId);
    host.setAttribute("data-section-item", item.id);
    host.getBoundingClientRect = () => rect;

    let firstTextNode = null;
    if (item.kind === "text") {
      const rich = document.createElement("div");
      rich.className = "twocol-rich";
      // One <p> per model block — a plain value is one paragraph.
      const paragraph = document.createElement("p");
      const value = typeof item.value === "string" ? item.value : "";
      if (value) {
        firstTextNode = document.createTextNode(value);
        paragraph.appendChild(firstTextNode);
      }
      rich.appendChild(paragraph);
      host.appendChild(rich);
      // An empty paragraph has no text node; the caret lands on the element.
      if (!firstTextNode) firstTextNode = paragraph;
    }

    return { item, top, bottom: top + BAND_HEIGHT, host, caretNode: firstTextNode };
  });

  const bandAt = (y) => bands.find((b) => y >= b.top && y < b.bottom) || null;

  return {
    elementFromPoint: (x, y) => {
      if (x < 100 || x > 500) return null;
      const band = bandAt(y);
      return band ? band.host : null;
    },
    caretPositionFromPoint: caretResolves
      ? (x, y) => {
          const band = bandAt(y);
          if (!band || !band.caretNode) return null;
          const text = band.caretNode.textContent || "";
          return {
            offsetNode: band.caretNode,
            offset: x < 200 ? 0 : Math.min(3, text.length),
          };
        }
      : undefined,
    // Presentation only (the insertion line's y). A zero-size range in jsdom
    // simply yields no caretTop, which the resolver already tolerates.
    createRange: () => document.createRange(),
  };
}

/** The band centre of the item at `index`, for a pointer coordinate. */
const bandY = (index) => BAND_TOP + index * BAND_HEIGHT + BAND_HEIGHT / 2;
const bandTopY = (index) => BAND_TOP + index * BAND_HEIGHT + 5;
const bandBottomY = (index) => BAND_TOP + (index + 1) * BAND_HEIGHT - 5;

/**
 * The whole pointer path, end to end: resolve a destination, then run the real
 * writer for it, and report the resulting order. This is what a user sees.
 */
function dropAt(items, movingItemId, clientX, clientY, options = {}) {
  const doc = makeDoc(items, options);
  const drop = resolveSectionItemDrop({
    doc,
    clientX,
    clientY,
    rowId: options.rowId || "row-1",
    movingItemId,
    items,
  });
  if (!drop) return { drop: null, order: items.map((i) => i.id) };
  const next =
    drop.kind === SECTION_DROP_KIND.TEXT
      ? splitSectionTextForItem({
          items,
          movingItemId,
          targetItemId: drop.targetItemId,
          point: drop.point,
          newItemId: "NEW",
        })?.items
      : moveSectionItem({
          items,
          sourceItemId: movingItemId,
          targetItemId: drop.targetItemId,
          placement: drop.placement,
        });
  return { drop, order: (next || items).map((i) => i.id), wrote: !!next };
}

/* ========================================================================== */
/* THE REPORTED FAILURE                                                        */
/* ========================================================================== */

describe("the reported failure: an image-first section's image could not be moved", () => {
  // The shape every image-first section has: the image is placed first, and the
  // empty text item that keeps the section typeable sits below it.
  const items = [photo("P"), text("T", "")];

  test("REGRESSION: some pointer position in the section moves the image", () => {
    const results = [bandTopY(1), bandY(1), bandBottomY(1)].map(
      (y) => dropAt(items, "P", 300, y).order.join(",")
    );
    // Before the fix every one of these was "P,T" — the image never moved.
    expect(results).toContain("T,P");
  });

  test("the lower half of the text band moves the image below it", () => {
    const { drop, order, wrote } = dropAt(items, "P", 300, bandBottomY(1));
    expect(drop.kind).toBe(SECTION_DROP_KIND.PLACEMENT);
    expect(drop.placement).toBe("after");
    expect(wrote).toBe(true);
    expect(order).toEqual(["T", "P"]);
  });

  test("the upper half offers NO destination — the image is already there", () => {
    // Honest rather than inert: no insertion line is drawn where nothing would
    // happen, so "no indicator" always means "no move".
    expect(dropAt(items, "P", 300, bandTopY(1)).drop).toBeNull();
  });

  test("a caret position the image already sits beside is not a destination", () => {
    // x < 200 resolves to offset 0 — the very start of the text below the image.
    const { drop } = dropAt(items, "P", 150, bandY(1));
    expect(drop === null || drop.kind === SECTION_DROP_KIND.PLACEMENT).toBe(true);
    expect(drop && drop.kind).not.toBe(SECTION_DROP_KIND.TEXT);
  });

  test("the same dead position with REAL text below still splits it", () => {
    const withText = [photo("P"), text("T", "Text B here")];
    // x >= 200 resolves to offset 3 — genuinely inside the paragraph.
    const { drop, order } = dropAt(withText, "P", 300, bandY(1));
    expect(drop.kind).toBe(SECTION_DROP_KIND.TEXT);
    expect(order).toEqual(["T", "P", "NEW"]);
  });
});

/* ========================================================================== */
/* 1–10. THE POINTER PATH                                                      */
/* ========================================================================== */

describe("5/6. the destination changes as the pointer moves through the section", () => {
  const items = [text("A", "First paragraph"), photo("P"), text("B", "Second paragraph")];

  test("5. moving DOWN the section resolves each item in turn", () => {
    const seen = [0, 1, 2].map((index) => {
      const drop = resolveSectionItemDrop({
        doc: makeDoc(items),
        clientX: 300,
        clientY: bandY(index),
        rowId: "row-1",
        movingItemId: "P",
        items,
      });
      return drop && drop.targetItemId;
    });
    expect(seen).toEqual(["A", null, "B"]); // its own band is never a destination
  });

  test("6. moving UPWARD resolves in the reverse order, symmetrically", () => {
    const seen = [2, 1, 0].map((index) => {
      const drop = resolveSectionItemDrop({
        doc: makeDoc(items),
        clientX: 300,
        clientY: bandY(index),
        rowId: "row-1",
        movingItemId: "P",
        items,
      });
      return drop && drop.targetItemId;
    });
    expect(seen).toEqual(["B", null, "A"]);
  });

  test("4. the pointer does NOT have to stay over the original image", () => {
    // Every resolution above happened with the pointer well outside the image's
    // own band, which is the whole point of a drag.
    const drop = resolveSectionItemDrop({
      doc: makeDoc(items),
      clientX: 300,
      clientY: bandY(2),
      rowId: "row-1",
      movingItemId: "P",
      items,
    });
    expect(drop).not.toBeNull();
  });
});

describe("7. before/after destinations between items", () => {
  const items = [photo("P"), photo("Q"), photo("R")];

  test("the top half of another image's band is BEFORE it", () => {
    const { drop, order } = dropAt(items, "P", 300, bandTopY(2));
    expect(drop).toMatchObject({ kind: "placement", targetItemId: "R", placement: "before" });
    expect(order).toEqual(["Q", "P", "R"]);
  });

  test("the bottom half is AFTER it", () => {
    const { drop, order } = dropAt(items, "P", 300, bandBottomY(2));
    expect(drop).toMatchObject({ kind: "placement", targetItemId: "R", placement: "after" });
    expect(order).toEqual(["Q", "R", "P"]);
  });

  test("a placement that would change nothing is not offered", () => {
    // P is already immediately before Q, so "before Q" is inert.
    expect(dropAt(items, "P", 300, bandTopY(1)).drop).toBeNull();
  });

  test("10. the stored order really changes, by reference-preserving move", () => {
    const { order } = dropAt(items, "P", 300, bandBottomY(2));
    expect(order).not.toEqual(items.map((i) => i.id));
  });
});

describe("8. a text destination still resolves and splits", () => {
  const items = [text("A", "The excavation started this morning"), photo("P")];

  test("dropping inside the paragraph splits it around the image", () => {
    const { drop, order } = dropAt(items, "P", 300, bandY(0));
    expect(drop.kind).toBe(SECTION_DROP_KIND.TEXT);
    expect(drop.point).toBeTruthy();
    expect(order).toEqual(["A", "P", "NEW"]);
  });

  test("the caret offset is carried through to the writer", () => {
    const doc = makeDoc(items);
    const drop = resolveSectionItemDrop({
      doc,
      clientX: 300,
      clientY: bandY(0),
      rowId: "row-1",
      movingItemId: "P",
      items,
    });
    expect(drop.point.offset).toBe(3);
  });

  test("text whose caret cannot be resolved falls back to before/after", () => {
    const { drop } = dropAt(items, "P", 300, bandTopY(0), { caretResolves: false });
    expect(drop).toMatchObject({ kind: "placement", targetItemId: "A", placement: "before" });
  });

  test("the very START of that paragraph IS a destination — it moves above it", () => {
    // x < 200 resolves to offset 0. The image currently sits AFTER A, so
    // "above A" is a genuine move and must be offered.
    const { drop, order } = dropAt(items, "P", 150, bandY(0));
    expect(drop).not.toBeNull();
    expect(order).toEqual(["P", "A"]);
  });

  test("the END of the text immediately ABOVE the image is not a destination", () => {
    // The mirror image of the reported failure: splitting at the end of A would
    // put the image after A, which is exactly where it already is.
    const tail = [text("A", "x"), photo("P")];
    const { drop, order } = dropAt(tail, "P", 300, bandBottomY(0));
    expect(drop).toBeNull();
    expect(order).toEqual(["A", "P"]);
  });
});

/* ========================================================================== */
/* EVERY VISIBLE ITEM IS A FULL-HEIGHT TARGET (8, 9, 10, 11, 12, 13)           */
/* ========================================================================== */

describe("8/9. an EMPTY text item is a plain before/after target", () => {
  // Caret resolution must never consume an empty item's whole band: it has no
  // interior position worth aiming at, and letting it win was what made an
  // image-first section's picture unmovable.
  const items = [text("A", "Intro"), photo("P"), text("E", "")];

  test("9. its LOWER half resolves AFTER it", () => {
    const { drop, order } = dropAt(items, "P", 300, bandBottomY(2));
    expect(drop).toMatchObject({ kind: SECTION_DROP_KIND.PLACEMENT, placement: "after" });
    expect(order).toEqual(["A", "E", "P"]);
  });

  test("8. its UPPER half resolves BEFORE it", () => {
    // The photo already sits directly before E, so this particular move is
    // inert — which is itself the correct answer, and no line is drawn.
    expect(dropAt(items, "P", 300, bandTopY(2)).drop).toBeNull();
    // With the photo elsewhere, the same upper half is a real BEFORE.
    const moved = [text("A", "Intro"), text("E", ""), photo("P")];
    const { drop, order } = dropAt(moved, "P", 300, bandTopY(1));
    expect(drop).toMatchObject({ kind: SECTION_DROP_KIND.PLACEMENT, placement: "before" });
    expect(order).toEqual(["A", "P", "E"]);
  });

  test("an empty item NEVER resolves to a text-split destination", () => {
    // Every x position across it, including ones where a caret does resolve.
    for (const x of [110, 150, 300, 450]) {
      for (const y of [bandTopY(2), bandY(2), bandBottomY(2)]) {
        const { drop } = dropAt(items, "P", x, y);
        expect(drop && drop.kind).not.toBe(SECTION_DROP_KIND.TEXT);
      }
    }
  });

  test("13. an image-first section: the empty item's lower half gives [Text, Photo]", () => {
    const imageFirst = [photo("P"), text("E", "")];
    expect(dropAt(imageFirst, "P", 300, bandBottomY(1)).order).toEqual(["E", "P"]);
  });
});

describe("10/11/12. a MEANINGFUL text item keeps both behaviours", () => {
  const items = [text("A", "The excavation started this morning"), photo("P")];

  test("11. a genuine mid-text position wins, because it changes structure", () => {
    const { drop, order } = dropAt(items, "P", 300, bandY(0));
    expect(drop.kind).toBe(SECTION_DROP_KIND.TEXT);
    expect(order).toEqual(["A", "P", "NEW"]);
  });

  test("12. a no-op caret falls back to the item's own placement rule", () => {
    // The image sits immediately BEFORE this paragraph, so a split at its very
    // start (x < 200 → offset 0) would put the image where it already is. The
    // placement rule answers instead, and the lower half is a genuine move.
    const imageAbove = [photo("P"), text("A", "The excavation started")];
    const { drop, order } = dropAt(imageAbove, "P", 150, bandBottomY(1));
    expect(drop).toMatchObject({ kind: SECTION_DROP_KIND.PLACEMENT, placement: "after" });
    expect(order).toEqual(["A", "P"]);
  });

  test("10. its upper and lower halves still work as placements", () => {
    const three = [photo("P"), text("A", "Some words"), text("B", "More words")];
    // Lower half of the LAST item, aimed where no caret resolves (x < 100 is
    // outside; use the caret-free document instead).
    const { drop } = dropAt(three, "P", 300, bandBottomY(2), { caretResolves: false });
    expect(drop).toMatchObject({ kind: SECTION_DROP_KIND.PLACEMENT, placement: "after" });
  });
});

/* ========================================================================== */
/* 11. CROSS-SECTION IS STILL REFUSED                                          */
/* ========================================================================== */

describe("11. a destination in another section is refused", () => {
  const items = [text("A", "First"), photo("P")];

  test("a block belonging to another row is not a destination", () => {
    const doc = makeDoc(items, { rowId: "row-OTHER" });
    const drop = resolveSectionItemDrop({
      doc,
      clientX: 300,
      clientY: bandY(0),
      rowId: "row-1",
      movingItemId: "P",
      items,
    });
    expect(drop).toBeNull();
  });

  test("the hit-test itself refuses another row", () => {
    const doc = makeDoc(items, { rowId: "row-OTHER" });
    expect(sectionItemAtPoint({ doc, clientX: 300, clientY: bandY(0), rowId: "row-1" })).toBeNull();
  });

  test("a point over nothing at all is not a destination", () => {
    const doc = makeDoc(items);
    expect(
      resolveSectionItemDrop({
        doc,
        clientX: 300,
        clientY: 5000,
        rowId: "row-1",
        movingItemId: "P",
        items,
      })
    ).toBeNull();
  });

  test("an unusable document simply resolves nothing", () => {
    expect(resolveSectionItemDrop({ doc: null, clientX: 1, clientY: 1 })).toBeNull();
    expect(resolveSectionItemDrop()).toBeNull();
  });
});

/* ========================================================================== */
/* WIRING GATES                                                                */
/* ========================================================================== */

describe("the writers that are not wired are not offered", () => {
  const items = [text("A", "First paragraph"), photo("P")];

  test("no text-drop writer means a text item is only a before/after target", () => {
    const doc = makeDoc(items);
    const drop = resolveSectionItemDrop({
      doc,
      clientX: 300,
      // The TOP half, so the placement is "before A" — a real move for an image
      // that currently sits after it.
      clientY: bandTopY(0),
      rowId: "row-1",
      movingItemId: "P",
      items,
      allowTextDrop: false,
    });
    expect(drop).toMatchObject({ kind: SECTION_DROP_KIND.PLACEMENT, placement: "before" });
  });

  test("no reorder writer means no placement destination at all", () => {
    const doc = makeDoc([photo("P"), photo("Q")]);
    const drop = resolveSectionItemDrop({
      doc,
      clientX: 300,
      clientY: bandBottomY(1),
      rowId: "row-1",
      movingItemId: "P",
      items: [photo("P"), photo("Q")],
      allowPlacement: false,
    });
    expect(drop).toBeNull();
  });
});
