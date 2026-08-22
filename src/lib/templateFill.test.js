// src/lib/templateFill.test.js
//
// THE CANONICAL FILL (Template Editor A3) — the pure colour model every surface
// of a Template document is painted from: the page, the table's defaults and
// each individual cell override.
//
// Everything here is executable: the module is pure, so the bounds, the alpha
// arithmetic, the inheritance rule and the deterministic flattening are all
// asserted directly rather than through a component.

import {
  CELL_FILL_KIND,
  DEFAULT_FILL_COLOR,
  FILL_OPACITY,
  PAPER_COLOR,
  clampFillOpacity,
  compositeFill,
  fillCss,
  fillsEqual,
  flattenFills,
  isValidHexColor,
  makeFill,
  normalizeFill,
  normalizeHexColor,
  resolveFill,
  storedFill,
} from "./templateFill";

/* ===================== the hex primitives that moved here ================= */

describe("the hex trust boundary", () => {
  test("only #rgb / #rrggbb is a colour — no CSS function, keyword or var()", () => {
    expect(isValidHexColor("#fff")).toBe(true);
    expect(isValidHexColor("#1AA3C2")).toBe(true);
    for (const hostile of [
      "rgb(1,2,3)",
      "rgba(0,0,0,.5)",
      "hsl(0 0% 0%)",
      "var(--x)",
      "url(data:image/png;base64,AAAA)",
      "red",
      "#12345",
      "#ffffff; background: url(x)",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isValidHexColor(hostile)).toBe(false);
    }
  });

  test("normalization expands and lowercases, and never passes input through", () => {
    expect(normalizeHexColor("#FFF", "#000000")).toBe("#ffffff");
    expect(normalizeHexColor("#1AA3C2", "#000000")).toBe("#1aa3c2");
    expect(normalizeHexColor("rgb(1,2,3)", "#123456")).toBe("#123456");
    // An invalid FALLBACK cannot leak either.
    expect(normalizeHexColor("nonsense", "also-nonsense")).toBe("#111111");
  });
});

/* ============================== 8-11. opacity ============================= */

describe("8-11. fill opacity is bounded, and a malformed one is refused", () => {
  test("the range is 0-100 and the default is fully opaque", () => {
    expect(FILL_OPACITY).toEqual({ min: 0, max: 100, default: 100 });
  });

  test("11. anything outside the range is CLAMPED, never accepted", () => {
    expect(clampFillOpacity(-40)).toBe(0);
    expect(clampFillOpacity(1000)).toBe(100);
    expect(clampFillOpacity("55")).toBe(55);
    expect(clampFillOpacity(33.4)).toBe(33);
    expect(clampFillOpacity(33.6)).toBe(34);
  });

  test("11. a MISSING opacity restores the opaque default, it does not become 0", () => {
    // The whole reason `clampFillOpacity` rejects empty/null before coercion:
    // `Number("")`, `Number(null)` and `Number([])` are all a finite 0, which
    // would silently turn "not configured" into "invisible".
    for (const missing of ["", "   ", null, undefined, [], {}, NaN, Infinity, true]) {
      expect(clampFillOpacity(missing)).toBe(100);
    }
  });

  test("a stored fill without an opacity is an OPAQUE fill", () => {
    expect(normalizeFill({ color: "#1aa3c2" })).toEqual({
      color: "#1aa3c2",
      opacity: 100,
    });
    expect(normalizeFill({ color: "#1aa3c2", opacity: null })).toEqual({
      color: "#1aa3c2",
      opacity: 100,
    });
  });

  test("a present but malformed opacity is clamped, never dropped", () => {
    expect(normalizeFill({ color: "#000", opacity: -5 })).toEqual({
      color: "#000000",
      opacity: 0,
    });
    expect(normalizeFill({ color: "#000", opacity: 250 })).toEqual({
      color: "#000000",
      opacity: 100,
    });
  });
});

/* ======================= absent means INHERIT, not white ================== */

describe("11. `null` is a real value: it means INHERIT", () => {
  test("absent / malformed / colourless input is null, never an invented colour", () => {
    for (const nothing of [
      undefined,
      null,
      "",
      "#ffffff",
      42,
      [],
      {},
      { opacity: 50 },
      { color: "rgb(1,2,3)", opacity: 50 },
      { color: "#12345" },
    ]) {
      expect(normalizeFill(nothing)).toBeNull();
    }
  });

  test("a deliberately INVISIBLE fill is not the same thing as no fill", () => {
    const invisible = normalizeFill({ color: "#ffffff", opacity: 0 });
    expect(invisible).toEqual({ color: "#ffffff", opacity: 0 });
    expect(invisible).not.toBeNull();
  });

  test("the inheritance chain takes the FIRST real override", () => {
    const cell = makeFill("#dbeafe", 100);
    const table = makeFill("#f3f4f6", 100);
    expect(resolveFill(cell, table)).toEqual(cell);
    expect(resolveFill(null, table)).toEqual(table);
    expect(resolveFill(null, null)).toBeNull();
    // A 0% override still WINS — it is an override.
    const clear = makeFill("#000000", 0);
    expect(resolveFill(clear, table)).toEqual(clear);
  });

  test("`storedFill` writes nothing for an absent override", () => {
    expect(storedFill(null)).toBeNull();
    expect(storedFill({ color: "not a colour" })).toBeNull();
    expect(storedFill({ color: "#ABC", opacity: 40 })).toEqual({
      color: "#aabbcc",
      opacity: 40,
    });
  });

  test("two fills are compared by meaning, and `null` equals `null`", () => {
    expect(fillsEqual(null, undefined)).toBe(true);
    expect(fillsEqual(null, makeFill("#ffffff", 100))).toBe(false);
    expect(fillsEqual({ color: "#FFF" }, { color: "#ffffff", opacity: 100 })).toBe(true);
    expect(fillsEqual({ color: "#fff", opacity: 50 }, { color: "#fff" })).toBe(false);
  });
});

