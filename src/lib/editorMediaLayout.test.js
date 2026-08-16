// src/lib/editorMediaLayout.test.js
//
// The layout vocabulary of the shared editor media core: what a stored
// presentation attribute may hold, how anything else degrades, and the one
// class/style derivation future consumers share.

import {
  MEDIA_CLASS,
  MEDIA_LAYOUT_MODE,
  MEDIA_LAYOUT_MODE_ATTR,
  MEDIA_LAYOUT_MODES,
  MEDIA_LAYOUT_SIDE,
  MEDIA_LAYOUT_SIDE_ATTR,
  MEDIA_LAYOUT_SIDES,
  MEDIA_MAX_WIDTH_PCT,
  MEDIA_MIN_WIDTH_PCT,
  MEDIA_WIDTH_PCT_ATTR,
  isDefaultMediaLayout,
  mediaLayoutClassNames,
  mediaWidthStyle,
  mediaWrapExportCss,
  normalizeMediaLayout,
  normalizeMediaLayoutMode,
  normalizeMediaLayoutSide,
  normalizeMediaWidthPct,
} from "./editorMediaLayout";
import { MAX_PHOTO_WIDTH_PCT, MIN_PHOTO_WIDTH_PCT } from "./noteAttachments";

describe("the vocabulary", () => {
  test("modes are block and wrap, sides are left and right", () => {
    expect(MEDIA_LAYOUT_MODES).toEqual([MEDIA_LAYOUT_MODE.BLOCK, MEDIA_LAYOUT_MODE.WRAP]);
    expect(MEDIA_LAYOUT_SIDES).toEqual([MEDIA_LAYOUT_SIDE.LEFT, MEDIA_LAYOUT_SIDE.RIGHT]);
  });

  test("width bounds are the existing 15–100 photo rule, not a new one", () => {
    expect(MEDIA_MIN_WIDTH_PCT).toBe(MIN_PHOTO_WIDTH_PCT);
    expect(MEDIA_MAX_WIDTH_PCT).toBe(MAX_PHOTO_WIDTH_PCT);
    expect(MEDIA_MIN_WIDTH_PCT).toBe(15);
    expect(MEDIA_MAX_WIDTH_PCT).toBe(100);
  });

  test("the serialized attribute names are stable", () => {
    expect(MEDIA_WIDTH_PCT_ATTR).toBe("data-width-pct");
    expect(MEDIA_LAYOUT_MODE_ATTR).toBe("data-layout-mode");
    expect(MEDIA_LAYOUT_SIDE_ATTR).toBe("data-layout-side");
  });
});

describe("normalizeMediaWidthPct", () => {
  test("absent means null — legacy rendering, never a default width", () => {
    for (const value of [null, undefined, ""]) {
      expect(normalizeMediaWidthPct(value)).toBeNull();
    }
  });

  test("non-numeric input is null, never coerced", () => {
    for (const value of ["abc", "45%", {}, [], NaN, Infinity, -Infinity]) {
      expect(normalizeMediaWidthPct(value)).toBeNull();
    }
  });

  test("a numeric string parses — DOM attributes arrive as strings", () => {
    expect(normalizeMediaWidthPct("45")).toBe(45);
    expect(normalizeMediaWidthPct(" 60 ")).toBe(60);
  });

  test("an out-of-range number clamps to the model bounds", () => {
    expect(normalizeMediaWidthPct(0)).toBe(15);
    expect(normalizeMediaWidthPct(-20)).toBe(15);
    expect(normalizeMediaWidthPct(14)).toBe(15);
    expect(normalizeMediaWidthPct(101)).toBe(100);
    expect(normalizeMediaWidthPct(500)).toBe(100);
  });

  test("stored widths are whole percentage points", () => {
    expect(normalizeMediaWidthPct(45.4)).toBe(45);
    expect(normalizeMediaWidthPct(45.6)).toBe(46);
  });
});

describe("normalizeMediaLayoutMode / Side", () => {
  test("known tokens survive, with trim and case tolerance", () => {
    expect(normalizeMediaLayoutMode("wrap")).toBe("wrap");
    expect(normalizeMediaLayoutMode(" Wrap ")).toBe("wrap");
    expect(normalizeMediaLayoutSide("LEFT")).toBe("left");
    expect(normalizeMediaLayoutSide(" right ")).toBe("right");
  });

  test("an unknown or missing mode is block — a future document degrades, never breaks", () => {
    for (const value of [null, undefined, "", "float", "anchored", "inline", 42, {}]) {
      expect(normalizeMediaLayoutMode(value)).toBe(MEDIA_LAYOUT_MODE.BLOCK);
    }
  });

  test("an unknown side is null, never guessed", () => {
    for (const value of [null, undefined, "", "centre", "top", 1]) {
      expect(normalizeMediaLayoutSide(value)).toBeNull();
    }
  });
});

