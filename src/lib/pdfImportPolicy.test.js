// src/lib/pdfImportPolicy.test.js
//
// The PDF import decision (Production Readiness Phase 7.0): made from the
// bytes — a `%PDF-` signature within the first 1024 bytes and a 50 MB
// ceiling — never from a name, an extension or a declared type.
import {
  MAX_PDF_SOURCE_BYTES,
  PDF_EMPTY_MESSAGE,
  PDF_HEADER_SEARCH_WINDOW,
  PDF_NOT_PDF_MESSAGE,
  PDF_OVERSIZED_MESSAGE,
  looksLikePdf,
  validatePdfSource,
} from "./pdfImportPolicy";

const SIG = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function pdfBytes(prefixLength = 0, total = 64) {
  const bytes = new Uint8Array(Math.max(total, prefixLength + SIG.length));
  bytes.fill(0x20);
  bytes.set(SIG, prefixLength);
  return bytes;
}

describe("looksLikePdf", () => {
  test("accepts a signature at offset 0", () => {
    expect(looksLikePdf(pdfBytes(0))).toBe(true);
  });

  test("accepts a signature anywhere within the first 1024 bytes (junk prefix)", () => {
    expect(looksLikePdf(pdfBytes(17))).toBe(true);
    expect(looksLikePdf(pdfBytes(PDF_HEADER_SEARCH_WINDOW))).toBe(true);
  });

  test("refuses a signature beyond the search window", () => {
    expect(looksLikePdf(pdfBytes(PDF_HEADER_SEARCH_WINDOW + 1, 2048))).toBe(false);
  });

  test("refuses other file types whatever they are called", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // jsdom 16 has no TextEncoder; spell the bytes out.
    const text = Uint8Array.from("PDF- is not the same as %PDF", (c) => c.charCodeAt(0));
    expect(looksLikePdf(jpeg)).toBe(false);
    expect(looksLikePdf(png)).toBe(false);
    expect(looksLikePdf(text)).toBe(false);
  });

  test("tolerates empty, short and non-byte input", () => {
    expect(looksLikePdf(new Uint8Array([]))).toBe(false);
    expect(looksLikePdf(new Uint8Array([0x25, 0x50]))).toBe(false);
    expect(looksLikePdf(null)).toBe(false);
    expect(looksLikePdf("%PDF-1.7")).toBe(false);
  });

  test("reads an ArrayBuffer and a typed-array view alike", () => {
    const bytes = pdfBytes(3);
    expect(looksLikePdf(bytes.buffer)).toBe(true);
    expect(looksLikePdf(new DataView(bytes.buffer))).toBe(true);
  });
});

describe("validatePdfSource", () => {
  test("a valid PDF passes", () => {
    expect(validatePdfSource(pdfBytes(0))).toEqual({ ok: true });
  });

  test("empty input is refused with the empty message", () => {
    expect(validatePdfSource(new Uint8Array([]))).toEqual({ ok: false, error: PDF_EMPTY_MESSAGE });
    expect(validatePdfSource(null)).toEqual({ ok: false, error: PDF_EMPTY_MESSAGE });
    expect(validatePdfSource(undefined)).toEqual({ ok: false, error: PDF_EMPTY_MESSAGE });
  });

  test("a non-PDF is refused with the not-a-PDF message", () => {
    expect(validatePdfSource(new Uint8Array([1, 2, 3, 4, 5, 6]))).toEqual({ ok: false, error: PDF_NOT_PDF_MESSAGE });
  });

  test("the ceiling is 50 MB, inclusive, checked before the header", () => {
    expect(MAX_PDF_SOURCE_BYTES).toBe(50 * 1024 * 1024);
    // An injectable ceiling keeps the boundary test cheap.
    expect(validatePdfSource(pdfBytes(0, 100), { maxBytes: 100 })).toEqual({ ok: true });
    expect(validatePdfSource(pdfBytes(0, 101), { maxBytes: 100 })).toEqual({ ok: false, error: PDF_OVERSIZED_MESSAGE });
    // Over the limit AND not a PDF reports the size — the cheaper, clearer refusal.
    expect(validatePdfSource(new Uint8Array(101), { maxBytes: 100 })).toEqual({ ok: false, error: PDF_OVERSIZED_MESSAGE });
  });

  test("never throws", () => {
    expect(() => validatePdfSource({})).not.toThrow();
    expect(validatePdfSource({}).ok).toBe(false);
  });
});