/* ============ 8-10, 12. opacity reaches the FILL and nothing else ========= */

describe("8-10. a fill becomes a background value, never a container opacity", () => {
  test("10. 100% is emitted as the plain hex colour it has always been", () => {
    expect(fillCss(makeFill("#1aa3c2", 100))).toBe("#1aa3c2");
  });

  test("9. 50% is an alpha COLOUR", () => {
    expect(fillCss(makeFill("#1aa3c2", 50))).toBe("rgba(26, 163, 194, 0.5)");
  });

  test("8. 0% is a fully transparent colour, not a hidden box", () => {
    expect(fillCss(makeFill("#1aa3c2", 0))).toBe("rgba(26, 163, 194, 0)");
  });

  test("no fill produces no declaration at all", () => {
    expect(fillCss(null)).toBeNull();
    expect(fillCss({ color: "nope" })).toBeNull();
  });

  test("12. the module can only ever produce a COLOUR — never `opacity`", () => {
    // The defect this rule exists to prevent: a CSS `opacity` on the cell would
    // fade its text, its images, its borders and its native picker buttons.
    for (const pct of [0, 1, 33, 50, 99, 100]) {
      const css = fillCss(makeFill("#123456", pct));
      expect(css).toMatch(/^(#[0-9a-f]{6}|rgba\([0-9]{1,3}, [0-9]{1,3}, [0-9]{1,3}, [0-9.]+\))$/);
      expect(css).not.toMatch(/opacity|filter|;/);
    }
  });

  test("every whole percentage round-trips to a clean alpha", () => {
    for (let pct = 0; pct <= 100; pct += 1) {
      const css = fillCss(makeFill("#000000", pct));
      const alpha = pct === 100 ? 1 : Number(css.match(/, ([0-9.]+)\)$/)[1]);
      expect(alpha).toBeCloseTo(pct / 100, 5);
      expect(String(alpha)).not.toMatch(/\d{6,}/); // no 17-digit float
    }
  });
});

/* ================= deterministic degradation (Word, print) =============== */

describe("28. opacity degrades DETERMINISTICALLY where alpha cannot travel", () => {
  test("100% replaces the backdrop; 0% leaves it exactly", () => {
    expect(compositeFill(makeFill("#1aa3c2", 100), "#ff0000")).toBe("#1aa3c2");
    expect(compositeFill(makeFill("#1aa3c2", 0), "#ff0000")).toBe("#ff0000");
  });

  test("50% black over white is the mid grey, to the byte", () => {
    expect(compositeFill(makeFill("#000000", 50), "#ffffff")).toBe("#808080");
  });

  test("no fill leaves the backdrop untouched", () => {
    expect(compositeFill(null, "#eeeeee")).toBe("#eeeeee");
    expect(compositeFill(null)).toBe(PAPER_COLOR);
  });

  test("a stack flattens bottom-first, and `null` layers contribute nothing", () => {
    const page = makeFill("#000000", 50); // -> #808080 on white paper
    const cell = makeFill("#ffffff", 50); // -> halfway back to white
    expect(flattenFills([page])).toBe("#808080");
    expect(flattenFills([page, cell])).toBe("#c0c0c0");
    expect(flattenFills([null, null])).toBe(PAPER_COLOR);
    expect(flattenFills([page, null])).toBe(flattenFills([page]));
  });

  test("flattening is deterministic — the same inputs always give the same hex", () => {
    const stack = [makeFill("#1aa3c2", 37), makeFill("#ff8800", 61)];
    const once = flattenFills(stack);
    for (let i = 0; i < 5; i += 1) expect(flattenFills(stack)).toBe(once);
    expect(once).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("a hostile backdrop cannot enter the arithmetic", () => {
    expect(compositeFill(makeFill("#ffffff", 50), "url(x)")).toBe("#ffffff");
    expect(flattenFills("not an array")).toBe(PAPER_COLOR);
  });
});

/* ============================== the vocabulary =========================== */

describe("the fill vocabulary", () => {
  test("the two surfaces a fill override can belong to are named once", () => {
    expect(CELL_FILL_KIND).toEqual({ LABEL: "label", VALUE: "value" });
  });

  test("`makeFill` normalizes both halves and never returns null", () => {
    expect(makeFill("#ABC", "70")).toEqual({ color: "#aabbcc", opacity: 70 });
    expect(makeFill("garbage")).toEqual({ color: DEFAULT_FILL_COLOR, opacity: 100 });
  });

  test("the paper is white", () => {
    expect(PAPER_COLOR).toBe("#ffffff");
    expect(DEFAULT_FILL_COLOR).toBe("#ffffff");
  });
});
