// Tests for the pure branding model (src/lib/templateBranding.js).
//
// These cover the three things the branded-template feature depends on being
// unconditionally true:
//   1. Absent/legacy branding normalizes to defaults that reproduce the
//      PREVIOUS appearance, so opening an old template neither recolours it nor
//      changes its measured height.
//   2. Every stored value is clamped, enum-checked or hex-validated, and the
//      result is built by whitelist — so nothing arbitrary can reach a style
//      object (this is the trust boundary, not a formatting nicety).
//   3. Branding maps to safe style objects, including the structural
//      containment that keeps the logo inside the header.
import {
  BANNER_SHAPE,
  BORDER_WIDTH_PX,
  DEFAULT_BRANDING,
  HEADER_HEIGHT_MM,
  HEADER_LAYOUT,
  LOGO_SNAP_THRESHOLD_PCT,
  LOGO_WIDTH_PCT,
  MIN_CONTRAST_RATIO,
  TITLE_ALIGNMENT,
  TITLE_FONT_SIZE_PT,
  TITLE_MAX_LENGTH,
  TITLE_WEIGHT,
  brandingStyles,
  clampLogoWidthPct,
  contrastRatio,
  contrastWarnings,
  isDefaultBranding,
  isValidHexColor,
  layoutShowsLogo,
  normalizeBranding,
  normalizeHexColor,
  snapLogoPct,
} from "./templateBranding";

describe("absent branding defaults safely", () => {
  test("undefined / null / a non-object all yield the documented defaults", () => {
    const expected = DEFAULT_BRANDING;
    for (const input of [undefined, null, "", 0, false, [], "branding"]) {
      expect(normalizeBranding(input)).toEqual(expected);
    }
  });

  test("the defaults reproduce the pre-branding appearance", () => {
    const b = normalizeBranding(undefined);
    // White document, neutral 1px borders, dark text on white cells.
    expect(b.table).toEqual({
      labelBackgroundColor: "#ffffff",
      labelTextColor: "#111111",
      contentBackgroundColor: "#ffffff",
      contentTextColor: "#111111",
      borderColor: "#d1d5db",
      borderWidthPx: 1,
    });
    // The header band keeps the previous height (29mm ≈ the old 110px band) and
    // shows no coloured banner, so nothing is recoloured and nothing repaginates.
    expect(b.header.enabled).toBe(true);
    expect(b.header.heightMm).toBe(29);
    expect(b.header.backgroundColor).toBe("#ffffff");
    // The logo stays centred, as it was before.
    expect(b.header.logo).toEqual({ widthPct: 40, xPct: 50, yPct: 50 });
    // No title block exists, so no new page height is consumed.
    expect(b.title.enabled).toBe(false);
  });

  test("a partial branding object fills only the missing pieces", () => {
    const b = normalizeBranding({ table: { labelBackgroundColor: "#1aa3c2" } });
    expect(b.table.labelBackgroundColor).toBe("#1aa3c2");
    expect(b.table.borderColor).toBe(DEFAULT_BRANDING.table.borderColor);
    expect(b.header).toEqual(DEFAULT_BRANDING.header);
  });

  test("isDefaultBranding treats an absent branding key as the defaults", () => {
    expect(isDefaultBranding(undefined)).toBe(true);
    expect(isDefaultBranding({})).toBe(true);
    expect(isDefaultBranding({ title: { enabled: true } })).toBe(false);
  });
});

