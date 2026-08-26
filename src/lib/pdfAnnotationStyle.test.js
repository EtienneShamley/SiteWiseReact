// Automated checks for the P1 style properties at the persistence boundary
// (src/lib/pdfAnnotationModel.js) and in the flattened export
// (src/lib/pdfUtils.js): No border, No fill, bold/italic, alignment and font
// family must survive edit → save → reopen → export.
jest.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {},
  getDocument: () => ({ promise: Promise.resolve(null) }),
}));

import zlib from "zlib";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import {
  DEFAULT_FONT_FAMILY,
  NO_FILL,
  PDF_FONT_FAMILIES,
  fontFamilyKind,
  hasNoBorder,
  isNoFill,
  normalizeAnnotation,
  serializeAnnotations,
} from "./pdfAnnotationModel";
import { flattenAnnotations, standardFontFor } from "./pdfUtils";

const box = (over = {}) => ({
  id: "t1",
  page: 1,
  type: "textbox",
  x: 50,
  y: 60,
  w: 200,
  h: 80,
  text: "Hello world",
  textColor: "#111111",
  fontSize: 14,
  stroke: "#333333",
  strokeWidth: 2,
  fill: NO_FILL,
  corner: 8,
  ...over,
});

/* ------------------------- 30/31. No border ------------------------------ */

describe("30/31. a genuine No border state", () => {
  test("strokeWidth 0 survives the persistence boundary (it used to be dropped)", () => {
    const stored = serializeAnnotations([box({ strokeWidth: 0 })]);
    expect(stored[0].strokeWidth).toBe(0);
    expect(hasNoBorder(stored[0])).toBe(true);
    // And a round trip is stable.
    expect(serializeAnnotations(stored)).toEqual(stored);
  });

  test("a negative width is still rejected; a missing width keeps the historical border", () => {
    expect(normalizeAnnotation(box({ strokeWidth: -1 })).strokeWidth).toBeUndefined();
    const legacy = normalizeAnnotation(box({ strokeWidth: undefined }));
    expect(hasNoBorder(legacy)).toBe(false);
  });

  test("it is not a nearly-transparent line: the representation is width 0, not a colour", () => {
    const stored = serializeAnnotations([box({ strokeWidth: 0 })])[0];
    expect(stored.stroke).toBe("#333333"); // colour retained for when the border returns
    expect(stored.strokeWidth).toBe(0);
  });
});

/* --------------------------- 27/28/29. Fill ------------------------------ */

describe("27/28/29. fill options", () => {
  test("28. No fill is the canonical transparent token and round-trips", () => {
    const stored = serializeAnnotations([box({ fill: NO_FILL })])[0];
    expect(stored.fill).toBe(NO_FILL);
    expect(isNoFill(stored.fill)).toBe(true);
    expect(isNoFill(undefined)).toBe(true);
  });

  test("29. a solid hex fill round-trips", () => {
    const stored = serializeAnnotations([box({ fill: "#FFF59D" })])[0];
    expect(stored.fill).toBe("#FFF59D");
    expect(isNoFill(stored.fill)).toBe(false);
  });

  test("a URL can never be a fill", () => {
    expect(normalizeAnnotation(box({ fill: "javascript:alert(1)" })).fill).toBeUndefined();
  });
});

/* ------------------------- 16/17/18/20. Text ----------------------------- */

describe("16/17/18/20. text formatting that survives save and reopen", () => {
  test("16. font family: the three families are stored as CSS strings and classified for export", () => {
    for (const f of PDF_FONT_FAMILIES) {
      const stored = serializeAnnotations([box({ fontFamily: f.css })])[0];
      expect(stored.fontFamily).toBe(f.css);
      expect(fontFamilyKind(stored.fontFamily)).toBe(f.id);
    }
    // A historical record's family string still reads as sans.
    expect(fontFamilyKind("system-ui, -apple-system, Segoe UI, Roboto, sans-serif")).toBe("sans");
    expect(fontFamilyKind(undefined)).toBe("sans");
    expect(DEFAULT_FONT_FAMILY).toBe(PDF_FONT_FAMILIES[0].css);
  });

  test("17. font size round-trips; zero or negative is dropped", () => {
    expect(serializeAnnotations([box({ fontSize: 20 })])[0].fontSize).toBe(20);
    expect(normalizeAnnotation(box({ fontSize: 0 })).fontSize).toBeUndefined();
  });

  test("18. bold, italic and alignment round-trip; only true and known alignments are stored", () => {
    const stored = serializeAnnotations([box({ bold: true, italic: true, align: "center" })])[0];
    expect(stored).toMatchObject({ bold: true, italic: true, align: "center" });
    const off = normalizeAnnotation(box({ bold: false, italic: "yes", align: "justify" }));
    expect("bold" in off).toBe(false);
    expect("italic" in off).toBe(false);
    expect("align" in off).toBe(false);
  });

  test("19. text colour round-trips", () => {
    expect(serializeAnnotations([box({ textColor: "#E53935" })])[0].textColor).toBe("#E53935");
  });

  test("20. reopening a saved record yields the same record (no drift on read)", () => {
    const stored = serializeAnnotations([box({ bold: true, align: "right", strokeWidth: 0, fill: "#FFFFFF", fontFamily: PDF_FONT_FAMILIES[2].css })]);
    const reopened = serializeAnnotations(JSON.parse(JSON.stringify(stored)));
    expect(reopened).toEqual(stored);
  });
});

