// src/lib/editorFileInsert.js
//
// The one write sequence for attaching a local FILE to a Free-form note. Every
// entry point goes through it, so none can grow its own idea of the ordering.
//
// It mirrors src/lib/editorImageInsert.js deliberately — the ordering is the
// whole point, and it must be the same ordering for images and files:
//
//   1. validate the file the user picked (type, extension consistency, 25 MB)
//   2. normalize a GENERIC MIME type to the canonical one by re-wrapping the
//      SAME bytes — never decoding, copying or re-encoding them
//   2b. PRIVACY (Production Readiness Phase 7.8): if the bytes are actually an
//      image — JPEG, PNG or WebP, decided from the BYTES and never from the
//      declared type or the filename — apply the same hidden-metadata policy
//      every Photo control applies. A Template File field accepts images, so
//      an ordinary photograph with GPS in it can arrive through this sequence,
//      and it must not reach the cloud with that metadata merely because the
//      user pressed "Attach file" rather than "Add photo". A real DOCUMENT is
//      not touched at all: a PDF, a Word file or a spreadsheet is stored
//      byte-for-byte as it came
//   3. persist the Blob to IndexedDB — a resolved write IS the confirmation
//   4. re-check that the originating note and the Free-form view are still the
//      target; the write is asynchronous and the user may have moved on
//   5. only THEN insert the reference node
//   6. if step 4 or 5 fails, the asset has no reference anywhere and is
//      provably safe to delete, so delete it rather than orphan it
//
// Nothing is inserted before the bytes are stored, so a failure at any step
// leaves the note exactly as it was and no broken attachment card is ever
// visible. Once step 5 succeeds the asset is REFERENCED by the live document: a
// later failure of ordinary note persistence must NOT delete it — the user
// still has the attachment on screen and must be able to recover — so this
// function never deletes after a successful insert.
//
// Every platform call is injectable, which is what makes the failure ordering
// testable without a browser, an editor or a real IndexedDB.

import {
  FILE_INSERT_MESSAGE,
  FILE_STORAGE_MESSAGE,
  validateEditorFileAttachment,
} from "./editorFileAttachments";
import { createEditorFileAsset, deleteAsset } from "./assetStorage";
import { insertFileAttachment } from "./editorCommands";
import { safeDownloadFilename } from "./safeAttachmentOpen";
import { normalizeImageBytesForPrivacy } from "./imageProcessing";
import { PRIVACY_NORMALIZATION_KEY } from "./imagePrivacy";

// Re-wrap the SAME bytes with the canonical MIME type. The Blob constructor
// does not read or copy the underlying data here — it references the same
// source — and nothing is base64-encoded or written into note content.
function defaultRewrapBlob(file, mimeType) {
  return new Blob([file], { type: mimeType });
}

/**
 * @param file            the File the user picked
 * @param editor          the TipTap editor the node goes into
 * @param isCurrentTarget () => boolean — true while the ORIGINATING note and the
 *                        Free-form view are still what an insertion would land
 *                        in. Checked after the asset write, never assumed.
 * @param beforeInsert    optional () => void, run immediately before step 5 so a
 *                        caller can place the caret — after the bytes are stored
 *                        AND after the identity re-check, so Quick Add validates
 *                        its captured insertion point against the document as it
 *                        is at insertion time. A throw is swallowed: failing to
 *                        move the caret must not fail an insertion whose bytes
 *                        are already persisted.
 * @returns {Promise<{ok: true, assetId, mimeType, size, name}
 *                 | {ok: false, error?: string, stale?: true}>}
 *
 * `stale: true` means the user moved to another note or view while the write
 * was in flight: the new asset has been deleted, nothing was inserted anywhere,
 * and the caller must NOT report success — nor an error that would describe a
 * note the user is no longer looking at.
 */
