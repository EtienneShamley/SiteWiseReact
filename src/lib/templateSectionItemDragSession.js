// src/lib/templateSectionItemDragSession.js
//
// THE LIFETIME OF ONE IMAGE-MOVE GESTURE — begun synchronously at pointerdown.
//
// A browser session proved the defect this module closes: the move/up/cancel
// listeners for a section-image drag used to be installed by a React effect
// gated on the gesture state, so they existed only after React had committed
// that state. A fast human gesture — press, flick, release — fits entirely
// inside that gap. Its moves and its release were dispatched to a window with
// no listeners, the gesture never armed, and the drag did nothing.
//
// So the listeners are installed HERE, synchronously, inside the pointerdown
// handler itself, before the browser can deliver the next event. The gesture
// no longer depends on React rendering quickly enough. This is the same
// principle the corner-resize fix adopted (see the gesture contract in
// PhotoAttachment.js), taken one step further: not only do the listeners live
// on the window for exactly the gesture's lifetime — they exist from the very
// first instant of it.
//
// ONE listener system. The caller supplies two callbacks and never touches
// addEventListener itself:
//
//   onMove(event)       a pointermove that belongs to this gesture
//   onEnd(commitEvent)  the gesture is over. `commitEvent` is the pointerup
//                       that completed it, or null for every abandoning exit
//                       (pointercancel, Escape, a stale gesture, manual end).
//                       The caller decides what a commit means; this module
//                       only guarantees WHICH endings may commit.
//
// Guarantees, each one a regression a manual test actually hit:
//
//   - installed synchronously: an event dispatched immediately after
//     beginItemDragGesture returns is heard;
//   - the pointer may leave the source image — everything is on the window;
//   - only the pointer that started the gesture may drive or end it
//     (`pointerId` checked when both sides have one);
//   - a move with NO button held ends the gesture, uncommitted: the release
//     was missed (off-window, for instance), so the last resolved drop is
//     stale and must not be written;
//   - pointerup anywhere ends it with the event, pointercancel and Escape end
//     it with null;
//   - every listener is removed exactly once, whichever exit runs first, and
//     `onEnd` fires exactly once.
//
// Pure apart from the injected `win`: no React, no storage, no component
// state — which is what makes the whole lifecycle testable with a fake window.

/**
 * Begin the gesture: install the window listeners NOW and return a handle.
 *
 * Returns `{ end }` — `end()` abandons the gesture from outside (component
 * unmount), tearing the listeners down and reporting `onEnd(null)`. Returns
 * null for an unusable window or missing callbacks, and a caller then simply
 * has no gesture (a press with no listeners is an ordinary click).
 */
export function beginItemDragGesture({ win, pointerId, onMove, onEnd } = {}) {
  if (
    !win ||
    typeof win.addEventListener !== "function" ||
    typeof win.removeEventListener !== "function"
  ) {
    return null;
  }
  if (typeof onMove !== "function" || typeof onEnd !== "function") return null;

  let done = false;

  // Only the pointer that started the gesture may drive it. An event with no
  // pointerId (a synthetic or legacy event) is accepted rather than dropped —
  // refusing it would strand the gesture with no way to end.
  const isThisPointer = (e) =>
    e.pointerId === undefined || pointerId === undefined || e.pointerId === pointerId;

  const end = (commitEvent) => {
    if (done) return;
    done = true;
    win.removeEventListener("pointermove", handleMove);
    win.removeEventListener("pointerup", handleUp);
    win.removeEventListener("pointercancel", handleCancel);
    win.removeEventListener("keydown", handleKey);
    onEnd(commitEvent || null);
  };

  const handleMove = (e) => {
    if (!isThisPointer(e)) return;
    // No button held is not a drag. If the release was missed for any reason,
    // this ends the gesture — uncommitted, because the pointer has moved since
    // the release actually happened — rather than tracking a pointer that is
    // no longer pressed.
    if (e.buttons === 0) {
      end(null);
      return;
    }
    onMove(e);
  };
  const handleUp = (e) => {
    if (!isThisPointer(e)) return;
    end(e);
  };
  const handleCancel = (e) => {
    if (!isThisPointer(e)) return;
    end(null);
  };
  const handleKey = (e) => {
    // Escape abandons an in-flight move, exactly as it abandons a resize.
    if (e.key === "Escape") end(null);
  };

  win.addEventListener("pointermove", handleMove);
  win.addEventListener("pointerup", handleUp);
  win.addEventListener("pointercancel", handleCancel);
  win.addEventListener("keydown", handleKey);

  return { end: () => end(null) };
}

/**
 * Consume the CLICK the browser generates after a completed drag.
 *
 * A drag is pointerdown → pointermove → pointerup — and after that pointerup
 * the browser still dispatches an ordinary `click`. For a drag that actually
 * moved the image, that trailing click is not something the user asked for:
 * left alone it reached the image's own click behaviour and popped the photo
 * controls the instant the drop landed.
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
export function suppressGestureTrailingClick({ win } = {}) {
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
