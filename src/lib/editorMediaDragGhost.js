// src/lib/editorMediaDragGhost.js
//
// THE FLOATING PREVIEW of a media body drag — the image "in the user's hand".
//
// Presentation only, by construction: the ghost is a detached element on
// `document.body`, it is `pointer-events: none` (so it can never sit between
// the pointer and the document being aimed at, and never disturbs
// posAtCoords hit-testing), it is positioned imperatively per pointer move
// (one style write, never a React render), and nothing about it is ever
// persisted. The original node keeps its place in the document while the
// ghost is shown, so the layout underneath never moves.
//
// Geometry comes from the shared rule (mediaDragGhostGeometry): scaled down
// proportionally past the size cap, aspect ratio preserved by construction,
// the grabbed point of the image staying under the pointer.
//
// The load-bearing styles (fixed positioning, pointer transparency, size) are
// set INLINE because the element lives outside the editor's DOM; the
// stylesheet class carries only cosmetics (translucency, shadow) and the
// print rule that keeps a mid-drag print from showing a ghost.
//
// No React, no editor, no storage. The document is injected, so the whole
// lifecycle is testable against jsdom.

import { MEDIA_DRAG_GHOST_MAX_PX, mediaDragGhostGeometry } from "./editorMediaDrag";

export const MEDIA_DRAG_GHOST_CLASS = "nw-media-drag-ghost";

/**
 * Create the ghost for one drag and attach it to the document body, hidden
 * until the first `moveTo` places it.
 *
 * @param doc    the Document to create in
 * @param src    the image URL the source <img> is currently showing
 * @param rect   the source image's bounding rect at arm time ({left, top, width, height})
 * @param grabX  the pointer x at pointerdown — the held point of the image
 * @param grabY  the pointer y at pointerdown
 * @param maxPx  optional size-cap override
 *
 * Returns `{ el, moveTo(clientX, clientY), destroy() }`, or null when the
 * inputs cannot describe a preview — a drag with no ghost is still a working
 * drag, so the caller simply shows none.
 */
export function createMediaDragGhost({
  doc,
  src,
  rect,
  grabX,
  grabY,
  maxPx = MEDIA_DRAG_GHOST_MAX_PX,
} = {}) {
  if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;
  if (typeof src !== "string" || !src) return null;

  // One probe proves the geometry is usable before any DOM exists; the scaled
  // size is fixed for the whole gesture (the rect cannot change mid-drag).
  const probe = mediaDragGhostGeometry({ rect, grabX, grabY, clientX: 0, clientY: 0, maxPx });
  if (!probe) return null;

  const el = doc.createElement("div");
  el.className = MEDIA_DRAG_GHOST_CLASS;
  el.setAttribute("aria-hidden", "true");
  el.style.position = "fixed";
  el.style.left = "0px";
  el.style.top = "0px";
  el.style.width = `${probe.width}px`;
  el.style.height = `${probe.height}px`;
  el.style.pointerEvents = "none";
  el.style.zIndex = "9999";
  // Hidden until the pointer has actually moved somewhere to follow.
  el.style.visibility = "hidden";

  const img = doc.createElement("img");
  img.src = src;
  img.alt = "";
  img.draggable = false;
  img.style.display = "block";
  img.style.width = "100%";
  img.style.height = "100%";
  el.appendChild(img);

  doc.body.appendChild(el);

  let destroyed = false;
  return {
    el,
    moveTo(clientX, clientY) {
      if (destroyed) return;
      const g = mediaDragGhostGeometry({ rect, grabX, grabY, clientX, clientY, maxPx });
      if (!g) return;
      el.style.left = `${g.left}px`;
      el.style.top = `${g.top}px`;
      el.style.visibility = "visible";
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
