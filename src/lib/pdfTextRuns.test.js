// The Edit-text model (src/lib/pdfTextRuns.js), numbered after the P3
// brief's cases 15–30 where they apply: detecting selectable text, grouping
// pdf.js items into line runs, page geometry (including rotation and the
// scale-1 viewport transform), style approximation, colour sampling, the
// replacement record and its safe handling of malformed input.
import {
  DEFAULT_ASCENT,
  DEFAULT_COVER,
  DEFAULT_DESCENT,
  DEFAULT_INK,
  buildTextRuns,
  describeFont,
  hitTestRun,
  replacementBaseline,
  replacementFromRun,
  replacementFromSelection,
  replacementLineHeight,
  runCorners,
  sampleRunColours,
  textItemGeometry,
} from "./pdfTextRuns";
import { PDF_FONT_FAMILIES } from "./pdfAnnotationModel";

// A 600×800 unrotated page: the scale-1 viewport transform flips y.
const VT = [1, 0, 0, -1, 0, 800];
// A pdf.js text item: transform [fs, 0, 0, fs, x, yBaseline] in user space.
const item = (str, x, yUser, fs = 12, extra = {}) => ({
  str,
  transform: [fs, 0, 0, fs, x, yUser],
  width: str.length * fs * 0.5,
  height: fs,
  fontName: "g_d0_f1",
  hasEOL: false,
  ...extra,
});
const STYLES = { g_d0_f1: { fontFamily: "sans-serif", ascent: 0.9, descent: -0.2 } };

describe("15/16. detecting text and resolving its page geometry", () => {
  test("an item's baseline origin, direction, size and metrics come through the viewport transform", () => {
    const g = textItemGeometry(item("Hello", 100, 700, 12), VT, STYLES);
    expect(g.origin).toEqual({ x: 100, y: 100 }); // 800 − 700
    expect(g.dir.x).toBeCloseTo(1);
    expect(g.dir.y).toBeCloseTo(0);
    expect(g.fontSize).toBeCloseTo(12);
    expect(g.width).toBe(30);
    expect(g.ascent).toBe(0.9);
    expect(g.descent).toBe(-0.2);
    expect(g.angle).toBeCloseTo(0);
  });

  test("a run's frame covers ascent above and descent below the baseline", () => {
    const [run] = buildTextRuns({ items: [item("Hello", 100, 700, 12)], styles: STYLES }, VT);
    expect(run.text).toBe("Hello");
    expect(run.x).toBeCloseTo(100);
    expect(run.w).toBeCloseTo(30);
    expect(run.y).toBeCloseTo(100 - 0.9 * 12);
    expect(run.h).toBeCloseTo(1.1 * 12);
    expect(run.baselineOffset).toBeCloseTo(0.9 * 12);
    expect(run.angle).toBe(0);
    expect(run.fontName).toBe("g_d0_f1");
  });

  test("without pdf.js metrics the search box's approximation applies", () => {
    const [run] = buildTextRuns({ items: [item("x", 0, 700, 10)] }, VT);
    expect(run.ascent).toBe(DEFAULT_ASCENT);
    expect(run.descent).toBe(DEFAULT_DESCENT);
    expect(run.h).toBeCloseTo((DEFAULT_ASCENT - DEFAULT_DESCENT) * 10);
  });

  test("30. a page with no items, no text content, or only whitespace yields no runs", () => {
    expect(buildTextRuns(null, VT)).toEqual([]);
    expect(buildTextRuns({ items: [] }, VT)).toEqual([]);
    expect(buildTextRuns({ items: [item("   ", 0, 700), item("", 0, 700, 12, { hasEOL: true })] }, VT)).toEqual([]);
  });
});

