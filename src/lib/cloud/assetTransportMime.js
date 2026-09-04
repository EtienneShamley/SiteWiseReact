// src/lib/cloud/assetTransportMime.js
//
// The CLOUD TRANSPORT content type of one locally stored asset (Production
// Readiness Phase 7.4) — the single answer to "what type is this object
// written with", derived from the record NoteWise actually stored.
//
// WHY IT EXISTS. The Storage create rule and the Firestore asset document
// both require a content type on the canonical cloud list
// (src/lib/cloud/assetCloudModel.js → CLOUD_ASSET_MIME_TYPES). Local records
// do not all carry one:
//
//   - a Template-form File field accepts a file when EITHER its MIME type or
//     its EXTENSION is allow-listed (src/lib/assetStorage.js →
//     `validateNoteFile`), so a legitimately accepted `.docx` picked on a
//     system that reported nothing is stored with `mimeType: null`;
//   - `makeAssetRecord` writes `blob.type || null`, so an empty browser type
//     becomes null rather than a guess;
//   - older records predate the Free-form attachment path, which has canonicalised
//     the stored Blob's type since it was written (src/lib/editorFileAttachments.js).
//
// Refusing every such record would leave real user files permanently
// unsyncable; inventing a type for them would let a file the product never
// accepted reach the cloud. So the rule is narrow: a type is DERIVED only
// where the existing product already decided the file was acceptable BY ITS
// EXTENSION, and only to the canonical type that extension already maps to.
//
// WHAT THIS IS NOT. It is not a widening of the accepted file policy: every
// extension consulted here is one `ALLOWED_FILE_EXTENSIONS` (Free-form) or
// `ALLOWED_NOTE_FILE_EXTENSIONS` (Template-form) already accepts, and every
// type produced is already on `CLOUD_ASSET_MIME_TYPES`. It is also not a
// security decision about CONTENT: a content type is a transport label, and
// opening or downloading an attachment still decides from the stored Blob
// itself (src/lib/safeAttachmentOpen.js), which this module does not touch.
//
// A record whose type can be neither preserved nor derived stays LOCAL and
// its queue entry becomes an explicit, actionable sync failure. It is never
// uploaded under a type nobody chose.

import { normalizeMimeType, ALLOWED_IMAGE_MIME_TYPES } from "../imageProcessing";
import { fileExtension } from "../assetStorage";
import {
  CANONICAL_MIME_BY_EXTENSION,
  GENERIC_MIME_TYPES,
  isGenericMimeType,
} from "../editorFileAttachments";
import { CLOUD_ASSET_KIND, isCloudAssetMimeType } from "./assetCloudModel";

/**
 * The image extensions the product already accepts, each mapped to the
 * canonical image type it is stored under.
 *
 * The Free-form attachment map deliberately holds no image entry — images
 * have their own path there and an image file is REFUSED by the attachment
 * validator. The Template-form File field does accept them
 * (`ALLOWED_NOTE_FILE_EXTENSIONS`), and a note-photo/editor-image/logo record
 * written from a Blob whose type the browser did not report needs the same
 * answer. Every value is on `ALLOWED_IMAGE_MIME_TYPES` and every key on
 * `ALLOWED_NOTE_FILE_EXTENSIONS`; both are asserted by the tests, so this
 * cannot drift into a wider policy.
 */
export const CLOUD_IMAGE_MIME_BY_EXTENSION = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
});

/** Why a record's transport type could not be resolved. */
export const TRANSPORT_MIME_REASON = Object.freeze({
  UNSUPPORTED: "unsupported-mime",
});

const IMAGE_KINDS = new Set([
  CLOUD_ASSET_KIND.LOGO,
  CLOUD_ASSET_KIND.NOTE_PHOTO,
  CLOUD_ASSET_KIND.EDITOR_IMAGE,
]);

const IMAGE_MIME_SET = new Set(ALLOWED_IMAGE_MIME_TYPES);

/** True for an asset kind whose bytes must be an image. */
export function isImageAssetKind(assetKind) {
  return IMAGE_KINDS.has(assetKind);
}

/**
 * The canonical type an accepted extension maps to, for CLOUD TRANSPORT.
 * Documents come from the Free-form attachment policy's own map; images from
 * the image map above. Returns null for anything else — including every
 * blocked or unknown extension, which neither map contains.
 */
export function canonicalTransportMimeForExtension(extension) {
  const ext = typeof extension === "string" ? extension.toLowerCase() : "";
  if (!ext) return null;
  return CANONICAL_MIME_BY_EXTENSION[ext] || CLOUD_IMAGE_MIME_BY_EXTENSION[ext] || null;
}

/**
 * The content type ONE asset's Storage object is written with.
 *
 * @param {{ assetKind: string, mimeType?: string|null, name?: string|null }} record
 *        the LOCAL record's own facts — never a caller's preference.
 * @returns {{ ok: true, mimeType: string, derived: boolean }}
 *        | {{ ok: false, reason: string }}
 *        `derived` is true when the extension supplied the answer, which is
 *        the case the queue entry's outcome reports as a legacy record made
 *        uploadable rather than as a stored type preserved.
 *
 * The order is deliberate:
 *   1. a PDF SOURCE is application/pdf by construction — its bytes are one
 *      immutable version of an imported PDF, validated from their CONTENT at
 *      import (src/lib/pdfImportPolicy.js), and its local record has no other
 *      type to preserve;
 *   2. a canonical stored type is PRESERVED — an image kind must resolve to
 *      an image type, so a note-photo claiming `text/csv` is refused rather
 *      than uploaded as one;
 *   3. an EMPTY or GENERIC stored type lets the extension decide, exactly as
 *      the product decided when it accepted the file;
 *   4. anything else — a real declaration that is not on the cloud list — is
 *      REFUSED. A contradiction is never silently corrected by the filename.
 */
export function resolveCloudTransportMime({ assetKind, mimeType, name } = {}) {
  if (assetKind === CLOUD_ASSET_KIND.PDF_SOURCE) {
    return { ok: true, mimeType: "application/pdf", derived: false };
  }

  const declared = normalizeMimeType(mimeType);
  const imageKind = isImageAssetKind(assetKind);

  if (declared && !isGenericMimeType(declared)) {
    if (!isCloudAssetMimeType(declared)) return { ok: false, reason: TRANSPORT_MIME_REASON.UNSUPPORTED };
    if (imageKind && !IMAGE_MIME_SET.has(declared)) {
      return { ok: false, reason: TRANSPORT_MIME_REASON.UNSUPPORTED };
    }
    return { ok: true, mimeType: declared, derived: false };
  }

  // No usable declaration: the extension the product already accepted decides.
  const derived = canonicalTransportMimeForExtension(fileExtension(name));
  if (!derived) return { ok: false, reason: TRANSPORT_MIME_REASON.UNSUPPORTED };
  if (imageKind && !IMAGE_MIME_SET.has(derived)) {
    return { ok: false, reason: TRANSPORT_MIME_REASON.UNSUPPORTED };
  }
  // A derived type must still be on the canonical cloud list — the one list
  // the rules enumerate. Both source maps are subsets of it today; this keeps
  // that true if either is ever extended.
  if (!isCloudAssetMimeType(derived)) return { ok: false, reason: TRANSPORT_MIME_REASON.UNSUPPORTED };
  return { ok: true, mimeType: derived, derived: true };
}

/** The generic types this module treats as "the browser told us nothing". */
export const TRANSPORT_GENERIC_MIME_TYPES = GENERIC_MIME_TYPES;
