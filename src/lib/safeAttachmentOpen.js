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
// object-URL lifecycle and tab-sequencing helpers at the bottom, so the policy
// is unit-testable in isolation. Those helpers take their window access and
// Blob retrieval as injectable parameters, so the open sequence is testable
// too.

/* -------------------------------------------------------------------------
 * Shared user-facing attachment messages.
 *
 * Restrained and FIXED: they never carry an exception message, a stack trace,
 * a storage key, an object URL, an internal module name or any other
 * implementation detail. A user cannot act on "DataError: key not found", and
 * showing it only leaks how the application is built.
 * ---------------------------------------------------------------------- */

export const ATTACHMENT_UNAVAILABLE_MESSAGE = "This attached file is unavailable.";
export const ATTACHMENT_OPEN_FAILED_MESSAGE = "This file could not be opened.";
export const ATTACHMENT_DOWNLOAD_FAILED_MESSAGE =
  "This file could not be downloaded.";
export const ATTACHMENT_PREVIEW_DENIED_MESSAGE =
  "This file can't be previewed in NoteWise. Use Download to open it in another application.";

/* -------------------------------------------------------------------------
 * Safe download filenames
 *
 * A filename is user-controlled data that reaches a real filesystem through
 * the `download` attribute. It is sanitized STRUCTURALLY here — path
 * separators, traversal segments, control characters and reserved characters
 * are removed — and the result is only ever used as a download name or as
 * escaped React text. It is never interpreted as HTML, and it never grants any
 * permission: what a file may DO is decided by the retrieved Blob's own MIME
 * type (see resolveOpenPolicy above), never by its name.
 *
 * Shared deliberately: Template-form File evidence and Free-form note
 * attachments must not each grow their own idea of what a safe filename is.
 * ---------------------------------------------------------------------- */

export const DOWNLOAD_FILENAME_FALLBACK = "attachment";
export const MAX_DOWNLOAD_FILENAME_LENGTH = 120;

// A structurally plausible extension, so a long name can be truncated without
// losing the suffix that tells the operating system what to open it with. This
// is a SHAPE check only — which extensions are ACCEPTABLE is a policy question
// answered where files are validated, not here.
const SIMPLE_EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Reduce a user-supplied filename to something safe to hand to a download.
 *
 * Always returns a non-empty string; a name with nothing usable left becomes
 * DOWNLOAD_FILENAME_FALLBACK rather than an empty `download` attribute.
 */