export async function insertFreeformFileAttachment(
  { file, editor, isCurrentTarget, beforeInsert },
  deps = {}
) {
  const {
    validate = validateEditorFileAttachment,
    rewrapBlob = defaultRewrapBlob,
    createAsset = createEditorFileAsset,
    removeAsset = deleteAsset,
    insertNode = insertFileAttachment,
    normalizeImagePrivacy = normalizeImageBytesForPrivacy,
  } = deps;

  // 1. Validate the user's own input.
  const check = validate(file);
  if (!check.ok) return { ok: false, error: check.error };

  const name = safeDownloadFilename(file && file.name);

  // 2. Generic MIME normalization. An accepted file is never stored as
  //    application/octet-stream: the safe-open policy reads the stored Blob's
  //    OWN type, so a PDF stored as octet-stream could never be previewed.
  let blobToStore = file;
  if (check.rewrap) {
    try {
      blobToStore = rewrapBlob(file, check.mimeType);
    } catch {
      return { ok: false, error: FILE_INSERT_MESSAGE };
    }
    if (!blobToStore || typeof blobToStore.size !== "number") {
      return { ok: false, error: FILE_INSERT_MESSAGE };
    }
  }

  // 2b. Privacy. Decided from the BYTES: an accepted image goes through the
  //     same inspect-and-re-encode-only-what-carries-metadata policy as a
  //     Photo, and anything else comes back exactly as it went in, unmarked.
  //     A failure here writes nothing and inserts nothing.
  let storedMimeType = check.mimeType;
  let privacyMark = null;
  // What the bytes WERE, when the privacy step converted them — `image/heic`
  // for an iPhone photograph attached through a File field.
  let convertedFrom = null;
  try {
    const prepared = await normalizeImagePrivacy(blobToStore, {
      assumeImage: false,
      fallbackMimeType: check.mimeType,
    });
    if (prepared && prepared.image) {
      blobToStore = prepared.blob;
      convertedFrom = prepared.sourceMimeType || null;
      // The type the stored Blob actually has, which is what the safe-open
      // policy will later read. A re-encode preserves the format, so this
      // normally equals the canonical type decided above.
      storedMimeType = prepared.mimeType || check.mimeType;
      privacyMark = prepared.privacy;
    }
  } catch {
    return { ok: false, error: FILE_INSERT_MESSAGE };
  }
  if (!blobToStore || typeof blobToStore.size !== "number" || blobToStore.size === 0) {
    return { ok: false, error: FILE_INSERT_MESSAGE };
  }

  // 3. Persist the bytes. Nothing enters the document until this resolves.
  let assetId;
  try {
    assetId = await createAsset(blobToStore, {
      name,
      metadata: {
        // The canonical type, recorded alongside the Blob's own type so a
        // future reader can see what was decided and why.
        canonicalMimeType: check.mimeType,
        declaredMimeType: (file && file.type) || null,
        extension: check.extension || null,
        normalizedFromGenericMimeType: !!check.rewrap,
        sourceSize: file && typeof file.size === "number" ? file.size : null,
        ...(convertedFrom ? { sourceMimeType: convertedFrom } : {}),
        // Present only when these bytes ARE an image; a document carries no
        // such claim, because the claim would not be about anything.
        ...(privacyMark ? { [PRIVACY_NORMALIZATION_KEY]: privacyMark } : {}),
      },
    });
  } catch {
    return { ok: false, error: FILE_STORAGE_MESSAGE };
  }
  if (!assetId) return { ok: false, error: FILE_STORAGE_MESSAGE };

  // 4. Identity re-check. Switching notes or views during the write must never
  //    drop the attachment into the wrong document.
  let stillTarget = true;
  try {
    stillTarget = typeof isCurrentTarget === "function" ? !!isCurrentTarget() : true;
  } catch {
    stillTarget = false;
  }
  if (!stillTarget) {
    await discard(removeAsset, assetId);
    return { ok: false, stale: true };
  }

  // 5. Insert the reference, at wherever the caller wants the caret.
  if (typeof beforeInsert === "function") {
    try {
      beforeInsert();
    } catch {
      // The bytes are stored and the identity check passed; the insertion below
      // is still correct and simply lands at the editor's current selection.
    }
  }
  let inserted;
  try {
    inserted = insertNode(editor, {
      assetId,
      name,
      mimeType: storedMimeType,
      size: blobToStore.size,
    });
  } catch {
    inserted = { ok: false, error: FILE_INSERT_MESSAGE };
  }

  if (!inserted || inserted.ok !== true) {
    // 6. Nothing references these bytes — this is the ONE case where deleting
    //    an asset is provably safe, so take it rather than leaking an orphan.
    await discard(removeAsset, assetId);
    return { ok: false, error: (inserted && inserted.error) || FILE_INSERT_MESSAGE };
  }

  return {
    ok: true,
    assetId,
    name,
    mimeType: storedMimeType,
    size: blobToStore.size,
  };
}

async function discard(removeAsset, assetId) {
  try {
    await removeAsset(assetId);
  } catch {
    // The unreferenced asset could not be cleaned up; a harmless orphan. It is
    // never reported as a user-facing failure — the user's note is unchanged.
  }
}
