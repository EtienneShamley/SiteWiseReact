// src/components/editor/PhotoAnnotatorHost.js
//
// The ONE place the Photo Annotator workspace is mounted (P4). It subscribes
// to the request bridge (src/lib/photoAnnotatorSession.js) — raised by the
// shared image NodeView on whichever editor surface holds the image — shows
// the workspace for the open request, and performs the write on Save
// (src/lib/photoAnnotationSave.js): persist the rendition, then point the
// image node at it through one editor command. Cancel persists nothing.
import React, { useCallback, useEffect, useState } from "react";
import PhotoAnnotatorDialog from "./PhotoAnnotatorDialog";
import {
  closePhotoAnnotation,
  currentPhotoAnnotationRequest,
  subscribePhotoAnnotation,
} from "../../lib/photoAnnotatorSession";
import { savePhotoAnnotation } from "../../lib/photoAnnotationSave";

export default function PhotoAnnotatorHost({ saveDeps, dialogDeps }) {
  const [request, setRequest] = useState(() => currentPhotoAnnotationRequest());

  useEffect(() => subscribePhotoAnnotation(setRequest), []);

  const onCancel = useCallback(() => closePhotoAnnotation(), []);

  const onSave = useCallback(
    async (result) => {
      const req = currentPhotoAnnotationRequest();
      if (!req) return { ok: false, error: "The photo is no longer open." };
      const outcome = await savePhotoAnnotation(req, result, saveDeps);
      if (outcome.ok) closePhotoAnnotation();
      return outcome;
    },
    [saveDeps]
  );

  if (!request) return null;
  return (
    <PhotoAnnotatorDialog
      key={`${request.assetId}:${request.pos ?? ""}`}
      request={request}
      onCancel={onCancel}
      onSave={onSave}
      deps={dialogDeps}
    />
  );
}
