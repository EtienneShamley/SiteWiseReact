// src/lib/freeformPaperScale.test.js
//
// THE ONE INVARIANT OF DOCUMENT ZOOM (Phase 8E.1): what is DRAWN grows with
// the displayed percentage. These tests relate the percentage the control
// shows to the width the sheet is laid out and drawn at, the size of the type
// inside it, and the pagination measurements taken over it — not to the
// helper that produced the percentage.
//
// jsdom cannot lay out CSS `zoom`, so the browser's own zoom arithmetic is
// stated here from the CSS specification (a percentage inside a zoomed
// subtree resolves against the containing block in that subtree's own px;
// every length is drawn at the scale) and applied to the REAL stylesheet
// rule, read from disk. The simulator remains the visual proof.
import fs from "fs";
import path from "path";
import { PAGE_WIDTH_PX } from "./pageGeometry";
import {
  ALL_DOCUMENT_ZOOM_LEVELS,
  DOCUMENT_ZOOM_LEVELS,
  PHONE_DOCUMENT_ZOOM_LEVELS,
  layoutPxFromVisualPx,
  zoomScale,
} from "./documentZoom";
import {
  FREEFORM_ZOOM_SCALE_VAR,
  freeformPaperLayoutWidth,
  freeformPaperVisualWidth,
  freeformVisualLength,
} from "./freeformPaperScale";
import { visualPageContentHeight } from "./freeformPageGuides";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const CSS = read("components/editor/freeformPagedEditor.css").replace(/\/\*[\s\S]*?\*\//g, "");
const PAPER_RULE = CSS.match(/\.nw-ff-page-surface \{([^}]*)\}/)[1];
const TEMPLATE_CSS = read("components/template/pagedDocument.css").replace(/\/\*[\s\S]*?\*\//g, "");
const PAGED_EDITOR = read("components/editor/FreeformPagedEditor.js");

const PHONE_CONTAINER_PX = 326; // a 375 px phone minus the shell's and the desk's padding
const DESKTOP_CONTAINER_PX = 1000;
const PHONE_LADDER = PHONE_DOCUMENT_ZOOM_LEVELS;
const strictlyIncreasing = (values) => values.every((v, i) => i === 0 || v > values[i - 1]);
const nonDecreasing = (values) => values.every((v, i) => i === 0 || v >= values[i - 1]);

/**
 * The browser's evaluation of the real stylesheet rule for a sheet inside a
 * wrapper zoomed to `scale`, in the subtree's own px (CSS Values: percentages
 * resolve against the containing block's own-px width, `container / scale`).
 */
function browserLaysOutPaper({ containerPx, scale }) {
  const width = PAPER_RULE.match(/width:\s*calc\(100% \* var\(--nw-doc-zoom-scale, 1\)\);/);
  const maxWidth = PAPER_RULE.match(/max-width:\s*min\(210mm, 100%\);/);
  expect(width).not.toBeNull();
  expect(maxWidth).not.toBeNull();
  const percent = containerPx / scale;
  const requested = percent * scale;
  return Math.min(requested, PAGE_WIDTH_PX, percent);
}

describe("6. the Free-form sheet, as DRAWN, grows with the displayed percentage", () => {
  test("phone: 25 < 40 < 50 < 60 < 75 < 90 < 100 — the sheet width the browser draws", () => {
    const drawn = PHONE_LADDER.filter((z) => z <= 100).map(
      (zoom) => browserLaysOutPaper({ containerPx: PHONE_CONTAINER_PX, scale: zoomScale(zoom) }) * zoomScale(zoom)
    );
    expect(strictlyIncreasing(drawn)).toBe(true);
    expect(drawn[0]).toBeCloseTo(PHONE_CONTAINER_PX * 0.25, 6);
    expect(drawn[drawn.length - 1]).toBeCloseTo(PHONE_CONTAINER_PX, 6);
  });

  test("phone: above 100% the sheet stays at the screen width and the TYPE keeps growing (the pre-existing behaviour, no sideways scroll)", () => {
    const widths = PHONE_LADDER.map(
      (zoom) => browserLaysOutPaper({ containerPx: PHONE_CONTAINER_PX, scale: zoomScale(zoom) }) * zoomScale(zoom)
    );
    expect(nonDecreasing(widths)).toBe(true);
    expect(Math.max(...widths)).toBeLessThanOrEqual(PHONE_CONTAINER_PX + 1e-6);
    const type = PHONE_LADDER.map((zoom) => freeformVisualLength(16, zoom));
    expect(strictlyIncreasing(type)).toBe(true);
    expect(type).toEqual(PHONE_LADDER.map((z) => (16 * z) / 100));
  });

  test("the model in freeformPaperScale.js is the stylesheet rule, number for number", () => {
    for (const containerPx of [PHONE_CONTAINER_PX, 600, DESKTOP_CONTAINER_PX]) {
      for (const zoom of ALL_DOCUMENT_ZOOM_LEVELS) {
        const scale = zoomScale(zoom);
        expect(freeformPaperLayoutWidth({ containerPx, zoom })).toBeCloseTo(
          browserLaysOutPaper({ containerPx, scale }),
          6
        );
        expect(freeformPaperVisualWidth({ containerPx, zoom })).toBeCloseTo(
          browserLaysOutPaper({ containerPx, scale }) * scale,
          6
        );
      }
    }
  });

  test("desktop: at or below 100% a wide workspace draws A4 × scale, and above 100% the sheet is capped at the container exactly as before", () => {
    const below = DOCUMENT_ZOOM_LEVELS.filter((z) => z <= 100);
    for (const zoom of below) {
      expect(freeformPaperVisualWidth({ containerPx: DESKTOP_CONTAINER_PX, zoom })).toBeCloseTo(
        PAGE_WIDTH_PX * zoomScale(zoom),
        6
      );
    }
    // What `width: 100%; max-width: 210mm` produced above 100%: min(container / scale, A4) × scale.
    for (const zoom of DOCUMENT_ZOOM_LEVELS.filter((z) => z > 100)) {
      const scale = zoomScale(zoom);
      const before = Math.min(DESKTOP_CONTAINER_PX / scale, PAGE_WIDTH_PX) * scale;
      expect(freeformPaperVisualWidth({ containerPx: DESKTOP_CONTAINER_PX, zoom })).toBeCloseTo(before, 6);
    }
  });

  test("the component publishes the scale the stylesheet reads, from the same zoomScale the wrapper uses", () => {
    expect(FREEFORM_ZOOM_SCALE_VAR).toBe("--nw-doc-zoom-scale");
    expect(PAGED_EDITOR).toContain("const shellStyle = { [FREEFORM_ZOOM_SCALE_VAR]: zoomScale(documentZoom) };");
    expect(PAGED_EDITOR).toContain('<div className="nw-ff-paged-shell" style={shellStyle}>');
  });
});

describe("10. zoom is a VIEW: the text column never reflows", () => {
  test("the sheet's LAYOUT width — what lines are wrapped at — is identical at every zoom up to 100%", () => {
    for (const containerPx of [PHONE_CONTAINER_PX, DESKTOP_CONTAINER_PX]) {
      const widths = PHONE_LADDER.filter((z) => z <= 100).map((zoom) =>
        freeformPaperLayoutWidth({ containerPx, zoom })
      );
      expect(new Set(widths.map((w) => Math.round(w * 1000)))).toEqual(
        new Set([Math.round(widths[0] * 1000)])
      );
    }
  });
});

describe("9. pagination measurements do not invert the visual zoom", () => {
  test("a block drawn at the scale, measured in visual px, normalises to ONE layout height on every phone step", () => {
    const layoutHeight = 240;
    const visual = PHONE_LADDER.map((zoom) => layoutHeight * zoomScale(zoom));
    expect(strictlyIncreasing(visual)).toBe(true);
    const normalised = PHONE_LADDER.map((zoom, i) => layoutPxFromVisualPx(visual[i], zoom));
    for (const value of normalised) expect(value).toBeCloseTo(layoutHeight, 9);
  });

  test("the sheet's usable height follows the constant layout width, so the page plan is the same plan at 25% and 100%", () => {
    const heights = PHONE_LADDER.filter((z) => z <= 100).map((zoom) =>
      visualPageContentHeight(freeformPaperLayoutWidth({ containerPx: PHONE_CONTAINER_PX, zoom }) - 80)
    );
    expect(new Set(heights.map((h) => Math.round(h * 1000)))).toEqual(new Set([Math.round(heights[0] * 1000)]));
    // …and what is DRAWN of that sheet still shrinks with the percentage.
    const drawn = PHONE_LADDER.filter((z) => z <= 100).map((zoom, i) => heights[i] * zoomScale(zoom));
    expect(strictlyIncreasing(drawn)).toBe(true);
  });

  test("under the old percent-width paper the drawn sheet GREW as the percentage fell — the defect, stated", () => {
    // width: 100% → the layout width was container / scale; the usable height
    // followed it; drawn height = (container / scale − 80) × aspect × scale.
    const drawn = PHONE_LADDER.filter((z) => z <= 100).map((zoom) => {
      const scale = zoomScale(zoom);
      return visualPageContentHeight(PHONE_CONTAINER_PX / scale - 80) * scale;
    });
    expect(drawn[0]).toBeGreaterThan(drawn[drawn.length - 1]);
  });
});

describe("7/8. the Template scales the same way and steps the same ladder", () => {
  test("the Template sheet is a fixed 210mm, so it is drawn at A4 × scale — strictly increasing across the phone ladder", () => {
    expect(TEMPLATE_CSS).toMatch(/\.paged-stack \{[^}]*width: 210mm;/);
    expect(TEMPLATE_CSS).toMatch(/\.paged-page \{[^}]*width: 210mm;/);
    const drawn = PHONE_LADDER.map((zoom) => PAGE_WIDTH_PX * zoomScale(zoom));
    expect(strictlyIncreasing(drawn)).toBe(true);
    expect(drawn[0]).toBeCloseTo(PAGE_WIDTH_PX * 0.25, 6);
  });

  test("both surfaces sit under ONE zoom wrapper, and the ladder is chosen by the SHELL, not by the surface", () => {
    const mainArea = read("components/MainArea.js");
    expect(mainArea).toContain('<div className="nw-doc-zoom" style={{ zoom: zoomScale(documentZoom) }}>');
    expect(mainArea).toContain("const zoomLevels = documentZoomLevelsForShell(shellLayout);");
    expect(mainArea).toContain("zoomInLevel(prev, zoomLevels)");
    expect(mainArea).toContain("zoomOutLevel(prev, zoomLevels)");
    expect(mainArea).toContain("useState(() => loadDocumentZoom(undefined, zoomLevels))");
    const toolbar = read("components/EditorToolbar.js");
    expect(toolbar).toContain("const zoomLevels = documentZoomLevelsForShell(shellLayout);");
    expect(toolbar).toContain("canZoomOut(documentZoom, zoomLevels)");
    expect(toolbar).toContain("canZoomIn(documentZoom, zoomLevels)");
    // No surface-specific ladder anywhere in the editor code.
    for (const file of ["components/MainArea.js", "components/EditorToolbar.js", "components/editor/FreeformPagedEditor.js", "components/template/NoteTemplateDoc.js"]) {
      expect(read(file)).not.toMatch(/PHONE_DOCUMENT_ZOOM_LEVELS|\[25, 40, 50/);
    }
  });
});

describe("11. no horizontal overflow from the sheet", () => {
  test("the sheet is never wider than its container at any zoom", () => {
    for (const containerPx of [PHONE_CONTAINER_PX, DESKTOP_CONTAINER_PX]) {
      for (const zoom of ALL_DOCUMENT_ZOOM_LEVELS) {
        expect(freeformPaperVisualWidth({ containerPx, zoom })).toBeLessThanOrEqual(containerPx + 1e-6);
      }
    }
  });

  test("no browser probe or engine sniff decides any of this", () => {
    for (const file of ["lib/documentZoom.js", "hooks/useFreeformPageGuides.js", "lib/freeformPaperScale.js", "components/editor/FreeformPagedEditor.js"]) {
      expect(read(file)).not.toMatch(/rectsIncludeZoom|clientRectsIncludeZoom|classifyClientRectZoom|navigator\.userAgent|WebKit/);
    }
  });
});