describe("normalizeMediaLayout — mode and side as one unit", () => {
  test("block never carries a side", () => {
    expect(normalizeMediaLayout({ mode: "block", side: "left" })).toEqual({
      mode: "block",
      side: null,
    });
    expect(normalizeMediaLayout({})).toEqual({ mode: "block", side: null });
    expect(normalizeMediaLayout()).toEqual({ mode: "block", side: null });
  });

  test("wrap keeps a usable side", () => {
    expect(normalizeMediaLayout({ mode: "wrap", side: "left" })).toEqual({
      mode: "wrap",
      side: "left",
    });
    expect(normalizeMediaLayout({ mode: "wrap", side: "right" })).toEqual({
      mode: "wrap",
      side: "right",
    });
  });

  test("a wrap without a usable side degrades to block as one unit", () => {
    for (const side of [null, undefined, "", "centre"]) {
      expect(normalizeMediaLayout({ mode: "wrap", side })).toEqual({
        mode: "block",
        side: null,
      });
    }
  });

  test("isDefaultMediaLayout is true exactly for block", () => {
    expect(isDefaultMediaLayout({ mode: "block" })).toBe(true);
    expect(isDefaultMediaLayout(undefined)).toBe(true);
    expect(isDefaultMediaLayout({ mode: "wrap", side: "bogus" })).toBe(true);
    expect(isDefaultMediaLayout({ mode: "wrap", side: "left" })).toBe(false);
  });
});

describe("presentation derivation", () => {
  test("classes carry the layout; block and wrap are distinct", () => {
    expect(mediaLayoutClassNames({ mode: "block" })).toEqual([
      MEDIA_CLASS,
      `${MEDIA_CLASS}--block`,
    ]);
    expect(mediaLayoutClassNames({ mode: "wrap", side: "left" })).toEqual([
      MEDIA_CLASS,
      `${MEDIA_CLASS}--wrap`,
      `${MEDIA_CLASS}--wrap-left`,
    ]);
    expect(mediaLayoutClassNames({ mode: "wrap", side: "right" })).toEqual([
      MEDIA_CLASS,
      `${MEDIA_CLASS}--wrap`,
      `${MEDIA_CLASS}--wrap-right`,
    ]);
  });

  test("an unrenderable layout derives the block classes", () => {
    expect(mediaLayoutClassNames({ mode: "hologram" })).toEqual(
      mediaLayoutClassNames({ mode: "block" })
    );
    expect(mediaLayoutClassNames(undefined)).toEqual(mediaLayoutClassNames({ mode: "block" }));
  });

  test("the inline style carries only the width — and only when one is stored", () => {
    expect(mediaWidthStyle(45)).toEqual({ width: "45%" });
    expect(mediaWidthStyle("60")).toEqual({ width: "60%" });
    expect(mediaWidthStyle(null)).toBeNull();
    expect(mediaWidthStyle(undefined)).toBeNull();
    expect(mediaWidthStyle("abc")).toBeNull();
  });
});

describe("mediaWrapExportCss", () => {
  test("emits exactly the two float rules, keyed off the serialized attributes", () => {
    const css = mediaWrapExportCss(".nw-ff-doc");
    expect(css).toContain(
      '.nw-ff-doc img[data-layout-mode="wrap"][data-layout-side="left"] { float: left;'
    );
    expect(css).toContain(
      '.nw-ff-doc img[data-layout-mode="wrap"][data-layout-side="right"] { float: right;'
    );
  });

  test("every selector carries the caller's scope, so an export stylesheet stays scoped", () => {
    const css = mediaWrapExportCss(".tiptap-content");
    for (const line of css.split("\n").map((l) => l.trim()).filter(Boolean)) {
      expect(line.startsWith(".tiptap-content ")).toBe(true);
    }
  });

  test("an image with no layout attributes matches no rule — legacy rendering untouched", () => {
    // The only selectors present require BOTH wrap attributes.
    const css = mediaWrapExportCss(".x");
    const selectors = css.match(/\.x [^{]+/g) || [];
    expect(selectors.length).toBe(2);
    for (const s of selectors) {
      expect(s).toContain('[data-layout-mode="wrap"]');
      expect(s).toContain("[data-layout-side=");
    }
  });
});
