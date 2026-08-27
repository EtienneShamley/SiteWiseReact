// The `textReplace` annotation through the shared systems it must behave
// in: the persistence boundary, bounds/translation, the selection
// capability table, the clipboard, z-order — and the REAL pdf-lib export
// (pdf.js stubbed, as in pdfUtils.test.js): the source bytes are proven
// unchanged, the cover and text are burned into the page, rotation is
// honoured, and a malformed record is skipped rather than fatal.
jest.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {},
  getDocument: () => ({ promise: Promise.resolve(null) }),
}));

import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import {
  ANNOTATION_TYPES,
  Z_ORDER,
  annotationBounds,
  isMovable,
  normalizeAnnotation,
  serializeAnnotations,
  sortByZOrder,
  translateAnnotation,
} from "./pdfAnnotationModel";
import { EDITABLE_FIELDS, applyPatchToSelection, selectionSummary } from "./pdfSelection";
import { copyAnnotations, planPaste, clearClipboard, readClipboard } from "./pdfClipboard";
import { flattenAnnotations, standardFontFor } from "./pdfUtils";
import { TOOL, TOOL_LABELS, annotationTypeForTool, overlayOwnsPointer, isCreationTool } from "../pdf/pdfTools";

const replace = (over = {}) => ({
  id: "tr1",
  page: 1,
  type: "textReplace",
  x: 100,
  y: 89.2,
  w: 66,
  h: 13.2,
  text: "Hello there",
  sourceText: "Hello world",
  fontSize: 12,
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  ascent: 0.9,
  descent: -0.2,
  textColor: "#141414",
  fill: "#FFFFFF",
  strokeWidth: 0,
  bold: true,
  ...over,
});

/* ------------------------------ persistence ----------------------------- */

describe("18/26. the persistence boundary", () => {
  test("a replacement round-trips through the whitelist byte-identically", () => {
    const a = replace({ createdAt: 1, updatedAt: 2, rotate: -90, lineHeight: 1.25, align: "center" });
    const out = normalizeAnnotation(a);
    expect(out).toEqual(a);
    expect(serializeAnnotations([a])).toEqual([a]);
  });

  test("an EMPTY replacement is valid (it removes the original text) and keeps its text field", () => {
    expect(normalizeAnnotation(replace({ text: "" })).text).toBe("");
    expect(normalizeAnnotation(replace({ text: undefined })).text).toBe("");
  });

  test("transient editing state, DOM refs and unknown fields never reach storage", () => {
    const out = normalizeAnnotation(replace({ editing: true, el: {}, run: { x: 1 }, font: {} }));
    expect(out).not.toHaveProperty("editing");
    expect(out).not.toHaveProperty("el");
    expect(out).not.toHaveProperty("run");
    expect(out).not.toHaveProperty("font");
  });

  test("29. malformed metrics degrade to defaults; a record without a size or page is dropped, not thrown", () => {
    const out = normalizeAnnotation(replace({ ascent: -1, descent: 0.5, lineHeight: 99, fontSize: "big" }));
    expect(out).not.toHaveProperty("ascent");
    expect(out).not.toHaveProperty("descent");
    expect(out).not.toHaveProperty("lineHeight");
    expect(out).not.toHaveProperty("fontSize");
    expect(normalizeAnnotation(replace({ w: 0 }))).toBeNull();
    expect(normalizeAnnotation(replace({ page: "x" }))).toBeNull();
    expect(normalizeAnnotation({ type: "textReplace" })).toBeNull();
    // A cover colour can never smuggle a URL.
    expect(normalizeAnnotation(replace({ fill: "javascript:alert(1)" }))).not.toHaveProperty("fill");
    expect(normalizeAnnotation(replace({ fill: "blob:http://x/y" }))).not.toHaveProperty("fill");
  });

  test("14. legacy records of every other type still load unchanged next to a replacement", () => {
    const legacy = [
      { id: "h", page: 1, type: "highlight", quads: [{ x: 1, y: 2, w: 3, h: 4 }], fill: "#FFF59D" },
      { id: "t", page: 1, type: "textbox", x: 1, y: 2, w: 30, h: 40, text: "x" },
      { id: "c", page: 1, type: "callout", x: 1, y: 2, w: 30, h: 40, text: "x", leader: { x: 0, y: 0 } },
    ];
    const out = serializeAnnotations([...legacy, replace()]);
    expect(out.slice(0, 3)).toEqual(legacy);
    expect(out[3].type).toBe("textReplace");
  });
});

/* -------------------------------- geometry ------------------------------- */

