// src/lib/pdfDocuments.test.js
//
// The PDF registry record and its SOURCE identity (Production Readiness
// Phase 7.0): a document's bytes are keyed by `sourceAssetId`, a fresh
// document gets its own, a replaced file gets a new one under the same
// document id, and a record written before the field existed resolves to
// its own id.
import { makePdfDoc, pdfSourceId, withReplacedPdfSource } from "./pdfDocuments";

describe("makePdfDoc", () => {
  test("mints a document id and a distinct source id", () => {
    const doc = makePdfDoc({ name: "Plan.pdf", now: 1000 });
    expect(typeof doc.id).toBe("string");
    expect(typeof doc.sourceAssetId).toBe("string");
    expect(doc.id).not.toBe(doc.sourceAssetId);
    expect(doc).toEqual({
      id: doc.id,
      sourceAssetId: doc.sourceAssetId,
      projectId: null,
      folderId: null,
      name: "Plan.pdf",
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  test("defaults the name and normalizes absent provenance", () => {
    const doc = makePdfDoc({});
    expect(doc.name).toBe("Untitled PDF");
    expect(doc.projectId).toBeNull();
    expect(doc.folderId).toBeNull();
  });
});

describe("pdfSourceId", () => {
  test("a record with a source id resolves to it", () => {
    expect(pdfSourceId({ id: "doc-1", sourceAssetId: "src-9" })).toBe("src-9");
  });

  test("a pre-Phase-7 record without the field resolves to its own id", () => {
    expect(pdfSourceId({ id: "doc-1", name: "x" })).toBe("doc-1");
    expect(pdfSourceId({ id: "doc-1", sourceAssetId: "" })).toBe("doc-1");
    expect(pdfSourceId({ id: "doc-1", sourceAssetId: 42 })).toBe("doc-1");
  });

  test("tolerates garbage", () => {
    expect(pdfSourceId(null)).toBeNull();
    expect(pdfSourceId("doc-1")).toBeNull();
    expect(pdfSourceId({})).toBeNull();
  });
});

describe("withReplacedPdfSource", () => {
  const original = Object.freeze({
    id: "doc-1",
    sourceAssetId: "src-old",
    projectId: "p1",
    folderId: "f1",
    name: "Old.pdf",
    createdAt: 10,
    updatedAt: 20,
  });

  test("keeps the document identity and provenance, replaces the source, stamps updatedAt", () => {
    const next = withReplacedPdfSource(original, { sourceAssetId: "src-new", name: "New.pdf", now: 99 });
    expect(next).toEqual({
      id: "doc-1",
      sourceAssetId: "src-new",
      projectId: "p1",
      folderId: "f1",
      name: "New.pdf",
      createdAt: 10,
      updatedAt: 99,
    });
    expect(next).not.toBe(original);
    expect(original.sourceAssetId).toBe("src-old");
    expect(original.name).toBe("Old.pdf");
  });

  test("keeps the previous name when none (or a blank one) is supplied", () => {
    expect(withReplacedPdfSource(original, { sourceAssetId: "s", now: 1 }).name).toBe("Old.pdf");
    expect(withReplacedPdfSource(original, { sourceAssetId: "s", name: "   ", now: 1 }).name).toBe("Old.pdf");
    expect(withReplacedPdfSource({ id: "d", createdAt: 1, updatedAt: 1 }, { sourceAssetId: "s", now: 1 }).name).toBe("Untitled PDF");
  });

  test("a legacy record (no source id) gains one without losing anything else", () => {
    const legacy = { id: "doc-2", name: "Legacy.pdf", createdAt: 5, updatedAt: 5, projectId: null, folderId: null };
    const next = withReplacedPdfSource(legacy, { sourceAssetId: "src-1", now: 6 });
    expect(next).toEqual({ ...legacy, sourceAssetId: "src-1", updatedAt: 6 });
  });

  test("refuses a missing record or source id", () => {
    expect(() => withReplacedPdfSource(null, { sourceAssetId: "s" })).toThrow();
    expect(() => withReplacedPdfSource(original, {})).toThrow();
    expect(() => withReplacedPdfSource(original, { sourceAssetId: "" })).toThrow();
  });
});
