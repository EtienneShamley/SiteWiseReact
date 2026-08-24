// src/lib/templateSectionToolbarFile.js
//
// THE TEMPLATE SECTION'S OWN FILE POLICY, for the shared toolbar's Attach file
// control (Template Editor A4, 2026-08-22).
//
// The sibling of src/lib/templateSectionToolbarImage.js, for exactly the same
// reason and in exactly the same shape: a flexible Template Section is one real
// document holding the shared `FileAttachment` node, so the top toolbar's
// Attach file button applies to it — but WHAT it may attach, and which asset
// kind the bytes become, is the Template's decision rather than the Free-form
// note's.
//
//   VALIDATION   a Template file is validated by `validateNoteFile` (the
//                Template's own extension allowlist and its 20 MB limit), not by
//                Free-form's `validateEditorFileAttachment` (25 MB).
//   ASSET KIND   the bytes become a `note-file` asset (`createNoteFileAsset`) —
//                the same store every Template attachment has always lived in,
//                which is what keeps the Template's deletion gate, its export
//                resolvers and its compatibility readers looking in one place.
//
// Everything else is the SHARED pipeline, unchanged and not restated here:
// `insertFreeformFileAttachment` still validates first, normalizes a generic
// MIME type by re-wrapping the SAME bytes, persists the Blob to IndexedDB,
// re-checks the target, inserts the reference node ONLY after that write is
// confirmed, and deletes the bytes again if the insertion is refused. This
// module is the injected policy, not a second write sequence — the Template
// surface has exactly one file insertion system, the one Quick Add already uses.
//
// Pure: a validator and two thin adapters. No React, no editor, no DOM, and no
// storage of its own.

import {
  ALLOWED_NOTE_FILE_EXTENSIONS,
  createNoteFileAsset,
  deleteAsset,
  validateNoteFile,
} from "./assetStorage";

/**
 * The Template Section's file validator.
 *
 * `validateNoteFile` answers "may this file be stored at all"; the shared
 * insertion pipeline additionally expects the validator to NAME the type it
 * accepted, so the file's declared type is passed through here.
 *
 * That type is DISPLAY metadata only, and stays so: `insertFileAttachment`
 * filters it through the shared allowlist before writing it, and the retrieved
 * Blob's own type remains the sole authority for whether a card may open
 * anything (src/lib/safeAttachmentOpen.js).
 */
export function validateSectionFile(file) {
  const check = validateNoteFile(file);
  if (!check.ok) return check;
  return { ...check, mimeType: (file && file.type) || null };
}

/**
 * The dependency set `insertFreeformFileAttachment(args, deps)` takes for a
 * Section.
 *
 * `insertNode` is deliberately absent so the shared default
 * (`insertFileAttachment`) applies: the node, its attributes and its
 * serialization are the shared media core's, and a Section must never gain its
 * own.
 */
export const SECTION_FILE_INSERT_DEPS = Object.freeze({
  validate: validateSectionFile,
  createAsset: (blob, options) => createNoteFileAsset(blob, options?.metadata),
  removeAsset: deleteAsset,
});

/** What the toolbar's Attach file picker offers a Template Section. */
export const SECTION_FILE_ACCEPT = ALLOWED_NOTE_FILE_EXTENSIONS.join(",");

export const SECTION_TOOLBAR_FILE_POLICY = Object.freeze({
  validateFile: validateSectionFile,
  insertDeps: SECTION_FILE_INSERT_DEPS,
  accept: SECTION_FILE_ACCEPT,
});