describe("geometry, order and capabilities", () => {
  test("bounds are the unrotated frame; the record moves as a whole and clamps to the page", () => {
    expect(annotationBounds(replace())).toEqual({ x: 100, y: 89.2, w: 66, h: 13.2 });
    expect(isMovable(replace())).toBe(true);
    const moved = translateAnnotation(replace(), 20, -10, { width: 600, height: 800 });
    expect(moved).toMatchObject({ x: 120, y: 79.2, w: 66, h: 13.2, text: "Hello there" });
    const clamped = translateAnnotation(replace(), 10000, 0, { width: 600, height: 800 });
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(600);
  });

  test("33. paint order: covers sit above shapes and under text boxes, callouts and sticky notes", () => {
    expect(Z_ORDER.textReplace).toBeGreaterThan(Z_ORDER.rect);
    expect(Z_ORDER.textReplace).toBeLessThan(Z_ORDER.textbox);
    expect(Z_ORDER.textReplace).toBeLessThan(Z_ORDER.callout);
    const order = sortByZOrder([
      { id: "s", type: "sticky", page: 1 },
      { id: "r", type: "textReplace", page: 1 },
      { id: "b", type: "rect", page: 1 },
      { id: "t", type: "textbox", page: 1 },
    ]).map((a) => a.id);
    expect(order).toEqual(["b", "r", "t", "s"]);
  });

  test("the ribbon offers text, alignment and the cover colour — never a border, never rotation", () => {
    expect(EDITABLE_FIELDS[ANNOTATION_TYPES.TEXT_REPLACE]).toEqual([
      "textColor",
      "fontSize",
      "fontFamily",
      "bold",
      "italic",
      "align",
      "fill",
    ]);
    const s = selectionSummary([replace()], ["tr1"]);
    expect(s.fields).toEqual(EDITABLE_FIELDS.textReplace);
    expect(s.values.fill).toBe("#FFFFFF");
    expect(s.values.bold).toBe(true);
    // A patch through the ribbon changes only allowed fields.
    const next = applyPatchToSelection([replace()], ["tr1"], { fill: "#EEEEEE", strokeWidth: 3, rotate: 45 });
    expect(next[0].fill).toBe("#EEEEEE");
    expect(next[0].strokeWidth).toBe(0);
    expect(next[0]).not.toHaveProperty("rotate");
  });

  test("the Edit text tool: a creation tool whose product is textReplace, that never owns the pointer", () => {
    expect(TOOL.EDIT_TEXT).toBe("editText");
    expect(isCreationTool(TOOL.EDIT_TEXT)).toBe(true);
    expect(annotationTypeForTool(TOOL.EDIT_TEXT)).toBe(ANNOTATION_TYPES.TEXT_REPLACE);
    expect(annotationTypeForTool(TOOL.TEXTBOX)).toBe("textbox");
    expect(annotationTypeForTool(TOOL.SELECT)).toBeNull();
    expect(overlayOwnsPointer(TOOL.EDIT_TEXT, true)).toBe(false);
    expect(overlayOwnsPointer(TOOL.EDIT_TEXT, false)).toBe(false);
    expect(TOOL_LABELS[TOOL.EDIT_TEXT]).toBe("Edit text");
    expect(TOOL_LABELS.textReplace).toBe("Replaced text");
  });
});

/* -------------------------------- clipboard ------------------------------ */

describe("32. clipboard: a replacement copies and pastes as one record", () => {
  afterEach(() => clearClipboard());

  test("copy keeps cover + text + metrics; paste gives a new id and offsets the whole object", () => {
    const items = [replace()];
    const payload = copyAnnotations(items, ["tr1"]);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ type: "textReplace", sourceText: "Hello world", fill: "#FFFFFF", ascent: 0.9 });
    const plan = planPaste(payload, { targetPage: 1, boundsFor: () => ({ width: 600, height: 800 }) });
    const pasted = plan.items;
    expect(pasted).toHaveLength(1);
    expect(pasted[0].id).not.toBe("tr1");
    expect(pasted[0].x).toBeGreaterThan(100);
    expect(pasted[0].text).toBe("Hello there");
  });
});

/* --------------------------------- export -------------------------------- */

async function makeSourcePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([600, 800]);
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

async function contentOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const streams = contents?.asArray ? contents.asArray() : [contents];
  let out = "";
  for (const ref of streams) {
    const stream = doc.context.lookup(ref);
    // pdf-lib saves content streams Flate-compressed.
    const raw =
      stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream?.getUnencodedContents?.();
    if (raw) out += Buffer.from(raw).toString("latin1") + "\n";
  }
  // pdf-lib writes text as hex strings: <48656C6C6F> Tj → (Hello) Tj.
  out = out.replace(/<([0-9A-Fa-f]+)> Tj/g, (_, hex) => `(${Buffer.from(hex, "hex").toString("latin1")}) Tj`);
  return { doc, page, text: out };
}

