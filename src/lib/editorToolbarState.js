// src/lib/editorToolbarState.js
//
// Which note-editor actions are available, derived from what the user can
// actually SEE.
//
// This exists because the Free-form TipTap editor is not unmounted when the
// Template form is shown — it is hidden with display:none (see MainArea). A
// control that stays enabled in that state dispatches into a document nobody
// is looking at and persists the result. The rule is therefore derived
// once, here, and used by every affected control.
//
// Pure: no React, no editor, no DOM.

// MainArea's stored view identifiers are unchanged ("natural" | "template");
// the user-facing names are Free-form note / Template form — see
// src/lib/noteViews.js NOTE_VIEW_LABEL.
export const FREEFORM_LAYOUT = "natural";
export const TEMPLATE_LAYOUT = "template";

/**
 * True only when the Free-form editor is the surface actually on screen.
 *
 * Formatting controls, Undo/Redo and AI Refine are all gated on this: no note
 * open, no editor, or the Template form visible all mean "do not act".
 */
export function isFreeformEditingEnabled({ hasNote, hasEditor, noteLayout }) {
  return Boolean(hasNote) && Boolean(hasEditor) && noteLayout === FREEFORM_LAYOUT;
}

/**
 * Whether the AI Refine action may be triggered right now.
 *
 * Requires a visible Free-form note with usable content, and no request
 * already in flight — one user action, at most one provider request.
 */
export function canRefine({ freeformEnabled, hasContent, isLoading }) {
  return Boolean(freeformEnabled) && Boolean(hasContent) && !isLoading;
}

/**
 * Whether Revert may be triggered. Scoped to the visible note having its own
 * backup — another note's backup is never offered here.
 */
export function canRevertRefine({ freeformEnabled, hasBackup, isLoading }) {
  return Boolean(freeformEnabled) && Boolean(hasBackup) && !isLoading;
}