/* ------------------------------ Export ----------------------------------- */

describe("export honours the same properties", () => {
  test("font family × bold/italic maps onto the PDF standard fonts", () => {
    expect(standardFontFor({})).toBe(StandardFonts.Helvetica);
    expect(standardFontFor({ bold: true })).toBe(StandardFonts.HelveticaBold);
    expect(standardFontFor({ italic: true })).toBe(StandardFonts.HelveticaOblique);
    expect(standardFontFor({ bold: true, italic: true })).toBe(StandardFonts.HelveticaBoldOblique);
    expect(standardFontFor({ fontFamily: PDF_FONT_FAMILIES[1].css, bold: true })).toBe(StandardFonts.TimesRomanBold);
    expect(standardFontFor({ fontFamily: PDF_FONT_FAMILIES[2].css, italic: true })).toBe(StandardFonts.CourierOblique);
  });

  async function flattenOne(item) {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const src = await doc.save();
    const blob = await flattenAnnotations(src, { 1: [item] }, { 1: { transform: [1, 0, 0, -1, 0, 800] } });
    const bytes = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const out = await PDFDocument.load(bytes);
    const page = out.getPage(0);
    // pdf-lib writes an uncompressed content stream for pushOperators/drawText.
    const contents = page.node.Contents();
    const streams = contents ? (Array.isArray(contents.array) ? contents.array : [contents]) : [];
    let text = "";
    for (const ref of streams) {
      const s = out.context.lookup(ref);
      let raw = s?.contents ?? s?.getContents?.();
      if (!raw) continue;
      // pdf-lib flate-encodes content streams on save; operators are ASCII.
      if (String(s.dict?.get?.(PDFName.of("Filter")) || "").includes("FlateDecode")) {
        raw = zlib.inflateSync(Buffer.from(raw));
      }
      text += Array.from(raw, (b) => String.fromCharCode(b)).join("");
    }
    return { out, text };
  }

  test("a bordered, unfilled text box strokes a path (rounded corners are Bézier curves, not a plain rectangle)", async () => {
    const { text } = await flattenOne(box());
    expect(text).toMatch(/\bc\n/); // appendBezierCurve operator
    expect(text).toMatch(/\bS\n/); // stroke, not fill
    expect(text).not.toMatch(/\bre\n/); // no plain rectangle for the box
  });

  test("30/31. No border + No fill draws no box at all — only the text", async () => {
    const { text } = await flattenOne(box({ strokeWidth: 0 }));
    expect(text).not.toMatch(/\bc\n/);
    expect(text).not.toMatch(/\bS\n|\bB\n|\bf\n/);
    expect(text).toMatch(/Tj|TJ/); // the text is still there
  });

  test("No border + Solid fill fills the rounded path without stroking it", async () => {
    const { text } = await flattenOne(box({ strokeWidth: 0, fill: "#FFF59D" }));
    expect(text).toMatch(/\bf\n/);
    expect(text).not.toMatch(/\bS\n|\bB\n/);
  });

  test("a bold serif box embeds Times-Bold, a plain one Helvetica", async () => {
    const bold = await flattenOne(box({ fontFamily: PDF_FONT_FAMILIES[1].css, bold: true }));
    const fonts = bold.out.context
      .enumerateIndirectObjects()
      .map(([, obj]) => obj?.toString?.() || "")
      .join("\n");
    expect(fonts).toMatch(/Times-Bold/);
    const plain = await flattenOne(box());
    const plainFonts = plain.out.context.enumerateIndirectObjects().map(([, obj]) => obj?.toString?.() || "").join("\n");
    expect(plainFonts).toMatch(/Helvetica/);
    expect(plainFonts).not.toMatch(/Times/);
  });

  test("right-aligned text starts further right than left-aligned text", async () => {
    const tm = (text) => {
      const m = [...text.matchAll(/([\d.e-]+) ([\d.e-]+) ([\d.e-]+) ([\d.e-]+) ([\d.e-]+) ([\d.e-]+) Tm/g)];
      return m.length ? Number(m[0][5]) : null;
    };
    const left = await flattenOne(box({ text: "Hi" }));
    const right = await flattenOne(box({ text: "Hi", align: "right" }));
    expect(tm(left.text)).not.toBeNull();
    expect(tm(right.text)).toBeGreaterThan(tm(left.text));
  });

  test("a rectangle with No border and No fill exports nothing, one with a border exports a border", async () => {
    const rect = { id: "r", page: 1, type: "rect", x: 10, y: 10, w: 50, h: 50, stroke: "#333333" };
    const none = await flattenOne({ ...rect, strokeWidth: 0 });
    expect(none.text).not.toMatch(/\bS\n|\bB\n|\bf\n/);
    const some = await flattenOne({ ...rect, strokeWidth: 2 });
    expect(some.text).toMatch(/\bS\n|\bB\n/);
  });
});
