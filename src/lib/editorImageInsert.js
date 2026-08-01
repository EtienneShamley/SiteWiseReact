// src/lib/editorImageInsert.js
//
// The one write sequence for putting a local image into a Free-form note. Both
// entry points — the toolbar's file picker and the BottomBar's photo/camera
// insert — go through it, so neither can grow its own idea of the ordering.
//
// The ordering is the whole point:
//
//   1. validate the SOURCE file the user actually picked (type + 20 MB), before
//      anything expensive happens
//   2. normalize it (decode, cap the long edge, re-encode only when that helps)
//   3. persist the Blob to IndexedDB — a resolved write IS the confirmation
//   4. only THEN insert the reference node into the document
//   5. if step 4 fails, the asset has no reference anywhere and is provably
//      safe to delete, so delete it immediately rather than orphan it
//
// Nothing is inserted before the bytes are stored, so a failure at any step
// leaves the note exactly as it was and no half-image is ever visible. Once
// step 4 succeeds the asset is REFERENCED by the live document: a later failure
// of ordinary note persistence must not delete it — the user still has the
// image on screen and must be able to recover — so this function never deletes
// after a successful insert.
//
// Every platform call is injectable, which is what makes the failure ordering
// testable without a browser, an editor or a real IndexedDB.

import { validateEditorImageFile } from "./editorImages";
import { normalizeImageFile, IMAGE_STORAGE_MESSAGE } from "./imageProcessing";
import { createEditorImageAsset, deleteAsset } from "./assetStorage";
import { insertImageAsset } from "./editorCommands";
import { EDITOR_IMAGE_INSERT_MESSAGE } from "./editorImageAssets";

/**
 * @param sourceFile  the File the user picked — always what is validated
 * @param blob        the bytes to normalize and store; defaults to sourceFile.
 *                    The BottomBar passes its stamped canvas output here, which
 *                    is derived from an ALREADY-validated source and so is not
 *                    re-measured against the input size limit.
 * @param editor      the TipTap editor the node goes into
 * @param name        display/alt name (defaults to the source filename)
 * @returns {Promise<{ok: true, assetId, width, height, mimeType}
 *                  | {ok: false, error: string}>}
 */
export async function insertLocalImageAsset(
  { sourceFile, blob, editor, name },
  deps = {}
) {
  const {
    validate = validateEditorImageFile,
    normalize = normalizeImageFile,
    createAsset = createEditorImageAsset,
    removeAsset = deleteAsset,
    insertNode = insertImageAsset,
  } = deps;

  // 1. The user's own input is what gets validated, never the derived blob.
  const check = validate(sourceFile);
  if (!check.ok) return { ok: false, error: check.error };

  const displayName =
    (typeof name === "string" && name.trim()) ||
    (sourceFile && typeof sourceFile.name === "string" && sourceFile.name.trim()) ||
    null;

  // 2. Normalize. A decode or encode failure aborts before any write.
  let normalized;
  try {
    normalized = await normalize(blob || sourceFile, {
      // A stamped capture is re-encoded back into the source photo's format
      // rather than the canvas's PNG default.
      preferredMimeType: check.mimeType,
    });
  } catch (err) {
    return { ok: false, error: (err && err.message) || EDITOR_IMAGE_INSERT_MESSAGE };
  }
  if (!normalized || !normalized.blob) {
    return { ok: false, error: EDITOR_IMAGE_INSERT_MESSAGE };
  }

  // 3. Persist the bytes. Nothing enters the document until this resolves.
  let assetId;
  try {
    assetId = await createAsset(normalized.blob, {
      name: displayName,
      metadata: {
        width: normalized.width || null,
        height: normalized.height || null,
        sourceMimeType: check.mimeType,
        sourceSize:
          sourceFile && typeof sourceFile.size === "number" ? sourceFile.size : null,
        normalized: !!normalized.processed,
      },
    });
  } catch {
    return { ok: false, error: IMAGE_STORAGE_MESSAGE };
  }
  if (!assetId) return { ok: false, error: IMAGE_STORAGE_MESSAGE };

  // 4. Insert the reference.
  let inserted;
  try {
    inserted = insertNode(editor, {
      assetId,
      alt: displayName,
      width: normalized.width,
      height: normalized.height,
    });
  } catch (err) {
    inserted = { ok: false, error: (err && err.message) || EDITOR_IMAGE_INSERT_MESSAGE };
  }

  if (!inserted || inserted.ok !== true) {
    // 5. Nothing references these bytes — this is the ONE case where deleting
    //    an asset is provably safe, so take it rather than leaking an orphan.
    try {
      await removeAsset(assetId);
    } catch {
      // The unreferenced asset could not be cleaned up; a harmless orphan.
    }
    return {
      ok: false,
      error: (inserted && inserted.error) || EDITOR_IMAGE_INSERT_MESSAGE,
    };
  }

  return {
    ok: true,
    assetId,
    width: normalized.width,
    height: normalized.height,
    mimeType: normalized.mimeType,
  };
}
