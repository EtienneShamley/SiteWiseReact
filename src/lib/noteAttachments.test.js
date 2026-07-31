// Unit tests for the pure note-attachment model (src/lib/noteAttachments.js):
// lightweight reference shape (no Blob/base64), stable ids, display-metadata
// normalization (widthPct clamping, alignment), preserved ordering, and mixed
// legacy/structured array compatibility.
import {
  ATTACHMENT_KIND,
  PHOTO_WIDTH_PRESETS,
  DEFAULT_PHOTO_WIDTH_PCT,
  MIN_PHOTO_WIDTH_PCT,
  DEFAULT_PHOTO_ALIGNMENT,
  LEGACY_ATTACHMENT_SOURCE,
  clampWidthPct,
  normalizeAlignment,
  normalizeDisplay,
  makeAttachment,
  isLegacyAttachmentEntry,
  isAttachmentRef,
  isLegacyMigratedAttachment,
  normalizeAttachment,
  normalizeAttachments,
  attachmentsForField,
  formatFileSize,
  fileKindLabel,
} from "./noteAttachments";

describe("size presets and width clamping", () => {
  test("presets are Small 35 / Normal 60 / Large 85 / Full 100, default Normal", () => {
    expect(PHOTO_WIDTH_PRESETS.map((p) => p.pct)).toEqual([35, 60, 85, 100]);
    expect(DEFAULT_PHOTO_WIDTH_PCT).toBe(60);
  });

  test("clampWidthPct constrains to [MIN, 100] and defaults invalid input", () => {
    expect(clampWidthPct(60)).toBe(60);
    expect(clampWidthPct(100)).toBe(100);
    expect(clampWidthPct(250)).toBe(100);
    expect(clampWidthPct(1)).toBe(MIN_PHOTO_WIDTH_PCT);
    expect(clampWidthPct(-5)).toBe(MIN_PHOTO_WIDTH_PCT);
    expect(clampWidthPct(undefined)).toBe(DEFAULT_PHOTO_WIDTH_PCT);
    expect(clampWidthPct("nope")).toBe(DEFAULT_PHOTO_WIDTH_PCT);
  });

  test("normalizeAlignment allows left/center/right only", () => {
    expect(normalizeAlignment("left")).toBe("left");
    expect(normalizeAlignment("center")).toBe("center");
    expect(normalizeAlignment("right")).toBe("right");
    expect(normalizeAlignment("justify")).toBe(DEFAULT_PHOTO_ALIGNMENT);
    expect(normalizeAlignment(undefined)).toBe(DEFAULT_PHOTO_ALIGNMENT);
  });

  test("normalizeDisplay fills defaults and clamps", () => {
    expect(normalizeDisplay(undefined)).toEqual({
      widthPct: DEFAULT_PHOTO_WIDTH_PCT,
      alignment: DEFAULT_PHOTO_ALIGNMENT,
    });
    expect(normalizeDisplay({ widthPct: 400, alignment: "right" })).toEqual({
      widthPct: 100,
      alignment: "right",
    });
  });
});

describe("makeAttachment", () => {
  const base = {
    id: "att-1",
    assetId: "asset-1",
    name: "site.png",
    mimeType: "image/png",
    size: 1234,
    createdAt: 111,
  };

  test("builds a lightweight photo reference with display defaults", () => {
    const att = makeAttachment({
      ...base,
      kind: ATTACHMENT_KIND.PHOTO,
      intrinsicWidth: 800,
      intrinsicHeight: 600,
    });
    expect(att).toEqual({
      id: "att-1",
      assetId: "asset-1",
      kind: "photo",
      name: "site.png",
      mimeType: "image/png",
      size: 1234,
      createdAt: 111,
      intrinsicWidth: 800,
      intrinsicHeight: 600,
      display: { widthPct: 60, alignment: "left" },
    });
    // Lightweight: no binary content of any form.
    expect(JSON.stringify(att)).not.toMatch(/data:|blob:/);
  });

  test("file attachments carry no photo display metadata", () => {
    const att = makeAttachment({ ...base, kind: ATTACHMENT_KIND.FILE });
    expect(att.kind).toBe("file");
    expect(att.display).toBeUndefined();
    expect(att.intrinsicWidth).toBeUndefined();
  });

  test("uses caller-supplied ids verbatim (stable / deterministic ids)", () => {
    const att = makeAttachment({ ...base, kind: ATTACHMENT_KIND.PHOTO });
    expect(att.id).toBe("att-1");
    expect(att.assetId).toBe("asset-1");
  });

  test("unknown intrinsic dimensions become null, never NaN", () => {
    const att = makeAttachment({ ...base, kind: ATTACHMENT_KIND.PHOTO });
    expect(att.intrinsicWidth).toBeNull();
    expect(att.intrinsicHeight).toBeNull();
  });

  test("rejects structurally invalid references", () => {
    expect(() => makeAttachment({ ...base, id: "", kind: "photo" })).toThrow();
    expect(() => makeAttachment({ ...base, assetId: "", kind: "photo" })).toThrow();
    expect(() => makeAttachment({ ...base, kind: "signature" })).toThrow();
  });

  test("keeps the legacy-source marker when supplied", () => {
    const att = makeAttachment({
      ...base,
      kind: ATTACHMENT_KIND.PHOTO,
      source: LEGACY_ATTACHMENT_SOURCE,
    });
    expect(isLegacyMigratedAttachment(att)).toBe(true);
  });
});

