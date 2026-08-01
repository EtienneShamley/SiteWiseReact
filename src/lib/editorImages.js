// src/lib/editorImages.js
//
// The Free-form editor's view of the shared image-upload policy
// (src/lib/imageProcessing.js). It exists as its own module because the editor
// surfaces — the toolbar upload and the BottomBar/camera insert — import their
// rules from here; the rules themselves are defined once, next to the
// normalization that enforces them, and are shared with Template-form Photo
// fields.
//
// STORAGE MODEL — this changed. A Free-form editor image is no longer embedded
// in the note's HTML as a data URL. Its bytes go to IndexedDB through the same
// asset store Template-form Photo/File evidence uses, and the note's document
// carries only a lightweight `assetId` reference (see
// src/lib/editorImageAssets.js). That is why the old 1 MB cap is gone: the
// limit no longer protects the shared ~5 MB localStorage budget, so it can be
// an ordinary-phone-photo limit instead of a stopgap.
//
// SECURITY: the decision is made from the Blob's own `type`, never from the
// filename, the extension, or the input's `accept` attribute — `accept` is a
// user-controlled picker hint that any file can be dropped past.
//
// Pure: no DOM, no IndexedDB, no React.

import {
  ALLOWED_IMAGE_MIME_TYPES,
  IMAGE_DECODE_MESSAGE,
  IMAGE_OVERSIZED_MESSAGE,
  IMAGE_STORAGE_MESSAGE,
  IMAGE_UNSUPPORTED_MESSAGE,
  MAX_IMAGE_SOURCE_BYTES,
  validateImageSource,
} from "./imageProcessing";

// Re-exported under the editor's own names so the toolbar and BottomBar do not
// each have to know where the policy lives. SVG is absent deliberately: it is a
// scriptable XML document format, not an ordinary image.
export const ALLOWED_EDITOR_IMAGE_MIME_TYPES = ALLOWED_IMAGE_MIME_TYPES;
export const MAX_EDITOR_IMAGE_BYTES = MAX_IMAGE_SOURCE_BYTES;

export const EDITOR_IMAGE_TYPE_MESSAGE = IMAGE_UNSUPPORTED_MESSAGE;
export const EDITOR_IMAGE_SIZE_MESSAGE = IMAGE_OVERSIZED_MESSAGE;
export const EDITOR_IMAGE_READ_MESSAGE = IMAGE_DECODE_MESSAGE;
export const EDITOR_IMAGE_STORAGE_MESSAGE = IMAGE_STORAGE_MESSAGE;

/**
 * Decide whether a picked File may be inserted into the Free-form note.
 *
 * @returns {{ok: true, mimeType: string}} | {{ok: false, error: string}}
 */
export function validateEditorImageFile(file) {
  return validateImageSource(file);
}
