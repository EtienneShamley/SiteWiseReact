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
// on Template section images. Until Phase G they were re-exported here wrapping
// the legacy `templateSectionImageMove.js` / `templateSectionItemDragSession.js`;
// Phase G retired that interaction and both now live HERE, unchanged in
// behaviour — exactly as editorMediaResize.js now owns the resize arithmetic.
//
// Pure apart from the injected `win`: no React, no editor, no storage.

import { beginMediaResizeSession } from "./editorMediaResizeSession";

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Small enough that a deliberate drag feels immediate, large enough that the
 * incidental travel of a click never arms one.
 */
export const MEDIA_BODY_DRAG_THRESHOLD_PX = 4;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Has this pointer travelled far enough to arm? The proven straight-line rule:
 * travel in any direction counts the same, and EXACTLY at the threshold is
 * still a click — a drag must be unambiguously intended.
 */
export function mediaDragExceedsThreshold({
  startX,
  startY,
  clientX,
  clientY,
  thresholdPx = MEDIA_BODY_DRAG_THRESHOLD_PX,
} = {}) {
  if (!finite(startX) || !finite(startY)) return false;
  if (!finite(clientX) || !finite(clientY)) return false;
  const limit =
    finite(thresholdPx) && thresholdPx >= 0 ? thresholdPx : MEDIA_BODY_DRAG_THRESHOLD_PX;
  return Math.hypot(clientX - startX, clientY - startY) > limit;
}

/**
 * Consume the CLICK the browser generates after a completed drag.
 *
 * A drag is pointerdown → pointermove → pointerup — and after that pointerup
 * the browser still dispatches an ordinary `click`. For a drag that actually
 * moved the image, that trailing click is not something the user asked for:
 * left alone it would reach the image's own click behaviour (selection) the
 * instant the drop landed.
 *
 * Armed by the gesture owner ONLY when the drag genuinely crossed the movement
 * threshold — a short click never comes through here and keeps its ordinary
 * behaviour. Consumption is deterministic, with no timers:
 *
 *   - the very next `click` (capture phase, so it is swallowed before any
 *     target handler) is prevented, stopped, and the suppression disarms;
 *   - a new `pointerdown` arriving FIRST proves the drag's own click is never
 *     coming (the release happened off-window, or the gesture was cancelled
 *     and released without one) — the suppression disarms untriggered, so the
 *     click that press produces behaves completely normally.
 *
 * Returns a `cancel` function for the caller's unmount path; calling it after
 * the suppression has already resolved is a no-op.
 */
export function suppressMediaGestureTrailingClick({ win } = {}) {
  if (
    !win ||
    typeof win.addEventListener !== "function" ||
    typeof win.removeEventListener !== "function"
  ) {
    return () => {};
  }

  let done = false;
  const disarm = () => {
    if (done) return;
    done = true;
    win.removeEventListener("click", handleClick, true);
    win.removeEventListener("pointerdown", handleDown, true);
  };
  const handleClick = (e) => {
    if (typeof e.preventDefault === "function") e.preventDefault();
    if (typeof e.stopPropagation === "function") e.stopPropagation();
    disarm();
  };
  const handleDown = () => disarm();

  win.addEventListener("click", handleClick, true);
  win.addEventListener("pointerdown", handleDown, true);

  return disarm;
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
