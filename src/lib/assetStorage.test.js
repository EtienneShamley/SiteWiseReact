// Pure-logic tests for the asset storage module (src/lib/assetStorage.js).
// The IndexedDB I/O itself is exercised manually in the browser (jsdom has no
// IndexedDB, and this project does not add a fake-indexeddb dependency). These
// tests pin down the pure parts: record shape + stable ids, logo validation
// (MIME + size + empty), and base64 data-URL -> Blob conversion.
import {
  makeAssetRecord,
  validateLogoFile,
  validatePhotoFile,
  validateNoteFile,
  fileExtension,
  dataUrlToBlob,
  isMigratableLogoSrc,
  ALLOWED_LOGO_MIME_TYPES,
  MAX_LOGO_BYTES,
  ALLOWED_PHOTO_MIME_TYPES,
  MAX_PHOTO_BYTES,
  ALLOWED_NOTE_FILE_MIME_TYPES,
  MAX_NOTE_FILE_BYTES,
} from "./assetStorage";

function blobOf(bytes, type) {
  return new Blob([new Uint8Array(bytes)], { type });
}

describe("makeAssetRecord", () => {
  test("builds a record from the supplied id and blob", () => {
    const blob = blobOf([1, 2, 3], "image/png");
    const rec = makeAssetRecord({ id: "a1", kind: "logo", name: "l.png", blob });
    expect(rec.id).toBe("a1");
    expect(rec.kind).toBe("logo");
    expect(rec.name).toBe("l.png");
    expect(rec.mimeType).toBe("image/png");
    expect(rec.size).toBe(3);
    expect(rec.blob).toBe(blob); // stores the original Blob, not base64
    expect(typeof rec.createdAt).toBe("number");
    expect(typeof rec.updatedAt).toBe("number");
    expect(rec.metadata).toEqual({});
  });

  test("uses the caller-supplied id verbatim (stable ids)", () => {
    const blob = blobOf([1], "image/png");
    expect(makeAssetRecord({ id: "fixed-id", blob }).id).toBe("fixed-id");
    expect(makeAssetRecord({ id: "tpl-logo-v1", blob }).id).toBe("tpl-logo-v1");
  });

  test("rejects a missing id or empty/absent blob", () => {
    expect(() => makeAssetRecord({ id: "", blob: blobOf([1], "image/png") })).toThrow();
    expect(() => makeAssetRecord({ id: "a", blob: blobOf([], "image/png") })).toThrow();
    expect(() => makeAssetRecord({ id: "a", blob: null })).toThrow();
  });
});

describe("validateLogoFile", () => {
  test("accepts PNG, JPEG and WebP within the size limit", () => {
    for (const type of ALLOWED_LOGO_MIME_TYPES) {
      expect(validateLogoFile(blobOf([1, 2, 3], type)).ok).toBe(true);
    }
  });

  test("rejects unsupported types, including SVG", () => {
    expect(validateLogoFile(blobOf([1], "image/svg+xml")).ok).toBe(false);
    expect(validateLogoFile(blobOf([1], "image/gif")).ok).toBe(false);
    expect(validateLogoFile(blobOf([1], "application/pdf")).ok).toBe(false);
  });

  test("rejects an empty file", () => {
    expect(validateLogoFile(blobOf([], "image/png")).ok).toBe(false);
  });

  test("rejects a file over the 5 MB maximum", () => {
    const tooBig = { size: MAX_LOGO_BYTES + 1, type: "image/png" };
    expect(validateLogoFile(tooBig).ok).toBe(false);
    const atLimit = { size: MAX_LOGO_BYTES, type: "image/png" };
    expect(validateLogoFile(atLimit).ok).toBe(true);
  });

  test("returns an error string and never throws on bad input", () => {
    const res = validateLogoFile(null);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
  });
});

