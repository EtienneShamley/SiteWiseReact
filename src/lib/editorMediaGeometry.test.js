// src/lib/editorMediaGeometry.test.js
//
// THE CONTAINER GEOMETRY RULE, proven with real numbers: a media resize must
// divide a VISUAL pointer delta by a VISUAL content width, so the same
// proportional drag produces the same widthPct at every document zoom level.
//
// The defect this suite locks out: a rect width (visual) minus a computed
// padding (layout), which is exact at 100% and drifts by the padding's share
// of the container everywhere else.
import {
  mediaContentBoxWidth,
  measureMediaContentBoxWidth,
} from "./editorMediaGeometry";
import {
  MEDIA_RESIZE_CORNER,
  mediaWidthPctFromPointer,
} from "./editorMediaResize";
import { DOCUMENT_ZOOM_LEVELS, zoomScale } from "./documentZoom";
import { MAX_PHOTO_WIDTH_PCT, MIN_PHOTO_WIDTH_PCT } from "./noteAttachments";

/**
 * A container as the browser would report it at a given zoom.
 *
 * `getComputedStyle` lengths are LAYOUT px and do not change with CSS zoom;
 * `getBoundingClientRect()` is VISUAL px and does. That asymmetry is the whole
 * problem, so the fake models it explicitly rather than scaling everything.
 */
const containerAt = ({ contentWidth, paddingX = 0, borderX = 0, zoom = 100 }) => ({
  borderBoxWidth: (contentWidth + paddingX + borderX) * zoomScale(zoom),
  contentWidth,
  paddingX,
  borderX,
});

/** A DOM stand-in for the reader — only the two APIs it uses are provided. */
const elementAt = ({ contentWidth, paddingX = 0, borderX = 0, zoom = 100 }) => ({
  getBoundingClientRect: () => ({
    width: (contentWidth + paddingX + borderX) * zoomScale(zoom),
  }),
  ownerDocument: {
    defaultView: {
      getComputedStyle: () => ({
        width: `${contentWidth}px`,
        paddingLeft: `${paddingX / 2}px`,
        paddingRight: `${paddingX / 2}px`,
        borderLeftWidth: `${borderX / 2}px`,
        borderRightWidth: `${borderX / 2}px`,
      }),
    },
  },
});

// A4 paper at 96dpi with the product's 20 mm margins: the padded case the
// original defect was estimated against.
const PAPER = { contentWidth: 642.5, paddingX: 151.2 };

/* ===================== 1–5. the content width itself ===================== */

