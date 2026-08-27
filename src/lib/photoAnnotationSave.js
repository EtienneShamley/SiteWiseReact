// src/lib/photoAnnotationSave.js
//
// The ONE write sequence of the Photo Annotator's Save (P4), in the same
// shape as src/lib/editorImageInsert.js — persist first, reference second,
// roll back the write when the reference cannot be made:
//
//   REVERT     every annotation was removed → the note goes back to the
//              ORIGINAL asset (nothing is written; the original never left
//              storage);
//   RENDITION  1. persist the flattened rendition as a NEW editor-image asset
//                 whose metadata carries the editable layer
//                 (src/lib/photoAnnotation.js → photoAnnotationMetadata);
//              2. point the image node at it, remembering the original
//                 (src/lib/editorCommands.js → replaceImageAssetReference);
//              3. if step 2 fails, the rendition is referenced by nothing and
//                 is deleted at once rather than orphaned.
//
// The original photograph is never modified or deleted here. The previous
// rendition (when re-editing) is left in place: the editor's own undo may
// still point at it, and NoteWise has no general asset garbage collection
// for Free-form notes (the Template gate collects it with its row).
//
// Every platform call is injectable, which is what makes the ordering
// testable without a browser, an editor or a real IndexedDB.
import { createEditorImageAsset, deleteAsset } from "./assetStorage";
import { replaceImageAssetReference } from "./editorCommands";
import {
  PHOTO_NOT_IN_NOTE_MESSAGE,
  PHOTO_SAVE_ACTION,
  PHOTO_SAVE_MESSAGE,
  photoAnnotationMetadata,
} from "./photoAnnotation";

/**
 * @param request  the open session request: { assetId, pos, editor, alt }
 * @param result   what the workspace produced:
 *                 { action, items, sourceAssetId, blob, width, height, mimeType }
 * @returns {Promise<{ok: true, assetId: string|null} | {ok: false, error: string}>}
 */
export async function savePhotoAnnotation(request, result, deps = {}) {
  const {
    createAsset = createEditorImageAsset,
    removeAsset = deleteAsset,
    replaceReference = replaceImageAssetReference,
  } = deps;

  if (!request || !request.editor || !result) return { ok: false, error: PHOTO_SAVE_MESSAGE };

  if (result.action === PHOTO_SAVE_ACTION.NONE) return { ok: true, assetId: null };

  if (result.action === PHOTO_SAVE_ACTION.REVERT) {
    const applied = replaceReference(request.editor, {
      fromAssetId: request.assetId,
      pos: request.pos,
      toAssetId: result.sourceAssetId,
      annotationSourceId: null,
      width: result.width,
      height: result.height,
    });
    return applied && applied.ok
      ? { ok: true, assetId: result.sourceAssetId }
      : { ok: false, error: PHOTO_NOT_IN_NOTE_MESSAGE };
  }

  if (result.action !== PHOTO_SAVE_ACTION.RENDITION) return { ok: false, error: PHOTO_SAVE_MESSAGE };

  const layer = photoAnnotationMetadata({
    sourceAssetId: result.sourceAssetId,
    items: result.items,
    width: result.width,
    height: result.height,
  });
  if (!layer || !result.blob || typeof result.blob.size !== "number" || result.blob.size === 0) {
    return { ok: false, error: PHOTO_SAVE_MESSAGE };
  }

  // 1. Persist the rendition. Nothing in the note changes until this resolves.
  let renditionId;
  try {
    renditionId = await createAsset(result.blob, {
      name: request.alt || null,
      metadata: {
        width: result.width || null,
        height: result.height || null,
        sourceMimeType: result.mimeType || null,
        normalized: false,
        annotation: layer,
      },
    });
  } catch {
    return { ok: false, error: PHOTO_SAVE_MESSAGE };
  }
  if (!renditionId) return { ok: false, error: PHOTO_SAVE_MESSAGE };

  // 2. Reference it from exactly the image that was annotated.
  let applied;
  try {
    applied = replaceReference(request.editor, {
      fromAssetId: request.assetId,
      pos: request.pos,
      toAssetId: renditionId,
      annotationSourceId: result.sourceAssetId,
      width: result.width,
      height: result.height,
    });
  } catch {
    applied = null;
  }
  if (!applied || applied.ok !== true) {
    // 3. Referenced by nothing — the one case where deleting is provably safe.
    try {
      await removeAsset(renditionId);
    } catch {
      // The unreferenced rendition could not be cleaned up; a harmless orphan.
    }
    return { ok: false, error: PHOTO_NOT_IN_NOTE_MESSAGE };
  }

  return { ok: true, assetId: renditionId };
}
