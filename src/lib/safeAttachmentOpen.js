// src/lib/safeAttachmentOpen.js
//
// Safe-open policy for note File attachments.
//
// SECURITY: a `blob:` URL inherits the ORIGIN of the page that created it, so
// navigating to a user-supplied file renders it as a same-origin document. An
// HTML, XHTML, SVG, XML or JavaScript payload opened that way executes script
// with full access to this origin's localStorage and IndexedDB — every note,
// template and piece of evidence in the browser profile. `noopener` does NOT
// prevent this (it only severs `window.opener`), so it is not a security
// control here.
//
// Therefore inline rendering permission is decided ONLY by the MIME type of the
// Blob actually retrieved from IndexedDB, checked against an explicit
// allowlist. It is never inferred from:
//   - the filename
//   - the file extension
//   - the displayed file-type label
//   - the attachment metadata alone
// A file called `report.txt`, `report.pdf` or `image.png` gets no inline
// permission whatsoever if the stored Blob's type says otherwise.
//
// The stored metadata MIME type is used only as a CONSISTENCY CHECK: when both
// it and the Blob type are present they must agree, otherwise the attachment is
// Download-only. Denying inline rendering never mutates or deletes the
// attachment — the file is still downloadable and its record is untouched.
//
// This module is pure (no DOM, no React, no IndexedDB) apart from the small
// object-URL lifecycle helper at the bottom, so the policy is unit-testable in
// isolation.

// How an attachment may be presented once its Blob has been retrieved.
export const RENDER_MODE = {
  // Open the PDF itself (object URL). Only for an exact application/pdf Blob.
  PDF: "pdf",
  // Controlled <img> preview inside a dialog. Never a navigation, so the image
  // bytes are decoded as an image and can never execute as a document.
  IMAGE: "image",
  // Controlled plain-text preview: blob.text() rendered as ESCAPED React text
  // inside <pre>. Never dangerouslySetInnerHTML.
  TEXT: "text",
  // Download only — the browser saves the file instead of rendering it.
  DOWNLOAD: "download",
};

// Why inline rendering was denied (surfaced for tests/diagnostics, not shown
// verbatim to users).
export const DENY_REASON = {
  MISSING_MIME: "missing-mime",
  BLOCKED_MIME: "blocked-mime",
  MIME_MISMATCH: "mime-mismatch",
  UNSUPPORTED_MIME: "unsupported-mime",
};

// Exact MIME types that may be opened as a document (navigated to).
export const INLINE_PDF_MIME_TYPE = "application/pdf";

// Exact MIME types that may be shown through the controlled <img> preview.
// SVG is deliberately absent: it is an XML document format that can carry
// script, and it must never be treated as an ordinary image here.
export const INLINE_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// Exact MIME types that may be shown through the controlled escaped-text
// preview.
export const INLINE_TEXT_MIME_TYPES = ["text/plain", "text/csv"];

// Explicitly blocked from any inline rendering. The allowlist above already
// excludes these — this set is a second, self-documenting barrier so a future
// edit that widens the allowlist cannot silently admit an executable document
// format.
export const BLOCKED_INLINE_MIME_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
];

const INLINE_IMAGE_SET = new Set(INLINE_IMAGE_MIME_TYPES);
const INLINE_TEXT_SET = new Set(INLINE_TEXT_MIME_TYPES);
const BLOCKED_SET = new Set(BLOCKED_INLINE_MIME_TYPES);

// Lowercase, trim, and drop any parameters (e.g. "text/plain; charset=utf-8"
// -> "text/plain") so comparisons and the allowlist are exact.
export function normalizeMimeType(mimeType) {
  if (typeof mimeType !== "string") return "";
  const base = mimeType.split(";")[0];
  return base.trim().toLowerCase();
}

// True for anything that must never be rendered inline. Beyond the explicit
// list this also covers, by structure:
//   - every "+xml" suffixed type (SVG, XHTML and any future XML dialect)
//   - every JavaScript/ECMAScript type
// so an unlisted variant cannot slip through.
export function isDangerousInlineMimeType(mimeType) {
  const mime = normalizeMimeType(mimeType);
  if (!mime) return false; // absent type is handled as MISSING_MIME, not dangerous
  if (BLOCKED_SET.has(mime)) return true;
  if (mime.endsWith("+xml")) return true;
  if (mime.includes("javascript") || mime.includes("ecmascript")) return true;
  return false;
}

/**
 * Decide how an attachment may be presented.
 *
 * @param {string} blobMimeType     MIME type of the Blob retrieved from
 *                                  IndexedDB — the FINAL AUTHORITY.
 * @param {string} [metadataMimeType] MIME type recorded on the attachment
 *                                  reference, used only as a consistency check.
 * @returns {{ mode: string, reason?: string }}
 *
 * Any path that is not an explicit allowlist match resolves to DOWNLOAD.
 */
export function resolveOpenPolicy(blobMimeType, metadataMimeType) {
  const blobMime = normalizeMimeType(blobMimeType);

  // Unknown/empty stored type: never guess from the filename.
  if (!blobMime) {
    return { mode: RENDER_MODE.DOWNLOAD, reason: DENY_REASON.MISSING_MIME };
  }

  // Executable/document formats are refused before anything else.
  if (isDangerousInlineMimeType(blobMime)) {
    return { mode: RENDER_MODE.DOWNLOAD, reason: DENY_REASON.BLOCKED_MIME };
  }

  // When both types are known they must agree; a mismatch means the record and
  // its bytes disagree about what this file is, so it is not rendered inline.
  const metaMime = normalizeMimeType(metadataMimeType);
  if (metaMime && metaMime !== blobMime) {
    return { mode: RENDER_MODE.DOWNLOAD, reason: DENY_REASON.MIME_MISMATCH };
  }

  if (blobMime === INLINE_PDF_MIME_TYPE) return { mode: RENDER_MODE.PDF };
  if (INLINE_IMAGE_SET.has(blobMime)) return { mode: RENDER_MODE.IMAGE };
  if (INLINE_TEXT_SET.has(blobMime)) return { mode: RENDER_MODE.TEXT };

  // Office formats and everything else: Download only.
  return { mode: RENDER_MODE.DOWNLOAD, reason: DENY_REASON.UNSUPPORTED_MIME };
}

// Convenience predicate: may this policy result be presented without a download?
export function isInlineRenderable(policy) {
  return !!policy && policy.mode !== RENDER_MODE.DOWNLOAD;
}

/**
 * Create an object URL with an owned lifecycle, so a `blob:` URL is never
 * leaked and never persisted.
 *
 * `revoke()` is idempotent and cancels the scheduled auto-revoke. When
 * `revokeAfterMs` is a positive number the URL is also revoked automatically
 * after that delay — needed for a navigation (a new tab must still be able to
 * read the URL immediately after it opens), matching the existing exported-file
 * handling elsewhere in this codebase. Dialogs pass no delay and revoke
 * explicitly on close/unmount.
 */
export function createManagedObjectUrl(blob, { revokeAfterMs } = {}) {
  const url = URL.createObjectURL(blob);
  let revoked = false;
  let timer = null;

  const revoke = () => {
    if (revoked) return;
    revoked = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    URL.revokeObjectURL(url);
  };

  if (typeof revokeAfterMs === "number" && revokeAfterMs > 0) {
    timer = setTimeout(revoke, revokeAfterMs);
  }

  return { url, revoke };
}
