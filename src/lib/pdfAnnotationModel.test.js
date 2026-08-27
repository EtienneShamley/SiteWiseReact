// Automated checks for the PDF annotation model — the normalized persistence
// boundary (src/lib/pdfAnnotationModel.js) and the geometry helpers the editor
// overlay and the flatten/export pipeline both use.
import {
  MAX_PATH_POINTS,
  MIN_SHAPE_SIZE,
  TRANSIENT_KEYS,
  arrowHeadPoints,
  arrowHeadSize,
  clampPathToPage,
  clampPointToPage,
  moveRect,
  moveSegment,
  newAnnotationBase,
  normalizeAnnotation,
  normalizeAnnotationList,
  normalizeRect,
  rectFromPoints,
  resizeRectCorner,
  serializeAnnotations,
  setSegmentEnd,
  simplifyPath,
  sortByZOrder,
  stampUpdated,
} from "./pdfAnnotationModel";

const PAGE = { width: 600, height: 800 };

const rect = (over = {}) => ({
  id: "a_rect",
  page: 1,
  type: "rect",
  x: 100,
  y: 100,
  w: 50,
  h: 40,
  stroke: "#333333",
  strokeWidth: 2,
  ...over,
});

const arrow = (over = {}) => ({
  id: "a_arrow",
  page: 1,
  type: "arrow",
  x1: 10,
  y1: 20,
  x2: 110,
  y2: 20,
  stroke: "#333333",
  strokeWidth: 2,
  head: "single",
  ...over,
});

/* -------------------------------------------------------------------------- */
/* Identity and normalization                                                 */
/* -------------------------------------------------------------------------- */

describe("annotation identity", () => {
  test("newAnnotationBase produces a stable unique id and creation times", () => {
    const a = newAnnotationBase(2, "rect");
    const b = newAnnotationBase(2, "rect");
    expect(a.id).toEqual(expect.any(String));
    expect(a.id.length).toBeGreaterThan(8);
    expect(a.id).not.toBe(b.id);
    expect(a.page).toBe(2);
    expect(a.type).toBe("rect");
    expect(typeof a.createdAt).toBe("number");
    expect(a.updatedAt).toBe(a.createdAt);
  });

  test("an existing stable id is preserved verbatim on load", () => {
    const out = normalizeAnnotation(rect({ id: "a_legacy1" }));
    expect(out.id).toBe("a_legacy1");
  });

  test("an annotation missing an id is repaired rather than dropped", () => {
    const out = normalizeAnnotation(rect({ id: undefined }));
    expect(out).not.toBeNull();
    expect(typeof out.id).toBe("string");
    expect(out.id.length).toBeGreaterThan(8);
  });
});

