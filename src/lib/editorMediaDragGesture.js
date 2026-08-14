// src/lib/editorMediaDragGesture.js
//
// ONE BODY-DRAG GESTURE of a shared-core media node, from pointerdown to its
// single possible drop.
//
// The pointer lifecycle already exists and is proven (editorMediaResizeSession
// — synchronous installation, pointer ownership, buttons===0 stale-gesture
// guard, which endings may commit, exactly-once teardown); this module is the
// BODY-DRAG policy on top of it, exactly as editorMediaResizeGesture is the
// corner-resize policy on the same session:
//
//   - a press is not a drag. The gesture starts PENDING and ARMS only once
//     the pointer travels past the proven ~4px threshold, so an ordinary
//     click on the image body keeps its ordinary meaning (select) and a
//     press-and-release moves nothing;
//   - `onArm` fires at most once, at the crossing — it is where the caller
//     creates the ghost, activates the insertion indicator, and arms the
//     trailing-click suppression;
//   - after arming, every move reaches `onDragMove` — ghost position and
//     candidate destination are the caller's business; nothing here may touch
//     a document;
//   - `onDrop` fires AT MOST ONCE, only for a pointerup ending of an ARMED
//     gesture with usable coordinates. Every abandoning ending (pointercancel,
//     Escape, a stale buttons===0 move, manual end/unmount) — and every
//     never-armed ending — drops nothing;
//   - `onSettle({ armed })` fires exactly once, after any drop, whichever way
//     the gesture ended — the one place the caller tears its presentation
//     down, so no exit path can leave a ghost or an indicator behind.
//
// The threshold rule and the trailing-click suppression were built and proven
// on Template section images; they are re-exported here under media-core
// names, WRAPPING — not copying — their proven implementations
// (src/lib/templateSectionImageMove.js, templateSectionItemDragSession.js),
// exactly as editorMediaResize.js wraps the resize arithmetic. Consolidating
// their home is Phase G of the shared-core plan.
//
// Pure apart from the injected `win`: no React, no editor, no storage.

import { beginMediaResizeSession } from "./editorMediaResizeSession";
import {
  IMAGE_MOVE_THRESHOLD_PX,
  exceedsMoveThreshold,
} from "./templateSectionImageMove";
import { suppressGestureTrailingClick } from "./templateSectionItemDragSession";

/** How far the pointer must travel before a press becomes a drag. */
export const MEDIA_BODY_DRAG_THRESHOLD_PX = IMAGE_MOVE_THRESHOLD_PX;

/** Has this pointer travelled far enough to arm? The proven straight-line rule. */
export const mediaDragExceedsThreshold = exceedsMoveThreshold;

/**
 * Consume the CLICK the browser generates after a completed drag — armed by
 * the gesture owner ONLY for a drag that genuinely crossed the threshold, so
 * a short click never loses its ordinary behaviour. The very next click is
 * swallowed in the capture phase; a new pointerdown arriving first disarms it
 * untriggered. Returns a cancel function for the caller's unmount path.
 */
export const suppressMediaGestureTrailingClick = suppressGestureTrailingClick;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Begin one body-drag gesture. Call synchronously inside pointerdown — the
 * session installs its window listeners before the browser can deliver the
 * next event, so a fast press-flick-release can never outrun a React commit.
 *
 * @param win          the window to listen on
 * @param pointerId    the pointer that owns this gesture
 * @param startX       the pointer x at pointerdown
 * @param startY       the pointer y at pointerdown
 * @param thresholdPx  optional override of the arming distance
 * @param onArm        () => void — at most once, at the threshold crossing
 * @param onDragMove   (event) => void — every move of an ARMED gesture
 * @param onDrop       (event) => void — at most once, armed pointerup only
 * @param onSettle     ({ armed }) => void — exactly once, after every ending
 *
 * Returns `{ end, isArmed }` (`end()` abandons, e.g. on unmount) or null when
 * the inputs cannot describe a drag — the caller then simply has no gesture,
 * and the press stays an ordinary click.
 */
export function beginMediaBodyDragGesture({
  win,
  pointerId,
  startX,
  startY,
  thresholdPx,
  onArm,
  onDragMove,
  onDrop,
  onSettle,
} = {}) {
  if (!finite(startX) || !finite(startY)) return null;
  if (typeof onDrop !== "function") return null;

  let armed = false;

  const session = beginMediaResizeSession({
    win,
    pointerId,
    onMove: (event) => {
      if (!armed) {
        if (
          !mediaDragExceedsThreshold({
            startX,
            startY,
            clientX: event.clientX,
            clientY: event.clientY,
            thresholdPx,
          })
        ) {
          // Still a click. Nothing arms, nothing draws, releasing here does
          // nothing at all.
          return;
        }
        armed = true;
        if (typeof onArm === "function") onArm();
      }
      if (typeof onDragMove === "function") onDragMove(event);
    },
    onEnd: (commitEvent) => {
      // Only an ARMED gesture completed by a pointerup with usable
      // coordinates may drop; every other ending falls straight through to
      // settle with nothing committed.
      if (
        armed &&
        commitEvent &&
        finite(commitEvent.clientX) &&
        finite(commitEvent.clientY)
      ) {
        onDrop(commitEvent);
      }
      if (typeof onSettle === "function") onSettle({ armed });
    },
  });
  if (!session) return null;

  return { end: session.end, isArmed: () => armed };
}