describe("grouping rule: one run per visible line (or cell)", () => {
  test("consecutive items on one baseline join, with a space where the gap says there was one", () => {
    const runs = buildTextRuns(
      {
        items: [
          item("Hello", 100, 700, 12), // ends at 130
          item("world", 133, 700, 12), // gap 3 = 0.25 fs → space
          item(",", 163, 700, 12), // gap 0 → no space
        ],
        styles: STYLES,
      },
      VT
    );
    expect(runs.length).toBe(1);
    expect(runs[0].text).toBe("Hello world,");
    expect(runs[0].w).toBeCloseTo(163 + 6 - 100);
  });

  test("a large gap (a table column) starts a new run on the same baseline", () => {
    const runs = buildTextRuns(
      { items: [item("Label", 100, 700, 12), item("Value", 300, 700, 12)], styles: STYLES },
      VT
    );
    expect(runs.map((r) => r.text)).toEqual(["Label", "Value"]);
    expect(runs[1].x).toBeCloseTo(300);
  });

  test("a different baseline, hasEOL, a different angle or a different size all end the run", () => {
    const runs = buildTextRuns(
      {
        items: [
          item("Line one", 100, 700, 12, { hasEOL: true }),
          item("Line two", 100, 700 - 15, 12),
          item("Line three", 100, 700 - 30, 12),
          item("BIG", 100, 700 - 60, 24),
          { str: "rot", transform: [0, 12, -12, 0, 400, 300], width: 18, fontName: "g_d0_f1" },
        ],
        styles: STYLES,
      },
      VT
    );
    expect(runs.map((r) => r.text)).toEqual(["Line one", "Line two", "Line three", "BIG", "rot"]);
    expect(runs[3].fontSize).toBeCloseTo(24);
  });

  test("a line whose items change size keeps the largest glyph box so the cover hides everything", () => {
    const [run] = buildTextRuns(
      { items: [item("small", 100, 700, 12), item("Big", 132, 700, 14)], styles: STYLES },
      VT
    );
    expect(run.fontSize).toBeCloseTo(14);
    expect(run.text).toBe("small Big");
  });

  test("29. malformed items — no transform, NaN, zero size, missing width — are skipped safely", () => {
    const runs = buildTextRuns(
      {
        items: [
          { str: "no transform" },
          { str: "nan", transform: [NaN, 0, 0, 12, 0, 0] },
          { str: "zero", transform: [0, 0, 0, 0, 10, 10], width: 5 },
          { str: "ok", transform: [12, 0, 0, 12, 50, 700] },
          null,
          42,
        ],
      },
      VT
    );
    expect(runs.map((r) => r.text)).toEqual(["ok"]);
    expect(runs[0].w).toBeGreaterThan(0);
  });
});

describe("28. rotated text", () => {
  test("a vertical run stores its unrotated frame plus the angle that maps it back onto the page", () => {
    // Text reading upwards: direction (0, −1) on screen.
    const [run] = buildTextRuns(
      { items: [{ str: "Up", transform: [0, 12, -12, 0, 400, 300], width: 12, fontName: "g_d0_f1" }], styles: STYLES },
      VT
    );
    expect(run.angle).toBeCloseTo(-90);
    expect(run.w).toBeCloseTo(12);
    expect(run.h).toBeCloseTo(1.1 * 12);
    const corners = runCorners(run);
    // The rotated frame spans 12 along the page's y axis at x ≈ 400.
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(12);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.1 * 12);
    expect(replacementFromRun(run).rotate).toBeCloseTo(-90);
  });

  test("horizontal text stores no rotation at all", () => {
    const [run] = buildTextRuns({ items: [item("flat", 0, 700)] }, VT);
    expect(replacementFromRun(run).rotate).toBeUndefined();
  });
});

describe("hit testing", () => {
  const runs = buildTextRuns(
    { items: [item("First", 100, 700, 12, { hasEOL: true }), item("Second", 100, 680, 12)], styles: STYLES },
    VT
  );

  test("a point inside a run's frame resolves to that run; blank page resolves to nothing", () => {
    expect(hitTestRun(runs, { x: 110, y: 96 }).text).toBe("First");
    expect(hitTestRun(runs, { x: 110, y: 116 }).text).toBe("Second");
    expect(hitTestRun(runs, { x: 400, y: 400 })).toBeNull();
    expect(hitTestRun(null, { x: 0, y: 0 })).toBeNull();
    expect(hitTestRun(runs, null)).toBeNull();
  });

  test("a tolerance pads thin text; the smallest overlapping run wins", () => {
    expect(hitTestRun(runs, { x: 131, y: 96 }, 2).text).toBe("First");
    expect(hitTestRun(runs, { x: 140, y: 96 }, 2)).toBeNull();
    const big = { ...runs[0], w: 500, h: 500, y: 0, x: 0, index: 9 };
    expect(hitTestRun([big, runs[0]], { x: 110, y: 96 })).toBe(runs[0]);
  });

  test("a rotated run is hit-tested in its rotated position", () => {
    const [up] = buildTextRuns(
      { items: [{ str: "Up", transform: [0, 12, -12, 0, 400, 300], width: 12, fontName: "g_d0_f1" }], styles: STYLES },
      VT
    );
    // Rotated frame: x ∈ [~387, ~400], y ∈ [488, 500].
    expect(hitTestRun([up], { x: 394, y: 494 })).toBe(up);
    expect(hitTestRun([up], { x: 420, y: 494 })).toBeNull();
  });
});

