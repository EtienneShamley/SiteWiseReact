// src/lib/pdfImportPolicy.js
//
// The ONE decision "may these bytes become a NoteWise PDF document?" — made
// from the bytes themselves, never from a filename, an extension or a
// picker's `accept` attribute (Engineering and Security Standard: no
// security decision from user-controlled metadata).
//
// Two rules, both pure and unit-tested:
//   - the content must carry a PDF header. The PDF specification allows the
//     `%PDF-` signature to appear within the first 1024 bytes (some
//     producers prepend junk); pdf.js tolerates the same window, so the
//     check accepts exactly what the renderer would open.
//   - a size ceiling. Cloud Storage (Production Readiness Phase 7) enforces
//     a hard object ceiling in its rules; the same number is applied HERE so
//     a document that could never sync is refused before anything is
//     written locally, rather than after the local write succeeded.
//
// Returns { ok: true } or { ok: false, error } with a user-facing sentence;
// never throws.

export const MAX_PDF_SOURCE_BYTES = 50 * 1024 * 1024; // 50 MB — matches the Storage object ceiling
export const PDF_HEADER_SEARCH_WINDOW = 1024;

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export const PDF_EMPTY_MESSAGE = "That PDF appears to be empty and was not added.";
export const PDF_NOT_PDF_MESSAGE = "That file is not a PDF document and was not added.";
export const PDF_OVERSIZED_MESSAGE = "That PDF is larger than the 50 MB limit and was not added.";

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input.byteLength === "number" && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }
  return null;
}

/** True when a `%PDF-` signature sits within the first 1024 bytes. */
export function looksLikePdf(input) {
  const bytes = toBytes(input);
  if (!bytes || bytes.byteLength < PDF_SIGNATURE.length) return false;
  const limit = Math.min(bytes.byteLength - PDF_SIGNATURE.length, PDF_HEADER_SEARCH_WINDOW);
  for (let start = 0; start <= limit; start++) {
    let matched = true;
    for (let i = 0; i < PDF_SIGNATURE.length; i++) {
      if (bytes[start + i] !== PDF_SIGNATURE[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Validates candidate PDF bytes. `{ ok: true }` or `{ ok: false, error }`.
 * Only the bytes are consulted.
 */
export function validatePdfSource(input, { maxBytes = MAX_PDF_SOURCE_BYTES } = {}) {
  const bytes = toBytes(input);
  if (!bytes || bytes.byteLength === 0) return { ok: false, error: PDF_EMPTY_MESSAGE };
  if (bytes.byteLength > maxBytes) return { ok: false, error: PDF_OVERSIZED_MESSAGE };
  if (!looksLikePdf(bytes)) return { ok: false, error: PDF_NOT_PDF_MESSAGE };
  return { ok: true };
}