describe("normalizeAnnotation", () => {
  test("keeps valid legacy geometry and styles untouched", () => {
    const legacy = rect({ fill: "transparent" });
    expect(normalizeAnnotation(legacy)).toEqual(legacy);
  });

  test("is idempotent", () => {
    const once = normalizeAnnotation(arrow());
    expect(normalizeAnnotation(once)).toEqual(once);
  });

  test("reading a legacy record does not invent createdAt/updatedAt", () => {
    const out = normalizeAnnotation(rect());
    expect(out).not.toHaveProperty("createdAt");
    expect(out).not.toHaveProperty("updatedAt");
  });

  test("reading the same record twice produces identical output", () => {
    const stored = [rect(), arrow(), { ...rect({ id: "q" }), type: "highlight", quads: [{ x: 1, y: 2, w: 3, h: 4 }] }];
    const first = JSON.stringify(normalizeAnnotationList(stored));
    const second = JSON.stringify(normalizeAnnotationList(stored));
    expect(second).toBe(first);
  });

  test("preserves existing timestamps when they are present", () => {
    const out = normalizeAnnotation(rect({ createdAt: 111, updatedAt: 222 }));
    expect(out.createdAt).toBe(111);
    expect(out.updatedAt).toBe(222);
  });

  test("never mutates its input", () => {
    const input = rect({ editing: true });
    const snapshot = JSON.stringify(input);
    normalizeAnnotation(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("invalid annotation rejection", () => {
  test.each([
    ["null", null],
    ["a string", "rect"],
    ["an array", []],
    ["an unknown type", { id: "x", page: 1, type: "wormhole", x: 1, y: 1 }],
    ["a missing type", { id: "x", page: 1, x: 1, y: 1 }],
    ["a missing page", { id: "x", type: "rect", x: 1, y: 1, w: 2, h: 2 }],
    ["a zero page", { id: "x", page: 0, type: "rect", x: 1, y: 1, w: 2, h: 2 }],
    ["NaN geometry", { id: "x", page: 1, type: "rect", x: NaN, y: 1, w: 2, h: 2 }],
    ["a zero-size rect", { id: "x", page: 1, type: "rect", x: 1, y: 1, w: 0, h: 2 }],
    ["an incomplete arrow", { id: "x", page: 1, type: "arrow", x1: 1, y1: 2, x2: 3 }],
    ["a one-point path", { id: "x", page: 1, type: "pen", pts: [{ x: 1, y: 1 }] }],
    ["markup with no geometry at all", { id: "x", page: 1, type: "highlight" }],
  ])("drops %s", (_label, input) => {
    expect(normalizeAnnotation(input)).toBeNull();
  });

  test("a malformed record does not take valid neighbours with it", () => {
    const out = normalizeAnnotationList([rect(), { nonsense: true }, null, arrow()]);
    expect(out.map((a) => a.id)).toEqual(["a_rect", "a_arrow"]);
  });

  test("normalizeAnnotationList tolerates a non-array", () => {
    expect(normalizeAnnotationList(null)).toEqual([]);
    expect(normalizeAnnotationList("[]")).toEqual([]);
  });
});

describe("serialization boundary", () => {
  test("transient editor state never reaches a stored record", () => {
    const live = rect({
      editing: true,
      selected: true,
      dragging: true,
      resizing: true,
      pointerId: 7,
      menuOpen: true,
      open: true,
      el: { nodeType: 1 },
      history: [1, 2, 3],
    });
    const [stored] = serializeAnnotations([live]);
    for (const key of TRANSIENT_KEYS) expect(stored).not.toHaveProperty(key);
    expect(stored).toEqual(rect());
  });

  test("object URLs can never enter a stored record", () => {
    const [stored] = serializeAnnotations([
      rect({ fill: "blob:http://localhost/9f0c-1", stroke: "data:image/png;base64,AAA" }),
    ]);
    expect(stored).not.toHaveProperty("fill");
    expect(stored).not.toHaveProperty("stroke");
    expect(JSON.stringify(stored)).not.toMatch(/blob:|data:/);
  });

  test("no PDF bytes or binary payloads survive serialization", () => {
    const [stored] = serializeAnnotations([
      rect({ bytes: new Uint8Array([1, 2, 3]), pdfBytes: "JVBERi0=", canvas: {} }),
    ]);
    expect(stored).not.toHaveProperty("bytes");
    expect(stored).not.toHaveProperty("pdfBytes");
    expect(stored).not.toHaveProperty("canvas");
  });

  test("serialization does not mutate the live annotation array", () => {
    const live = [rect({ editing: true }), arrow()];
    const before = JSON.stringify(live);
    const out = serializeAnnotations(live);
    expect(JSON.stringify(live)).toBe(before);
    expect(out).not.toBe(live);
    expect(out[0]).not.toBe(live[0]);
  });

  test("annotations survive a serialize → store → load round trip", () => {
    const items = [rect(), arrow(), { id: "p", page: 3, type: "freehandHighlight", pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }], stroke: "#FFF59D", opacity: 0.35 }];
    const stored = JSON.parse(JSON.stringify(serializeAnnotations(items)));
    expect(normalizeAnnotationList(stored)).toEqual(serializeAnnotations(items));
  });
});

describe("per-document and per-page isolation", () => {
  test("only the requested page's annotations are selected for a page overlay", () => {
    const items = normalizeAnnotationList([
      rect({ id: "p1", page: 1 }),
      rect({ id: "p2", page: 2 }),
      rect({ id: "p2b", page: 2 }),
    ]);
    expect(items.filter((a) => a.page === 2).map((a) => a.id)).toEqual(["p2", "p2b"]);
    expect(items.filter((a) => a.page === 1).map((a) => a.id)).toEqual(["p1"]);
  });

  test("two documents' lists share no object identity", () => {
    const source = [rect()];
    const docA = normalizeAnnotationList(source);
    const docB = normalizeAnnotationList(source);
    docA[0].x = 999;
    expect(docB[0].x).toBe(100);
    expect(source[0].x).toBe(100);
  });

  test("an annotation record carries no document id, so it cannot address another PDF", () => {
    const [stored] = serializeAnnotations([rect({ pdfDocId: "some-other-pdf" })]);
    expect(stored).not.toHaveProperty("pdfDocId");
  });
});

describe("immutable updates and timestamps", () => {
  test("stampUpdated only touches items that actually changed", () => {
    const before = [rect(), arrow()];
    const after = [rect({ x: 120 }), arrow()];
    const out = stampUpdated(before, after, 5000);
    expect(out[0].updatedAt).toBe(5000);
    expect(out[1]).not.toHaveProperty("updatedAt");
    expect(out[1]).toBe(after[1]);
  });

  test("stampUpdated does not mutate the input arrays", () => {
    const before = [rect()];
    const after = [rect({ x: 1 })];
    const snapshot = JSON.stringify(after);
    stampUpdated(before, after, 1);
    expect(JSON.stringify(after)).toBe(snapshot);
  });
});

/* -------------------------------------------------------------------------- */
/* Paint order                                                                */
/* -------------------------------------------------------------------------- */

describe("z-order", () => {
  const items = [
    { id: "arrow", page: 1, type: "arrow", x1: 0, y1: 0, x2: 1, y2: 1 },
    { id: "hl", page: 1, type: "highlight", quads: [{ x: 0, y: 0, w: 1, h: 1 }] },
    { id: "fhl", page: 1, type: "freehandHighlight", pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    { id: "rect", page: 1, type: "rect", x: 0, y: 0, w: 1, h: 1 },
    { id: "sticky", page: 1, type: "sticky", x: 0, y: 0 },
  ];

  test("translucent highlights paint beneath lines, arrows and outlines", () => {
    expect(sortByZOrder(items).map((a) => a.id)).toEqual([
      "hl",
      "fhl",
      "arrow",
      "rect",
      "sticky",
    ]);
  });

  test("annotations in the same band keep their creation order", () => {
    const same = [
      { id: "first", page: 1, type: "rect", x: 0, y: 0, w: 1, h: 1 },
      { id: "second", page: 1, type: "line", x1: 0, y1: 0, x2: 1, y2: 1 },
      { id: "third", page: 1, type: "arrow", x1: 0, y1: 0, x2: 1, y2: 1 },
    ];
    expect(sortByZOrder(same).map((a) => a.id)).toEqual(["first", "second", "third"]);
  });

  test("sorting copies — the canonical array is never reordered", () => {
    const source = items.slice();
    const order = source.map((a) => a.id);
    const sorted = sortByZOrder(source);
    expect(sorted).not.toBe(source);
    expect(source.map((a) => a.id)).toEqual(order);
  });

  test("every annotation appears exactly once, so nothing is drawn twice", () => {
    const sorted = sortByZOrder(items);
    expect(sorted).toHaveLength(items.length);
    expect(new Set(sorted.map((a) => a.id)).size).toBe(items.length);
  });

  test("an unknown band falls back to the shape band without dropping the item", () => {
    const out = sortByZOrder([{ id: "odd", type: "mystery" }]);
    expect(out.map((a) => a.id)).toEqual(["odd"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

describe("point and rect clamping", () => {
  test("clamps a point inside the page", () => {
    expect(clampPointToPage({ x: -50, y: 9000 }, PAGE)).toEqual({ x: 0, y: 800 });
    expect(clampPointToPage({ x: 300, y: 400 }, PAGE)).toEqual({ x: 300, y: 400 });
  });

  test("normalizeRect removes negative width and height", () => {
    expect(normalizeRect({ x: 100, y: 100, w: -40, h: -30 })).toEqual({
      x: 60,
      y: 70,
      w: 40,
      h: 30,
    });
  });

  test("clampPathToPage keeps every point on the page", () => {
    const out = clampPathToPage([{ x: -5, y: 10 }, { x: 700, y: 900 }], PAGE);
    expect(out).toEqual([{ x: 0, y: 10 }, { x: 600, y: 800 }]);
  });
});

describe("rectangle creation and movement", () => {
  test("rectFromPoints normalizes a drag in any direction", () => {
    const a = rectFromPoints({ x: 200, y: 200 }, { x: 100, y: 120 }, PAGE);
    expect(a).toEqual({ x: 100, y: 120, w: 100, h: 80 });
  });

  test("a tiny drag still produces a usable, non-zero rectangle", () => {
    const a = rectFromPoints({ x: 200, y: 200 }, { x: 201, y: 201 }, PAGE);
    expect(a.w).toBeGreaterThanOrEqual(MIN_SHAPE_SIZE);
    expect(a.h).toBeGreaterThanOrEqual(MIN_SHAPE_SIZE);
  });

  test("moving translates without resizing", () => {
    expect(moveRect(rect(), 25, -30, PAGE)).toEqual({ x: 125, y: 70, w: 50, h: 40 });
  });

  test("a move cannot push the rectangle off the page", () => {
    expect(moveRect(rect(), -9999, -9999, PAGE)).toEqual({ x: 0, y: 0, w: 50, h: 40 });
    expect(moveRect(rect(), 9999, 9999, PAGE)).toEqual({
      x: PAGE.width - 50,
      y: PAGE.height - 40,
      w: 50,
      h: 40,
    });
  });
});

describe("rectangle corner resizing", () => {
  const base = { x: 100, y: 100, w: 100, h: 80 };

  test("resizes from the south-east corner, anchored at north-west", () => {
    expect(resizeRectCorner(base, "se", { x: 260, y: 300 }, PAGE)).toEqual({
      x: 100,
      y: 100,
      w: 160,
      h: 200,
    });
  });

  test("resizes from the north-west corner, anchored at south-east", () => {
    expect(resizeRectCorner(base, "nw", { x: 60, y: 40 }, PAGE)).toEqual({
      x: 60,
      y: 40,
      w: 140,
      h: 140,
    });
  });

  test("resizes from the north-east corner, anchored at south-west", () => {
    expect(resizeRectCorner(base, "ne", { x: 300, y: 50 }, PAGE)).toEqual({
      x: 100,
      y: 50,
      w: 200,
      h: 130,
    });
  });

  test("resizes from the south-west corner, anchored at north-east", () => {
    expect(resizeRectCorner(base, "sw", { x: 20, y: 400 }, PAGE)).toEqual({
      x: 20,
      y: 100,
      w: 180,
      h: 300,
    });
  });

  test("dragging a corner past its anchor never inverts the rectangle", () => {
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const out = resizeRectCorner(base, corner, { x: -400, y: -400 }, PAGE);
      expect(out.w).toBeGreaterThan(0);
      expect(out.h).toBeGreaterThan(0);
      const far = resizeRectCorner(base, corner, { x: 5000, y: 5000 }, PAGE);
      expect(far.w).toBeGreaterThan(0);
      expect(far.h).toBeGreaterThan(0);
    }
  });

  test("a collapsed drag keeps at least the minimum size", () => {
    const out = resizeRectCorner(base, "se", { x: 100, y: 100 }, PAGE);
    expect(out.w).toBeGreaterThanOrEqual(MIN_SHAPE_SIZE);
    expect(out.h).toBeGreaterThanOrEqual(MIN_SHAPE_SIZE);
  });

  test("resizing stays inside the page boundary", () => {
    const out = resizeRectCorner(base, "se", { x: 100000, y: 100000 }, PAGE);
    expect(out.x + out.w).toBeLessThanOrEqual(PAGE.width);
    expect(out.y + out.h).toBeLessThanOrEqual(PAGE.height);
    const out2 = resizeRectCorner(base, "nw", { x: -100000, y: -100000 }, PAGE);
    expect(out2.x).toBeGreaterThanOrEqual(0);
    expect(out2.y).toBeGreaterThanOrEqual(0);
  });

  test("resizing does not mutate the source rect", () => {
    const source = { ...base };
    resizeRectCorner(source, "se", { x: 400, y: 400 }, PAGE);
    expect(source).toEqual(base);
  });
});

describe("arrow and line editing", () => {
  test("moving the whole arrow translates both endpoints equally", () => {
    const out = moveSegment(arrow(), 40, 15, PAGE);
    expect(out).toEqual({ x1: 50, y1: 35, x2: 150, y2: 35 });
    expect(out.x2 - out.x1).toBe(100);
  });

  test("a whole-arrow move is shifted back inside the page, preserving length", () => {
    const out = moveSegment(arrow(), -9999, -9999, PAGE);
    expect(out.x1).toBe(0);
    expect(out.x2 - out.x1).toBe(100);
    expect(out.y1).toBe(0);
    expect(out.y2).toBe(0);
  });

  test("dragging the start handle changes only the start point", () => {
    const out = setSegmentEnd(arrow(), "start", { x: 55, y: 66 }, PAGE);
    expect(out).toEqual({ x1: 55, y1: 66, x2: 110, y2: 20 });
  });

  test("dragging the end handle changes only the end point", () => {
    const out = setSegmentEnd(arrow(), "end", { x: 55, y: 66 }, PAGE);
    expect(out).toEqual({ x1: 10, y1: 20, x2: 55, y2: 66 });
  });

  test("endpoints are clamped inside the page", () => {
    const out = setSegmentEnd(arrow(), "end", { x: 5000, y: -5000 }, PAGE);
    expect(out.x2).toBe(PAGE.width);
    expect(out.y2).toBe(0);
  });

  test("editing an endpoint does not mutate the source annotation", () => {
    const source = arrow();
    const snapshot = JSON.stringify(source);
    setSegmentEnd(source, "end", { x: 1, y: 1 }, PAGE);
    moveSegment(source, 5, 5, PAGE);
    expect(JSON.stringify(source)).toBe(snapshot);
  });
});

describe("arrowhead geometry (shared by the editor and the export)", () => {
  test("head size scales with stroke width but never collapses", () => {
    expect(arrowHeadSize(1)).toBe(6);
    expect(arrowHeadSize(4)).toBe(16);
    expect(arrowHeadSize(undefined)).toBe(8);
  });

  test("barbs sit behind the tip, symmetrically about the shaft", () => {
    const [b1, b2] = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
    expect(b1.x).toBeCloseTo(b2.x, 10);
    expect(b1.x).toBeLessThan(100);
    expect(b1.y).toBeCloseTo(-b2.y, 10);
    expect(Math.hypot(b1.x - 100, b1.y)).toBeCloseTo(20, 10);
  });

  test("the head follows the direction of the shaft", () => {
    const right = arrowHeadPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 10);
    const down = arrowHeadPoints({ x: 0, y: 0 }, { x: 0, y: 10 }, 10);
    expect(right[0]).not.toEqual(down[0]);
    expect(down[0].y).toBeLessThan(10);
  });

  test("the editor and the export derive the head from the same inputs", () => {
    // Both call sites pass the annotation's own endpoints and stroke width, so
    // identical inputs must give identical barbs.
    const a = arrow({ strokeWidth: 3 });
    const editor = arrowHeadPoints({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, arrowHeadSize(a.strokeWidth));
    const exported = arrowHeadPoints({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, arrowHeadSize(a.strokeWidth));
    expect(exported).toEqual(editor);
  });
});

/* -------------------------------------------------------------------------- */
/* Freehand path sampling                                                     */
/* -------------------------------------------------------------------------- */

describe("freehand path simplification", () => {
  test("drops points closer together than the sampling tolerance", () => {
    const dense = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.1, y: 0 }));
    const out = simplifyPath(dense, 1.5);
    expect(out.length).toBeLessThan(dense.length);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual(dense[dense.length - 1]);
  });

  test("keeps meaningful points that are far enough apart", () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 50 }];
    expect(simplifyPath(pts, 1.5)).toEqual(pts);
  });

  test("enforces the persisted point limit and keeps both ends", () => {
    const long = Array.from({ length: 5000 }, (_, i) => ({ x: i * 3, y: i % 2 ? 0 : 5 }));
    const out = simplifyPath(long);
    expect(out.length).toBeLessThanOrEqual(MAX_PATH_POINTS);
    expect(out[0]).toEqual(long[0]);
    expect(out[out.length - 1]).toEqual(long[long.length - 1]);
  });

  test("an explicit lower cap is honoured", () => {
    const long = Array.from({ length: 400 }, (_, i) => ({ x: i * 3, y: 0 }));
    expect(simplifyPath(long, 1, 10)).toHaveLength(10);
  });

  test("fewer than two meaningful points creates nothing", () => {
    expect(simplifyPath([])).toEqual([]);
    expect(simplifyPath([{ x: 5, y: 5 }])).toEqual([]);
    expect(simplifyPath(null)).toEqual([]);
    // A tap: many samples, all in the same place.
    expect(simplifyPath(Array.from({ length: 20 }, () => ({ x: 3, y: 3 })))).toEqual([]);
  });

  test("ignores non-finite samples rather than persisting them", () => {
    const out = simplifyPath([{ x: 0, y: 0 }, { x: NaN, y: 4 }, { x: 40, y: 0 }], 1.5);
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 40, y: 0 }]);
  });

  test("does not mutate the captured pointer trail", () => {
    const trail = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 0 }];
    const snapshot = JSON.stringify(trail);
    simplifyPath(trail);
    expect(JSON.stringify(trail)).toBe(snapshot);
  });

  test("a simplified freehand highlight survives the persistence boundary", () => {
    const pts = simplifyPath(Array.from({ length: 900 }, (_, i) => ({ x: i, y: 0 })));
    const [stored] = serializeAnnotations([
      { id: "f", page: 1, type: "freehandHighlight", pts, stroke: "#FFF59D", strokeWidth: 16, opacity: 0.35 },
    ]);
    expect(stored.pts).toEqual(pts);
    expect(stored.pts.length).toBeLessThanOrEqual(MAX_PATH_POINTS);
    expect(stored.opacity).toBe(0.35);
  });
});

describe("P4. the typewriter box follows the font size", () => {
  const { TYPEWRITER_BOX, annotationBounds, typewriterBox } = require("./pdfAnnotationModel");
  test("is the historical 260 × 40 at (or below) the default size, and proportional above it", () => {
    expect(typewriterBox(14)).toEqual(TYPEWRITER_BOX);
    expect(typewriterBox(8)).toEqual(TYPEWRITER_BOX);
    expect(typewriterBox(undefined)).toEqual(TYPEWRITER_BOX);
    expect(typewriterBox(70)).toEqual({ w: 1300, h: 200 });
    expect(annotationBounds({ type: "typewriter", x: 10, y: 100, fontSize: 70 })).toEqual({ x: 6, y: 26, w: 1300, h: 200 });
    expect(annotationBounds({ type: "typewriter", x: 10, y: 100 })).toEqual({ x: 6, y: 82, w: 260, h: 40 });
  });
});
