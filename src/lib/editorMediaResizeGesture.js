// src/lib/editorMediaResizeGesture.js
//
// ONE CORNER-RESIZE GESTURE of a shared-core media node, from pointerdown to
// its single possible commit.
//
// The two halves already exist and are proven separately: the arithmetic
// (editorMediaResize.js — which corner grows which way, the 15–100 clamp, the
// whole-point change rule) and the pointer lifecycle (editorMediaResizeSession
// — synchronous installation, pointer ownership, which endings may commit).
// This module is the policy that joins them, so the rules a NodeView must not
// get wrong are stated — and testable — WITHOUT a DOM or a React render:
//
//   - pointer movement only ever previews (`onPreview`); nothing else runs
//     during the gesture, so no transaction can exist before release;
//   - `onCommit` fires AT MOST ONCE, only for a pointerup ending, and only
//     when the released width differs from the starting width by a whole
//     point — a gesture that ends where it started commits nothing;
//   - every abandoning ending (pointercancel, Escape, a stale buttons===0
//     move, manual end/unmount) commits nothing;
//   - `onSettle` fires exactly once, after any commit, whichever way the
//     gesture ended — it is where the caller clears its preview state, so no
//     exit path can leave a stale preview behind.
//
// The geometry of the whole gesture is captured HERE, at begin time, and never
// re-derived from the box being resized — the preview can therefore never
// become its own next basis (the feedback loop the Template gesture had to
// unlearn).
//
// Pure apart from the injected `win`: no React, no editor, no storage.

import {
  isMediaResizeCorner,
  mediaWidthPctChanged,
  mediaWidthPctFromPointer,
} from "./editorMediaResize";
import { beginMediaResizeSession } from "./editorMediaResizeSession";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Begin one corner-resize gesture. Call synchronously inside pointerdown.
 *
 * @param win            the window to listen on
 * @param corner         one of MEDIA_RESIZE_CORNERS
 * @param pointerId      the pointer that owns this gesture
 * @param startX         the pointer x at pointerdown
 * @param startWidthPct  the PERSISTED width when the press landed
 * @param containerWidth the content-box width `widthPct` is a percentage of
 * @param onPreview      (pct) => void — live visual feedback only
 * @param onCommit       (pct) => void — at most once, pointerup + real change
 * @param onSettle       () => void — exactly once, after every ending
 *
 * Returns `{ end }` (end() abandons, e.g. on unmount) or null when the inputs
 * cannot describe a resize — the caller then simply has no gesture.
 */
export function beginMediaResizeGesture({
  win,
  corner,
  pointerId,
  startX,
  startWidthPct,
  containerWidth,
  onPreview,
  onCommit,
  onSettle,
} = {}) {
  if (!isMediaResizeCorner(corner)) return null;
  if (!finite(startX) || !finite(startWidthPct)) return null;
  if (!finite(containerWidth) || containerWidth <= 0) return null;
  if (typeof onCommit !== "function") return null;

  const pctAt = (clientX) =>
    mediaWidthPctFromPointer({
      corner,
      startWidthPct,
      startX,
      clientX,
      containerWidth,
    });

  return beginMediaResizeSession({
    win,
    pointerId,
    onMove: (event) => {
      const pct = pctAt(event.clientX);
      if (pct !== null && typeof onPreview === "function") onPreview(pct);
    },
    onEnd: (commitEvent) => {
      // Commit only a pointerup ending whose width is a real change; every
      // other ending — cancel, Escape, stale gesture, manual end — falls
      // straight through to settle with nothing written.
      if (commitEvent && finite(commitEvent.clientX)) {
        const pct = pctAt(commitEvent.clientX);
        if (pct !== null && mediaWidthPctChanged(pct, startWidthPct)) {
          onCommit(Math.round(pct));
        }
      }
      if (typeof onSettle === "function") onSettle();
    },
  });
}
