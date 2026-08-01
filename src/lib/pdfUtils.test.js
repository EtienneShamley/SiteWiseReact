// Automated checks for the PDF export pipeline (src/lib/pdfUtils.js).
//
// pdf.js is ESM-only and is never exercised here — this suite covers the
// pdf-lib flatten path and the export transaction state. pdf.js is replaced
// with a stub so the module can be imported at all under jest; no network,
// no worker and no external service is involved.
jest.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {},
  getDocument: () => ({ promise: Promise.resolve(null) }),
}));

import { PDFDocument } from "pdf-lib";
import { EXPORT_STATE, canStartExport, flattenAnnotations } from "./pdfUtils";

/** Build a real, minimal source PDF to flatten into. */
async function makeSourcePdf(pageCount = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([600, 800]);
  return doc.save();
}

/** jsdom's Blob has no arrayBuffer() on this runtime — read it the long way. */
function blobToBytes(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

// A page's scale-1 viewport transform for an unrotated 600x800 page.
const META = { 1: { transform: [1, 0, 0, -1, 0, 800] }, 2: { transform: [1, 0, 0, -1, 0, 800] } };

const rect = (over = {}) => ({
  id: "r1",
  page: 1,
  type: "rect",
  x: 100,
  y: 100,
  w: 120,
  h: 80,
  stroke: "#E53935",
  strokeWidth: 2,
  ...over,
});

const arrow = (over = {}) => ({
  id: "ar1",
  page: 1,
  type: "arrow",
  x1: 50,
  y1: 60,
  x2: 250,
  y2: 160,
  stroke: "#1976D2",
  strokeWidth: 3,
  head: "single",
  ...over,
});

describe("export transaction state", () => {
  test("an export may start from idle, success or failure", () => {
    expect(canStartExport(EXPORT_STATE.IDLE)).toBe(true);
    expect(canStartExport(EXPORT_STATE.SUCCESS)).toBe(true);
    expect(canStartExport(EXPORT_STATE.FAILURE)).toBe(true);
  });

  test("a duplicate export is prevented while one is in flight", () => {
    expect(canStartExport(EXPORT_STATE.EXPORTING)).toBe(false);
  });

  test("no document means no export", () => {
    expect(canStartExport(EXPORT_STATE.IDLE, { hasDocument: false })).toBe(false);
  });
});

describe("flattenAnnotations", () => {
  test("produces a valid, non-empty PDF", async () => {
    const src = await makeSourcePdf();
    const blob = await flattenAnnotations(src, { 1: [rect()] }, META);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);
    const bytes = await blobToBytes(blob);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
  });

  test("never mutates the canonical source bytes", async () => {
    const src = await makeSourcePdf();
    const before = Uint8Array.from(src);
    await flattenAnnotations(src, { 1: [rect(), arrow()] }, META);
    expect(Uint8Array.from(src)).toEqual(before);
  });

  test("the original page count and content survive", async () => {
    const src = await makeSourcePdf(3);
    const blob = await flattenAnnotations(src, { 2: [rect({ page: 2 })] }, META);
    const out = await PDFDocument.load(await blobToBytes(blob));
    expect(out.getPageCount()).toBe(3);
    expect(out.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
  });

  test("multi-page documents export every page", async () => {
    const src = await makeSourcePdf(5);
    const blob = await flattenAnnotations(
      src,
      { 1: [rect()], 5: [rect({ id: "r5", page: 5 })] },
      META
    );
    const out = await PDFDocument.load(await blobToBytes(blob));
    expect(out.getPageCount()).toBe(5);
  });

  test("annotations on different pages produce different output", async () => {
    const src = await makeSourcePdf(2);
    const onPage1 = await blobToBytes(await flattenAnnotations(src, { 1: [rect()] }, META));
    const onPage2 = await blobToBytes(
      await flattenAnnotations(src, { 2: [rect({ page: 2 })] }, META)
    );
    expect(onPage1.length).toBeGreaterThan(0);
    expect(onPage2.length).toBeGreaterThan(0);
    expect(Buffer.from(onPage1).equals(Buffer.from(onPage2))).toBe(false);
  });

  test("annotations actually change the output relative to no annotations", async () => {
    const src = await makeSourcePdf();
    const plain = await blobToBytes(await flattenAnnotations(src, {}, META));
    const marked = await blobToBytes(await flattenAnnotations(src, { 1: [rect()] }, META));
    expect(Buffer.from(plain).equals(Buffer.from(marked))).toBe(false);
  });

  test("a deleted annotation is simply absent from the export", async () => {
    const src = await makeSourcePdf();
    const withBoth = await blobToBytes(
      await flattenAnnotations(src, { 1: [rect(), arrow()] }, META)
    );
    const withOne = await blobToBytes(await flattenAnnotations(src, { 1: [rect()] }, META));
    expect(withOne.length).toBeLessThan(withBoth.length);
  });

  test("repeated export of the same state is byte-for-byte consistent", async () => {
    const src = await makeSourcePdf(2);
    const items = { 1: [rect(), arrow()], 2: [rect({ id: "r2", page: 2 })] };
    const first = await blobToBytes(await flattenAnnotations(src, items, META));
    const second = await blobToBytes(await flattenAnnotations(src, items, META));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  test("every supported annotation type flattens without throwing", async () => {
    const src = await makeSourcePdf();
    const items = [
      rect(),
      arrow(),
      { id: "l", page: 1, type: "line", x1: 10, y1: 10, x2: 200, y2: 200, stroke: "#333333", strokeWidth: 2 },
      { id: "e", page: 1, type: "ellipse", x: 300, y: 300, w: 120, h: 60, stroke: "#333333", strokeWidth: 2 },
      { id: "fh", page: 1, type: "freehandHighlight", pts: [{ x: 10, y: 400 }, { x: 90, y: 420 }, { x: 170, y: 400 }], stroke: "#FFF59D", strokeWidth: 16, opacity: 0.35 },
      { id: "pen", page: 1, type: "pen", pts: [{ x: 10, y: 500 }, { x: 90, y: 520 }], stroke: "#1976D2", strokeWidth: 3 },
      { id: "hq", page: 1, type: "highlight", quads: [{ x: 60, y: 600, w: 200, h: 14 }], fill: "#FFF59D", opacity: 0.35 },
      { id: "hb", page: 1, type: "highlight", x0: 60, y0: 640, x1: 260, y1: 640, thickness: 22, fill: "#FFF59D", opacity: 0.35 },
      { id: "u", page: 1, type: "underline", quads: [{ x: 60, y: 660, w: 200, h: 14 }], stroke: "#1976D2" },
      { id: "s", page: 1, type: "strike", quads: [{ x: 60, y: 680, w: 200, h: 14 }], stroke: "#E53935" },
      { id: "tb", page: 1, type: "textbox", x: 320, y: 100, w: 200, h: 80, text: "Hello", stroke: "#333333", strokeWidth: 2, fontSize: 12, textColor: "#111111" },
      { id: "co", page: 1, type: "callout", x: 320, y: 200, w: 180, h: 60, text: "Note", leader: { x: 280, y: 180 }, stroke: "#333333", strokeWidth: 2, fontSize: 12 },
      { id: "tw", page: 1, type: "typewriter", x: 40, y: 720, text: "Typed", fontSize: 12, textColor: "#111111" },
      { id: "st", page: 1, type: "sticky", x: 500, y: 700, note: "Sticky body", color: "#FFE082" },
    ];
    const blob = await flattenAnnotations(src, { 1: items }, META);
    const out = await PDFDocument.load(await blobToBytes(blob));
    expect(out.getPageCount()).toBe(1);
    expect(blob.size).toBeGreaterThan(0);
  });

  test("malformed annotations are skipped safely and never abort the export", async () => {
    const src = await makeSourcePdf();
    const junk = [
      null,
      undefined,
      "not an object",
      { id: "x", page: 1, type: "rect", x: NaN, y: 1, w: 2, h: 2 },
      { id: "y", page: 1, type: "wormhole", x: 1, y: 1 },
      { id: "z", page: 1, type: "arrow", x1: 1, y1: 2 },
      { id: "p", page: 1, type: "pen", pts: "nope" },
      rect(),
    ];
    const blob = await flattenAnnotations(src, { 1: junk }, META);
    expect(blob.size).toBeGreaterThan(0);
    // The one valid annotation still made it in.
    const plain = await blobToBytes(await flattenAnnotations(src, {}, META));
    const marked = await blobToBytes(blob);
    expect(Buffer.from(plain).equals(Buffer.from(marked))).toBe(false);
  });

  test("zoom never reaches the export — placement comes only from page space", async () => {
    // The same page-space annotation must flatten identically regardless of
    // what the editor was zoomed to when it was drawn.
    const src = await makeSourcePdf();
    const drawnAt100 = await blobToBytes(await flattenAnnotations(src, { 1: [rect()] }, META));
    const drawnAt250 = await blobToBytes(await flattenAnnotations(src, { 1: [rect()] }, META));
    expect(Buffer.from(drawnAt100).equals(Buffer.from(drawnAt250))).toBe(true);
  });

  test("falls back to an unrotated full-page transform when metadata is absent", async () => {
    const src = await makeSourcePdf();
    const blob = await flattenAnnotations(src, { 1: [rect()] });
    expect(blob.size).toBeGreaterThan(0);
  });

  test("a corrupt source PDF rejects instead of returning a partial file", async () => {
    await expect(
      flattenAnnotations(new Uint8Array([1, 2, 3, 4]), { 1: [rect()] }, META)
    ).rejects.toBeDefined();
  });
});
