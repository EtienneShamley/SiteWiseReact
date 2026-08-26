// src/lib/noteDrag.js
//
// DRAGGING A NOTE TO A FOLDER — the pure rules of the pointer interaction
// (Phase B2). The ownership change itself is src/lib/noteMove.js; this module
// owns only what the drag needs to decide before that operation runs:
//
//   - how a note drag is recognised on a drop target (the data-transfer type),
//   - when hovering a collapsed project during a drag may reveal its folders,
//     and how that reveal cannot flap.
//
// WHY NATIVE HTML5 DRAG AND DROP. The Notes pane (source) and the sidebar tree
// (targets) are sibling panes with independent scroll regions. The browser's
// own drag session gives a drag ghost, edge auto-scroll of scrollable
// ancestors, Escape-to-cancel and pointer capture across those panes for
// free, with no custom hit-testing — and touch pointers keep the keyboard
// "Move to…" path (the SAME move operation) rather than a second gesture
// system. The drag carries only the note id; nothing about the note's content
// travels through the data transfer.
//
// Pure: no React, no DOM, no timers — the timer lives in the component.

/** The one data-transfer type a note drag carries. Custom, so a file, a URL or a text drag can never be mistaken for a note. */
export const NOTE_DRAG_TYPE = "application/x-notewise-note";

/**
 * How long the pointer must rest over a COLLAPSED project before its folders
 * are revealed. Long enough that passing over a project on the way to a
 * folder below it reveals nothing; short enough not to read as stuck.
 */
export const PROJECT_HOVER_REVEAL_MS = 600;

function types(dataTransfer) {
  const list = dataTransfer && dataTransfer.types;
  if (!list) return [];
  // DOMStringList in older engines has no `includes`; an array copy is safe.
  return Array.from(list);
}

/** True when the drag in flight is a NoteWise note (checked from `types` — the data itself is unreadable during dragover). */
export function isNoteDragTransfer(dataTransfer) {
  return types(dataTransfer).includes(NOTE_DRAG_TYPE);
}

/** The note id a completed drop carries, or null when the drop is not a note. */
export function readDraggedNoteId(dataTransfer) {
  if (!isNoteDragTransfer(dataTransfer)) return null;
  let id = "";
  try {
    id = dataTransfer.getData(NOTE_DRAG_TYPE);
  } catch {
    return null;
  }
  return typeof id === "string" && id ? id : null;
}

/**
 * The pending reveal after the pointer is seen over `projectId` at `now`.
 *
 * `pending` is `{ projectId, since }` or null. The rule that stops flapping:
 * a reveal is scheduled ONCE per entry — seeing the same project again keeps
 * the existing schedule (its `since` does not restart), so continuous
 * dragover events cannot push the reveal further away, and a project that is
 * ALREADY expanded schedules nothing (there is nothing to reveal and no reason
 * to touch the expansion). Moving to a different project replaces the
 * schedule, so only the project under the pointer can ever expand.
 */
export function projectHoverSeen(pending, { projectId, expandedProjectId, now }) {
  if (typeof projectId !== "string" || !projectId) return null;
  if (projectId === expandedProjectId) return null;
  if (pending && pending.projectId === projectId) return pending;
  return { projectId, since: Number.isFinite(now) ? now : 0 };
}

/** The pointer has left the project (or the drag ended): nothing is pending. */
export function projectHoverLeft() {
  return null;
}

/** Whether a pending reveal has rested long enough to fire at `now`. */
export function projectHoverDue(pending, now, delayMs = PROJECT_HOVER_REVEAL_MS) {
  if (!pending || !Number.isFinite(pending.since)) return false;
  return Number.isFinite(now) && now - pending.since >= delayMs;
}

/**
 * The props a note ROW takes to be a drag source.
 *
 * The data transfer carries the note id under NOTE_DRAG_TYPE only — no
 * `text/plain`, so a note dropped into an editor or a text field inserts
 * nothing. A press that starts on a control marked `data-nw-no-drag` (the
 * three-dot menu trigger) never becomes a drag, so menus keep their meaning.
 * `onBegin`/`onEnd` are the app-state bookkeeping (AppStateContext's
 * beginNoteDrag / endNoteDrag); `dragend` fires for every ending — drop,
 * Escape, release outside a target — so the session can never stay open.
 */
export function noteDragSourceProps({ noteId, title, onBegin, onEnd }) {
  return {
    draggable: true,
    onDragStart: (e) => {
      const origin = e.target;
      if (origin && typeof origin.closest === "function" && origin.closest("[data-nw-no-drag]")) {
        e.preventDefault();
        return;
      }
      try {
        e.dataTransfer.setData(NOTE_DRAG_TYPE, noteId);
        e.dataTransfer.effectAllowed = "move";
      } catch {
        // A transfer that refuses the type cannot carry the note: no drag.
        e.preventDefault();
        return;
      }
      if (typeof onBegin === "function") onBegin(noteId, title);
    },
    onDragEnd: () => {
      if (typeof onEnd === "function") onEnd();
    },
  };
}
