// Automated checks for the PDF annotation SELECTION model
// (src/lib/pdfSelection.js): single/additive/marquee membership, page-space
// marquee geometry (zoom- and scroll-independent by construction), the
// "only annotations, never PDF text" rule, and the capability summary the
// contextual options bar reads.
import {
  EDITABLE_FIELDS,
  MIXED,
  applyPatchToSelection,
  isDragDistance,
  itemsInRect,
  marqueeRect,
  primaryId,
  pruneSelection,
  rectsIntersect,
  resolveClickSelection,
  resolveMarqueeSelection,
  selectionSummary,
} from "./pdfSelection";
import { ANNOTATION_TYPES, annotationBounds, translateAnnotation } from "./pdfAnnotationModel";

const PAGE = { width: 600, height: 800 };

const rect = (id, over = {}) => ({ id, page: 1, type: "rect", x: 100, y: 100, w: 50, h: 40, stroke: "#333333", strokeWidth: 2, ...over });
const box = (id, over = {}) => ({ id, page: 1, type: "textbox", x: 300, y: 300, w: 120, h: 60, text: "hi", textColor: "#111111", fontSize: 14, stroke: "#333333", strokeWidth: 2, fill: "transparent", ...over });
const line = (id, over = {}) => ({ id, page: 1, type: "line", x1: 10, y1: 10, x2: 60, y2: 30, stroke: "#1976D2", strokeWidth: 3, ...over });
const sticky = (id, over = {}) => ({ id, page: 1, type: "sticky", x: 500, y: 700, note: "n", color: "#FFE082", ...over });
const highlight = (id, over = {}) => ({ id, page: 1, type: "highlight", quads: [{ x: 50, y: 50, w: 100, h: 12 }], fill: "#FFF59D", opacity: 0.35, ...over });

/* -------------------------- 6/7/11. membership -------------------------- */

describe("6/7/11. single, additive and cleared selection", () => {
  test("6. a plain click replaces the selection with that one id", () => {
    expect(resolveClickSelection([], "a")).toEqual(["a"]);
    expect(resolveClickSelection(["a", "b"], "c")).toEqual(["c"]);
  });

  test("a plain click on the only selected item keeps the same array (no churn)", () => {
    const cur = ["a"];
    expect(resolveClickSelection(cur, "a")).toBe(cur);
  });

  test("7. an additive click toggles membership and keeps order (last = primary)", () => {
    expect(resolveClickSelection(["a"], "b", { additive: true })).toEqual(["a", "b"]);
    expect(resolveClickSelection(["a", "b"], "a", { additive: true })).toEqual(["b"]);
    expect(primaryId(["a", "b"])).toBe("b");
    expect(primaryId([])).toBeNull();
  });

  test("11. clicking nothing clears — unless additive, which leaves the selection alone", () => {
    expect(resolveClickSelection(["a", "b"], null)).toEqual([]);
    expect(resolveClickSelection(["a", "b"], null, { additive: true })).toEqual(["a", "b"]);
  });

  test("ids that stop existing (delete/undo/reload) leave the selection", () => {
    const items = [rect("a"), rect("b")];
    expect(pruneSelection(["a", "gone", "b"], items)).toEqual(["a", "b"]);
    const same = ["a"];
    expect(pruneSelection(same, items)).toBe(same);
  });
});

/* --------------------------- 8/9/10/13/14. marquee ----------------------- */

