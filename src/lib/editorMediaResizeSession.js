// src/lib/editorMediaResizeSession.js
//
// THE LIFETIME OF ONE MEDIA POINTER GESTURE — begun synchronously at
// pointerdown. Surface-agnostic: this is the shared-core generalisation of the
// pointer lifecycle proven on Template section images (see
// templateSectionItemDragSession.js, whose Template-facing copy remains in
// place until Phase G consolidation — docs/PROJECT_DECISIONS.md → "Shared
// NoteWise Editor Core").
//
// The defect this lifecycle closes was proven in a browser: listeners
// installed by a React effect exist only after React commits, and a fast human
// gesture — press, flick, release — fits entirely inside that gap, so the
// gesture was silently lost. Listeners are therefore installed HERE,
// synchronously, inside the caller's pointerdown handler, before the browser
// can deliver the next event. Nothing about the gesture depends on React
// render timing.
//
// Equally deliberate: NO setPointerCapture. Browser testing showed
// setPointerCapture can throw (NotFoundError on an unknown pointerId) and must
// never be load-bearing for a gesture starting or ending. This lifecycle needs
// only window listeners.
//
// The caller supplies two callbacks and never touches addEventListener:
//
//   onMove(event)       a pointermove belonging to this gesture
//   onEnd(commitEvent)  the gesture is over. `commitEvent` is the pointerup
//                       that completed it, or null for every abandoning exit
//                       (pointercancel, Escape, a stale gesture, manual end).
//                       The caller decides what a commit means; this module
//                       only guarantees WHICH endings may commit.
//
// Guarantees:
//
//   - installed synchronously: an event dispatched immediately after
//     beginMediaResizeSession returns is heard;
//   - the pointer may leave the source element — everything is on the window;
//   - only the pointer that started the gesture may drive or end it
//     (`pointerId` checked when both sides have one; an event with no
//     pointerId is accepted so a synthetic/legacy event cannot strand the
//     gesture with no way to end);
//   - a move with NO button held ends the gesture UNCOMMITTED: the release
//     was missed (off-window, for instance), so the last previewed value is
//     stale and must not be written;
//   - pointerup anywhere ends it WITH the event; pointercancel and Escape end
//     it with null;
//   - every listener is removed exactly once, whichever exit runs first, and
//     `onEnd` fires exactly once.
//
// Pure apart from the injected `win`: no React, no DOM types required, no
// storage, no editor — which is what makes the whole lifecycle testable
// against a fake window.

/**
 * Begin the gesture: install the window listeners NOW and return a handle.
 *
 * Returns `{ end }` — `end()` abandons the gesture from outside (component
 * unmount), tearing the listeners down and reporting `onEnd(null)`. Returns
 * null for an unusable window or missing callbacks; the caller then simply
 * has no gesture (a press with no listeners is an ordinary click).
 */
export function beginMediaResizeSession({ win, pointerId, onMove, onEnd } = {}) {
  if (
    !win ||
    typeof win.addEventListener !== "function" ||
    typeof win.removeEventListener !== "function"
  ) {
    return null;
  }
  if (typeof onMove !== "function" || typeof onEnd !== "function") return null;

  let done = false;

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
    // No button held is not a gesture. If the release was missed for any
    // reason, end uncommitted rather than tracking a pointer that is no
    // longer pressed.
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
    // Escape abandons an in-flight gesture.
    if (e.key === "Escape") end(null);
  };

  win.addEventListener("pointermove", handleMove);
  win.addEventListener("pointerup", handleUp);
  win.addEventListener("pointercancel", handleCancel);
  win.addEventListener("keydown", handleKey);

  return { end: () => end(null) };
}
