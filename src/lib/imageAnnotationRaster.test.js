// The raster boundary (src/lib/imageAnnotationRaster.js), exercised with a
// RECORDING 2D context: what is asserted is the sequence of draw operations
// — text, colours, fills, borders, arrowheads, callout leaders, geometry —
// and, through a fake canvas, the output's dimensions, format and
// determinism. jsdom has no canvas, so the platform pieces are injected.
import {
  annotationFont,
  drawAnnotationsToContext,
  firstBaselineOffset,
  renderAnnotatedImage,
  wrapTextLines,
} from "./imageAnnotationRaster";
import { arrowHeadPoints, arrowHeadSize } from "./pdfAnnotationModel";
import { calloutLeaderGeometry } from "./pdfCallout";

function recordingContext() {
  const ops = [];
  const state = {};
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "ops") return ops;
        if (prop === "measureText") return (s) => ({ width: s.length * 7 });
        if (prop in state) return state[prop];
        return (...args) => {
          ops.push([prop, ...args]);
        };
      },
      set(_t, prop, value) {
        state[prop] = value;
        ops.push(["set", prop, value]);
        return true;
      },
    }
  );
  return ctx;
}

const names = (ctx) => ctx.ops.map((o) => o[0]);
const sets = (ctx, prop) => ctx.ops.filter((o) => o[0] === "set" && o[1] === prop).map((o) => o[2]);
const calls = (ctx, name) => ctx.ops.filter((o) => o[0] === name);

describe("text", () => {
  test("40. text is drawn with the annotation's font, colour and CSS-line-box baseline", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [
      { id: "t", page: 1, type: "textbox", x: 100, y: 50, w: 200, h: 80, text: "Crack here", fontSize: 20, textColor: "#ff0000", bold: true, italic: true, fontFamily: "Georgia, serif" },
    ]);
    expect(sets(ctx, "font")).toContain("italic bold 20px Georgia, serif");
    expect(sets(ctx, "fillStyle")).toContain("#ff0000");
    const text = calls(ctx, "fillText");
    expect(text).toHaveLength(1);
    expect(text[0][1]).toBe("Crack here");
    expect(text[0][2]).toBe(106); // x + 6 inset
    expect(text[0][3]).toBeCloseTo(56 + firstBaselineOffset(20, 1.25), 6);
    // The text is clipped to the box's text area, as the overlay's foreignObject clips it.
    expect(names(ctx)).toContain("clip");
  });

  test("wrapping breaks at words, honours newlines and breaks an oversized word", () => {
    const m = (s) => s.length * 10;
    expect(wrapTextLines("one two three", 75, m)).toEqual(["one two", "three"]);
    expect(wrapTextLines("a\nb", 100, m)).toEqual(["a", "b"]);
    expect(wrapTextLines("abcdefgh", 30, m)).toEqual(["abc", "def", "gh"]);
    expect(wrapTextLines("", 30, m)).toEqual([]);
  });

  test("alignment offsets each line inside the box", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [
      { id: "t", page: 1, type: "textbox", x: 0, y: 0, w: 212, h: 60, text: "abc", fontSize: 14, align: "right" },
    ]);
    // width 200, "abc" measures 21 → x = 6 + (200 − 21)
    expect(calls(ctx, "fillText")[0][2]).toBe(185);
  });

  test("typewriter text is unwrapped at the stored baseline point", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [{ id: "t", page: 1, type: "typewriter", x: 40, y: 100, text: "one two\nthree", fontSize: 20 }]);
    const text = calls(ctx, "fillText");
    expect(text.map((c) => c[1])).toEqual(["one two", "three"]);
    expect(text[0][2]).toBe(44);
    expect(text[0][3]).toBeCloseTo(100 - 20 + 2 + firstBaselineOffset(20, 1.2), 6);
    expect(text[1][3] - text[0][3]).toBeCloseTo(24, 6);
  });

  test("the font shorthand matches what the overlay renders", () => {
    expect(annotationFont({ fontSize: 14 })).toMatch(/^14px system-ui/);
    expect(annotationFont({ fontSize: 30, bold: true })).toMatch(/^bold 30px /);
  });
});

