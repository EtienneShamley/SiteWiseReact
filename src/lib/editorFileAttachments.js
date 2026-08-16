// src/lib/editorFileAttachments.js
//
// The policy and the persistence boundary for a FREE-FORM note file attachment
// (an ordinary business document — PDF, Word, Excel, PowerPoint, text, CSV).
//
// It is the file counterpart of src/lib/editorImageAssets.js + editorImages.js,
// and it follows the same architecture: the bytes live ONLY in IndexedDB
// (src/lib/assetStorage.js, kind `editor-file`) and the note's rich-text
// document carries a lightweight REFERENCE — an `assetId` serialized as
// `data-file-asset-id`, plus the small display metadata (filename, MIME type,
// byte size) needed to draw a card before the bytes arrive.
//
// Three rules make that safe, and they are enforced here rather than in the
// node so they are unit-testable without a DOM or a running editor:
//
//   1. A `blob:` URL, an object URL, a Blob, base64 bytes and every runtime
//      state (busy, availability, selection, errors) are NEVER serialized. Only
//      the four reference attributes below reach stored note HTML.
//   2. The reference is DISPLAY metadata, never authority. What a file may DO
//      is decided from the asset record actually retrieved from IndexedDB — its
//      `kind` and its Blob's own MIME type (see src/lib/safeAttachmentOpen.js).
//      A node claiming `application/pdf` proves nothing.
//   3. Every attribute is validated on the way IN as well as on the way OUT.
//      Stored note HTML is data, and an id, a size or a filename read back out
//      of it is treated as untrusted input.
//
// SECURITY — the accept policy. The decision is made from the file's MIME type
// first. A restrained extension fallback exists ONLY because some browsers and
// operating systems report an empty or generic type for Office and CSV files;
// it never widens what is accepted, and a declared MIME type that CONTRADICTS
// the extension is rejected rather than silently corrected (`invoice.pdf.exe`
// declared `application/pdf` is not a PDF). Executables, installers, archives,
// disk images, scripts, HTML, SVG, macro-enabled Office documents and
// audio/video are refused. Images are refused too — they belong to the
// persistent editor-IMAGE path and are routed there before validation.
//
// Pure: no DOM, no IndexedDB, no React, no editor.

import { ASSET_KIND_EDITOR_FILE, fileExtension } from "./assetStorage";
import {
  isDangerousInlineMimeType,
  normalizeMimeType,
  safeDownloadFilename,
} from "./safeAttachmentOpen";
import { formatFileSize } from "./noteAttachments";

/* ------------------------------ node contract ---------------------------- */

export const FILE_ATTACHMENT_NODE_NAME = "fileAttachment";

export const FILE_ATTACHMENT_ASSET_ATTR = "data-file-asset-id";
export const FILE_ATTACHMENT_NAME_ATTR = "data-file-name";
export const FILE_ATTACHMENT_TYPE_ATTR = "data-file-type";
export const FILE_ATTACHMENT_SIZE_ATTR = "data-file-size";

export const FILE_ATTACHMENT_CLASS = "note-file-attachment";

/**
 * Which IndexedDB asset KIND the shared file-attachment card may open —
 * separate from the id/attribute SHAPE checks above. Kind is the runtime
 * ownership boundary (see src/lib/assetStorage.js): a card must never open a
 * Blob belonging to a different feature just because a document happens to
 * point at it, even a well-formed, safely-shaped reference.
 *
 * FREE-FORM'S DEFAULT IS UNCHANGED: a card with no explicit `.configure()`
 * accepts only `editor-file`, exactly as before this option existed. A future
 * Template Section editor is expected to `.configure({ acceptedAssetKinds })`
 * with its OWN kind(s) (see src/components/editor/sectionEditorExtensions.js)
 * — the node itself neither knows nor cares which surface is using it.
 *
 * This is a KIND allowlist only. It says nothing about, and never rewrites,
 * an asset's id — a long historical migrated id is refused or accepted by
 * `isSafeAssetId` exactly as it always was, upstream of this check.
 */
