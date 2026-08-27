// 12/13. Callout save/reopen and export fidelity.
//
// Save/reopen is the persistence whitelist (normalize → serialize → normalize
// must be the identity for a callout). Export runs pdf-lib for real against a
// generated source PDF, with pdf.js stubbed (ESM-only), and asserts the
// flattened output depends on exactly the geometry the editor draws — the
// tip, the box and the leader's attachment — through
// src/lib/pdfCallout.js, the one definition both renderers use.
jest.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {},
  getDocument: () => ({ promise: Promise.resolve(null) }),
}));

import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { flattenAnnotations } from "./pdfUtils";
import { normalizeAnnotationList, serializeAnnotations } from "./pdfAnnotationModel";
import { copyAnnotations, planPaste } from "./pdfClipboard";
import { calloutLeaderGeometry } from "./pdfCallout";

async function makeSourcePdf(pageCount = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([600, 800]);
  return doc.save();
}

function blobToBytes(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const META = { 1: { transform: [1, 0, 0, -1, 0, 800] } };

const callout = (over = {}) => ({
  id: "c1",
  page: 1,
  type: "callout",
  x: 200,
  y: 160,
  w: 180,
  h: 80,
  leader: { x: 100, y: 120 },
  text: "Check this joint",
  textColor: "#111111",
  fontSize: 14,
  fontFamily: "Georgia, 'Times New Roman', Times, serif",
  bold: true,
  align: "center",
  stroke: "#1976D2",
  strokeWidth: 3,
  fill: "#FFF59D",
  corner: 8,
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

// The flattened page's content streams, inflated and decoded to their
// operators, so geometry can be asserted. (jsdom has no TextDecoder here;
// content streams are ASCII.)
async function contentOf(src, items) {
  const blob = await flattenAnnotations(src, { 1: items }, META);
  const bytes = await blobToBytes(blob);
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const streams = contents?.asArray ? contents.asArray() : [contents];
  let text = "";
  for (const ref of streams) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const raw = decodePDFRawStream(stream).decode();
    text += String.fromCharCode.apply(null, Array.from(raw)) + "\n";
  }
  return { text, bytes, ops: pathOps(text) };
}

/** Every `x y m` / `x y l` operator in a content stream, as numbers. */
function pathOps(text) {
  const out = [];
  const re = /(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (m|l)\b/g;
  let m;
  while ((m = re.exec(text))) out.push({ x: Number(m[1]), y: Number(m[2]), op: m[3] });
  return out;
}

const hasOp = (ops, op, x, y, eps = 0.05) =>
  ops.some((o) => o.op === op && Math.abs(o.x - x) < eps && Math.abs(o.y - y) < eps);

describe("12. save / reopen preserves the callout", () => {
  test("normalize → serialize → normalize is the identity, leader and formatting included", () => {
    const stored = serializeAnnotations([callout()]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(callout());
    expect(normalizeAnnotationList(stored)).toEqual(stored);
  });

  test("No border and No fill survive; a pasted callout survives the same way with its own id", () => {
    const src = callout({ strokeWidth: 0, fill: "transparent" });
    expect(serializeAnnotations([src])[0]).toMatchObject({ strokeWidth: 0, fill: "transparent" });
    const plan = planPaste(copyAnnotations([src], ["c1"]), { targetPage: 1, boundsFor: () => ({ width: 600, height: 800 }) });
    const stored = serializeAnnotations(plan.items);
    expect(stored[0].id).not.toBe("c1");
    expect(stored[0]).toMatchObject({ strokeWidth: 0, fill: "transparent", leader: { x: 112, y: 132 }, text: "Check this joint" });
  });

  test("46. a historical callout (no leader) is readable and unchanged by reading", () => {
    const old = callout({ leader: undefined });
    const [read] = normalizeAnnotationList([old]);
    expect(read).toEqual(old);
    expect(read.leader).toBeUndefined();
  });
});

describe("13. export preserves the callout's geometry", () => {
  let src;
  beforeAll(async () => {
    src = await makeSourcePdf();
  });

  test("a callout flattens to a valid PDF whose drawing follows the leader tip and box", async () => {
    const a = await contentOf(src, [callout()]);
    const b = await contentOf(src, [callout({ leader: { x: 500, y: 700 } })]);
    const c = await contentOf(src, [callout({ x: 260, y: 300 })]);
    expect(a.bytes.length).toBeGreaterThan(0);
    expect(a.text).not.toBe(b.text);
    expect(a.text).not.toBe(c.text);
  });

  test("the leader is drawn from the SAME attachment point the editor derives, in PDF user space", async () => {
    const item = callout({ leader: { x: 290, y: 20 } }); // above → attaches at top-mid (290,160)
    const geometry = calloutLeaderGeometry(item);
    expect(geometry.anchor).toEqual({ x: 290, y: 160 });
    const { text, ops } = await contentOf(src, [item]);
    // pdf-lib writes `x y m` / `x y l` operators; the y-down page space
    // maps to y-up user space through the page transform (800 − y).
    expect(hasOp(ops, "m", 290, 640)).toBe(true); // anchor (290, 800−160)
    expect(hasOp(ops, "l", 290, 780)).toBe(true); // tip (290, 800−20)
    // The two arrowhead barbs end where the shared helper says they do.
    for (const barb of geometry.barbs) expect(hasOp(ops, "l", barb.x, 800 - barb.y)).toBe(true);
    // Leader thickness follows the border width.
    expect(text).toMatch(/\b3 w\b/);
  });

  test("No border still exports a visible hairline leader, and the box without a stroke", async () => {
    const { text, ops } = await contentOf(src, [callout({ strokeWidth: 0, leader: { x: 290, y: 20 } })]);
    expect(text).toMatch(/\b1\.5 w\b/);
    expect(hasOp(ops, "m", 290, 640)).toBe(true);
  });

  test("a historical callout without a stored leader now exports the leader the editor shows", async () => {
    const withDefault = await contentOf(src, [callout({ leader: undefined })]);
    const explicit = await contentOf(src, [callout({ leader: { x: 180, y: 140 } })]);
    expect(withDefault.text).toBe(explicit.text);
  });

  test("a rotated callout keeps its tip fixed on the page and attaches to the rotated box", async () => {
    const item = callout({ rotate: 90, leader: { x: 290, y: 20 } });
    const geometry = calloutLeaderGeometry(item);
    const { ops } = await contentOf(src, [item]);
    expect(hasOp(ops, "l", 290, 780)).toBe(true); // the tip did not rotate
    // The attachment point is the rotated LEFT-edge midpoint (290, 110) → (290, 690).
    expect(geometry.anchor.x).toBeCloseTo(290, 6);
    expect(geometry.anchor.y).toBeCloseTo(110, 6);
    expect(hasOp(ops, "m", 290, 690)).toBe(true);
  });

  test("a pasted callout exports at its offset position, its original where it was", async () => {
    const original = callout();
    const plan = planPaste(copyAnnotations([original], ["c1"]), { targetPage: 1, boundsFor: () => ({ width: 600, height: 800 }) });
    const one = await contentOf(src, [original]);
    const both = await contentOf(src, [original, ...plan.items]);
    expect(both.text.length).toBeGreaterThan(one.text.length);
    expect(hasOp(both.ops, "m", 200, 640)).toBe(true); // original anchor (200, 800−160)
    expect(hasOp(both.ops, "m", 212, 628)).toBe(true); // pasted anchor (212, 800−172)
    expect(hasOp(one.ops, "m", 212, 628)).toBe(false);
  });

  test("repeated export of the same callout is byte-for-byte consistent", async () => {
    const a = await contentOf(src, [callout()]);
    const b = await contentOf(src, [callout()]);
    expect(a.text).toBe(b.text);
  });
});