describe("41–43. colours, fills and borders", () => {
  test("a filled, bordered rectangle uses its own colours and width", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [{ id: "r", page: 1, type: "rect", x: 10, y: 20, w: 100, h: 50, fill: "#00ff00", stroke: "#0000ff", strokeWidth: 6 }]);
    expect(calls(ctx, "fillRect")).toEqual([["fillRect", 10, 20, 100, 50]]);
    expect(sets(ctx, "fillStyle")).toContain("#00ff00");
    expect(sets(ctx, "strokeStyle")).toContain("#0000ff");
    expect(sets(ctx, "lineWidth")).toContain(6);
    expect(calls(ctx, "strokeRect")).toEqual([["strokeRect", 10, 20, 100, 50]]);
  });

  test("43. No border (strokeWidth 0) draws no outline; no fill draws no fill", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [
      { id: "r", page: 1, type: "rect", x: 10, y: 20, w: 100, h: 50, fill: "transparent", strokeWidth: 0 },
      { id: "e", page: 1, type: "ellipse", x: 10, y: 20, w: 100, h: 50, fill: "#ffffff", strokeWidth: 0 },
      { id: "t", page: 1, type: "textbox", x: 0, y: 0, w: 100, h: 50, text: "x", strokeWidth: 0, fill: "transparent" },
    ]);
    expect(calls(ctx, "strokeRect")).toEqual([]);
    expect(calls(ctx, "fillRect")).toEqual([]);
    expect(calls(ctx, "stroke")).toEqual([]);
    expect(calls(ctx, "ellipse")).toEqual([["ellipse", 60, 45, 50, 25, 0, 0, Math.PI * 2]]);
    expect(calls(ctx, "fill")).toHaveLength(1);
  });

  test("a freehand highlight is translucent; a pen stroke is opaque", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [
      { id: "h", page: 1, type: "freehandHighlight", pts: [{ x: 0, y: 0 }, { x: 10, y: 10 }], stroke: "#fff59d", strokeWidth: 30, opacity: 0.4 },
      { id: "p", page: 1, type: "pen", pts: [{ x: 0, y: 0 }, { x: 10, y: 10 }], stroke: "#1976d2", strokeWidth: 4 },
    ]);
    expect(sets(ctx, "globalAlpha")).toContain(0.4);
    expect(sets(ctx, "lineCap")).toContain("round");
    expect(sets(ctx, "lineJoin")).toContain("round");
    expect(calls(ctx, "lineTo")).toHaveLength(2);
  });
});

describe("44–46. arrows, callouts, geometry", () => {
  test("44. an arrow draws its shaft and the SAME two barbs the overlay computes", () => {
    const ctx = recordingContext();
    const a = { id: "a", page: 1, type: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, stroke: "#333333", strokeWidth: 4, head: "single" };
    drawAnnotationsToContext(ctx, [a]);
    const barbs = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, arrowHeadSize(4));
    const lines = calls(ctx, "lineTo").map((c) => [c[1], c[2]]);
    expect(lines[0]).toEqual([100, 0]);
    expect(lines[1][0]).toBeCloseTo(barbs[0].x, 6);
    expect(lines[1][1]).toBeCloseTo(barbs[0].y, 6);
    expect(lines[2][0]).toBeCloseTo(barbs[1].x, 6);
    expect(calls(ctx, "moveTo")).toHaveLength(3);
  });

  test("a double-headed arrow draws four barbs; a line draws none", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [
      { id: "a", page: 1, type: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, head: "double" },
      { id: "l", page: 1, type: "line", x1: 0, y1: 0, x2: 100, y2: 0 },
    ]);
    expect(calls(ctx, "moveTo")).toHaveLength(5 + 1);
  });

  test("45. a callout draws its leader from the shared attachment geometry, then the box and text", () => {
    const ctx = recordingContext();
    const a = { id: "c", page: 1, type: "callout", x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 }, text: "Note", fontSize: 14, strokeWidth: 2, stroke: "#333333", fill: "#ffffff" };
    drawAnnotationsToContext(ctx, [a]);
    const g = calloutLeaderGeometry(a);
    const firstMove = calls(ctx, "moveTo")[0];
    const firstLine = calls(ctx, "lineTo")[0];
    expect([firstMove[1], firstMove[2]]).toEqual([g.anchor.x, g.anchor.y]);
    expect([firstLine[1], firstLine[2]]).toEqual([g.tip.x, g.tip.y]);
    expect(calls(ctx, "moveTo")).toHaveLength(1 + g.barbs.length + 1); // leader, barbs, rounded box
    expect(sets(ctx, "lineWidth")).toContain(g.width);
    expect(calls(ctx, "arcTo")).toHaveLength(4);
    expect(calls(ctx, "fillText")[0][1]).toBe("Note");
    expect(names(ctx).indexOf("moveTo")).toBeLessThan(names(ctx).indexOf("arcTo"));
  });

  test("46. geometry is used in image pixels verbatim, and a rotated box rotates about its centre", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [{ id: "t", page: 1, type: "textbox", x: 100, y: 100, w: 200, h: 100, rotate: 90, text: "" }]);
    expect(calls(ctx, "translate")[0]).toEqual(["translate", 200, 150]);
    expect(calls(ctx, "rotate")[0][1]).toBeCloseTo(Math.PI / 2, 6);
    // The rounded box path starts at (x + corner, y) with the stored numbers untouched.
    expect(calls(ctx, "moveTo")[0]).toEqual(["moveTo", 108, 100]);
    expect(calls(ctx, "arcTo")[0]).toEqual(["arcTo", 300, 100, 300, 108, 8]);
  });

  test("paint order is the shared z-order: a highlight under a shape under text", () => {
    const ctx = recordingContext();
    drawAnnotationsToContext(ctx, [
      { id: "t", page: 1, type: "textbox", x: 0, y: 0, w: 50, h: 50, text: "T" },
      { id: "r", page: 1, type: "rect", x: 0, y: 0, w: 50, h: 50 },
      { id: "h", page: 1, type: "freehandHighlight", pts: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
    ]);
    const n = names(ctx);
    expect(n.indexOf("lineTo")).toBeLessThan(n.indexOf("strokeRect"));
    expect(n.indexOf("strokeRect")).toBeLessThan(n.indexOf("fillText"));
  });

  test("a malformed record is skipped, never drawn wrong", () => {
    const ctx = recordingContext();
    expect(drawAnnotationsToContext(ctx, [{ type: "rect", page: 1 }, { id: "r", page: 1, type: "rect", x: 0, y: 0, w: 1, h: 1 }])).toBe(1);
  });
});