export const DEFAULT_FILE_ATTACHMENT_ASSET_KINDS = Object.freeze([
  ASSET_KIND_EDITOR_FILE,
]);

/**
 * Is this asset's KIND one this card is configured to open?
 *
 * `acceptedKinds` defaults to the Free-form default, so a caller that has not
 * configured anything gets EXACTLY today's behaviour. An empty or malformed
 * `acceptedKinds` (a `.configure()` call that supplied nothing usable) falls
 * back to the default too, rather than silently accepting every kind.
 */
export function isAcceptedFileAssetKind(
  kind,
  acceptedKinds = DEFAULT_FILE_ATTACHMENT_ASSET_KINDS
) {
  const list =
    Array.isArray(acceptedKinds) && acceptedKinds.length
      ? acceptedKinds
      : DEFAULT_FILE_ATTACHMENT_ASSET_KINDS;
  return list.includes(kind);
}

/* --------------------------------- limits -------------------------------- */

// The Free-form attachment limit. Deliberately its own constant: the
// Template-form File field keeps its separate 20 MB limit
// (MAX_NOTE_FILE_BYTES) and neither may drift into the other.
export const MAX_EDITOR_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

// An upper bound for a size read back OUT of stored note HTML. It only guards
// against an absurd stored value being rendered; the real limit is enforced at
// upload time above.
const MAX_STORED_SIZE = 1024 * 1024 * 1024; // 1 GB

/* ------------------------------- allowlist ------------------------------- */

// Accepted MIME type -> the extensions that MIME type may legitimately carry,
// plus the short human label shown on the card.
//
// Some pairs are deliberately many-to-one because real systems report them:
// Windows commonly reports a .csv as `application/vnd.ms-excel`, and a .csv
// picked on Linux is frequently `text/plain`. Those are consistency-check
// entries, not extra accepted formats — a `.csv` is still a CSV.
export const ALLOWED_FILE_TYPES = Object.freeze({
  "application/pdf": { extensions: [".pdf"], label: "PDF" },
  "application/msword": { extensions: [".doc"], label: "Word" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extensions: [".docx"],
    label: "Word",
  },
  "application/vnd.ms-excel": { extensions: [".xls", ".csv"], label: "Excel" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    extensions: [".xlsx"],
    label: "Excel",
  },
  "application/vnd.ms-powerpoint": { extensions: [".ppt"], label: "PowerPoint" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    extensions: [".pptx"],
    label: "PowerPoint",
  },
  "text/plain": { extensions: [".txt", ".csv"], label: "Text" },
  "text/csv": { extensions: [".csv"], label: "CSV" },
  "application/csv": { extensions: [".csv"], label: "CSV" },
});

// Extension -> the CANONICAL MIME type it is stored under. Used when the
// browser supplies an empty or generic type: the asset must not be left as
// `application/octet-stream`, because the safe-open policy reads the stored
// Blob's own type and would then be unable to offer a PDF preview for a PDF.
export const CANONICAL_MIME_BY_EXTENSION = Object.freeze({
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
});

export const ALLOWED_FILE_EXTENSIONS = Object.freeze(
  Object.keys(CANONICAL_MIME_BY_EXTENSION)
);

export const ALLOWED_FILE_MIME_TYPES = Object.freeze(
  Object.keys(ALLOWED_FILE_TYPES)
);

// Types a browser reports when it does not know what the file is. They carry no
// information, so the extension decides — and the canonical type is then stored.
export const GENERIC_MIME_TYPES = Object.freeze([
  "",
  "application/octet-stream",
  "application/download",
  "application/force-download",
  "binary/octet-stream",
  "application/unknown",
]);

