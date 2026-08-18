// src/lib/templateSectionToolbarImage.js
//
// THE TEMPLATE SECTION'S OWN IMAGE POLICY, for the shared toolbar's local-image
// picker.
//
// Since Phase G a flexible Template Section is one real document holding the
// shared `AssetImage` node, so the top toolbar's image button applies to it —
// but WHAT it may insert is the Template's decision, not the Free-form note's.
// Two things differ, and both matter:
//
//   VALIDATION   a Template photo is validated by `validatePhotoFile` (the
//                Photo-field MIME allowlist and the Template's own 20 MB source
//                limit), not by Free-form's `validateEditorImageFile` (25 MB).
//                The file here is the user's RAW pick, so it is validated in
//                full — unlike a Quick Add capture, whose bytes the capture bar
//                already validated and whose derived output must not be
//                re-measured against the source limit.
//   ASSET KIND   the bytes become a `photo` asset (`createPhotoAsset`) — the
//                same store every Template photo has always lived in, which is
//                what keeps the Template's deletion gate, its export resolvers
//                and its compatibility readers looking in one place. Inserting
//                a Free-form `editor-image` asset into a Section would put a
//                second asset kind into Template storage.
//
// Everything else is the SHARED pipeline, unchanged and not restated here:
// `insertLocalImageAsset` still validates first, normalizes (decode, cap the
// long edge, re-encode only where that helps), persists the Blob to IndexedDB,
// inserts the reference node ONLY after that write is confirmed, and deletes the
// bytes again if the insertion is refused. This module is the injected policy,
// not a second write sequence — the Template surface has exactly one image
// insertion system, the one Quick Add and the row upload control already use.
//
// Pure: a validator reference and three thin adapters. No React, no editor, no
// DOM, no storage of its own.

import {
  createPhotoAsset,
  deleteAsset,
  validatePhotoFile,
} from "./assetStorage";
import { normalizeImageFile } from "./imageProcessing";

/**
 * The dependency set `insertLocalImageAsset(args, deps)` takes for a Section.
 *
 * `insertNode` is deliberately absent so the shared default
 * (`insertImageAsset`) applies: the node, its attributes and its serialization
 * are the shared media core's, and a Section must never gain its own.
 */
export const SECTION_IMAGE_INSERT_DEPS = Object.freeze({
  validate: validatePhotoFile,
  normalize: normalizeImageFile,
  // The shared pipeline passes `{ name, metadata }`; `createPhotoAsset` takes
  // them positionally, exactly as every other Template photo write does.
  createAsset: (blob, options) =>
    createPhotoAsset(blob, options?.metadata, options?.name),
  removeAsset: deleteAsset,
});

/**
 * The complete policy the toolbar needs for ONE surface: the cheap pre-check it
 * runs before showing a busy state, and the deps the shared pipeline uses.
 *
 * The pre-check is the SAME validator the deps carry, so a file can never be
 * accepted by one and refused by the other.
 */
export const SECTION_TOOLBAR_IMAGE_POLICY = Object.freeze({
  validateFile: validatePhotoFile,
  insertDeps: SECTION_IMAGE_INSERT_DEPS,
  // Image by web address is IMPORTED into a `photo` asset through the same
  // pipeline (src/lib/editorImageUrlImport.js), never stored as a remote src:
  // a Section image must be asset-backed for the PDF/DOCX rasterizers, offline
  // reading and the deletion gate. Free-form's own policy (null) keeps its
  // historical remote-src behaviour.
  importFromUrl: true,
});
