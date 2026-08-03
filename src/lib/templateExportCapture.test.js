// The rasterisation geometry: the arithmetic that decides where html2pdf cuts
// the captured bitmap into A4 pages, and how much of the document is captured
// in the first place.
//
// These are the numbers that produced a one-page PDF whose footer was sliced in
// half by the bottom edge of the canvas. They are pure arithmetic, so they can
// be pinned exactly — jsdom performs no layout, but none is needed here.

import {
  CAPTURE_SCALE,
  PDF_PAGE_CONTENT_HEIGHT_PX,
  USABLE_HEIGHT_MM,
  USABLE_WIDTH_MM,
  canvasWidthDevicePx,
  captureHeightPx,
  captureIsAligned,
  captureWidthPx,
  pdfPageCountFor,
  pdfSliceHeightDevicePx,
} from "./templateExportCapture";
import { USABLE_HEIGHT_PX, USABLE_WIDTH_PX } from "./pageGeometry";

describe("page box", () => {
  test("it is the A4 content area the rest of the app already uses", () => {
    expect(USABLE_WIDTH_MM).toBe(170);
    expect(USABLE_HEIGHT_MM).toBe(257);
  });

  test("the page height is floored exactly as html2pdf's own toPx() floors it", () => {
    expect(PDF_PAGE_CONTENT_HEIGHT_PX).toBe(Math.floor(USABLE_HEIGHT_PX));
    expect(PDF_PAGE_CONTENT_HEIGHT_PX).toBe(971);
  });
});

describe("capture width", () => {
  test("it is rounded DOWN to a whole device pixel", () => {
    // 642.5197 CSS px is 1285.04 device px at scale 2. Rounding up (the previous
    // build used a 643 px page) pushed the table's right border outside the
    // bitmap html2canvas produced, and it was captured mid-stroke.
    expect(captureWidthPx(2)).toBe(642.5);
    expect(canvasWidthDevicePx(2)).toBe(1285);
  });

  test("it never exceeds the usable page width", () => {
    for (const scale of [1, 2, 3, 4]) {
      expect(captureWidthPx(scale)).toBeLessThanOrEqual(USABLE_WIDTH_PX);
    }
  });

  test("html2canvas's own floor(width * scale) loses nothing", () => {
    for (const scale of [1, 2, 3, 4]) {
      expect(Math.floor(captureWidthPx(scale) * scale)).toBe(
        canvasWidthDevicePx(scale)
      );
    }
  });

  test("an invalid scale falls back to the configured one", () => {
    for (const bad of [0, -2, NaN, Infinity, null, undefined, "2"]) {
      expect(captureWidthPx(bad)).toBe(captureWidthPx(CAPTURE_SCALE));
    }
  });
});

describe("slice alignment", () => {
  test("html2pdf's slice is exactly the page box its pagebreak plugin pads to", () => {
    // The defect this guards: the pagebreak plugin starts each page at a
    // multiple of 971 CSS px while toPdf() slices the bitmap at
    // floor(canvasWidth * ratio). At a 643 px capture those are 1942 and 1944
    // device px — every page carried a sliver of the next one.
    expect(pdfSliceHeightDevicePx(2)).toBe(1942);
    expect(pdfSliceHeightDevicePx(2)).toBe(PDF_PAGE_CONTENT_HEIGHT_PX * 2);
    expect(captureIsAligned(2)).toBe(true);
  });
});

describe("capture height", () => {
  test("it is a whole number of page boxes", () => {
    expect(captureHeightPx(1)).toBe(971);
    expect(captureHeightPx(3)).toBe(2913);
  });

  test("a degenerate page count still captures one whole page", () => {
    for (const bad of [0, -1, NaN, null, undefined]) {
      expect(captureHeightPx(bad)).toBe(PDF_PAGE_CONTENT_HEIGHT_PX);
    }
  });

  test("the whole footer is inside the capture, not on its edge", () => {
    // A one-page plan whose content ends at 800 px is captured to the full 971,
    // so the page number cannot be clipped by the bottom of the bitmap.
    expect(captureHeightPx(1)).toBeGreaterThan(800);
  });
});

describe("resulting PDF page count", () => {
  test("a plan of N pages produces exactly N physical pages", () => {
    for (const pages of [1, 2, 3, 4, 5, 10, 25, 60]) {
      expect(pdfPageCountFor(pages)).toBe(pages);
    }
  });

  test("no blank trailing page is ever produced", () => {
    for (const pages of [1, 2, 3, 7, 12]) {
      expect(pdfPageCountFor(pages)).not.toBe(pages + 1);
    }
  });
});
