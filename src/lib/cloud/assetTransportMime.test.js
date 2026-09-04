// src/lib/cloud/assetTransportMime.test.js
//
// The CLOUD TRANSPORT type of a local asset (Production Readiness Phase 7.4).
//
// Two properties matter more than the mapping itself:
//
//   NO WIDENING   every extension consulted is one the product already
//                 accepts, and every type produced is already on the canonical
//                 cloud list. The suite asserts both against the SOURCE lists,
//                 so an edit that widened the policy here would fail rather
//                 than quietly admit a new file type to the cloud.
//   NO CORRECTION a real declaration that is not accepted is REFUSED, never
//                 replaced by whatever the filename claims.

import {
  CLOUD_IMAGE_MIME_BY_EXTENSION,
  canonicalTransportMimeForExtension,
  isImageAssetKind,
  resolveCloudTransportMime,
} from "./assetTransportMime";
import { CLOUD_ASSET_KIND, CLOUD_ASSET_MIME_TYPES, isCloudAssetMimeType } from "./assetCloudModel";
import { ALLOWED_IMAGE_MIME_TYPES } from "../imageProcessing";
import { ALLOWED_NOTE_FILE_EXTENSIONS } from "../assetStorage";
import {
  ALLOWED_FILE_EXTENSIONS,
  CANONICAL_MIME_BY_EXTENSION,
  GENERIC_MIME_TYPES,
} from "../editorFileAttachments";

const FILE_KIND = CLOUD_ASSET_KIND.EDITOR_FILE;
const NOTE_FILE = CLOUD_ASSET_KIND.NOTE_FILE;
const PHOTO = CLOUD_ASSET_KIND.NOTE_PHOTO;

describe("the policy is not widened", () => {
  test("every image extension it consults is one the product already accepts", () => {
    for (const ext of Object.keys(CLOUD_IMAGE_MIME_BY_EXTENSION)) {
      expect(ALLOWED_NOTE_FILE_EXTENSIONS).toContain(ext);
    }
  });

  test("every image type it produces is on the shared image policy", () => {
    for (const mime of Object.values(CLOUD_IMAGE_MIME_BY_EXTENSION)) {
      expect(ALLOWED_IMAGE_MIME_TYPES).toContain(mime);
    }
  });

  test("every document extension it consults is a Free-form accepted extension", () => {
    for (const ext of Object.keys(CANONICAL_MIME_BY_EXTENSION)) {
      expect(ALLOWED_FILE_EXTENSIONS).toContain(ext);
    }
  });

  test("every type it can ever produce is on the canonical cloud list", () => {
    const produced = [
      ...Object.values(CANONICAL_MIME_BY_EXTENSION),
      ...Object.values(CLOUD_IMAGE_MIME_BY_EXTENSION),
      "application/pdf",
    ];
    for (const mime of produced) expect(CLOUD_ASSET_MIME_TYPES).toContain(mime);
  });

  test("an extension outside both maps resolves to nothing", () => {
    for (const ext of [".exe", ".zip", ".svg", ".html", ".heic", ".gif", ""]) {
      expect(canonicalTransportMimeForExtension(ext)).toBeNull();
    }
  });
});

describe("every canonical accepted type is preserved", () => {
  test.each(CLOUD_ASSET_MIME_TYPES)("%s survives untouched on a file asset", (mime) => {
    const kind = ALLOWED_IMAGE_MIME_TYPES.includes(mime) ? PHOTO : FILE_KIND;
    const result = resolveCloudTransportMime({ assetKind: kind, mimeType: mime, name: "whatever.bin" });
    expect(result).toEqual({ ok: true, mimeType: mime, derived: false });
  });

  test("a parameterised type is normalised, not refused", () => {
    expect(resolveCloudTransportMime({ assetKind: FILE_KIND, mimeType: "text/csv; charset=utf-8" })).toEqual({
      ok: true,
      mimeType: "text/csv",
      derived: false,
    });
  });

  test("an upper-case type is normalised", () => {
    expect(resolveCloudTransportMime({ assetKind: PHOTO, mimeType: "IMAGE/PNG" })).toEqual({
      ok: true,
      mimeType: "image/png",
      derived: false,
    });
  });
});