describe("dataUrlToBlob / isMigratableLogoSrc", () => {
  const pngDataUrl = "data:image/png;base64," + btoa("hello");

  test("converts a base64 data:image URL to a non-empty Blob of the right type", () => {
    const blob = dataUrlToBlob(pngDataUrl);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(5); // "hello"
  });

  test("returns null for non-data-URL, empty, or malformed values", () => {
    expect(dataUrlToBlob("")).toBeNull();
    expect(dataUrlToBlob("https://example.com/logo.png")).toBeNull();
    expect(dataUrlToBlob("data:image/png;base64,")).toBeNull();
    expect(dataUrlToBlob(null)).toBeNull();
  });

  test("isMigratableLogoSrc is true only for a valid data:image URL", () => {
    expect(isMigratableLogoSrc(pngDataUrl)).toBe(true);
    expect(isMigratableLogoSrc("data:text/plain;base64," + btoa("x"))).toBe(false);
    expect(isMigratableLogoSrc("blob:xyz")).toBe(false);
    expect(isMigratableLogoSrc(null)).toBe(false);
  });
});

describe("validatePhotoFile (note Photo fields)", () => {
  test("accepts PNG, JPEG and WebP within the 15 MB limit", () => {
    for (const type of ALLOWED_PHOTO_MIME_TYPES) {
      expect(validatePhotoFile(blobOf([1, 2, 3], type)).ok).toBe(true);
    }
  });

  test("rejects unsupported photo MIME types with a clear message", () => {
    for (const type of ["image/gif", "image/svg+xml", "application/pdf", ""]) {
      const res = validatePhotoFile(blobOf([1], type));
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe("string");
    }
  });

  test("rejects an oversized photo (over 15 MB)", () => {
    const big = { size: MAX_PHOTO_BYTES + 1, type: "image/png", name: "big.png" };
    const res = validatePhotoFile(big);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/15 MB/);
  });

  test("rejects empty and missing files", () => {
    expect(validatePhotoFile(blobOf([], "image/png")).ok).toBe(false);
    expect(validatePhotoFile(null).ok).toBe(false);
  });
});

describe("fileExtension", () => {
  test("extracts a lowercase extension", () => {
    expect(fileExtension("Report.PDF")).toBe(".pdf");
    expect(fileExtension("a.b.docx")).toBe(".docx");
  });
  test("returns empty for no/edge-case extensions", () => {
    expect(fileExtension("noext")).toBe("");
    expect(fileExtension(".hidden")).toBe("");
    expect(fileExtension("trailing.")).toBe("");
    expect(fileExtension(null)).toBe("");
  });
});

describe("validateNoteFile (note File fields)", () => {
  const fileOf = (bytes, type, name) => {
    const b = blobOf(bytes, type);
    b.name = name;
    return b;
  };

  test("accepts every allowlisted MIME type within the 20 MB limit", () => {
    for (const type of ALLOWED_NOTE_FILE_MIME_TYPES) {
      expect(validateNoteFile(fileOf([1, 2], type, "f")).ok).toBe(true);
    }
  });

  test("accepts by extension when the MIME type is missing or nonstandard", () => {
    // Office/CSV MIME types vary by platform; the extension is a valid signal.
    expect(validateNoteFile(fileOf([1], "", "report.docx")).ok).toBe(true);
    expect(validateNoteFile(fileOf([1], "application/octet-stream", "data.CSV")).ok).toBe(true);
    expect(validateNoteFile(fileOf([1], "", "sheet.xlsx")).ok).toBe(true);
  });

  test("rejects when neither MIME nor extension is allowlisted", () => {
    for (const [type, name] of [
      ["application/zip", "archive.zip"],
      ["video/mp4", "clip.mp4"],
      ["", "script.exe"],
      ["image/svg+xml", "vector.svg"],
    ]) {
      const res = validateNoteFile(fileOf([1], type, name));
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe("string");
    }
  });

  test("rejects an oversized file (over 20 MB)", () => {
    const big = { size: MAX_NOTE_FILE_BYTES + 1, type: "application/pdf", name: "big.pdf" };
    const res = validateNoteFile(big);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/20 MB/);
  });

  test("rejects empty and missing files", () => {
    expect(validateNoteFile(fileOf([], "application/pdf", "e.pdf")).ok).toBe(false);
    expect(validateNoteFile(null).ok).toBe(false);
  });
});
