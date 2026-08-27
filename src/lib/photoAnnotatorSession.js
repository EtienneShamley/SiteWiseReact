// src/lib/photoAnnotatorSession.js
//
// The bridge between an image NodeView and the Photo Annotator workspace.
//
// A NodeView lives inside whichever Tiptap editor holds the image — the
// Free-form note's, or a Template Section's — and neither editor should know
// that a modal workspace exists, let alone own one. So the NodeView only
// RAISES A REQUEST here; ONE host component (PhotoAnnotatorHost, mounted once
// in the document workspace) subscribes and shows the workspace for the
// current request. One request at a time: the workspace is modal, and a
// second Annotate press while it is open is ignored rather than queued.
//
// The request carries the EDITOR and the node's position so the host can
// write the result back through one editor command
// (src/lib/editorCommands.js → replaceImageAssetReference) — never through
// the NodeView, which may have re-rendered or unmounted by then.
//
// Pure module state; no DOM, no React.

let current = null;
const listeners = new Set();

function emit() {
  for (const fn of Array.from(listeners)) {
    try {
      fn(current);
    } catch {
      // A listener's failure must not break the others.
    }
  }
}

/** The open request, or null. */
export function currentPhotoAnnotationRequest() {
  return current;
}

/**
 * Raise a request. Returns false (and changes nothing) when one is already
 * open or the request is unusable.
 *
 * @param request { assetId, annotationSourceId, alt, editor, pos }
 */
export function requestPhotoAnnotation(request) {
  if (current) return false;
  if (!request || typeof request !== "object") return false;
  const assetId = typeof request.assetId === "string" ? request.assetId.trim() : "";
  if (!assetId || !request.editor) return false;
  current = {
    assetId,
    annotationSourceId:
      typeof request.annotationSourceId === "string" && request.annotationSourceId.trim()
        ? request.annotationSourceId.trim()
        : null,
    alt: typeof request.alt === "string" ? request.alt : null,
    editor: request.editor,
    pos: typeof request.pos === "number" ? request.pos : null,
  };
  emit();
  return true;
}

/** Close the open request (after Save or Cancel). */
export function closePhotoAnnotation() {
  if (!current) return;
  current = null;
  emit();
}

/** Subscribe to request changes; returns the unsubscribe function. */
export function subscribePhotoAnnotation(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop every request and listener. */
export function resetPhotoAnnotationSession() {
  current = null;
  listeners.clear();
}