describe("colour validation", () => {
  test("valid hex colours normalize to lowercase 6-digit form", () => {
    expect(normalizeHexColor("#FFF", "#000000")).toBe("#ffffff");
    expect(normalizeHexColor("#1AA3C2", "#000000")).toBe("#1aa3c2");
    expect(normalizeHexColor("  #abc  ", "#000000")).toBe("#aabbcc");
  });

  test("anything that is not a literal hex colour is rejected to the fallback", () => {
    const rejected = [
      "rgb(255,0,0)",
      "hsl(200 50% 50%)",
      "red",
      "transparent",
      "var(--nw-accent)",
      "url(https://example.com/x.png)",
      "#12345",
      "#gggggg",
      "#ffffff; background:url(javascript:alert(1))",
      "expression(alert(1))",
      "",
      null,
      undefined,
      123,
      {},
    ];
    for (const value of rejected) {
      expect(isValidHexColor(value)).toBe(false);
      expect(normalizeHexColor(value, "#d1d5db")).toBe("#d1d5db");
    }
  });

  test("an invalid colour anywhere in stored branding falls back, never passes through", () => {
    const b = normalizeBranding({
      header: { backgroundColor: "url(evil.png)" },
      title: { color: "rgb(1,2,3)" },
      table: {
        labelBackgroundColor: "#fff; content:'x'",
        labelTextColor: "javascript:alert(1)",
        borderColor: "#ZZZ",
      },
    });
    expect(b.header.backgroundColor).toBe(DEFAULT_BRANDING.header.backgroundColor);
    expect(b.title.color).toBe(DEFAULT_BRANDING.title.color);
    expect(b.table.labelBackgroundColor).toBe(DEFAULT_BRANDING.table.labelBackgroundColor);
    expect(b.table.labelTextColor).toBe(DEFAULT_BRANDING.table.labelTextColor);
    expect(b.table.borderColor).toBe(DEFAULT_BRANDING.table.borderColor);

    // ...and no fragment of the rejected input survives into the style objects.
    const serialized = JSON.stringify(brandingStyles(b));
    expect(serialized).not.toMatch(/url\(|javascript:|content:|expression\(/);
  });
});

describe("numeric clamping", () => {
  test("header height clamps to its documented range", () => {
    expect(normalizeBranding({ header: { heightMm: 0 } }).header.heightMm).toBe(
      HEADER_HEIGHT_MM.min
    );
    expect(normalizeBranding({ header: { heightMm: 5000 } }).header.heightMm).toBe(
      HEADER_HEIGHT_MM.max
    );
    expect(normalizeBranding({ header: { heightMm: 40 } }).header.heightMm).toBe(40);
  });

  test("logo width and position percentages clamp", () => {
    const b = normalizeBranding({
      header: { logo: { widthPct: 900, xPct: -50, yPct: 250 } },
    });
    expect(b.header.logo.widthPct).toBe(LOGO_WIDTH_PCT.max);
    expect(b.header.logo.xPct).toBe(0);
    expect(b.header.logo.yPct).toBe(100);
  });

  test("title font size clamps", () => {
    expect(normalizeBranding({ title: { fontSizePt: 2 } }).title.fontSizePt).toBe(
      TITLE_FONT_SIZE_PT.min
    );
    expect(normalizeBranding({ title: { fontSizePt: 400 } }).title.fontSizePt).toBe(
      TITLE_FONT_SIZE_PT.max
    );
  });

  test("border width clamps and is rounded to a whole pixel", () => {
    expect(normalizeBranding({ table: { borderWidthPx: -4 } }).table.borderWidthPx).toBe(
      BORDER_WIDTH_PX.min
    );
    expect(normalizeBranding({ table: { borderWidthPx: 99 } }).table.borderWidthPx).toBe(
      BORDER_WIDTH_PX.max
    );
    expect(normalizeBranding({ table: { borderWidthPx: 2.4 } }).table.borderWidthPx).toBe(2);
  });

  test("non-numeric, NaN and Infinity fall back to the default rather than 0", () => {
    for (const bad of ["", "20mm", NaN, Infinity, -Infinity, null, {}, []]) {
      expect(normalizeBranding({ header: { heightMm: bad } }).header.heightMm).toBe(
        HEADER_HEIGHT_MM.default
      );
    }
  });
});

describe("enum normalization", () => {
  test("layout preset, banner shape, alignment and weight reject unknown values", () => {
    const b = normalizeBranding({
      header: { layoutStyle: "free-canvas", bannerShape: "swoosh" },
      title: { alignment: "justify", fontWeight: "900" },
    });
    expect(b.header.layoutStyle).toBe(DEFAULT_BRANDING.header.layoutStyle);
    expect(b.header.bannerShape).toBe(DEFAULT_BRANDING.header.bannerShape);
    expect(b.title.alignment).toBe(DEFAULT_BRANDING.title.alignment);
    expect(b.title.fontWeight).toBe(DEFAULT_BRANDING.title.fontWeight);
  });

  test("every supported preset round-trips unchanged", () => {
    for (const layoutStyle of Object.values(HEADER_LAYOUT)) {
      expect(normalizeBranding({ header: { layoutStyle } }).header.layoutStyle).toBe(
        layoutStyle
      );
    }
    for (const bannerShape of Object.values(BANNER_SHAPE)) {
      expect(normalizeBranding({ header: { bannerShape } }).header.bannerShape).toBe(
        bannerShape
      );
    }
    for (const alignment of Object.values(TITLE_ALIGNMENT)) {
      expect(normalizeBranding({ title: { alignment } }).title.alignment).toBe(alignment);
    }
    for (const fontWeight of Object.values(TITLE_WEIGHT)) {
      expect(normalizeBranding({ title: { fontWeight } }).title.fontWeight).toBe(fontWeight);
    }
  });

  test("only the banner-only preset omits the logo", () => {
    expect(layoutShowsLogo(HEADER_LAYOUT.BANNER_ONLY)).toBe(false);
    expect(layoutShowsLogo(HEADER_LAYOUT.LOGO_LEFT)).toBe(true);
    expect(layoutShowsLogo(HEADER_LAYOUT.LOGO_OVER)).toBe(true);
    expect(layoutShowsLogo(HEADER_LAYOUT.LOGO_ABOVE)).toBe(true);
  });

  test("booleans are not coerced from truthy/falsy values", () => {
    expect(normalizeBranding({ title: { enabled: "yes" } }).title.enabled).toBe(false);
    expect(normalizeBranding({ title: { enabled: 1 } }).title.enabled).toBe(false);
    expect(normalizeBranding({ title: { enabled: true } }).title.enabled).toBe(true);
    expect(normalizeBranding({ header: { enabled: false } }).header.enabled).toBe(false);
  });
});

describe("title text handling", () => {
  test("a non-string title falls back to empty", () => {
    for (const bad of [null, 42, {}, []]) {
      expect(normalizeBranding({ title: { text: bad } }).title.text).toBe("");
    }
  });

  test("an over-long title is clamped, not rejected", () => {
    const long = "x".repeat(TITLE_MAX_LENGTH + 500);
    expect(normalizeBranding({ title: { text: long } }).title.text).toHaveLength(
      TITLE_MAX_LENGTH
    );
  });

  test("markup in a title is stored verbatim (it is rendered as escaped text, never HTML)", () => {
    const text = "<img src=x onerror=alert(1)>";
    expect(normalizeBranding({ title: { text } }).title.text).toBe(text);
  });
});

describe("unknown properties are dropped, not interpreted", () => {
  test("the normalized object contains exactly the whitelisted keys", () => {
    const b = normalizeBranding({
      header: { enabled: true, evil: "url(x)", logo: { widthPct: 30, rotate: 45 } },
      title: { enabled: true, textShadow: "0 0 10px red" },
      table: { labelBackgroundColor: "#1aa3c2", cellCss: "position:fixed" },
      watermark: { image: "data:image/png;base64,AAAA" },
    });

    expect(Object.keys(b).sort()).toEqual(["header", "table", "title"]);
    expect(Object.keys(b.header).sort()).toEqual([
      "backgroundColor",
      "bannerShape",
      "enabled",
      "heightMm",
      "layoutStyle",
      "logo",
    ]);
    expect(Object.keys(b.header.logo).sort()).toEqual(["widthPct", "xPct", "yPct"]);
    expect(Object.keys(b.title).sort()).toEqual([
      "alignment",
      "color",
      "enabled",
      "fontSizePt",
      "fontWeight",
      "text",
    ]);
    expect(Object.keys(b.table).sort()).toEqual([
      "borderColor",
      "borderWidthPx",
      "contentBackgroundColor",
      "contentTextColor",
      "labelBackgroundColor",
      "labelTextColor",
    ]);

    // Nothing carried over — no CSS string, no data URL, no watermark.
    const serialized = JSON.stringify(b);
    expect(serialized).not.toContain("evil");
    expect(serialized).not.toContain("rotate");
    expect(serialized).not.toContain("textShadow");
    expect(serialized).not.toContain("cellCss");
    expect(serialized).not.toContain("watermark");
    expect(serialized).not.toContain("data:");
  });

  test("no blob/data URL or remote URL can be smuggled into branding", () => {
    const b = normalizeBranding({
      header: {
        backgroundColor: "#123456",
        logoUrl: "https://example.com/logo.svg",
        logoSrc: "data:image/svg+xml,<svg onload=alert(1)>",
        logo: { blob: "blob:http://localhost/abc", widthPct: 50 },
      },
    });
    const serialized = JSON.stringify(b);
    expect(serialized).not.toMatch(/https?:|data:|blob:|svg/i);
    expect(b.header.logo).toEqual({ widthPct: 50, xPct: 50, yPct: 50 });
  });

  test("normalizeBranding never mutates its input", () => {
    const input = { header: { heightMm: 9999 }, title: { text: "x" } };
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeBranding(input);
    expect(input).toEqual(snapshot);
  });
});

describe("branding maps to safe style objects", () => {
  test("table colours become CSS custom properties", () => {
    const styles = brandingStyles({
      table: {
        labelBackgroundColor: "#1aa3c2",
        labelTextColor: "#ffffff",
        contentBackgroundColor: "#ffffff",
        contentTextColor: "#111111",
        borderColor: "#9ca3af",
        borderWidthPx: 2,
      },
    });
    expect(styles.table).toEqual({
      "--nw-tpl-label-bg": "#1aa3c2",
      "--nw-tpl-label-text": "#ffffff",
      "--nw-tpl-content-bg": "#ffffff",
      "--nw-tpl-content-text": "#111111",
      "--nw-tpl-border-color": "#9ca3af",
      "--nw-tpl-border-width": "2px",
    });
  });

  test("the header height is expressed in mm so it prints at true A4 scale", () => {
    expect(brandingStyles({ header: { heightMm: 34 } }).header).toEqual({ height: "34mm" });
  });

  test("logo placement is structurally contained by the paired translate", () => {
    // For ANY percentage in 0-100 the offset and the translate match, which is
    // what keeps the logo inside its box without a clamp-back measurement pass.
    for (const [xPct, yPct] of [
      [0, 0],
      [50, 50],
      [100, 100],
      [12.5, 87.5],
    ]) {
      const { logo } = brandingStyles({ header: { logo: { xPct, yPct, widthPct: 30 } } });
      expect(logo.left).toBe(`${xPct}%`);
      expect(logo.top).toBe(`${yPct}%`);
      expect(logo.transform).toBe(`translate(-${xPct}%, -${yPct}%)`);
      // Only width is ever set — height stays auto, so the aspect ratio is
      // preserved and the logo can never be stretched or squashed.
      expect(logo.width).toBe("30%");
      expect(logo).not.toHaveProperty("height");
    }
  });

  test("the banner-only preset exposes no logo box", () => {
    expect(
      brandingStyles({ header: { layoutStyle: HEADER_LAYOUT.BANNER_ONLY } }).logoBox
    ).toBeNull();
    expect(
      brandingStyles({ header: { layoutStyle: HEADER_LAYOUT.LOGO_LEFT } }).logoBox
    ).not.toBeNull();
  });

  test("banner shapes emit constant clip-paths only for the shaped presets", () => {
    const straight = brandingStyles({ header: { bannerShape: BANNER_SHAPE.STRAIGHT } });
    expect(straight.banner.clipPath).toBeUndefined();
    const angled = brandingStyles({ header: { bannerShape: BANNER_SHAPE.ANGLED_LEFT } });
    expect(angled.banner.clipPath).toMatch(/^polygon\([0-9%\s,]+\)$/);
  });

  test("title style is built from validated values only", () => {
    const { title } = brandingStyles({
      title: {
        color: "#b91c1c",
        fontSizePt: 18,
        fontWeight: TITLE_WEIGHT.BOLD,
        alignment: TITLE_ALIGNMENT.RIGHT,
      },
    });
    expect(title).toEqual({
      color: "#b91c1c",
      fontSize: "18pt",
      fontWeight: 700,
      textAlign: "right",
    });
  });

  test("style objects survive garbage input without producing garbage output", () => {
    const styles = brandingStyles({ header: "nope", title: 7, table: null });
    expect(styles.header.height).toBe(`${HEADER_HEIGHT_MM.default}mm`);
    expect(styles.table["--nw-tpl-border-width"]).toBe("1px");
  });
});

describe("contrast warnings", () => {
  test("black on white and white on a dark brand colour pass", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastWarnings(undefined)).toEqual([]);
    expect(
      contrastWarnings({
        table: { labelBackgroundColor: "#0e7490", labelTextColor: "#ffffff" },
      })
    ).toEqual([]);
  });

  test("a low-contrast label pair is reported without changing the colour", () => {
    const branding = {
      table: { labelBackgroundColor: "#39dde9", labelTextColor: "#ffffff" },
    };
    const warnings = contrastWarnings(branding);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].id).toBe("label");
    expect(warnings[0].ratio).toBeLessThan(MIN_CONTRAST_RATIO);
    // The user's chosen colour is untouched — a warning is advice, not a fix.
    expect(normalizeBranding(branding).table.labelBackgroundColor).toBe("#39dde9");
  });

  test("the content pair is checked independently of the label pair", () => {
    const warnings = contrastWarnings({
      table: {
        labelBackgroundColor: "#000000",
        labelTextColor: "#ffffff",
        contentBackgroundColor: "#ffffff",
        contentTextColor: "#f3f4f6",
      },
    });
    expect(warnings.map((w) => w.id)).toEqual(["content"]);
  });

  test("contrast is symmetric", () => {
    expect(contrastRatio("#1aa3c2", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#1aa3c2"),
      10
    );
  });
});

