// Automated checks for the PDF storage record shape and per-note keying
// (src/lib/pdfStorage.js). The IndexedDB I/O itself is exercised manually in
// the browser (jsdom has no IndexedDB); these tests pin down the pure parts:
// keying, copying, and serialization safety.
import { makePdfRecord, makeAnnotationRecord } from "./pdfStorage";

describe("makePdfRecord", () => {
  test("keys the record by note id", () => {
    const rec = makePdfRecord("note-123", new Uint8Array([1, 2, 3]), "site.pdf");
    expect(rec.noteId).toBe("note-123");
    expect(rec.name).toBe("site.pdf");
    expect(new Uint8Array(rec.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(typeof rec.updatedAt).toBe("number");
  });

  test("two notes produce records under distinct keys", () => {
    const a = makePdfRecord("note-a", new Uint8Array([1]), null);
    const b = makePdfRecord("note-b", new Uint8Array([2]), null);
    expect(a.noteId).not.toBe(b.noteId);
  });

  test("stores a copy, not the caller's buffer", () => {
    const src = new Uint8Array([9, 9, 9]);
    const rec = makePdfRecord("n", src, null);
    src[0] = 0;
    expect(new Uint8Array(rec.bytes)[0]).toBe(9);
  });

  test("rejects missing note id and empty bytes", () => {
    expect(() => makePdfRecord(null, new Uint8Array([1]))).toThrow();
    expect(() => makePdfRecord("n", new Uint8Array([]))).toThrow();
    expect(() => makePdfRecord("n", null)).toThrow();
  });
});

describe("makeAnnotationRecord", () => {
  test("keys annotations by note id and deep-copies items", () => {
    const items = [{ id: "a_1", page: 1, type: "highlight", quads: [{ x: 1, y: 2, w: 3, h: 4 }] }];
    const rec = makeAnnotationRecord("note-xyz", items);
    expect(rec.noteId).toBe("note-xyz");
    expect(rec.items).toEqual(items);
    expect(rec.items).not.toBe(items);
    expect(rec.items[0].quads).not.toBe(items[0].quads);
  });

  test("normalizes non-arrays to an empty list", () => {
    expect(makeAnnotationRecord("n", null).items).toEqual([]);
    expect(makeAnnotationRecord("n", undefined).items).toEqual([]);
  });

  test("rejects a missing note id", () => {
    expect(() => makeAnnotationRecord(null, [])).toThrow();
  });
});