describe("27. PDF export fidelity (real pdf-lib)", () => {
  test("18. the canonical source bytes are untouched; the output is a valid, larger PDF", async () => {
    const src = await makeSourcePdf();
    const before = Array.from(src);
    const blob = await flattenAnnotations(src, { 1: [replace()] }, META);
    const out = await blobToBytes(blob);
    expect(Array.from(src)).toEqual(before);
    expect(String.fromCharCode(...out.slice(0, 5))).toBe("%PDF-");
    expect(out.length).toBeGreaterThan(src.length);
  });

  test("19/20/21. the cover is a filled rectangle at the frame and the text sits on the source baseline in the bold sans font", async () => {
    const src = await makeSourcePdf();
    const out = await blobToBytes(await flattenAnnotations(src, { 1: [replace()] }, META));
    const { doc, text } = await contentOf(out);
    // Cover: white fill, then a path from the frame's top-left in user space
    // (page space y 89.2 → user space 800 − 89.2 = 710.8) that is filled.
    expect(text).toMatch(/1 1 1 rg/);
    expect(text).toMatch(/100(\.0+)? 710\.8\d* m/);
    expect(text).toMatch(/\bf\b/);
    // Text: baseline at y = 89.2 + 0.9·12 = 100 → user 700, at x = 100.
    expect(text).toMatch(/1 0 0 1 100(\.0+)? 700(\.0+)? Tm|100(\.0+)? 700(\.0+)? Td/);
    expect(text).toMatch(/12 Tf/);
    expect(text).toMatch(/\(Hello there\) Tj/);
    // Font: the closest standard font, Helvetica-Bold, selected for the run.
    expect(standardFontFor(replace())).toBe("Helvetica-Bold");
    expect(text).toMatch(/\/Helvetica-Bold[^ ]* 12 Tf/);
    const fontDicts = doc.context
      .enumerateIndirectObjects()
      .filter(([, obj]) => String(obj?.toString?.() || "").includes("/BaseFont /Helvetica-Bold"));
    expect(fontDicts.length).toBe(1);
  });

  test("the text colour and a non-white cover are honoured; a transparent cover draws no rectangle", async () => {
    const src = await makeSourcePdf();
    const out = await blobToBytes(
      await flattenAnnotations(src, { 1: [replace({ fill: "#E6F0FF", textColor: "#C80000" })] }, META)
    );
    const { text } = await contentOf(out);
    expect(text).toMatch(/0\.9\d* 0\.94\d* 1 rg/);
    expect(text).toMatch(/0\.78\d* 0 0 rg/);
    const none = await blobToBytes(await flattenAnnotations(src, { 1: [replace({ fill: "transparent" })] }, META));
    const c2 = await contentOf(none);
    expect(c2.text).not.toMatch(/1 1 1 rg/);
    expect(c2.text).toMatch(/\(Hello there\) Tj/);
  });

  test("an empty replacement exports only its cover (the original text is hidden, nothing drawn over it)", async () => {
    const src = await makeSourcePdf();
    const out = await blobToBytes(await flattenAnnotations(src, { 1: [replace({ text: "" })] }, META));
    const { text } = await contentOf(out);
    expect(text).toMatch(/1 1 1 rg/);
    expect(text).not.toMatch(/Tj/);
  });

  test("multi-line replacements keep their measured pitch and never wrap inside the cover", async () => {
    const src = await makeSourcePdf();
    const long = "a much longer line than the original width can hold without wrapping";
    const out = await blobToBytes(
      await flattenAnnotations(src, { 1: [replace({ text: `${long}\nsecond`, lineHeight: 1.5, w: 30 })] }, META)
    );
    const { text } = await contentOf(out);
    expect(text).toMatch(new RegExp(`\\(${long.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) Tj`));
    expect(text).toMatch(/\(second\) Tj/);
    // Second baseline 1.5 × 12 = 18 lower: user space 700 − 18 = 682.
    expect(text).toMatch(/682(\.0+)? Tm|682(\.0+)? Td/);
  });

  test("28. a rotated replacement rotates its cover about the frame centre and its text with it", async () => {
    const src = await makeSourcePdf();
    const out = await blobToBytes(await flattenAnnotations(src, { 1: [replace({ rotate: -90 })] }, META));
    const { text } = await contentOf(out);
    // The text matrix carries a 90° rotation (cos ≈ 0, sin 1).
    const tm = text.match(/([-\d.e+]+) ([-\d.e+]+) ([-\d.e+]+) ([-\d.e+]+) ([-\d.e+]+) ([-\d.e+]+) Tm/);
    expect(tm).not.toBeNull();
    expect(Number(tm[1])).toBeCloseTo(0, 6);
    expect(Number(tm[2])).toBeCloseTo(1, 6);
    expect(Number(tm[3])).toBeCloseTo(-1, 6);
    expect(Number(tm[4])).toBeCloseTo(0, 6);
    expect(text).toMatch(/\(Hello there\) Tj/);
  });

  test("characters outside the standard font's encoding are substituted, never fatal", async () => {
    const src = await makeSourcePdf();
    const out = await blobToBytes(await flattenAnnotations(src, { 1: [replace({ text: "Temp 25 ℃ ✓" })] }, META));
    const { text } = await contentOf(out);
    expect(text).toMatch(/\(Temp 25 \? \?\) Tj/);
  });

  test("29. a malformed replacement is skipped and the rest of the page still exports", async () => {
    const src = await makeSourcePdf();
    const out = await blobToBytes(
      await flattenAnnotations(src, { 1: [replace({ w: -5 }), replace({ id: "ok", text: "fine" })] }, META)
    );
    const { text } = await contentOf(out);
    expect(text).toMatch(/\(fine\) Tj/);
    expect(text).not.toMatch(/Hello there/);
  });
});