describe("8/9/10. marquee selection", () => {
  const items = [rect("r"), box("t"), line("l"), sticky("s"), highlight("h")];

  test("8. a marquee selects every annotation it touches, of any type", () => {
    // Covers the rect (100..150) and the highlight (50..150 x 50..62).
    const hits = itemsInRect(items, 1, { x: 40, y: 40, w: 120, h: 120 });
    expect(hits.sort()).toEqual(["h", "r"]);
  });

  test("10. a marquee across mixed types selects them all", () => {
    const hits = itemsInRect(items, 1, { x: 0, y: 0, w: 600, h: 800 });
    expect(hits.sort()).toEqual(["h", "l", "r", "s", "t"]);
  });

  test("9. only NoteWise annotations are candidates — the PDF's text is not addressable", () => {
    // The function only ever sees annotation records; a page with none
    // yields nothing however much printed text the marquee crosses.
    expect(itemsInRect([], 1, { x: 0, y: 0, w: 600, h: 800 })).toEqual([]);
    // And an annotation on ANOTHER page is never hit by this page's marquee.
    expect(itemsInRect([rect("other", { page: 2 })], 1, { x: 0, y: 0, w: 600, h: 800 })).toEqual([]);
  });

  test("an empty or degenerate marquee selects nothing", () => {
    expect(itemsInRect(items, 1, { x: 100, y: 100, w: 0, h: 10 })).toEqual([]);
    expect(itemsInRect(items, 1, null)).toEqual([]);
  });

  test("release replaces the selection, or with additive unions without duplicates", () => {
    expect(resolveMarqueeSelection(["a"], ["b", "c"])).toEqual(["b", "c"]);
    expect(resolveMarqueeSelection(["a", "b"], ["b", "c"], { additive: true })).toEqual(["a", "b", "c"]);
  });

  test("a press only becomes a drag past the threshold", () => {
    expect(isDragDistance({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(isDragDistance({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(true);
  });

  test("rectsIntersect is strict on touching edges", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 })).toBe(true);
  });
});

describe("13/14/15. marquee geometry is page space — zoom and scroll cannot skew it", () => {
  // The overlay converts client px → page units with (client - svgRect) / scale
  // before calling marqueeRect, exactly as getLocal does for every gesture.
  const toPage = (client, svgRect, scale) => ({ x: (client.x - svgRect.left) / scale, y: (client.y - svgRect.top) / scale });

  test.each([0.5, 1, 1.1, 2.5, 4])("13. at zoom %s the same screen drag maps to the same page rect", (scale) => {
    const svgRect = { left: 40, top: 60 };
    const a = toPage({ x: 40 + 100 * scale, y: 60 + 200 * scale }, svgRect, scale);
    const b = toPage({ x: 40 + 250 * scale, y: 60 + 320 * scale }, svgRect, scale);
    const r = marqueeRect(a, b, PAGE);
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(200);
    expect(r.w).toBeCloseTo(150);
    expect(r.h).toBeCloseTo(120);
  });

  test("14. a scrolled viewport only moves the overlay's client rect; the page rect is unchanged", () => {
    const scale = 1.5;
    const unscrolled = { left: 40, top: 60 };
    const scrolled = { left: 40 - 300, top: 60 - 1200 }; // scrolled 300 right, 1200 down
    const drag = (svgRect) =>
      marqueeRect(
        toPage({ x: svgRect.left + 30, y: svgRect.top + 45 }, svgRect, scale),
        toPage({ x: svgRect.left + 330, y: svgRect.top + 345 }, svgRect, scale),
        PAGE
      );
    expect(drag(scrolled)).toEqual(drag(unscrolled));
  });

  test("a marquee dragged up-left or off the page is normalized and clamped", () => {
    const r = marqueeRect({ x: 200, y: 300 }, { x: -50, y: -20 }, PAGE);
    expect(r).toEqual({ x: 0, y: 0, w: 200, h: 300 });
    const r2 = marqueeRect({ x: 500, y: 700 }, { x: 900, y: 1000 }, PAGE);
    expect(r2).toEqual({ x: 500, y: 700, w: 100, h: 100 });
  });

  test("15. annotation bounds are stored geometry — no scale term anywhere", () => {
    expect(annotationBounds(rect("r"))).toEqual({ x: 100, y: 100, w: 50, h: 40 });
    expect(annotationBounds(line("l"))).toEqual({ x: 8.5, y: 8.5, w: 53, h: 23 });
    expect(annotationBounds(sticky("s"))).toEqual({ x: 500, y: 700, w: 18, h: 18 });
    expect(annotationBounds(highlight("h"))).toEqual({ x: 50, y: 50, w: 100, h: 12 });
    expect(annotationBounds({ type: "rect", x: NaN })).toBeNull();
    expect(annotationBounds(null)).toBeNull();
  });
});

/* ----------------------------- multi-move -------------------------------- */

describe("multi-selection foundation: whole-annotation translation", () => {
  test("every movable type translates and stays on the page", () => {
    expect(translateAnnotation(rect("r"), 10, -5, PAGE)).toMatchObject({ x: 110, y: 95 });
    expect(translateAnnotation(line("l"), -100, 0, PAGE)).toMatchObject({ x1: 0, x2: 50 });
    expect(translateAnnotation(sticky("s"), 200, 200, PAGE)).toMatchObject({ x: 600, y: 800 });
    const pen = { id: "p", page: 1, type: "pen", pts: [{ x: 10, y: 10 }, { x: 20, y: 20 }], strokeWidth: 3 };
    expect(translateAnnotation(pen, -50, 5, PAGE).pts).toEqual([{ x: 0, y: 15 }, { x: 10, y: 25 }]);
  });

  test("a callout's leader moves with its box", () => {
    const c = box("c", { type: "callout", leader: { x: 250, y: 250 } });
    const moved = translateAnnotation(c, 20, 30, PAGE);
    expect(moved).toMatchObject({ x: 320, y: 330, leader: { x: 270, y: 280 } });
  });

  test("text-anchored markup never moves", () => {
    const h = highlight("h");
    expect(translateAnnotation(h, 50, 50, PAGE)).toBe(h);
  });
});

/* ------------------------- 5. capability summary -------------------------- */

describe("5. the selection summary drives the contextual options", () => {
  test("a single text box exposes exactly its editable fields with its values", () => {
    const s = selectionSummary([box("t", { bold: true })], ["t"]);
    expect(s.count).toBe(1);
    expect(s.types).toEqual(["textbox"]);
    expect(s.fields).toEqual(EDITABLE_FIELDS.textbox);
    expect(s.values).toMatchObject({ fontSize: 14, bold: true, italic: false, align: "left", fill: "transparent", strokeWidth: 2 });
  });

  test("a line exposes stroke properties only — no font, no fill", () => {
    const s = selectionSummary([line("l")], ["l"]);
    expect(s.fields).toEqual(["stroke", "strokeWidth"]);
  });

  test("10. a mixed selection exposes only the INTERSECTION, and disagreeing values read MIXED", () => {
    const s = selectionSummary([box("t"), rect("r", { stroke: "#E53935" })], ["t", "r"]);
    expect(s.fields).toEqual(["stroke", "strokeWidth", "fill"]);
    expect(s.values.stroke).toBe(MIXED);
    expect(s.values.strokeWidth).toBe(2);
    // Two types with nothing in common → nothing to edit, but still a selection.
    const none = selectionSummary([sticky("s"), line("l")], ["s", "l"]);
    expect(none.count).toBe(2);
    expect(none.fields).toEqual([]);
  });

  test("absent fields read as the rendered default, never undefined", () => {
    const s = selectionSummary([{ id: "x", page: 1, type: "arrow", x1: 0, y1: 0, x2: 10, y2: 10 }], ["x"]);
    expect(s.values).toEqual({ stroke: "#333333", strokeWidth: 2, head: "single" });
  });

  test("every annotation type has a capability row", () => {
    for (const type of Object.values(ANNOTATION_TYPES)) expect(EDITABLE_FIELDS[type]).toBeDefined();
  });
});

describe("applying a patch to the selection", () => {
  const items = [box("t"), rect("r"), line("l")];

  test("touches exactly the selected items and only the fields their type supports", () => {
    const next = applyPatchToSelection(items, ["t", "l"], { stroke: "#E53935", fontSize: 20 });
    expect(next[0]).toMatchObject({ stroke: "#E53935", fontSize: 20 });
    expect(next[1]).toBe(items[1]); // untouched object identity
    expect(next[2]).toMatchObject({ stroke: "#E53935" });
    expect(next[2].fontSize).toBeUndefined(); // a line has no font
  });

  test("a no-op patch returns the same array, so no history entry and no save", () => {
    expect(applyPatchToSelection(items, ["r"], { stroke: "#333333" })).toBe(items);
    expect(applyPatchToSelection(items, [], { stroke: "#000000" })).toBe(items);
  });

  test("undefined removes a field (bold off, left alignment) rather than storing a flag", () => {
    const next = applyPatchToSelection([box("t", { bold: true, align: "right" })], ["t"], { bold: undefined, align: undefined });
    expect("bold" in next[0]).toBe(false);
    expect("align" in next[0]).toBe(false);
  });

  test("strokeWidth 0 (No border) is applied verbatim", () => {
    const next = applyPatchToSelection(items, ["t"], { strokeWidth: 0 });
    expect(next[0].strokeWidth).toBe(0);
  });
});