// A second, self-documenting barrier. The allowlist above already excludes all
// of these; this list exists so a future edit that widens the allowlist cannot
// silently admit an executable, an installer, an archive or a scriptable
// document. Mirrors BLOCKED_INLINE_MIME_TYPES in safeAttachmentOpen.js.
export const BLOCKED_FILE_EXTENSIONS = Object.freeze([
  ".html", ".htm", ".xhtml", ".shtml", ".svg", ".xml",
  ".js", ".mjs", ".cjs", ".jsx", ".vbs", ".ps1", ".sh", ".bash", ".zsh",
  ".command", ".scpt", ".applescript",
  ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".pif", ".cpl",
  ".app", ".dmg", ".pkg", ".deb", ".rpm", ".apk", ".appimage",
  ".jar", ".class", ".war",
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz",
  ".iso", ".img", ".vhd", ".vmdk",
  ".docm", ".xlsm", ".pptm", ".dotm", ".xltm", ".potm", ".xlam", ".ppam",
  ".lnk", ".url", ".desktop", ".reg", ".dll", ".so", ".dylib",
]);

const ALLOWED_EXTENSION_SET = new Set(ALLOWED_FILE_EXTENSIONS);
const BLOCKED_EXTENSION_SET = new Set(BLOCKED_FILE_EXTENSIONS);
const GENERIC_MIME_SET = new Set(GENERIC_MIME_TYPES);

/* -------------------------------- messages ------------------------------- */

export const FILE_UNSUPPORTED_MESSAGE = "This file type is not supported.";
export const FILE_OVERSIZED_MESSAGE = "This file is larger than 25 MB.";
export const FILE_EMPTY_MESSAGE = "This file is empty or unreadable.";
export const FILE_STORAGE_MESSAGE =
  "The file could not be saved. Browser storage may be full.";
export const FILE_INSERT_MESSAGE =
  "This file could not be attached to the note. Nothing was changed.";
export const FILE_IMAGE_ROUTED_MESSAGE =
  "Images are added to the note as pictures, not as file attachments.";

// Card states.
export const FILE_ATTACHMENT_LOADING_TEXT = "Loading attached file…";
export const FILE_ATTACHMENT_UNAVAILABLE_TEXT =
  "Attached file unavailable — its stored file could not be found.";

// Export wording. The binary is never embedded, and the export must say so
// rather than imply the document travels with the file.
export const EXPORT_ATTACHMENT_NOTE = "Attached file, not included in this export.";
export const EXPORT_ATTACHMENT_UNAVAILABLE_NOTE =
  "Attached file unavailable and not included in this export.";
export const PRINT_ATTACHMENT_NOTE =
  "Attached file, not included in this printout.";
export const LEGACY_LINK_UNAVAILABLE_SUFFIX = " (attached file unavailable)";

/* ------------------------------- primitives ------------------------------ */

/** True for a transient object URL, which must never be persisted. */
export function isBlobUrl(value) {
  return typeof value === "string" && /^blob:/i.test(value.trim());
}

// Ids come from newId() — a UUID, or an `id-<hex>-<hex>` fallback. Anything
// outside that shape did not come from this application and is refused rather
// than used as an IndexedDB key.
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export function isSafeAssetId(value) {
  return typeof value === "string" && ASSET_ID_RE.test(value.trim());
}

/** An accepted MIME type, normalized ("text/plain; charset=utf-8" -> "text/plain"). */
export function isAllowedFileMimeType(mimeType) {
  return Object.prototype.hasOwnProperty.call(
    ALLOWED_FILE_TYPES,
    normalizeMimeType(mimeType)
  );
}

export function isGenericMimeType(mimeType) {
  return GENERIC_MIME_SET.has(normalizeMimeType(mimeType));
}

/** The MIME type an accepted extension must be stored under, or null. */
export function canonicalMimeForExtension(extension) {
  const ext = typeof extension === "string" ? extension.toLowerCase() : "";
  return CANONICAL_MIME_BY_EXTENSION[ext] || null;
}

