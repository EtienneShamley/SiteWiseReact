// src/lib/editorImages.js
//
// Validation for images inserted into the Free-form note (toolbar upload and
// the BottomBar/camera insert path).
//
// SCOPE BOUNDARY — read before changing the limit below.
// A Free-form editor image is stored as a data URL inside the note's HTML,
// which lives in localStorage under "sitewise-notes". That is the current
// model; replacing it with the IndexedDB asset architecture that Template-form
// Photo/File evidence uses (src/lib/assetStorage.js) is a storage-architecture
// change and is explicitly out of scope here. The size limit is therefore a
// deliberate stopgap chosen so a single insert cannot exhaust the origin's
// ~5 MB localStorage budget and take every note's persistence down with it.
//
// SECURITY: the decision is made from the Blob's own `type`, never from the
// filename, the extension, or the input's `accept` attribute — `accept` is a
// user-controlled picker hint that any file can be dropped past.
//
// Pure: no DOM, no IndexedDB, no React.

// Matches assetStorage.ALLOWED_PHOTO_MIME_TYPES so the application has one
// answer to "which image types do we accept". SVG is absent deliberately: it
// is a scriptable XML document format, not an ordinary image.
export const ALLOWED_EDITOR_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

// 1 MB of source bytes — roughly 1.4 MB once base64-encoded into the note.
export const MAX_EDITOR_IMAGE_BYTES = 1024 * 1024;

export const EDITOR_IMAGE_TYPE_MESSAGE =
  "That file was not inserted — only PNG, JPEG and WebP images are supported.";
export const EDITOR_IMAGE_SIZE_MESSAGE =
  "That image was not inserted — editor images must be 1 MB or smaller.";
export const EDITOR_IMAGE_READ_MESSAGE =
  "That image could not be read, so nothing was inserted.";

function normalizeMime(type) {
  if (typeof type !== "string") return "";
  return type.split(";")[0].trim().toLowerCase();
}

/**
 * Decide whether a picked File may be inserted into the Free-form note.
 *
 * @returns {{ok: true, mimeType: string}} | {{ok: false, error: string}}
 */
export function validateEditorImageFile(file) {
  if (!file || typeof file !== "object") {
    return { ok: false, error: EDITOR_IMAGE_TYPE_MESSAGE };
  }

  const mimeType = normalizeMime(file.type);
  if (!ALLOWED_EDITOR_IMAGE_MIME_TYPES.includes(mimeType)) {
    return { ok: false, error: EDITOR_IMAGE_TYPE_MESSAGE };
  }

  const size = typeof file.size === "number" ? file.size : NaN;
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: EDITOR_IMAGE_READ_MESSAGE };
  }
  if (size > MAX_EDITOR_IMAGE_BYTES) {
    return { ok: false, error: EDITOR_IMAGE_SIZE_MESSAGE };
  }

  return { ok: true, mimeType };
}

/**
 * A data URL is only acceptable if it actually carries one of the allowed
 * image types. This re-checks the produced string rather than trusting that
 * the reader honoured the File's declared type.
 */
export function isAllowedImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return false;
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  if (!match) return false;
  return ALLOWED_EDITOR_IMAGE_MIME_TYPES.includes(normalizeMime(match[1]));
}