describe("legacy records accepted by extension", () => {
  test.each([
    [".pdf", "application/pdf"],
    [".doc", "application/msword"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".xls", "application/vnd.ms-excel"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".ppt", "application/vnd.ms-powerpoint"],
    [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    [".txt", "text/plain"],
    [".csv", "text/csv"],
  ])("a null MIME with %s resolves to %s", (ext, mime) => {
    expect(resolveCloudTransportMime({ assetKind: NOTE_FILE, mimeType: null, name: `report${ext}` })).toEqual({
      ok: true,
      mimeType: mime,
      derived: true,
    });
  });

  test.each(GENERIC_MIME_TYPES)("the generic type %p lets a known extension decide", (generic) => {
    expect(resolveCloudTransportMime({ assetKind: NOTE_FILE, mimeType: generic, name: "sheet.xlsx" })).toEqual({
      ok: true,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      derived: true,
    });
  });

  test("application/octet-stream with a known extension is mapped", () => {
    expect(
      resolveCloudTransportMime({ assetKind: FILE_KIND, mimeType: "application/octet-stream", name: "notes.txt" })
    ).toEqual({ ok: true, mimeType: "text/plain", derived: true });
  });

  test("an image record with no reported type is resolved from its extension", () => {
    expect(resolveCloudTransportMime({ assetKind: PHOTO, mimeType: "", name: "site.JPG" })).toEqual({
      ok: true,
      mimeType: "image/jpeg",
      derived: true,
    });
  });

  test("an octet-stream note-file that is really a photo resolves to an image type", () => {
    expect(
      resolveCloudTransportMime({ assetKind: NOTE_FILE, mimeType: "application/octet-stream", name: "wall.png" })
    ).toEqual({ ok: true, mimeType: "image/png", derived: true });
  });
});

describe("PDF source bytes", () => {
  test("are application/pdf whatever the record says", () => {
    expect(resolveCloudTransportMime({ assetKind: CLOUD_ASSET_KIND.PDF_SOURCE, mimeType: null, name: null })).toEqual({
      ok: true,
      mimeType: "application/pdf",
      derived: false,
    });
    expect(
      resolveCloudTransportMime({
        assetKind: CLOUD_ASSET_KIND.PDF_SOURCE,
        mimeType: "application/octet-stream",
        name: "plan.pdf",
      })
    ).toEqual({ ok: true, mimeType: "application/pdf", derived: false });
  });
});

describe("refusals", () => {
  test("an unknown extension with no declared type is refused", () => {
    expect(resolveCloudTransportMime({ assetKind: FILE_KIND, mimeType: null, name: "archive.zip" })).toEqual({
      ok: false,
      reason: "unsupported-mime",
    });
  });

  test("no name and no type is refused", () => {
    expect(resolveCloudTransportMime({ assetKind: FILE_KIND, mimeType: null, name: null })).toEqual({
      ok: false,
      reason: "unsupported-mime",
    });
  });

  test("a real declaration outside the cloud list is refused, not corrected by the filename", () => {
    const result = resolveCloudTransportMime({
      assetKind: FILE_KIND,
      mimeType: "application/zip",
      name: "invoice.pdf",
    });
    expect(result).toEqual({ ok: false, reason: "unsupported-mime" });
  });

  test("a scriptable type is refused even with an accepted extension", () => {
    expect(resolveCloudTransportMime({ assetKind: FILE_KIND, mimeType: "text/html", name: "notes.txt" })).toEqual({
      ok: false,
      reason: "unsupported-mime",
    });
  });

  test("an image kind may not resolve to a document type", () => {
    expect(resolveCloudTransportMime({ assetKind: PHOTO, mimeType: "text/csv", name: "data.csv" })).toEqual({
      ok: false,
      reason: "unsupported-mime",
    });
    expect(resolveCloudTransportMime({ assetKind: CLOUD_ASSET_KIND.LOGO, mimeType: null, name: "brand.pdf" })).toEqual({
      ok: false,
      reason: "unsupported-mime",
    });
  });

  test("every produced type passes the cloud model's own check", () => {
    for (const name of ["a.pdf", "b.docx", "c.csv", "d.png", "e.jpeg", "f.webp"]) {
      const result = resolveCloudTransportMime({ assetKind: NOTE_FILE, mimeType: null, name });
      expect(result.ok).toBe(true);
      expect(isCloudAssetMimeType(result.mimeType)).toBe(true);
    }
  });
});

describe("isImageAssetKind", () => {
  test("names exactly the kinds whose bytes must be an image", () => {
    expect(isImageAssetKind(CLOUD_ASSET_KIND.LOGO)).toBe(true);
    expect(isImageAssetKind(CLOUD_ASSET_KIND.NOTE_PHOTO)).toBe(true);
    expect(isImageAssetKind(CLOUD_ASSET_KIND.EDITOR_IMAGE)).toBe(true);
    expect(isImageAssetKind(CLOUD_ASSET_KIND.NOTE_FILE)).toBe(false);
    expect(isImageAssetKind(CLOUD_ASSET_KIND.EDITOR_FILE)).toBe(false);
    expect(isImageAssetKind(CLOUD_ASSET_KIND.PDF_SOURCE)).toBe(false);
  });
});