describe("1–5. the content-box width is always in the pointer's own space", () => {
  test("1. no padding at 100%: the border box IS the content box", () => {
    expect(mediaContentBoxWidth(containerAt({ contentWidth: 800, zoom: 100 }))).toBeCloseTo(800, 9);
  });

  test("2. no padding at 150%: it scales with what the user sees", () => {
    expect(mediaContentBoxWidth(containerAt({ contentWidth: 800, zoom: 150 }))).toBeCloseTo(1200, 9);
  });

  test("3. a padded parent at 100% subtracts the padding exactly", () => {
    expect(mediaContentBoxWidth(containerAt({ ...PAPER, zoom: 100 }))).toBeCloseTo(642.5, 9);
  });

  test("4/5. the SAME padded parent at 125% and 150% stays exact — this is the regression", () => {
    expect(mediaContentBoxWidth(containerAt({ ...PAPER, zoom: 125 }))).toBeCloseTo(642.5 * 1.25, 9);
    expect(mediaContentBoxWidth(containerAt({ ...PAPER, zoom: 150 }))).toBeCloseTo(642.5 * 1.5, 9);
  });

  test("the mixed-space answer is provably different, so this test would fail on the old rule", () => {
    const at150 = containerAt({ ...PAPER, zoom: 150 });
    const mixed = at150.borderBoxWidth - PAPER.paddingX; // the defect
    const correct = mediaContentBoxWidth(at150);
    expect(mixed).not.toBeCloseTo(correct, 1);
    // …and the error is the padding's share of the container, as reported.
    expect(Math.abs(mixed - correct) / correct).toBeGreaterThan(0.07);
  });

  test("a border is part of the border box but not the content box, and is removed too", () => {
    const width = mediaContentBoxWidth(containerAt({ contentWidth: 600, paddingX: 40, borderX: 4, zoom: 125 }));
    expect(width).toBeCloseTo(600 * 1.25, 9);
  });

  test("the content width is a fixed fraction of the visual border box at every zoom", () => {
    const ratios = DOCUMENT_ZOOM_LEVELS.map((zoom) => {
      const c = containerAt({ ...PAPER, zoom });
      return mediaContentBoxWidth(c) / c.borderBoxWidth;
    });
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0], 12);
  });

  test("unusable input degrades in ONE space rather than mixing them", () => {
    // No computed style at all: the border box is the honest visual answer.
    expect(mediaContentBoxWidth({ borderBoxWidth: 500, contentWidth: null })).toBe(500);
    expect(mediaContentBoxWidth({ borderBoxWidth: 500, contentWidth: NaN })).toBe(500);
    // An `auto`/zero width resolves nothing usable.
    expect(mediaContentBoxWidth({ borderBoxWidth: 500, contentWidth: 0 })).toBe(500);
    // Nothing to measure at all.
    expect(mediaContentBoxWidth({ borderBoxWidth: 0, contentWidth: 100 })).toBeNull();
    expect(mediaContentBoxWidth({})).toBeNull();
    expect(mediaContentBoxWidth()).toBeNull();
  });

  test("the DOM reader produces the same answers as the rule it delegates to", () => {
    for (const zoom of DOCUMENT_ZOOM_LEVELS) {
      expect(measureMediaContentBoxWidth(elementAt({ ...PAPER, zoom }))).toBeCloseTo(
        mediaContentBoxWidth(containerAt({ ...PAPER, zoom })),
        9
      );
    }
    expect(measureMediaContentBoxWidth(null)).toBeNull();
    expect(measureMediaContentBoxWidth({})).toBeNull();
    // No computed style available (a detached or exotic host).
    expect(
      measureMediaContentBoxWidth({ getBoundingClientRect: () => ({ width: 400 }) })
    ).toBe(400);
  });
});

/* ================ 6–10. the resize the geometry feeds ==================== */

/**
 * One gesture: drag a handle through the same PROPORTION of the container at
 * a given zoom, and report the widthPct it produces. The pointer travels in
 * VISUAL px, which is the only thing a pointer can do.
 */
function resizeAt({ zoom, corner, startWidthPct, fractionOfContainer, container = PAPER }) {
  const c = containerAt({ ...container, zoom });
  const containerWidth = mediaContentBoxWidth(c);
  const travelVisual = containerWidth * fractionOfContainer;
  const growsRight = corner === MEDIA_RESIZE_CORNER.BOTTOM_RIGHT || corner === MEDIA_RESIZE_CORNER.TOP_RIGHT;
  return mediaWidthPctFromPointer({
    corner,
    startWidthPct,
    startX: 0,
    clientX: growsRight ? travelVisual : -travelVisual,
    containerWidth,
  });
}

