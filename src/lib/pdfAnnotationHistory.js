// src/lib/pdfAnnotationHistory.js
//
// Bounded, document-scoped Undo/Redo for PDF annotations.
//
// This history is deliberately separate from every other history in the app
// (Free-form TipTap, Save progress, AI Refine, template-row Refine). It is
// session-only: annotation STATE persists to IndexedDB normally, the history
// of how it got there does not. One editor instance exists per PDF document
// (the editor is remounted per `docId`), so a history object can never span
// two documents.
//
// A "gesture" is one completed user action — a drag, a resize, a create, a
// text edit. `beginGesture` snapshots the state before it, `commitGesture`
// records exactly one entry after it, and records nothing at all when the
// state came back unchanged (a selection-only click, a cancelled drag, or a
// drag that ended where it started).
//
// Pure functions over a plain mutable state object, so it is unit-testable
// without React.

/** Completed actions retained per PDF document. */
export const HISTORY_LIMIT = 50;

const snapshot = (items) => JSON.parse(JSON.stringify(Array.isArray(items) ? items : []));

/** Deep value equality for annotation lists. */
export function annotationsEqual(a, b) {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

export function createHistory(limit = HISTORY_LIMIT) {
  return {
    past: [],
    future: [],
    baseline: null,
    inGesture: false,
    limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : HISTORY_LIMIT,
  };
}

/** Discard everything — used when a document's annotations are replaced. */
export function resetHistory(history) {
  history.past.length = 0;
  history.future.length = 0;
  history.baseline = null;
  history.inGesture = false;
  return history;
}

export function canUndo(history) {
  return !!history && history.past.length > 0;
}

export function canRedo(history) {
  return !!history && history.future.length > 0;
}

function pushEntry(history, before) {
  history.past.push(before);
  if (history.past.length > history.limit) history.past.shift();
  history.future.length = 0;
}

/**
 * Record the state a gesture starts from. Re-entrant calls while a gesture is
 * already open are ignored, so the outermost begin/commit pair wins.
 */
export function beginGesture(history, items) {
  if (history.inGesture) return false;
  history.inGesture = true;
  history.baseline = snapshot(items);
  return true;
}

/** True while a gesture is open (a drag/resize/draw is in progress). */
export function isGestureActive(history) {
  return !!history && history.inGesture;
}

/** The state the open gesture started from, or null. */
export function gestureBaseline(history) {
  return history?.inGesture ? history.baseline : null;
}

/**
 * Close the open gesture. Pushes exactly one Undo entry when the state
 * actually changed, and nothing when it did not.
 * Returns true when an entry was recorded.
 */
export function commitGesture(history, items) {
  if (!history.inGesture) return false;
  const before = history.baseline;
  history.inGesture = false;
  history.baseline = null;
  if (before === null || annotationsEqual(before, items)) return false;
  pushEntry(history, before);
  return true;
}

/**
 * Abandon the open gesture. Returns the baseline so the caller can restore it;
 * no Undo entry is created.
 */
export function cancelGesture(history) {
  if (!history.inGesture) return null;
  const before = history.baseline;
  history.inGesture = false;
  history.baseline = null;
  return before;
}

/**
 * Record a single mutation that has no drag phase (delete, style change).
 * `before` is the state prior to the change.
 */
export function pushMutation(history, before) {
  pushEntry(history, snapshot(before));
  return true;
}

/**
 * Step back one entry. Returns the items to apply, or null when there is
 * nothing to undo. `current` is pushed onto the Redo stack.
 */
export function undo(history, current) {
  if (!history.past.length) return null;
  const previous = history.past.pop();
  history.future.unshift(snapshot(current));
  return previous;
}

/** Step forward one entry. Returns the items to apply, or null. */
export function redo(history, current) {
  if (!history.future.length) return null;
  const next = history.future.shift();
  history.past.push(snapshot(current));
  if (history.past.length > history.limit) history.past.shift();
  return next;
}