/** Short human label for the card and for exports. MIME first, extension second. */
export function fileAttachmentLabel(mimeType, name) {
  const entry = ALLOWED_FILE_TYPES[normalizeMimeType(mimeType)];
  if (entry) return entry.label;
  const canonical = canonicalMimeForExtension(fileExtension(name));
  if (canonical && ALLOWED_FILE_TYPES[canonical]) {
    return ALLOWED_FILE_TYPES[canonical].label;
  }
  return "File";
}

/** "Word · 180 KB" — the one meta line shared by the card, print and exports. */
export function fileAttachmentMetaText(mimeType, name, size) {
  const label = fileAttachmentLabel(mimeType, name);
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return label;
  return `${label} · ${formatFileSize(bytes)}`;
}

/* ------------------------------- validation ------------------------------ */

/**
 * Decide whether a picked File may be attached to a Free-form note.
 *
 * @returns {{ok: true, mimeType: string, extension: string, rewrap: boolean}}
 *        | {{ok: false, error: string}}
 *
 * `mimeType` is the CANONICAL type the asset must be stored under. `rewrap` is
 * true when the browser supplied a generic type and the Blob therefore has to
 * be re-wrapped with that canonical type before it is stored — see
 * src/lib/editorFileInsert.js. The bytes are never copied, decoded or re-encoded.
 */
export function validateEditorFileAttachment(file) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: FILE_UNSUPPORTED_MESSAGE };
  }
  if (file.size === 0) return { ok: false, error: FILE_EMPTY_MESSAGE };

  const declared = normalizeMimeType(file.type);
  const extension = fileExtension(file.name);

  // Refused outright, whatever the declared type claims, and BEFORE the image
  // routing below. An SVG is an `image/*` type but it is a scriptable XML
  // document, not an ordinary image: it must be refused here rather than
  // forwarded to the image path as though a picture were intended.
  if (
    BLOCKED_EXTENSION_SET.has(extension) ||
    isDangerousInlineMimeType(declared)
  ) {
    return { ok: false, error: FILE_UNSUPPORTED_MESSAGE };
  }

  // Ordinary images have their own persistent path and must never arrive here.
  if (declared.startsWith("image/") || isImageExtension(extension)) {
    return { ok: false, error: FILE_IMAGE_ROUTED_MESSAGE };
  }

  let mimeType;
  let rewrap = false;

  if (isGenericMimeType(declared)) {
    // The browser told us nothing. The extension decides — and the canonical
    // type is what the asset is stored under, so the stored Blob is never left
    // as application/octet-stream.
    if (!ALLOWED_EXTENSION_SET.has(extension)) {
      return { ok: false, error: FILE_UNSUPPORTED_MESSAGE };
    }
    mimeType = canonicalMimeForExtension(extension);
    rewrap = true;
  } else {
    // A real declaration: it must be accepted, AND the extension must be one
    // that type may legitimately carry. A contradiction is rejected, never
    // silently corrected.
    const entry = ALLOWED_FILE_TYPES[declared];
    if (!entry) return { ok: false, error: FILE_UNSUPPORTED_MESSAGE };
    if (extension && !entry.extensions.includes(extension)) {
      return { ok: false, error: FILE_UNSUPPORTED_MESSAGE };
    }
    mimeType = declared;
  }

  if (file.size > MAX_EDITOR_FILE_BYTES) {
    return { ok: false, error: FILE_OVERSIZED_MESSAGE };
  }

  return { ok: true, mimeType, extension, rewrap };
}

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
  ".heic", ".heif", ".avif", ".ico",
]);

function isImageExtension(extension) {
  return IMAGE_EXTENSIONS.has(extension);
}

/**
 * Which persistent path a BottomBar selection belongs to.
 *
 * Extracted so the routing decision is testable on its own: a PDF selected
 * through the attachment picker becomes a Free-form file attachment and is NOT
 * imported into the global PDF workspace — that remains the dedicated
 * Note → PDF workflow's job.
 *
 * @returns {"image"|"file"}
 */
export function bottomBarRouteFor(file) {
  const declared = normalizeMimeType(file && file.type);
  return declared.startsWith("image/") ? "image" : "file";
}