describe("6–10. the same proportional drag gives the same widthPct at every zoom", () => {
  test("7/8. a right-handle drag of 10% of the container always adds 10 points", () => {
    for (const zoom of DOCUMENT_ZOOM_LEVELS) {
      expect(
        resizeAt({
          zoom,
          corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
          startWidthPct: 50,
          fractionOfContainer: 0.1,
        })
      ).toBe(60);
    }
  });

  test("6/8. a left-handle drag away from the image grows it identically at every zoom", () => {
    for (const zoom of DOCUMENT_ZOOM_LEVELS) {
      expect(
        resizeAt({
          zoom,
          corner: MEDIA_RESIZE_CORNER.TOP_LEFT,
          startWidthPct: 50,
          fractionOfContainer: 0.2,
        })
      ).toBe(70);
    }
  });

  test("8. an unpadded container agrees with a padded one — the surface never changes the answer", () => {
    for (const zoom of DOCUMENT_ZOOM_LEVELS) {
      const padded = resizeAt({
        zoom,
        corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
        startWidthPct: 40,
        fractionOfContainer: 0.25,
        container: PAPER,
      });
      const bare = resizeAt({
        zoom,
        corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
        startWidthPct: 40,
        fractionOfContainer: 0.25,
        container: { contentWidth: 900 },
      });
      expect(padded).toBe(65);
      expect(bare).toBe(65);
    }
  });

  test("9. the minimum clamp holds at every zoom", () => {
    for (const zoom of DOCUMENT_ZOOM_LEVELS) {
      expect(
        resizeAt({
          zoom,
          corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
          startWidthPct: 20,
          fractionOfContainer: -0.9,
        })
      ).toBe(MIN_PHOTO_WIDTH_PCT);
    }
  });

  test("10. the maximum clamp holds at every zoom", () => {
    for (const zoom of DOCUMENT_ZOOM_LEVELS) {
      expect(
        resizeAt({
          zoom,
          corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
          startWidthPct: 90,
          fractionOfContainer: 0.9,
        })
      ).toBe(MAX_PHOTO_WIDTH_PCT);
    }
  });

  test("100% behaviour is byte-for-byte what it always was", () => {
    // A plain unpadded container at 100% is the pre-existing path exactly:
    // the rect width, no subtraction, no ratio.
    const c = containerAt({ contentWidth: 1000, zoom: 100 });
    expect(mediaContentBoxWidth(c)).toBe(1000);
    expect(
      mediaWidthPctFromPointer({
        corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
        startWidthPct: 50,
        startX: 0,
        clientX: 100,
        containerWidth: 1000,
      })
    ).toBe(60);
  });

  test("a gesture that ends where it started still saves nothing, at every zoom", () => {
    for (const zoom of DOCUMENT_ZOOM_LEVELS) {
      expect(
        resizeAt({
          zoom,
          corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
          startWidthPct: 55,
          fractionOfContainer: 0,
        })
      ).toBe(55);
    }
  });
});

/* ========================== regression / purity ========================== */

describe("the media core stays zoom-agnostic", () => {
  test("the geometry rule is told nothing about zoom and imports nothing", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "editorMediaGeometry.js"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/documentZoom|zoomScale|currentCSSZoom/);
    // …and neither does the resize arithmetic it feeds.
    const resize = fs.readFileSync(path.join(__dirname, "editorMediaResize.js"), "utf8");
    expect(resize).not.toMatch(/documentZoom|zoomScale/);
  });

  test("one geometry rule serves both surfaces — the shared NodeView, never a per-surface copy", () => {
    const fs = require("fs");
    const path = require("path");
    const SRC = path.join(__dirname, "..");
    const assetImage = fs.readFileSync(path.join(SRC, "components/editor/AssetImage.js"), "utf8");
    expect(assetImage).toMatch(
      /import \{ measureMediaContentBoxWidth \} from "\.\.\/\.\.\/lib\/editorMediaGeometry"/
    );
    // The old mixed-space helper is gone, not merely unused.
    expect(assetImage).not.toMatch(/function contentBoxWidth/);
    expect(assetImage).not.toMatch(/width -= \(parseFloat/);
    // No other component measures a container width for a resize.
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(full);
      }
      return out;
    };
    const readers = walk(SRC)
      .filter((f) => /measureMediaContentBoxWidth|mediaContentBoxWidth/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.basename(f))
      .sort();
    expect(readers).toEqual(["AssetImage.js", "editorMediaGeometry.js"]);
  });

  test("nothing zoom-specific is ever stored: a resize saves a widthPct and nothing else", () => {
    const fs = require("fs");
    const path = require("path");
    const assetImage = fs.readFileSync(path.join(__dirname, "..", "components/editor/AssetImage.js"), "utf8");
    expect(assetImage).toMatch(/onCommit: \(pct\) => updateMediaAttrs\(editor, \{ widthPct: pct \}\)/);
    expect(assetImage).not.toMatch(/zoom:\s*[^)]*updateMediaAttrs|widthPx|scaleFactor/);
  });
});