describe("21. style approximation", () => {
  test("the pdf.js font object's flags win: bold/italic/serif/mono", () => {
    expect(describeFont({ fontObj: { name: "ABCDEF+Foo", bold: true, italic: true, isSerifFont: true } })).toEqual({
      kind: "serif",
      fontFamily: PDF_FONT_FAMILIES[1].css,
      bold: true,
      italic: true,
    });
    expect(describeFont({ fontObj: { name: "X", isMonospace: true } }).kind).toBe("mono");
  });

  test("otherwise the font NAME decides", () => {
    expect(describeFont({ fontObj: { name: "ABCDEF+Arial-BoldMT" } })).toMatchObject({ kind: "sans", bold: true, italic: false });
    expect(describeFont({ fontObj: { name: "TimesNewRomanPS-ItalicMT" } })).toMatchObject({ kind: "serif", italic: true });
    expect(describeFont({ fontObj: { name: "CourierNewPSMT" } }).kind).toBe("mono");
    expect(describeFont({ fontObj: { name: "Helvetica-Oblique" } }).italic).toBe(true);
    expect(describeFont({ fontObj: { name: "DejaVuSansMono" } }).kind).toBe("mono");
    expect(describeFont({ fontObj: { name: "OpenSans-Regular" } }).kind).toBe("sans");
  });

  test("with only textContent.styles the generic family decides; nothing at all means sans regular", () => {
    expect(describeFont({ fontName: "f1", styles: { f1: { fontFamily: "serif" } } }).kind).toBe("serif");
    expect(describeFont({ fontName: "f1", styles: { f1: { fontFamily: "monospace" } } }).kind).toBe("mono");
    expect(describeFont({ fontName: "f1", styles: { f1: { fontFamily: "sans-serif" } } }).kind).toBe("sans");
    expect(describeFont({})).toEqual({ kind: "sans", fontFamily: PDF_FONT_FAMILIES[0].css, bold: false, italic: false });
    expect(describeFont()).toMatchObject({ kind: "sans" });
  });
});

describe("colour sampling (the cover and the ink come from the page itself)", () => {
  const pixels = (rows) => {
    const h = rows.length;
    const w = rows[0].length;
    const data = new Uint8ClampedArray(w * h * 4);
    rows.forEach((row, y) =>
      row.forEach((px, x) => {
        const i = (y * w + x) * 4;
        data[i] = px[0];
        data[i + 1] = px[1];
        data[i + 2] = px[2];
        data[i + 3] = px.length > 3 ? px[3] : 255;
      })
    );
    return { data, width: w, height: h };
  };
  const W = [255, 255, 255];
  const K = [20, 20, 20];
  const B = [230, 240, 255];
  const R = [200, 0, 0];

  test("majority colour is the background, the most common contrasting colour the text", () => {
    expect(sampleRunColours(pixels([[W, W, W, K], [W, K, W, W], [W, W, W, W]]))).toEqual({
      background: "#FFFFFF",
      foreground: "#141414",
    });
    expect(sampleRunColours(pixels([[B, B, B, R], [B, R, B, B]]))).toEqual({
      background: "#E6F0FF",
      foreground: "#C80000",
    });
  });

  test("a run over a flat area (no contrast) reports no ink; transparent pixels are ignored", () => {
    expect(sampleRunColours(pixels([[W, W], [W, [250, 250, 250]]]))).toEqual({ background: "#FEFEFE", foreground: null });
    expect(sampleRunColours(pixels([[[0, 0, 0, 0], [0, 0, 0, 0], W]]))).toEqual({ background: "#FFFFFF", foreground: null });
  });

  test("empty or malformed pixel buffers never throw", () => {
    expect(sampleRunColours(null)).toEqual({ background: null, foreground: null });
    expect(sampleRunColours({ data: new Uint8ClampedArray(0) })).toEqual({ background: null, foreground: null });
    expect(sampleRunColours({ data: [1, 2] })).toEqual({ background: null, foreground: null });
  });
});