describe("direct-manipulation helpers", () => {
  test("dragging snaps to 0 / 50 / 100 within the threshold and nowhere else", () => {
    expect(snapLogoPct(1)).toBe(0);
    expect(snapLogoPct(LOGO_SNAP_THRESHOLD_PCT)).toBe(0);
    expect(snapLogoPct(49)).toBe(50);
    expect(snapLogoPct(51.5)).toBe(50);
    expect(snapLogoPct(99)).toBe(100);
    // Outside the threshold the value is kept (rounded to 0.1% for stability).
    expect(snapLogoPct(30)).toBe(30);
    expect(snapLogoPct(44.44)).toBe(44.4);
  });

  test("snapping still clamps out-of-range drag values", () => {
    expect(snapLogoPct(-30)).toBe(0);
    expect(snapLogoPct(130)).toBe(100);
    expect(snapLogoPct(NaN)).toBe(50); // default position, never NaN in a style
  });

  test("a dragged logo width is clamped to the allowed range", () => {
    expect(clampLogoWidthPct(0)).toBe(LOGO_WIDTH_PCT.min);
    expect(clampLogoWidthPct(1000)).toBe(LOGO_WIDTH_PCT.max);
    expect(clampLogoWidthPct(42.36)).toBe(42.4);
  });
});
