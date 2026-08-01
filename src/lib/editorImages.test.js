// src/lib/editorImages.test.js

import {
  ALLOWED_EDITOR_IMAGE_MIME_TYPES,
  EDITOR_IMAGE_SIZE_MESSAGE,
  EDITOR_IMAGE_TYPE_MESSAGE,
  MAX_EDITOR_IMAGE_BYTES,
  validateEditorImageFile,
} from "./editorImages";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_SOURCE_BYTES,
} from "./imageProcessing";

// A File-shaped stand-in: only `type` and `size` are consulted, which is the
// point — the decision must not depend on the filename.
const fileLike = (type, size, name = "photo.png") => ({ type, size, name });

describe("validateEditorImageFile", () => {
  test("accepts the allowed image types", () => {
    expect(ALLOWED_EDITOR_IMAGE_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    for (const type of ALLOWED_EDITOR_IMAGE_MIME_TYPES) {
      expect(validateEditorImageFile(fileLike(type, 1024))).toEqual({
        ok: true,
        mimeType: type,
      });
    }
  });

  test("rejects a disallowed MIME type", () => {
    for (const type of [
      "image/svg+xml",
      "image/gif",
      "text/html",
      "application/pdf",
      "application/octet-stream",
      "",
    ]) {
      const result = validateEditorImageFile(fileLike(type, 1024));
      expect(result.ok).toBe(false);
      expect(result.error).toBe(EDITOR_IMAGE_TYPE_MESSAGE);
    }
  });

  test("SVG is rejected even though it is an image — it is a scriptable document", () => {
    expect(validateEditorImageFile(fileLike("image/svg+xml", 500)).ok).toBe(false);
  });

  test("the decision comes from the type, never from the filename", () => {
    // A .png name over an HTML payload must not be accepted...
    expect(validateEditorImageFile(fileLike("text/html", 100, "photo.png")).ok).toBe(false);
    // ...and a .exe name over a real PNG is fine.
    expect(validateEditorImageFile(fileLike("image/png", 100, "payload.exe")).ok).toBe(true);
  });

  test("parameterised and mixed-case MIME types are normalized", () => {
    expect(validateEditorImageFile(fileLike("IMAGE/PNG", 100)).ok).toBe(true);
    expect(validateEditorImageFile(fileLike("image/jpeg; charset=binary", 100)).ok).toBe(true);
  });

  test("rejects an oversized file at the boundary", () => {
    expect(validateEditorImageFile(fileLike("image/png", MAX_EDITOR_IMAGE_BYTES)).ok).toBe(true);
    const tooBig = validateEditorImageFile(
      fileLike("image/png", MAX_EDITOR_IMAGE_BYTES + 1)
    );
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error).toBe(EDITOR_IMAGE_SIZE_MESSAGE);
  });

  test("the limit is the shared 20 MB source-file policy", () => {
    // It is no longer a localStorage stopgap: the bytes go to IndexedDB, so the
    // limit exists to bound one upload, not to protect the note's own record.
    expect(MAX_EDITOR_IMAGE_BYTES).toBe(MAX_IMAGE_SOURCE_BYTES);
    expect(MAX_EDITOR_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });

  test("an ordinary high-resolution phone photo needs no manual resizing", () => {
    expect(validateEditorImageFile(fileLike("image/jpeg", 12 * 1024 * 1024)).ok).toBe(
      true
    );
  });

  test("the editor and Template-form Photo fields share one answer", () => {
    expect(ALLOWED_EDITOR_IMAGE_MIME_TYPES).toBe(ALLOWED_IMAGE_MIME_TYPES);
  });

  test("rejects a missing, empty or unreadable file", () => {
    expect(validateEditorImageFile(null).ok).toBe(false);
    expect(validateEditorImageFile(undefined).ok).toBe(false);
    expect(validateEditorImageFile("photo.png").ok).toBe(false);
    expect(validateEditorImageFile(fileLike("image/png", 0)).ok).toBe(false);
    expect(validateEditorImageFile(fileLike("image/png", NaN)).ok).toBe(false);
    expect(validateEditorImageFile(fileLike("image/png", -1)).ok).toBe(false);
  });

  test("a rejection never names the file back to the user", () => {
    const result = validateEditorImageFile(fileLike("text/html", 10, "secret-site.html"));
    expect(result.error).not.toContain("secret-site");
  });
});

describe("no base64 insertion path remains", () => {
  test("the module exposes no data-URL helper for creating new images", async () => {
    // A new Free-form image is an IndexedDB reference. The former data-URL
    // helpers were removed so no reachable command can create a base64-backed
    // image again; legacy base64 in EXISTING notes still renders and exports
    // (see editorImageAssets.test.js and exportImageAssets.test.js).
    const mod = await import("./editorImages");
    expect(mod.isAllowedImageDataUrl).toBeUndefined();
    const commands = await import("./editorCommands");
    expect(commands.insertImageDataUrl).toBeUndefined();
  });
});
