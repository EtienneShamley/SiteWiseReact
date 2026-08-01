// src/lib/editorImages.test.js

import {
  ALLOWED_EDITOR_IMAGE_MIME_TYPES,
  EDITOR_IMAGE_SIZE_MESSAGE,
  EDITOR_IMAGE_TYPE_MESSAGE,
  MAX_EDITOR_IMAGE_BYTES,
  isAllowedImageDataUrl,
  validateEditorImageFile,
} from "./editorImages";

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

  test("the size limit stays well inside a typical localStorage budget", () => {
    // Base64 inflates by ~4/3; the whole origin gets roughly 5 MB.
    expect(MAX_EDITOR_IMAGE_BYTES * (4 / 3)).toBeLessThan(2 * 1024 * 1024);
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

describe("isAllowedImageDataUrl", () => {
  test("accepts a data URL carrying an allowed image type", () => {
    expect(isAllowedImageDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isAllowedImageDataUrl("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(isAllowedImageDataUrl("data:image/webp;base64,UklGRg==")).toBe(true);
  });

  test("rejects a data URL carrying anything else", () => {
    expect(isAllowedImageDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isAllowedImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isAllowedImageDataUrl("data:,hello")).toBe(false);
  });

  test("rejects anything that is not a data URL at all", () => {
    expect(isAllowedImageDataUrl("https://example.com/x.png")).toBe(false);
    expect(isAllowedImageDataUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedImageDataUrl(null)).toBe(false);
    expect(isAllowedImageDataUrl(undefined)).toBe(false);
  });
});