export function safeDownloadFilename(name) {
  if (typeof name !== "string") return DOWNLOAD_FILENAME_FALLBACK;

  let value = name
    // Control characters, including NUL — these can truncate or confuse a path.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    // Path separators: a filename must never be able to address a directory.
    .replace(/[\\/]+/g, " ")
    // Reserved or awkward on common filesystems.
    .replace(/[:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Drop traversal segments left behind by the separator removal above
  // ("../../etc/passwd" -> ".. .. etc passwd" -> "etc passwd").
  value = value
    .split(" ")
    .filter((part) => part && !/^\.+$/.test(part))
    .join(" ");

  // A leading dot makes a hidden file on Unix-like systems.
  value = value.replace(/^\.+/, "").trim();

  if (!value) return DOWNLOAD_FILENAME_FALLBACK;

  if (value.length > MAX_DOWNLOAD_FILENAME_LENGTH) {
    const match = SIMPLE_EXTENSION_RE.exec(value);
    const ext = match ? match[0] : "";
    const stem = ext ? value.slice(0, value.length - ext.length) : value;
    const room = Math.max(1, MAX_DOWNLOAD_FILENAME_LENGTH - ext.length);
    value = `${stem.slice(0, room).trim()}${ext}`;
  }

  return value || DOWNLOAD_FILENAME_FALLBACK;
}

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

/* -------------------------------------------------------------------------
 * Opening a PDF: user-gesture-safe tab sequencing
 *
 * The Blob comes from IndexedDB asynchronously, so by the time it arrives the
 * click's user activation has expired and a fresh window.open() would be
 * popup-blocked. The tab is therefore RESERVED synchronously inside the click
 * handler (reserveNavigationTab), and only navigated once the Blob has been
 * retrieved and the policy re-checked against it.
 *
 * `noopener` must NEVER be passed as a window feature here: per the HTML spec
 * window.open() returns null whenever noopener is requested, which is
 * indistinguishable from a blocked popup — that is exactly what made every
 * successful open report itself as blocked. It was not a security control in
 * this flow anyway (a `blob:` URL is same-origin — see the header); the safety
 * property is the MIME allowlist above, which is unchanged. The opener
 * back-reference is still severed, as defence in depth, after navigation.
 * ---------------------------------------------------------------------- */

// A navigated PDF needs its object URL to outlive the click; the new tab reads
// it immediately after opening. Mirrors the exported-file handling elsewhere.
export const NAVIGATION_URL_REVOKE_MS = 10000;

// Outcome of an open attempt. The caller maps these to UI; only BLOCKED means
// the browser actually refused to open a tab.
export const OPEN_RESULT = {
  PDF_OPENED: "pdf-opened",
  IMAGE_PREVIEW: "image-preview",
  TEXT_PREVIEW: "text-preview",
  DENIED: "denied", // policy refused inline rendering — still downloadable
  MISSING: "missing", // asset absent from storage
  READ_ERROR: "read-error", // retrieval threw
  BLOCKED: "blocked", // no tab could be opened / navigated
};

function defaultOpenWindow(url) {
  if (typeof window === "undefined" || typeof window.open !== "function") {
    return null;
  }
  return window.open(url, "_blank");
}

/**
 * Synchronously reserve a blank tab. MUST be called from the click handler
 * itself, before any `await`, so the user gesture is still valid.
 *
 * @returns {Window|null} null only when the browser genuinely blocked it.
 */
export function reserveNavigationTab(openWindow = defaultOpenWindow) {
  try {
    return openWindow("about:blank") || null;
  } catch {
    return null;
  }
}

/** Close a reserved tab that will not be used. Never throws. */
export function closeReservedTab(tab) {
  if (!tab) return;
  try {
    tab.close();
  } catch {
    /* already closed or inaccessible */
  }
}

/**
 * Point a reserved tab at `url`. Returns false if the navigation could not be
 * performed, so the caller can close the tab and report a real failure.
 */
export function navigateReservedTab(tab, url) {
  if (!tab) return false;
  try {
    try {
      tab.opener = null; // defence in depth; not the security control here
    } catch {
      /* some browsers refuse the assignment — not fatal */
    }
    if (tab.location && typeof tab.location.replace === "function") {
      // replace() so the transient about:blank leaves no history entry.
      tab.location.replace(url);
    } else {
      tab.location = url;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Complete an attachment open: retrieve the Blob, re-evaluate the safe-open
 * policy against the bytes actually held, and present it.
 *
 * Every failure path — retrieval error, missing asset, policy denial — closes
 * the reserved tab, so a temporary blank tab is never left behind.
 *
 * @param {object}   deps
 * @param {Window|null} deps.reservedTab  tab reserved during the click, if any
 * @param {Function} deps.getBlob         () => Promise<Blob|null>
 * @param {string}   [deps.metadataMimeType] consistency check only
 * @param {Function} [deps.openWindow]    fallback opener (no tab reserved)
 * @param {Function} [deps.createUrl]     object-URL factory (injected in tests)
 * @returns {Promise<{status, policy?, url?, blob?, revoke?, error?}>}
 */
export async function openAttachmentSafely({
  reservedTab = null,
  getBlob,
  metadataMimeType,
  openWindow = defaultOpenWindow,
  createUrl = createManagedObjectUrl,
}) {
  let blob;
  try {
    blob = await getBlob();
  } catch (error) {
    closeReservedTab(reservedTab);
    return { status: OPEN_RESULT.READ_ERROR, error };
  }

  if (!blob) {
    closeReservedTab(reservedTab);
    return { status: OPEN_RESULT.MISSING };
  }

  // Authoritative check: the Blob's own type decides, never the filename.
  const policy = resolveOpenPolicy(blob.type, metadataMimeType);

  if (!isInlineRenderable(policy)) {
    // Denial never mutates or removes the attachment — it stays downloadable.
    closeReservedTab(reservedTab);
    return { status: OPEN_RESULT.DENIED, policy };
  }

  if (policy.mode === RENDER_MODE.PDF) {
    const managed = createUrl(blob, { revokeAfterMs: NAVIGATION_URL_REVOKE_MS });
    let tab = reservedTab;
    if (!tab) {
      // No tab was reserved (the pre-click policy expected a dialog and the
      // stored bytes turned out to be a PDF). Try anyway; being blocked here
      // is a genuine block.
      try {
        tab = openWindow(managed.url) || null;
      } catch {
        tab = null;
      }
      if (!tab) {
        managed.revoke();
        return { status: OPEN_RESULT.BLOCKED, policy };
      }
      return { status: OPEN_RESULT.PDF_OPENED, policy, revoke: managed.revoke };
    }
    if (!navigateReservedTab(tab, managed.url)) {
      managed.revoke();
      closeReservedTab(tab);
      return { status: OPEN_RESULT.BLOCKED, policy };
    }
    return { status: OPEN_RESULT.PDF_OPENED, policy, revoke: managed.revoke };
  }

  // Image and text are controlled dialogs, never navigations — a reserved tab
  // is not needed and must not be left open.
  closeReservedTab(reservedTab);

  if (policy.mode === RENDER_MODE.IMAGE) {
    const managed = createUrl(blob);
    return {
      status: OPEN_RESULT.IMAGE_PREVIEW,
      policy,
      url: managed.url,
      revoke: managed.revoke,
    };
  }

  return { status: OPEN_RESULT.TEXT_PREVIEW, policy, blob };
}