describe("47/48. output", () => {
  function fakeCanvas(log) {
    const ctx = recordingContext();
    return {
      ctx,
      canvas: {
        width: 0,
        height: 0,
        getContext: () => ctx,
        toBlob(cb, type, quality) {
          log.push(["toBlob", type, quality, this.width, this.height]);
          cb({ size: 1234, type });
        },
      },
    };
  }
  const source = { type: "image/jpeg", size: 100 };
  const decode = async () => ({ source: "BITMAP", width: 4032, height: 3024, release: jest.fn() });

  test("47. the rendition has the decoded image's own dimensions and aspect", async () => {
    const log = [];
    const { canvas, ctx } = fakeCanvas(log);
    const out = await renderAnnotatedImage({ sourceBlob: source, items: [{ id: "r", page: 1, type: "rect", x: 1, y: 1, w: 10, h: 10 }] }, { createCanvas: () => canvas, decodeImageSource: decode });
    expect(out).toMatchObject({ width: 4032, height: 3024, mimeType: "image/jpeg" });
    expect(canvas.width).toBe(4032);
    expect(canvas.height).toBe(3024);
    expect(calls(ctx, "drawImage")[0]).toEqual(["drawImage", "BITMAP", 0, 0, 4032, 3024]);
    expect(log[0]).toEqual(["toBlob", "image/jpeg", 0.88, 4032, 3024]);
  });

  test("a PNG stays a PNG (lossless, alpha kept); a WebP stays WebP", async () => {
    for (const type of ["image/png", "image/webp"]) {
      const log = [];
      const { canvas } = fakeCanvas(log);
      await renderAnnotatedImage({ sourceBlob: { type, size: 1 }, items: [] }, { createCanvas: () => canvas, decodeImageSource: decode });
      expect(log[0][1]).toBe(type);
    }
  });

  test("48. the same layer over the same source produces the same draw sequence", async () => {
    const items = [
      { id: "c", page: 1, type: "callout", x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 }, text: "Note", fontSize: 14 },
      { id: "a", page: 1, type: "arrow", x1: 0, y1: 0, x2: 100, y2: 50 },
    ];
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const { canvas, ctx } = fakeCanvas([]);
      await renderAnnotatedImage({ sourceBlob: source, items }, { createCanvas: () => canvas, decodeImageSource: decode });
      runs.push(JSON.stringify(ctx.ops));
    }
    expect(runs[0]).toBe(runs[1]);
  });

  test("an unsupported source type or a failed decode is refused with a user-facing message", async () => {
    await expect(renderAnnotatedImage({ sourceBlob: { type: "image/svg+xml" }, items: [] }, { createCanvas: () => ({}) })).rejects.toThrow(/could not be rendered/);
    await expect(
      renderAnnotatedImage({ sourceBlob: source, items: [] }, { createCanvas: () => ({}), decodeImageSource: async () => { throw new Error("x"); } })
    ).rejects.toThrow(/could not be rendered/);
  });

  test("the decoded source is released after rendering, on success and failure", async () => {
    const release = jest.fn();
    const dec = async () => ({ source: "B", width: 10, height: 10, release });
    const { canvas } = fakeCanvas([]);
    await renderAnnotatedImage({ sourceBlob: source, items: [] }, { createCanvas: () => canvas, decodeImageSource: dec });
    await renderAnnotatedImage({ sourceBlob: source, items: [] }, { createCanvas: () => ({ getContext: () => null }), decodeImageSource: dec }).catch(() => {});
    expect(release).toHaveBeenCalledTimes(2);
  });
});
