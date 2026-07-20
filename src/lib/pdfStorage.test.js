// Automated checks for the PDF storage record shape and per-document keying
// (src/lib/pdfStorage.js). The IndexedDB I/O itself is exercised manually in
// the browser (jsdom has no IndexedDB); these tests pin down the pure parts:
// keying, copying, and serialization safety.
//
// Canonical model: records are keyed by a stable PDF `documentId`, not a note
// id — PDFs are independent documents (see docs/features/PDF_EDITOR.md).
import { makePdfRecord, makeAnnotationRecord } from "./pdfStorage";

describe("makePdfRecord", () => {
  test("keys the record by document id", () => {
    const rec = makePdfRecord("pdf-123", new Uint8Array([1, 2, 3]), "site.pdf");
    expect(rec.documentId).toBe("pdf-123");
    expect(rec.name).toBe("site.pdf");
    expect(new Uint8Array(rec.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(typeof rec.updatedAt).toBe("number");
  });

  test("two documents produce records under distinct keys", () => {
    const a = makePdfRecord("pdf-a", new Uint8Array([1]), null);
    const b = makePdfRecord("pdf-b", new Uint8Array([2]), null);
    expect(a.documentId).not.toBe(b.documentId);
  });

  test("stores a copy, not the caller's buffer", () => {
    const src = new Uint8Array([9, 9, 9]);
    const rec = makePdfRecord("d", src, null);
    src[0] = 0;
    expect(new Uint8Array(rec.bytes)[0]).toBe(9);
  });

  test("rejects missing document id and empty bytes", () => {
    expect(() => makePdfRecord(null, new Uint8Array([1]))).toThrow();
    expect(() => makePdfRecord("d", new Uint8Array([]))).toThrow();
    expect(() => makePdfRecord("d", null)).toThrow();
  });
});

describe("makeAnnotationRecord", () => {
  test("keys annotations by document id and deep-copies items", () => {
    const items = [{ id: "a_1", page: 1, type: "highlight", quads: [{ x: 1, y: 2, w: 3, h: 4 }] }];
    const rec = makeAnnotationRecord("pdf-xyz", items);
    expect(rec.documentId).toBe("pdf-xyz");
    expect(rec.items).toEqual(items);
    expect(rec.items).not.toBe(items);
    expect(rec.items[0].quads).not.toBe(items[0].quads);
  });

  test("normalizes non-arrays to an empty list", () => {
    expect(makeAnnotationRecord("d", null).items).toEqual([]);
    expect(makeAnnotationRecord("d", undefined).items).toEqual([]);
  });

  test("rejects a missing document id", () => {
    expect(() => makeAnnotationRecord(null, [])).toThrow();
  });
});