describe("17/19/20/21. the replacement record", () => {
  const [run] = buildTextRuns({ items: [item("Hello world", 100, 700, 12)], styles: STYLES }, VT);

  test("starts from the source text, at the source frame, with the source metrics", () => {
    const r = replacementFromRun(run, {
      font: describeFont({ fontObj: { name: "Arial-BoldMT" } }),
      colours: { background: "#FAFAFA", foreground: "#222222" },
    });
    expect(r.text).toBe("Hello world");
    expect(r.sourceText).toBe("Hello world");
    expect(r).toMatchObject({ x: run.x, y: run.y, w: run.w, h: run.h, fontSize: 12, ascent: 0.9, descent: -0.2 });
    expect(r.bold).toBe(true);
    expect(r.italic).toBeUndefined();
    expect(r.fontFamily).toBe(PDF_FONT_FAMILIES[0].css);
    expect(r.textColor).toBe("#222222");
    expect(r.fill).toBe("#FAFAFA");
    expect(r.strokeWidth).toBe(0);
  });

  test("with nothing sampled the stable fallbacks apply: sans regular, white cover, near-black ink", () => {
    const r = replacementFromRun(run);
    expect(r.fill).toBe(DEFAULT_COVER);
    expect(r.textColor).toBe(DEFAULT_INK);
    expect(r.bold).toBeUndefined();
    expect(r.fontFamily).toBe(PDF_FONT_FAMILIES[0].css);
    expect(replacementFromRun(run, { colours: { background: null, foreground: null } }).fill).toBe(DEFAULT_COVER);
    expect(replacementFromRun(null)).toBeNull();
  });

  test("baseline and line pitch derive from the stored metrics, with defaults for legacy/malformed records", () => {
    const r = replacementFromRun(run);
    expect(replacementBaseline(r)).toBeCloseTo(0.9 * 12);
    expect(replacementLineHeight(r)).toBeCloseTo(1.1);
    expect(replacementLineHeight({ fontSize: 12 })).toBeCloseTo(DEFAULT_ASCENT - DEFAULT_DESCENT);
    expect(replacementLineHeight({ lineHeight: 1.5 })).toBe(1.5);
    expect(replacementBaseline({})).toBeCloseTo(DEFAULT_ASCENT * 14);
    expect(replacementLineHeight({ ascent: 0.1, descent: -0.1 })).toBe(0.8);
  });
});

describe("a replacement seeded from a native selection", () => {
  const [run] = buildTextRuns({ items: [item("Hello world again", 100, 700, 12)], styles: STYLES }, VT);

  test("a selection within one line keeps the run's vertical frame and the selection's horizontal extent", () => {
    const r = replacementFromSelection({ quads: [{ x: 136, y: 90, w: 30, h: 13 }], text: "world", run });
    expect(r.text).toBe("world");
    expect(r.sourceText).toBe("world");
    expect(r.x).toBe(136);
    expect(r.w).toBe(30);
    expect(r.y).toBeCloseTo(run.y);
    expect(r.h).toBeCloseTo(run.h);
    expect(r.lineHeight).toBeUndefined();
    expect(r.rotate).toBeUndefined();
  });

  test("a selection across lines becomes one block with the measured line pitch and the first baseline kept", () => {
    const r = replacementFromSelection({
      quads: [
        { x: 100, y: 89, w: 100, h: 14 },
        { x: 100, y: 104, w: 80, h: 14 },
        { x: 100, y: 119, w: 60, h: 14 },
      ],
      text: "one\ntwo\r\nthree",
      run,
    });
    expect(r.text).toBe("one\ntwo\nthree");
    expect(r.x).toBe(100);
    expect(r.w).toBe(100);
    expect(r.y).toBe(89);
    expect(r.h).toBeCloseTo(133 - 89);
    expect(r.lineHeight).toBeCloseTo(15 / 12, 1);
    // First baseline = the run's baseline (run.y + 0.9·12), measured from the new top.
    expect(r.ascent).toBeCloseTo((run.y + 0.9 * 12 - 89) / 12);
  });

  test("no quads, no run, or degenerate quads → nothing", () => {
    expect(replacementFromSelection({ quads: [], text: "x", run })).toBeNull();
    expect(replacementFromSelection({ quads: [{ x: 0, y: 0, w: 0, h: 0 }], text: "x", run })).toBeNull();
    expect(replacementFromSelection({ quads: [{ x: 0, y: 0, w: 10, h: 10 }], text: "x", run: null })).toBeNull();
  });
});
