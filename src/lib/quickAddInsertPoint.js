// src/lib/quickAddInsertPoint.js
//
// The Free-form insertion point Quick Add captures, and the rules that decide
// whether it may still be used.
//
// Why this exists at all: focusing the Quick Add textarea BLURS the Free-form
// editor. ProseMirror keeps its selection across a blur, but a bare selection
// object cannot say which note, which view or which version of the document it
// belonged to — and Quick Add needs exactly that, because an image or a file
// write is asynchronous and the user may type, switch note or switch view
// while it is in flight.
//
// A captured point therefore carries FOUR identifying facts, and all four must
// still hold at insertion time:
//
//   noteId    — the note it was taken in
//   view      — Free-form (a Template-form point is never captured)
//   from/to   — the numeric selection range
//   revision  — a counter bumped on every Free-form document change
//
// The revision is the part that matters most. `to <= docSize` proves only that
// a number is in range, NOT that it still points where the user was: deleting a
// paragraph above the caret leaves every later position in range while moving
// all of them, so a bounds check alone would silently insert into the wrong
// place. A changed revision means "the document is not the one this position
// described", and the only safe answer is the end of the note.
//
// This is deliberately NOT transaction mapping. Mapping a stored position
// through every intervening step would be a second, stateful subsystem beside
// ProseMirror's own; the product need here is "put it where I was looking, or
// somewhere obviously safe", and a monotonic counter answers that honestly.
//
// Nothing here is persisted. A captured point dies with the session, the note
// and the view.
//
// Pure: no React, no editor, no DOM.

import { NOTE_VIEW } from "./noteViews";

export const FREEFORM_INSERT_MODE = {
  /** Use the captured range. */
  POSITION: "position",
  /** Every rejection path: append at the end of the current note. */
  END: "end",
};

const END = Object.freeze({ mode: FREEFORM_INSERT_MODE.END, from: null, to: null });

function isPosition(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Capture the live Free-form selection, or null when it is not capturable.
 *
 * Called from the editor's own focus/selection events, so the stored point is
 * always the last place the user genuinely had the caret.
 */
export function captureFreeformInsertPoint({
  noteId,
  view,
  from,
  to,
  revision,
} = {}) {
  if (!noteId) return null;
  // A Template-form caret belongs to a row editor, which has its own identity
  // model (templateRowEditorIdentity) and its own insertion path. It is never
  // a Free-form insertion point.
  if (view !== NOTE_VIEW.FREEFORM) return null;
  if (!isPosition(from) || !isPosition(to) || to < from) return null;
  if (!isPosition(revision)) return null;
  return Object.freeze({
    noteId,
    view: NOTE_VIEW.FREEFORM,
    from,
    to,
    revision,
  });
}

/**
 * Where should this insertion actually go?
 *
 * Returns the captured range only when the note, the view, the document
 * revision and the numeric bounds ALL still hold. Every other case — no
 * capture, another note, another view, an edited document, an out-of-range
 * position — resolves to the end of the current note, which is always a valid
 * place to add something and never silently wrong.
 *
 * @param snapshot  a point from captureFreeformInsertPoint (or null)
 * @param noteId    the note being inserted into RIGHT NOW
 * @param view      the view on screen RIGHT NOW
 * @param revision  the Free-form document revision RIGHT NOW
 * @param docSize   editor.state.doc.content.size RIGHT NOW
 */
export function resolveFreeformInsertPoint(
  snapshot,
  { noteId, view, revision, docSize } = {}
) {
  if (!snapshot) return END;
  if (!noteId || snapshot.noteId !== noteId) return END;
  if (view !== NOTE_VIEW.FREEFORM || snapshot.view !== NOTE_VIEW.FREEFORM) {
    return END;
  }
  // The document changed since the point was captured. The stored numbers may
  // still be "in range" and still be wrong, so they are not used.
  if (!isPosition(revision) || snapshot.revision !== revision) return END;
  if (!isPosition(docSize)) return END;
  if (!isPosition(snapshot.from) || !isPosition(snapshot.to)) return END;
  if (snapshot.to < snapshot.from) return END;
  if (snapshot.to > docSize) return END;
  return {
    mode: FREEFORM_INSERT_MODE.POSITION,
    from: snapshot.from,
    to: snapshot.to,
  };
}

/** True when a capture is usable — the chip says "At cursor" only then. */
export function hasUsableInsertPoint(snapshot, live) {
  return (
    resolveFreeformInsertPoint(snapshot, live || {}).mode ===
    FREEFORM_INSERT_MODE.POSITION
  );
}