describe("legacy / structured entry detection", () => {
  test("a base64 data-URL string is a legacy entry, not a reference", () => {
    const s = "data:image/png;base64,AAAA";
    expect(isLegacyAttachmentEntry(s)).toBe(true);
    expect(isAttachmentRef(s)).toBe(false);
  });

  test("a structured reference is detected by its assetId", () => {
    expect(isAttachmentRef({ assetId: "a1" })).toBe(true);
    expect(isAttachmentRef({})).toBe(false);
    expect(isAttachmentRef(null)).toBe(false);
  });
});

describe("normalizeAttachment(s)", () => {
  test("legacy strings pass through untouched", () => {
    const s = "data:image/png;base64,AAAA";
    expect(normalizeAttachment(s)).toBe(s);
  });

  test("structured refs get defaults filled and display clamped", () => {
    const att = normalizeAttachment({
      assetId: "a1",
      kind: "photo",
      display: { widthPct: 999, alignment: "diagonal" },
    });
    expect(att.id).toBe("a1"); // falls back to assetId
    expect(att.display).toEqual({ widthPct: 100, alignment: "left" });
  });

  test("structurally unusable entries normalize to null (skipped, no crash)", () => {
    expect(normalizeAttachment({ kind: "photo" })).toBeNull();
    expect(normalizeAttachment(42)).toBeNull();
    expect(normalizeAttachment(null)).toBeNull();
  });

  test("mixed arrays keep exact order; only unusable entries are dropped", () => {
    const legacy = "data:image/png;base64,AAAA";
    const ref1 = { id: "r1", assetId: "a1", kind: "photo" };
    const ref2 = { id: "r2", assetId: "a2", kind: "file" };
    const out = normalizeAttachments([ref1, legacy, { broken: true }, ref2]);
    expect(out.map((e) => (typeof e === "string" ? "legacy" : e.id))).toEqual([
      "r1",
      "legacy",
      "r2",
    ]);
  });

  test("attachmentsForField reads one field's list from the instance map", () => {
    const map = {
      f1: [{ id: "r1", assetId: "a1", kind: "photo" }],
      f2: [{ id: "r2", assetId: "a2", kind: "file" }],
    };
    expect(attachmentsForField(map, "f1").map((e) => e.id)).toEqual(["r1"]);
    expect(attachmentsForField(map, "missing")).toEqual([]);
    expect(attachmentsForField(null, "f1")).toEqual([]);
  });
});

describe("display helpers", () => {
  test("formatFileSize is human readable", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  test("fileKindLabel maps MIME/extension to a basic type", () => {
    expect(fileKindLabel("application/pdf", "r.pdf")).toBe("PDF");
    expect(fileKindLabel("", "report.docx")).toBe("Word");
    // CSV wins over the Excel MIME some systems report for .csv files.
    expect(fileKindLabel("application/vnd.ms-excel", "data.csv")).toBe("CSV");
    expect(fileKindLabel("application/vnd.ms-excel", "data.xls")).toBe("Excel");
    expect(fileKindLabel("text/plain", "notes.txt")).toBe("Text");
    expect(fileKindLabel("image/png", "x.png")).toBe("Image");
    expect(fileKindLabel("application/octet-stream", "x.bin")).toBe("File");
  });
});