/* --------------------------- reference model ----------------------------- */

function trimmedString(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v ? v : null;
}

function safeSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > MAX_STORED_SIZE) return 0;
  return Math.round(n);
}

/**
 * The exact HTML attributes an attachment node serializes to.
 *
 * This is what ends up in the note's stored HTML, so it is the single place
 * that decides what a persisted attachment may contain. Anything not produced
 * here — a Blob, base64, an object URL, availability, busy or error state —
 * cannot reach storage.
 *
 * Returns null when there is no usable asset id, so a node that lost its
 * reference is never serialized as a valid-looking one.
 */
export function fileAttachmentAttrsToHTML(attrs) {
  const source = attrs || {};
  const assetId = trimmedString(source.assetId);
  if (!isSafeAssetId(assetId)) return null;

  const name = safeDownloadFilename(source.name);
  const mimeType = normalizeMimeType(source.mimeType);
  const out = {
    class: FILE_ATTACHMENT_CLASS,
    [FILE_ATTACHMENT_ASSET_ATTR]: assetId,
    [FILE_ATTACHMENT_NAME_ATTR]: name,
    [FILE_ATTACHMENT_SIZE_ATTR]: String(safeSize(source.size)),
  };
  // Only an ACCEPTED type is carried forward. An unrecognised one is display
  // metadata we would not act on anyway, and omitting it keeps stored HTML from
  // asserting something the asset does not support.
  if (isAllowedFileMimeType(mimeType)) {
    out[FILE_ATTACHMENT_TYPE_ATTR] = mimeType;
  }
  return out;
}

/**
 * Read an attachment node's attributes back out of a parsed element.
 *
 * `element` only needs `getAttribute`, so this is testable against a plain
 * object as well as a real DOM element. Every value is validated: stored note
 * HTML is untrusted input, and a malformed id, an absurd size or an unsafe
 * filename must not survive the trip back in.
 *
 * `assetId` is null when the reference is unusable — the caller must then
 * refuse the node rather than create one that can never resolve.
 */
export function fileAttachmentAttrsFromElement(element) {
  const get = (name) =>
    element && typeof element.getAttribute === "function"
      ? element.getAttribute(name)
      : null;

  const rawId = trimmedString(get(FILE_ATTACHMENT_ASSET_ATTR));
  const assetId = isSafeAssetId(rawId) ? rawId : null;

  const rawName = trimmedString(get(FILE_ATTACHMENT_NAME_ATTR));
  const rawType = normalizeMimeType(get(FILE_ATTACHMENT_TYPE_ATTR));

  return {
    assetId,
    name: rawName ? safeDownloadFilename(rawName) : null,
    mimeType: isAllowedFileMimeType(rawType) ? rawType : null,
    size: safeSize(get(FILE_ATTACHMENT_SIZE_ATTR)),
  };
}

/**
 * Every distinct attachment assetId referenced by a stored note HTML string, in
 * first-appearance order. Available to any future reference-aware cleanup; not
 * used to decide anything at render time.
 */
export function collectFileAssetIdsFromHtml(html) {
  if (typeof html !== "string" || !html) return [];
  const re = new RegExp(
    `${FILE_ATTACHMENT_ASSET_ATTR}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    "gi"
  );
  const seen = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    const id = (match[2] !== undefined ? match[2] : match[3] || "").trim();
    if (isSafeAssetId(id) && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

/**
 * How many legacy `blob:` anchors a stored note HTML string still contains.
 *
 * Those are the remains of the previous temporary-link path. Their bytes are
 * NOT recoverable — a blob: URL dies with the document that created it — and
 * nothing here rewrites or deletes them. This exists so the situation can be
 * reported honestly rather than guessed at.
 */
export function countLegacyBlobLinks(html) {
  if (typeof html !== "string" || !html) return 0;
  const matches = html.match(/<a\s[^>]*href\s*=\s*["']blob:/gi);
  return matches ? matches.length : 0;
}
